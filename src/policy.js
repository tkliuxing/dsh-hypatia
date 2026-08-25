/**
 * Memory authorization, independent of the DSH file sandbox.
 *
 * `read-only`, `workspace-write`, and `danger-full-access` are Agent
 * file-effect policies. They are not memory consent, and this module never
 * reads them. Memory capabilities come only from operator configuration
 * resolved once at plugin load; the resulting object is frozen, so no
 * recalled text, tool result, or model proposal can widen it later.
 *
 * @module dsh-hypatia/policy
 */

import { ErrorCode, HypatiaError } from './errors.js'

/** @enum {string} Capabilities a deployment may grant. */
export const Capability = {
  /** Read plugin-owned records for same-request recall. */
  READ_RECALL: 'read-only-recall',
  /** Create or update plugin-owned semantic memories. */
  SEMANTIC_WRITE: 'semantic-write',
  /** Mirror raw transcript chunks. Off unless every prerequisite is met. */
  TRANSCRIPT_MIRROR: 'transcript-mirror',
  /** Tombstone and clean up plugin-owned records. */
  DELETE: 'delete',
  /** Write rules/taboos at global scope. Never granted to automatic extraction. */
  GLOBAL_RULE_WRITE: 'global-rule-write',
  /** Shelf connect/export/archive and explicit reconcile runs. */
  ADMINISTER: 'administer',
}

/** Named bundles an operator can select with a single config value. */
const PRESETS = {
  disabled: [],
  'read-only-recall': [Capability.READ_RECALL],
  standard: [Capability.READ_RECALL, Capability.SEMANTIC_WRITE, Capability.DELETE],
  full: [
    Capability.READ_RECALL,
    Capability.SEMANTIC_WRITE,
    Capability.DELETE,
    Capability.GLOBAL_RULE_WRITE,
    Capability.ADMINISTER,
  ],
}

const KNOWN = new Set(Object.values(Capability))

/**
 * Capabilities that automatic, model-assisted paths may never exercise no
 * matter what the operator granted. A background extractor that decides a
 * memory is globally applicable still cannot write it globally, and it can
 * never mirror a raw transcript.
 */
const NEVER_AUTOMATIC = new Set([Capability.GLOBAL_RULE_WRITE, Capability.TRANSCRIPT_MIRROR])

/**
 * Build the frozen policy for this deployment.
 *
 * @param {{preset?: string, capabilities?: string[], warn?: (msg: string) => void}} config
 * @returns {Readonly<{
 *   capabilities: ReadonlySet<string>,
 *   can(cap: string, options?: {automatic?: boolean}): boolean,
 *   require(cap: string, options?: {automatic?: boolean, detail?: object}): void,
 *   enabled: boolean,
 *   describe(): string[],
 * }>}
 */
export function createMemoryPolicy({ preset = 'standard', capabilities, warn } = {}) {
  // `Object.hasOwn`, not a bare lookup: `PRESETS['constructor']` resolves to an
  // inherited function, which is truthy, so the fall-back branch below would be
  // skipped and `new Set(base)` would throw out of `apply()` instead of
  // degrading to "disabled".
  const base = Object.hasOwn(PRESETS, preset) ? PRESETS[preset] : undefined
  if (!base) {
    warn?.(`unknown memory policy preset "${preset}" - falling back to "disabled"`)
  }
  const granted = new Set(base ?? [])
  for (const cap of capabilities ?? []) {
    if (!KNOWN.has(cap)) {
      warn?.(`unknown memory capability "${cap}" ignored`)
      continue
    }
    granted.add(cap)
  }
  // A transcript mirror needs consent, retention, and cleanup prerequisites
  // that this repository does not implement yet; refuse to pretend otherwise.
  if (granted.has(Capability.TRANSCRIPT_MIRROR)) {
    granted.delete(Capability.TRANSCRIPT_MIRROR)
    warn?.('transcript-mirror is not implemented and stays disabled; '
      + 'see GOAL.md "Full-transcript vector mirror" for its prerequisites')
  }

  const policy = {
    /**
     * A frozen snapshot, never the live set. `Object.freeze` below is shallow,
     * so exposing `granted` itself would leave the capability set mutable:
     * `policy.capabilities.add('transcript-mirror')` would sail past both the
     * preset gate and the refusal above, because `can()` reads the same set.
     */
    capabilities: Object.freeze([...granted]),
    enabled: granted.size > 0,

    can(cap, { automatic = false } = {}) {
      if (!granted.has(cap)) return false
      if (automatic && NEVER_AUTOMATIC.has(cap)) return false
      return true
    },

    require(cap, { automatic = false, detail } = {}) {
      if (policy.can(cap, { automatic })) return
      const why = granted.has(cap) && automatic
        ? `capability "${cap}" is never available to automatic extraction`
        : `capability "${cap}" is not granted by the configured memory policy`
      throw new HypatiaError(ErrorCode.UNAUTHORIZED, why, { detail: { capability: cap, automatic, ...detail } })
    },

    describe() {
      return [...granted].sort()
    },
  }
  return Object.freeze(policy)
}
