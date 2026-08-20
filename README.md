# dsh-hypatia

[中文文档](./README.zh.md)

[Hypatia](https://github.com/MarchLiu/hypatia) memory plugin for DeepSeek Harness: connects DSH sessions to the hypatia local knowledge graph, giving agents **long-term memory across sessions**.

What you get:

- **Automatic memory** — every conversation turn is logged to the knowledge graph; oversized conversations are compressed through hierarchical summaries instead of blowing up the context
- **Project rules/taboos auto-loaded** — new sessions load the current project's and global rules/taboos at startup, so the agent follows your project conventions from the very first turn
- **Semantic distillation** — completed discussions are mined for work units (technical decisions, correction chains, design rationales) that resurface when related topics come up
- **Explicit control** — tell the agent "remember …" / "forget …" anytime to read and write memory directly; knowledge-graph questions trigger the `hypatia` skill

## Prerequisites

**The `hypatia` command must be installed on your PATH.** The plugin probes `hypatia --version` at load time; if it is missing, a warning is logged and nothing is registered (neither skills nor the memory bridge). Install hypatia and restart dsh to enable.

Install hypatia from source:

```sh
git clone https://github.com/MarchLiu/hypatia
cd hypatia && cargo build --release
# put target/release/hypatia on your PATH

# Optional: download the BGE-M3 embedding model (required for vector search / similar recall)
mkdir -p ~/.hypatia/default
hf download BAAI/bge-m3 --local-dir /tmp/bge-m3
cp /tmp/bge-m3/onnx/model.onnx ~/.hypatia/default/embedding_model.onnx
cp /tmp/bge-m3/onnx/model.onnx_data ~/.hypatia/default/model.onnx_data
cp /tmp/bge-m3/onnx/tokenizer.json ~/.hypatia/default/tokenizer.json
```

## Installation

```sh
# From a local path (development or source checkout)
dsh plugin --profile web add /path/to/dsh-hypatia

# Straight from GitHub (plain JS, no build step)
dsh plugin --profile web add github:tkliuxing/dsh-hypatia

# When running dsh from a source checkout, use pnpm dsh instead:
pnpm dsh plugin --profile web add /path/to/dsh-hypatia
```

**Restart dsh** after installation.

## Usage

**No manual steps required** — the memory bridge is fully automatic: every message is logged, every 5 user messages trigger a check for extractable memories, and new sessions load rules at startup.

On top of that, you can:

| Action | Effect |
|---|---|
| Tell the agent "remember: this project forbids eval" | Explicitly stores a memory (rule / taboo / memory) |
| Tell the agent "forget what you know about X" | Searches and deletes the related knowledge and relationships |
| Ask "what does the knowledge base say about Y", "search earlier decisions" | Triggers the `hypatia` skill for JSE / full-text / vector queries |

## Verification

Config layer (you should see a `# == dsh-hypatia` layer):

```sh
dsh --profile web --dump-config
```

End-to-end (confirm the skills and bridge actually work):

1. Open a **new session** — the first injected message should be `[hypatia-memory] TRIGGER:session-start`
2. Chat a bit in that project, then ask the agent: "search the knowledge base for message entries" — the `hypatia` skill should trigger and return the logged conversation

## Upgrade and Removal

`dsh plugin` is a pnpm forwarder; upgrade and removal run on the same profile, followed by a dsh restart:

```sh
dsh plugin --profile web update dsh-hypatia   # upgrade
dsh plugin --profile web remove dsh-hypatia   # remove
```

## Contents

| Skill | Description |
|---|---|
| `hypatia` | Operate the hypatia knowledge graph in natural language: knowledge CRUD, RDF triples, JSE queries, full-text/vector search, shelf management |
| `hypatia-memory` | Automatic memory system: per-turn conversation logging, hierarchical summary cascade, work-unit extraction, rules/taboos loading |

### Event bridge (the TRIGGER source for hypatia-memory)

`hypatia-memory` was designed around Claude Code hooks (`UserPromptSubmit` / `Stop`) emitting TRIGGER signals. This plugin implements an equivalent bridge using native cordis events:

| DSH event | Trigger signal |
|---|---|
| `agent/session-start` | `TRIGGER:session-start` — load project and global rules/taboos |
| `agent/pre-step` (step 1 of a turn carrying a genuine user message) | `TRIGGER:log`; every 5 user messages appends `TRIGGER:extract`; remember/forget intent appends `TRIGGER:immediate` |
| `agent/turn-stopping` | `TRIGGER:log (assistant)` — log the assistant reply (queued until the next pre-step) |

The bridge only applies to root sessions (subagent child sessions are skipped).

## Configuration

Everything is optional; override on the cordis row:

```yaml
- insert:
    - id: dsh-hypatia
      name: 'dsh-hypatia'
      config:
        memoryBridge: true    # event bridge on/off (default true)
        registerSkills: true  # skill registration on/off (default true)
        extractInterval: 5    # user messages between TRIGGER:extract (default 5)
```

## Known Limitations

- **No `TRIGGER:session-end`**: DSH has no reliable "session end" execution point; on session resume, summaries and TURN counters continue via the skill protocol's own queries
- **Changes require a restart**: skill registration and the event bridge run at plugin load time — restart dsh after editing `index.js` or `skills/`
- **Vector search needs the embedding model**: without the downloaded model, `similar` recall is unavailable; everything else is unaffected

## Development

`skills/` is self-maintained in this repository (it was once synced from the hypatia repo; the two are now decoupled). Edit `skills/*/SKILL.md` directly — do not overwrite-sync from upstream.

With a local link install (`dsh plugin add <path>`), changes to `index.js` or `skills/` take effect after restarting dsh.

## License

[MIT](./LICENSE)
