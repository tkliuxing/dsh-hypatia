/**
 * Phase 2 acceptance gates for the mutation wrapper.
 *
 * The claim under test is narrow and important: a memory reaches `applied`
 * only after its payload is read back and matched. Everything else - a lost
 * response, a duplicate key holding foreign content, a crash between dispatch
 * and receipt - must surface as an explicit state, never as a silent success.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ErrorCode, HypatiaError } from '../src/errors.js'
import { CleanupState, RecordState, openLedger } from '../src/ledger/ledger.js'
import { MutationCoordinator } from '../src/mutations.js'
import { canonicalJson, payloadHash } from '../src/identity.js'
import { FakeAdapter } from './helpers/fake-adapter.js'

function setup() {
  const ledger = openLedger(':memory:')
  const adapter = new FakeAdapter()
  const warnings = []
  const mutations = new MutationCoordinator({
    ledger, adapter, shelf: 'default', warn: (message) => warnings.push(message),
  })
  return { ledger, adapter, mutations, warnings }
}

function request(overrides = {}) {
  return {
    operationId: 'op-1',
    memoryId: 'mem-1',
    hypatiaName: 'dshmem:v1:aaaa:mem-1',
    scope: 'proj-a',
    kind: 'decision',
    title: 'Use the CLI adapter',
    payload: { title: 'Use the CLI adapter', summary: 'One absolute binary, fixed argv.' },
    sourceIdentity: 'src-1',
    fromSeq: 1,
    throughSeq: 4,
    ...overrides,
  }
}

describe('write verification', () => {
  it('applies only after the payload reads back identical', async () => {
    const { ledger, adapter, mutations } = setup()
    const result = await mutations.writeMemory(request())

    assert.equal(result.status, 'applied')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
    // create, then the verifying read.
    assert.deepEqual(adapter.calls.map((call) => call[0]), ['knowledgeCreate', 'knowledgeGet'])
    ledger.close()
  })

  it('reports uncertain when the key is absent on read-back', async () => {
    const { ledger, adapter, mutations } = setup()
    // Create "succeeds" but nothing lands - the partial-write shape.
    adapter.knowledgeCreate = async () => ({ ok: true, text: 'Created knowledge: x' })

    const result = await mutations.writeMemory(request())

    assert.equal(result.status, 'uncertain')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.UNCERTAIN)
    // Queued with backoff, so it is scheduled but not yet due.
    assert.equal(ledger.status().retryQueue, 1)
    assert.equal(ledger.dueRetries().length, 0)
    ledger.close()
  })

  it('treats a duplicate key with an identical payload as applied', async () => {
    const { ledger, adapter, mutations } = setup()
    // Pre-seed exactly what this operation intends to write: the shape a
    // successful-but-unacknowledged retry leaves behind.
    const payload = request().payload
    adapter.knowledge.set('dshmem:v1:aaaa:mem-1', {
      name: 'dshmem:v1:aaaa:mem-1',
      content: { data: canonicalJson(payload), tags: [], scopes: ['proj-a'] },
    })

    const result = await mutations.writeMemory(request())

    assert.equal(result.status, 'applied')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
    ledger.close()
  })

  it('refuses to overwrite a duplicate key holding a different payload', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledge.set('dshmem:v1:aaaa:mem-1', {
      name: 'dshmem:v1:aaaa:mem-1',
      content: { data: JSON.stringify({ someoneElse: true }), tags: [], scopes: ['proj-a'] },
    })

    const result = await mutations.writeMemory(request())

    assert.equal(result.status, 'conflict')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.CONFLICT)
    // The foreign record must survive untouched.
    assert.deepEqual(
      JSON.parse(adapter.knowledge.get('dshmem:v1:aaaa:mem-1').content.data),
      { someoneElse: true },
    )
    // A conflict needs a decision, not a retry.
    assert.equal(ledger.dueRetries().length, 0)
    ledger.close()
  })

  it('redacts secrets before they reach the knowledge base', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request({
      payload: { title: 'creds', summary: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyz' },
    }))

    const stored = adapter.knowledge.get('dshmem:v1:aaaa:mem-1').content.data
    assert.ok(!stored.includes('ghp_0123456789'), 'raw token must not be stored')
    assert.ok(stored.includes('[redacted]'))
    assert.deepEqual(JSON.parse(ledger.getRecord('mem-1').redaction_labels), ['github-token'])
    ledger.close()
  })

  it('does not re-dispatch an already applied operation', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request())
    const callsAfterFirst = adapter.calls.length

    const replay = await mutations.writeMemory(request())

    assert.equal(replay.status, 'replayed')
    assert.equal(adapter.calls.length, callsAfterFirst, 'replay must not touch the CLI')
    ledger.close()
  })

  it('records relation fanout exactly, for later cleanup', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request({
      relations: [{ predicate: 'derivedFrom', object: 'dshsession:v1:abc' }],
    }))

    const relations = ledger.relationsFor('mem-1')
    assert.equal(relations.length, 1)
    assert.equal(relations[0].state, 'applied')
    assert.ok(adapter.statements.has('dshmem:v1:aaaa:mem-1,derivedFrom,dshsession:v1:abc'))
    ledger.close()
  })
})

describe('forget', () => {
  it('hides the memory before touching Hypatia, then verifies absence', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request({
      relations: [{ predicate: 'derivedFrom', object: 'dshsession:v1:abc' }],
    }))

    const outcome = await mutations.forget({ memoryId: 'mem-1', reason: 'user forget' })

    assert.equal(outcome.cleanupState, CleanupState.COMPLETE)
    assert.equal(outcome.relations, 1)
    assert.equal(adapter.knowledge.has('dshmem:v1:aaaa:mem-1'), false)
    assert.equal(adapter.statements.size, 0)
    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 0)
    assert.equal(ledger.getRecord('mem-1').payload_json, null)
    ledger.close()
  })

  it('keeps the record hidden and reports uncertain when deletion fails', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request())
    adapter.failNext('knowledgeDelete', new HypatiaError(ErrorCode.TIMEOUT, 'timed out', { dispatched: true }))

    const outcome = await mutations.forget({ memoryId: 'mem-1' })

    assert.equal(outcome.cleanupState, CleanupState.UNCERTAIN)
    // Hidden regardless of the backend outcome - that is the whole point of
    // tombstoning first.
    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 0)
    // And the payload is retained so cleanup can be retried honestly.
    assert.notEqual(ledger.getRecord('mem-1').payload_json, null)
    ledger.close()
  })

  it('treats an already absent record as cleaned', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request())
    adapter.knowledge.clear()

    const outcome = await mutations.forget({ memoryId: 'mem-1' })

    assert.equal(outcome.cleanupState, CleanupState.COMPLETE)
    ledger.close()
  })

  it('rejects an unknown memory instead of guessing a target', async () => {
    const { ledger, mutations } = setup()
    await assert.rejects(
      () => mutations.forget({ memoryId: 'never-existed' }),
      (error) => error.code === ErrorCode.VALIDATION,
    )
    ledger.close()
  })
})

describe('reconciliation', () => {
  it('settles an uncertain operation by stable key rather than rewriting', async () => {
    const { ledger, adapter, mutations } = setup()
    // Simulate a crash after dispatch: Hypatia holds the record, the ledger
    // never received a receipt.
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    const first = await mutations.writeMemory(request())
    assert.equal(first.status, 'uncertain')

    // The write had actually landed.
    adapter.knowledge.set('dshmem:v1:aaaa:mem-1', {
      name: 'dshmem:v1:aaaa:mem-1',
      content: { data: canonicalJson(request().payload), tags: [], scopes: ['proj-a'] },
    })

    const summary = await mutations.reconcile()

    assert.equal(summary.applied, 1)
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
    ledger.close()
  })

  it('marks a conflict when the stable key holds foreign content', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    await mutations.writeMemory(request())

    adapter.knowledge.set('dshmem:v1:aaaa:mem-1', {
      name: 'dshmem:v1:aaaa:mem-1',
      content: { data: JSON.stringify({ foreign: true }), tags: [], scopes: ['proj-a'] },
    })

    const summary = await mutations.reconcile()

    assert.equal(summary.conflicts, 1)
    assert.equal(ledger.getRecord('mem-1').state, RecordState.CONFLICT)
    ledger.close()
  })

  it('drains a due retry by re-dispatching from the ledger payload', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    await mutations.writeMemory(request())
    assert.equal(ledger.status().retryQueue, 1)

    // The backoff elapses, and the CLI recovers.
    ledger.scheduleRetry('op-1', { delayMs: -1 })
    adapter.knowledgeCreate = FakeAdapter.prototype.knowledgeCreate

    const summary = await mutations.reconcile()

    assert.equal(summary.applied, 1)
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
    assert.equal(adapter.knowledge.size, 1)
    assert.equal(ledger.status().retryQueue, 0, 'a drained retry must be cleared')
    ledger.close()
  })

  it('does not re-dispatch before the backoff elapses', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    await mutations.writeMemory(request())
    adapter.knowledgeCreate = FakeAdapter.prototype.knowledgeCreate

    const summary = await mutations.reconcile()

    assert.equal(summary.applied, 0)
    assert.equal(adapter.knowledge.size, 0, 'a not-yet-due retry must not fire')
    ledger.close()
  })

  it('never recreates a memory the user already forgot', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    await mutations.writeMemory(request())

    // The user forgets it while the write is still uncertain.
    ledger.tombstone('mem-1', 'user forget')
    ledger.scheduleRetry('op-1', { delayMs: -1 })
    adapter.knowledgeCreate = FakeAdapter.prototype.knowledgeCreate

    await mutations.reconcile()

    assert.equal(ledger.getRecord('mem-1').state, RecordState.TOMBSTONED)
    assert.equal(adapter.knowledge.size, 0, 'reconciliation must not resurrect a forgotten memory')
    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 0)
    ledger.close()
  })

  it('leaves an operation unresolved when the key is still absent', async () => {
    const { ledger, adapter, mutations } = setup()
    adapter.knowledgeCreate = async () => { throw new HypatiaError(ErrorCode.TIMEOUT, 'lost', { dispatched: true }) }
    await mutations.writeMemory(request())

    const summary = await mutations.reconcile()

    assert.equal(summary.unresolved, 1)
    assert.equal(summary.applied, 0)
    ledger.close()
  })
})

/**
 * Regressions from the max-effort review.
 *
 * Each of these shipped with a green suite, so they are written against the
 * observable outcome - what is in Hypatia, what the ledger says, what the
 * caller is told - rather than against the shape of the code that failed.
 */
describe('write-path regressions', () => {
  it('refuses to recreate a memory the user forgot, instead of claiming success', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request())
    await mutations.forget({ memoryId: 'mem-1' })
    assert.equal(adapter.knowledge.size, 0, 'forget removed it from the shelf')

    // A re-delivered compaction summary, or the same content remembered again,
    // arrives with a fresh operation ID over the same stable memory.
    const result = await mutations.writeMemory(request({ operationId: 'op-2' }))

    assert.equal(result.status, 'failed')
    assert.equal(adapter.knowledge.size, 0, 'a forgotten memory must not come back')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.TOMBSTONED)
    // The tombstone is already cleanup-complete, so a resurrected row would be
    // orphaned: nothing would ever try to delete it again.
    assert.equal(ledger.getTombstone('mem-1').cleanup_state, CleanupState.COMPLETE)
  })

  it('refuses a memory ID that another scope already owns', async () => {
    const { ledger, mutations } = setup()
    await mutations.writeMemory(request())

    await assert.rejects(
      () => mutations.writeMemory(request({
        operationId: 'op-2', scope: 'proj-b', hypatiaName: 'dshmem:v1:bbbb:mem-1',
      })),
      (error) => error.code === ErrorCode.CONFLICT,
    )
    assert.equal(ledger.getRecord('mem-1').scope, 'proj-a', 'the first owner keeps the row')
  })

  it('keeps the canonical payload current when the same memory is rewritten', async () => {
    const { ledger, adapter, mutations } = setup()
    // The first attempt never lands, so the stable key is still free.
    adapter.failNext('knowledgeCreate', new HypatiaError(ErrorCode.CLI_ERROR, 'boom'))
    await mutations.writeMemory(request())
    assert.equal(adapter.knowledge.size, 0)

    // A re-summarized range writes new content under the same stable memory.
    const revised = { title: 'Use the CLI adapter', summary: 'Rewritten after a re-summarize.' }
    const result = await mutations.writeMemory(request({ operationId: 'op-2', payload: revised }))

    assert.equal(result.status, 'applied')
    // A stale payload_hash here would make reconcile report a conflict against
    // content this plugin itself just wrote, hiding it from recall for good.
    const summary = await mutations.reconcile()
    assert.equal(summary.conflicts, 0)
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
  })

  it('records what was redacted even when the caller redacted first', async () => {
    const { ledger, mutations } = setup()
    await mutations.writeMemory(request({
      payload: { title: 'key', summary: 'AKIAIOSFODNN7EXAMPLE' },
      redactionLabels: ['aws-access-key'],
    }))

    assert.deepEqual(JSON.parse(ledger.getRecord('mem-1').redaction_labels), ['aws-access-key'])
  })
})

describe('cleanup honesty', () => {
  it('reports uncertain, and keeps retrying, when a relation delete fails', async () => {
    const { ledger, adapter, mutations } = setup()
    await mutations.writeMemory(request({ relations: [{ predicate: 'about', object: 'thing-1' }] }))
    adapter.failNext('statementDelete', new HypatiaError(ErrorCode.CLI_ERROR, 'locked', { dispatched: true }))

    const outcome = await mutations.forget({ memoryId: 'mem-1' })

    assert.equal(outcome.cleanupState, CleanupState.UNCERTAIN, 'a stranded triple is not "complete"')
    assert.equal(ledger.getTombstone('mem-1').cleanup_state, CleanupState.UNCERTAIN)
    assert.ok(
      ledger.pendingCleanups().some((row) => row.memory_id === 'mem-1'),
      'an unfinished cleanup must stay in the queue that retries it',
    )
    assert.ok(ledger.getRecord('mem-1').payload_json, 'the payload survives for the retry')
  })
})

describe('reconciliation drains stuck work', () => {
  it('settles an intent that never reached the retry queue', async () => {
    const { ledger, adapter, mutations } = setup()
    // A crash between durable intent and dispatch: `#recordFailure` never ran,
    // so nothing ever scheduled a retry for this operation.
    const intent = request()
    ledger.beginOperation({
      ...intent, verb: 'create', shelf: 'default', payloadHash: payloadHash(intent.payload),
    })

    assert.equal((await mutations.reconcile()).unresolved, 1)
    assert.equal(ledger.status().retryQueue, 1, 'reconcile gives it a backoff slot')

    ledger.db.prepare('UPDATE retry_queue SET next_attempt_at = 0').run()
    const second = await mutations.reconcile()

    assert.equal(second.applied, 1, 'the next due pass actually re-dispatches it')
    assert.equal(adapter.knowledge.size, 1)
  })
})
