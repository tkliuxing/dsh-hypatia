# dsh-hypatia

[Hypatia](https://github.com/tkliuxing/hypatia) skills for DeepSeek Harness：把两个 hypatia skill 带进 DSH 会话（`skills/` 由本仓库自维护），并把 DSH 的 agent 生命周期事件桥接为 `hypatia-memory` skill 所期望的 Claude Code 风格 TRIGGER 协议。

**前置依赖：系统本地必须安装 `hypatia` 命令（在 PATH 上）**。插件加载时探测 `hypatia --version`，缺失则打印警告并完全不注册（skills 与记忆桥接都不生效），安装 hypatia 后重启 dsh 即可。

## 包含内容

| Skill | 说明 |
|---|---|
| `hypatia` | 用自然语言操作 hypatia 知识图谱：knowledge CRUD、RDF 三元组、JSE 查询、全文/向量搜索、shelf 管理 |
| `hypatia-memory` | 自动记忆系统：逐条记录会话消息、分层摘要级联、work unit 语义提取、rules/taboos 加载 |

### 事件桥接（hypatia-memory 的 TRIGGER 来源）

`hypatia-memory` 原本依赖 Claude Code hooks（`UserPromptSubmit` / `Stop`）输出 TRIGGER 信号。本插件用原生 cordis 事件实现了等价桥接：

| DSH 事件 | 触发信号 |
|---|---|
| `agent/session-start` | `TRIGGER:session-start` —— 加载项目与全局 rules/taboos |
| `agent/pre-step`（含真实用户消息的 turn 第 1 步） | `TRIGGER:log`；每 5 条用户消息追加 `TRIGGER:extract`；检测到“记住/忘记”意图追加 `TRIGGER:immediate` |
| `agent/turn-stopping` | `TRIGGER:log（assistant）` —— 记录助手回复（排队到下一 pre-step 生效） |

桥接只作用于根会话（跳过 subagent 子会话）。已知限制：DSH 没有可靠的“会话结束”执行时机，`TRIGGER:session-end` 不会触发；会话恢复时摘要/计数靠 skill 协议中的查询自行续接。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-hypatia
# 从源码 checkout 运行 dsh 时：
pnpm dsh plugin --profile web add /path/to/dsh-hypatia
```

安装后**重启 dsh** 生效。验证配置层：

```sh
pnpm dsh --profile web --dump-config   # 应看到 "# == dsh-hypatia" 层
```

## 配置

在 cordis 行上可覆盖（均可选）：

```yaml
- insert:
    - id: dsh-hypatia
      name: 'dsh-hypatia'
      config:
        memoryBridge: true    # 事件桥接开关（默认 true）
        registerSkills: true  # skill 注册开关（默认 true）
        extractInterval: 5    # 每 N 条用户消息触发一次 TRIGGER:extract（默认 5）
```

## 开发

`skills/` 由本仓库自维护（曾与 hypatia 仓库同步，现已脱钩），直接编辑 `skills/*/SKILL.md` 即可，勿再从上游覆盖同步。

以本地 link 安装（`dsh plugin add <路径>`）时改动 `index.js` 或 `skills/` 后重启 dsh 即生效。
