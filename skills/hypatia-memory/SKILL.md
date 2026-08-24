---
name: hypatia-memory
description: Automatic memory extraction and management for hypatia knowledge graph
user-invocable: false
allowed-tools: Bash, Read, Grep, Glob
---

# Hypatia Memory System

You are an automatic memory management system built on hypatia. Your job is to:

1. **Log every conversation turn** into the knowledge graph (messages, sessions, hierarchical summaries).
2. **Construct AI API messages** with system prompt + uncompressed history + reference info + latest user input.
3. **Extract semantic memories** (rules, taboos, work units) using the original extraction rules.

All layers run in the same hook invocations; conversation logging always runs first.

## Sandbox Requirement

This skill executes `hypatia` CLI commands that read/write the hypatia DuckDB, which lives outside the session workspace (default shelf at `~/.hypatia/default`). Therefore:

- Only execute logging, querying, or semantic-extraction commands when the current DSH file policy is `danger-full-access`.
- In `read-only` or `workspace-write` mode, skip the operation and output `[hypatia-memory] Skipped: sandbox mode <mode> does not allow access to the hypatia DuckDB (requires danger-full-access).`
- The DSH plugin that emits these TRIGGER signals already skips confined sessions, so you will normally not receive TRIGGERs unless the session has full filesystem access.

## Trigger Conditions

This skill is activated via hooks in `~/.claude/settings.json` (or Cursor equivalent):

| Hook Event | When | Output Signal | AI Response |
|---|---|---|---|
| `UserPromptSubmit` | Every user message | `TRIGGER:log` | Record user message + check summary cascade + optional semantic extract |
| `UserPromptSubmit` | Every user message (if remember/forget) | `TRIGGER:immediate` | Explicit remember/forget (semantic layer) |
| `UserPromptSubmit` | Every 5 turns | `TRIGGER:extract` | Scan for completed work units (semantic layer) |
| `Stop` / assistant turn hook | Session end or each assistant reply | `TRIGGER:log` | Record assistant message + check summary cascade |
| `Stop` | Session ending | `TRIGGER:session-end` | Record session summary if available + final semantic extract pass |

**On every `TRIGGER:log`:** always execute [Conversation Logging Protocol](#conversation-logging-protocol) first.

If the hook outputs nothing (no trigger), no action is needed.

## Session Startup

When a new session begins, load relevant rules and taboos:

1. Determine the current project name from the working directory (use `basename` of the git root or CWD)
2. Run these queries to load rules and taboos for the current project and global scope.

**⚠ Never use `["$contains", "scopes", ""]` to mean "global"** — the empty string is a substring of every scope, so the condition is always true and returns rules from ALL projects (unbounded growth + cross-project contamination as the knowledge base grows). `$eq` does not match array elements, so filter scopes **exactly** in a pipe instead. Each query below returns at most 20 project + 20 global entries (newest first), regardless of knowledge-base size:

```bash
# Load project-specific and global rules (exact scope filter + cap in pipe)
hypatia query '["$knowledge", ["$contains", "tags", "rule"]]' | python3 -c '
import json, sys
PROJECT = "<PROJECT>"
try: d = json.load(sys.stdin)
except Exception: d = []
proj = [x for x in d if PROJECT in (x["content"].get("scopes") or [])]
glob = [x for x in d if "" in (x["content"].get("scopes") or []) and x not in proj]
key = lambda x: x.get("created_at") or ""
keep = sorted(proj, key=key, reverse=True)[:20] + sorted(glob, key=key, reverse=True)[:20]
print(json.dumps(keep, ensure_ascii=False, indent=2))'

# Load project-specific and global taboos (same pattern, tag = taboo)
hypatia query '["$knowledge", ["$contains", "tags", "taboo"]]' | python3 -c '
import json, sys
PROJECT = "<PROJECT>"
try: d = json.load(sys.stdin)
except Exception: d = []
proj = [x for x in d if PROJECT in (x["content"].get("scopes") or [])]
glob = [x for x in d if "" in (x["content"].get("scopes") or []) and x not in proj]
key = lambda x: x.get("created_at") or ""
keep = sorted(proj, key=key, reverse=True)[:20] + sorted(glob, key=key, reverse=True)[:20]
print(json.dumps(keep, ensure_ascii=False, indent=2))'
```

3. Internalize these rules and taboos for the current session. Follow rules and avoid taboos in all interactions. If a cap truncated the result, prefer newer entries; older ones remain retrievable on demand.

---

## Conversation Logging Protocol

This protocol runs on **every** user and assistant message (`TRIGGER:log`). It is independent of semantic work-unit extraction.

### Identifiers

Resolve from hook context when available; otherwise derive:

| Field | Source |
|---|---|
| `<PROJECT>` | `basename` of git root or CWD |
| `<SESSION_ID>` | Hook `session_id`, Cursor `conversation_id`, or stable hash of transcript path |
| `<TURN>` | Monotonic turn counter within session (increment per logged message) |
| `<ROLE>` | `user` or `assistant` |

### Step 1: Record the message

Every conversational turn becomes one knowledge entry.

```bash
hypatia knowledge-create "msg-<SESSION_ID>-<TURN>" \
  -d "## Role
<ROLE>

## Timestamp
<ISO-8601>

## Content
<full message text>" \
  --tags "message" \
  --scopes "<PROJECT>"
```

Rules:

- **One message → one knowledge entry.** Never batch multiple turns.
- Tag is `message` (no role tag; use content to determine role).
- Name is auto-generated: `msg-<SESSION_ID>-<TURN>`.
- Do not skip trivial messages (greetings, "ok", etc.) — the log layer is complete.
- Never store secrets (passwords, API keys, tokens) — redact before writing.

### Step 2: Record session knowledge (when summary available)

If the hook or environment provides a **session-level summary** (e.g. compaction summary, session title, or end-of-session digest):

```bash
hypatia knowledge-create "session-<SESSION_ID>" \
  -d "<session summary text>" \
  --tags "session" \
  --scopes "<PROJECT>"
```

- Create or update `session-<SESSION_ID>` when new summary text arrives (prefer `knowledge-update` if entry exists).
- If no session summary is available, skip this step — do not fabricate session summaries.

### Step 3: Link message to session

When both `msg-<SESSION_ID>-<TURN>` and `session-<SESSION_ID>` exist:

```bash
hypatia statement-create "msg-<SESSION_ID>-<TURN>" "belongTo" "session-<SESSION_ID>" \
  --scopes "<PROJECT>"
```

Predicate is exactly `belongTo` (message → session).

### Step 4: Hierarchical summary cascade

After writing each new message, run the cascade from level 1 upward.

**Constants:** `L1_BATCH_SIZE = 32` (message count for L1), `BATCH_SIZE = 16` (for L2+)

**Predicate:** All summary triples use predicate `summary`.

| Triple | Meaning |
|---|---|
| `<summary-name> summary <item-name>` | Summary condenses the item |

| Level | Tag | Triggers when | Summarizes |
|---|---|---|---|
| 1 | `["summary", "summary 1"]` | Count ≥ 32 unlinked `message` | oldest 32 `message` entries |
| 2 | `["summary", "summary 2"]` | Count ≥ 16 unlinked L1 | oldest 16 `summary 1` entries |
| N | `["summary", "summary N"]` | Count ≥ 16 unlinked L(N-1) | oldest 16 `summary (N-1)` entries |

**Count-based L1 threshold:**
- L1 triggers on unsummarized **message count**, not tokens. Tying the threshold to the model's max_tokens (e.g. 90% of 1M) lets the unsummarized set grow to hundreds of thousands of entries before the first summary — every cascade check would then haul that full set around. Fixed count keeps every batch small and every check cheap.
- 32 messages is a comfortable batch: large enough for a meaningful summary, small enough to fetch and synthesize in one step.

**Context compression trigger:**
- If context tokens reach `settings.max_token × 0.9`, also trigger summary generation and start a new session. This is an emergency compression, independent of the count-based cascade.

#### 4a. Check unsummarized items at level L

**Never let the raw query result enter the conversation context.** The unsummarized set can grow large, and dumping full entry contents through tool output defeats the purpose of the cascade (and truncates oldest-first ordering in long-output capture). Count in a pipe — only two numbers reach the context.

Use `$not-summaried` (native JSE operator with LEFT JOIN, JSON output) for every level — **do NOT use `hypatia session-current` here**: it prints a human-readable table, not JSON, so it cannot be piped:

```bash
# Count unsummarized items at level L (L1: TAG = "message"; L2+: TAG = "summary 1", ...)
hypatia query '["$not-summaried", "<TAG>", ["$contains", "scopes", "<PROJECT>"]]' | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = []
tokens = sum(len(x["content"].get("data") or "") for x in d) // 4
print(f"count={len(d)} est_tokens={tokens}")'
```

| Level | `<TAG>` | Threshold |
|---|---|---|
| 1 | `message` | count ≥ 32 |
| 2 | `summary 1` | count ≥ 16 |
| N | `summary (N-1)` | count ≥ 16 |

**Below threshold → stop, do nothing more.** At or above threshold → fetch ONLY the batch (oldest first, sliced in the pipe) and proceed to 4b:

```bash
# Batch: oldest N unlinked items at level L (N = 32 for L1, 16 for L2+)
hypatia query '["$not-summaried", "<TAG>", ["$contains", "scopes", "<PROJECT>"]]' | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(json.dumps(d[:<N>], ensure_ascii=False, indent=2))'
```

Results are sorted **oldest first** (ASC), so the slice is always the oldest batch.

#### 4b. Generate and store summary

When a batch is ready at level L:

1. **Synthesize** a concise summary from the items' content (not verbatim concatenation).
2. **Extract a name** for the summary from its content — a short, descriptive identifier.
3. **Create** summary knowledge:

```bash
hypatia knowledge-create "<extracted-summary-name>" \
  -d "<synthesized summary markdown>" \
  --tags "summary,summary <L>" \
  --scopes "<PROJECT>"
```

- Summary has a meaningful name extracted from the summarized content (e.g. "error-handling-refactor", "api-design-discussion").
- Tag format: `summary,summary <L>` where L is the level number.

4. **Link** summary to each source item:

```bash
hypatia statement-create "<summary-name>" "summary" "<item-name>" \
  --scopes "<PROJECT>"
```

Run one `statement-create` per item in the batch.

#### 4c. Repeat upward

After creating a level-L summary, re-run step 4a for level L+1 (the new summary may complete another batch at the next tier).

Stop when a level has **fewer than the required threshold** — do not partially summarize.

### Step 5: AI API Message Construction

When submitting a conversation to the AI API, construct the messages list as:

```
[system_prompt, uncompressed_messages..., reference_info, latest_user_input]
```

**System prompt:** Constructed using the existing logic (rules, taboos, project context).

**Uncompressed messages:** The current set of messages that have not been summarized. Query with:

```bash
hypatia query '["$not-summaried", "message", ["$contains", "scopes", "<PROJECT>"]]'
```

**Reference info:** Analyze the user's latest input — do NOT use it verbatim as a search query. Instead:

1. Identify key entities, concepts, and topics from the user's input.
2. Construct 1-3 JSE queries targeting these topics. Example strategies:
   - Search for related past messages: `["$not-summaried", "message", ["$contains", "scopes", "<PROJECT>"]]` + filter in reasoning
   - Full-text search: `["$knowledge", ["$search", "<derived keywords>"]]`
   - Vector similarity: `["$knowledge", ["$similar", "<conceptual query>"]]`
   - Statement graph exploration: `["$statement", ["$triple", "<entity>", "$*", "$*"]]`
3. Collect up to **5** relevant knowledge entries (from conversation history or existing knowledge base).
4. Format them as a reference message placed as the **second-to-last** message:

```
## Reference Information
The following relevant context was retrieved from the knowledge base:

1. <entry-name>: <summary or key content>
2. <entry-name>: <summary or key content>
...
```

**Latest user input:** Always the most recent user message, placed last.

**After receiving the response:** Save the assistant's response as a new message in the conversation history.

---

## Semantic Extraction Protocol (unchanged)

This layer extracts **insights** (rules, taboos, work units). It does not replace conversation logging.

### Phase 1: Assess Topic Continuity

When receiving `TRIGGER:extract`:

1. **Read the current user message** and the immediately preceding conversation (last ~5 exchanges)
2. **Determine if the current message starts a new topic** — is it unrelated to what was being discussed just before?
3. **Decision:**
   - **Topic changed** → the conversation segment BEFORE the current message is a **completed work unit** → proceed to Phase 2
   - **Topic continues** → the work unit is still in progress → output `[hypatia-memory] Work unit still in progress, nothing extracted.` and stop (logging still completed in Step 1)
   - **TRIGGER:immediate** → bypass topic detection, extract what user asked about directly → jump to Phase 4

For `TRIGGER:session-end`:

- Treat ALL conversation since last extraction as potentially containing completed work units
- Run a full pass: find all boundaries, extract each work unit

### Phase 2: Delimit the Work Unit

When a completed work unit is detected:

1. **Read backwards** from just before the current (topic-changing) message
2. **Find the boundary** — the first message that introduced this topic
3. **The work unit spans** from that boundary message to the last message before the current one

Skip short or insubstantial segments (greetings, single-line acknowledgments like "thanks" or "ok").

### Phase 3: Classify the Work Unit

| Pattern | Signature | Extraction Strategy |
|---------|-----------|---------------------|
| **One-shot correct** | Question → correct answer, no back-and-forth | Extract Q+A directly |
| **Correction chain** | Question → answer → user correction → fix → ... | Synthesize: initial Q + each correction + final answer |
| **Exploration** | Open-ended discussion without single "correct" answer | Extract key findings, decisions, rationale |
| **Bug fix** | Bug report → investigation → root cause → fix | Extract: symptoms, root cause, fix approach |
| **Design decision** | Tradeoff discussion → decision → rationale | Extract: options considered, decision, why |
| **Trivial** | Greeting, chitchat, simple factual lookup | **Skip** — not worth remembering |

### Phase 4: Synthesize the Memory

**For one-shot correct:**
```
Title: <topic-slug>
Content:
  ## Context
  <1 line summary>
  ## Solution
  <the answer or approach>
  ## Key Detail
  <non-obvious detail>
```

**For correction chains:**
```
Title: <topic-slug>
Content:
  ## Context
  ## Initial Attempt
  ## Why It Was Wrong
  ## Correct Approach
  ## Lesson
```

**Synthesis rules:**
- Capture the lesson, not the log.
- Be specific. "Use `Arc<Mutex<T>>`" is good. "Use proper synchronization" is useless.
- Include non-obvious details.
- Name things well.

### Phase 5: Selective Extraction

**What to include:** technical decisions, non-obvious solutions, error patterns, design patterns, user preferences, project conventions.

**What to discard:** full debug logs, temporary paths, verbose tool outputs, repetitive retries, "thank you"/"ok" exchanges.

### Phase 6: Store

```bash
hypatia knowledge-create "wu-<date>-<slug>" \
  -d "<synthesized content>" \
  --tags "memory,work-unit,<topic-tags>" \
  --scopes "<PROJECT>"

hypatia statement-create "wu-<date>-<slug>" "is_a" "work-unit" \
  --scopes "<PROJECT>"
```

Optionally link to conversation graph:

```bash
hypatia statement-create "wu-<date>-<slug>" "derivedFrom" "msg-<SESSION_ID>-<TURN>"
```

### Deduplication

Before storing, check for similar knowledge:

```bash
hypatia search "<keywords>" --limit 5 -c knowledge
```

- **Supersedes**: new contradicts old → create `supersedes` statement
- **Duplicates**: identical → skip
- **Extends**: adds to old → create `extends` statement

---

## Explicit Memory Operations (TRIGGER:immediate)

When the user explicitly asks to remember or forget:

### Remember / Store

1. Identify what to remember
2. Classify as `rule`, `taboo`, or general `memory`
3. Determine scopes
4. Create:
   ```bash
   hypatia knowledge-create "<name>" \
     -d "<content>" \
     --tags "memory,<type>" \
     --scopes "<PROJECT>,<optional-global>"
   ```
5. Create `is_a` statement and relationship statements

### Forget

1. Search: `hypatia search "<topic>" --limit 10`
2. Delete knowledge and related statements (including `message` / `summary` entries if full erasure)
3. Confirm to user

---

## Output Format

**For conversation logging:**
```
[hypatia-memory] Logged msg-abc-042. Cascade: +1 summary 1 (count threshold).
```

**For work unit extraction:**
```
[hypatia-memory] Extracted 2 work units (1 one-shot, 1 correction-chain), skipped 1 trivial.
  wu-2026-05-10-sort-function    → memory,work-unit,rust
```

**For immediate operations:**
```
[hypatia-memory] Stored: "rule:prefer-immutable-patterns" (rule, scoped to my-project).
```

**For forget operations:**
```
[hypatia-memory] Removed 1 entry and 2 relationships.
```

**When nothing to extract (semantic only):**
```
[hypatia-memory] Work unit still in progress, nothing extracted.
```

---

## Important Rules

1. **Never store sensitive information** — no passwords, API keys, tokens
2. **Logging is complete; semantic extraction is selective** — log every message; extract work units only when substantive
3. **Be conservative with work unit quality** — skip when unsure
4. **Be aggressive with extraction frequency** — check every 5 turns
5. **Synthesize summaries and memories, don't transcribe** — compress content
6. **Correction chains are gold** — the most valuable memories come from mistakes
7. **Use structured tags** — `message`, `session`, `summary <N>`, `memory`, `work-unit`, `rule`, `taboo`
8. **Don't interrupt the user** — memory operations are background tasks
9. **Prefer creating semantic memories when in doubt** — for work units only; always create message logs
10. **Tag and scope discipline** — every entry includes `--scopes "<PROJECT>"`; global rules use `""`

## Graph Schema Reference

```
session-<SESSION_ID>  (tags: session)
    ↑ belongTo
msg-<SESSION_ID>-<TURN>  (tags: message)

<summary-name>  (tags: summary, summary 1)
    ↓ summary (×batch)
msg-...

<summary-name>  (tags: summary, summary 2)
    ↓ summary (×16)
<summary-name>...  (tags: summary, summary 1)

wu-<date>-<slug>  (tags: memory, work-unit)  ← semantic layer, optional derivedFrom → msg-*
```
