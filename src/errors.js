/**
 * Structured error and receipt types shared by the adapter, ledger, and tools.
 *
 * Every failure that crosses a module boundary is one of these, so callers can
 * branch on `code` instead of matching human CLI text. The Hypatia CLI reports
 * failure inconsistently — `knowledge-get` and `query` print human "not found"
 * text with exit 0, `similar` prints `Error:` with exit 0, and writes fail with
 * exit 1 — so exit status alone is never the signal.
 *
 * @module dsh-hypatia/errors
 */

/** @enum {string} Stable machine codes; never localize or reword these. */
export const ErrorCode = {
  /** Binary missing, unresolvable, or an unsupported version. */
  BINARY: 'binary',
  /** Process exceeded its deadline and was terminated. */
  TIMEOUT: 'timeout',
  /** Caller AbortSignal fired. */
  CANCELLED: 'cancelled',
  /** stdout or stderr exceeded the configured byte cap. */
  OUTPUT_OVERFLOW: 'output-overflow',
  /** Process exited non-zero, or printed `Error:` with exit 0. */
  CLI_ERROR: 'cli-error',
  /** Output was neither parseable JSON nor a recognized human form. */
  PARSE: 'parse',
  /** The stable key exists in Hypatia holding a different payload. */
  CONFLICT: 'conflict',
  /** Dispatched, but the result is unknown (crash/timeout after spawn). */
  UNCERTAIN: 'uncertain',
  /** The memory policy denies the requested capability. */
  UNAUTHORIZED: 'unauthorized',
  /** Host-side validation rejected a payload, scope, or proposal. */
  VALIDATION: 'validation',
  /** Required host service (session-query, persistence) is unavailable. */
  UNAVAILABLE: 'unavailable',
}

/**
 * A failure with a stable `code`. `retryable` tells the retry queue whether a
 * later attempt could plausibly succeed; `dispatched` tells reconciliation
 * whether Hypatia may already hold the write.
 */
export class HypatiaError extends Error {
  /**
   * @param {string} code one of {@link ErrorCode}
   * @param {string} message human detail for logs and `memory_status`
   * @param {{cause?: unknown, retryable?: boolean, dispatched?: boolean, detail?: object}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'HypatiaError'
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    this.dispatched = options.dispatched ?? false
    this.detail = options.detail ?? {}
  }

  /** Content-free shape safe to persist in the ledger and show in status. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      dispatched: this.dispatched,
      detail: this.detail,
    }
  }
}

/**
 * Codes worth another attempt. Conflicts and validation failures are not:
 * they need a decision, not a retry.
 */
const RETRYABLE_CODES = new Set([
  ErrorCode.TIMEOUT,
  ErrorCode.OUTPUT_OVERFLOW,
  ErrorCode.CLI_ERROR,
  ErrorCode.UNCERTAIN,
])

/** @returns {value is HypatiaError} */
export function isHypatiaError(value) {
  return value instanceof HypatiaError
}

/** Narrow a caught value to a HypatiaError, wrapping anything unexpected. */
export function asHypatiaError(value, fallbackCode = ErrorCode.CLI_ERROR) {
  if (isHypatiaError(value)) return value
  return new HypatiaError(fallbackCode, String(value?.message ?? value), { cause: value })
}
