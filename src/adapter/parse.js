/**
 * Normalization of Hypatia CLI output into structured results.
 *
 * The CLI's success signalling is genuinely mixed, and exit status is
 * unreliable in *both* directions. Observed against hypatia 0.1.4:
 *
 * | invocation                | exit | stdout                                    |
 * |---------------------------|------|-------------------------------------------|
 * | `knowledge-get` (missing) | 0    | `Knowledge 'x' not found.`                |
 * | `query` (no matches)      | 0    | `No results found.`                       |
 * | `similar` (no model)      | 0    | `Error: model unavailable: ...`           |
 * | `knowledge-create` (dup)  | 1    | `Error: ... Duplicate key ...`            |
 * | `knowledge-delete` (miss) | 1    | `Error: not found: knowledge 'x'`         |
 * | `knowledge-create` (ok)   | 0    | `Created knowledge: <name>`               |
 *
 * So every result is classified from the text, and the exit code is only
 * corroborating evidence. Callers branch on `kind`, never on a substring.
 *
 * @module dsh-hypatia/adapter/parse
 */

import { ErrorCode, HypatiaError } from '../errors.js'

/** @enum {string} Classified shape of one CLI invocation's output. */
export const ResultKind = {
  /** Parsed JSON payload (object or array). */
  DATA: 'data',
  /** The query ran and matched nothing. Not a failure. */
  EMPTY: 'empty',
  /** A human-readable success acknowledgement, e.g. `Created knowledge: x`. */
  ACK: 'ack',
  /** The CLI reported a failure. */
  ERROR: 'error',
}

/** @enum {string} Sub-classification of a CLI error, for retry decisions. */
export const CliFailure = {
  /** Stable key already exists. For a create, this may mean "already applied". */
  DUPLICATE: 'duplicate',
  /** Target does not exist. For a delete, this may mean "already gone". */
  NOT_FOUND: 'not-found',
  /** No embedding provider; vector search is unavailable on this shelf. */
  MODEL_UNAVAILABLE: 'model-unavailable',
  /** Shelf name is not registered or not connected. */
  SHELF: 'shelf',
  /**
   * Another Hypatia process holds the DuckDB file lock. Retryable, and the
   * reason the adapter serializes every invocation - see
   * {@link module:dsh-hypatia/adapter/cli} for the measurement behind that.
   */
  LOCKED: 'locked',
  /** Anything else. */
  OTHER: 'other',
}

const EMPTY_PATTERNS = [
  /^No results found\.?$/i,
  /^Knowledge '.*' not found\.?$/i,
  /^Statement '.*' not found\.?$/i,
  /^No .* found\.?$/i,
]

/** Classify an `Error: ...` line into a {@link CliFailure}. */
export function classifyFailure(text) {
  // Checked before the others: a lock conflict can surface alongside other
  // storage wording, and it is the one failure that is purely transient.
  if (/conflicting lock|could not set lock/i.test(text)) return CliFailure.LOCKED
  if (/duplicate key/i.test(text)) return CliFailure.DUPLICATE
  if (/not found/i.test(text)) return CliFailure.NOT_FOUND
  if (/model unavailable|no embedding provider/i.test(text)) return CliFailure.MODEL_UNAVAILABLE
  if (/shelf error|is not connected/i.test(text)) return CliFailure.SHELF
  return CliFailure.OTHER
}

/**
 * Turn raw process output into a structured result.
 *
 * @param {{stdout: string, stderr: string, code: number|null}} output
 * @returns {{kind: string, data?: unknown, text: string, failure?: string}}
 */
export function parseOutput({ stdout, stderr, code }) {
  const text = (stdout ?? '').trim()
  const errText = (stderr ?? '').trim()

  // `Error:` on either stream wins over a zero exit code.
  const errorLine = [text, errText].find((candidate) => /^Error:/i.test(candidate))
  if (errorLine) {
    return { kind: ResultKind.ERROR, text: errorLine, failure: classifyFailure(errorLine) }
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { kind: ResultKind.DATA, data: JSON.parse(text), text }
    } catch (cause) {
      throw new HypatiaError(ErrorCode.PARSE, 'CLI emitted malformed JSON', {
        cause, detail: { preview: text.slice(0, 200) },
      })
    }
  }

  // Non-zero exit with no `Error:` prefix is still a failure, and this has to
  // be decided *before* the empty patterns: `/^No .* found\.?$/i` is broad
  // enough to swallow a real failure such as `No shelf 'default' found.`, and
  // reporting that as "the query matched nothing" would make recall return
  // zero entries with no `degraded` note and make a failed delete look clean.
  if (code !== 0) {
    return {
      kind: ResultKind.ERROR,
      text: text || errText || `exited with code ${code}`,
      failure: classifyFailure(`${text} ${errText}`),
    }
  }

  if (EMPTY_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: ResultKind.EMPTY, text }
  }

  if (text.length === 0) return { kind: ResultKind.EMPTY, text }
  return { kind: ResultKind.ACK, text }
}

/**
 * Normalize one `knowledge-get` / `query` knowledge row.
 *
 * `content.data` is stored as an opaque string by Hypatia. Plugin-owned rows
 * hold canonical JSON there, so it is decoded when possible and otherwise
 * surfaced verbatim as untrusted text.
 *
 * @returns {{name: string, tags: string[], scopes: string[], createdAt: string|null,
 *   data: string, parsed: unknown|null}}
 */
export function normalizeKnowledge(row) {
  const content = row?.content ?? {}
  const data = typeof content.data === 'string' ? content.data : ''
  let parsed = null
  if (data.startsWith('{') || data.startsWith('[')) {
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = null
    }
  }
  return {
    name: row?.name ?? '',
    tags: Array.isArray(content.tags) ? content.tags : [],
    scopes: Array.isArray(content.scopes) ? content.scopes : [],
    createdAt: row?.created_at ?? null,
    data,
    parsed,
  }
}

/** Normalize one `query` statement row into an exact triple. */
export function normalizeStatement(row) {
  return {
    subject: row?.subject ?? '',
    predicate: row?.predicate ?? '',
    object: row?.object ?? '',
    scopes: Array.isArray(row?.content?.scopes) ? row.content.scopes : [],
    createdAt: row?.created_at ?? null,
  }
}

/** Normalize one `search` hit. `key` is the knowledge name or triple. */
export function normalizeSearchHit(row) {
  return {
    key: row?.key ?? '',
    catalog: row?.catalog ?? 'knowledge',
    rank: typeof row?.rank === 'number' ? row.rank : 0,
    content: typeof row?.content === 'string' ? row.content : '',
  }
}
