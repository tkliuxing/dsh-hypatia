/**
 * Wiring tests for the plugin entry point.
 *
 * These cover the seams `apply()` owns and nothing else does: degradation when
 * Hypatia is missing or the policy is empty, that recall enters the same
 * request through the pre-step decision, and that the deprecated bridge stays
 * off unless explicitly enabled.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { apply, inject, name } from '../index.js'
import { deriveProjectIdentity, memoryName } from '../src/identity.js'
import { openLedger } from '../src/ledger/ledger.js'
import { resolveOnPath } from '../src/adapter/cli.js'

/** Recall wiring needs a real adapter; skip where hypatia is not installed. */
function hypatiaMissing() {
  return resolveOnPath('hypatia') ? false : 'hypatia CLI not on PATH'
}

const stateDirs = []

/** A cordis-like context recording registrations and emitted events. */
function makeContext() {
  const handlers = new Map()
  const ctx = {
    warnings: [],
    skills: { registered: [], register(skill) { this.registered.push(skill) } },
    agents: { roots: () => [] },
    handlers,
    logger: () => ({ warn: (message) => ctx.warnings.push(message) }),
    get: () => undefined,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler))
    },
    has: (event) => (handlers.get(event) ?? []).length > 0,
  }
  return ctx
}

function freshStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hypatia-test-'))
  stateDirs.push(dir)
  return dir
}

/** Config pointing at a throwaway ledger and a binary that cannot exist. */
function config(overrides = {}) {
  return { state: { dir: freshStateDir() }, ...overrides }
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin metadata', () => {
  it('declares its name and required services', () => {
    assert.equal(name, 'dsh-hypatia')
    assert.deepEqual(inject.required, ['skills', 'agents'])
    assert.ok(inject.optional.includes('tools'))
  })
})

describe('degradation', () => {
  it('registers skills even when memory cannot start', async () => {
    const ctx = makeContext()
    // An unresolvable absolute path makes adapter creation fail deterministically.
    await apply(ctx, config({ adapter: { binaryPath: '/nonexistent/hypatia' } }))

    assert.deepEqual(ctx.skills.registered.map((skill) => skill.name).sort(), ['hypatia', 'hypatia-memory'])
  })

  it('stops before opening a ledger when the policy grants nothing', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' } }))

    assert.match(ctx.warnings.join('\n'), /grants no capabilities/)
    assert.equal(ctx.has('agent/pre-step'), false, 'no recall handler without a policy')
  })

  it('warns and changes nothing when Phase 3 extraction is requested', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ extraction: { enabled: true }, memory: { preset: 'disabled' } }))

    assert.match(ctx.warnings.join('\n'), /gated NO-GO in GOAL\.md/)
  })

  it('does not register the deprecated bridge by default', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' } }))

    assert.equal(ctx.has('agent/turn-stopping'), false)
  })
})

describe('same-request recall wiring', { skip: hypatiaMissing() }, () => {
  /** Seed one applied memory straight into the ledger `apply()` will open. */
  function seedLedger(stateDir, scope) {
    const ledger = openLedger(join(stateDir, 'state.sqlite'))
    const memoryId = 'seeded01'
    ledger.beginOperation({
      operationId: 'op-seeded01',
      memoryId,
      verb: 'create',
      scope,
      shelf: 'default',
      hypatiaName: memoryName(scope, memoryId),
      kind: 'rule',
      title: 'Pin the toolchain',
      payload: { title: 'Pin the toolchain', summary: 'Release builds pin rust-toolchain.toml.' },
      payloadHash: 'seeded-hash',
    })
    ledger.markDispatched('op-seeded01')
    ledger.commitReceipt('op-seeded01', { verified: true })
    ledger.close()
  }

  /** Drive the registered pre-step handler with one direct user message. */
  async function runPreStep(ctx, agent, text) {
    const messages = [{
      id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }]
    const handler = ctx.handlers.get('agent/pre-step')[0]
    return handler(
      { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }),
    )
  }

  function makeAgent(cwd) {
    return { session: { id: 's1', header: { id: 's1', cwd, createdAt: 1 } }, ctx: makeContext() }
  }

  it('appends a recall message to the accepted decision', async () => {
    const ctx = makeContext()
    const stateDir = freshStateDir()
    const cwd = '/work/recall-wiring'
    seedLedger(stateDir, deriveProjectIdentity({ cwd }).scope)

    await apply(ctx, { state: { dir: stateDir }, recall: { hypatiaSupplement: false } })
    const decision = await runPreStep(ctx, makeAgent(cwd), 'what is our toolchain rule?')

    assert.equal(decision.messages.length, 2)
    const appended = decision.messages[1]
    assert.equal(appended.source.form, 'recall')
    assert.equal(appended.source.plugin, 'dsh-hypatia')
    assert.match(appended.content[0].text, /Pin the toolchain/)
    assert.match(appended.content[0].text, /untrusted historical reference data/)
  })

  it('does not leak a memory into another project\'s session', async () => {
    const ctx = makeContext()
    const stateDir = freshStateDir()
    seedLedger(stateDir, deriveProjectIdentity({ cwd: '/work/project-one' }).scope)

    await apply(ctx, { state: { dir: stateDir }, recall: { hypatiaSupplement: false } })
    const decision = await runPreStep(ctx, makeAgent('/work/project-two'), 'what is our toolchain rule?')

    assert.equal(decision.messages.length, 1, 'no recall for a different project')
  })

  it('adds nothing when the turn carries no direct user message', async () => {
    const ctx = makeContext()
    const stateDir = freshStateDir()
    const cwd = '/work/recall-wiring'
    seedLedger(stateDir, deriveProjectIdentity({ cwd }).scope)

    await apply(ctx, { state: { dir: stateDir }, recall: { hypatiaSupplement: false } })
    const contextOnly = [{
      id: 'p1', role: 'user',
      source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'x' },
      content: [{ type: 'text', text: 'toolchain' }],
    }]
    const handler = ctx.handlers.get('agent/pre-step')[0]
    const decision = await handler(
      { agent: makeAgent(cwd), messages: contextOnly, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: contextOnly }),
    )

    assert.equal(decision.messages.length, 1)
  })

  it('preserves a downstream rejection untouched', async () => {
    const ctx = makeContext()
    const stateDir = freshStateDir()
    const cwd = '/work/recall-wiring'
    seedLedger(stateDir, deriveProjectIdentity({ cwd }).scope)

    await apply(ctx, { state: { dir: stateDir }, recall: { hypatiaSupplement: false } })
    const handler = ctx.handlers.get('agent/pre-step')[0]
    const decision = await handler(
      { agent: makeAgent(cwd), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'reject', reason: 'downstream said no' }),
    )

    assert.equal(decision.kind, 'reject')
    assert.equal(decision.reason, 'downstream said no')
  })
})

describe('skill registration', () => {
  it('marks hypatia-memory as not user-invocable', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ adapter: { binaryPath: '/nonexistent/hypatia' } }))

    const memory = ctx.skills.registered.find((skill) => skill.name === 'hypatia-memory')
    assert.equal(memory.invocation.userInvocable, false)

    const admin = ctx.skills.registered.find((skill) => skill.name === 'hypatia')
    assert.equal(admin.invocation.userInvocable, true)
  })

  it('ships skill content and a resource base for each skill', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ adapter: { binaryPath: '/nonexistent/hypatia' } }))

    for (const skill of ctx.skills.registered) {
      assert.ok(skill.content.length > 100, `${skill.name} has no content`)
      assert.equal(skill.resourceBase.kind, 'directory')
      assert.ok(skill.description.length > 0)
    }
  })
})

describe('deprecated bridge registration', () => {
  it('honours legacyBridge.enabled even when the host memory path is off', async () => {
    // The configuration an operator migrating off TRIGGER would actually use:
    // keep the old path only, while the host path is still being evaluated.
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' }, legacyBridge: { enabled: true } }))

    assert.equal(ctx.has('agent/turn-stopping'), true)
    assert.equal(ctx.has('agent/session-start'), true)
    assert.match(ctx.warnings.join('\n'), /legacyBridge is enabled/)
  })

  it('still stays off by default under the same configuration', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' } }))

    assert.equal(ctx.has('agent/turn-stopping'), false)
  })
})
