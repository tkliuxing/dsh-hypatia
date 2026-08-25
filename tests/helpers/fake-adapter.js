/**
 * An in-memory stand-in for the Hypatia CLI adapter.
 *
 * It reproduces the CLI's actual quirks rather than an idealized version:
 * a duplicate create fails, a missing get returns null, and a missing delete
 * raises a not-found failure. Faults are injected per call so tests can drive
 * the uncertain, conflict, and retry paths deterministically.
 */

import { ErrorCode, HypatiaError } from '../../src/errors.js'
import { CliFailure } from '../../src/adapter/parse.js'

export class FakeAdapter {
  constructor() {
    this.version = '0.1.4-fake'
    /** @type {Map<string, {content: {data: string, tags: string[], scopes: string[]}, name: string}>} */
    this.knowledge = new Map()
    /** @type {Set<string>} */
    this.statements = new Set()
    /** Queued faults keyed by operation name, consumed one per call. */
    this.faults = new Map()
    this.calls = []
  }

  /** Queue one fault for the next call to `op`. */
  failNext(op, error) {
    const queue = this.faults.get(op) ?? []
    queue.push(error)
    this.faults.set(op, queue)
  }

  #maybeFail(op) {
    const queue = this.faults.get(op)
    if (queue?.length) throw queue.shift()
  }

  async knowledgeGet(name) {
    this.calls.push(['knowledgeGet', name])
    this.#maybeFail('knowledgeGet')
    return this.knowledge.get(name) ?? null
  }

  async knowledgeCreate({ name, data, tags = [], scopes = [] }) {
    this.calls.push(['knowledgeCreate', name])
    this.#maybeFail('knowledgeCreate')
    if (this.knowledge.has(name)) {
      throw new HypatiaError(ErrorCode.CLI_ERROR, `knowledge-create ${name}: Duplicate key`, {
        dispatched: true, detail: { failure: CliFailure.DUPLICATE },
      })
    }
    this.knowledge.set(name, { name, content: { data, tags, scopes, format: 'markdown' } })
    return { ok: true, text: `Created knowledge: ${name}` }
  }

  async knowledgeDelete(name) {
    this.calls.push(['knowledgeDelete', name])
    this.#maybeFail('knowledgeDelete')
    if (!this.knowledge.has(name)) {
      throw new HypatiaError(ErrorCode.CLI_ERROR, `knowledge-delete ${name}: not found`, {
        dispatched: true, detail: { failure: CliFailure.NOT_FOUND },
      })
    }
    this.knowledge.delete(name)
    return { ok: true, text: `Deleted knowledge: ${name}` }
  }

  async statementCreate({ subject, predicate, object }) {
    this.calls.push(['statementCreate', `${subject},${predicate},${object}`])
    this.#maybeFail('statementCreate')
    const triple = `${subject},${predicate},${object}`
    if (this.statements.has(triple)) {
      throw new HypatiaError(ErrorCode.CLI_ERROR, 'Duplicate key', {
        dispatched: true, detail: { failure: CliFailure.DUPLICATE },
      })
    }
    this.statements.add(triple)
    return { ok: true }
  }

  async statementDelete({ subject, predicate, object }) {
    this.calls.push(['statementDelete', `${subject},${predicate},${object}`])
    this.#maybeFail('statementDelete')
    const triple = `${subject},${predicate},${object}`
    if (!this.statements.has(triple)) {
      throw new HypatiaError(ErrorCode.CLI_ERROR, 'not found', {
        dispatched: true, detail: { failure: CliFailure.NOT_FOUND },
      })
    }
    this.statements.delete(triple)
    return { ok: true }
  }

  async search(text) {
    this.calls.push(['search', text])
    this.#maybeFail('search')
    return [...this.knowledge.values()].map((row) => ({
      key: row.name, catalog: 'knowledge', rank: -1, content: row.content.data,
    }))
  }

  async similar(text) {
    this.calls.push(['similar', text])
    this.#maybeFail('similar')
    return []
  }
}

/** Minimal cordis-like context for wiring tests. */
export class FakeContext {
  constructor() {
    this.handlers = new Map()
    this.warnings = []
    this.registeredTools = new Map()
    this.tools = {
      register: (definition) => {
        this.registeredTools.set(definition.name, definition)
        return () => this.registeredTools.delete(definition.name)
      },
    }
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      this.handlers.set(event, current.filter((entry) => entry !== handler))
    }
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  logger() {
    return { warn: (message) => this.warnings.push(message) }
  }
}
