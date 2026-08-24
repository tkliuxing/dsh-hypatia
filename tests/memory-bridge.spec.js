import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerMemoryBridge } from '../index.js'

class MockContext {
  constructor({ mode = 'danger-full-access', hasPolicy = true, resolveError } = {}) {
    this.mode = mode
    this.hasPolicy = hasPolicy
    this.resolveError = resolveError
    this.handlers = {}
    this.warnings = []
  }

  get(name) {
    if (name === 'sandboxPolicy') {
      if (!this.hasPolicy) return undefined
      return {
        resolve: ({ session }) => {
          if (this.resolveError) throw this.resolveError
          return {
            mode: this.mode,
            workspaceRoot: session?.header?.cwd ?? '/ws',
          }
        },
      }
    }
    throw new Error(`unknown service ${name}`)
  }

  logger(name) {
    return { warn: (msg) => this.warnings.push({ name, msg }) }
  }

  on(event, handler) {
    ;(this.handlers[event] ||= []).push(handler)
  }

  emit(event, payload) {
    return this.handlers[event]?.map((h) => h(payload)) ?? []
  }
}

function createAgent({ id = 'session-test', cwd = '/project', origin } = {}) {
  return {
    session: {
      id,
      header: { cwd, origin },
      events: [],
    },
    injected: [],
    inject(message) {
      this.injected.push(message)
    },
  }
}

let messageId = 0

function directUserMessage(text = 'hello') {
  messageId += 1
  return {
    id: `user-${messageId}`,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${messageId}` },
    content: [{ type: 'text', text }],
  }
}

function contextMessage(text = 'runtime context') {
  messageId += 1
  return {
    id: `context-${messageId}`,
    role: 'user',
    source: {
      kind: 'plugin',
      plugin: 'test-context',
      form: 'notice',
      summary: 'test runtime context',
    },
    content: [{ type: 'text', text }],
  }
}

function noopSignal() {
  return new AbortController().signal
}

async function runPreStep(ctx, agent, turn = 1, messages = [directUserMessage()]) {
  const handlers = ctx.handlers['agent/pre-step']
  assert.ok(handlers, 'pre-step handler not registered')
  assert.equal(handlers.length, 1)
  const next = () => Promise.resolve({ kind: 'enter', messages })
  return handlers[0]({ agent, messages, turn, step: 1, signal: noopSignal() }, next)
}

function runSessionStart(ctx, agent) {
  const handlers = ctx.handlers['agent/session-start']
  assert.ok(handlers, 'session-start handler not registered')
  assert.equal(handlers.length, 1)
  handlers[0]({ agent })
}

function runTurnStopping(ctx, agent) {
  const handlers = ctx.handlers['agent/turn-stopping']
  assert.ok(handlers, 'turn-stopping handler not registered')
  assert.equal(handlers.length, 1)
  handlers[0]({ agent })
}

describe('registerMemoryBridge sandbox gating', () => {
  it('injects session-start and user/assistant logs when session starts with full access', async () => {
    const ctx = new MockContext({ mode: 'danger-full-access' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 1)
    assert.ok(agent.injected[0].content[0].text.includes('TRIGGER:session-start'))

    const decision = await runPreStep(ctx, agent, 1)
    assert.equal(agent.session.events.length, 0)
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[0].source.kind, 'user')
    assert.ok(decision.messages[1].content[0].text.includes('TRIGGER:log'))
    assert.equal(ctx.warnings.length, 0)

    runTurnStopping(ctx, agent)
    assert.equal(agent.injected.length, 2)
    assert.ok(agent.injected[1].content[0].text.includes('TRIGGER:log（assistant）'))
  })

  it('skips everything and warns once when session starts confined', async () => {
    const ctx = new MockContext({ mode: 'read-only' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)
    assert.ok(ctx.warnings[0].msg.includes('sandbox mode "read-only"'))

    const decision = await runPreStep(ctx, agent, 1)
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0].source.kind, 'user')
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1) // still only one warning

    runTurnStopping(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)
  })

  it('fails closed and warns once when sandbox policy resolution throws', async () => {
    const ctx = new MockContext({ resolveError: new Error('resolver unavailable') })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)
    assert.ok(ctx.warnings[0].msg.includes('sandbox policy resolution failed'))
    assert.ok(ctx.warnings[0].msg.includes('resolver unavailable'))
    assert.ok(ctx.warnings[0].msg.includes('danger-full-access was not confirmed'))

    const decision = await runPreStep(ctx, agent, 1)
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0].source.kind, 'user')
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)

    runTurnStopping(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)

    ctx.resolveError = undefined
    const recovered = await runPreStep(ctx, agent, 2)
    assert.equal(recovered.messages.length, 3)
    assert.ok(recovered.messages[1].content[0].text.includes('TRIGGER:session-start'))
    assert.ok(recovered.messages[2].content[0].text.includes('TRIGGER:log'))
    assert.equal(ctx.warnings.length, 1)
  })

  it('keeps legacy unrestricted behavior when sandbox policy is not composed', async () => {
    const ctx = new MockContext({ hasPolicy: false })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 1)
    assert.ok(agent.injected[0].content[0].text.includes('TRIGGER:session-start'))

    const decision = await runPreStep(ctx, agent, 1)
    assert.equal(decision.messages.length, 2)
    assert.ok(decision.messages[1].content[0].text.includes('TRIGGER:log'))
    assert.equal(ctx.warnings.length, 0)
  })

  it('injects missed session-start after confined-to-full-access transition', async () => {
    const ctx = new MockContext({ mode: 'read-only' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)

    ctx.mode = 'danger-full-access'
    const decision = await runPreStep(ctx, agent, 1)
    // Startup is returned in the same pre-step decision, not queued via agent.inject().
    assert.equal(agent.injected.length, 0)
    assert.equal(decision.messages.length, 3)
    assert.equal(decision.messages[0].source.kind, 'user')
    assert.ok(decision.messages[1].content[0].text.includes('TRIGGER:session-start'))
    assert.ok(decision.messages[2].content[0].text.includes('TRIGGER:log'))
    assert.equal(ctx.warnings.length, 1) // no new warnings
  })

  it('does not duplicate startup after full-access -> confined -> full-access', async () => {
    const ctx = new MockContext({ mode: 'danger-full-access' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 1)

    await runPreStep(ctx, agent, 1)
    assert.equal(agent.injected.length, 1)

    ctx.mode = 'read-only'
    const confinedDecision = await runPreStep(ctx, agent, 2)
    assert.equal(confinedDecision.messages.length, 1)
    assert.equal(confinedDecision.messages[0].source.kind, 'user')
    assert.equal(ctx.warnings.length, 1)

    ctx.mode = 'danger-full-access'
    const resumedDecision = await runPreStep(ctx, agent, 3)
    assert.equal(resumedDecision.messages.length, 2)
    assert.equal(resumedDecision.messages[0].source.kind, 'user')
    assert.ok(resumedDecision.messages[1].content[0].text.includes('TRIGGER:log'))
    assert.equal(agent.injected.length, 1) // startup still injected only once
  })

  it('keeps missed startup pending through a post-elevation context-only step', async () => {
    const ctx = new MockContext({ mode: 'read-only' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 5 })

    runSessionStart(ctx, agent)
    assert.equal(agent.injected.length, 0)
    assert.equal(ctx.warnings.length, 1)

    ctx.mode = 'danger-full-access'
    const context = contextMessage()
    const contextDecision = await runPreStep(ctx, agent, 1, [context])
    assert.deepEqual(contextDecision.messages, [context])
    assert.equal(agent.injected.length, 0)

    const decision = await runPreStep(ctx, agent, 2, [directUserMessage('hello')])
    assert.equal(decision.messages.length, 3)
    assert.equal(decision.messages[0].source.kind, 'user')
    assert.ok(decision.messages[1].content[0].text.includes('TRIGGER:session-start'))
    assert.ok(decision.messages[2].content[0].text.includes('TRIGGER:log'))
    assert.ok(decision.messages[2].content[0].text.includes('第 1 条用户消息'))

    const nextDecision = await runPreStep(ctx, agent, 3)
    assert.equal(nextDecision.messages.length, 2)
    assert.equal(nextDecision.messages[0].source.kind, 'user')
    assert.ok(nextDecision.messages[1].content[0].text.includes('TRIGGER:log'))
  })

  it('uses claimed prompt text for extraction cadence and explicit memory intent', async () => {
    const ctx = new MockContext({ mode: 'danger-full-access' })
    const agent = createAgent()
    registerMemoryBridge(ctx, { extractInterval: 2 })
    runSessionStart(ctx, agent)

    const first = await runPreStep(ctx, agent, 1, [directUserMessage('hello')])
    const firstLog = first.messages.at(-1).content[0].text
    assert.ok(!firstLog.includes('TRIGGER:extract'))
    assert.ok(!firstLog.includes('TRIGGER:immediate'))

    const second = await runPreStep(ctx, agent, 2, [directUserMessage('remember this preference')])
    const secondLog = second.messages.at(-1).content[0].text
    assert.ok(secondLog.includes('第 2 条用户消息'))
    assert.ok(secondLog.includes('TRIGGER:extract'))
    assert.ok(secondLog.includes('TRIGGER:immediate'))
  })
})
