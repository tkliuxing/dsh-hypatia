/**
 * Phase 0 acceptance gates for identity, authorization, and redaction.
 *
 * These three decide what a memory *is*, who may write it, and what must
 * never be stored - so they are tested independently of any backend.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ErrorCode } from '../src/errors.js'
import { Capability, createMemoryPolicy } from '../src/policy.js'
import { normalizeConfig } from '../src/config.js'
import { redactDeep, redactText, truncateBytes } from '../src/redaction.js'
import {
  buildProvenance,
  canonicalJson,
  deriveMemoryId,
  deriveOperationId,
  deriveProjectIdentity,
  isPluginOwnedName,
  memoryName,
  nameMatchesScope,
  payloadHash,
} from '../src/identity.js'

describe('project identity', () => {
  it('separates same-named checkouts at different paths', () => {
    const a = deriveProjectIdentity({ cwd: '/work/acme/api' })
    const b = deriveProjectIdentity({ cwd: '/work/other/api' })

    assert.notEqual(a.scope, b.scope, 'basename alone would collide here')
    assert.equal(a.label, 'api')
    assert.equal(b.label, 'api')
  })

  it('is stable for the same path and normalizes it', () => {
    const a = deriveProjectIdentity({ cwd: '/work/acme/api' })
    const b = deriveProjectIdentity({ cwd: '/work/acme/./api' })

    assert.equal(a.scope, b.scope)
  })

  it('lets an operator pin one scope across worktrees', () => {
    const a = deriveProjectIdentity({ cwd: '/work/api', configuredProjectId: 'acme-api' })
    const b = deriveProjectIdentity({ cwd: '/work/api-worktree', configuredProjectId: 'acme-api' })

    assert.equal(a.scope, b.scope)
    assert.equal(a.scope, 'acme-api')
  })

  it('produces a comma-free scope, since Hypatia splits scopes on commas', () => {
    const identity = deriveProjectIdentity({ cwd: '/work/my, weird; project' })
    assert.ok(!identity.scope.includes(','))
  })

  it('falls back to an explicit unscoped identity with no cwd', () => {
    assert.equal(deriveProjectIdentity({ cwd: null }).scope, 'unscoped')
  })
})

describe('stable names', () => {
  it('encodes scope ownership in the key itself', () => {
    const mine = deriveProjectIdentity({ cwd: '/work/a' }).scope
    const theirs = deriveProjectIdentity({ cwd: '/work/b' }).scope
    const name = memoryName(mine, 'mem1')

    assert.ok(isPluginOwnedName(name))
    assert.ok(nameMatchesScope(name, mine))
    assert.ok(!nameMatchesScope(name, theirs))
  })

  it('does not claim ownership of a foreign key', () => {
    assert.ok(!isPluginOwnedName('some-user-note'))
    assert.ok(!nameMatchesScope('some-user-note', 'proj-a'))
  })
})

describe('operation identity', () => {
  it('is deterministic for the same source range and kind', () => {
    const args = { sourceIdentity: 'src', fromSeq: 1, throughSeq: 9, kind: 'summary' }
    assert.equal(deriveOperationId(args), deriveOperationId(args))
    assert.equal(deriveMemoryId(args), deriveMemoryId(args))
  })

  it('differs when the source range or kind differs', () => {
    const base = { sourceIdentity: 'src', fromSeq: 1, throughSeq: 9, kind: 'summary' }
    assert.notEqual(deriveOperationId(base), deriveOperationId({ ...base, throughSeq: 10 }))
    assert.notEqual(deriveOperationId(base), deriveOperationId({ ...base, kind: 'rule' }))
    assert.notEqual(deriveOperationId(base), deriveOperationId({ ...base, sourceIdentity: 'other' }))
  })

  it('changes when the extractor version changes, so old output is not reused', () => {
    const base = { sourceIdentity: 'src', fromSeq: 1, throughSeq: 9, kind: 'summary' }
    assert.notEqual(deriveOperationId(base), deriveOperationId({ ...base, extractorVersion: '9.9.9' }))
  })
})

describe('payload hashing', () => {
  it('ignores key order', () => {
    assert.equal(payloadHash({ a: 1, b: [2, 3] }), payloadHash({ b: [2, 3], a: 1 }))
  })

  it('does not ignore array order or values', () => {
    assert.notEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }))
    assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }))
  })

  it('produces canonical JSON with sorted keys', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  })
})

describe('provenance', () => {
  it('records host-observed source facts and derivation versions', () => {
    const provenance = buildProvenance({
      sessionId: 's1', sessionCreatedAt: 5, sessionCwd: '/work/a', fromSeq: 2, throughSeq: 8, turn: 3,
    })

    assert.equal(provenance.source.dshSessionId, 's1')
    assert.equal(provenance.source.fromSeq, 2)
    assert.equal(provenance.source.throughSeq, 8)
    assert.ok(provenance.derivation.extractorVersion)
    assert.equal(typeof provenance.derivation.proposalSchemaVersion, 'number')
    assert.equal(typeof provenance.derivation.validatorPolicyVersion, 'number')
  })
})

describe('memory authorization', () => {
  it('is independent of the file sandbox and starts from the configured preset', () => {
    const readOnly = createMemoryPolicy({ preset: 'read-only-recall' })

    assert.ok(readOnly.can(Capability.READ_RECALL))
    assert.ok(!readOnly.can(Capability.SEMANTIC_WRITE))
    assert.ok(!readOnly.can(Capability.DELETE))
  })

  it('never lets automatic extraction write a global rule', () => {
    const full = createMemoryPolicy({ preset: 'full' })

    assert.ok(full.can(Capability.GLOBAL_RULE_WRITE), 'granted for explicit use')
    assert.ok(!full.can(Capability.GLOBAL_RULE_WRITE, { automatic: true }), 'never for automatic use')
  })

  it('grants reconcile wherever it grants the writes reconcile settles', () => {
    // The startup pass and `memory_reconcile` are the same operation; if one
    // capability governed the automatic path and another the manual one, a
    // default deployment could dispatch writes it could never settle.
    const standard = createMemoryPolicy({ preset: 'standard' })

    assert.ok(standard.can(Capability.SEMANTIC_WRITE))
    assert.ok(standard.can(Capability.RECONCILE))
    assert.ok(!standard.can(Capability.ADMINISTER), 'shelf administration stays separate')
  })

  it('keeps transcript mirroring off even when configured on', () => {
    const warnings = []
    const policy = createMemoryPolicy({
      preset: 'full',
      capabilities: [Capability.TRANSCRIPT_MIRROR],
      warn: (message) => warnings.push(message),
    })

    assert.ok(!policy.can(Capability.TRANSCRIPT_MIRROR))
    assert.match(warnings.join('\n'), /transcript-mirror is not implemented/)
  })

  it('cannot be widened after construction', () => {
    const policy = createMemoryPolicy({ preset: 'read-only-recall' })

    assert.throws(() => { policy.can = () => true }, TypeError)
    assert.ok(!policy.can(Capability.DELETE))
  })

  it('throws a structured unauthorized error from require()', () => {
    const policy = createMemoryPolicy({ preset: 'read-only-recall' })

    assert.throws(
      () => policy.require(Capability.DELETE),
      (error) => error.code === ErrorCode.UNAUTHORIZED,
    )
  })

  it('falls back to no capabilities for an unknown preset', () => {
    const warnings = []
    const policy = createMemoryPolicy({ preset: 'wide-open', warn: (m) => warnings.push(m) })

    assert.equal(policy.enabled, false)
    assert.match(warnings.join('\n'), /unknown memory policy preset/)
  })
})

describe('redaction', () => {
  it('removes common credential shapes', () => {
    const cases = [
      ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
      ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'github-token'],
      ['sk-ant-0123456789abcdefghijklmn', 'anthropic-key'],
      ['Bearer abcdefghijklmnopqrstuvwxyz012345', 'bearer-header'],
    ]
    for (const [secret, label] of cases) {
      const result = redactText(`value is ${secret} here`)
      assert.ok(!result.text.includes(secret), `${label} leaked`)
      assert.ok(result.labels.includes(label), `${label} not reported`)
    }
  })

  it('keeps the key name and redacts only the assigned value', () => {
    const result = redactText('password: hunter2secret and more')
    assert.equal(result.text, 'password: [redacted] and more')
  })

  it('strips credentials from a URL without destroying the URL', () => {
    const result = redactText('postgres://user:p4ssw0rd@host/db')
    assert.ok(!result.text.includes('p4ssw0rd'))
    assert.ok(result.text.includes('@host/db'))
  })

  it('walks nested structures', () => {
    const { value, labels } = redactDeep({ a: [{ b: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' }] })
    assert.equal(value.a[0].b, '[redacted]')
    assert.deepEqual(labels, ['github-token'])
  })

  it('leaves ordinary text untouched', () => {
    const result = redactText('the adapter uses execFile with fixed argv')
    assert.equal(result.text, 'the adapter uses execFile with fixed argv')
    assert.deepEqual(result.labels, [])
  })

  it('truncates to a byte budget without splitting a UTF-8 sequence', () => {
    const truncated = truncateBytes('中'.repeat(100), 40)
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= 40)
    assert.ok(!truncated.includes('�'))
  })
})

describe('configuration', () => {
  it('clamps out-of-range values instead of trusting them', () => {
    const config = normalizeConfig({
      recall: { deadlineMs: 10_000_000, maxResults: 999 },
      adapter: { timeoutMs: -5, maxConcurrentReads: 0 },
    })

    assert.equal(config.recall.deadlineMs, 5_000)
    assert.equal(config.recall.maxResults, 25)
    assert.equal(config.adapter.timeoutMs, 250)
    assert.equal(config.adapter.maxConcurrentReads, 1)
  })

  it('keeps Phase 3 extraction off even when an operator enables it', () => {
    const config = normalizeConfig({ extraction: { enabled: true } })

    assert.equal(config.extraction.enabled, false)
    assert.equal(config.extraction.requested, true)
  })

  it('keeps the legacy bridge off by default', () => {
    assert.equal(normalizeConfig({}).legacyBridge.enabled, false)
    assert.equal(normalizeConfig({ legacyBridge: { enabled: true } }).legacyBridge.enabled, true)
  })

  it('ignores a relative binary path, which would be ambiguous at spawn time', () => {
    assert.equal(normalizeConfig({ adapter: { binaryPath: './hypatia' } }).adapter.binaryPath, null)
    assert.equal(normalizeConfig({ adapter: { binaryPath: '/usr/bin/hypatia' } }).adapter.binaryPath, '/usr/bin/hypatia')
  })
})

/**
 * Regressions from the max-effort review: three places where a stated
 * guarantee did not hold in the code that claimed it.
 */
describe('configuration hardening', () => {
  it('falls back to the default for a blank value rather than clamping to the minimum', () => {
    // `adapter:\n  timeoutMs:` in YAML arrives as null. `Number(null)` is a
    // finite 0, so a plain isFinite test would clamp it to `min` and every
    // hypatia call would be killed after 250ms.
    const config = normalizeConfig({
      adapter: { timeoutMs: null, maxOutputBytes: '' },
      recall: { deadlineMs: null, maxResults: false },
    })

    assert.equal(config.adapter.timeoutMs, 10_000)
    assert.equal(config.adapter.maxOutputBytes, 4 * 1024 * 1024)
    assert.equal(config.recall.deadlineMs, 200)
    assert.equal(config.recall.maxResults, 5)
  })

  it('truncates a fractional concurrency limit to an integer', () => {
    // A limit of 1.5 would leave `active >= limit` false at one in-flight call,
    // so the lane would admit a second hypatia process and hit the DuckDB lock.
    assert.equal(normalizeConfig({ adapter: { maxConcurrentReads: 1.5 } }).adapter.maxConcurrentReads, 1)
  })

  it('degrades rather than throwing for a preset named after an Object.prototype key', () => {
    const warnings = []
    const policy = createMemoryPolicy({ preset: 'constructor', warn: (m) => warnings.push(m) })

    assert.equal(policy.enabled, false)
    assert.match(warnings.join('\n'), /unknown memory policy preset/)
  })
})

describe('capability set immutability', () => {
  it('does not hand out the live capability set', () => {
    const policy = createMemoryPolicy({ preset: 'read-only-recall' })

    // `Object.freeze` is shallow, so exposing the backing Set would let any
    // holder of the policy widen it - defeating both the preset gate and the
    // transcript-mirror refusal.
    assert.throws(() => policy.capabilities.push(Capability.ADMINISTER))
    assert.equal(typeof policy.capabilities.add, 'undefined')
    assert.ok(!policy.can(Capability.ADMINISTER))
  })
})

describe('redaction shapes', () => {
  it('redacts an assigned secret in its JSON spelling, not only unquoted', () => {
    // The key's own closing quote sits between the token and the colon, so a
    // pattern anchored straight to `\s*[:=]` misses every pasted JSON config.
    const json = redactText('{"password": "hunter2secret"}')

    assert.ok(!json.text.includes('hunter2secret'))
    assert.deepEqual(json.labels, ['assigned-secret'])
    assert.ok(!redactText('{"api_key": "abcdef123456"}').text.includes('abcdef123456'))
  })

  it('leaves prose that merely mentions a secret keyword alone', () => {
    const prose = 'passwords are important to people'
    assert.equal(redactText(prose).text, prose)
  })
})
