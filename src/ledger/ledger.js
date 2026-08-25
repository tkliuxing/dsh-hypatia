/**
 * The plugin-owned control ledger: the canonical control plane for
 * plugin-created semantic memories and their delivery state.
 *
 * Two rules shape every method here:
 *
 * 1. **Transactions stay short.** No ledger transaction is ever held open
 *    while a Hypatia process runs. Callers commit intent, run the CLI, then
 *    commit a receipt - three separate short transactions.
 * 2. **A stable operation ID is write-once.** Replaying one returns the
 *    existing receipt or enters reconciliation. It never creates a second
 *    memory, which is what makes crash, resume, and duplicate-notification
 *    replay safe.
 *
 * @module dsh-hypatia/ledger/ledger
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { ErrorCode, HypatiaError } from '../errors.js'
import { canonicalJson } from '../identity.js'
import { migrate } from './migrations.js'

/** @enum {string} Lifecycle of one plugin-owned memory. */
export const RecordState = {
  /** Intent committed; Hypatia has not confirmed the write. */
  PENDING: 'pending',
  /** Written and verified by exact read-back. */
  APPLIED: 'applied',
  /** Dispatched, outcome unknown. Needs reconciliation before retry. */
  UNCERTAIN: 'uncertain',
  /** The stable key exists holding a different payload. Needs a decision. */
  CONFLICT: 'conflict',
  /** Deletion requested. Immediately excluded from every recall path. */
  TOMBSTONED: 'tombstoned',
  /** Gave up after retries. */
  FAILED: 'failed',
}

/** @enum {string} Lifecycle of one mutation attempt. */
export const OperationState = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  APPLIED: 'applied',
  UNCERTAIN: 'uncertain',
  CONFLICT: 'conflict',
  FAILED: 'failed',
}

/** @enum {string} Honest cleanup status, surfaced verbatim by `memory_status`. */
export const CleanupState = {
  /** Hidden from recall; Hypatia not yet touched. */
  TOMBSTONED: 'tombstoned',
  /** Deleted from the active shelf and verified absent. */
  COMPLETE: 'active-shelf-cleanup-complete',
  /** Dispatched but unverified. Never report this as complete. */
  UNCERTAIN: 'cleanup-uncertain',
  /** Exports, backups, and other shelves are outside this plugin's reach. */
  EXTERNAL_UNKNOWN: 'external-retention-unknown',
}

const now = () => Date.now()

/**
 * Two distinct memories claimed the same memory ID. Never retryable: the
 * caller derived a colliding identity and has to fix that, so this is raised
 * as a structured CONFLICT the tools can report verbatim.
 */
function identityConflict(message) {
  return new HypatiaError(ErrorCode.CONFLICT, message, { retryable: false })
}

/**
 * Open (creating if needed) the control ledger at `file`.
 *
 * @param {string} file absolute path to the SQLite database
 * @returns {Ledger}
 */
export function openLedger(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  const migration = migrate(db)
  return new Ledger(db, migration)
}

export class Ledger {
  /**
   * @param {DatabaseSync} db
   * @param {{from: number, to: number, applied: number[]}} migration
   */
  constructor(db, migration) {
    this.db = db
    this.migration = migration
  }

  close() {
    this.db.close()
  }

  /**
   * Run `fn` inside one short transaction. Nesting is not supported on
   * purpose: a nested call would silently widen the outer transaction's
   * window, which is exactly what the short-transaction rule forbids.
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // --- operations -------------------------------------------------------

  /**
   * Commit durable intent for one mutation before any CLI call.
   *
   * Idempotent by `operationId`. A replay never inserts a second record; it
   * reports the state the first attempt reached so the caller can return a
   * receipt, reconcile, or retry.
   *
   * @param {{
   *   operationId: string, memoryId: string, verb: 'create'|'delete',
   *   scope: string, shelf: string, hypatiaName: string, kind: string,
   *   title?: string|null, payload?: object, payloadHash: string,
   *   trust?: 'user-confirmed'|'derived', redactionLabels?: string[],
   *   provenance?: object|null, sourceIdentity?: string|null,
   *   sessionId?: string|null, fromSeq?: number, throughSeq?: number, turn?: number,
   * }} intent
   * @returns {{status: 'new'|'replay', operation: object, record: object}}
   */
  beginOperation(intent) {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM memory_operation WHERE operation_id = ?')
        .get(intent.operationId)
      if (existing) {
        const record = this.db
          .prepare('SELECT * FROM memory_record WHERE memory_id = ?')
          .get(existing.memory_id)
        return { status: 'replay', operation: existing, record }
      }

      const timestamp = now()
      const payloadJson = intent.payload === undefined ? null : canonicalJson(intent.payload)

      // A record may already exist from an earlier operation on the same
      // memory (for example a delete after a create). Only insert once.
      const record = this.db
        .prepare('SELECT * FROM memory_record WHERE memory_id = ?')
        .get(intent.memoryId)

      if (record) {
        // A memory ID is an identity, not just a key. If an existing row
        // carries a different scope, shelf, or stable name, this is a genuine
        // collision between two distinct memories - adopting the existing row
        // would write to Hypatia under one name while the ledger vouches for
        // another, leaving the new memory unrecallable and its Hypatia entry
        // orphaned. Refuse instead of silently reusing.
        const mismatch = ['scope', 'shelf', 'hypatia_name'].find((column) => record[column] !== ({
          scope: intent.scope, shelf: intent.shelf, hypatia_name: intent.hypatiaName,
        })[column])
        if (mismatch) {
          throw identityConflict(
            `memory ${intent.memoryId} already exists with ${mismatch} `
            + `"${record[mismatch]}"; refusing to reuse it for a different memory`,
          )
        }
        // Same identity, new content (a re-summarized range, say). Keep the
        // canonical payload current: reconciliation compares Hypatia's stored
        // payload against `payload_hash`, so a stale hash here would surface a
        // conflict that no retry can clear.
        if (record.state !== RecordState.TOMBSTONED && record.payload_hash !== intent.payloadHash) {
          this.db.prepare(`
            UPDATE memory_record SET payload_json = ?, payload_hash = ?, title = ?, updated_at = ?
             WHERE memory_id = ?
          `).run(payloadJson, intent.payloadHash, intent.title ?? null, timestamp, intent.memoryId)
        }
      }

      if (!record) {
        this.db.prepare(`
          INSERT INTO memory_record (
            memory_id, scope, shelf, hypatia_name, kind, title,
            payload_json, payload_hash, state, trust, redaction_labels,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          intent.memoryId, intent.scope, intent.shelf, intent.hypatiaName,
          intent.kind, intent.title ?? null, payloadJson, intent.payloadHash,
          RecordState.PENDING, intent.trust ?? 'derived',
          JSON.stringify(intent.redactionLabels ?? []), timestamp, timestamp,
        )
      }

      if (intent.provenance) {
        this.db.prepare(`
          INSERT OR IGNORE INTO memory_provenance (
            memory_id, source_identity, session_id, from_seq, through_seq, turn,
            provenance_json, created_at, source_range_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          intent.memoryId, intent.sourceIdentity ?? '', intent.sessionId ?? null,
          intent.fromSeq ?? 0, intent.throughSeq ?? 0, intent.turn ?? 0,
          canonicalJson(intent.provenance), timestamp, intent.rangeKey ?? '',
        )
      }

      this.db.prepare(`
        INSERT INTO memory_operation (
          operation_id, memory_id, verb, state, intent_json, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        intent.operationId, intent.memoryId, intent.verb, OperationState.PENDING,
        canonicalJson({
          hypatiaName: intent.hypatiaName,
          scope: intent.scope,
          shelf: intent.shelf,
          kind: intent.kind,
          payloadHash: intent.payloadHash,
        }),
        timestamp, timestamp,
      )

      return {
        status: 'new',
        operation: this.db.prepare('SELECT * FROM memory_operation WHERE operation_id = ?').get(intent.operationId),
        record: this.db.prepare('SELECT * FROM memory_record WHERE memory_id = ?').get(intent.memoryId),
      }
    })
  }

  /** Mark an operation dispatched right before spawning the CLI. */
  markDispatched(operationId) {
    this.db.prepare(`
      UPDATE memory_operation
         SET state = ?, attempts = attempts + 1, updated_at = ?
       WHERE operation_id = ?
    `).run(OperationState.DISPATCHED, now(), operationId)
  }

  /**
   * Commit the verified receipt. Only this method moves a record to
   * `applied`, and only after the caller has read the payload back.
   */
  commitReceipt(operationId, receipt) {
    return this.transaction(() => {
      const timestamp = now()
      const operation = this.db
        .prepare('SELECT * FROM memory_operation WHERE operation_id = ?')
        .get(operationId)
      if (!operation) return false
      this.db.prepare(`
        UPDATE memory_operation
           SET state = ?, receipt_json = ?, error_json = NULL, updated_at = ?
         WHERE operation_id = ?
      `).run(OperationState.APPLIED, canonicalJson(receipt ?? {}), timestamp, operationId)

      // Never resurrect a tombstoned record. Deletion intent lives in
      // `memory_tombstone`, which is written before any CLI call, so a late
      // create receipt for a since-forgotten memory must not undo the forget.
      this.db.prepare(`
        UPDATE memory_record SET state = ?, updated_at = ?
         WHERE memory_id = ? AND state != ?
      `).run(RecordState.APPLIED, timestamp, operation.memory_id, RecordState.TOMBSTONED)
      this.db.prepare('DELETE FROM retry_queue WHERE operation_id = ?').run(operationId)
      return true
    })
  }

  /**
   * Record a non-terminal or terminal failure.
   *
   * `uncertain` means the write may have landed, so reconciliation must check
   * the stable key before any retry. `conflict` means the key holds someone
   * else's payload and needs a decision, never an overwrite.
   */
  markOperationFailure(operationId, state, error) {
    return this.transaction(() => {
      const timestamp = now()
      const operation = this.db
        .prepare('SELECT * FROM memory_operation WHERE operation_id = ?')
        .get(operationId)
      if (!operation) return false
      this.db.prepare(`
        UPDATE memory_operation SET state = ?, error_json = ?, updated_at = ? WHERE operation_id = ?
      `).run(state, canonicalJson(error ?? {}), timestamp, operationId)

      const recordState = {
        [OperationState.UNCERTAIN]: RecordState.UNCERTAIN,
        [OperationState.CONFLICT]: RecordState.CONFLICT,
        [OperationState.FAILED]: RecordState.FAILED,
      }[state]
      if (recordState) {
        // Never lift a tombstone because a later operation failed.
        this.db.prepare(`
          UPDATE memory_record SET state = ?, updated_at = ?
           WHERE memory_id = ? AND state != ?
        `).run(recordState, timestamp, operation.memory_id, RecordState.TOMBSTONED)
      }
      return true
    })
  }

  getOperation(operationId) {
    return this.db.prepare('SELECT * FROM memory_operation WHERE operation_id = ?').get(operationId)
  }

  /** Operations needing reconciliation after a crash, timeout, or reload. */
  pendingOperations(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM memory_operation
       WHERE state IN (?, ?, ?)
       ORDER BY updated_at ASC LIMIT ?
    `).all(OperationState.PENDING, OperationState.DISPATCHED, OperationState.UNCERTAIN, limit)
  }

  // --- records ----------------------------------------------------------

  getRecord(memoryId) {
    return this.db.prepare('SELECT * FROM memory_record WHERE memory_id = ?').get(memoryId)
  }

  getRecordByName(hypatiaName) {
    return this.db.prepare('SELECT * FROM memory_record WHERE hypatia_name = ?').get(hypatiaName)
  }

  /**
   * Active records for exactly this scope, newest first.
   *
   * Scope is compared with `=`, never a substring or `LIKE` match, and only
   * `applied` rows are returned - so tombstoned, pending, uncertain, and
   * conflicted records are absent from recall by construction.
   */
  recallCandidates({ scope, shelf, limit = 50 }) {
    return this.db.prepare(`
      SELECT * FROM memory_record
       WHERE state = ? AND scope = ? AND shelf = ?
       ORDER BY updated_at DESC
       LIMIT ?
    `).all(RecordState.APPLIED, scope, shelf, limit)
  }

  /**
   * Whether a Hypatia key may be surfaced by automatic recall in `scope`.
   * Requires an active ledger row whose scope matches exactly.
   */
  isRecallable(hypatiaName, scope, shelf) {
    const row = this.db.prepare(`
      SELECT 1 FROM memory_record
       WHERE hypatia_name = ? AND scope = ? AND shelf = ? AND state = ?
    `).get(hypatiaName, scope, shelf, RecordState.APPLIED)
    return row !== undefined
  }

  /**
   * Look up an existing memory for an exact source range, for idempotent
   * ingestion.
   *
   * Matches on `source_range_key` - the digest of the authoritative shadowed
   * sequence set - rather than a `from`/`through` pair, because that pair is a
   * surface-position span that two different compactions can share.
   */
  findBySourceRange({ sourceIdentity, rangeKey }) {
    if (!rangeKey) return undefined
    return this.db.prepare(`
      SELECT r.* FROM memory_record r
        JOIN memory_provenance p ON p.memory_id = r.memory_id
       WHERE p.source_identity = ? AND p.source_range_key = ?
    `).get(sourceIdentity, rangeKey)
  }

  // --- deletion ---------------------------------------------------------

  /**
   * Tombstone a memory synchronously, before any CLI call.
   *
   * After this returns, every plugin recall path already excludes the record,
   * even if the process dies before Hypatia is touched.
   */
  tombstone(memoryId, reason = null) {
    return this.transaction(() => {
      const record = this.db.prepare('SELECT * FROM memory_record WHERE memory_id = ?').get(memoryId)
      if (!record) return null
      const timestamp = now()
      this.db.prepare('UPDATE memory_record SET state = ?, updated_at = ? WHERE memory_id = ?')
        .run(RecordState.TOMBSTONED, timestamp, memoryId)
      this.db.prepare(`
        INSERT INTO memory_tombstone (
          memory_id, hypatia_name, shelf, scope, cleanup_state, reason, requested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (memory_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(
        memoryId, record.hypatia_name, record.shelf, record.scope,
        CleanupState.TOMBSTONED, reason, timestamp, timestamp,
      )
      return this.db.prepare('SELECT * FROM memory_tombstone WHERE memory_id = ?').get(memoryId)
    })
  }

  setCleanupState(memoryId, cleanupState) {
    this.db.prepare('UPDATE memory_tombstone SET cleanup_state = ?, updated_at = ? WHERE memory_id = ?')
      .run(cleanupState, now(), memoryId)
  }

  getTombstone(memoryId) {
    return this.db.prepare('SELECT * FROM memory_tombstone WHERE memory_id = ?').get(memoryId)
  }

  pendingCleanups(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM memory_tombstone
       WHERE cleanup_state IN (?, ?)
       ORDER BY updated_at ASC LIMIT ?
    `).all(CleanupState.TOMBSTONED, CleanupState.UNCERTAIN, limit)
  }

  /**
   * Drop the semantic payload once cleanup succeeded, keeping the row as
   * content-free audit metadata (identity, scope, timestamps, state).
   */
  purgePayload(memoryId) {
    this.db.prepare(`
      UPDATE memory_record SET payload_json = NULL, title = NULL, updated_at = ?
       WHERE memory_id = ?
    `).run(now(), memoryId)
    this.db.prepare('DELETE FROM memory_provenance WHERE memory_id = ?').run(memoryId)
  }

  // --- relations --------------------------------------------------------

  /** Record an exact plugin-created triple so cleanup can target it later. */
  recordRelation({ memoryId, subject, predicate, object, state = 'pending' }) {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO memory_relation (memory_id, subject, predicate, object, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject, predicate, object) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `).run(memoryId, subject, predicate, object, state, timestamp, timestamp)
  }

  setRelationState(subject, predicate, object, state) {
    this.db.prepare(`
      UPDATE memory_relation SET state = ?, updated_at = ?
       WHERE subject = ? AND predicate = ? AND object = ?
    `).run(state, now(), subject, predicate, object)
  }

  relationsFor(memoryId) {
    return this.db.prepare('SELECT * FROM memory_relation WHERE memory_id = ?').all(memoryId)
  }

  // --- cursors ----------------------------------------------------------

  getCursor(sourceIdentity) {
    return this.db.prepare('SELECT * FROM session_cursor WHERE source_identity = ?').get(sourceIdentity)
  }

  /**
   * Advance a consumption cursor. Monotonic: a stale notification can never
   * move `last_applied_seq` backwards and cause reprocessing.
   */
  setCursor({ sourceIdentity, sessionId = null, parentSession = null, seedLength = 0, lastAppliedSeq }) {
    this.db.prepare(`
      INSERT INTO session_cursor (
        source_identity, session_id, parent_session, seed_length, last_applied_seq, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_identity) DO UPDATE SET
        session_id       = excluded.session_id,
        parent_session   = excluded.parent_session,
        seed_length      = excluded.seed_length,
        last_applied_seq = MAX(session_cursor.last_applied_seq, excluded.last_applied_seq),
        updated_at       = excluded.updated_at
    `).run(sourceIdentity, sessionId, parentSession, seedLength, lastAppliedSeq, now())
  }

  // --- retry / dead letter ---------------------------------------------

  scheduleRetry(operationId, { delayMs = 1_000, error = null } = {}) {
    this.db.prepare(`
      INSERT INTO retry_queue (operation_id, next_attempt_at, attempts, last_error_json)
      VALUES (?, ?, 1, ?)
      ON CONFLICT (operation_id) DO UPDATE SET
        next_attempt_at = excluded.next_attempt_at,
        attempts        = retry_queue.attempts + 1,
        last_error_json = excluded.last_error_json
    `).run(operationId, now() + delayMs, error ? canonicalJson(error) : null)
  }

  getRetry(operationId) {
    return this.db.prepare('SELECT * FROM retry_queue WHERE operation_id = ?').get(operationId)
  }

  dueRetries(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM retry_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?
    `).all(now(), limit)
  }

  clearRetry(operationId) {
    this.db.prepare('DELETE FROM retry_queue WHERE operation_id = ?').run(operationId)
  }

  /** Give up on an operation, keeping only the content-free error. */
  deadLetter(operationId, memoryId, error) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO dead_letter (operation_id, memory_id, error_json, created_at) VALUES (?, ?, ?, ?)
      `).run(operationId, memoryId ?? null, canonicalJson(error ?? {}), now())
      this.db.prepare('DELETE FROM retry_queue WHERE operation_id = ?').run(operationId)
      this.db.prepare('UPDATE memory_operation SET state = ?, updated_at = ? WHERE operation_id = ?')
        .run(OperationState.FAILED, now(), operationId)
      // Carry the record to a terminal state too. Left in `uncertain` it would
      // keep `memory_status` telling the user to run `memory_reconcile`, while
      // `pendingOperations()` - which excludes `failed` - can never look at it
      // again. A tombstone still wins: a dead-lettered write must not lift one.
      if (memoryId) {
        this.db.prepare(`
          UPDATE memory_record SET state = ?, updated_at = ?
           WHERE memory_id = ? AND state != ?
        `).run(RecordState.FAILED, now(), memoryId, RecordState.TOMBSTONED)
      }
    })
  }

  // --- status -----------------------------------------------------------

  /**
   * Counts by state plus outstanding work, for `memory_status`. Content-free:
   * safe to show a user and safe to log.
   */
  status({ scope = null, shelf = null } = {}) {
    const where = []
    const params = []
    if (scope !== null) { where.push('scope = ?'); params.push(scope) }
    if (shelf !== null) { where.push('shelf = ?'); params.push(shelf) }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const records = this.db
      .prepare(`SELECT state, COUNT(*) AS count FROM memory_record ${filter} GROUP BY state`)
      .all(...params)
    const cleanups = this.db
      .prepare(`SELECT cleanup_state, COUNT(*) AS count FROM memory_tombstone ${filter} GROUP BY cleanup_state`)
      .all(...params)

    // Outstanding work carries the same filter. `memory_status` promises health
    // "for this project"; counting another project's pending operations here
    // would tell a user their memories are unverified when the entries in
    // question are ones they cannot see, own, or reconcile. Operations, retries
    // and dead letters reach a scope only through their record, so each one
    // joins `memory_record` and repeats the predicate on `r`.
    //
    // `dead_letter.memory_id` is nullable, so its join is LEFT and an
    // unattributable dead letter is counted only in the unfiltered view.
    const ownerFilter = where.length
      ? `WHERE ${where.map((clause) => `r.${clause}`).join(' AND ')}`
      : ''
    const count = (sql, extra = []) => this.db.prepare(sql).get(...extra, ...params)?.count ?? 0

    const toMap = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row.count]))
    return {
      schemaVersion: this.migration.to,
      records: toMap(records, 'state'),
      cleanups: toMap(cleanups, 'cleanup_state'),
      pendingOperations: this.db.prepare(`
        SELECT COUNT(*) AS count FROM memory_operation o
          JOIN memory_record r ON r.memory_id = o.memory_id
         WHERE o.state IN (?, ?, ?) ${where.map((clause) => `AND r.${clause}`).join(' ')}
      `).get(
        OperationState.PENDING, OperationState.DISPATCHED, OperationState.UNCERTAIN, ...params,
      )?.count ?? 0,
      retryQueue: count(`
        SELECT COUNT(*) AS count FROM retry_queue q
          JOIN memory_operation o ON o.operation_id = q.operation_id
          JOIN memory_record r ON r.memory_id = o.memory_id
        ${ownerFilter}
      `),
      deadLetters: count(`
        SELECT COUNT(*) AS count FROM dead_letter d
          LEFT JOIN memory_record r ON r.memory_id = d.memory_id
        ${ownerFilter}
      `),
    }
  }
}
