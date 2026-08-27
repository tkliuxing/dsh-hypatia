# dsh-hypatia Technical Goal

## Status

Architecture research is complete. This revision applies a hard repository boundary:

- **Only this repository may be changed.**
- DeepSeek Harness and Hypatia are external dependencies and must remain unmodified.
- The first implementation uses a host-side, one-shot Hypatia CLI adapter plus a plugin-owned SQLite control ledger.
- An in-repository Rust helper is only a benchmark-triggered fallback and requires a separate design discussion before implementation.
- Full-transcript vector mirroring remains **NO-GO by default**.

### Implementation state

Phases 0, 1, and 2 are implemented and covered by tests. Phase 3 remains NO-GO and
Phase 4 remains unauthorized.

| Phase | State | Where |
|---|---|---|
| 0 — contracts and control ledger | delivered | `src/policy.js`, `src/identity.js`, `src/ledger/` |
| 1 — CLI adapter and bounded recall | delivered | `src/adapter/`, `src/recall.js`, `scripts/bench-recall.js` |
| 2 — explicit memory and compaction ingestion | delivered | `src/mutations.js`, `src/tools.js`, `src/ingest/` |
| 3 — background model-assisted extraction | NO-GO, unimplemented | `extraction.enabled` is forced off and warns |
| 4 — in-repository helper | not authorized | — |
| Full-transcript vector mirror | NO-GO, unimplemented | `transcript-mirror` capability is refused and warns |

The compatibility bridge is **removed**. `src/legacy-bridge.js`, its tests, and the
deprecated appendix in `skills/hypatia-memory/SKILL.md` are deleted; a profile that
still carries `legacyBridge.enabled` is told at load that the flag no longer does
anything, rather than booting silently without it.

### Measured facts added since the research revision

Two upstream behaviours were measured during Phase 1 and changed the design:

- **Concurrent CLI invocations are unsafe, reads included.** Every invocation opens
  all registered shelves and DuckDB takes an exclusive file lock. Four concurrent
  `hypatia query` calls against 0.1.4 produced three `Conflicting lock is held`
  failures. The adapter therefore serializes *all* invocations, not just mutations
  per shelf as this document originally proposed.
- **Exit status is unreliable in both directions.** `knowledge-get` and `query`
  report "not found" with exit 0; `similar` reports `Error:` with exit 0; writes
  fail with exit 1. Classification is therefore text-driven, with exit status as
  corroboration only.

Recall latency against the 200 ms deadline, re-measured after the schema v2 and
recall changes (hypatia 0.1.4, Node 22.22.3, darwin/arm64):

| records | sessions | full recall P50 | full recall P95 | max | failures |
|---|---|---|---|---|---|
| 100 | 1 | 47.8 ms | 52.2 ms | 58.2 ms | 0 |
| 100 | 4 | 97.8 ms | 189.2 ms | 190.0 ms | 0 |
| 1,000 | 1 | 50.3 ms | 54.9 ms | 61.8 ms | 0 |
| 1,000 | 4 | 100.4 ms | 198.9 ms | 199.1 ms | 0 |

Serialized concurrency, not dataset size, is the cost driver: a tenfold increase in
records costs about 3 ms, while four concurrent sessions roughly quadruple the P95.
The one-shot CLI still meets the target at the supported size, so the Phase 4 trigger
has **not** fired - but four concurrent sessions at 1,000 records now sit within
1 ms of the deadline, and the individual `jse query` and `fts search` operations
already exceed it (P95 203.4 ms, max 207.6 ms). Recall fails open, so this costs
coverage rather than turns. Treat four concurrent sessions as the measured ceiling
and re-measure before raising `adapter.maxConcurrentReads` or the record count.

## Goal

Build `dsh-hypatia` as a reliable, scoped, auditable long-term memory capability for DeepSeek Harness without making the primary agent model responsible for deterministic logging, database orchestration, permissions, retries, or deletion.

The intended ownership split is:

- DSH session persistence remains the source of truth for raw conversation history.
- The plugin owns lifecycle integration, memory authorization, durable operation state, scope derivation, provenance, recall budgets, extraction scheduling, validation, retries, and observability.
- Hypatia remains an unmodified external semantic/graph storage and query backend reached through its installed CLI.
- The plugin-owned control ledger is the canonical control plane for plugin-created semantic memories and their delivery state; it is not a second raw transcript store.
- Models may propose semantic content, but never determine storage authority, source provenance, project scope, destructive target sets, or commit success.

## Hard Constraints

This goal must be implemented entirely in `dsh-hypatia`.

Do not:

- Modify DeepSeek Harness packages or require new DSH lifecycle hooks.
- Modify Hypatia library, CLI, schema, query operators, storage implementation, or release process.
- Patch or vendor Hypatia source into this repository.
- Depend on a hypothetical Hypatia daemon, JSONL protocol, batch API, transaction, tombstone, or idempotency API.
- Write DuckDB or Hypatia's SQLite index directly from Node.
- Use Agent Bash or `danger-full-access` as the automatic memory data plane.
- Claim storage guarantees that the current Hypatia CLI cannot provide.

The implementation may use:

- Existing DSH plugin lifecycle, session-query, tool, LLM, and context APIs.
- Node.js standard-library APIs supported by the DSH runtime, including `node:sqlite`, `child_process.execFile`, `AbortSignal`, and filesystem primitives.
- The installed, unmodified `hypatia` CLI.
- Plugin-owned state under a configurable directory such as `~/.dsh/dsh-hypatia/`.

Any proposal to add an in-repository Rust helper, native dependency, or bundled executable is a large implementation change and must be discussed with the user before work begins.

## Architecture Decision

Use a **host-trusted CLI adapter backed by a plugin-owned SQLite control ledger**.

```text
DSH durable session log
        |
        | turn/end notification + live-preferred durable read
        v
dsh-hypatia host plugin
  - memory authorization
  - project/scope derivation
  - provenance and stable operation IDs
  - node:sqlite control ledger and outbox
  - recall cache, deadline, and context budget
  - extraction scheduling and proposal validation
        |
        | execFile(absoluteHypatiaPath, fixedArgv)
        v
Unmodified Hypatia CLI
  - knowledge and statement CRUD
  - JSE / FTS / vector queries
  - existing shelves, DuckDB, SQLite FTS, embeddings
```

The adapter is host code, not a model-facing shell command. It intentionally runs outside the Agent file sandbox in the same way other trusted host persistence capabilities do. Memory access is governed by an independent plugin policy.

### Why this route

This route accepts several constraints in exchange for keeping all changes local to this repository:

- Every Hypatia CLI call creates a new `Lab`, restores registered shelves, and reopens storage.
- SQLite FTS currently rebuilds on open.
- Write commands do not return stable machine receipts.
- DuckDB, SQLite FTS, and embedding updates are not atomic together.
- Vector search has no exact project filter before top-K ranking.

The plugin compensates where it can through a durable ledger, stable names, post-write verification, serialization, caching, retry, and exact host-side visibility checks. It must expose remaining limitations instead of pretending they are solved.

## Established Facts

### DSH lifecycle

- `agent/pre-step` receives already claimed inbox messages before those messages are appended to `agent.session.events`.
- Messages returned by the accepted pre-step decision are appended as durable `user/message` events and enter the same model request.
- `agent/turn-stopping` occurs after the response and cannot affect the request that just completed. Steering there creates another step.
- `session/event` is post-commit to the live in-memory log, fire-and-forget, and not an external durability barrier.
- `session/flush` is the explicit DSH durability barrier. Hypatia CLI work must not participate in it by default.
- Seeded events loaded during resume or fork do not re-emit through `session/event`; consumers need cursor reconciliation.
- A closed `turn/end` is the minimum stable source boundary for semantic extraction.

Primary evidence:

- `../deepseek-harness/packages/core/agent-loop/src/agent.ts:225-300`
- `../deepseek-harness/packages/core/agent/src/runtime-types.ts:221-278`
- `../deepseek-harness/packages/core/session/src/index.ts:66-85`
- `../deepseek-harness/packages/session/session-checkpoint-policy/src/index.ts:52-82`
- `../deepseek-harness/packages/session/session-persistence/src/index.ts:203-209`
- `../deepseek-harness/packages/session/session-projection-cache/src/index.ts:179-204`

### Existing DSH capabilities

DSH already provides:

- Append-only session history with per-session monotonic `seq` values.
- Durable persistence and crash-repaired closed session snapshots.
- Live-preferred session-query reads and SQLite FTS across session history.
- Exact `cwd`, parent-session, sequence, event-type, and surface filters.
- Durable compaction summaries with source ranges, model provenance, and usage data.
- A proven same-request recall pattern in the session-reference plugin.
- Auxiliary LLM call patterns in the session-title provider.

Therefore Hypatia must not become a second canonical raw transcript store by default.

Primary evidence:

- `../deepseek-harness/packages/core/session/src/types.ts:231-232`
- `../deepseek-harness/packages/session-query/session-query/src/types.ts:179-279`
- `../deepseek-harness/packages/compaction/compaction/src/types.ts:17-71`
- `../deepseek-harness/packages/context/session-reference/src/index.ts:106-147`
- `../deepseek-harness/packages/session/session-title-llm/src/index.ts:229-279`

### Current Hypatia constraints

The plugin must design around these upstream facts without changing them:

- Every CLI invocation constructs a new `Lab` and restores registered shelves.
- Each opened shelf holds DuckDB, SQLite, and an embedding provider.
- SQLite drops and rebuilds its FTS table on every open.
- Knowledge and statement writes update DuckDB, SQLite FTS, and embeddings sequentially without a cross-store transaction or repair journal.
- Vector similarity search scans globally and lacks a storage-level exact project/scope filter.
- CLI output is mixed: reads are often JSON, while writes and administration use human-readable text.
- There is no daemon, batch mutation contract, caller idempotency key, tombstone model, or provenance-indexed delete.
- The shelf registry lacks a cross-process lock and atomic replacement contract.

Primary evidence:

- `../hypatia/src/cli/commands.rs:197-207`
- `../hypatia/src/storage/shelf_manager.rs:154-238`
- `../hypatia/src/storage/sqlite_store.rs:95-143`
- `../hypatia/src/service/knowledge.rs:14-40`
- `../hypatia/src/service/statement.rs:27-48`
- `../hypatia/src/storage/duckdb_store.rs:378-443`

## Plugin-Owned Control Ledger

Use `node:sqlite` to maintain plugin state under a configurable host path, initially:

```text
~/.dsh/dsh-hypatia/state.sqlite
```

The ledger stores semantic-memory control data, not raw conversation transcripts.

Minimum logical tables:

```text
memory_operation
memory_record
memory_provenance
memory_relation
memory_tombstone
session_cursor
retry_queue
dead_letter
```

### Ledger responsibilities

- Assign stable memory IDs and Hypatia names.
- Persist operation intent before invoking Hypatia.
- Persist exact semantic payloads needed for verification and replay.
- Track source identity and sequence ranges.
- Track pending, uncertain, applied, conflict, tombstoned, cleanup-pending, and failed states.
- Serialize mutations by shelf.
- Retry uncertain operations by stable operation ID.
- Suppress tombstoned and wrong-scope records before any result reaches the model.
- Reconcile ledger state against Hypatia after startup, timeout, crash, or ambiguous CLI output.
- Retain bounded audit metadata without retaining deleted semantic content after cleanup.

### Transaction boundary

Keep SQLite transactions short. Never hold a ledger transaction open while a Hypatia process is running.

One operation follows this state machine:

```text
ledger intent committed
  -> Hypatia CLI invocation
  -> Hypatia read-back verification
  -> ledger receipt committed
```

If the process exits or times out after dispatch, mark the operation `uncertain`. Reconciliation determines whether the stable Hypatia key contains the expected payload before retrying.

The plugin provides at-least-once delivery with idempotent wrapping. It does not claim an atomic transaction across DSH, the plugin ledger, DuckDB, SQLite FTS, and embeddings.

## Hypatia CLI Adapter

### Execution boundary

The adapter must:

- Resolve and retain one absolute Hypatia binary path during plugin startup.
- Verify a supported version before enabling memory operations.
- Invoke the binary with `execFile` or equivalent `shell: false` execution.
- Construct fixed argv arrays; never interpolate shell command strings.
- Apply an AbortSignal, timeout, stdout/stderr byte caps, and process termination policy.
- Normalize exit status, signal, timeout, output overflow, JSON parse errors, and known human output into structured plugin errors.
- Serialize mutations per shelf to reduce concurrent DuckDB/SQLite conflicts.
- Apply bounded concurrency to reads.
- Never expose generic CLI argv, paths, JSE, SQL, or shell text as model-controlled tool input.

### Stable names

Plugin-created records use host-generated names such as:

```text
dshmem:v1:<scopeHash>:<memoryId>
dshsession:v1:<sessionIdentityHash>
```

The scope prefix is redundant with ledger metadata and enables deterministic ownership checks. A name collision with a different payload is a conflict, not a successful retry.

Relations created by the plugin must also be recorded in the ledger with exact triples so cleanup never relies on a broad model-generated relationship query.

### Write verification

A successful CLI exit alone is not a durable receipt.

For knowledge writes:

1. Create or update by the host-generated stable name using available CLI operations.
2. Read the exact knowledge name back.
3. Compare the normalized payload or payload hash with the ledger intent.
4. Mark the operation applied only after a match.

For statement writes:

1. Create the exact host-generated triple.
2. Query the exact triple positions.
3. Compare normalized content.
4. Record each relation independently so partial fanout can be retried.

If the key exists with different content, stop and mark a conflict. Do not overwrite unknown user-owned records.

### Repair limitations

The adapter may repair plugin-owned records by exact stable key, including delete-and-recreate when the ledger has the canonical semantic payload. It must not repair or rewrite arbitrary user-owned Hypatia knowledge.

Without upstream changes, the plugin cannot prove that every Hypatia internal FTS/vector partial failure has converged. `memory_status` must report degraded or uncertain index state when verification is incomplete.

## DSH Plugin Responsibilities

### Deterministic source consumption

Use `session/event` and `turn/end` only as work notifications. The reliable consumer must:

1. Persist a cursor containing source identity and `lastAppliedSeq`.
2. Read a live-preferred, replay-validated session snapshot through existing DSH services.
3. Process only source ranges closed by `turn/end`.
4. Reconcile on startup, resume, and plugin reload.
5. Enqueue semantic work in the local ledger before returning from the scheduling task.
6. Exclude plugin recall messages and other derived memory context from re-ingestion.
7. Process only child events at `seq >= seedLength` for forks by default.
8. Skip subagent transcripts by default; allow an explicit parent-scoped digest later.

If the required durable session-query/persistence service is unavailable, automatic extraction must remain disabled. The plugin may still expose explicit memory tools if its memory policy allows them.

Do not infer message contents from current model context. Do not count turns only in an in-memory `Map`.

### Same-request recall

Implement recall in `agent/pre-step`:

1. Call `await next()` and preserve downstream decisions.
2. Return immediately on rejection.
3. Build the query only from direct human messages in the original claimed payload.
4. Derive project and scope in host code.
5. Read exact-scope plugin records from the ledger/cache.
6. Optionally use DSH session-query for bounded lexical evidence from raw history.
7. Optionally invoke Hypatia search/similar within the remaining deadline.
8. Accept Hypatia candidates only when their stable key maps to an active exact-scope ledger record, unless the user explicitly invokes a broader Hypatia search tool.
9. Merge, deduplicate, rank, and truncate results deterministically.
10. Append a plugin message with `form: recall` to the accepted decision.
11. Treat every recalled value as untrusted historical data, never as permission or system policy.
12. Fail open on timeout, cancellation, adapter failure, or malformed output.

Default recall limits:

- Total deadline: configurable, initially 100-300 ms.
- Results: at most 5 entries.
- Injected payload: at most 8-12 KB and a configured token budget.
- Ledger/cache lexical recall is the reliable baseline.
- Hypatia vector recall is a best-effort supplement because current vector top-K cannot pre-filter by exact project scope.
- Rules/taboos must be user-confirmed, exact-scope records with provenance and trust state.

### Scope isolation

Exact isolation is enforced by the plugin ledger and stable record prefix, not by assuming Hypatia's content-level `scopes` are sufficient.

Automatic recall must never inject a Hypatia candidate unless:

- the name has a recognized plugin-owned stable prefix;
- the record exists and is active in the ledger;
- the ledger scope exactly matches the current host-derived scope;
- the record is not tombstoned, conflicted, or uncertain.

Hypatia vector results may be adaptively over-fetched and then filtered, but this remains best effort and must not be the only automatic recall path.

User-invoked generic Hypatia search is a separate, explicitly broader operation and must label results as untrusted external knowledge.

### Extraction

Roll extraction out conservatively:

- First ingest existing DSH `compaction/summary` events; do not pay for a second summary of the same source range.
- Support explicit remember operations through a narrow model-facing tool.
- Add background work-unit extraction only after ledger, retry, verification, deletion, and authorization gates pass.
- Use existing DSH LLM services through a separately configured auxiliary route; do not modify DSH.
- Frame source messages as JSON data and require a versioned structured proposal.
- Derive source range, project, scope, operation ID, and authorization in host code.
- Apply host-side limits and redaction. A model claim that content is safe or redacted is not authoritative.
- Record extractor version, proposal schema version, model route, and validator policy version.

The model may propose:

- A title and summary.
- Semantic-memory kind.
- Candidate tags.
- Candidate graph relations within bounded fanout.

The model may not authoritatively propose:

- Shelf or project identity.
- Global scope.
- Filesystem paths, URLs, shell commands, SQL, JSE, or raw CLI argv.
- A permission grant.
- A destructive selector or delete target set.
- A database success result.

### Model-facing tools

Replace general Bash access with narrow tools:

- `memory_search`
- `memory_remember`
- `memory_forget_preview`
- `memory_forget_confirm`
- `memory_status`
- `memory_reconcile` for explicit administrative use

Automatic recall must not depend on the model calling `memory_search`.

Forget is a two-stage exact-ID workflow. Broad semantic search may produce preview candidates, but only host-generated IDs from that preview may be confirmed.

## Memory Authorization

Memory authorization is independent of the DSH file sandbox. Define at least these capabilities:

```text
disabled
read-only-recall
semantic-write
transcript-mirror
delete
global-rule-write
```

Rules:

- Installing/enabling the host plugin grants only the configured host capability.
- `read-only`, `workspace-write`, and `danger-full-access` remain Agent file-effect policies, not memory consent.
- Automatic Hypatia CLI calls are host-trusted plugin effects and must be documented as such.
- Project scope is derived from a configured stable project ID or hash of the canonical project root, not only `basename(cwd)`.
- Global rule/taboo writes require explicit authorization and cannot be produced by automatic extraction.
- Delete, export, archive, connect, and reconcile are separate administrative capabilities.
- Model-provided or recalled text never changes authorization.

## Provenance and Identity

Every source-derived memory must contain at least:

```json
{
  "source": {
    "dshSessionId": "...",
    "dshSessionCreatedAt": 0,
    "dshSessionCwd": "/absolute/path/or-null",
    "dshPersistenceSource": "opaque backend identity",
    "dshRevisionAtExtraction": "opaque revision",
    "parentSession": "optional",
    "seedLength": 0,
    "fromSeq": 0,
    "throughSeq": 0,
    "turn": 0
  },
  "derivation": {
    "extractorVersion": "...",
    "proposalSchemaVersion": 1,
    "validatorPolicyVersion": 1,
    "embeddingModelVersion": "optional"
  }
}
```

The stable operation ID is derived from immutable host-owned fields:

```text
source identity + fromSeq + throughSeq + memory kind
+ extractor version + proposal schema version
```

A repeated operation ID returns the existing ledger receipt or enters reconciliation. It never blindly creates another Hypatia record.

For forks, inherited events remain associated with the parent source. The child consumer starts at `seedLength` unless a separate lineage operation explicitly links parent memory.

## Deletion and Retention

Deletion is part of the plugin control design, but its guarantee must be scoped honestly.

### Supported guarantee

For plugin-owned semantic records in the active configured shelf:

1. Authorize an exact host-generated memory ID.
2. Write a durable deletion request to the ledger.
3. Tombstone the record synchronously so plugin recall immediately stops returning it.
4. Delete exact plugin-owned relations recorded in the ledger.
5. Delete the exact Hypatia knowledge key through the CLI.
6. Verify absence through exact reads/queries.
7. Remove the semantic payload from the ledger after cleanup while retaining content-free audit metadata.
8. Retry uncertain cleanup or expose it through `memory_status`.

### Explicit limitations

Without modifying Hypatia, this repository cannot guarantee erasure from:

- Unknown user-created relations that refer to a deleted plugin record.
- Hypatia exports or external backups not tracked by this plugin.
- A stale internal FTS row after an upstream partial failure that the available CLI cannot repair safely.
- Other clients or shelves not managed by this plugin.
- DSH source transcripts and their persistence backups.

The UI/tool response must distinguish:

```text
tombstoned
active-shelf-cleanup-complete
cleanup-uncertain
external-retention-unknown
```

Do not claim complete or regulatory-grade forget semantics beyond the supported boundary.

## Prompt Injection and Privacy

Treat all of the following as untrusted data:

- User and assistant text.
- Tool results and repository files.
- DSH historical search results.
- Hypatia memories and graph data.
- External documents.
- Model-generated proposals.

Controls:

- Never elevate retrieved memory directly to a system instruction.
- Delimit recall as historical reference data and strip it of execution authority.
- Only user-confirmed rule/taboo records can influence behavior, and they remain user-level instructions.
- Derive scope and authorization outside the model.
- Apply deterministic payload, relation fanout, query, process-output, and result limits.
- Run host-side sensitive-data classification/redaction before storage.
- Do not store raw secrets merely because the model failed to identify them.
- Exclude memory recall messages from future extraction to prevent recursive poisoning.
- Keep full transcript mirroring disabled by default.
- Delete semantic payloads from both Hypatia and the plugin ledger when cleanup succeeds.

## Performance Decision Gate

One-shot CLI latency is an accepted first-stage risk, not an ignored fact.

Before enabling automatic same-request Hypatia vector recall by default, benchmark at representative sizes and concurrency:

```text
100, 1,000, and 10,000 plugin-owned semantic records
1 and 4 concurrent DSH sessions
cold and warm process/filesystem cache
FTS, exact get, JSE, and vector similar
```

Initial acceptance targets:

- Recall adapter P95 within the configured 300 ms deadline at the supported dataset size.
- Timeout and cancellation leave no child process running.
- Output caps hold under large query results.
- Concurrent operations produce no observable shelf corruption or registry drift.
- Normal user turns continue when every Hypatia call fails.

If the CLI adapter misses the agreed target, the next step is a design discussion, not an automatic implementation change.

The fallback may be an in-repository Rust helper that depends on Hypatia's public library and exposes a private JSONL protocol while keeping `Lab` alive. That option:

- still does not modify Hypatia;
- introduces native builds and cross-platform packaging;
- may inherit Hypatia's multi-store consistency limitations;
- requires explicit user approval and a separate GOAL amendment before implementation.

Do not introduce N-API, HTTP, MCP, a daemon, or a native helper merely to avoid measuring the CLI route first.

## Migration Plan

### Phase 0: local contracts and control ledger

**Status: DELIVERED.** Only this repository changed.

Deliver:

- Independent memory authorization policy.
- Stable project identity, memory names, operation IDs, and provenance schema.
- `node:sqlite` schema and migrations for operations, memories, provenance, relations, tombstones, cursors, retries, and dead letters.
- Structured adapter error and receipt types.
- Payload limits, redaction boundary, retention policy, and threat model.
- Unit tests for state-machine transitions and crash windows.

Acceptance gates:

- Ledger migrations are idempotent and transactional.
- Repeating an operation ID cannot create a second ledger memory.
- Scope tests prove zero cross-project plugin recall.
- Tombstoned records are immediately absent from every plugin recall path.

### Phase 1: host CLI adapter and bounded read-only recall

**Status: DELIVERED.** Benchmarked; the Phase 4 trigger did not fire.

Deliver:

- Absolute binary resolution and compatible-version check.
- `execFile` adapter with fixed argv, `shell: false`, timeout, cancellation, and output caps.
- Structured parsing for supported read/query operations.
- Per-shelf mutation serialization and bounded read concurrency.
- `agent/pre-step` same-request recall.
- Exact-scope ledger/cache baseline recall.
- Best-effort Hypatia FTS/vector supplement within the remaining deadline.
- Recall provenance and untrusted-data framing.
- CLI benchmark report for the performance decision gate.

Acceptance gates:

- Adapter failure or timeout never fails the user turn.
- Recall respects cancellation and the total deadline.
- No recall message is recursively indexed.
- Wrong-scope or tombstoned Hypatia candidates never reach the model.
- No timed-out child process remains alive.
- P95 behavior and supported dataset size are documented.

### Phase 2: explicit memory and compaction ingestion

**Status: DELIVERED.** Write-verification and deletion-preview tests pass.

Deliver:

- Narrow memory tools without general Bash.
- Durable intent before each Hypatia mutation.
- Stable plugin-owned names and exact read-back verification.
- Idempotent ingestion of DSH `compaction/summary` events.
- Project-scoped explicit remember.
- Two-stage exact-ID forget with immediate ledger tombstone.
- Retry, reconciliation, conflict, and cleanup status.

Acceptance gates:

- The same compaction range cannot create duplicate ledger or Hypatia records.
- The final assistant response does not depend on a future turn for capture.
- Explicit remember reports only verified or explicitly uncertain status.
- A lost CLI response is reconciled by stable key before retry.
- Forget preview cannot broaden into an unreviewed delete selector.

### Phase 3: background model-assisted extraction

**Status: NO-GO.** Phases 0-2 are delivered, but their fault and security tests have not been reviewed as a release gate, so this stays unimplemented and `extraction.enabled` is forced off.

Deliver:

- Durable extraction cursor and retry/dead-letter state.
- Separately configured auxiliary LLM route through existing DSH services.
- Versioned proposal schema and host validator.
- Project-scoped work-unit, decision, and preference candidates.
- Redaction, deduplication, relation fanout limits, and audit.

Acceptance gates:

- Restart, duplicate notification, resume, fork, and concurrent-session tests pass.
- The model cannot set scope, provenance, permission, path, CLI argv, query program, or delete targets.
- Failed extraction never blocks the primary conversation.
- Automatic output cannot become a trusted global rule or taboo.

### Phase 4: optional in-repository helper

**Status: discussion required; not authorized by this GOAL alone.**

Trigger:

- The Phase 1 benchmark demonstrates that the one-shot CLI cannot meet an agreed requirement after caching, budgeting, and concurrency tuning.

Before implementation, discuss and approve:

- Rust dependency and pinning strategy.
- Build matrix and release artifacts.
- Installation and upgrade behavior.
- Crash isolation and protocol framing.
- Whether the helper uses only public `hypatia::Lab` APIs.
- Residual DuckDB/SQLite/embedding consistency limitations.

### Full-transcript vector mirror

**Status: NO-GO by default; strict opt-in only.**

Prerequisites:

- Per-session explicit consent.
- Provenance-indexed chunking with versioned chunker/model identity.
- Independent TTL and retention policy.
- Complete plugin-ledger cleanup semantics.
- Honest documentation of Hypatia export/backup limitations.
- Scope isolation, audit, and prompt-injection hardening.

Until every prerequisite is met, store only semantic memories, summaries, confirmed rules/taboos, relationships, and provenance.

## Removed Compatibility Bridge

The `TRIGGER + skill + Bash` bridge has been deleted. Its lifecycle fixes remain
valid for the host path that replaced it:

- Detect direct user prompts from `agent/pre-step.messages`, not from pre-populated session events.
- Do not consume deferred startup on a context-only step.
- Fail closed when sandbox policy resolution throws.

It was removed rather than kept indefinitely because every one of these faults was
structural, not a bug to be fixed:

- Memory protocol text is inserted into the durable model-visible transcript.
- Assistant logging is queued to the next step and can lose the final response.
- Turn counters and startup state are process-local.
- The model reconstructs data that host events already contain exactly.
- Writes have no durable operation ID, verification receipt, retry, or repair wrapper.
- Generic Bash and CLI operations widen prompt-injection and destructive-delete risk.
- Raw transcript duplication increases privacy and retention obligations.
- `danger-full-access` is incorrectly overloaded as memory authorization.

Cutover is complete:

- Automatic `TRIGGER:log`, `TRIGGER:extract`, and `TRIGGER:immediate` messages are gone.
- `hypatia-memory` documents the tools only; the Bash instructions are deleted.
- Generic Hypatia CLI administration stays separate, explicit, and permissioned in the
  `hypatia` skill, which still requires `danger-full-access`.
- `legacyBridge.enabled` is still read, for one reason: a profile that sets it gets a
  warning naming its removal instead of silently losing a memory path.

## Implementation Order

Recommended pull-request sequence, all in this repository:

1. **Control ledger:** memory policy, `node:sqlite` schema, stable identities, state machine, and migrations.
2. **CLI adapter:** binary/version resolution, safe `execFile`, limits, normalization, and serialization.
3. **Read path:** ledger/cache recall, optional Hypatia supplement, pre-step integration, and benchmarks.
4. **Mutation wrapper:** durable intent, stable names, read-back verification, retry, conflict, and reconciliation.
5. **Explicit tools:** remember, search, forget preview/confirm, status, and reconcile.
6. **Compaction ingestion:** durable cursor and idempotent summary operations.
7. **Auxiliary extraction:** proposal schema, validator, retry/dead-letter, and red-team tests.
8. **Legacy removal:** DONE. `src/legacy-bridge.js`, its tests, and the skill appendix are deleted; the flag survives only as a removal notice.
9. **Performance decision:** measured twice; the CLI meets the target at the supported size. Four concurrent sessions at 1,000 records is the measured ceiling - re-measure before raising concurrency.

## Definition of Done

The plugin-only architecture is complete when:

- No DeepSeek Harness or Hypatia source change is required.
- Normal memory use requires no Agent Bash access and no `danger-full-access` session.
- User and assistant source facts are consumed from durable DSH events without depending on a future turn.
- Recall enters the same request, stays within fixed budgets, and fails open.
- Exact plugin scope is enforced by host-derived ledger identity before model injection.
- Every plugin mutation has durable intent, a stable operation ID, read-back verification, and explicit uncertain/conflict states.
- Resume, fork, retry, duplicate delivery, and concurrent sessions do not create duplicate plugin-owned semantic memories.
- Prompt injection cannot grant permissions, select global scope, supply CLI argv, or choose destructive targets.
- Forget immediately hides data from plugin recall and exposes honest active-shelf cleanup status.
- The raw transcript remains canonical in DSH; the plugin ledger stores semantic control data only.
- Hypatia remains unmodified and is treated as an external projection with documented consistency limits.
- Full transcript mirroring remains opt-in and cannot be enabled without its retention and deletion prerequisites.
- A Rust/native helper is not introduced without measured need and explicit user approval.
