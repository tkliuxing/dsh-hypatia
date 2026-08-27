# dsh-hypatia

[中文文档](./README.zh.md)

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), backed by the [Hypatia](https://github.com/MarchLiu/hypatia) knowledge graph.

The plugin runs Hypatia itself, in host code. The model is not responsible for logging, database orchestration, permissions, retries, or deletion — it only proposes what is worth remembering.

What you get:

- **Recall in the same request** — relevant project memories are retrieved and attached to the turn that needs them, inside a fixed time and size budget, and always failing open
- **Exact project scoping** — memories belong to one project, derived from the canonical workspace path; cross-project leakage is prevented by a host-side ledger, not by hoping content tags line up
- **Verified writes** — every write is read back and compared before it counts as stored, so "saved" means saved
- **Two-stage forget** — you see exactly what will be deleted before anything is deleted, and cleanup status is reported honestly rather than optimistically
- **No Bash required** — memory works in `read-only` and `workspace-write` sessions, because the plugin never asks the model to shell out

## Prerequisites

**The `hypatia` command must be on your PATH,** and **Node 22.5+** (the control ledger uses `node:sqlite`). At load the plugin resolves the binary to an absolute path and checks its version; if either fails it logs a warning and memory stays inactive.

The adapter is written against the **hypatia 0.1.4** CLI contract and refuses anything older, because its output classification depends on observed per-command behaviour rather than exit codes. Override with `adapter.minVersion`, or set `adapter.requireVersionCheck: false` to proceed unverified.

```sh
git clone https://github.com/MarchLiu/hypatia
cd hypatia && cargo build --release
# put target/release/hypatia on your PATH

# Optional: the BGE-M3 embedding model, only needed for vector search
mkdir -p ~/.hypatia/default
hf download BAAI/bge-m3 --local-dir /tmp/bge-m3
cp /tmp/bge-m3/onnx/model.onnx ~/.hypatia/default/embedding_model.onnx
cp /tmp/bge-m3/onnx/model.onnx_data ~/.hypatia/default/model.onnx_data
cp /tmp/bge-m3/onnx/tokenizer.json ~/.hypatia/default/tokenizer.json
```

## Installation

```sh
# From npm
dsh plugin --profile web add @tkliuxing/dsh-hypatia

# Straight from GitHub (plain JS, no build step)
dsh plugin --profile web add github:tkliuxing/dsh-hypatia

# From a local path, for development against a checkout
dsh plugin --profile web add /path/to/dsh-hypatia

# When running dsh from a source checkout, use pnpm dsh instead:
pnpm dsh plugin --profile web add /path/to/dsh-hypatia
```

The published package is **`@tkliuxing/dsh-hypatia`**. The unscoped `dsh-hypatia`
name on npm belongs to this project's pre-rewrite release and is not updated.

Upgrading from an install made under that old name? Remove it first, or the
profile carries two entries for one plugin — and, because both resolve to the
same code, the plugin can load twice against one ledger:

```sh
dsh plugin --profile web remove dsh-hypatia
dsh plugin --profile web add @tkliuxing/dsh-hypatia
```

**Restart dsh** after installing or after editing `index.js`, `src/`, or `skills/`.

## Usage

Recall and summary ingestion are automatic. Beyond that, the agent has six tools it uses on your behalf:

| You say | What happens |
|---|---|
| "remember: this project forbids eval" | `memory_remember` stores one user-confirmed rule in this project's scope |
| "what do we know about the retry policy?" | `memory_search` returns this project's memories, labelled as reference data |
| "forget what you know about the old API" | `memory_forget_preview` shows the exact entries first; `memory_forget_confirm` deletes only what you approved |
| "did that actually save?" | `memory_status` reports verified, pending, and uncertain counts, plus how much of the project automatic recall scores |
| "settle whatever is still unverified" | `memory_reconcile` re-checks unverified operations against the knowledge base by stable key |

For knowledge-graph administration — shelves, archives, embedding models, export, or a deliberately unscoped search across the whole graph — the `hypatia` skill drives the CLI directly. That path does require `danger-full-access`.

## How it works

```text
DSH durable session log
        |
        | turn notifications, compaction summaries
        v
dsh-hypatia host plugin
  - memory authorization (independent of the file sandbox)
  - project/scope derivation, provenance, stable operation IDs
  - node:sqlite control ledger and retry queue
  - recall cache, deadline, and context budget
        |
        | execFile(absoluteHypatiaPath, fixedArgv)   shell: false
        v
Unmodified Hypatia CLI
```

| Module | Responsibility |
|---|---|
| `src/policy.js` | memory capabilities, frozen at load |
| `src/identity.js` | project scope, stable names, operation IDs, provenance |
| `src/ledger/` | the plugin-owned SQLite control plane |
| `src/adapter/` | the one place a subprocess is spawned |
| `src/mutations.js` | intent → CLI → read-back verification → receipt |
| `src/recall.js` | same-request recall inside `agent/pre-step` |
| `src/retry-driver.js` | drains the retry queue inside the session that scheduled it |
| `src/tools.js` | the narrow `memory_*` tools |
| `src/ingest/` | idempotent ingestion of DSH compaction summaries |

[GOAL.md](./GOAL.md) is the authoritative architecture document, including the phases that are deliberately not implemented yet.

## Configuration

Everything is optional; override on the cordis row:

```yaml
- insert:
    - id: dsh-hypatia
      name: '@tkliuxing/dsh-hypatia'
      config:
        memory:
          preset: standard      # disabled | read-only-recall | standard | full
        projectId: null         # pin one scope across worktrees
        state:
          dir: ~/.dsh/dsh-hypatia
        adapter:
          shelf: default
          timeoutMs: 10000
          maxConcurrentReads: 1 # see "One process at a time" below
        recall:
          enabled: true
          deadlineMs: 200
          maxResults: 5
          maxBytes: 10240
          candidatePool: 50     # ledger records scored per turn
          searchScanLimit: 200  # ledger records memory_search scans
          hypatiaSupplement: true
          vectorSupplement: false
        ingest:
          compaction: true
        reconcile:
          batchSize: 50         # operations and cleanups settled per pass
          retryDriver: true     # drain the retry queue in-session
```

### Coverage caps

Recall and `memory_search` both score a **newest-first** slice of the ledger, so a
project with more memories than the cap reaches the model only through the Hypatia
full-text supplement. Neither cap is silent: recall reports its ceiling once per
scope in the log, `memory_search` names it in the tool's `note`, and `memory_status`
returns `recall_coverage`. Raise `recall.candidatePool` to widen the pool — it costs
one wider SQLite read per turn and no subprocess.

### Memory authorization

Memory capabilities are **independent of the DSH file sandbox**. `read-only`, `workspace-write`, and `danger-full-access` govern what the *agent* may touch; they are not memory consent. Presets:

| Preset | Grants |
|---|---|
| `disabled` | nothing |
| `read-only-recall` | recall only |
| `standard` (default) | recall, semantic write, delete, reconcile |
| `full` | adds global-rule write and shelf administration |

Global-rule writes and transcript mirroring are never available to automatic paths, whatever the preset says.

## Limits worth knowing

These are deliberate, and the plugin reports them rather than papering over them.

- **One process at a time.** Every `hypatia` invocation opens all registered shelves and DuckDB takes an exclusive file lock, so concurrent invocations fail with `Conflicting lock is held` — measured at 3 failures out of 4 concurrent `hypatia query` calls against hypatia 0.1.4. The adapter therefore serializes every call, reads included. Raise `maxConcurrentReads` only if nothing else can touch the same shelves.
- **Deletion is scoped honestly.** Forget tombstones a record immediately, deletes it from the active shelf, and verifies absence. It cannot reach Hypatia exports, backups, other shelves, unknown user-created relations, or the DSH transcript — and reports `cleanup-uncertain` instead of claiming success when verification is incomplete.
- **A failing write retries three times, then stops.** Backoff is 1s, 5s, 30s; after that the operation is dead-lettered and `memory_status` counts it. Retries are drained in-session by an armed timer, not a poll, so a transient lock conflict settles without waiting for the next dsh start — but nothing retries forever, and a payload conflict is never retried at all.
- **Vector recall is off by default.** Hypatia's top-K cannot pre-filter by scope, so results must be over-fetched and filtered afterwards. Enable `recall.vectorSupplement` only after benchmarking your dataset.
- **Background extraction is not implemented.** GOAL.md gates it NO-GO until the Phase 0–2 fault and security tests pass; setting `extraction.enabled` logs a warning and changes nothing.
- **Full-transcript mirroring is not implemented.** It stays off until its consent, retention, and cleanup prerequisites exist.

## Performance

`npm run bench` measures the CLI against the configured recall deadline on a throwaway shelf it creates and removes. Re-measured on hypatia 0.1.4, Node 22.22.3, darwin/arm64:

| Records | Concurrency | full recall P50 | P95 | max | Within 200 ms deadline |
|---|---|---|---|---|---|
| 100 | 1 | 47.8 ms | 52.2 ms | 58.2 ms | yes |
| 100 | 4 | 97.8 ms | 189.2 ms | 190.0 ms | yes |
| 1,000 | 1 | 50.3 ms | 54.9 ms | 61.8 ms | yes |
| 1,000 | 4 | 100.4 ms | 198.9 ms | 199.1 ms | yes |

Serialized concurrency is the cost driver, not dataset size: ten times the records costs about 3 ms, while four concurrent sessions roughly quadruple the P95.

Read the last row carefully. It clears the deadline by about 1 ms, and the individual `jse query` and `fts search` operations behind it already miss it (P95 203.4 ms, max 207.6 ms). Recall fails open, so exceeding the deadline costs coverage rather than turns — but **four concurrent sessions at 1,000 records is the measured ceiling**, not a comfortable margin. Re-measure before raising `adapter.maxConcurrentReads` or planning for a larger corpus.

## Development

```sh
npm test                                    # full suite
node --test tests/ledger.spec.js            # one file
npm run bench -- --sizes 100,1000           # performance gate
```

`skills/` is self-maintained here — it was once synced from the hypatia repo, but the two are now decoupled. Edit `skills/*/SKILL.md` directly.

## The TRIGGER bridge is gone

Earlier versions injected `[hypatia-memory] TRIGGER:*` messages and asked the model to run `hypatia` through Bash. That mode has been **removed**: it wrote protocol text into the durable transcript, had no durable operation IDs or write receipts, could lose the final assistant reply, and overloaded `danger-full-access` as memory consent.

A profile that still sets `legacyBridge.enabled: true` loads normally and logs a warning naming the removal — the key does nothing and can be deleted. Everything it used to do is now the `memory_*` tools plus automatic recall, neither of which needs Bash or a full-access session.

## License

[MIT](./LICENSE)
