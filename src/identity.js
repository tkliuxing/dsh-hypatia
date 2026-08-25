/**
 * Host-owned identity: project scope, stable Hypatia names, operation IDs,
 * and the provenance record attached to every source-derived memory.
 *
 * Everything here is derived in host code from immutable inputs. The model
 * never proposes a scope, a name, or an operation ID — that is what makes
 * scope isolation and idempotent replay enforceable.
 *
 * @module dsh-hypatia/identity
 */

import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'

/** Namespace prefixes. Bump the version segment only with a migration. */
export const MEMORY_NAME_PREFIX = 'dshmem:v1'
export const SESSION_NAME_PREFIX = 'dshsession:v1'

/** Tag applied to every plugin-owned knowledge entry, for coarse CLI filtering. */
export const PLUGIN_TAG = 'dshmem'

/** Bumped when the extraction prompt or post-processing changes. */
export const EXTRACTOR_VERSION = '0.2.0'
/** Bumped when the model proposal contract changes shape. */
export const PROPOSAL_SCHEMA_VERSION = 1
/** Bumped when host validation rules tighten. */
export const VALIDATOR_POLICY_VERSION = 1

/** Short stable hex digest over the given parts. */
function digest(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part))
    hash.update(' ')
  }
  return hash.digest('hex')
}

/** Comma-free, lowercase, CLI-safe label fragment. */
function sanitizeLabel(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned || 'project'
}

/**
 * Derive the stable project identity for a session.
 *
 * `basename(cwd)` alone is not acceptable: two unrelated checkouts named
 * `api` would share memory. The scope keeps a readable label for humans and
 * appends a digest of the canonical absolute root for uniqueness. An operator
 * may pin `configuredProjectId` to make sibling worktrees share one scope.
 *
 * @param {{cwd?: string|null, configuredProjectId?: string|null}} input
 * @returns {{projectId: string, scope: string, label: string, root: string|null}}
 */
export function deriveProjectIdentity({ cwd, configuredProjectId } = {}) {
  if (configuredProjectId) {
    const label = sanitizeLabel(configuredProjectId)
    return { projectId: label, scope: label, label, root: cwd ? resolve(cwd) : null }
  }
  if (!cwd) {
    return { projectId: 'unscoped', scope: 'unscoped', label: 'unscoped', root: null }
  }
  const root = resolve(cwd)
  const label = sanitizeLabel(basename(root))
  const projectId = `${label}-${digest('project', root).slice(0, 12)}`
  return { projectId, scope: projectId, label, root }
}

/**
 * Global scope. Hypatia spells global as the empty scope string, but an empty
 * string is a substring of every scope, so `$contains` matching on it silently
 * returns every project's records. Plugin recall therefore never matches on
 * this value: exact scope comes from the ledger.
 */
export const GLOBAL_SCOPE = ''

/**
 * Stable, ownership-encoding Hypatia knowledge name.
 * The scope segment is redundant with the ledger on purpose - it makes
 * ownership checkable from the key alone, before any ledger lookup.
 */
export function memoryName(scope, memoryId) {
  return `${MEMORY_NAME_PREFIX}:${scopeTag(scope)}:${memoryId}`
}

/** The scope segment embedded in plugin-owned keys. */
export function scopeTag(scope) {
  return digest('scope', scope).slice(0, 16)
}

/** Stable Hypatia name for a DSH session node. */
export function sessionName(sessionIdentity) {
  return `${SESSION_NAME_PREFIX}:${digest('session', sessionIdentity).slice(0, 24)}`
}

/**
 * Whether a Hypatia key claims plugin ownership. A true result is necessary
 * but never sufficient: recall still requires an active ledger row in the
 * exact current scope, because anyone can create a lookalike key.
 */
export function isPluginOwnedName(name) {
  return typeof name === 'string'
    && (name.startsWith(`${MEMORY_NAME_PREFIX}:`) || name.startsWith(`${SESSION_NAME_PREFIX}:`))
}

/** Whether `name` is a plugin memory key belonging to exactly `scope`. */
export function nameMatchesScope(name, scope) {
  if (typeof name !== 'string' || !name.startsWith(`${MEMORY_NAME_PREFIX}:`)) return false
  return name.split(':')[2] === scopeTag(scope)
}

/**
 * Deterministic memory ID for source-derived memories, so the same source
 * range never yields a second record after a crash or duplicate notification.
 */
export function deriveMemoryId({ sourceIdentity, fromSeq, throughSeq, kind }) {
  return digest('memory', sourceIdentity, fromSeq, throughSeq, kind).slice(0, 24)
}

/**
 * Stable operation ID over immutable host-owned fields only.
 * A repeat of this ID returns the existing receipt or enters reconciliation;
 * it never blindly creates a second Hypatia record.
 */
export function deriveOperationId({
  sourceIdentity,
  fromSeq,
  throughSeq,
  kind,
  verb = 'create',
  extractorVersion = EXTRACTOR_VERSION,
  proposalSchemaVersion = PROPOSAL_SCHEMA_VERSION,
}) {
  return digest(
    'operation', verb, sourceIdentity, fromSeq, throughSeq, kind,
    extractorVersion, proposalSchemaVersion,
  ).slice(0, 32)
}

/**
 * Opaque identity for one DSH session as a memory source. Includes creation
 * time so a recycled session ID cannot silently inherit another's memories.
 */
export function sourceIdentityOf({ sessionId, sessionCreatedAt, persistenceSource }) {
  return digest('source', sessionId, sessionCreatedAt ?? 0, persistenceSource ?? 'unknown').slice(0, 32)
}

/**
 * Build the provenance block stored with every source-derived memory.
 * Fields are host-observed; none of them are model-proposed.
 */
export function buildProvenance({
  sessionId,
  sessionCreatedAt = 0,
  sessionCwd = null,
  persistenceSource = 'unknown',
  revisionAtExtraction = 'unknown',
  parentSession = null,
  seedLength = 0,
  fromSeq = 0,
  throughSeq = 0,
  turn = 0,
  embeddingModelVersion = null,
}) {
  return {
    source: {
      dshSessionId: sessionId,
      dshSessionCreatedAt: sessionCreatedAt,
      dshSessionCwd: sessionCwd,
      dshPersistenceSource: persistenceSource,
      dshRevisionAtExtraction: revisionAtExtraction,
      parentSession,
      seedLength,
      fromSeq,
      throughSeq,
      turn,
    },
    derivation: {
      extractorVersion: EXTRACTOR_VERSION,
      proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
      validatorPolicyVersion: VALIDATOR_POLICY_VERSION,
      embeddingModelVersion,
    },
  }
}

/**
 * Canonical payload hash used as the write-verification receipt. Key order is
 * normalized so a semantically identical payload always hashes the same.
 */
export function payloadHash(payload) {
  return digest('payload', canonicalJson(payload))
}

/** Stable JSON with sorted object keys, for hashing and equality checks. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}
