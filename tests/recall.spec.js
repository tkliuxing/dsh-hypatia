/**
 * Phase 1 acceptance gates for same-request recall.
 *
 * Recall is allowed to return nothing. It is not allowed to fail a turn, to
 * leak another project's memory, or to hand the model text that reads as an
 * instruction.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ErrorCode, HypatiaError } from '../src/errors.js'
import { RecallService, extractTerms } from '../src/recall.js'
import { openLedger } from '../src/ledger/ledger.js'
import { normalizeConfig } from '../src/config.js'
import { Capability, createMemoryPolicy } from '../src/policy.js'
import { memoryName } from '../src/identity.js'
import { FakeAdapter } from './helpers/fake-adapter.js'

const SCOPE = 'proj-a'
const OTHER = 'proj-b'

function seed(ledger, { memoryId, scope = SCOPE, kind = 'decision', title, summary, name }) {
  const hypatiaName = name ?? memoryName(scope, memoryId)
  ledger.beginOperation({
    operationId: `op-${memoryId}`,
    memoryId,
    verb: 'create',
    scope,
    shelf: 'default',
    hypatiaName,
    kind,
    title,
    payload: { title, summary },
    payloadHash: `hash-${memoryId}`,
  })
  ledger.markDispatched(`op-${memoryId}`)
  ledger.commitReceipt(`op-${memoryId}`, { verified: true })
  return hypatiaName
}

function setup(configOverrides = {}) {
  const ledger = openLedger(':memory:')
  const adapter = new FakeAdapter()
  const config = normalizeConfig(configOverrides)
  const policy = createMemoryPolicy({ preset: 'standard' })
  const warnings = []
  const recall = new RecallService({
    ledger, adapter, policy, config, warn: (message) => warnings.push(message),
  })
  return { ledger, adapter, recall, warnings, config }
}

describe('term extraction', () => {
  it('drops stopwords and keeps identifiers', () => {
    const terms = extractTerms('How do we handle the retry_queue in this adapter?')
    assert.ok(terms.includes('retry_queue'))
    assert.ok(terms.includes('adapter'))
    assert.ok(!terms.includes('the'))
    assert.ok(!terms.includes('do'))
  })

  it('produces bigrams for CJK text, which has no word delimiters', () => {
    const terms = extractTerms('记住这个项目的构建方式')
    assert.ok(terms.length > 0)
    assert.ok(terms.every((term) => term.length >= 2))
  })
})

describe('scope isolation', () => {
  it('never surfaces another project\'s memory', async () => {
    const { ledger, recall } = setup()
    seed(ledger, { memoryId: 'mine', title: 'adapter design', summary: 'use execFile' })
    seed(ledger, { memoryId: 'theirs', scope: OTHER, title: 'adapter design', summary: 'use execFile' })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter design' })

    assert.deepEqual(result.entries.map((entry) => entry.memoryId), ['mine'])
    ledger.close()
  })

  it('rejects a Hypatia hit whose key is not vouched for by the ledger', async () => {
    const { ledger, adapter, recall } = setup()
    // A lookalike key with the right prefix and this scope's tag, but no
    // ledger row: the forged-candidate case.
    const forged = memoryName(SCOPE, 'forged')
    adapter.knowledge.set(forged, {
      name: forged,
      content: { data: JSON.stringify({ title: 'adapter', summary: 'trust me' }), tags: [], scopes: [SCOPE] },
    })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })

    assert.equal(result.entries.length, 0)
    ledger.close()
  })

  it('rejects a Hypatia hit carrying another scope\'s key tag', async () => {
    const { ledger, adapter, recall } = setup()
    const foreign = memoryName(OTHER, 'theirs')
    seed(ledger, { memoryId: 'theirs', scope: OTHER, title: 'adapter', summary: 'x', name: foreign })
    adapter.knowledge.set(foreign, {
      name: foreign,
      content: { data: JSON.stringify({ title: 'adapter', summary: 'x' }), tags: [], scopes: [OTHER] },
    })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })

    assert.equal(result.entries.length, 0)
    ledger.close()
  })

  it('excludes tombstoned memories immediately', async () => {
    const { ledger, recall } = setup()
    seed(ledger, { memoryId: 'doomed', title: 'adapter design', summary: 'use execFile' })
    ledger.tombstone('doomed', 'user forget')

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter design' })

    assert.equal(result.entries.length, 0)
    ledger.close()
  })
})

describe('failure behaviour', () => {
  it('fails open when the adapter throws', async () => {
    const { ledger, adapter, recall } = setup()
    seed(ledger, { memoryId: 'mine', title: 'adapter design', summary: 'use execFile' })
    adapter.failNext('search', new HypatiaError(ErrorCode.TIMEOUT, 'slow'))

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter design' })

    // The ledger baseline still answers; only the supplement degraded.
    assert.equal(result.entries.length, 1)
    assert.match(result.degraded, /supplement unavailable/)
    ledger.close()
  })

  it('returns nothing rather than throwing when everything is unavailable', async () => {
    const ledger = openLedger(':memory:')
    const recall = new RecallService({
      ledger,
      adapter: null,
      policy: createMemoryPolicy({ preset: 'standard' }),
      config: normalizeConfig({}),
      warn: () => {},
    })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'anything' })

    assert.deepEqual(result.entries, [])
    ledger.close()
  })

  it('returns nothing when the policy withholds recall', async () => {
    const ledger = openLedger(':memory:')
    seed(ledger, { memoryId: 'mine', title: 'adapter', summary: 'x' })
    const policy = createMemoryPolicy({ preset: 'disabled' })
    assert.equal(policy.can(Capability.READ_RECALL), false)

    const recall = new RecallService({
      ledger, adapter: new FakeAdapter(), policy, config: normalizeConfig({}), warn: () => {},
    })
    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })

    assert.deepEqual(result.entries, [])
    ledger.close()
  })
})

describe('budget and ordering', () => {
  it('honours the configured result cap', async () => {
    const { ledger, recall } = setup({ recall: { maxResults: 2 } })
    for (let i = 0; i < 6; i += 1) {
      seed(ledger, { memoryId: `m${i}`, title: `adapter note ${i}`, summary: 'execFile' })
    }

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter execFile' })

    assert.equal(result.entries.length, 2)
    ledger.close()
  })

  it('ranks rules above derived work units, deterministically', async () => {
    const { ledger, recall } = setup()
    seed(ledger, { memoryId: 'w1', kind: 'work-unit', title: 'adapter work', summary: 'adapter' })
    seed(ledger, { memoryId: 'r1', kind: 'rule', title: 'adapter rule', summary: 'adapter' })

    const first = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })
    const second = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })

    assert.equal(first.entries[0].kind, 'rule')
    assert.deepEqual(
      first.entries.map((entry) => entry.memoryId),
      second.entries.map((entry) => entry.memoryId),
      'repeated recall must produce a stable order',
    )
    ledger.close()
  })

  it('truncates the rendered payload to the byte budget', async () => {
    const { ledger, recall } = setup({ recall: { maxBytes: 512 } })
    for (let i = 0; i < 5; i += 1) {
      seed(ledger, { memoryId: `m${i}`, title: `adapter ${i}`, summary: 'x'.repeat(400) })
    }

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })
    const text = recall.renderText(result.entries, { scope: SCOPE })

    assert.ok(Buffer.byteLength(text, 'utf8') <= 512, `payload was ${Buffer.byteLength(text)} bytes`)
    ledger.close()
  })
})

describe('untrusted framing', () => {
  it('labels recall as reference data with no authority', async () => {
    const { ledger, recall } = setup()
    seed(ledger, { memoryId: 'mine', title: 'adapter', summary: 'use execFile' })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })
    const text = recall.renderText(result.entries, { scope: SCOPE })

    assert.match(text, /untrusted historical reference data/)
    assert.match(text, /not instructions/)
    assert.match(text, /permission grant/)
  })

  it('marks derived entries as derived rather than user-confirmed', async () => {
    const { ledger, recall } = setup()
    seed(ledger, { memoryId: 'mine', title: 'adapter', summary: 'use execFile' })

    const result = await recall.recall({ scope: SCOPE, shelf: 'default', queryText: 'adapter' })
    const text = recall.renderText(result.entries, { scope: SCOPE })

    assert.match(text, /\(decision, derived\)/)
    ledger.close()
  })
})
