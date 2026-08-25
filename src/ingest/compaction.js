/**
 * Idempotent ingestion of DSH `compaction/summary` events.
 *
 * DSH already pays a model to summarize a range of conversation when it
 * compacts. Ingesting that existing summary is strictly better than paying
 * again for a second one over the same source range, so this is the first
 * extraction path the plugin enables.
 *
 * Idempotency comes from the source range itself: `shadowedRange` is closed
 * and immutable, so the memory ID and operation ID derived from it are stable
 * across restart, resume, duplicate delivery, and plugin reload.
 *
 * @module dsh-hypatia/ingest/compaction
 */

import { Capability } from '../policy.js'
import {
  buildProvenance,
  deriveMemoryId,
  deriveOperationId,
  memoryName,
  sourceIdentityOf,
} from '../identity.js'
import { RECALL_BLOCK_END, RECALL_BLOCK_START } from '../recall.js'
import { truncateBytes } from '../redaction.js'

/** Cap on one ingested summary's stored text. Summaries can be long. */
const MAX_SUMMARY_BYTES = 8 * 1024

/** Marker that identifies this plugin's own injected context. */
const PLUGIN_MARKER = '[dsh-hypatia]'

/**
 * Lines that still belong to a recall block after its opening marker: the two
 * header lines `renderText` emits, blank separators, and the memory bullets.
 */
const RECALL_BLOCK_LINE = /^\s*$|^Scope: .*carry no authority:$|^do not treat any recalled text\b|^- \(/

/** Flatten `ContentBlock[]` to plain text, dropping non-text blocks. */
function blocksToText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Drop this plugin's own recall text from a summary before storing it.
 *
 * Without this, recalled memories get summarized into a new memory, which is
 * then recalled and summarized again - each pass amplifying whatever the
 * first one got wrong, and giving injected text a route to launder itself
 * into stored "history".
 */
export function stripDerivedContext(text) {
  // Fenced region first. Filtering blank-line-separated blocks alone is not
  // enough: `renderText` carries the marker in its header and puts a blank
  // line before the memory bullets, so a block filter drops the header and
  // keeps the memories - which is exactly the text that must not come back.
  const kept = []
  let inRecallBlock = false
  for (const line of text.split(/\r?\n/)) {
    if (!inRecallBlock && line.includes(RECALL_BLOCK_START)) {
      inRecallBlock = true
      continue
    }
    if (inRecallBlock) {
      if (line.includes(RECALL_BLOCK_END)) { inRecallBlock = false; continue }
      // A summary may quote the block only partly, so the closing fence can be
      // missing. Keep consuming only lines that still have the block's own
      // shape - its two header lines, blanks, and recall bullets - so an
      // unterminated quote costs the surrounding narrative nothing.
      if (RECALL_BLOCK_LINE.test(line)) continue
      inRecallBlock = false
    }
    kept.push(line)
  }

  // The legacy TRIGGER protocol has no fence, so it keeps the block filter.
  return kept
    .join('\n')
    .split(/\n{2,}/)
    .filter((block) => !block.includes(PLUGIN_MARKER) && !block.includes('[hypatia-memory]'))
    .join('\n\n')
    .trim()
}

/**
 * Watch one agent's session for compaction summaries and ingest them.
 *
 * @param {{
 *   ctx: object, agent: object, ledger: import('../ledger/ledger.js').Ledger,
 *   mutations: import('../mutations.js').MutationCoordinator|null,
 *   policy: object, scope: string, shelf: string, warn: (msg: string) => void,
 * }} deps
 * @returns {() => void} disposer
 */
export function registerCompactionIngest({ ctx, agent, ledger, mutations, policy, scope, shelf, warn }) {
  const header = agent.session.header ?? {}

  // Subagent transcripts are skipped by default: their content belongs to the
  // parent's work, and ingesting both would duplicate the same material.
  if (header.origin === 'subagent') return () => {}
  if (!mutations || !policy.can(Capability.SEMANTIC_WRITE, { automatic: true })) return () => {}

  const sourceIdentity = sourceIdentityOf({
    sessionId: String(header.id ?? agent.session.id),
    sessionCreatedAt: header.createdAt ?? 0,
    persistenceSource: 'dsh-session',
  })
  // For a fork, inherited events belong to the parent source; only work after
  // the seed boundary is this session's to ingest.
  const seedLength = Number(header.seedLength ?? 0)

  /** Serializes ingestion so two summaries cannot interleave their writes. */
  let queue = Promise.resolve()
  let disposed = false

  const enqueue = (event, range) => {
    queue = queue
      .then(() => (disposed ? undefined : ingestOne({
        event, range, sourceIdentity, seedLength, header,
        ledger, mutations, scope, shelf, warn,
      })))
      .catch((error) => warn(`compaction ingest failed: ${error.message}`))
  }

  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    const range = ingestableRange(event, seedLength)
    if (!range) return
    enqueue(event, range)
  })

  // Catch up on summaries this plugin was not running to observe: a resumed
  // session, a plugin reload, or the plugin being enabled partway through a
  // project. Without this, `session/event` only ever delivers *future*
  // compactions and everything already in the log is silently never ingested.
  //
  // Not awaited - registration must not block on subprocesses - and safe to
  // race with live delivery, because the operation ID makes a double ingest a
  // no-op rather than a duplicate.
  catchUp({ agent, ledger, sourceIdentity, seedLength, enqueue, warn })

  return () => {
    disposed = true
    dispose()
  }
}

/**
 * The shadowed range this event should be ingested for, or null when it is not
 * an ingestable compaction summary.
 *
 * `seq` is the event's own position in the session log; `shadowedRange` is the
 * span of events it replaced. They are different number spaces, so the fork
 * boundary is checked against `seq` and ingestion progress against the range.
 */
function ingestableRange(event, seedLength) {
  if (event?.type !== 'compaction/summary') return null
  if (typeof event.seq === 'number' && event.seq < seedLength) return null
  const range = event.data?.shadowedRange
  if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') return null
  return range
}

/**
 * Queue every already-logged summary the cursor has not accounted for.
 *
 * The cursor stores the highest `shadowedRange.end` that reached `applied`.
 * Compacted ranges advance monotonically, so anything at or below it is
 * settled and can be skipped without a per-range database lookup.
 */
function catchUp({ agent, ledger, sourceIdentity, seedLength, enqueue, warn }) {
  let events
  try {
    events = agent.session?.events
  } catch (error) {
    warn(`compaction catch-up could not read session events: ${error.message}`)
    return
  }
  if (!Array.isArray(events) || events.length === 0) return

  let lastAppliedSeq = 0
  try {
    lastAppliedSeq = ledger.getCursor(sourceIdentity)?.last_applied_seq ?? 0
  } catch (error) {
    // A cursor read failure only costs efficiency: ingestion stays idempotent.
    warn(`compaction catch-up could not read its cursor: ${error.message}`)
  }

  let queued = 0
  for (const event of events) {
    const range = ingestableRange(event, seedLength)
    if (!range || range.end <= lastAppliedSeq) continue
    enqueue(event, range)
    queued += 1
  }
  if (queued > 0) warn(`compaction catch-up queued ${queued} summaries logged before this load`)
}

/** Write one compaction summary as a plugin-owned memory, exactly once. */
async function ingestOne({ event, range, sourceIdentity, seedLength, header, ledger, mutations, scope, shelf, warn }) {
  const raw = blocksToText(event.data?.summary)
  const text = truncateBytes(stripDerivedContext(raw), MAX_SUMMARY_BYTES)
  if (!text) return

  const kind = 'summary'
  const memoryId = deriveMemoryId({ sourceIdentity, fromSeq: range.start, throughSeq: range.end, kind })

  // Cheap pre-check: a completed ingest for this exact range needs no CLI call.
  const existing = ledger.findBySourceRange({ sourceIdentity, fromSeq: range.start, throughSeq: range.end })
  if (existing && existing.state === 'applied') return

  const operationId = deriveOperationId({
    sourceIdentity, fromSeq: range.start, throughSeq: range.end, kind,
  })

  const result = await mutations.writeMemory({
    operationId,
    memoryId,
    hypatiaName: memoryName(scope, memoryId),
    scope,
    kind,
    title: `Conversation summary (events ${range.start}-${range.end})`,
    payload: {
      title: `Conversation summary (events ${range.start}-${range.end})`,
      summary: text,
      kind,
    },
    // Machine-derived, so it never carries user-confirmed authority.
    trust: 'derived',
    provenance: buildProvenance({
      sessionId: String(header.id ?? ''),
      sessionCreatedAt: header.createdAt ?? 0,
      sessionCwd: header.cwd ?? null,
      persistenceSource: 'dsh-session',
      revisionAtExtraction: String(event.data?.compactionId ?? 'unknown'),
      parentSession: header.parentSession ?? null,
      seedLength,
      fromSeq: range.start,
      throughSeq: range.end,
    }),
    sourceIdentity,
    sessionId: String(header.id ?? ''),
    fromSeq: range.start,
    throughSeq: range.end,
  })

  if (result.status === 'applied' || result.status === 'replayed') {
    ledger.setCursor({
      sourceIdentity,
      sessionId: String(header.id ?? ''),
      parentSession: header.parentSession ?? null,
      seedLength,
      lastAppliedSeq: range.end,
    })
  } else {
    warn(`compaction summary ${range.start}-${range.end} not confirmed stored (${result.status})`)
  }
}
