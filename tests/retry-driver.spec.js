/**
 * The in-session retry drain.
 *
 * What matters here is not that a timer exists but that its lifecycle is
 * honest: it must not run for a deployment that may not reconcile, must not
 * multiply, must not survive teardown, and must not hold the process open.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RETRY_DRAIN_SLACK_MS, createRetryDriver } from '../src/retry-driver.js'

/** A controllable stand-in for the global timer functions. */
function fakeTimers() {
  const scheduled = new Map()
  let nextId = 1
  return {
    scheduled,
    setTimeout(fn, delayMs) {
      const id = nextId
      nextId += 1
      scheduled.set(id, { fn, delayMs, unrefs: 0 })
      return { id, unref() { scheduled.get(id).unrefs += 1 } }
    },
    clearTimeout(handle) {
      scheduled.delete(handle?.id)
    },
    /** Fire every pending timer, as the event loop would at its due time. */
    async fire() {
      for (const [id, entry] of [...scheduled]) {
        scheduled.delete(id)
        entry.fn()
      }
      await new Promise((resolve) => { process.nextTick(resolve) })
      await new Promise((resolve) => { process.nextTick(resolve) })
    },
  }
}

function setup({ enabled = true, canReconcile = () => true, reconcile } = {}) {
  const timers = fakeTimers()
  const warnings = []
  const calls = []
  const driver = createRetryDriver({
    enabled,
    canReconcile,
    reconcile: reconcile ?? (async () => {
      calls.push('reconcile')
      return { checked: 1, applied: 1, conflicts: 0, unresolved: 0, cleanups: 0, remaining: 0, truncated: false }
    }),
    warn: (message) => warnings.push(message),
    timers,
  })
  return { driver, timers, warnings, calls }
}

describe('retry drain scheduling', () => {
  it('drains after the backoff has actually elapsed', async () => {
    const { driver, timers, calls } = setup()

    driver.arm(5_000)

    const [entry] = [...timers.scheduled.values()]
    assert.equal(entry.delayMs, 5_000 + RETRY_DRAIN_SLACK_MS,
      'firing exactly at the backoff would race dueRetries, which compares next_attempt_at <= now')
    await timers.fire()
    assert.deepEqual(calls, ['reconcile'])
  })

  it('keeps one timer however many retries pile up', async () => {
    const { driver, timers, calls } = setup()

    driver.arm(1_000)
    driver.arm(1_000)
    driver.arm(30_000)

    assert.equal(timers.scheduled.size, 1, 'one drain settles every due retry, not just the one that armed it')
    await timers.fire()
    assert.deepEqual(calls, ['reconcile'])
  })

  it('unrefs the timer so a pending drain never holds dsh open', () => {
    const { driver, timers } = setup()
    driver.arm(1_000)

    const [entry] = [...timers.scheduled.values()]
    assert.equal(entry.unrefs, 1)
  })

  it('re-arms after a drain, because a later failure deserves its own', async () => {
    const { driver, timers, calls } = setup()

    driver.arm(1_000)
    await timers.fire()
    assert.equal(driver.pending, false)

    driver.arm(1_000)
    await timers.fire()
    assert.deepEqual(calls, ['reconcile', 'reconcile'])
  })
})

describe('retry drain gating', () => {
  it('stays off when the operator disabled it', () => {
    const { driver, timers } = setup({ enabled: false })
    driver.arm(1_000)

    assert.equal(timers.scheduled.size, 0)
    assert.equal(driver.pending, false)
  })

  it('refuses to reconcile from a timer when the policy withholds RECONCILE', () => {
    // One operation, one capability: a deployment that may not settle its own
    // writes from `memory_reconcile` must not settle them from a timer either.
    const { driver, timers } = setup({ canReconcile: () => false })
    driver.arm(1_000)

    assert.equal(timers.scheduled.size, 0)
  })

  it('re-checks the capability at arming time, not at construction', () => {
    let allowed = false
    const { driver, timers } = setup({ canReconcile: () => allowed })

    driver.arm(1_000)
    assert.equal(timers.scheduled.size, 0)

    allowed = true
    driver.arm(1_000)
    assert.equal(timers.scheduled.size, 1)
  })
})

describe('retry drain teardown', () => {
  it('cancels a pending drain, so it cannot run against a closed ledger', async () => {
    const { driver, timers, calls } = setup()

    driver.arm(1_000)
    assert.equal(driver.pending, true)
    driver.stop()

    assert.equal(driver.pending, false)
    assert.equal(timers.scheduled.size, 0)
    await timers.fire()
    assert.deepEqual(calls, [], 'a stopped driver must never reconcile')
  })

  it('is safe to stop when nothing is pending', () => {
    const { driver } = setup()
    assert.doesNotThrow(() => driver.stop())
    assert.doesNotThrow(() => driver.stop())
  })
})

describe('retry drain failure handling', () => {
  it('reports a failed drain instead of raising an unhandled rejection', async () => {
    const { driver, timers, warnings } = setup({
      reconcile: async () => { throw new Error('hypatia is gone') },
    })

    driver.arm(0)
    await timers.fire()

    assert.match(warnings.join('\n'), /retry drain failed: hypatia is gone/)
  })

  it('survives a reconcile that throws synchronously', async () => {
    const { driver, timers, warnings } = setup({
      reconcile: () => { throw new Error('ledger closed') },
    })

    driver.arm(0)
    await timers.fire()

    assert.match(warnings.join('\n'), /retry drain failed: ledger closed/)
  })

  it('stays quiet when a drain finds nothing to settle', async () => {
    const { driver, timers, warnings } = setup({
      reconcile: async () => ({ checked: 0, applied: 0, conflicts: 0, unresolved: 0, remaining: 0, truncated: false }),
    })

    driver.arm(0)
    await timers.fire()

    assert.deepEqual(warnings, [])
  })
})
