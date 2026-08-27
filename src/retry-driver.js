/**
 * The in-session drain for the retry queue.
 *
 * A retryable write failure - another process holding the DuckDB lock is the
 * realistic one - is durable in the ledger the moment it happens, but nothing
 * re-dispatches it on its own: `reconcile()` runs at startup and on demand. So
 * without a driver, a memory the user asked for stays unverified for the rest
 * of the session and only settles at the next plugin load.
 *
 * This is deliberately not a polling interval. It arms only when a retry is
 * actually scheduled, keeps at most one timer, and drains through the same
 * `reconcile()` every other path uses - which means it inherits that path's
 * conflict handling, dead-lettering, and tombstone checks rather than
 * re-implementing a weaker version of them.
 *
 * @module dsh-hypatia/retry-driver
 */

/** Fire this long after the backoff so `dueRetries` really sees the row. */
export const RETRY_DRAIN_SLACK_MS = 250

/**
 * @param {{
 *   enabled: boolean,
 *   canReconcile: () => boolean,
 *   reconcile: () => Promise<object>,
 *   warn: (message: string) => void,
 *   slackMs?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 * }} deps
 * @returns {{arm: (delayMs: number) => void, stop: () => void, pending: boolean}}
 */
export function createRetryDriver({
  enabled,
  canReconcile,
  reconcile,
  warn,
  slackMs = RETRY_DRAIN_SLACK_MS,
  timers = globalThis,
}) {
  let timer = null

  return {
    /**
     * Schedule one drain, unless a drain is already pending.
     *
     * Gated by `Capability.RECONCILE`, like the startup pass and
     * `memory_reconcile`: a deployment that may not settle its own writes from
     * a tool must not settle them from a timer either.
     */
    arm(delayMs) {
      if (!enabled || timer || !canReconcile()) return
      timer = timers.setTimeout(() => {
        timer = null
        // A drain settles every retry that is due, not only the one that armed
        // it, so one timer is enough however many failures pile up.
        Promise.resolve()
          .then(reconcile)
          .then((summary) => {
            if (summary?.checked > 0) warn(`retry drain: ${JSON.stringify(summary)}`)
          })
          .catch((error) => warn(`retry drain failed: ${error.message}`))
      }, Math.max(0, Number(delayMs) || 0) + slackMs)
      // A pending drain must never be the reason dsh stays alive.
      timer?.unref?.()
    },

    /**
     * Cancel a pending drain. Called from the `ctx.effect` teardown, because a
     * timer that survives an unloaded plugin would reconcile against a closed
     * ledger.
     */
    stop() {
      if (timer) timers.clearTimeout(timer)
      timer = null
    },

    get pending() {
      return timer !== null
    },
  }
}
