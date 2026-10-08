# Deprecation notice

**`dsh-hypatia` is deprecated as of 2026-10-08 and is no longer maintained.** No
further fixes, releases, or issue triage. The last release is `0.2.0`.

Use **[`dsh-hypatia-auto-memory`](https://github.com/tkliuxing/dsh-hypatia-auto-memory)**
instead. ([中文说明](#中文说明))

## Why

This plugin deliberately left writing memories to the agent: the model loaded a
protocol and then had to choose to call a tool. In practice it usually did not.
In the deployment this plugin was written for, one recorded session out of
fifteen issued a `hypatia` command at all — and that was the session where the
user asked for one directly.

Recall, exact project scoping, verified writes, and the retry queue here worked
as designed. The part that depended on model initiative was the write path, and
that is the part the replacement takes over: `dsh-hypatia-auto-memory` drives the
same Hypatia store from DSH native session events, with consolidation queued onto
a dedicated model route. Its README is the authority on its own behaviour.

## Migrating

```sh
# 1. remove this plugin from the profile
dsh plugin --profile web remove @tkliuxing/dsh-hypatia

# 2. install the replacement
dsh plugin --profile web add dsh-hypatia-auto-memory

# 3. restart dsh - plugin wiring happens once, at load
```

Mind the name: the unscoped `dsh-hypatia` on npm is a **different plugin**, by
MarchLiu (who writes hypatia itself), not an earlier release of this one. Leave
it alone — only the scoped `@tkliuxing/dsh-hypatia` is this project.

**Run one or the other, never both.** They both register a `hypatia-memory` skill
and both write to the same shelves; installed together, one silently loses the
skill registration and the same conversation can be logged twice.

### Your data

Nothing is lost and nothing needs converting:

- **Hypatia entries stay where they are.** They live in the Hypatia shelves, not
  in this plugin, and the replacement reads and writes the same shelves.
- **This plugin's control ledger is not used by the replacement.** It stays at
  `~/.dsh/dsh-hypatia/state.sqlite` — the intent/dispatch/receipt records and the
  retry queue for the operations this plugin performed. It is inert once the
  plugin is unloaded: keep it if you want the audit trail, delete it if you do
  not.
- **Session logs** belong to DSH and are untouched either way.

## Rolling back

Deprecation is a statement about maintenance, not a switch: the code still works
as it did on `0.2.0`. Reinstall it with
`dsh plugin --profile web add @tkliuxing/dsh-hypatia`, and remove the replacement
first — same "not both" reason as above.

## 中文说明

**`dsh-hypatia` 自 2026-10-08 起废弃，不再维护**，最后一个版本是 `0.2.0`。请改用
**[`dsh-hypatia-auto-memory`](https://github.com/tkliuxing/dsh-hypatia-auto-memory)**。

原因：本插件把「写入记忆」留给模型主动调用工具，而实际很少发生 —— 在它面向的部署里，
十五个会话中只有一个真正执行过 `hypatia` 命令，而那一个还是用户直接要求的。召回、
精确的项目作用域隔离、写入校验与重试队列都按设计工作，问题出在依赖模型自觉的写入
路径上。替代插件改由 DSH 原生事件驱动写入，并用自己的模型路由在后台做整理。

```sh
dsh plugin --profile web remove @tkliuxing/dsh-hypatia
dsh plugin --profile web add dsh-hypatia-auto-memory
# 然后重启 dsh
```

注意包名：npm 上未加 scope 的 `dsh-hypatia` 是**另一个插件**（hypatia 作者 MarchLiu
的项目），不是本项目的早期版本，不要顺手卸掉它 —— 本项目只有
`@tkliuxing/dsh-hypatia` 这一个名字。

两个插件**只能装一个**：它们都注册 `hypatia-memory` 技能、都写同一批 shelf，同时安装会
导致技能注册被其中一个顶掉，同一段对话还可能被写两遍。

数据不需要迁移：记忆本身在 Hypatia shelf 里，替代插件读写的是同一批 shelf；本插件的
控制账本（`~/.dsh/dsh-hypatia/state.sqlite`）只服务于本插件，卸载后即失效，留着当审计
记录或直接删除都可以。
