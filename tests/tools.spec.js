/**
 * Phase 2 acceptance gates for the narrow model-facing tools.
 *
 * The security claim under test: a model that follows injected instructions
 * still cannot broaden a delete, choose a scope, or reach the CLI directly.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { openLedger } from '../src/ledger/ledger.js'
import { MutationCoordinator } from '../src/mutations.js'
import { RecallService } from '../src/recall.js'
import { normalizeConfig } from '../src/config.js'
import { createMemoryPolicy } from '../src/policy.js'
import { registerMemoryTools } from '../src/tools.js'
import { FakeAdapter, FakeContext } from './helpers/fake-adapter.js'

const SCOPE = 'proj-a'

function setup({ preset = 'full', config: configOverrides = {} } = {}) {
  const ledger = openLedger(':memory:')
  const adapter = new FakeAdapter()
  const config = normalizeConfig(configOverrides)
  const policy = createMemoryPolicy({ preset })
  const warnings = []
  const warn = (message) => warnings.push(message)
  const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
  const recall = new RecallService({ ledger, adapter, policy, config, warn })
  const agentCtx = new FakeContext()

  const dispose = registerMemoryTools({
    agentCtx,
    ledger,
    adapter,
    mutations,
    recall,
    policy,
    config,
    scope: SCOPE,
    shelf: 'default',
    sessionId: 'session-1',
    sessionCreatedAt: 1,
    warn,
  })

  const call = (name, args = {}) => agentCtx.registeredTools.get(name).execute(args, { signal: undefined })
  return { ledger, adapter, agentCtx, call, dispose, warnings }
}

describe('tool surface', () => {
  it('registers exactly the six narrow memory tools', () => {
    const { agentCtx, ledger } = setup()
    assert.deepEqual([...agentCtx.registeredTools.keys()].sort(), [
      'memory_forget_confirm',
      'memory_forget_preview',
      'memory_reconcile',
      'memory_remember',
      'memory_search',
      'memory_status',
    ])
    ledger.close()
  })

  it('exposes no parameter that could carry argv, a path, a shelf, or a scope', () => {
    const { agentCtx, ledger } = setup()
    const forbidden = /argv|command|shell|path|shelf|scope|jse|query_program|sql|name|tool/i
    for (const [name, definition] of agentCtx.registeredTools) {
      for (const parameter of Object.keys(definition.parameters.properties ?? {})) {
        assert.ok(
          !forbidden.test(parameter),
          `${name} exposes a dangerous parameter: ${parameter}`,
        )
      }
    }
    ledger.close()
  })
})

describe('memory_remember', () => {
  it('stores a user-confirmed memory in the host-derived scope', async () => {
    const { call, ledger } = setup()
    const result = await call('memory_remember', {
      kind: 'rule', title: 'No eval', summary: 'This project forbids eval().',
    })

    assert.equal(result.status, 'applied')
    assert.equal(result.scope, SCOPE)
    const record = ledger.getRecord(result.memory_id)
    assert.equal(record.scope, SCOPE)
    assert.equal(record.trust, 'user-confirmed')
    ledger.close()
  })

  it('is idempotent for identical content', async () => {
    const { call, ledger } = setup()
    const first = await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden.' })
    const second = await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden.' })

    assert.equal(first.memory_id, second.memory_id)
    assert.equal(second.status, 'replayed')
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_record').get().c, 1)
    ledger.close()
  })

  it('rejects an unknown kind rather than inventing one', async () => {
    const { call, ledger } = setup()
    const result = await call('memory_remember', { kind: 'global-override', title: 'x', summary: 'y' })

    assert.equal(result.error, 'validation')
    ledger.close()
  })

  it('refuses to write when the policy withholds semantic-write', async () => {
    const { call, ledger } = setup({ preset: 'read-only-recall' })
    const result = await call('memory_remember', { kind: 'rule', title: 'x', summary: 'y' })

    assert.equal(result.error, 'unauthorized')
    ledger.close()
  })
})

describe('two-stage forget', () => {
  it('preview lists candidates without deleting anything', async () => {
    const { call, adapter, ledger } = setup()
    await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden here.' })

    const preview = await call('memory_forget_preview', { query: 'eval' })

    assert.equal(preview.candidates.length, 1)
    assert.ok(preview.preview_token)
    assert.equal(adapter.knowledge.size, 1, 'preview must not delete')
    ledger.close()
  })

  it('confirm deletes exactly the previewed IDs', async () => {
    const { call, adapter, ledger } = setup()
    const stored = await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden here.' })
    const preview = await call('memory_forget_preview', { query: 'eval' })

    const result = await call('memory_forget_confirm', {
      preview_token: preview.preview_token,
      memory_ids: [stored.memory_id],
    })

    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].cleanup_state, 'active-shelf-cleanup-complete')
    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })

  it('refuses IDs that were not in the preview', async () => {
    const { call, adapter, ledger } = setup()
    await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden here.' })
    const other = await call('memory_remember', { kind: 'decision', title: 'Use pnpm', summary: 'Workspaces.' })
    const preview = await call('memory_forget_preview', { query: 'eval' })

    // The classic broadening attempt: confirm an ID the user never reviewed.
    const result = await call('memory_forget_confirm', {
      preview_token: preview.preview_token,
      memory_ids: [other.memory_id],
    })

    assert.deepEqual(result.results, [])
    assert.deepEqual(result.refused, [other.memory_id])
    assert.equal(adapter.knowledge.size, 2, 'nothing may be deleted')
    ledger.close()
  })

  it('refuses an unknown or reused token', async () => {
    const { call, ledger } = setup()
    const stored = await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden here.' })
    const preview = await call('memory_forget_preview', { query: 'eval' })

    const forged = await call('memory_forget_confirm', {
      preview_token: 'not-a-real-token', memory_ids: [stored.memory_id],
    })
    assert.equal(forged.error, 'validation')

    await call('memory_forget_confirm', {
      preview_token: preview.preview_token, memory_ids: [stored.memory_id],
    })
    // A token is single-use, so a replay cannot delete again.
    const replay = await call('memory_forget_confirm', {
      preview_token: preview.preview_token, memory_ids: [stored.memory_id],
    })
    assert.equal(replay.error, 'validation')
    ledger.close()
  })

  it('refuses to delete when the policy withholds delete', async () => {
    const { call, ledger } = setup({ preset: 'read-only-recall' })
    const result = await call('memory_forget_preview', { query: 'anything' })

    assert.equal(result.error, 'unauthorized')
    ledger.close()
  })
})

describe('forget coverage and honesty', () => {
  /** Store `count` distinct memories in the current scope. */
  async function seedMemories(call, count, prefix = 'Rule') {
    const ids = []
    for (let i = 0; i < count; i += 1) {
      const stored = await call('memory_remember', {
        kind: 'rule', title: `${prefix} ${i}`, summary: `Distinct guidance number ${i}.`,
      })
      ids.push(stored.memory_id)
    }
    return ids
  }

  it('cannot express "forget everything" as a term search', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 3)

    // The words a user says when they mean "all of it" appear in none of the
    // stored memories, so a term search finds nothing and the empty list reads
    // as "there is nothing to delete".
    const preview = await call('memory_forget_preview', { query: 'forget everything' })

    assert.equal(preview.candidates.length, 0)
    assert.equal(preview.matched, 0)
    assert.equal(preview.total_in_scope, 3, 'the user must still be told memories exist')
    ledger.close()
  })

  it('selects every memory in scope when match is "all"', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 3)

    const preview = await call('memory_forget_preview', { query: 'everything', match: 'all' })

    assert.equal(preview.candidates.length, 3)
    assert.equal(preview.matched, 3)
    assert.equal(preview.truncated, false)
    ledger.close()
  })

  it('deletes exactly the previewed set when "all" is confirmed', async () => {
    const { call, adapter, ledger } = setup()
    await seedMemories(call, 3)

    const preview = await call('memory_forget_preview', { query: 'everything', match: 'all' })
    const result = await call('memory_forget_confirm', {
      preview_token: preview.preview_token,
      memory_ids: preview.candidates.map((entry) => entry.memory_id),
    })

    assert.equal(result.results.length, 3)
    assert.deepEqual(result.refused, [])
    assert.equal(adapter.knowledge.size, 0)
    assert.equal(ledger.countRecallCandidates({ scope: SCOPE, shelf: 'default' }), 0)
    ledger.close()
  })

  it('never silently caps: an over-long list reports the shortfall', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 30)

    const preview = await call('memory_forget_preview', { query: 'everything', match: 'all' })

    assert.equal(preview.listed, 25)
    assert.equal(preview.matched, 30)
    assert.equal(preview.total_in_scope, 30)
    assert.equal(preview.truncated, true, 'a capped list must announce that it is capped')
    assert.match(preview.note, /INCOMPLETE/)
    assert.match(preview.note, /25 of 30/)
    ledger.close()
  })

  it('marks a complete term match as not truncated', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 2)

    const preview = await call('memory_forget_preview', { query: 'Distinct guidance' })

    assert.equal(preview.truncated, false)
    assert.match(preview.note, /complete set/)
    ledger.close()
  })

  it('confirming a truncated preview leaves the remainder intact and visible', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 30)

    const preview = await call('memory_forget_preview', { query: 'everything', match: 'all' })
    await call('memory_forget_confirm', {
      preview_token: preview.preview_token,
      memory_ids: preview.candidates.map((entry) => entry.memory_id),
    })

    // The user believed they deleted everything; the tool must still show the
    // remainder rather than report an empty project.
    const after = await call('memory_forget_preview', { query: 'everything', match: 'all' })
    assert.equal(after.total_in_scope, 5)
    assert.equal(after.matched, 5)
    assert.equal(after.truncated, false)
    ledger.close()
  })

  it('keeps match "all" inside the current project scope', async () => {
    const { call, ledger } = setup()
    await seedMemories(call, 2)
    // A memory belonging to another project must never enter the preview.
    ledger.beginOperation({
      operationId: 'op-foreign', memoryId: 'foreign', verb: 'create',
      scope: 'some-other-project', shelf: 'default',
      hypatiaName: 'dshmem:v1:ffff:foreign', kind: 'rule',
      title: 'Foreign rule', payload: { title: 'Foreign rule' }, payloadHash: 'h',
    })
    ledger.markDispatched('op-foreign')
    ledger.commitReceipt('op-foreign', { verified: true })

    const preview = await call('memory_forget_preview', { query: 'everything', match: 'all' })

    assert.equal(preview.matched, 2)
    assert.ok(!preview.candidates.some((entry) => entry.memory_id === 'foreign'))
    ledger.close()
  })
})

describe('status and reconcile', () => {
  it('reports capabilities and counts without leaking payloads', async () => {
    const { call, ledger } = setup()
    await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Secret detail here.' })

    const status = await call('memory_status')

    assert.equal(status.scope, SCOPE)
    assert.equal(status.records.applied, 1)
    assert.ok(Array.isArray(status.capabilities))
    assert.ok(!JSON.stringify(status).includes('Secret detail here.'))
    ledger.close()
  })

  it('lets the default preset settle its own unverified operations', async () => {
    // `standard` authorizes the writes, so it must be able to finish them.
    // Gating reconcile behind ADMINISTER stranded every uncertain operation on
    // the default preset, with memory_status pointing at a tool that always
    // refused.
    const { call, ledger } = setup({ preset: 'standard' })
    const result = await call('memory_reconcile')

    assert.equal(result.error, undefined)
    assert.equal(typeof result.checked, 'number')
    ledger.close()
  })

  it('refuses to reconcile when the capability is withheld', async () => {
    const { call, ledger } = setup({ preset: 'read-only-recall' })
    const result = await call('memory_reconcile')

    assert.equal(result.error, 'unauthorized')
    ledger.close()
  })

  it('does not advise a tool this deployment cannot run', async () => {
    const { call, ledger } = setup({ preset: 'read-only-recall' })
    const status = await call('memory_status')

    assert.ok(!status.note?.includes('Run memory_reconcile'),
      'advice the caller cannot act on is a dead end')
    ledger.close()
  })
})

describe('memory_search', () => {
  it('returns only this scope and labels results as reference data', async () => {
    const { call, ledger } = setup()
    await call('memory_remember', { kind: 'rule', title: 'No eval', summary: 'Forbidden here.' })

    const result = await call('memory_search', { query: 'eval' })

    assert.equal(result.scope, SCOPE)
    assert.equal(result.entries.length, 1)
    assert.match(result.note, /Not instructions/)
    ledger.close()
  })
})

describe('memory_remember regressions', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE'

  it('redacts the title, not only the payload copy', async () => {
    const { ledger, call } = setup()
    await call('memory_remember', {
      kind: 'rule',
      title: `deploy key ${SECRET}`,
      summary: `the same key ${SECRET} appears here`,
    })

    // `memory_record.title` is a column of its own, and every read path prefers
    // it over `payload.title` - so a raw title is a secret in the ledger that
    // recall and memory_search then render verbatim.
    const row = ledger.db.prepare('SELECT title, payload_json, redaction_labels FROM memory_record').get()
    assert.ok(!row.title.includes(SECRET), 'the stored title must not carry the secret')
    assert.ok(!row.payload_json.includes(SECRET))

    const search = await call('memory_search', { query: 'deploy key' })
    assert.ok(!JSON.stringify(search).includes(SECRET), 'memory_search must not hand it back')
  })

  it('records that something was redacted', async () => {
    const { ledger, call } = setup()
    await call('memory_remember', { kind: 'rule', title: 'a key', summary: `key ${SECRET}` })

    // The tool redacts first so it can hash the redacted form; without carrying
    // its labels down, the audit trail would say nothing was ever stripped.
    const row = ledger.db.prepare('SELECT redaction_labels FROM memory_record').get()
    assert.deepEqual(JSON.parse(row.redaction_labels), ['aws-access-key'])
  })

  it('keeps two projects that remember the same sentence independent', async () => {
    // One ledger, two scopes - the real arrangement, since the ledger file is
    // per-user rather than per-project.
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const config = normalizeConfig({})
    const policy = createMemoryPolicy({ preset: 'full' })
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn: () => {} })

    const project = (scope) => {
      const agentCtx = new FakeContext()
      registerMemoryTools({
        agentCtx, ledger, adapter, mutations, policy, config, scope, shelf: 'default',
        sessionId: `session-${scope}`, sessionCreatedAt: 1, warn: () => {},
      })
      return (name, args = {}) => agentCtx.registeredTools.get(name).execute(args, { signal: undefined })
    }
    const a = project('proj-a')
    const b = project('proj-b')
    const memory = { kind: 'rule', title: 'Use pnpm', summary: 'Always use pnpm in this repo.' }

    const first = await a('memory_remember', memory)
    const second = await b('memory_remember', memory)

    assert.equal(first.status, 'applied')
    assert.equal(second.status, 'applied')
    // A content-only id would collide on the ledger primary key, so the second
    // project's write would land in Hypatia with no ledger row of its own.
    assert.notEqual(first.memory_id, second.memory_id)
    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 1)
    assert.equal(ledger.recallCandidates({ scope: 'proj-b', shelf: 'default' }).length, 1)
    assert.equal((await b('memory_search', { query: 'pnpm' })).entries.length, 1,
      'the second project can actually recall what it was told was stored')
    ledger.close()
  })
})

/**
 * The host renders a tool call - live and on every replay of an old session -
 * by calling `presentCall` and shipping what it returns inside the transcript
 * page. That page is validated against the harness wire schema, whose only
 * requirement on the interior is a string `card` discriminant. A view without
 * one fails the WHOLE page: an existing session stops opening at the first
 * memory tool call it contains.
 *
 * The contract is mirrored here rather than imported, for the same reason
 * `createUserMessage` is inlined in `index.js`: a link install resolves imports
 * from the checkout path, where in-box harness packages are unreachable.
 * Sources: `ToolCallView` in `@deepseek-ai/dsh-tools/src/presentation.ts`,
 * `toolEventViewSchema` in `@deepseek-ai/dsh-apiproxy/src/api/sessions.schema.ts`.
 */
const CALL_VIEW_SHAPES = {
  generic: { required: ['title'], optional: ['kind', 'rawInput', 'content', 'locations'] },
  terminal: { required: ['title'], optional: ['description', 'cwd'] },
  diff: { required: ['title', 'diffs'], optional: ['locations'] },
}

/** `ToolCallKind`. A UI picks its icon from this closed vocabulary. */
const CALL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])

function assertValidCallView(view, label) {
  assert.equal(typeof view, 'object', `${label}: view must be an object`)
  assert.notEqual(view, null, `${label}: view must not be null`)
  // The exact failure a malformed view produces on the wire:
  // `{"expected":"string","code":"invalid_type","path":["events",N,"view","view","card"]}`.
  assert.equal(typeof view.card, 'string', `${label}: view.card must be a string discriminant`)
  const shape = CALL_VIEW_SHAPES[view.card]
  assert.ok(shape, `${label}: unknown card '${view.card}'`)
  for (const field of shape.required) {
    assert.ok(field in view, `${label}: card '${view.card}' requires ${field}`)
  }
  const known = new Set(['card', ...shape.required, ...shape.optional])
  for (const key of Object.keys(view)) {
    // An unknown key survives the loose wire schema and is then silently
    // dropped by the UI - the input a card was meant to show goes missing.
    assert.ok(known.has(key), `${label}: card '${view.card}' has no field '${key}'`)
  }
  assert.equal(typeof view.title, 'string', `${label}: title must be a string`)
  assert.ok(view.title.length > 0, `${label}: title must not be empty`)
  if ('kind' in view) assert.ok(CALL_KINDS.has(view.kind), `${label}: unknown kind '${view.kind}'`)
}

describe('pending-call presentation', () => {
  /** Arguments as the model would send them, per tool. */
  const REALISTIC_ARGS = {
    memory_search: { query: 'pnpm', limit: 5 },
    memory_remember: { kind: 'rule', title: 'Use pnpm', summary: 'Always use pnpm in this repo.' },
    memory_forget_preview: { query: 'pnpm' },
    memory_forget_confirm: { preview_token: 'tok', memory_ids: ['a', 'b'] },
    memory_status: {},
    memory_reconcile: {},
  }

  it('returns a card-tagged view the host transcript schema accepts', () => {
    const { agentCtx, ledger } = setup()
    for (const [name, definition] of agentCtx.registeredTools) {
      assert.equal(typeof definition.presentCall, 'function', `${name} declares no presentCall`)
      assertValidCallView(definition.presentCall(REALISTIC_ARGS[name]), name)
    }
    ledger.close()
  })

  it('still returns a valid view for arguments logged by an older build', () => {
    const { agentCtx, ledger } = setup()
    // History replay feeds back whatever was stored, parsed but never
    // re-validated, so a presenter that assumes its own current parameters
    // would throw and drop the card for every past call.
    for (const [name, definition] of agentCtx.registeredTools) {
      for (const args of [undefined, {}, { unexpected: 1 }]) {
        assertValidCallView(definition.presentCall(args), `${name} with ${JSON.stringify(args)}`)
      }
    }
    ledger.close()
  })
})

/**
 * A capped list must announce its cap - the same rule `memory_forget_preview`
 * already follows. Here the stake is different but no smaller: a model that
 * reads a silently truncated search as "this project has no such memory" will
 * tell the user something false, and then act on it.
 */
describe('memory_search coverage', () => {
  async function remember(call, index) {
    return call('memory_remember', {
      kind: 'decision',
      title: `decision ${index}`,
      summary: `we decided thing number ${index}`,
    })
  }

  it('reports the scan as complete when everything in scope was searched', async () => {
    const { call, ledger } = setup({ config: { recall: { searchScanLimit: 50 } } })
    await remember(call, 1)
    await remember(call, 2)

    const result = await call('memory_search', { query: 'decision' })

    assert.equal(result.truncated, false)
    assert.equal(result.scanned, 2)
    assert.equal(result.total_in_scope, 2)
    assert.doesNotMatch(result.note, /were searched/)
    ledger.close()
  })

  it('announces the cap, with real numbers, when it could not search everything', async () => {
    const { call, ledger } = setup({ config: { recall: { searchScanLimit: 2 } } })
    for (let i = 0; i < 5; i += 1) await remember(call, i)

    const result = await call('memory_search', { query: 'decision' })

    assert.equal(result.truncated, true)
    assert.equal(result.scanned, 2)
    assert.equal(result.total_in_scope, 5)
    assert.match(result.note, /Only the 2 most recent of 5 memories/)
    assert.match(result.note, /an older match may exist/)
    ledger.close()
  })

  it('does not let a wider scan limit leak another project into the total', async () => {
    const { call, ledger } = setup({ config: { recall: { searchScanLimit: 1 } } })
    await remember(call, 1)
    await remember(call, 2)
    // A record belonging to another project, written straight to the ledger.
    ledger.beginOperation({
      operationId: 'op-other',
      memoryId: 'other-1',
      verb: 'create',
      scope: 'proj-b',
      shelf: 'default',
      hypatiaName: 'dshmem:v1:bbbb:other-1',
      kind: 'decision',
      title: 'decision elsewhere',
      payload: { title: 'decision elsewhere' },
      payloadHash: 'hash-other',
    })
    ledger.markDispatched('op-other')
    ledger.commitReceipt('op-other', { verified: true })

    const result = await call('memory_search', { query: 'decision' })

    assert.equal(result.total_in_scope, 2, 'the cap is reported against this scope, never the whole ledger')
    ledger.close()
  })
})

describe('memory_status coverage reporting', () => {
  it('reports how much of the project automatic recall actually scores', async () => {
    const { call, ledger } = setup({ config: { recall: { candidatePool: 2 } } })
    for (let i = 0; i < 5; i += 1) {
      await call('memory_remember', { kind: 'decision', title: `d${i}`, summary: `s${i}` })
    }

    const status = await call('memory_status', {})

    assert.deepEqual(status.recall_coverage, { active: 5, scored_per_turn: 2, truncated: true })
    ledger.close()
  })

  it('does not claim truncation when the whole project fits in the pool', async () => {
    const { call, ledger } = setup({ config: { recall: { candidatePool: 50 } } })
    await call('memory_remember', { kind: 'decision', title: 'only one', summary: 'body' })

    const status = await call('memory_status', {})

    assert.deepEqual(status.recall_coverage, { active: 1, scored_per_turn: 1, truncated: false })
    ledger.close()
  })
})

describe('memory_reconcile honesty', () => {
  it('says everything is settled when it is', async () => {
    const { call, ledger } = setup()
    await call('memory_remember', { kind: 'decision', title: 'settled', summary: 'body' })

    const result = await call('memory_reconcile', {})

    assert.equal(result.truncated, false)
    assert.equal(result.remaining, 0)
    assert.match(result.note, /Everything tracked is settled/)
    ledger.close()
  })

  it('tells the model to stop rather than loop on work reconciliation cannot finish', async () => {
    const { call, ledger, adapter } = setup()
    // A write that never lands leaves an operation reconciliation will keep
    // finding; once its record is forgotten, no further pass can settle it.
    adapter.knowledgeCreate = async () => ({ ok: true, text: 'Created knowledge: x' })
    const written = await call('memory_remember', { kind: 'decision', title: 'stuck', summary: 'body' })
    ledger.tombstone(written.memory_id, 'user asked')
    ledger.setCleanupState(written.memory_id, 'complete')

    const result = await call('memory_reconcile', {})

    assert.equal(result.truncated, false)
    assert.ok(result.remaining > 0)
    assert.match(result.note, /cannot be settled/)
    assert.match(result.note, /Running again will not change that/)
    assert.doesNotMatch(result.note, /Run memory_reconcile again/)
    ledger.close()
  })
})
