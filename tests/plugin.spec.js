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

/**
 * A cordis-like context recording registrations and emitted events.
 *
 * `agents.roots()` reports the agents this context has published, which is
 * what the real service does. An earlier version of this fake returned a
 * constant empty array, and because `apply()` skips any agent absent from
 * `roots()`, every per-agent registration silently short-circuited: tools,
 * compaction ingest, and disposal were never exercised through `apply()` at
 * all. The suite stayed green while the wiring layer had zero coverage, which
 * is how a broken `inject` declaration reached a real profile.
 */
function makeContext() {
  const handlers = new Map()
  const roots = []
  const ctx = {
    warnings: [],
    skills: { registered: [], register(skill) { this.registered.push(skill) } },
    agents: { roots: () => [...roots] },
    handlers,
    logger: () => ({ warn: (message) => ctx.warnings.push(message) }),
    get: () => undefined,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler))
    },
    emit(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
    },
    has: (event) => (handlers.get(event) ?? []).length > 0,
    /** Publish an agent the way the runtime does: root list first, then event. */
    createAgent(agent) {
      roots.push(agent)
      ctx.emit('agent/created', { agent })
      return agent
    },
    disposeAgent(agent) {
      const index = roots.indexOf(agent)
      if (index !== -1) roots.splice(index, 1)
      ctx.emit('agent/disposed', { agent })
    },
  }
  return ctx
}

/** An agent whose own context carries a tool registry, as the runtime's does. */
function makeRootAgent({ id = 'agent-1', cwd = '/work/wiring', origin, withTools = true } = {}) {
  const registered = new Map()
  return {
    session: { id, header: { id, cwd, origin, createdAt: 1 } },
    ctx: {
      registered,
      ...(withTools
        ? {
          tools: {
            register(definition) {
              registered.set(definition.name, definition)
              return () => registered.delete(definition.name)
            },
          },
        }
        : {}),
    },
  }
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
    assert.deepEqual(inject, ['skills', 'agents'])
  })

  it('declares inject as a flat array of service names', () => {
    // Cordis reads the normalized form with `Object.keys(fiber.inject)`, so an
    // object like {required: [...], optional: [...]} is taken as two services
    // named "required" and "optional". They never resolve, the entry stays
    // pending, and the entire profile boot fails - observed for real:
    //   dsh-hypatia: pending (waiting for services: required, optional)
    assert.ok(Array.isArray(inject), 'inject must be an array, never an object')
    for (const service of inject) {
      assert.equal(typeof service, 'string', `inject entry ${String(service)} must be a service name`)
    }
  })

  it('requires only services every profile provides', () => {
    // A service listed here that a profile lacks is a hard boot failure for
    // the whole profile, so `tools` and `sandboxPolicy` stay out: both degrade
    // cleanly when absent.
    assert.ok(!inject.includes('tools'))
    assert.ok(!inject.includes('sandboxPolicy'))
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

describe('per-agent wiring', { skip: hypatiaMissing() }, () => {
  /** Boot the plugin against a throwaway ledger and return the live context. */
  async function boot(overrides = {}) {
    const ctx = makeContext()
    await apply(ctx, { state: { dir: freshStateDir() }, recall: { hypatiaSupplement: false }, ...overrides })
    return ctx
  }

  it('registers every memory tool on a published root agent', async () => {
    const ctx = await boot()
    const agent = ctx.createAgent(makeRootAgent())

    assert.deepEqual([...agent.ctx.registered.keys()].sort(), [
      'memory_forget_confirm',
      'memory_forget_preview',
      'memory_reconcile',
      'memory_remember',
      'memory_search',
      'memory_status',
    ])
  })

  it('wires tools that actually run against the booted ledger', async () => {
    const ctx = await boot()
    const agent = ctx.createAgent(makeRootAgent())

    // Exercising the tool through the wiring is the point: a registration that
    // hands over a broken ledger or scope would pass a name-only assertion.
    const status = await agent.ctx.registered.get('memory_status').execute({}, {})

    assert.equal(status.error, undefined)
    assert.match(status.scope, /^wiring-/)
    assert.ok(Array.isArray(status.capabilities))
  })

  it('scopes each agent to its own workspace', async () => {
    const ctx = await boot()
    const one = ctx.createAgent(makeRootAgent({ id: 'a', cwd: '/work/project-one' }))
    const two = ctx.createAgent(makeRootAgent({ id: 'b', cwd: '/work/project-two' }))

    const first = await one.ctx.registered.get('memory_status').execute({}, {})
    const second = await two.ctx.registered.get('memory_status').execute({}, {})

    assert.notEqual(first.scope, second.scope)
  })

  it('skips subagent sessions', async () => {
    const ctx = await boot()
    const agent = ctx.createAgent(makeRootAgent({ origin: 'subagent' }))

    assert.equal(agent.ctx.registered.size, 0)
  })

  it('registers an agent only once', async () => {
    const ctx = await boot()
    const agent = makeRootAgent()
    ctx.createAgent(agent)
    ctx.emit('agent/created', { agent })

    assert.equal(agent.ctx.registered.size, 6)
  })

  it('disposes an agent\'s tools when the agent goes away', async () => {
    const ctx = await boot()
    const agent = ctx.createAgent(makeRootAgent())
    assert.equal(agent.ctx.registered.size, 6)

    ctx.disposeAgent(agent)

    assert.equal(agent.ctx.registered.size, 0, 'a disposed agent must not leave tools registered')
  })

  it('warns instead of silently skipping when the tools service is absent', async () => {
    const ctx = await boot()
    const agent = ctx.createAgent(makeRootAgent({ withTools: false }))

    assert.equal(agent.ctx.registered.size, 0)
    assert.match(ctx.warnings.join('\n'), /`tools` service is unavailable/)
  })

  it('registers no tools when registerTools is off, and does not warn', async () => {
    const ctx = await boot({ registerTools: false })
    const agent = ctx.createAgent(makeRootAgent())

    assert.equal(agent.ctx.registered.size, 0)
    assert.ok(!ctx.warnings.join('\n').includes('`tools` service is unavailable'))
  })

  it('subscribes compaction ingest for the agent', async () => {
    const before = makeContext()
    await apply(before, { state: { dir: freshStateDir() }, ingest: { compaction: false } })
    const withoutIngest = (before.handlers.get('session/event') ?? []).length

    const ctx = await boot()
    ctx.createAgent(makeRootAgent())
    const withIngest = (ctx.handlers.get('session/event') ?? []).length

    assert.equal(withoutIngest, 0)
    assert.equal(withIngest, 1, 'compaction ingest must attach through apply(), not only in unit tests')
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

describe('removed bridge configuration', () => {
  it('tells a profile still carrying legacyBridge.enabled that the bridge is gone', async () => {
    // The configuration an operator who never finished migrating would still
    // have: the old path only, while the host path was being evaluated. It
    // must not boot silently into a session with no memory path at all.
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' }, legacyBridge: { enabled: true } }))

    assert.equal(ctx.has('agent/turn-stopping'), false)
    assert.equal(ctx.has('agent/session-start'), false)
    assert.match(ctx.warnings.join('\n'), /legacyBridge\.enabled is set but .* has been removed/s)
  })

  it('says nothing when the key is absent', async () => {
    const ctx = makeContext()
    await apply(ctx, config({ memory: { preset: 'disabled' } }))

    assert.equal(ctx.has('agent/turn-stopping'), false)
    assert.doesNotMatch(ctx.warnings.join('\n'), /legacyBridge/)
  })
})
