# dsh-hypatia Technical Goal

## Status

Architecture research completed. The target architecture is approved in stages, not as a single cutover.

- **GO now:** DSH as the canonical conversation source, a host-managed Hypatia stdio sidecar, and bounded read-only recall.
- **Conditional GO:** explicit semantic writes, compaction-summary ingestion, and model-assisted extraction after provenance, idempotency, repair, deletion, and authorization requirements are implemented.
- **NO-GO by default:** full-transcript vector mirroring.

## Goal

Build `dsh-hypatia` as a reliable, scoped, auditable long-term memory capability for DeepSeek Harness without making the primary agent model responsible for deterministic logging, database orchestration, permissions, retries, or deletion.

The intended ownership split is:

- DSH session persistence is the source of truth for raw conversation history.
- Hypatia stores derived semantic memories, summaries, user-confirmed rules and taboos, graph relationships, and provenance pointing back to DSH events.
- The DSH plugin owns lifecycle integration, memory authorization, scope derivation, recall budgets, extraction scheduling, validation, and observability.
- A persistent Hypatia sidecar owns storage connections, embedding state, mutation journals, idempotent receipts, repair, and deletion state.
- Models may propose semantic content, but never determine storage authority, source provenance, project scope, destructive target sets, or commit success.

## Architecture Decision

Use a **single-threaded, host-managed stdio JSONL sidecar** that keeps one explicit Hypatia shelf, its DuckDB/SQLite connections, and its embedding provider open.

```text
DSH durable session log
        |
        | turn/end notification + durable suffix/cursor read
        v
DSH Hypatia host plugin
  - memory authorization
  - project/scope derivation
  - provenance and stable operation IDs
  - recall deadline and context budget
  - extraction scheduling and validation
        |
        | versioned JSONL requests and receipts
        v
Hypatia sidecar
  - one explicit shelf and one writer
  - persistent Lab/connections/embedder
  - operation journal and idempotency
  - DuckDB primary semantic records
  - repairable FTS and embedding indexes
  - tombstones and deletion cleanup
```

Do not use the following as the automatic memory data plane:

- Primary-model `TRIGGER + skill + Bash` orchestration.
- One-shot Hypatia CLI invocations on every turn.
- Direct Node writes to DuckDB.
- MCP tools for automatic ingestion.
- `danger-full-access` as memory consent.

N-API may be reconsidered after the storage and protocol contracts stabilize. HTTP or a Unix socket may replace stdio only if multiple independent clients need to share one daemon.

## Established Facts

### DSH lifecycle

- `agent/pre-step` receives already claimed inbox messages before those messages are appended to `agent.session.events`.
- Messages returned by the accepted pre-step decision are appended as durable `user/message` events and enter the same model request.
- `agent/turn-stopping` occurs after the response and cannot affect the request that just completed. Steering there creates another step.
- `session/event` is post-commit to the live in-memory log, fire-and-forget, and not an external durability barrier.
- `session/flush` is the explicit durability barrier and is used before LLM and top-level tool side effects. Hypatia network or embedding work must not participate in this barrier by default.
- Seeded events loaded during resume or fork do not re-emit through `session/event`; consumers need durable cursor reconciliation.
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

Therefore Hypatia should not become a second canonical transcript store by default.

Primary evidence:

- `../deepseek-harness/packages/core/session/src/types.ts:231-232`
- `../deepseek-harness/packages/session-query/session-query/src/types.ts:179-279`
- `../deepseek-harness/packages/compaction/compaction/src/types.ts:17-71`
- `../deepseek-harness/packages/context/session-reference/src/index.ts:106-147`
- `../deepseek-harness/packages/session/session-title-llm/src/index.ts:229-279`

### Hypatia constraints

- Every CLI invocation constructs a new `Lab` and restores registered shelves.
- Each opened shelf holds DuckDB, SQLite, and an embedding provider.
- Storage objects intentionally do not implement `Send + Sync`; a single-threaded owner fits the current design.
- SQLite currently drops and rebuilds its FTS table on every open.
- Knowledge and statement writes update DuckDB, SQLite FTS, and embeddings sequentially without a cross-store transaction or repair journal.
- Vector similarity search scans globally and lacks a storage-level exact project/scope filter.
- The CLI has mixed human-readable and JSON output and no stable request/receipt envelope.
- There is no daemon, batch mutation contract, caller idempotency key, tombstone model, or provenance-indexed delete.
- Shelf registry writes are not protected by an atomic replacement or cross-process lock.

Primary evidence:

- `../hypatia/src/cli/commands.rs:197-207`
- `../hypatia/src/storage/shelf_manager.rs:154-238`
- `../hypatia/src/storage/mod.rs:1-20`
- `../hypatia/src/storage/sqlite_store.rs:95-143`
- `../hypatia/src/service/knowledge.rs:14-40`
- `../hypatia/src/service/statement.rs:27-48`
- `../hypatia/src/storage/duckdb_store.rs:378-443`

## DSH Plugin Responsibilities

### Deterministic source consumption

Use `session/event` and `turn/end` only as work notifications. The reliable consumer must:

1. Persist a cursor containing source identity and `lastAppliedSeq`.
2. Read a contiguous durable suffix after the target `turn/end`.
3. Process only complete source ranges.
4. Reconcile on startup, resume, and sidecar restart.
5. Deliver work at least once and rely on idempotent Hypatia commits.
6. Exclude plugin recall messages and other derived memory context from re-ingestion.
7. Process only child events at `seq >= seedLength` for forks by default.
8. Skip subagent transcripts by default; allow an explicit parent-scoped digest later.

Do not infer message contents from the current model context. Do not count turns only in an in-memory `Map`.

### Same-request recall

Implement recall in `agent/pre-step`:

1. Call `await next()` and preserve downstream decisions.
2. Return immediately on rejection.
3. Build the query only from direct human messages in the original claimed payload.
4. Derive project and namespace in host code.
5. Query Hypatia with exact storage-level scope filtering.
6. Optionally query DSH session-query for bounded lexical evidence from raw history.
7. Merge, deduplicate, rank, and truncate results deterministically.
8. Append a plugin message with `form: recall` to the accepted decision.
9. Treat every recalled value as untrusted historical data, never as a permission or system-policy source.
10. Fail open on timeout, cancellation, sidecar failure, or malformed output.

Default recall limits:

- Deadline: configurable, initially 100-300 ms.
- Results: at most 5 entries.
- Injected payload: at most 8-12 KB and a configured token budget.
- Vector recall: only if it finishes within the same deadline.
- Rules/taboos: only user-confirmed, exact-scope records with provenance and trust state.

### Extraction

Roll extraction out conservatively:

- First ingest existing DSH `compaction/summary` events; do not pay for a second summary of the same source range.
- Support explicit remember operations through a narrow model-facing tool.
- Add background work-unit extraction only after the mutation and deletion gates below pass.
- Run extraction through a separately configured auxiliary LLM route, not by adding work to the primary response loop.
- Frame source messages as JSON data and require a versioned structured proposal.
- Derive source range, project, scope, operation ID, and authorization in host code.
- Apply host-side limits and redaction. A model claim that content is safe or redacted is not authoritative.
- Record extractor version, proposal schema version, model route, and validator policy version.

The model may propose:

- A title and summary.
- Semantic-memory kind.
- Candidate tags.
- Candidate graph relations within bounded fanout.

The model may not propose authoritative:

- Shelf or project identity.
- Global scope.
- Filesystem paths, URLs, shell commands, SQL, or JSE programs.
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
- `memory_reindex` for explicit administrative use

Automatic recall must not depend on the model calling `memory_search`.

Forget must be a two-stage exact-ID workflow. Broad semantic search may produce preview candidates, but only host-generated IDs from the preview may be confirmed. The first deletion action is a tombstone so the item immediately disappears from recall; physical cleanup is asynchronous and auditable.

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
- `read-only`, `workspace-write`, and `danger-full-access` remain file-effect policies, not memory consent.
- Project scope is derived from a configured stable project ID or a hash of the canonical project root, not only `basename(cwd)`.
- Global rule/taboo writes require explicit authorization and cannot be produced by automatic extraction.
- Delete, export, archive, connect, and reindex are separate administrative capabilities.
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

The stable operation ID must be derived from immutable host-owned fields such as:

```text
source identity + fromSeq + throughSeq + memory kind
+ extractor version + proposal schema version
```

A repeated operation ID must return the original durable receipt rather than creating another memory.

For forks, inherited events remain associated with the parent source. The child consumer starts at its `seedLength` unless a separate lineage operation explicitly links parent memory.

## Hypatia Sidecar Contract

### Process model

- Add `hypatia serve --stdio --shelf <absolute-path>` or an equivalent dedicated binary.
- Open only the configured shelf; do not restore every registry entry.
- Acquire an exclusive writer lock for the shelf.
- Keep `Lab`, DuckDB, SQLite, and the embedding provider alive.
- Serialize storage mutations through one owner thread.
- Keep stdout machine-only JSONL; send diagnostics to stderr.
- Enforce request-line, response, queue-depth, and result-size limits.
- Perform a protocol/schema/version handshake before accepting work.
- Let Node restart the process with bounded backoff without restarting the DSH agent loop.

### Minimum operations

```text
hello / health / status
recall
validateProposal
commitProposal
getReceipt
deleteById
deleteByProvenance
repair
shutdown
```

Every mutating request carries a stable caller-generated `opId`. A response is a durable receipt, not merely a report that execution started.

If the child exits after a request is written but before a response arrives, the client must classify the result as `uncertain` and retry by the same `opId` after restart.

### Consistency model

Do not attempt a distributed transaction between DSH and Hypatia. Provide:

- DSH-to-Hypatia at-least-once delivery.
- Idempotent sidecar commits.
- A durable source watermark.
- A durable operation intent and receipt journal.
- A read-side visibility gate.
- Deterministic repair and rebuild.

Treat DuckDB semantic entities as primary records. FTS and embeddings are repairable indexes with explicit status:

```text
pending -> ready
pending -> failed -> retrying -> ready
```

Recall must exclude incomplete, validation-failed, and tombstoned records unless a specific degraded read mode says otherwise.

A successful semantic commit may report `ftsPending` or `embeddingPending`; it must never leave the caller unable to determine whether the primary entity exists.

### Scope filtering

Exact namespace/project filtering must occur inside the storage query before ranking or top-K truncation. It is not acceptable to:

1. search all shelves/projects;
2. take global top-K;
3. filter the returned rows in Node.

Hypatia needs an indexed first-class scope/namespace representation or an equivalent exact filter usable by FTS and vector SQL.

## Deletion and Retention

Deletion is part of the core design, not a later UI concern.

Required state:

```text
memory_operation
memory_provenance
memory_tombstone
memory_export_inventory
```

Deletion sequence:

1. Authorize an exact host-generated target set.
2. Write a durable deletion request.
3. Tombstone targets synchronously so recall stops returning them.
4. Remove or rewrite dependent relations and summaries.
5. Remove DuckDB records, SQLite FTS rows, vectors, archives, and tracked exports according to policy.
6. Record cleanup status and retry failures.
7. Preserve an audit record that does not retain the deleted content itself.

A source transcript deletion policy must separately define DSH retention, persistence backend deletion, backup retention, and how Hypatia handles provenance whose source is gone.

Do not claim complete forget semantics until both DSH source retention and all Hypatia derived artifacts have explicit contracts.

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
- Apply deterministic payload, relation fanout, query, and result limits.
- Run host-side sensitive-data classification/redaction before storage.
- Do not store raw secrets merely because the model failed to identify them.
- Exclude memory recall messages from future extraction to prevent recursive poisoning.
- Keep full transcript mirroring disabled by default.

## Migration Plan

### Phase 0: contracts and safety foundation

**Status: required before automatic writes.**

Deliver:

- Provenance schema and stable source identity.
- Independent memory authorization policy.
- Versioned JSONL protocol.
- Stable operation IDs and durable receipts.
- Mutation journal and repair state machine.
- Tombstone, cascade, retention, and audit specification.
- Exact scope-filter query design.
- Threat model and failure-injection plan.

Acceptance gates:

- Repeating a mutating `opId` returns the same receipt.
- Scope tests prove zero cross-project results.
- A crash after each storage stage converges through repair.
- A tombstoned item is immediately absent from all recall paths.

### Phase 1: read-only sidecar and bounded recall

**Status: conditional GO after the read-path subset of Phase 0.**

Deliver:

- Persistent stdio sidecar with one explicit shelf.
- Host-owned sidecar lifecycle and health state.
- `agent/pre-step` same-request recall.
- Exact project/global filtering.
- FTS fallback when embedding is unavailable.
- Strict timeout, cancellation, result, byte, and token budgets.
- Recall provenance and untrusted-data framing.

Acceptance gates:

- Sidecar crash or timeout never fails the user turn.
- Recall respects cancellation and the configured deadline.
- No recall message is recursively indexed.
- Resume and fork behavior matches the cursor/seed policy.
- P95 added latency remains within the configured local budget.

### Phase 2: explicit memory and compaction ingestion

**Status: conditional GO after idempotent mutations and deletion previews exist.**

Deliver:

- Narrow memory tools without general Bash.
- Idempotent ingestion of DSH `compaction/summary` events.
- Project-scoped explicit remember.
- Two-stage exact-ID forget with tombstones.
- Operation and deletion audit status.

Acceptance gates:

- The same compaction range cannot create duplicate memories.
- The final assistant response is never lost because no next turn occurred.
- Explicit remember reports a durable receipt.
- Forget preview cannot broaden into an unreviewed delete selector.

### Phase 3: background model-assisted extraction

**Status: NO-GO until Phases 0-2 pass fault and security tests.**

Deliver:

- Durable extraction cursor and retry/dead-letter state.
- Separately configured auxiliary LLM route.
- Versioned proposal schema and host validator.
- Project-scoped work-unit/decision/preference candidates.
- Redaction, deduplication, relation fanout limits, and audit.

Acceptance gates:

- Restart, duplicate notification, lost response, resume, fork, and concurrent-session tests pass.
- The model cannot set scope, provenance, permission, path, query program, or delete targets.
- Failed extraction never blocks the primary conversation.
- Automatic output cannot become a trusted global rule or taboo.

### Phase 4: full-transcript vector mirror

**Status: NO-GO by default; strict opt-in only.**

Prerequisites:

- Per-session explicit consent.
- Provenance-indexed chunking with versioned chunker/model identity.
- Independent TTL and retention policy.
- Complete delete cascade across chunks, FTS, vectors, relations, summaries, archives, exports, and backups.
- Rebuild from the DSH source log.
- Scope isolation, audit, and prompt-injection hardening.

Until every prerequisite is met, store only semantic memories, summaries, confirmed rules/taboos, relationships, and provenance.

## Current Compatibility Bridge

The existing lifecycle fixes remain valid:

- Detect direct user prompts from `agent/pre-step.messages`, not from pre-populated session events.
- Do not consume deferred startup on a context-only step.
- Fail closed when sandbox policy resolution throws.

However, the current `TRIGGER + skill + Bash` bridge remains a temporary compatibility mode because it still has these architectural faults:

- Memory protocol text is inserted into the durable model-visible transcript.
- Assistant logging is queued to the next step and can lose the final response.
- Turn counters and startup state are process-local.
- The model reconstructs data that host events already contain exactly.
- Writes have no durable operation ID, transaction, receipt, retry, or repair contract.
- Generic Bash and CLI operations widen prompt-injection and destructive-delete risk.
- Raw transcript duplication increases privacy and retention obligations.
- `danger-full-access` is incorrectly overloaded as memory authorization.

Migration rule:

- Keep the bridge behind an explicit legacy feature flag while the sidecar path is incomplete.
- Do not add new features to the trigger protocol.
- At cutover, remove automatic `TRIGGER:log`, `TRIGGER:extract`, and `TRIGGER:immediate` messages.
- Replace `hypatia-memory` Bash instructions with narrow tool behavior.
- Keep generic Hypatia CLI administration separate, explicit, and permissioned.

## Implementation Order

Recommended pull-request sequence:

1. **Hypatia protocol:** explicit-shelf stdio server, handshake, machine errors, health, limits, and process lock.
2. **Hypatia read path:** exact scoped FTS/vector recall and no per-open FTS rebuild.
3. **DSH plugin read path:** sidecar client, memory policy, pre-step recall, budgets, health, and failure handling.
4. **Hypatia mutation foundation:** operation journal, stable receipts, upsert/batch, index state, and repair.
5. **Hypatia deletion foundation:** provenance index, tombstones, relation cascade, and cleanup status.
6. **DSH explicit tools:** remember, search, forget preview/confirm, status, and audit events.
7. **Compaction ingestion:** durable cursor and idempotent summary commits.
8. **Auxiliary extraction:** proposal schema, validator, retry/dead-letter, and red-team tests.
9. **Legacy removal:** delete automatic trigger/Bash orchestration after migration acceptance tests pass.

## Definition of Done

The architecture is complete when:

- Normal memory use requires no Agent Bash access and no `danger-full-access` session.
- User and assistant source facts are consumed from durable DSH events without depending on a future turn.
- Recall enters the same request, stays within fixed budgets, and fails open.
- All scopes are host-derived and enforced before retrieval ranking.
- Every mutation is idempotent, journaled, repairable, and returns a durable receipt.
- Resume, fork, crash, retry, duplicate delivery, and concurrent sessions do not create duplicate semantic memories.
- Prompt injection cannot grant permissions, select global scope, or choose destructive targets.
- Forget immediately hides data and exposes verifiable cleanup status.
- The raw transcript remains canonical in DSH; Hypatia defaults to semantic-only storage.
- Full transcript mirroring remains opt-in and cannot be enabled without its retention and deletion guarantees.
