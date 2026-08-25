/**
 * Phase 1 acceptance gates for the CLI adapter.
 *
 * Two things are load-bearing here. First, output classification: the real
 * CLI reports failure with exit 0 and success with human text, so exit status
 * alone is not a signal. Second, process hygiene: a deadline or cancellation
 * must leave no child alive.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { ErrorCode } from '../src/errors.js'
import { CliFailure, ResultKind, classifyFailure, normalizeKnowledge, parseOutput } from '../src/adapter/parse.js'
import { HypatiaAdapter, compareVersions, execFixed, resolveOnPath } from '../src/adapter/cli.js'
import { normalizeConfig } from '../src/config.js'

describe('output classification', () => {
  it('treats an Error line as failure even when the process exits 0', () => {
    // Observed from `hypatia similar` with no embedding provider.
    const result = parseOutput({ stdout: 'Error: model unavailable: no embedding provider configured', stderr: '', code: 0 })

    assert.equal(result.kind, ResultKind.ERROR)
    assert.equal(result.failure, CliFailure.MODEL_UNAVAILABLE)
  })

  it('treats a human not-found line as empty, not as failure', () => {
    // Observed from `hypatia knowledge-get` on a missing name.
    const missing = parseOutput({ stdout: "Knowledge 'dshmem:v1:x:y' not found.", stderr: '', code: 0 })
    const noResults = parseOutput({ stdout: 'No results found.', stderr: '', code: 0 })

    assert.equal(missing.kind, ResultKind.EMPTY)
    assert.equal(noResults.kind, ResultKind.EMPTY)
  })

  it('classifies a duplicate key and a missing delete distinctly', () => {
    const duplicate = parseOutput({
      stdout: '',
      stderr: 'Error: storage error: DuckDB error: Constraint Error: Duplicate key "name: x" violates primary key constraint.',
      code: 1,
    })
    const notFound = parseOutput({ stdout: '', stderr: "Error: not found: knowledge 'x'", code: 1 })

    assert.equal(duplicate.failure, CliFailure.DUPLICATE)
    assert.equal(notFound.failure, CliFailure.NOT_FOUND)
  })

  it('reads a success acknowledgement as an ack', () => {
    const result = parseOutput({ stdout: 'Created knowledge: dshmem:v1:a:b', stderr: '', code: 0 })
    assert.equal(result.kind, ResultKind.ACK)
  })

  it('parses JSON payloads and rejects malformed JSON explicitly', () => {
    const ok = parseOutput({ stdout: '[{"name":"x"}]', stderr: '', code: 0 })
    assert.equal(ok.kind, ResultKind.DATA)
    assert.deepEqual(ok.data, [{ name: 'x' }])

    assert.throws(
      () => parseOutput({ stdout: '[{"name":', stderr: '', code: 0 }),
      (error) => error.code === ErrorCode.PARSE,
    )
  })

  it('fails a non-zero exit that printed no Error line', () => {
    const result = parseOutput({ stdout: '', stderr: 'segfault', code: 139 })
    assert.equal(result.kind, ResultKind.ERROR)
  })

  it('classifies a shelf error', () => {
    assert.equal(classifyFailure("Error: shelf error: shelf 'x' is not connected"), CliFailure.SHELF)
  })

  it('classifies a DuckDB lock conflict distinctly from other storage errors', () => {
    // Measured against hypatia 0.1.4: concurrent invocations produce this.
    const text = 'Error: storage error: DuckDB error: IO Error: Could not set lock on file '
      + '"/x/data.duckdb": Conflicting lock is held in /usr/bin/hypatia (PID 1) by user u.'
    assert.equal(classifyFailure(text), CliFailure.LOCKED)
    assert.equal(parseOutput({ stdout: '', stderr: text, code: 1 }).failure, CliFailure.LOCKED)
  })
})

describe('invocation concurrency', () => {
  it('defaults to one process at a time, because DuckDB locks on open', () => {
    // Not a tuning choice: four concurrent `hypatia query` calls against
    // hypatia 0.1.4 produced three "Conflicting lock is held" failures, and
    // pure reads collide exactly as writes do.
    assert.equal(normalizeConfig({}).adapter.maxConcurrentReads, 1)
  })

  it('serializes reads and mutations through the same lane', async () => {
    const adapter = new HypatiaAdapter({
      binary: '/bin/true',
      version: '0.1.4',
      shelf: 'default',
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      maxConcurrentReads: 1,
    })

    let active = 0
    let peak = 0
    // Exercise the shared lane directly rather than spawning real processes.
    const work = () => adapter.lane.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
    })

    await Promise.all([work(), work(), work(), work()])

    assert.equal(peak, 1, 'the adapter must never run two Hypatia processes at once')
  })

  it('never lets a configured limit fall below one', () => {
    assert.equal(normalizeConfig({ adapter: { maxConcurrentReads: 0 } }).adapter.maxConcurrentReads, 1)
  })
})

describe('knowledge normalization', () => {
  it('decodes the JSON stored in content.data', () => {
    const normalized = normalizeKnowledge({
      name: 'dshmem:v1:a:b',
      created_at: '2026-08-24 10:09:01',
      content: { data: '{"title":"t"}', tags: ['dshmem'], scopes: ['proj-a'] },
    })

    assert.deepEqual(normalized.parsed, { title: 't' })
    assert.deepEqual(normalized.scopes, ['proj-a'])
  })

  it('surfaces non-JSON data verbatim rather than guessing', () => {
    const normalized = normalizeKnowledge({ name: 'x', content: { data: 'plain text' } })

    assert.equal(normalized.parsed, null)
    assert.equal(normalized.data, 'plain text')
  })
})

describe('version comparison', () => {
  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('0.1.4', '0.1.4'), 0)
    assert.equal(compareVersions('0.1.3', '0.1.4'), -1)
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
    assert.equal(compareVersions('1.0', '1.0.0'), 0)
  })
})

describe('process hygiene', () => {
  it('resolves an executable on PATH and rejects a missing one', () => {
    assert.ok(resolveOnPath('node'))
    assert.equal(resolveOnPath('definitely-not-a-real-binary-xyz'), null)
  })

  it('terminates a process that exceeds its deadline, leaving no child alive', async () => {
    const marker = `dsh-hypatia-deadline-${process.pid}`
    await assert.rejects(
      () => execFixed('/bin/sh', ['-c', `# ${marker}\nsleep 30`], { timeoutMs: 200, maxOutputBytes: 4096 }),
      (error) => error.code === ErrorCode.TIMEOUT && error.dispatched === true,
    )
    assert.equal(countProcesses(marker), 0, 'a timed-out child must not survive')
  })

  it('terminates on abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100).unref()

    await assert.rejects(
      () => execFixed('/bin/sh', ['-c', 'sleep 30'], {
        timeoutMs: 30_000, maxOutputBytes: 4096, signal: controller.signal,
      }),
      (error) => error.code === ErrorCode.CANCELLED,
    )
  })

  it('rejects before dispatch when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      () => execFixed('/bin/echo', ['hi'], { timeoutMs: 1000, maxOutputBytes: 4096, signal: controller.signal }),
      (error) => error.code === ErrorCode.CANCELLED && error.dispatched === false,
    )
  })

  it('caps oversized output instead of buffering it all', async () => {
    await assert.rejects(
      () => execFixed('/bin/sh', ['-c', 'yes abcdefghij | head -c 400000'], {
        timeoutMs: 20_000, maxOutputBytes: 2048,
      }),
      (error) => error.code === ErrorCode.OUTPUT_OVERFLOW,
    )
  })

  it('reports a spawn failure as a binary error', async () => {
    await assert.rejects(
      () => execFixed('/definitely/not/here', [], { timeoutMs: 1000, maxOutputBytes: 1024 }),
      (error) => error.code === ErrorCode.BINARY,
    )
  })

  it('passes arguments as argv, never through a shell', async () => {
    // With `shell: true` this would run `id` and produce different output.
    const result = await execFixed('/bin/echo', ['$(id -u); rm -rf /tmp/nope'], {
      timeoutMs: 5000, maxOutputBytes: 4096,
    })

    assert.equal(result.stdout.trim(), '$(id -u); rm -rf /tmp/nope')
  })
})

/** Count live processes whose command line contains `marker`. */
function countProcesses(marker) {
  try {
    const output = execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf8' })
    return output.split('\n').filter((line) => line.includes(marker) && !line.includes('ps -Ao')).length
  } catch {
    return 0
  }
}

/**
 * Regressions from the max-effort review.
 */
describe('failure classification order', () => {
  it('does not read a failed invocation as an empty result', () => {
    // `/^No .* found\.?$/i` is broad enough to swallow a real failure, and
    // "the query matched nothing" would make recall return zero entries with
    // no `degraded` note while the shelf was actually broken.
    for (const stdout of ["No shelf 'default' found.", 'No matching index found']) {
      const result = parseOutput({ stdout, stderr: '', code: 1 })
      assert.equal(result.kind, ResultKind.ERROR, stdout)
      assert.ok(result.failure, 'a failure classification must be present for cliError')
    }
  })

  it('still reads a zero-exit "not found" as empty', () => {
    assert.equal(parseOutput({ stdout: "Knowledge 'x' not found.", stderr: '', code: 0 }).kind, ResultKind.EMPTY)
    assert.equal(parseOutput({ stdout: 'No results found.', stderr: '', code: 0 }).kind, ResultKind.EMPTY)
  })
})

describe('lane admission is bounded', () => {
  /** An adapter whose lane is held by one long call. */
  function occupiedLane() {
    const adapter = new HypatiaAdapter({
      binary: '/bin/true',
      version: '0.1.4',
      shelf: 'default',
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      maxConcurrentReads: 1,
    })
    const holder = adapter.lane.run(() => new Promise((resolve) => setTimeout(resolve, 200)))
    return { adapter, holder }
  }

  it('counts queue time against the caller\'s timeout', async () => {
    const { adapter, holder } = occupiedLane()

    // execFixed's deadline only starts once a lane is free, so without this the
    // recall budget would bound the subprocess and not the wait in front of it.
    await assert.rejects(
      () => adapter.read(['knowledge-get', 'x'], { timeoutMs: 20 }),
      (error) => error.code === ErrorCode.TIMEOUT && error.dispatched === false,
    )
    await holder
  })

  it('observes an abort raised while still queued', async () => {
    const { adapter, holder } = occupiedLane()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)

    await assert.rejects(
      () => adapter.read(['knowledge-get', 'x'], { signal: controller.signal }),
      (error) => error.code === ErrorCode.CANCELLED,
    )
    await holder
  })

  it('still serializes when callers wait their turn', async () => {
    const { adapter, holder } = occupiedLane()
    await holder

    let active = 0
    let peak = 0
    const work = () => adapter.lane.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })
    await Promise.all([work(), work(), work()])

    assert.equal(peak, 1)
  })
})
