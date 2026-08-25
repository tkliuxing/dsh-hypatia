/**
 * Configuration normalization. Every tunable has a defined default here, so
 * no other module has to guess or re-validate operator input.
 *
 * @module dsh-hypatia/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Clamp a configured number into a supported range, falling back on garbage.
 *
 * Only an actual number or a numeric string counts as a value. `null`, `''`,
 * `false`, and `[]` all coerce to a finite 0 under `Number()`, which would
 * clamp them to `min` - so a YAML key left blank would silently become the
 * smallest legal setting rather than the documented default.
 *
 * The result is truncated to an integer: every tunable here is a count, a byte
 * budget, or a millisecond deadline, and a fractional `maxConcurrentReads`
 * would let the adapter's semaphore admit two Hypatia processes at once.
 */
function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize the cordis `config:` row into the shape the plugin uses.
 *
 * @param {object} raw
 * @returns {object} frozen, fully-populated configuration
 */
export function normalizeConfig(raw = {}) {
  const state = raw.state ?? {}
  const recall = raw.recall ?? {}
  const adapter = raw.adapter ?? {}
  const legacy = raw.legacyBridge ?? {}
  const ingest = raw.ingest ?? {}
  const extraction = raw.extraction ?? {}
  const memory = raw.memory ?? {}

  const stateDir = state.dir
    ? resolve(state.dir)
    : join(homedir(), '.dsh', 'dsh-hypatia')

  return Object.freeze({
    /** Memory authorization, independent of the DSH file sandbox. */
    memory: Object.freeze({
      preset: typeof memory.preset === 'string' ? memory.preset : 'standard',
      capabilities: Array.isArray(memory.capabilities) ? [...memory.capabilities] : [],
    }),

    /** Pin a stable project ID to share one scope across worktrees. */
    projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,

    /** Plugin-owned control ledger. Never Hypatia's own storage. */
    state: Object.freeze({
      dir: stateDir,
      file: join(stateDir, 'state.sqlite'),
    }),

    /** Hypatia CLI adapter limits. */
    adapter: Object.freeze({
      /** Explicit binary path; otherwise resolved from PATH at startup. */
      binaryPath: typeof adapter.binaryPath === 'string' && isAbsolute(adapter.binaryPath)
        ? adapter.binaryPath
        : null,
      shelf: typeof adapter.shelf === 'string' && adapter.shelf ? adapter.shelf : 'default',
      timeoutMs: num(adapter.timeoutMs, 10_000, { min: 250, max: 120_000 }),
      maxOutputBytes: num(adapter.maxOutputBytes, 4 * 1024 * 1024, { min: 64 * 1024 }),
      /**
       * Concurrent `hypatia` processes, reads included. Must stay at 1 under
       * hypatia 0.1.4: every invocation opens all registered shelves and
       * DuckDB locks the file exclusively, so concurrent calls fail with
       * "Conflicting lock is held". Raise only if nothing else can touch the
       * same shelves.
       */
      maxConcurrentReads: num(adapter.maxConcurrentReads, 1, { min: 1, max: 32 }),
      /** Minimum Hypatia version whose CLI contract this adapter was written against. */
      minVersion: typeof adapter.minVersion === 'string' ? adapter.minVersion : '0.1.4',
      /** Refuse to run against an unverified version rather than guessing. */
      requireVersionCheck: bool(adapter.requireVersionCheck, true),
    }),

    /** Same-request recall budget. Recall always fails open. */
    recall: Object.freeze({
      enabled: bool(recall.enabled, true),
      deadlineMs: num(recall.deadlineMs, 200, { min: 25, max: 5_000 }),
      maxResults: num(recall.maxResults, 5, { min: 1, max: 25 }),
      maxBytes: num(recall.maxBytes, 10 * 1024, { min: 512, max: 64 * 1024 }),
      /** Best-effort Hypatia FTS supplement inside the remaining deadline. */
      hypatiaSupplement: bool(recall.hypatiaSupplement, true),
      /** Vector recall cannot pre-filter by scope; off until benchmarked. */
      vectorSupplement: bool(recall.vectorSupplement, false),
    }),

    /** Idempotent ingestion of DSH compaction summaries. */
    ingest: Object.freeze({
      compaction: bool(ingest.compaction, true),
    }),

    /**
     * Phase 3 background model-assisted extraction.
     * GOAL.md marks it NO-GO until Phases 0-2 pass fault and security tests,
     * so it stays off even if an operator sets the flag.
     */
    extraction: Object.freeze({
      enabled: false,
      requested: bool(extraction.enabled, false),
    }),

    /**
     * The pre-refactor TRIGGER/Bash bridge. Off by default; kept only as an
     * explicit legacy escape hatch during migration. No new features.
     */
    legacyBridge: Object.freeze({
      enabled: bool(legacy.enabled, false),
      extractInterval: num(legacy.extractInterval, 5, { min: 1, max: 1_000 }),
    }),

    /** Register the packaged skills in the session skill catalog. */
    registerSkills: bool(raw.registerSkills, true),
    /** Register the narrow `memory_*` model-facing tools. */
    registerTools: bool(raw.registerTools, true),
  })
}
