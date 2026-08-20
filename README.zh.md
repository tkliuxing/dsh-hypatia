# dsh-hypatia

[English](./README.md)

[Hypatia](https://github.com/MarchLiu/hypatia) memory plugin for DeepSeek Harness：为 DSH 会话接入 hypatia 本地知识图谱，让 agent 获得**跨会话的长期记忆**。

装上之后你会得到：

- **自动记忆**：每一轮对话自动记入知识图谱，超长对话按层级自动摘要压缩，不撑爆上下文
- **项目规则/禁忌自动加载**：新会话启动时自动加载当前项目与全局的 rule / taboo，agent 从第一轮就遵守你的项目约定
- **语义沉淀**：自动从完成的讨论中提取 work unit（技术决策、踩坑修正链、设计方案），下次相关话题自动召回
- **显式控制**：随时对 agent 说「记住…」「忘记…」直接读写记忆；提到知识库/记忆类话题会触发 `hypatia` skill 做图查询

## 前置依赖

**系统本地必须安装 `hypatia` 命令（在 PATH 上）**。插件加载时探测 `hypatia --version`，缺失则打印警告并完全不注册（skills 与记忆桥接都不生效），安装 hypatia 后重启 dsh 即可。

从源码安装 hypatia：

```sh
git clone https://github.com/MarchLiu/hypatia
cd hypatia && cargo build --release
# 将 target/release/hypatia 放入 PATH

# 可选：下载 BGE-M3 embedding 模型（向量搜索 / similar 召回需要）
mkdir -p ~/.hypatia/default
hf download BAAI/bge-m3 --local-dir /tmp/bge-m3
cp /tmp/bge-m3/onnx/model.onnx ~/.hypatia/default/embedding_model.onnx
cp /tmp/bge-m3/onnx/model.onnx_data ~/.hypatia/default/model.onnx_data
cp /tmp/bge-m3/onnx/tokenizer.json ~/.hypatia/default/tokenizer.json
```

## 安装

```sh
# 本地路径（开发或源码 checkout）
dsh plugin --profile web add /path/to/dsh-hypatia

# 直接从 GitHub（纯 JS 无构建步骤，可直接安装）
dsh plugin --profile web add github:tkliuxing/dsh-hypatia

# 从源码 checkout 运行 dsh 时，用 pnpm dsh 代替 dsh：
pnpm dsh plugin --profile web add /path/to/dsh-hypatia
```

安装后**重启 dsh** 生效。

## 使用方式

**无需任何手动操作**——记忆桥接是全自动的：每条消息自动记录、每 5 条用户消息自动检查是否有可提取的记忆、新会话自动加载规则。

在此之上，你可以：

| 做法 | 效果 |
|---|---|
| 对 agent 说「记住：本项目禁用 eval」 | 显式写入一条记忆（rule / taboo / memory） |
| 对 agent 说「忘掉关于 X 的记忆」 | 搜索并删除相关知识与关系 |
| 问「知识库里关于 Y 有什么」「搜一下之前的决策」 | 触发 `hypatia` skill 做 JSE / 全文 / 向量查询 |

## 验证

配置层（应看到 `# == dsh-hypatia` 层）：

```sh
dsh --profile web --dump-config
```

端到端（确认 skill 与桥接真正工作）：

1. 打开一个**新会话**——第一条注入消息应是 `[hypatia-memory] TRIGGER:session-start`
2. 在该项目里随便聊几句后问 agent：「搜索知识库里的 message 条目」——应触发 `hypatia` skill 并返回已记录的对话

## 升级与卸载

`dsh plugin` 是 pnpm 转发器，升级与卸载同样在 profile 上操作，之后重启 dsh：

```sh
dsh plugin --profile web update dsh-hypatia   # 升级
dsh plugin --profile web remove dsh-hypatia   # 卸载
```

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

桥接只作用于根会话（跳过 subagent 子会话）。

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

## 已知限制

- **无 `TRIGGER:session-end`**：DSH 没有可靠的“会话结束”执行时机；会话恢复时摘要与 TURN 计数靠 skill 协议中的查询自行续接
- **改动需重启**：skill 注册与事件桥接都在插件加载时执行，改动 `index.js` 或 `skills/` 后须重启 dsh
- **向量搜索依赖 embedding 模型**：未下载模型时 `similar` 召回不可用，其余功能不受影响

## 开发

`skills/` 由本仓库自维护（曾与 hypatia 仓库同步，现已脱钩），直接编辑 `skills/*/SKILL.md` 即可，勿再从上游覆盖同步。

以本地 link 安装（`dsh plugin add <路径>`）时改动 `index.js` 或 `skills/` 后重启 dsh 即生效。

## License

[MIT](./LICENSE)
