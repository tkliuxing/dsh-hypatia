/**
 * dsh-hypatia — Hypatia skills for DeepSeek Harness.
 *
 * Contributes the two hypatia skills (`hypatia`, `hypatia-memory`) to the
 * session skill catalog, and bridges DSH agent lifecycle events onto the
 * Claude-Code-style TRIGGER protocol the `hypatia-memory` skill expects:
 *
 *   - agent/session-start  -> TRIGGER:session-start (load rules/taboos)
 *   - agent/pre-step        -> TRIGGER:log per genuine user message
 *                              (+ TRIGGER:extract every N user turns,
 *                               + TRIGGER:immediate on remember/forget intent)
 *   - agent/turn-stopping   -> TRIGGER:log for the assistant reply
 *
 * The plugin requires the `hypatia` CLI on PATH. When it is missing the
 * plugin logs a warning and registers nothing.
 *
 * Optional config (cordis row `config:`):
 *   memoryBridge:   boolean (default true)  — event bridge on/off
 *   registerSkills: boolean (default true)  — skill catalog registration on/off
 *   extractInterval: number (default 5)     — user turns between TRIGGER:extract
 *
 * @module dsh-hypatia
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics and message provenance. */
export const name = 'dsh-hypatia'

/** Skill registry and agent registry drive everything this plugin does. */
export const inject = ['skills', 'agents']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PLUGIN_DIR, 'skills')

/** Remember/forget intent in either language, matched against the user prompt. */
const EXPLICIT_MEMORY_RE =
  /记住|记一下|记下|请不要忘记|别忘了|请记住|忘掉|忘记|取消记住|\bremember\b|\bforget\b/i

/** Best-effort logging that never breaks plugin load. */
function warn(ctx, message) {
  try {
    ctx.logger(name).warn(message)
  } catch {
    console.warn(`[${name}] ${message}`)
  }
}

/** Probe the `hypatia` CLI on PATH once at load time. */
function hypatiaAvailable() {
  const probe = spawnSync('hypatia', ['--version'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0
}

/**
 * Parse the small controlled frontmatter of a packaged SKILL.md.
 * Only the keys these skills use are supported: scalar values, double-quoted
 * strings, and booleans.
 */
function parseSkillFile(file) {
  const raw = readFileSync(file, 'utf8')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) throw new Error(`${file}: missing frontmatter block`)
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    }
    meta[kv[1]] = value
  }
  return { meta, content: raw.slice(match[0].length) }
}

/** Register every packaged skill directory (`<name>/SKILL.md`). */
function registerSkills(ctx) {
  if (!existsSync(SKILLS_DIR)) {
    warn(ctx, `skills directory missing: ${SKILLS_DIR} — package is incomplete, reinstall the plugin`)
    return
  }
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(SKILLS_DIR, entry.name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const { meta, content } = parseSkillFile(file)
    if (!meta.name || !meta.description) {
      warn(ctx, `${file}: frontmatter requires name and description, skipped`)
      continue
    }
    ctx.skills.register({
      name: meta.name,
      description: meta.description,
      content,
      source: 'bundled',
      path: file,
      resourceBase: { kind: 'directory', path: dir },
      invocation: {
        modelInvocable: meta['disable-model-invocation'] !== 'true',
        userInvocable: meta['user-invocable'] !== 'false',
      },
    })
  }
}

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
 * One user-role plugin message. Mirrors `createUserMessage` from
 * `@deepseek-ai/dsh-llm` (`{ ...input, id: randomUUID(), role: 'user' }`),
 * inlined so this package needs no runtime dependency on harness packages —
 * a `dsh plugin add <dir>` link resolves imports from its real path, where
 * in-box harness packages are not reachable.
 */
function pluginMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  }
}

/** Extract plain text from a user/message event's content blocks. */
function messageText(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Register the hypatia-memory event bridge for the lifetime of `ctx`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ extractInterval: number }} options
 */
function registerMemoryBridge(ctx, { extractInterval }) {
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
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(String(agent.session.id))
  })

  // Claude Code `SessionStart` equivalent: ask the model to load project and
  // global rules/taboos before the first turn.
  ctx.on('agent/session-start', ({ agent }) => {
    if (!isRootSession(agent)) return
    const sessionId = String(agent.session.id)
    const project = projectOf(agent)
    agent.inject(pluginMessage(
      `[hypatia-memory] TRIGGER:session-start\n`
      + `SESSION_ID: ${sessionId}，PROJECT: ${project}\n`
      + `请通过 skill 工具加载 hypatia-memory 并执行 Session Startup：查询并内化 PROJECT=${project} `
      + `与全局 scope 的 rule / taboo 知识条目。若已存在 msg-${sessionId}-* 条目（会话恢复），`
      + `TURN 计数从现有最大序号继续。本会话后续的 [hypatia-memory] TRIGGER 信号均按该 skill 的协议处理。`,
      'hypatia-memory：会话启动，加载 rules/taboos',
    ))
  })

  // Claude Code `UserPromptSubmit` equivalent: fire on the first step of a
  // turn that carries a genuine user message.
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1 || !isRootSession(agent)) return decision

    const events = agent.session.events
    const start = events.findLastIndex(
      (event) => event.type === 'turn/start' && event.data.turn === turn,
    )
    if (start < 0) return decision
    const userEvent = events
      .slice(start + 1)
      .find((event) => event.type === 'user/message' && event.data.source.kind === 'user')
    if (!userEvent) return decision

    const sessionId = String(agent.session.id)
    const state = stateFor(sessionId)
    if (state.countedTurns.has(turn)) return decision
    state.countedTurns.add(turn)
    state.userTurns += 1

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
    if (EXPLICIT_MEMORY_RE.test(messageText(userEvent.data))) {
      lines.push(
        `TRIGGER:immediate —— 用户消息疑似包含显式“记住/忘记”请求，若确认请直接执行对应的语义记忆操作。`,
      )
    }
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        pluginMessage(lines.join('\n'), 'hypatia-memory：记录用户消息'),
      ],
    }
  })

  // Claude Code `Stop` equivalent: queue logging of the assistant reply; the
  // pending context is claimed at the next pre-step (or after resume).
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!isRootSession(agent)) return
    const sessionId = String(agent.session.id)
    const state = states.get(sessionId)
    if (!state || state.userTurns === 0) return
    agent.inject(pluginMessage(
      `[hypatia-memory] TRIGGER:log（assistant）\n`
      + `SESSION_ID: ${sessionId}，PROJECT: ${projectOf(agent)}\n`
      + `按 hypatia-memory skill 记录上一轮助手回复（msg-${sessionId}-<TURN>）并检查摘要级联；`
      + `这是后台记录任务，无需回复用户。`,
      'hypatia-memory：记录助手回复',
    ))
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config = {}) {
  if (!hypatiaAvailable()) {
    warn(ctx, '`hypatia` CLI not found on PATH — skills and memory bridge disabled. '
      + 'Install hypatia (https://github.com/tkliuxing/hypatia) and restart dsh to enable.')
    return
  }
  if (config.registerSkills !== false) registerSkills(ctx)
  if (config.memoryBridge !== false) {
    registerMemoryBridge(ctx, {
      extractInterval: Number.isSafeInteger(config.extractInterval) && config.extractInterval > 0
        ? config.extractInterval
        : 5,
    })
  }
}
