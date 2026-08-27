/**
 * dsh-hypatia - long-term memory for DeepSeek Harness, backed by Hypatia.
 *
 * The plugin owns lifecycle integration, memory authorization, durable
 * operation state, scope derivation, provenance, recall budgets, validation,
 * retries, and observability. Hypatia stays an unmodified external semantic
 * store reached through its installed CLI, and DSH session persistence stays
 * the source of truth for raw conversation history.
 *
 * Wiring only lives here; the pieces are:
 *
 *   src/policy.js        memory capabilities, independent of the file sandbox
 *   src/identity.js      project scope, stable names, operation IDs, provenance
 *   src/ledger/          the plugin-owned SQLite control plane
 *   src/adapter/         the one place a subprocess is spawned
 *   src/mutations.js     intent -> CLI -> read-back verification -> receipt
 *   src/recall.js        same-request recall inside `agent/pre-step`
 *   src/retry-driver.js  the in-session drain for the retry queue
 *   src/tools.js         the narrow `memory_*` tools, replacing model Bash
 *   src/ingest/          idempotent ingestion of DSH compaction summaries
 *
 * See GOAL.md for the architecture this implements and the limits it refuses
 * to overstate.
 *
 * @module dsh-hypatia
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAdapter } from './src/adapter/cli.js'
import { normalizeConfig } from './src/config.js'
import { deriveProjectIdentity } from './src/identity.js'
import { registerCompactionIngest } from './src/ingest/compaction.js'
import { openLedger } from './src/ledger/ledger.js'
import { MutationCoordinator } from './src/mutations.js'
import { Capability, createMemoryPolicy } from './src/policy.js'
import { RecallService } from './src/recall.js'
import { createRetryDriver } from './src/retry-driver.js'
import { registerSkills } from './src/skills.js'
import { registerMemoryTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics and message provenance. */
export const name = 'dsh-hypatia'

/**
 * Services that must exist before this plugin activates.
 *
 * Must stay a flat array of service names. Cordis reads the normalized form
 * with `Object.keys(fiber.inject)`, so an object like
 * `{required: [...], optional: [...]}` is read as two services literally named
 * "required" and "optional" - which never resolve, leaving the entry pending
 * and failing the whole profile boot with:
 *
 *   dsh-hypatia: pending (waiting for services: required, optional)
 *
 * Keep this list to services every profile really has. `tools` and
 * `sandboxPolicy` are deliberately absent: a missing service here is a hard
 * boot failure for the entire profile, whereas both of those degrade cleanly
 * (tools warn and are skipped).
 */
export const inject = ['skills', 'agents']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PLUGIN_DIR, 'skills')

/** Best-effort logging that never breaks plugin load. */
function makeWarn(ctx) {
  return (message) => {
    try {
      ctx.logger(name).warn(message)
    } catch {
      console.warn(`[${name}] ${message}`)
    }
  }
}

/** Whether this session is a top-level user session. */
function isRootSession(agent) {
  return agent?.session?.header?.origin !== 'subagent'
}

/** Extract plain text from a message's content blocks. */
function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * One recall message. Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm`,
 * inlined so this package needs no runtime dependency on harness packages - a
 * `dsh plugin add <dir>` link resolves imports from its real path, where
 * in-box harness packages are not reachable.
 *
 * `form: 'recall'` marks it as retrieved reference context rather than an
 * instruction or a notice.
 */
function recallMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'recall' },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig cordis `config:` row
 */
export async function apply(ctx, rawConfig = {}) {
  const warn = makeWarn(ctx)
  const config = normalizeConfig(rawConfig)

  if (config.registerSkills) {
    try {
      registerSkills(ctx, { skillsDir: SKILLS_DIR, warn })
    } catch (error) {
      warn(`skill registration failed: ${error.message}`)
    }
  }

  if (config.extraction.requested) {
    warn('extraction.enabled is not available: background model-assisted extraction is '
      + 'gated NO-GO in GOAL.md until the fault and security tests for Phases 0-2 pass.')
  }

  // --- removed compatibility mode --------------------------------------
  //
  // Reported before the host path's gates, not after: the configurations an
  // operator would have paired the bridge with - `memory.preset: 'disabled'`,
  // or a host without the CLI - are exactly the ones that return early below,
  // so a notice placed after them would never reach the deployment that needs
  // it. The tools are the whole memory path now.
  if (config.legacyBridge.requested) {
    warn('legacyBridge.enabled is set but the deprecated TRIGGER/Bash memory protocol has '
      + 'been removed. Memory now runs entirely through the host adapter and the memory_* '
      + 'tools; drop the key from this profile.')
  }

  const policy = createMemoryPolicy({ ...config.memory, warn })
  if (!policy.enabled) {
    warn('memory policy grants no capabilities - skills are registered, memory is inactive.')
    return
  }

  // The adapter is the gate: without a usable CLI there is no memory backend,
  // and the plugin degrades to skills rather than failing the session.
  const adapter = await createAdapter({ config, warn })
  if (!adapter) return

  let ledger
  try {
    ledger = openLedger(config.state.file)
  } catch (error) {
    warn(`could not open the control ledger at ${config.state.file}: ${error.message} `
      + '- memory is inactive.')
    return
  }

  const shelf = config.adapter.shelf

  // Drains the retry queue inside the session that scheduled it; the timer's
  // lifecycle is tied to the `ctx.effect` teardown below.
  const retryDriver = createRetryDriver({
    enabled: config.reconcile.retryDriver,
    canReconcile: () => policy.can(Capability.RECONCILE),
    reconcile: () => mutations.reconcile(),
    warn,
  })

  const mutations = new MutationCoordinator({
    ledger,
    adapter,
    shelf,
    warn,
    batchSize: config.reconcile.batchSize,
    onRetryScheduled: (delayMs) => retryDriver.arm(delayMs),
  })
  const recall = new RecallService({ ledger, adapter, policy, config, warn })

  /** Host-derived scope for an agent. Never model-supplied. */
  const scopeOf = (agent) => deriveProjectIdentity({
    cwd: agent?.session?.header?.cwd ?? null,
    configuredProjectId: config.projectId,
  }).scope

  // Settle anything a previous process left mid-flight. Deliberately not
  // awaited: startup must not block on subprocesses. Gated by the same
  // capability as `memory_reconcile`, so the automatic and manual paths to one
  // operation cannot disagree about who may run it.
  if (policy.can(Capability.RECONCILE)) {
    mutations.reconcile()
      .then((summary) => {
        if (summary.checked > 0) {
          warn(`startup reconciliation: ${JSON.stringify(summary)}`)
        }
      })
      .catch((error) => warn(`startup reconciliation failed: ${error.message}`))
  }

  // --- same-request recall ---------------------------------------------
  //
  // Runs after downstream listeners so their decision is preserved, and
  // appends at most one message to the accepted decision.

  /** Scopes whose recall coverage ceiling has already been reported. */
  const coverageWarned = new Set()
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted) return decision
    if (step !== 1 || !isRootSession(agent)) return decision
    if (!config.recall.enabled || !policy.can(Capability.READ_RECALL)) return decision

    try {
      // Only direct human text seeds the query. Plugin notices, tool results,
      // and prior recall are excluded so recall cannot feed on itself.
      const queryText = messages
        .filter((message) => message.source?.kind === 'user')
        .map(messageText)
        .join('\n')
        .trim()
      if (!queryText) return decision

      const scope = scopeOf(agent)
      const { entries, degraded, coverage } = await recall.recall({ scope, shelf, queryText, signal })
      if (degraded) warn(`recall degraded: ${degraded}`)
      // A coverage ceiling is not a fault, so it must not be reported as one -
      // but it must be reported. Once per scope per process: this runs on every
      // first step, and a per-turn line would be ignored as noise by the time
      // it mattered.
      if (coverage?.truncated && !coverageWarned.has(scope)) {
        coverageWarned.add(scope)
        warn(`recall scored the ${coverage.considered} most recent of ${coverage.totalInScope} `
          + `memories in ${scope}; older ones reach the model only through the hypatia `
          + 'full-text supplement. Raise `recall.candidatePool` to widen the pool.')
      }
      if (entries.length === 0) return decision

      return {
        kind: 'enter',
        messages: [...decision.messages, recallMessage(recall.renderText(entries, { scope }))],
      }
    } catch (error) {
      // Recall never fails a user's turn.
      warn(`recall failed open: ${error.message}`)
      return decision
    }
  })

  // --- per-agent installation ------------------------------------------

  const installed = new Map()

  const installPerAgent = () => ctx.on('agent/created', ({ agent }) => {
    if (installed.has(agent) || !isRootSession(agent)) return
    const roots = ctx.agents?.roots?.()
    if (Array.isArray(roots) && !roots.includes(agent)) return

    const scope = scopeOf(agent)
    const header = agent.session?.header ?? {}
    const disposers = []

    // `tools` is not injected (see `inject` above), so its absence must be
    // reported rather than silently costing the model every memory tool.
    if (config.registerTools && !agent.ctx?.tools) {
      warn('the `tools` service is unavailable for this agent - memory_search, '
        + 'memory_remember, and memory_forget_* are not registered. Recall and '
        + 'compaction ingestion still work.')
    }

    if (config.registerTools && agent.ctx?.tools) {
      disposers.push(registerMemoryTools({
        agentCtx: agent.ctx,
        ledger,
        adapter,
        mutations,
        policy,
        config,
        scope,
        shelf,
        sessionId: String(header.id ?? agent.session?.id ?? ''),
        sessionCreatedAt: header.createdAt ?? 0,
        warn,
      }))
    }

    if (config.ingest.compaction) {
      disposers.push(registerCompactionIngest({
        ctx, agent, ledger, mutations, policy, scope, shelf, warn,
      }))
    }

    installed.set(agent, () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A registry already torn down is not worth surfacing.
        }
      }
    })
  })

  const trackDisposal = () => ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })

  // Cordis owns teardown through `effect`. Registering the agent listeners
  // inside it means unloading the plugin also closes the ledger and disposes
  // every per-agent registration, with no separate dispose bookkeeping.
  const installMemory = () => {
    const stopCreated = installPerAgent()
    const stopDisposed = trackDisposal()
    return () => {
      stopCreated()
      stopDisposed()
      retryDriver.stop()
      for (const dispose of installed.values()) dispose()
      installed.clear()
      try {
        ledger.close()
      } catch {
        // Closing an already-closed database is not worth surfacing.
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(installMemory, 'dsh-hypatia.memory()')
  } else {
    // No effect seam (older host or a test double): still install, and accept
    // that teardown is the process's responsibility.
    installMemory()
  }
}
