/**
 * The mutation wrapper: durable intent, stable names, read-back verification,
 * retry, conflict detection, and reconciliation.
 *
 * A zero exit code from the CLI is not a receipt. Every write here is followed
 * by an exact read of the stable key and a payload-hash comparison, and only
 * that comparison moves a record to `applied`. Anything else becomes an
 * explicit `uncertain` or `conflict` state that `memory_status` can report
 * honestly.
 *
 * @module dsh-hypatia/mutations
 */

import { ErrorCode, HypatiaError, asHypatiaError } from './errors.js'
import { CleanupState, OperationState, RecordState } from './ledger/ledger.js'
import { CliFailure, normalizeKnowledge } from './adapter/parse.js'
import { canonicalJson, payloadHash, PLUGIN_TAG } from './identity.js'
import { redactDeep } from './redaction.js'

/** Backoff schedule for retryable operations, in milliseconds. */
const RETRY_DELAYS = [1_000, 5_000, 30_000]

/**
 * Coordinates the ledger and the CLI adapter for every write.
 *
 * Holds no ledger transaction across a CLI call: intent, dispatch, and receipt
 * are three separate short transactions with the subprocess in between.
 */
export class MutationCoordinator {
  /**
   * @param {{ledger: import('./ledger/ledger.js').Ledger,
   *   adapter: import('./adapter/cli.js').HypatiaAdapter,
   *   shelf: string, warn: (msg: string) => void, batchSize?: number}} deps
   */
  constructor({ ledger, adapter, shelf, warn, batchSize = 50 }) {
    this.ledger = ledger
    this.adapter = adapter
    this.shelf = shelf
    this.warn = warn
    this.batchSize = batchSize
  }

  /**
   * Create a plugin-owned semantic memory and verify it landed.
   *
   * Idempotent by `operationId`: a replay of an applied operation returns the
   * stored receipt without touching Hypatia.
   *
   * @param {{operationId: string, memoryId: string, hypatiaName: string,
   *   scope: string, kind: string, title?: string|null, payload: object,
   *   provenance?: object|null, sourceIdentity?: string|null, sessionId?: string|null,
   *   fromSeq?: number, throughSeq?: number, turn?: number,
   *   trust?: 'user-confirmed'|'derived', relations?: Array<{predicate: string, object: string}>,
   *   signal?: AbortSignal}} request
   * @returns {Promise<{status: 'applied'|'replayed'|'uncertain'|'conflict', memoryId: string,
   *   hypatiaName: string, error?: object}>}
   */
  async writeMemory(request) {
    const { value: safePayload, labels } = redactDeep(request.payload)
    const hash = payloadHash(safePayload)
    // Redaction runs here unconditionally, whatever the caller claims. A caller
    // that already redacted (the tools do, so they can hash the redacted form)
    // hands its labels over, because this pass finds nothing left to strip and
    // would otherwise record an empty audit trail for a write that did carry a
    // secret.
    const redactionLabels = [...new Set([...labels, ...(request.redactionLabels ?? [])])]

    const begin = this.ledger.beginOperation({
      operationId: request.operationId,
      memoryId: request.memoryId,
      verb: 'create',
      scope: request.scope,
      shelf: this.shelf,
      hypatiaName: request.hypatiaName,
      kind: request.kind,
      title: request.title ?? null,
      payload: safePayload,
      payloadHash: hash,
      trust: request.trust ?? 'derived',
      redactionLabels,
      provenance: request.provenance ?? null,
      sourceIdentity: request.sourceIdentity ?? null,
      sessionId: request.sessionId ?? null,
      fromSeq: request.fromSeq ?? 0,
      throughSeq: request.throughSeq ?? 0,
      turn: request.turn ?? 0,
      rangeKey: request.rangeKey ?? '',
    })

    if (begin.status === 'replay' && begin.operation.state === OperationState.APPLIED) {
      return { status: 'replayed', memoryId: request.memoryId, hypatiaName: request.hypatiaName }
    }

    // A forget is final on the write path too, not just on the receipt path.
    // `commitReceipt` already refuses to lift a tombstone, but without this
    // guard the CLI call still runs first: a re-delivered compaction summary
    // or a re-derived content key would put the deleted payload back into
    // Hypatia under a key whose tombstone is already marked cleanup-complete,
    // so nothing would ever remove it again - while the caller was told the
    // write was "stored and verified".
    if (begin.record?.state === RecordState.TOMBSTONED) {
      const error = new HypatiaError(ErrorCode.VALIDATION,
        `memory ${request.memoryId} was forgotten; refusing to recreate it`,
        { retryable: false })
      this.ledger.markOperationFailure(request.operationId, OperationState.FAILED, error.toJSON())
      return {
        status: 'failed',
        memoryId: request.memoryId,
        hypatiaName: request.hypatiaName,
        error: error.toJSON(),
      }
    }

    return this.#dispatchCreate({
      operationId: request.operationId,
      memoryId: request.memoryId,
      hypatiaName: request.hypatiaName,
      scope: request.scope,
      kind: request.kind,
      payload: safePayload,
      hash,
      relations: request.relations ?? [],
      signal: request.signal,
    })
  }

  /** Run the create, then verify by exact read-back. */
  async #dispatchCreate({ operationId, memoryId, hypatiaName, scope, kind, payload, hash, relations, signal }) {
    this.ledger.markDispatched(operationId)
    const data = canonicalJson(payload)

    try {
      await this.adapter.knowledgeCreate({
        name: hypatiaName,
        data,
        tags: [PLUGIN_TAG, kind],
        scopes: [scope],
        shelf: this.shelf,
        signal,
      })
    } catch (error) {
      const failure = error?.detail?.failure
      if (failure !== CliFailure.DUPLICATE) {
        // Not-yet-dispatched failures are plain retries; anything that reached
        // the process is `uncertain` until read-back proves otherwise.
        return this.#recordFailure(operationId, memoryId, error)
      }
      // Duplicate key: either our own successful retry, or someone else's
      // record under the same name. Read-back decides which.
    }

    return this.#verifyCreate({ operationId, memoryId, hypatiaName, hash, relations, scope, signal })
  }

  /**
   * Compare the stored payload against ledger intent.
   * Same hash means applied (including after a duplicate-key retry); a
   * different hash is a conflict we must not overwrite.
   */
  async #verifyCreate({ operationId, memoryId, hypatiaName, hash, relations, scope, signal }) {
    let stored
    try {
      stored = await this.adapter.knowledgeGet(hypatiaName, { shelf: this.shelf, signal })
    } catch (error) {
      return this.#recordFailure(operationId, memoryId, asHypatiaError(error))
    }

    if (!stored) {
      const error = new HypatiaError(ErrorCode.UNCERTAIN,
        'write dispatched but the key is absent on read-back', { dispatched: true })
      return this.#recordFailure(operationId, memoryId, error)
    }

    const observed = payloadHash(parseStoredPayload(stored))
    if (observed !== hash) {
      const error = new HypatiaError(ErrorCode.CONFLICT,
        `key ${hypatiaName} holds a different payload; refusing to overwrite`,
        { dispatched: true, retryable: false })
      this.ledger.markOperationFailure(operationId, OperationState.CONFLICT, error.toJSON())
      return { status: 'conflict', memoryId, hypatiaName, error: error.toJSON() }
    }

    // Relations fan out after the knowledge row exists; each is recorded and
    // verified independently so a partial fanout is retryable.
    const relationResults = await this.#writeRelations({ memoryId, hypatiaName, relations, scope, signal })

    this.ledger.commitReceipt(operationId, {
      hypatiaName,
      payloadHash: hash,
      verifiedAt: Date.now(),
      relations: relationResults,
    })
    this.ledger.clearRetry(operationId)
    return { status: 'applied', memoryId, hypatiaName }
  }

  /** Create and verify each exact triple, recording it for later cleanup. */
  async #writeRelations({ memoryId, hypatiaName, relations, scope, signal }) {
    const results = []
    for (const relation of relations) {
      const triple = { subject: hypatiaName, predicate: relation.predicate, object: relation.object }
      this.ledger.recordRelation({ memoryId, ...triple, state: 'pending' })
      try {
        await this.adapter.statementCreate({ ...triple, scopes: [scope], shelf: this.shelf, signal })
        this.ledger.setRelationState(triple.subject, triple.predicate, triple.object, 'applied')
        results.push({ ...triple, state: 'applied' })
      } catch (error) {
        const duplicate = error?.detail?.failure === CliFailure.DUPLICATE
        const state = duplicate ? 'applied' : 'uncertain'
        this.ledger.setRelationState(triple.subject, triple.predicate, triple.object, state)
        results.push({ ...triple, state })
        if (!duplicate) this.warn(`relation fanout incomplete for ${hypatiaName}: ${error.message}`)
      }
    }
    return results
  }

  /** Persist a failure and schedule a retry when the code allows one. */
  #recordFailure(operationId, memoryId, rawError) {
    const error = asHypatiaError(rawError)
    const state = error.dispatched || error.code === ErrorCode.UNCERTAIN
      ? OperationState.UNCERTAIN
      : OperationState.FAILED
    this.ledger.markOperationFailure(operationId, state, error.toJSON())

    if (error.retryable) {
      const attempts = this.ledger.getOperation(operationId)?.attempts ?? 1
      const delayMs = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
      if (attempts > RETRY_DELAYS.length) {
        this.ledger.deadLetter(operationId, memoryId, error.toJSON())
      } else {
        this.ledger.scheduleRetry(operationId, { delayMs, error: error.toJSON() })
      }
    }
    return {
      status: state === OperationState.UNCERTAIN ? 'uncertain' : 'failed',
      memoryId,
      hypatiaName: this.ledger.getRecord(memoryId)?.hypatia_name ?? null,
      error: error.toJSON(),
    }
  }

  /**
   * Two-stage forget, stage two.
   *
   * The tombstone is written first and synchronously, so recall stops
   * returning the memory even if this process dies before Hypatia is touched.
   * Cleanup status is then reported exactly, never optimistically.
   *
   * @param {{memoryId: string, reason?: string, signal?: AbortSignal}} request
   * @returns {Promise<{memoryId: string, cleanupState: string, relations: number, error?: object}>}
   */
  async forget({ memoryId, reason = null, signal }) {
    const record = this.ledger.getRecord(memoryId)
    if (!record) {
      throw new HypatiaError(ErrorCode.VALIDATION, `unknown memory ${memoryId}`)
    }
    this.ledger.tombstone(memoryId, reason)

    // Exact plugin-recorded triples only. A broad relationship query could
    // delete user-owned statements this plugin never created.
    let relationsCleaned = 0
    let relationsUncertain = 0
    for (const relation of this.ledger.relationsFor(memoryId)) {
      try {
        await this.adapter.statementDelete({
          subject: relation.subject,
          predicate: relation.predicate,
          object: relation.object,
          shelf: record.shelf,
          signal,
        })
        this.ledger.setRelationState(relation.subject, relation.predicate, relation.object, 'deleted')
        relationsCleaned += 1
      } catch (error) {
        if (error?.detail?.failure === CliFailure.NOT_FOUND) {
          this.ledger.setRelationState(relation.subject, relation.predicate, relation.object, 'deleted')
          relationsCleaned += 1
          continue
        }
        this.ledger.setRelationState(relation.subject, relation.predicate, relation.object, 'uncertain')
        relationsUncertain += 1
      }
    }

    try {
      await this.adapter.knowledgeDelete(record.hypatia_name, { shelf: record.shelf, signal })
    } catch (error) {
      if (error?.detail?.failure !== CliFailure.NOT_FOUND) {
        this.ledger.setCleanupState(memoryId, CleanupState.UNCERTAIN)
        return {
          memoryId,
          cleanupState: CleanupState.UNCERTAIN,
          relations: relationsCleaned,
          error: asHypatiaError(error).toJSON(),
        }
      }
      // Already absent counts as cleaned; verification below confirms it.
    }

    try {
      const stillThere = await this.adapter.knowledgeGet(record.hypatia_name, { shelf: record.shelf, signal })
      if (stillThere) {
        this.ledger.setCleanupState(memoryId, CleanupState.UNCERTAIN)
        return { memoryId, cleanupState: CleanupState.UNCERTAIN, relations: relationsCleaned }
      }
    } catch (error) {
      this.ledger.setCleanupState(memoryId, CleanupState.UNCERTAIN)
      return {
        memoryId,
        cleanupState: CleanupState.UNCERTAIN,
        relations: relationsCleaned,
        error: asHypatiaError(error).toJSON(),
      }
    }

    // A triple this plugin created and could not delete is still plugin data
    // sitting in the shelf, so cleanup is not complete and must not be reported
    // as such. Leaving the tombstone `uncertain` also keeps it in
    // `pendingCleanups()`, which is the only thing that will try again - and
    // the payload stays put, because a later attempt needs the record intact.
    if (relationsUncertain > 0) {
      this.ledger.setCleanupState(memoryId, CleanupState.UNCERTAIN)
      this.warn(`forget left ${relationsUncertain} relation(s) unverified for ${record.hypatia_name}`)
      return {
        memoryId,
        cleanupState: CleanupState.UNCERTAIN,
        relations: relationsCleaned,
        relationsUncertain,
      }
    }

    this.ledger.setCleanupState(memoryId, CleanupState.COMPLETE)
    this.ledger.purgePayload(memoryId)
    return { memoryId, cleanupState: CleanupState.COMPLETE, relations: relationsCleaned }
  }

  /**
   * Settle operations left pending, dispatched, or uncertain by a crash,
   * timeout, or plugin reload - by stable key, never by blind retry.
   *
   * One pass settles at most `limit` operations and `limit` cleanups, because
   * each one costs a subprocess. A pass that fills either batch says so:
   * `truncated` means "this batch hit its cap, run again", which is distinct
   * from `remaining`, since an operation whose record is gone or tombstoned is
   * counted as outstanding forever and can never be settled. Reporting only
   * `remaining` would send a caller into an unwinnable loop.
   *
   * @returns {Promise<{checked: number, applied: number, conflicts: number,
   *   unresolved: number, cleanups: number, remaining: number, truncated: boolean}>}
   */
  async reconcile({ signal, limit = this.batchSize } = {}) {
    const summary = {
      checked: 0, applied: 0, conflicts: 0, unresolved: 0, cleanups: 0, remaining: 0, truncated: false,
    }

    const due = new Set(this.ledger.dueRetries(limit).map((row) => row.operation_id))

    const operations = this.ledger.pendingOperations(limit)
    for (const operation of operations) {
      summary.checked += 1
      const record = this.ledger.getRecord(operation.memory_id)
      if (!record) { summary.unresolved += 1; continue }

      // A forgotten memory must not be recreated by settling an older write.
      if (record.state === RecordState.TOMBSTONED) { summary.unresolved += 1; continue }

      try {
        const stored = await this.adapter.knowledgeGet(record.hypatia_name, { shelf: record.shelf, signal })
        if (!stored) {
          // Genuinely absent: the write never landed. Re-dispatch from the
          // ledger's canonical payload if this attempt is due, so the retry
          // queue is actually drained rather than merely recorded.
          const retry = this.ledger.getRetry(operation.operation_id)
          if (due.has(operation.operation_id)) {
            // Terminate rather than retry forever: a key that stays absent
            // across the whole backoff schedule is not going to appear.
            if (retry && retry.attempts > RETRY_DELAYS.length) {
              this.ledger.deadLetter(operation.operation_id, operation.memory_id, {
                code: ErrorCode.UNCERTAIN,
                message: 'reconciliation exhausted its retries with the stable key still absent',
              })
              summary.unresolved += 1
              continue
            }
            const redispatched = await this.#redispatch(operation, record, signal)
            if (redispatched === 'applied') summary.applied += 1
            else summary.unresolved += 1
            continue
          }
          // Not due, and not necessarily *ever* due: only `#recordFailure`
          // enqueues retries, and only for retryable codes - so an operation
          // that died before dispatch, or failed with a non-retryable but
          // dispatched code such as CANCELLED, would otherwise sit here being
          // re-checked by every reconcile run forever, burning a knowledge-get
          // subprocess each time. Give it a backoff slot so a later pass can
          // finish it.
          if (!retry) {
            const delayMs = RETRY_DELAYS[Math.min(Math.max(operation.attempts, 1) - 1, RETRY_DELAYS.length - 1)]
            this.ledger.scheduleRetry(operation.operation_id, { delayMs })
          }
          summary.unresolved += 1
          continue
        }
        const observed = payloadHash(parseStoredPayload(stored))
        if (observed === record.payload_hash) {
          this.ledger.commitReceipt(operation.operation_id, {
            hypatiaName: record.hypatia_name,
            payloadHash: record.payload_hash,
            verifiedAt: Date.now(),
            reconciled: true,
          })
          summary.applied += 1
        } else {
          this.ledger.markOperationFailure(operation.operation_id, OperationState.CONFLICT, {
            code: ErrorCode.CONFLICT,
            message: 'reconciliation found a different payload under the stable key',
          })
          summary.conflicts += 1
        }
      } catch (error) {
        this.warn(`reconcile could not settle ${operation.operation_id}: ${error.message}`)
        summary.unresolved += 1
      }
    }

    // Finish deletions whose CLI step never completed.
    const cleanups = this.ledger.pendingCleanups(limit)
    for (const tombstone of cleanups) {
      const record = this.ledger.getRecord(tombstone.memory_id)
      if (!record || record.state !== RecordState.TOMBSTONED) continue
      try {
        await this.forget({ memoryId: tombstone.memory_id, reason: 'reconcile', signal })
        summary.cleanups += 1
      } catch (error) {
        this.warn(`reconcile could not clean up ${tombstone.memory_id}: ${error.message}`)
      }
    }

    // Counted after the pass, against the same unjoined sets the batches page
    // over, so `remaining` is what a further pass would actually see.
    summary.remaining = this.ledger.countPendingOperations() + this.ledger.countPendingCleanups()
    summary.truncated = operations.length >= limit || cleanups.length >= limit
    return summary
  }

  /**
   * Re-run a create whose write is confirmed absent, using the payload the
   * ledger already holds. Only reached from reconciliation, and only for an
   * operation whose backoff has elapsed - which is what actually drains the
   * retry queue instead of merely recording it.
   *
   * @returns {Promise<'applied'|'unresolved'>}
   */
  async #redispatch(operation, record, signal) {
    if (!record.payload_json) return 'unresolved'
    let payload
    try {
      payload = JSON.parse(record.payload_json)
    } catch {
      return 'unresolved'
    }
    const result = await this.#dispatchCreate({
      operationId: operation.operation_id,
      memoryId: record.memory_id,
      hypatiaName: record.hypatia_name,
      scope: record.scope,
      kind: record.kind,
      payload,
      hash: record.payload_hash,
      // Relations carry their own per-triple state and are retried there.
      relations: [],
      signal,
    })
    return result.status === 'applied' ? 'applied' : 'unresolved'
  }
}

/**
 * Recover the canonical payload from a Hypatia knowledge row.
 * Plugin rows always store canonical JSON in `content.data`; a row that does
 * not parse is treated as foreign content, which fails the hash comparison
 * and surfaces as a conflict rather than a silent overwrite.
 */
function parseStoredPayload(row) {
  const normalized = normalizeKnowledge(row)
  return normalized.parsed ?? { __raw: normalized.data }
}
