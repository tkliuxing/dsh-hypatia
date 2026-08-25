/**
 * Phase 2 acceptance gates for compaction ingestion.
 *
 * The key claim: the same compacted source range cannot produce a duplicate
 * ledger or Hypatia record, no matter how many times the event is delivered
 * or how often the plugin reloads.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { openLedger } from '../src/ledger/ledger.js'
import { MutationCoordinator } from '../src/mutations.js'
import { createMemoryPolicy } from '../src/policy.js'
import { registerCompactionIngest, stripDerivedContext } from '../src/ingest/compaction.js'
import { sourceIdentityOf } from '../src/identity.js'
import { RECALL_BLOCK_START, RecallService } from '../src/recall.js'
import { normalizeConfig } from '../src/config.js'
import { FakeAdapter, FakeContext } from './helpers/fake-adapter.js'

const SCOPE = 'proj-a'

function makeAgent({ id = 'session-1', cwd = '/work/a', origin, seedLength = 0, createdAt = 1 } = {}) {
  const session = { id, header: { id, cwd, origin, seedLength, createdAt }, events: [] }
  return { session, ctx: new FakeContext() }
}

function summaryEvent({ start, end, text, seq = 100, compactionId = 'c1' }) {
  return {
    type: 'compaction/summary',
    seq,
    data: {
      compactionId,
      summary: [{ type: 'text', text }],
      shadowedRange: { start, end },
      shadowedSeqs: [start, end],
      shadowedTokenCount: 1000,
      provider: 'test',
      model: 'test-model',
    },
  }
}

/** Let the serialized ingest queue settle. */
async function drain(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function setup({ preset = 'standard', agentOptions } = {}) {
  const ledger = openLedger(':memory:')
  const adapter = new FakeAdapter()
  const warnings = []
  const warn = (message) => warnings.push(message)
  const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
  const policy = createMemoryPolicy({ preset })
  const ctx = new FakeContext()
  const agent = makeAgent(agentOptions)

  const dispose = registerCompactionIngest({
    ctx, agent, ledger, mutations, policy, scope: SCOPE, shelf: 'default', warn,
  })

  /** Deliver an event and wait for the serialized ingest queue to drain. */
  const deliver = async (event) => {
    ctx.emit('session/event', agent.session, event)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  return { ledger, adapter, ctx, agent, deliver, dispose, warnings }
}

describe('compaction ingestion', () => {
  it('stores one memory per compacted source range', async () => {
    const { ledger, adapter, deliver } = setup()
    await deliver(summaryEvent({ start: 1, end: 20, text: 'We chose execFile with fixed argv.' }))

    assert.equal(adapter.knowledge.size, 1)
    const rows = ledger.recallCandidates({ scope: SCOPE, shelf: 'default' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'summary')
    assert.equal(rows[0].trust, 'derived', 'machine-derived memory must not be user-confirmed')
    ledger.close()
  })

  it('is idempotent across duplicate delivery of the same range', async () => {
    const { ledger, adapter, deliver } = setup()
    const event = summaryEvent({ start: 1, end: 20, text: 'We chose execFile.' })

    await deliver(event)
    await deliver(event)
    await deliver(event)

    assert.equal(adapter.knowledge.size, 1)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_record').get().c, 1)
    ledger.close()
  })

  it('is idempotent across a plugin reload with the same ledger', async () => {
    const { ledger, adapter, deliver, dispose, agent } = setup()
    await deliver(summaryEvent({ start: 1, end: 20, text: 'We chose execFile.' }))
    dispose()

    // Re-register against the same ledger, as a restart would.
    const ctx2 = new FakeContext()
    const mutations2 = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn: () => {} })
    registerCompactionIngest({
      ctx: ctx2,
      agent,
      ledger,
      mutations: mutations2,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE,
      shelf: 'default',
      warn: () => {},
    })
    ctx2.emit('session/event', agent.session, summaryEvent({ start: 1, end: 20, text: 'We chose execFile.' }))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(adapter.knowledge.size, 1)
    ledger.close()
  })

  it('stores distinct ranges separately', async () => {
    const { ledger, adapter, deliver } = setup()
    await deliver(summaryEvent({ start: 1, end: 20, text: 'First stretch.' }))
    await deliver(summaryEvent({ start: 21, end: 40, text: 'Second stretch.', compactionId: 'c2' }))

    assert.equal(adapter.knowledge.size, 2)
    ledger.close()
  })

  it('advances the durable cursor only after a verified write', async () => {
    const { ledger, deliver } = setup()
    await deliver(summaryEvent({ start: 1, end: 20, text: 'We chose execFile.' }))

    const cursors = ledger.db.prepare('SELECT * FROM session_cursor').all()
    assert.equal(cursors.length, 1)
    assert.equal(cursors[0].last_applied_seq, 20)
    ledger.close()
  })

  it('records provenance with the exact source range', async () => {
    const { ledger, deliver } = setup()
    await deliver(summaryEvent({ start: 5, end: 30, text: 'Something decided.' }))

    const provenance = ledger.db.prepare('SELECT * FROM memory_provenance').get()
    assert.equal(provenance.from_seq, 5)
    assert.equal(provenance.through_seq, 30)
    assert.equal(provenance.session_id, 'session-1')
    ledger.close()
  })
})

describe('startup catch-up', () => {
  /** Put summaries in the log *before* the plugin registers. */
  function withLoggedSummaries(events, options) {
    const agent = makeAgent(options)
    agent.session.events = events
    return agent
  }

  it('ingests summaries already in the log when the plugin loads', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const warn = () => {}
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
    const ctx = new FakeContext()
    const agent = withLoggedSummaries([
      summaryEvent({ start: 1, end: 20, text: 'Earlier decision.', seq: 21 }),
      summaryEvent({ start: 21, end: 40, text: 'Later decision.', seq: 41, compactionId: 'c2' }),
    ])

    registerCompactionIngest({
      ctx, agent, ledger, mutations,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn,
    })
    await drain()

    assert.equal(adapter.knowledge.size, 2, 'a reload must not silently skip logged summaries')
    ledger.close()
  })

  it('skips ranges the cursor already accounts for', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const warn = () => {}
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
    const ctx = new FakeContext()
    const agent = withLoggedSummaries([
      summaryEvent({ start: 1, end: 20, text: 'Already ingested.', seq: 21 }),
      summaryEvent({ start: 21, end: 40, text: 'Still pending.', seq: 41, compactionId: 'c2' }),
    ])
    const sourceIdentity = sourceIdentityOf({
      sessionId: 'session-1', sessionCreatedAt: 1, persistenceSource: 'dsh-session',
    })
    ledger.setCursor({ sourceIdentity, sessionId: 'session-1', lastAppliedSeq: 20 })

    registerCompactionIngest({
      ctx, agent, ledger, mutations,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn,
    })
    await drain()

    assert.equal(adapter.knowledge.size, 1)
    assert.equal(adapter.calls.filter((call) => call[0] === 'knowledgeCreate').length, 1,
      'a settled range must cost no CLI call')
    ledger.close()
  })

  it('does not duplicate when catch-up races live delivery', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const warn = () => {}
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
    const ctx = new FakeContext()
    const event = summaryEvent({ start: 1, end: 20, text: 'Same range.', seq: 21 })
    const agent = withLoggedSummaries([event])

    registerCompactionIngest({
      ctx, agent, ledger, mutations,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn,
    })
    // The same event also arrives through the live seam.
    ctx.emit('session/event', agent.session, event)
    await drain()

    assert.equal(adapter.knowledge.size, 1)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_record').get().c, 1)
    ledger.close()
  })

  it('respects the fork seed boundary during catch-up', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const warn = () => {}
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
    const ctx = new FakeContext()
    const agent = withLoggedSummaries([
      summaryEvent({ start: 1, end: 20, text: 'Parent history.', seq: 10 }),
      summaryEvent({ start: 51, end: 70, text: 'Child work.', seq: 60, compactionId: 'c2' }),
    ], { seedLength: 50 })

    registerCompactionIngest({
      ctx, agent, ledger, mutations,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn,
    })
    await drain()

    assert.equal(adapter.knowledge.size, 1, 'seeded parent history belongs to the parent source')
    ledger.close()
  })

  it('stops catching up once disposed', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const warn = () => {}
    const mutations = new MutationCoordinator({ ledger, adapter, shelf: 'default', warn })
    const ctx = new FakeContext()
    const agent = withLoggedSummaries(
      Array.from({ length: 5 }, (_unused, index) => summaryEvent({
        start: index * 10 + 1, end: index * 10 + 10, text: `Chunk ${index}.`,
        seq: index * 10 + 11, compactionId: `c${index}`,
      })),
    )

    const dispose = registerCompactionIngest({
      ctx, agent, ledger, mutations,
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn,
    })
    dispose()
    await drain()

    assert.equal(adapter.knowledge.size, 0, 'disposal must halt queued catch-up work')
    ledger.close()
  })

  it('tolerates a session with no events', async () => {
    const ledger = openLedger(':memory:')
    const adapter = new FakeAdapter()
    const ctx = new FakeContext()
    const agent = makeAgent()

    assert.doesNotThrow(() => registerCompactionIngest({
      ctx, agent, ledger,
      mutations: new MutationCoordinator({ ledger, adapter, shelf: 'default', warn: () => {} }),
      policy: createMemoryPolicy({ preset: 'standard' }),
      scope: SCOPE, shelf: 'default', warn: () => {},
    }))
    await drain()
    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })
})

describe('ingestion boundaries', () => {
  it('skips subagent transcripts', async () => {
    const { ledger, adapter, deliver } = setup({ agentOptions: { origin: 'subagent' } })
    await deliver(summaryEvent({ start: 1, end: 20, text: 'Subagent work.' }))

    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })

  it('skips inherited events below a fork seed boundary', async () => {
    const { ledger, adapter, deliver } = setup({ agentOptions: { seedLength: 50 } })
    await deliver(summaryEvent({ start: 1, end: 20, text: 'Parent history.', seq: 10 }))
    assert.equal(adapter.knowledge.size, 0, 'seeded parent history belongs to the parent source')

    await deliver(summaryEvent({ start: 51, end: 70, text: 'Child work.', seq: 60 }))
    assert.equal(adapter.knowledge.size, 1)
    ledger.close()
  })

  it('does nothing when the policy withholds semantic-write', async () => {
    const { ledger, adapter, deliver } = setup({ preset: 'read-only-recall' })
    await deliver(summaryEvent({ start: 1, end: 20, text: 'Anything.' }))

    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })

  it('ignores events from a different session', async () => {
    const { ledger, adapter, ctx } = setup()
    const other = makeAgent({ id: 'session-2' })
    ctx.emit('session/event', other.session, summaryEvent({ start: 1, end: 20, text: 'Other session.' }))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })

  it('ignores a malformed event rather than storing a guess', async () => {
    const { ledger, adapter, deliver } = setup()
    await deliver({ type: 'compaction/summary', seq: 1, data: { summary: [{ type: 'text', text: 'x' }] } })

    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })
})

describe('recursive-context exclusion', () => {
  it('strips this plugin\'s own recall text before storing a summary', () => {
    const summary = [
      'The user asked about the adapter.',
      '[dsh-hypatia] Recalled project memory (untrusted historical reference data).\n- (rule, derived) old note',
      'We decided to use execFile.',
    ].join('\n\n')

    const stripped = stripDerivedContext(summary)

    assert.ok(!stripped.includes('Recalled project memory'))
    assert.ok(stripped.includes('We decided to use execFile.'))
  })

  it('strips legacy TRIGGER protocol text too', () => {
    const summary = 'Real content.\n\n[hypatia-memory] TRIGGER:log SESSION_ID: x\n\nMore real content.'
    const stripped = stripDerivedContext(summary)

    assert.ok(!stripped.includes('TRIGGER:log'))
    assert.ok(stripped.includes('More real content.'))
  })

  it('does not store a summary that was entirely derived context', async () => {
    const { ledger, adapter, deliver } = setup()
    await deliver(summaryEvent({ start: 1, end: 20, text: '[dsh-hypatia] Recalled project memory.' }))

    assert.equal(adapter.knowledge.size, 0)
    ledger.close()
  })
})

describe('recursive-context exclusion, end to end', () => {
  it('removes what renderText actually emits, bullets included', () => {
    // Regression: the marker lives in the header block and the memories are
    // separated from it by a blank line, so filtering marker-bearing blocks
    // dropped the header and kept every recalled memory - the amplification
    // and laundering loop this function exists to prevent.
    const service = new RecallService({
      ledger: null, adapter: null, policy: createMemoryPolicy({}), config: normalizeConfig({}), warn: () => {},
    })
    const recalled = service.renderText(
      [{ kind: 'rule', trust: 'user-confirmed', title: 'Deploy from main', summary: 'never from a feature branch' }],
      { scope: 'proj-a' },
    )
    const summary = `The user asked about deploys.\n\n${recalled}\n\nWe decided to use execFile.`

    const stripped = stripDerivedContext(summary)

    assert.ok(!stripped.includes('Deploy from main'), 'a recalled memory must not be re-stored')
    assert.ok(!stripped.includes('never from a feature branch'))
    assert.ok(stripped.includes('The user asked about deploys.'))
    assert.ok(stripped.includes('We decided to use execFile.'), 'real narrative survives')
  })

  it('bounds an unterminated quote to the recall block\'s own shape', () => {
    // A summary may quote only part of the block, so the closing fence can be
    // missing; consuming to end of text would eat the surrounding narrative.
    const summary = [
      'Real content.',
      `${RECALL_BLOCK_START}\n- (rule, derived) old note`,
      'More real content.',
    ].join('\n\n')

    const stripped = stripDerivedContext(summary)

    assert.ok(!stripped.includes('old note'))
    assert.ok(stripped.includes('Real content.'))
    assert.ok(stripped.includes('More real content.'))
  })
})
