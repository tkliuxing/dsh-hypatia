/**
 * The pre-refactor TRIGGER bridge, kept only as a migration escape hatch.
 *
 * DEPRECATED. This is the compatibility mode GOAL.md describes: it asks the
 * model to run `hypatia` through Bash by injecting protocol text into the
 * durable transcript. Its architectural faults are known and are the reason
 * the host adapter exists:
 *
 * - Memory protocol text lands in the model-visible durable transcript.
 * - Assistant logging is queued to the next step, so a final reply can be lost.
 * - Turn counters and startup state are process-local.
 * - Writes have no durable operation ID, receipt, retry, or repair wrapper.
 * - Generic Bash widens prompt-injection and destructive-delete exposure.
 * - `danger-full-access` is overloaded as memory authorization.
 *
 * It is off by default (`legacyBridge.enabled`). Do not add features here;
 * new work belongs in the adapter, ledger, recall, and tool modules.
 *
 * @module dsh-hypatia/legacy-bridge
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

/** Remember/forget intent in either language, matched against the user prompt. */
const EXPLICIT_MEMORY_RE =
  /记住|记一下|记下|请不要忘记|别忘了|请记住|忘掉|忘记|取消记住|\bremember\b|\bforget\b/i

/** Project label for hypatia scopes: basename of the session workspace. */
function projectOf(agent) {
  const cwd = agent.session.header.cwd
  return cwd ? basename(cwd) : 'default'
}

/** Whether this session is a top-level user session (subagent children are skipped). */
function isRootSession(agent) {
  return agent.session.header.origin !== 'subagent'
}

/**
 * Resolve the effective file-sandbox mode for an agent's session.
 * Returns `undefined` only when no sandbox policy service is composed (legacy
 * or test deployments). Resolution failures propagate so the gate can fail
 * closed and report the error.
 */
function sessionSandboxMode(ctx, agent) {
  const policy = ctx.get('sandboxPolicy')
  return policy?.resolve({ session: agent.session }).mode
}

/**
 * One user-role plugin message. Mirrors `createUserMessage` from
 * `@deepseek-ai/dsh-llm`, inlined so this package needs no runtime dependency
 * on harness packages - a `dsh plugin add <dir>` link resolves imports from
 * its real path, where in-box harness packages are not reachable.
 */
function pluginMessage(pluginName, text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: pluginName, form: 'notice', summary },
  }
}

/**
 * Register the hypatia-memory event bridge for the lifetime of `ctx`.
 *
 * Gated by the session's effective file-sandbox mode: TRIGGER signals are
 * injected only under `danger-full-access`, because the triggered skill runs
 * `hypatia` commands against a DuckDB outside the workspace.
 *
 * @param {object} ctx cordis context
 * @param {{extractInterval: number, name?: string, warn?: (msg: string) => void}} options
 */
export function registerMemoryBridge(ctx, { extractInterval, name = 'dsh-hypatia', warn: warnFn } = {}) {
  const warn = warnFn ?? ((message) => {
    try {
      ctx.logger(name).warn(message)
    } catch {
      console.warn(`[${name}] ${message}`)
    }
  })

  /** Per-session bridge state. */
  const states = new Map()
  const stateFor = (id) => {
    let state = states.get(id)
    if (!state) {
      state = { userTurns: 0, countedTurns: new Set() }
      states.set(id, state)
    }
    return state
  }

  /** Sessions already warned about confined mode, so we log the skip once. */
  const warnedSessions = new Set()
  const warnSkippedOnce = (agent, action, reason) => {
    const sessionId = String(agent.session.id)
    if (warnedSessions.has(sessionId)) return
    warnedSessions.add(sessionId)
    warn(`hypatia-memory ${action} skipped for session ${sessionId}: ${reason}`)
  }

  /**
   * Sessions whose startup trigger has already been injected. Tracked
   * separately so a session created confined and later elevated still gets
   * its rules/taboos loaded and its turn counter restored.
   */
  const startupInjected = new Set()
  const buildStartupMessage = (agent) => {
    const sessionId = String(agent.session.id)
    if (startupInjected.has(sessionId)) return undefined
    startupInjected.add(sessionId)
    const project = projectOf(agent)
    return pluginMessage(
      name,
      `[hypatia-memory] TRIGGER:session-start\n`
      + `SESSION_ID: ${sessionId}，PROJECT: ${project}\n`
      + `请通过 skill 工具加载 hypatia-memory 并执行 Session Startup：查询并内化 PROJECT=${project} `
      + `与全局 scope 的 rule / taboo 知识条目。若已存在 msg-${sessionId}-* 条目（会话恢复），`
      + `TURN 计数从现有最大序号继续。本会话后续的 [hypatia-memory] TRIGGER 信号均按该 skill 的协议处理。`,
      'hypatia-memory：会话启动，加载 rules/taboos',
    )
  }

  /**
   * Common gate for every bridge event: confined sessions warn once and are
   * skipped. Startup injection is handled by each caller so pre-step can place
   * the startup message in the same decision before the log notice
   * (`agent.inject()` during pre-step would queue it for the next step).
   */
  const guardAccess = (agent, action) => {
    let mode
    try {
      mode = sessionSandboxMode(ctx, agent)
    } catch (error) {
      warnSkippedOnce(
        agent,
        action,
        `sandbox policy resolution failed (${String(error)}); danger-full-access was not confirmed.`,
      )
      return false
    }
    // No sandbox policy service composed: treat as unrestricted (legacy / test).
    if (mode === undefined || mode === 'danger-full-access') return true
    warnSkippedOnce(
      agent,
      action,
      `sandbox mode "${mode}" cannot access the hypatia DuckDB (requires danger-full-access).`,
    )
    return false
  }

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(String(agent.session.id))
    warnedSessions.delete(String(agent.session.id))
    startupInjected.delete(String(agent.session.id))
  })

  // Claude Code `SessionStart` equivalent: ask the model to load project and
  // global rules/taboos before the first turn.
  ctx.on('agent/session-start', ({ agent }) => {
    if (!isRootSession(agent)) return
    if (!guardAccess(agent, 'session-start')) return
    const startup = buildStartupMessage(agent)
    if (startup) agent.inject(startup)
  })

  // Claude Code `UserPromptSubmit` equivalent: fire on the first step of a
  // turn that carries a genuine user message.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1 || !isRootSession(agent)) return decision
    if (!guardAccess(agent, 'pre-step')) return decision

    // Claimed inbox messages are not appended to session.events until after
    // pre-step returns, so the direct prompt must be found in this payload.
    const userMessage = messages.find((message) => message.source.kind === 'user')
    if (!userMessage) return decision

    const sessionId = String(agent.session.id)
    const state = stateFor(sessionId)
    if (state.countedTurns.has(turn)) return decision
    state.countedTurns.add(turn)
    state.userTurns += 1

    // Claim startup only once it can be returned with a genuine user prompt.
    const startup = buildStartupMessage(agent)
    const project = projectOf(agent)
    const lines = [
      `[hypatia-memory] TRIGGER:log`,
      `SESSION_ID: ${sessionId}，PROJECT: ${project}，第 ${state.userTurns} 条用户消息`,
      `按 hypatia-memory skill 的 Conversation Logging Protocol 记录本条用户消息并检查摘要级联；`
      + `记录是后台任务，完成后正常回复用户，不要向用户提及记录过程。`,
    ]
    if (state.userTurns % extractInterval === 0) {
      lines.push(
        `TRIGGER:extract —— 同时检查最近对话中是否有已完成的 work unit 需要提取为语义记忆。`,
      )
    }
    if (EXPLICIT_MEMORY_RE.test(messageText(userMessage))) {
      lines.push(
        `TRIGGER:immediate —— 用户消息疑似包含显式“记住/忘记”请求，若确认请直接执行对应的语义记忆操作。`,
      )
    }
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        ...(startup ? [startup] : []),
        pluginMessage(name, lines.join('\n'), 'hypatia-memory：记录用户消息'),
      ],
    }
  })

  // Claude Code `Stop` equivalent: queue logging of the assistant reply; the
  // pending context is claimed at the next pre-step (or after resume).
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!isRootSession(agent)) return
    if (!guardAccess(agent, 'turn-stopping')) return
    const sessionId = String(agent.session.id)
    const state = states.get(sessionId)
    if (!state || state.userTurns === 0) return
    agent.inject(pluginMessage(
      name,
      `[hypatia-memory] TRIGGER:log（assistant）\n`
      + `SESSION_ID: ${sessionId}，PROJECT: ${projectOf(agent)}\n`
      + `按 hypatia-memory skill 记录上一轮助手回复（msg-${sessionId}-<TURN>）并检查摘要级联；`
      + `这是后台记录任务，无需回复用户。`,
      'hypatia-memory：记录助手回复',
    ))
  })
}

/** Extract plain text from a user message's content blocks. */
function messageText(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
