#!/usr/bin/env node
/**
 * Recall benchmark for the GOAL.md performance decision gate.
 *
 * Measures the one-shot Hypatia CLI at representative dataset sizes and
 * concurrency, against the configured recall deadline. The point is to decide
 * with numbers whether the CLI route is adequate - GOAL.md is explicit that
 * missing the target starts a design discussion, not an automatic jump to a
 * native helper.
 *
 * Usage:
 *   node scripts/bench-recall.js [--sizes 100,1000] [--concurrency 1,4] [--iterations 20]
 *
 * It creates its own throwaway shelf, registers it, and disconnects and
 * removes it afterwards, so the operator's own shelves are untouched.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createAdapter } from '../src/adapter/cli.js'
import { normalizeConfig } from '../src/config.js'
import { openLedger } from '../src/ledger/ledger.js'
import { MutationCoordinator } from '../src/mutations.js'
import { RecallService } from '../src/recall.js'
import { createMemoryPolicy } from '../src/policy.js'
import { deriveProjectIdentity, memoryName } from '../src/identity.js'

const run = promisify(execFile)

function parseArgs(argv) {
  const args = { sizes: [100, 1000], concurrency: [1, 4], iterations: 20 }
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1]
    if (argv[i] === '--sizes') args.sizes = next.split(',').map(Number)
    if (argv[i] === '--concurrency') args.concurrency = next.split(',').map(Number)
    if (argv[i] === '--iterations') args.iterations = Number(next)
  }
  return args
}

/** Percentile of a sorted-on-demand sample, in milliseconds. */
function percentile(samples, p) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[Math.max(0, index)] * 10) / 10
}

/**
 * Time one call. A failure is data, not a crash: measuring how the CLI behaves
 * under contention is the whole point of the concurrency dimension.
 */
async function timeIt(fn) {
  const started = performance.now()
  try {
    await fn()
    return { ms: performance.now() - started, ok: true }
  } catch (error) {
    return { ms: performance.now() - started, ok: false, failure: error?.detail?.failure ?? error.code }
  }
}

/** Run `fn` `iterations` times at the given concurrency. */
async function sample(fn, iterations, concurrency) {
  const results = []
  for (let batch = 0; batch < Math.ceil(iterations / concurrency); batch += 1) {
    const group = Array.from({ length: concurrency }, () => timeIt(fn))
    results.push(...await Promise.all(group))
  }
  return {
    latencies: results.filter((result) => result.ok).map((result) => result.ms),
    failures: results.filter((result) => !result.ok),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const shelfDir = mkdtempSync(join(tmpdir(), 'dsh-hypatia-bench-'))
  const shelfName = `dshbench${process.pid}`
  const warn = (message) => console.error(`  ! ${message}`)

  const config = normalizeConfig({ adapter: { shelf: shelfName } })
  const adapter = await createAdapter({ config, warn })
  if (!adapter) {
    console.error('hypatia CLI unavailable; cannot benchmark.')
    process.exitCode = 1
    return
  }

  await run(adapter.binary, ['connect', shelfDir, '-n', shelfName])
  console.log(`# dsh-hypatia recall benchmark`)
  console.log(`hypatia ${adapter.version} | node ${process.version} | ${process.platform}/${process.arch}`)
  console.log(`recall deadline: ${config.recall.deadlineMs}ms | shelf: ${shelfDir}\n`)

  const ledger = openLedger(':memory:')
  const policy = createMemoryPolicy({ preset: 'standard' })
  const mutations = new MutationCoordinator({ ledger, adapter, shelf: shelfName, warn })
  const recall = new RecallService({ ledger, adapter, policy, config, warn })
  const scope = deriveProjectIdentity({ cwd: '/bench/project' }).scope

  let seeded = 0
  try {
    for (const size of args.sizes) {
      process.stderr.write(`seeding to ${size} records...`)
      for (; seeded < size; seeded += 1) {
        const memoryId = `bench${String(seeded).padStart(6, '0')}`
        await mutations.writeMemory({
          operationId: `op-${memoryId}`,
          memoryId,
          hypatiaName: memoryName(scope, memoryId),
          scope,
          kind: seeded % 10 === 0 ? 'rule' : 'work-unit',
          title: `Benchmark memory ${seeded}`,
          payload: {
            title: `Benchmark memory ${seeded}`,
            summary: `Decision ${seeded} about the adapter, ledger, recall budget, and retry policy.`,
          },
        })
      }
      process.stderr.write(' done\n')

      for (const concurrency of args.concurrency) {
        const results = {
          'exact get': await sample(
            () => adapter.knowledgeGet(memoryName(scope, 'bench000001'), { shelf: shelfName }),
            args.iterations, concurrency,
          ),
          'fts search': await sample(
            () => adapter.search('adapter ledger', { shelf: shelfName, limit: 20 }),
            args.iterations, concurrency,
          ),
          'jse query': await sample(
            () => adapter.query(['$knowledge', ['$contains', 'tags', 'dshmem']], { shelf: shelfName }),
            args.iterations, concurrency,
          ),
          'full recall': await sample(
            () => recall.recall({ scope, shelf: shelfName, queryText: 'adapter ledger retry budget' }),
            args.iterations, concurrency,
          ),
        }

        console.log(`## ${size} records, concurrency ${concurrency}`)
        console.log('| operation | P50 ms | P95 ms | max ms | failures | within deadline |')
        console.log('|---|---|---|---|---|---|')
        for (const [label, { latencies, failures }] of Object.entries(results)) {
          const p95 = percentile(latencies, 95)
          const within = label === 'full recall'
            ? (p95 <= config.recall.deadlineMs ? 'yes' : 'NO')
            : '-'
          const failureNote = failures.length === 0
            ? '0'
            : `${failures.length} (${[...new Set(failures.map((f) => f.failure))].join(', ')})`
          console.log(`| ${label} | ${percentile(latencies, 50)} | ${p95} | ${percentile(latencies, 100)} `
            + `| ${failureNote} | ${within} |`)
        }
        console.log()
      }
    }
  } finally {
    ledger.close()
    try {
      await run(adapter.binary, ['disconnect', shelfName])
    } catch (error) {
      warn(`could not disconnect the benchmark shelf: ${error.message}`)
    }
    rmSync(shelfDir, { recursive: true, force: true })
  }
}

await main()
