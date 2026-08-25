/**
 * Phase 0 acceptance gates for the control ledger.
 *
 * These are the invariants the rest of the plugin is allowed to assume:
 * migrations are idempotent, a stable operation ID is write-once, scope
 * isolation is exact, and a tombstone hides a record everywhere at once.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CleanupState, OperationState, RecordState, openLedger } from '../src/ledger/ledger.js'
import { MIGRATIONS, TARGET_VERSION, migrate } from '../src/ledger/migrations.js'

function intent(overrides = {}) {
  return {
    operationId: 'op-1',
    memoryId: 'mem-1',
    verb: 'create',
    scope: 'proj-a',
    shelf: 'default',
    hypatiaName: 'dshmem:v1:aaaa:mem-1',
    kind: 'rule',
    title: 'Prefer execFile',
    payload: { title: 'Prefer execFile', summary: 'Never build shell strings.' },
    payloadHash: 'hash-1',
    provenance: { source: { dshSessionId: 's1' } },
    sourceIdentity: 'src-1',
    fromSeq: 1,
    throughSeq: 4,
    ...overrides,
  }
}

/** Drive one memory all the way to `applied`. */
function applied(ledger, overrides = {}) {
  const request = intent(overrides)
  ledger.beginOperation(request)
  ledger.markDispatched(request.operationId)
  ledger.commitReceipt(request.operationId, { verified: true })
  return request
}

describe('ledger migrations', () => {
  it('is idempotent across repeated opens', () => {
    const ledger = openLedger(':memory:')
    assert.deepEqual(ledger.migration.applied, MIGRATIONS.map((m) => m.version))

    // Re-running against the same database must apply nothing further.
    const again = migrate(ledger.db)
    assert.deepEqual(again.applied, [])
    assert.equal(again.to, TARGET_VERSION)
    ledger.close()
  })

  it('rolls back a failing migration instead of half-applying it', () => {
    const ledger = openLedger(':memory:')
    const before = ledger.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v

    // A migration that creates a table then throws must leave neither behind.
    const broken = [{
      version: TARGET_VERSION + 1,
      up(db) {
        db.exec('CREATE TABLE halfway (x TEXT)')
        throw new Error('boom')
      },
    }]
    assert.throws(() => {
      for (const migration of broken) {
        ledger.db.exec('BEGIN IMMEDIATE')
        try {
          migration.up(ledger.db)
          ledger.db.exec('COMMIT')
        } catch (error) {
          ledger.db.exec('ROLLBACK')
          throw error
        }
      }
    }, /boom/)

    const after = ledger.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v
    assert.equal(after, before)
    const table = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='halfway'")
      .get()
    assert.equal(table, undefined)
    ledger.close()
  })
})

describe('operation identity', () => {
  it('replaying an operation ID cannot create a second memory', () => {
    const ledger = openLedger(':memory:')
    const first = ledger.beginOperation(intent())
    const second = ledger.beginOperation(intent())

    assert.equal(first.status, 'new')
    assert.equal(second.status, 'replay')
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_record').get().c, 1)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_operation').get().c, 1)
    ledger.close()
  })

  it('replaying an applied operation reports its committed state', () => {
    const ledger = openLedger(':memory:')
    applied(ledger)
    const replay = ledger.beginOperation(intent())

    assert.equal(replay.status, 'replay')
    assert.equal(replay.operation.state, OperationState.APPLIED)
    ledger.close()
  })

  it('only a committed receipt moves a record to applied', () => {
    const ledger = openLedger(':memory:')
    ledger.beginOperation(intent())
    assert.equal(ledger.getRecord('mem-1').state, RecordState.PENDING)

    ledger.markDispatched('op-1')
    assert.equal(ledger.getRecord('mem-1').state, RecordState.PENDING)

    ledger.commitReceipt('op-1', { verified: true })
    assert.equal(ledger.getRecord('mem-1').state, RecordState.APPLIED)
    ledger.close()
  })

  it('a failed later operation cannot lift an existing tombstone', () => {
    const ledger = openLedger(':memory:')
    applied(ledger)
    ledger.tombstone('mem-1', 'user forget')

    ledger.beginOperation(intent({ operationId: 'op-2', verb: 'create' }))
    ledger.markOperationFailure('op-2', OperationState.UNCERTAIN, { code: 'uncertain' })

    assert.equal(ledger.getRecord('mem-1').state, RecordState.TOMBSTONED)
    ledger.close()
  })
})

describe('scope isolation', () => {
  it('never returns a record from another project', () => {
    const ledger = openLedger(':memory:')
    applied(ledger, { operationId: 'op-a', memoryId: 'mem-a', scope: 'proj-a', hypatiaName: 'dshmem:v1:aaaa:mem-a' })
    applied(ledger, { operationId: 'op-b', memoryId: 'mem-b', scope: 'proj-b', hypatiaName: 'dshmem:v1:bbbb:mem-b' })

    const a = ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' })
    const b = ledger.recallCandidates({ scope: 'proj-b', shelf: 'default' })

    assert.deepEqual(a.map((row) => row.memory_id), ['mem-a'])
    assert.deepEqual(b.map((row) => row.memory_id), ['mem-b'])
    ledger.close()
  })

  it('does not treat a scope prefix or empty scope as a match', () => {
    const ledger = openLedger(':memory:')
    applied(ledger, { scope: 'proj-alpha' })

    // Substring semantics are exactly the bug the empty-scope trap causes.
    assert.equal(ledger.recallCandidates({ scope: 'proj', shelf: 'default' }).length, 0)
    assert.equal(ledger.recallCandidates({ scope: '', shelf: 'default' }).length, 0)
    assert.equal(ledger.recallCandidates({ scope: 'proj-alpha', shelf: 'default' }).length, 1)
    ledger.close()
  })

  it('refuses a recallable check for the wrong scope or shelf', () => {
    const ledger = openLedger(':memory:')
    applied(ledger, { scope: 'proj-a', shelf: 'default' })

    assert.equal(ledger.isRecallable('dshmem:v1:aaaa:mem-1', 'proj-a', 'default'), true)
    assert.equal(ledger.isRecallable('dshmem:v1:aaaa:mem-1', 'proj-b', 'default'), false)
    assert.equal(ledger.isRecallable('dshmem:v1:aaaa:mem-1', 'proj-a', 'other-shelf'), false)
    ledger.close()
  })
})

describe('tombstones', () => {
  it('hides a record from every recall path immediately', () => {
    const ledger = openLedger(':memory:')
    applied(ledger)
    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 1)

    ledger.tombstone('mem-1', 'user forget')

    assert.equal(ledger.recallCandidates({ scope: 'proj-a', shelf: 'default' }).length, 0)
    assert.equal(ledger.isRecallable('dshmem:v1:aaaa:mem-1', 'proj-a', 'default'), false)
    assert.equal(ledger.getTombstone('mem-1').cleanup_state, CleanupState.TOMBSTONED)
    ledger.close()
  })

  it('keeps content-free audit metadata after the payload is purged', () => {
    const ledger = openLedger(':memory:')
    applied(ledger)
    ledger.tombstone('mem-1')
    ledger.setCleanupState('mem-1', CleanupState.COMPLETE)
    ledger.purgePayload('mem-1')

    const record = ledger.getRecord('mem-1')
    assert.equal(record.payload_json, null)
    assert.equal(record.title, null)
    assert.equal(record.scope, 'proj-a')
    assert.ok(record.created_at > 0)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS c FROM memory_provenance').get().c, 0)
    ledger.close()
  })

  it('pending cleanups list tombstoned and uncertain work only', () => {
    const ledger = openLedger(':memory:')
    applied(ledger, { operationId: 'op-a', memoryId: 'mem-a', hypatiaName: 'dshmem:v1:aaaa:mem-a' })
    applied(ledger, { operationId: 'op-b', memoryId: 'mem-b', hypatiaName: 'dshmem:v1:aaaa:mem-b' })
    ledger.tombstone('mem-a')
    ledger.tombstone('mem-b')
    ledger.setCleanupState('mem-b', CleanupState.COMPLETE)

    assert.deepEqual(ledger.pendingCleanups().map((row) => row.memory_id), ['mem-a'])
    ledger.close()
  })
})

describe('cursors and retries', () => {
  it('never moves a cursor backwards on a stale notification', () => {
    const ledger = openLedger(':memory:')
    ledger.setCursor({ sourceIdentity: 'src-1', lastAppliedSeq: 40 })
    ledger.setCursor({ sourceIdentity: 'src-1', lastAppliedSeq: 12 })

    assert.equal(ledger.getCursor('src-1').last_applied_seq, 40)
    ledger.close()
  })

  it('dead-letters an operation and clears its retry entry', () => {
    const ledger = openLedger(':memory:')
    ledger.beginOperation(intent())
    ledger.scheduleRetry('op-1', { delayMs: 0, error: { code: 'timeout' } })
    assert.equal(ledger.dueRetries().length, 1)

    ledger.deadLetter('op-1', 'mem-1', { code: 'timeout' })

    assert.equal(ledger.dueRetries().length, 0)
    assert.equal(ledger.getOperation('op-1').state, OperationState.FAILED)
    assert.equal(ledger.status().deadLetters, 1)
    ledger.close()
  })
})

describe('status is scoped to one project', () => {
  it('counts outstanding work for this scope only', () => {
    const ledger = openLedger(':memory:')
    // One project shares the per-user ledger file with another.
    ledger.beginOperation(intent({ scope: 'proj-a' }))

    const other = ledger.status({ scope: 'proj-b', shelf: 'default' })
    const own = ledger.status({ scope: 'proj-a', shelf: 'default' })

    // `memory_status` promises health "for this project", and its note flips to
    // "some operations are unverified" off the back of these counts.
    assert.deepEqual(other.records, {})
    assert.equal(other.pendingOperations, 0)
    assert.equal(own.pendingOperations, 1)
    ledger.close()
  })

  it('keeps counting everything in the unfiltered view', () => {
    const ledger = openLedger(':memory:')
    ledger.beginOperation(intent({ scope: 'proj-a' }))
    ledger.beginOperation(intent({ operationId: 'op-2', memoryId: 'mem-2', hypatiaName: 'n-2', scope: 'proj-b' }))

    assert.equal(ledger.status().pendingOperations, 2)
    ledger.close()
  })
})

describe('dead letters reach a terminal record state', () => {
  it('does not leave the record looking reconcilable', () => {
    const ledger = openLedger(':memory:')
    ledger.beginOperation(intent())
    ledger.markOperationFailure('op-1', OperationState.UNCERTAIN, { code: 'timeout' })

    ledger.deadLetter('op-1', 'mem-1', { code: 'timeout' })

    // Left `uncertain`, the record would keep memory_status telling the user to
    // run memory_reconcile, while pendingOperations() - which excludes failed
    // operations - could never look at it again.
    assert.equal(ledger.getRecord('mem-1').state, RecordState.FAILED)
    assert.equal(ledger.status().pendingOperations, 0)
    ledger.close()
  })

  it('still refuses to lift a tombstone', () => {
    const ledger = openLedger(':memory:')
    ledger.beginOperation(intent())
    ledger.tombstone('mem-1', 'user forget')

    ledger.deadLetter('op-1', 'mem-1', { code: 'timeout' })

    assert.equal(ledger.getRecord('mem-1').state, RecordState.TOMBSTONED)
    ledger.close()
  })
})
