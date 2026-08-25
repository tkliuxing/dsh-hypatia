/**
 * The Hypatia CLI adapter: the single place this plugin runs a subprocess.
 *
 * This is host code, not a model-facing shell. Every invocation is a fixed
 * argv array executed with `shell: false` against one absolute binary path
 * resolved at startup. No caller anywhere in this plugin builds a command
 * string, and no model-supplied text ever reaches argv except as a positional
 * value the CLI treats as data.
 *
 * @module dsh-hypatia/adapter/cli
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import { ErrorCode, HypatiaError } from '../errors.js'
import { ResultKind, parseOutput } from './parse.js'

/** Grace period between SIGTERM and SIGKILL when enforcing a deadline. */
const KILL_GRACE_MS = 250

/**
 * Bounds how many Hypatia processes run at once.
 *
 * The default limit is 1, and that is a measured requirement rather than
 * caution. Every `hypatia` invocation constructs a `Lab` and opens *every*
 * registered shelf, and DuckDB takes an exclusive file lock on open - so
 * concurrent invocations collide even when they are pure reads and even when
 * they target different shelves. Measured against hypatia 0.1.4, four
 * concurrent `hypatia query` calls produced three failures:
 *
 *   Error: storage error: DuckDB error: IO Error: Could not set lock on file
 *   ".../data.duckdb": Conflicting lock is held in .../hypatia (PID ...)
 *
 * Raising the limit trades correctness for throughput and is only safe if no
 * other Hypatia process can touch the same shelves.
 *
 * Queue time counts against the caller's budget. `execFixed`'s deadline only
 * starts once a lane is free, so without this a 200ms recall waiting behind a
 * 10s write would block `agent/pre-step` for the whole 10s and never observe
 * its own timeout or its turn's AbortSignal.
 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    /** @type {Array<{resolve: () => void, reject: (error: Error) => void}>} */
    this.waiters = []
  }

  /** Wake the next waiter that is still interested. */
  #release() {
    this.waiters.shift()?.resolve()
  }

  #wait({ timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let timer = null
      const waiter = {
        resolve: () => { cleanup(); resolve() },
        reject: (error) => { cleanup(); reject(error) },
      }
      const abandon = (error) => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        waiter.reject(error)
      }
      const onAbort = () => abandon(
        new HypatiaError(ErrorCode.CANCELLED, 'cancelled while queued for a hypatia lane'),
      )
      function cleanup() {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      if (signal?.aborted) {
        reject(new HypatiaError(ErrorCode.CANCELLED, 'cancelled before queueing for a hypatia lane'))
        return
      }
      this.waiters.push(waiter)
      if (Number.isFinite(timeoutMs)) {
        // Not `dispatched`: nothing was spawned, so this stays a plain retry
        // rather than an outcome reconciliation has to go and check.
        timer = setTimeout(() => abandon(new HypatiaError(ErrorCode.TIMEOUT,
          `timed out after ${timeoutMs}ms waiting for a free hypatia lane`)), timeoutMs)
        timer.unref?.()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async run(fn, { timeoutMs, signal } = {}) {
    if (this.active >= this.limit) {
      await this.#wait({ timeoutMs, signal })
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.#release()
    }
  }
}

/** Find an executable named `name` on PATH, returning its absolute path. */
export function resolveOnPath(name, env = process.env) {
  const parts = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of parts) {
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

/** Compare dotted numeric versions. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/**
 * Run one process to completion with a hard deadline and byte caps.
 *
 * Resolves with raw output; classification is the caller's job. On timeout or
 * abort the child is terminated and awaited, so no orphan survives the call.
 *
 * @param {string} binary absolute path
 * @param {string[]} argv fixed argument vector
 * @param {{timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal}} options
 */
export function execFixed(binary, argv, { timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HypatiaError(ErrorCode.CANCELLED, 'cancelled before dispatch'))
      return
    }

    const child = spawn(binary, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    let settled = false
    let overflow = false
    let timedOut = false
    let killTimer = null

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    deadline.unref?.()

    const onAbort = () => {
      terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(deadline)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const collect = (stream, key) => {
      stream.on('data', (chunk) => {
        sizes[key] += chunk.byteLength
        if (sizes[key] > maxOutputBytes) {
          if (!overflow) {
            overflow = true
            terminate()
          }
          return
        }
        chunks[key].push(chunk)
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    const settle = (fn) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    child.on('error', (cause) => {
      settle(() => reject(new HypatiaError(ErrorCode.BINARY, `failed to spawn ${binary}`, { cause })))
    })

    // 'close' (not 'exit') guarantees the stdio streams are drained.
    child.on('close', (code) => {
      settle(() => {
        if (overflow) {
          reject(new HypatiaError(ErrorCode.OUTPUT_OVERFLOW,
            `CLI output exceeded ${maxOutputBytes} bytes`, { dispatched: true }))
          return
        }
        if (timedOut) {
          reject(new HypatiaError(ErrorCode.TIMEOUT, `CLI exceeded ${timeoutMs}ms`, { dispatched: true }))
          return
        }
        if (signal?.aborted) {
          reject(new HypatiaError(ErrorCode.CANCELLED, 'cancelled during execution', { dispatched: true }))
          return
        }
        resolve({
          code,
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        })
      })
    })
  })
}

/**
 * Typed access to the Hypatia CLI.
 *
 * Construct with {@link createAdapter}, which resolves the binary and verifies
 * its version before any memory operation is enabled.
 */
export class HypatiaAdapter {
  /**
   * @param {{binary: string, version: string, shelf: string, timeoutMs: number,
   *   maxOutputBytes: number, maxConcurrentReads: number}} options
   */
  constructor({ binary, version, shelf, timeoutMs, maxOutputBytes, maxConcurrentReads }) {
    this.binary = binary
    this.version = version
    this.defaultShelf = shelf
    this.timeoutMs = timeoutMs
    this.maxOutputBytes = maxOutputBytes
    /**
     * One lane for reads *and* mutations. Splitting them would not help: the
     * DuckDB lock is taken on open, so a read and a write collide exactly as
     * two writes do.
     */
    this.lane = new Semaphore(maxConcurrentReads)
  }

  /**
   * Run one command on the shared lane.
   *
   * The caller's `timeoutMs` is the budget for the *whole* operation, queue
   * wait included, so a deadline-bound caller such as recall cannot be parked
   * behind an unrelated write for longer than it asked for.
   */
  #run(argv, { timeoutMs, signal } = {}) {
    const budgetMs = timeoutMs ?? this.timeoutMs
    const startedAt = Date.now()
    return this.lane.run(async () => {
      const remaining = budgetMs - (Date.now() - startedAt)
      if (remaining <= 0) {
        throw new HypatiaError(ErrorCode.TIMEOUT, `CLI budget of ${budgetMs}ms elapsed while queued`)
      }
      const raw = await execFixed(this.binary, argv, {
        timeoutMs: remaining,
        maxOutputBytes: this.maxOutputBytes,
        signal,
      })
      return parseOutput(raw)
    }, { timeoutMs: budgetMs, signal })
  }

  /** Run a read-shaped command. */
  read(argv, options = {}) {
    return this.#run(argv, options)
  }

  /** Run a mutation. Shares the read lane; see {@link Semaphore}. */
  mutate(argv, options = {}) {
    return this.#run(argv, options)
  }

  /** Append `-s <shelf>` using the default when the caller did not choose. */
  #shelfArgs(shelf) {
    return ['-s', shelf ?? this.defaultShelf]
  }

  // --- reads ------------------------------------------------------------

  /** Fetch one knowledge entry by exact name. Returns null when absent. */
  async knowledgeGet(name, { shelf, signal, timeoutMs } = {}) {
    const result = await this.read(['knowledge-get', name, ...this.#shelfArgs(shelf)], { signal, timeoutMs })
    if (result.kind === ResultKind.DATA) return result.data
    if (result.kind === ResultKind.EMPTY) return null
    throw cliError(result, `knowledge-get ${name}`)
  }

  /**
   * Run a JSE query. The program is always built by host code from a fixed
   * template - never assembled from model output.
   */
  async query(jse, { shelf, signal, timeoutMs } = {}) {
    const result = await this.read(['query', JSON.stringify(jse), ...this.#shelfArgs(shelf)], { signal, timeoutMs })
    if (result.kind === ResultKind.DATA) return Array.isArray(result.data) ? result.data : [result.data]
    if (result.kind === ResultKind.EMPTY) return []
    throw cliError(result, 'query')
  }

  /** Full-text search. `text` is user/model data passed as a positional value. */
  async search(text, { shelf, limit = 20, signal, timeoutMs } = {}) {
    const result = await this.read(
      ['search', text, '--limit', String(limit), ...this.#shelfArgs(shelf)],
      { signal, timeoutMs },
    )
    if (result.kind === ResultKind.DATA) return Array.isArray(result.data) ? result.data : []
    if (result.kind === ResultKind.EMPTY) return []
    throw cliError(result, 'search')
  }

  /**
   * Vector similarity. Best-effort: this shelf may have no embedding provider,
   * and Hypatia's top-K cannot pre-filter by scope, so callers must filter
   * results against the ledger afterwards.
   */
  async similar(text, { shelf, limit = 20, signal, timeoutMs } = {}) {
    const result = await this.read(
      ['similar', text, '--limit', String(limit), ...this.#shelfArgs(shelf)],
      { signal, timeoutMs },
    )
    if (result.kind === ResultKind.DATA) return Array.isArray(result.data) ? result.data : []
    if (result.kind === ResultKind.EMPTY) return []
    throw cliError(result, 'similar')
  }

  // --- mutations --------------------------------------------------------

  /**
   * Create a knowledge entry under a host-generated stable name.
   * A duplicate key is reported as a structured CONFLICT so the caller can
   * read back and decide "already applied" versus "someone else's payload".
   */
  async knowledgeCreate({ name, data, tags = [], scopes = [], shelf, signal, timeoutMs }) {
    const result = await this.mutate([
      'knowledge-create', name,
      '-d', data,
      '-t', tags.join(','),
      '--scopes', scopes.join(','),
      ...this.#shelfArgs(shelf),
    ], { shelf, signal, timeoutMs })
    if (result.kind === ResultKind.ACK) return { ok: true, text: result.text }
    throw cliError(result, `knowledge-create ${name}`)
  }

  async knowledgeDelete(name, { shelf, signal, timeoutMs } = {}) {
    const result = await this.mutate(
      ['knowledge-delete', name, ...this.#shelfArgs(shelf)],
      { shelf, signal, timeoutMs },
    )
    if (result.kind === ResultKind.ACK) return { ok: true, text: result.text }
    throw cliError(result, `knowledge-delete ${name}`)
  }

  async statementCreate({ subject, predicate, object, data = '', scopes = [], shelf, signal, timeoutMs }) {
    const result = await this.mutate([
      'statement-create', subject, predicate, object,
      '-d', data,
      '--scopes', scopes.join(','),
      ...this.#shelfArgs(shelf),
    ], { shelf, signal, timeoutMs })
    if (result.kind === ResultKind.ACK) return { ok: true, text: result.text }
    throw cliError(result, 'statement-create')
  }

  async statementDelete({ subject, predicate, object, shelf, signal, timeoutMs }) {
    const result = await this.mutate(
      ['statement-delete', subject, predicate, object, ...this.#shelfArgs(shelf)],
      { shelf, signal, timeoutMs },
    )
    if (result.kind === ResultKind.ACK) return { ok: true, text: result.text }
    throw cliError(result, 'statement-delete')
  }
}

/** Wrap a classified CLI failure in a structured error. */
function cliError(result, what) {
  return new HypatiaError(ErrorCode.CLI_ERROR, `${what}: ${result.text}`, {
    dispatched: true,
    detail: { failure: result.failure ?? 'other' },
  })
}

/**
 * Resolve the binary, verify its version, and build the adapter.
 *
 * Returns `null` (after warning) when Hypatia is unusable, so the caller can
 * degrade instead of throwing during plugin load.
 *
 * @param {{config: object, warn: (msg: string) => void}} deps
 * @returns {Promise<HypatiaAdapter|null>}
 */
export async function createAdapter({ config, warn }) {
  const { adapter: settings } = config
  // A pin that cannot be honoured is reported, never silently swapped for
  // whatever `hypatia` happens to be first on PATH: an operator pinning a
  // vetted binary would otherwise run a different one and never know.
  if (settings.binaryPath && !existsSync(settings.binaryPath)) {
    warn(`configured adapter.binaryPath ${settings.binaryPath} does not exist; `
      + 'falling back to the first `hypatia` on PATH.')
  }
  const binary = settings.binaryPath && isAbsolute(settings.binaryPath) && existsSync(settings.binaryPath)
    ? settings.binaryPath
    : resolveOnPath('hypatia')

  if (!binary) {
    warn('`hypatia` CLI not found on PATH - memory features disabled. '
      + 'Install hypatia (https://github.com/MarchLiu/hypatia) and restart dsh.')
    return null
  }

  let version = 'unknown'
  try {
    const probe = await execFixed(binary, ['--version'], {
      timeoutMs: Math.min(settings.timeoutMs, 5_000),
      maxOutputBytes: 64 * 1024,
    })
    version = (probe.stdout.trim().match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? 'unknown'
  } catch (error) {
    warn(`could not determine hypatia version (${error.message}) - memory features disabled`)
    return null
  }

  if (settings.requireVersionCheck) {
    if (version === 'unknown') {
      warn('hypatia reported no parseable version - memory features disabled. '
        + 'Set adapter.requireVersionCheck: false to proceed anyway.')
      return null
    }
    if (compareVersions(version, settings.minVersion) < 0) {
      warn(`hypatia ${version} is older than the supported ${settings.minVersion} `
        + '- memory features disabled because the CLI contract may differ.')
      return null
    }
  }

  return new HypatiaAdapter({
    binary,
    version,
    shelf: settings.shelf,
    timeoutMs: settings.timeoutMs,
    maxOutputBytes: settings.maxOutputBytes,
    maxConcurrentReads: settings.maxConcurrentReads,
  })
}
