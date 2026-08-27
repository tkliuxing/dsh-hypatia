# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-hypatia` is a **DeepSeek Harness (DSH) plugin** — a cordis plugin published as plain ESM JavaScript with **no build step and no runtime dependencies**. It gives DSH sessions long-term memory backed by the external [hypatia](https://github.com/MarchLiu/hypatia) knowledge-graph CLI.

The defining architectural choice: **the plugin runs Hypatia itself, in host code.** The model proposes semantic content and nothing else — it never gets argv, a shelf, a path, a JSE program, a scope, or a delete selector.

## Commands

```bash
npm test                                                    # full suite
node --test tests/ledger.spec.js                            # one file
node --test --test-name-pattern="fails open" tests/recall.spec.js   # one case
npm run bench -- --sizes 100,1000 --concurrency 1,4         # performance gate
```

Install/iterate against a live harness (a `dsh plugin` link install resolves imports from the checkout's real path):

```bash
dsh plugin --profile web add /path/to/dsh-hypatia
```

**Restart dsh after any change to `index.js`, `src/`, or `skills/`** — registration and event wiring happen once at plugin load.

Requires **Node 22.5+** for `node:sqlite`. The benchmark creates and removes its own throwaway shelf; if it dies mid-run, check `hypatia list` for a leaked `dshbench*` entry.

## Architecture

`index.js` is wiring only. The pipeline is:

| Module | Responsibility |
|---|---|
| `src/config.js` | normalize the cordis `config:` row; every default lives here |
| `src/policy.js` | memory capabilities, frozen at construction |
| `src/identity.js` | project scope, stable names, operation IDs, provenance, payload hashing |
| `src/ledger/` | plugin-owned SQLite control plane (`~/.dsh/dsh-hypatia/state.sqlite`) |
| `src/adapter/` | the only place a subprocess is spawned |
| `src/mutations.js` | intent → CLI → read-back verification → receipt |
| `src/recall.js` | same-request recall in `agent/pre-step` |
| `src/tools.js` | the narrow `memory_*` tools |
| `src/ingest/compaction.js` | idempotent ingestion of DSH `compaction/summary` events |
| `src/legacy-bridge.js` | the deprecated TRIGGER protocol, off by default |

### Invariants you must not break

These are each covered by tests, so violating one fails the suite — but the *reasons* are not obvious from the code alone.

- **`inject` is a flat array of service names.** Cordis reads the normalized form with `Object.keys(fiber.inject)`, so `{required: [...], optional: [...]}` is taken as two services literally named `required` and `optional`. They never resolve, the entry stays pending, and *the whole profile fails to boot* — this shipped once with a green suite. Only list services every profile has: a service named here that a profile lacks is a hard boot failure for the entire tree, which is why `tools` and `sandboxPolicy` are accessed defensively instead.
- **Compaction identity comes from `shadowedSeqs`, never `shadowedRange`.** `shadowedRange` is a surface-POSITION span, not a seq interval: `start` can exceed `end` after a replacement summary node lands at an older range's position, and two compactions can share a bounding pair while shadowing different nodes. `sourceRangeKey` hashes the exact sorted set, and `memory_provenance.source_range_key` (schema v2) makes the dedup lookup exact. `first`/`last` exist for provenance and display only. An event without `shadowedSeqs` is skipped, not ingested under a weaker key.
- **One Hypatia process at a time.** `adapter.maxConcurrentReads` defaults to 1 and this is a measured requirement, not caution. Every `hypatia` invocation opens *all* registered shelves and DuckDB takes an exclusive file lock, so concurrent invocations collide even when they are pure reads on different shelves. Measured against 0.1.4: four concurrent `hypatia query` calls → three `Conflicting lock is held` failures.
- **Exit status is not a success signal, in either direction.** `knowledge-get` and `query` print human "not found" text with exit 0; `similar` prints `Error:` with exit 0; writes fail with exit 1. `src/adapter/parse.js` classifies from the text and treats exit code as corroboration only. Its header table records the observed behaviour per command.
- **A zero exit is not a receipt.** Only `commitReceipt` after an exact read-back and payload-hash match moves a record to `applied`. A duplicate key with a matching hash means "our retry already succeeded"; a different hash is a `conflict` that must never be overwritten.
- **Ledger transactions never wrap a CLI call.** Intent, dispatch, and receipt are three separate short transactions with the subprocess in between. `Ledger.transaction()` does not nest, deliberately.
- **Scope is compared with `=`, never a substring.** Recall filters on exact ledger scope plus `state = 'applied'`, so tombstoned, pending, and cross-project records are absent by construction. A Hypatia candidate additionally needs a plugin-owned key prefix *and* an active ledger row — the prefix alone is forgeable.
- **Recall fails open.** Any timeout, cancellation, adapter fault, or parse failure yields zero entries and the turn proceeds. It also runs after `await next()` and only appends to an accepted decision.
- **Forget tombstones before touching Hypatia.** After `ledger.tombstone()` returns, recall already excludes the record even if the process dies. Cleanup status is reported exactly (`cleanup-uncertain` is a real outcome, not a failure to hide).
- **`memory_forget_confirm` accepts only IDs from its preview token.** That gate is the reason a prompt injection cannot broaden a delete.
- **A capped list must announce its cap.** `memory_forget_preview` returns `matched`, `listed`, `total_in_scope`, and `truncated`. A user confirming a silently truncated list believes the project is clean while entries remain. "Forget everything" is `match: 'all'`, because the words a user says for it appear in none of the stored memories and a term search would return an empty list that reads as "nothing to delete".
- **One operation, one capability.** The startup reconciliation pass and `memory_reconcile` both check `Capability.RECONCILE`. When they disagreed, a default deployment could dispatch writes it had no way to settle, while `memory_status` advised a tool that always refused. `memory_status` also never names a tool the current policy withholds.
- **Registration reads the cursor, not just writes it.** `registerCompactionIngest` scans `session.events` for summaries above `session_cursor.last_applied_seq`, because `session/event` only ever delivers *future* compactions — a resume, reload, or mid-project enable would otherwise skip everything already logged. The cursor is a fast-path skip; `ingestOne`'s exact range-key check is the correctness boundary.
- **A `presentCall` view is `card`-tagged, and the tag is the wire contract.** `ToolCallView` is a union discriminated by `card` (`'generic' | 'terminal' | 'diff'`), not by a `tag` field, and the salient input field is `rawInput`. The host recomputes every view at read time and validates the page with `z.looseObject({ card: z.string() })`, so one malformed view fails the *whole* transcript: an existing session stops opening with `{"expected":"string","code":"invalid_type","path":["events",N,"view","view","card"]}`. Nothing is persisted, so correcting the presenter repairs every past session at once. `defineTool` is unavailable here (see below) and nothing else type-checks these objects, which is why `tests/tools.spec.js` mirrors the contract and asserts it for every tool.
- **No imports from harness packages.** `recallMessage` in `index.js` and `pluginMessage` in the legacy bridge inline `createUserMessage` from `@deepseek-ai/dsh-llm` on purpose: a link install resolves imports from the checkout path, where in-box harness packages are unreachable. Tool definitions are likewise plain objects rather than `defineTool` calls.

### DSH APIs this depends on

The harness is a sibling checkout at `../deepseek-harness` — **read it for API shape, never modify it.** Relevant contracts:

- `ctx.on('agent/pre-step', async (payload, next) => ...)` — call `await next()` first, return `{kind: 'enter', messages}`. Claimed inbox messages are in the payload, not yet in `session.events`.
- `agent.ctx.tools.register(definition)` → disposer. A definition is `{name, description, parameters, output: {schema, render}, execute, presentCall}`; the JSON Schema subset is enforced by `assertSupportedJsonSchema` (`packages/core/tools/src/json-schema.ts`) and allows only `type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, and annotations.
- `presentCall(args)` → a `ToolCallView` from `packages/core/tools/src/presentation.ts`, re-derived on every transcript read by `viewFor` in `packages/host/apiproxy/src/api-proxy.ts` and shipped as `{for: 'call', view}`. A presenter that *throws* soft-falls to no card; one that *returns* a bad object does not — see the `card` invariant above.
- `ctx.on('session/event', (session, event) => ...)` — `compaction/summary` carries `shadowedSeqs` (authoritative) and `shadowedRange` (a surface-position span; see the invariant above). `session.events` holds what was logged before this plugin loaded.
- `ctx.effect(fn, label)` is the teardown seam; `ctx.on('dispose')` is not a cordis event and never fires.
- `source: {kind: 'plugin', plugin, form}` — `form: 'recall'` marks retrieved reference context; `'notice'` also needs a `summary`.
- Session header fields used for identity: `id`, `createdAt`, `cwd`, `parentSession`, `seedLength`, `origin`.

### Testing the wiring, not only the parts

`apply()` skips any agent absent from `ctx.agents.roots()`. A fake whose `roots()` returns a constant `[]` therefore short-circuits *every* per-agent registration — tools, compaction ingest, scoping, disposal — while the suite stays green. That is exactly how a broken `inject` reached a real profile with 179 tests passing.

So: `tests/plugin.spec.js` must publish agents the way the runtime does (push to the root list, then emit `agent/created`), and must execute at least one registered tool rather than only asserting that names appear. `tests/tools.spec.js` calls `registerMemoryTools` directly and deliberately bypasses the wiring — it cannot cover this.

Prefer a mutation check for anything load-bearing: break the code deliberately and confirm the new tests fail. Several invariants above were confirmed that way, and one test that passed either way was rewritten because of it.

## GOAL.md is binding

[GOAL.md](GOAL.md) is the authoritative architecture document and it **overrides the implementation** where they disagree. Before any non-trivial change:

- **Only this repository may change.** DSH and Hypatia are unmodified external dependencies — do not patch, vendor, or require new lifecycle hooks from either.
- Phases 0–2 are delivered. **Phase 3 (background model-assisted extraction) is NO-GO**; `extraction.enabled` is forced off in `config.js` and warns. **Full-transcript mirroring is NO-GO**; the `transcript-mirror` capability is refused in `policy.js`.
- **Phase 4 (an in-repository Rust helper, native dependency, or bundled executable) requires explicit user approval first.** The Phase 1 benchmark met its target, so its trigger has not fired.
- The legacy TRIGGER bridge takes **no new features**. It exists only so an in-flight deployment can migrate.

## skills/

`skills/` is **self-maintained here** — it was once synced from the hypatia repo, but the two are now decoupled. Edit `skills/*/SKILL.md` directly; never overwrite-sync from upstream.

The frontmatter parser (`src/skills.js`) is deliberately minimal — scalars, double-quoted strings, booleans — so don't add YAML features it can't parse.

- `hypatia` is now the **explicit administrative** path (shelves, archives, models, unscoped search) and still requires `danger-full-access`.
- `hypatia-memory` documents the tool-based path; the original TRIGGER protocol survives verbatim in a deprecated appendix for `legacyBridge.enabled` deployments.

One trap the skills still warn about: **never express "global scope" as `["$contains", "scopes", ""]`** — the empty string is a substring of every scope, so it matches all projects. This is also why `src/identity.js` exports `GLOBAL_SCOPE` but recall never matches on it; exact scope comes from the ledger.
