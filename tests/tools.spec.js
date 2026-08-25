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

function setup({ preset = 'full' } = {}) {
  const ledger = openLedger(':memory:')
  const adapter = new FakeAdapter()
  const config = normalizeConfig({})
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

  it('requires the administer capability to reconcile', async () => {
    const { call, ledger } = setup({ preset: 'standard' })
    const result = await call('memory_reconcile')

    assert.equal(result.error, 'unauthorized')
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
