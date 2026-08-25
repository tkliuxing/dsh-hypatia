# dsh-hypatia

[English](./README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供长期记忆，底层是 [Hypatia](https://github.com/MarchLiu/hypatia) 知识图谱。

插件在宿主进程内自行调用 Hypatia。模型不负责写日志、编排数据库、判断权限、重试或删除，它只负责判断**什么值得记住**。

功能：

- **同一次请求内召回** —— 相关的项目记忆会在需要它的那一轮被取出并附加进去，受固定的时间与体积预算约束，且永远失败即放行
- **精确的项目隔离** —— 记忆归属于唯一一个项目，由工作区规范化路径推导；跨项目泄漏由宿主账本阻止，而不是指望内容标签恰好对得上
- **写入经过校验** —— 每次写入都会回读比对后才算存好，所以"已保存"就是真的保存了
- **两段式遗忘** —— 删除前你先看到将被删除的确切条目，清理状态如实汇报而非报喜
- **不需要 Bash** —— 在 `read-only` 与 `workspace-write` 会话中记忆同样可用，因为插件从不要求模型去执行 shell

## 前置条件

**`hypatia` 命令必须在 PATH 上**，并且需要 **Node 22.5+**（控制账本使用 `node:sqlite`）。插件加载时会把二进制解析为绝对路径并检查版本；任一步失败都会记录警告，记忆功能保持关闭。

```sh
git clone https://github.com/MarchLiu/hypatia
cd hypatia && cargo build --release
# 将 target/release/hypatia 放到 PATH 上

# 可选：BGE-M3 向量模型，仅向量检索需要
mkdir -p ~/.hypatia/default
hf download BAAI/bge-m3 --local-dir /tmp/bge-m3
cp /tmp/bge-m3/onnx/model.onnx ~/.hypatia/default/embedding_model.onnx
cp /tmp/bge-m3/onnx/model.onnx_data ~/.hypatia/default/model.onnx_data
cp /tmp/bge-m3/onnx/tokenizer.json ~/.hypatia/default/tokenizer.json
```

## 安装

```sh
# 从本地路径安装（开发或源码检出）
dsh plugin --profile web add /path/to/dsh-hypatia

# 直接从 GitHub 安装（纯 JS，无构建步骤）
dsh plugin --profile web add github:tkliuxing/dsh-hypatia

# 从源码检出运行 dsh 时，改用 pnpm dsh：
pnpm dsh plugin --profile web add /path/to/dsh-hypatia
```

安装后、以及修改 `index.js`、`src/`、`skills/` 后，都需要**重启 dsh**。

## 使用

召回与摘要入库是自动的。除此之外，agent 会代你使用这五个工具：

| 你说 | 发生什么 |
|---|---|
| "记住：本项目禁止使用 eval" | `memory_remember` 在当前项目 scope 下存入一条用户确认的规则 |
| "关于重试策略我们知道些什么？" | `memory_search` 返回本项目的记忆，并标注为参考资料 |
| "忘掉旧 API 的相关内容" | `memory_forget_preview` 先列出确切条目；`memory_forget_confirm` 只删除你批准的那些 |
| "刚才那条真的存下来了吗？" | `memory_status` 汇报已校验、待处理、不确定的数量 |

知识图谱管理类操作 —— shelf、归档、向量模型、导出，或刻意不限 scope 的全图检索 —— 由 `hypatia` skill 直接驱动 CLI，该路径确实需要 `danger-full-access`。

## 工作原理

```text
DSH 持久会话日志
        |
        | 轮次通知、压缩摘要
        v
dsh-hypatia 宿主插件
  - 记忆授权（独立于文件沙箱）
  - 项目/scope 推导、来源溯源、稳定 operation ID
  - node:sqlite 控制账本与重试队列
  - 召回缓存、截止时间与上下文预算
        |
        | execFile(hypatia 绝对路径, 固定 argv)   shell: false
        v
未经修改的 Hypatia CLI
```

| 模块 | 职责 |
|---|---|
| `src/policy.js` | 记忆能力，加载时冻结 |
| `src/identity.js` | 项目 scope、稳定命名、operation ID、溯源 |
| `src/ledger/` | 插件自有的 SQLite 控制面 |
| `src/adapter/` | 全插件唯一创建子进程的地方 |
| `src/mutations.js` | 意图 → CLI → 回读校验 → 回执 |
| `src/recall.js` | `agent/pre-step` 中的同请求召回 |
| `src/tools.js` | 收窄的 `memory_*` 工具 |
| `src/ingest/` | 幂等地吸收 DSH 压缩摘要 |

[GOAL.md](./GOAL.md) 是权威架构文档，其中也说明了哪些阶段被刻意暂不实现。

## 配置

全部可选，在 cordis 行上覆盖：

```yaml
- insert:
    - id: dsh-hypatia
      name: 'dsh-hypatia'
      config:
        memory:
          preset: standard      # disabled | read-only-recall | standard | full
        projectId: null         # 让多个 worktree 共用一个 scope
        state:
          dir: ~/.dsh/dsh-hypatia
        adapter:
          shelf: default
          timeoutMs: 10000
          maxConcurrentReads: 1 # 见下文"同时只跑一个进程"
        recall:
          enabled: true
          deadlineMs: 200
          maxResults: 5
          maxBytes: 10240
          hypatiaSupplement: true
          vectorSupplement: false
        ingest:
          compaction: true
        legacyBridge:
          enabled: false        # 已废弃的 TRIGGER/Bash 协议
```

### 记忆授权

记忆能力**独立于 DSH 文件沙箱**。`read-only`、`workspace-write`、`danger-full-access` 管的是 *agent* 能碰什么文件，它们不是记忆授权。预设：

| 预设 | 授予 |
|---|---|
| `disabled` | 无 |
| `read-only-recall` | 仅召回 |
| `standard`（默认） | 召回、语义写入、删除、对账 |
| `full` | 追加全局规则写入与 shelf 管理操作 |

无论预设如何，全局规则写入与整份转录镜像永远不会开放给自动路径。

## 值得了解的边界

这些都是有意为之，插件会如实汇报而不是掩盖。

- **同时只跑一个进程。** 每次 `hypatia` 调用都会打开所有已注册的 shelf，而 DuckDB 会取独占文件锁，因此并发调用会以 `Conflicting lock is held` 失败 —— 在 hypatia 0.1.4 上实测 4 个并发 `hypatia query` 有 3 个失败。因此适配器把所有调用（包括读）串行化。只有在确定没有其他进程会碰同一批 shelf 时，才提高 `maxConcurrentReads`。
- **删除的保证范围是诚实的。** 遗忘会立刻打上墓碑、从当前 shelf 删除并校验其不存在。它无法触及 Hypatia 导出、备份、其他 shelf、用户自建的未知关系，以及 DSH 转录；校验不完整时汇报 `cleanup-uncertain`，而不是宣称成功。
- **向量召回默认关闭。** Hypatia 的 top-K 无法先按 scope 过滤，只能超量取回再过滤。请先在你的数据规模上跑基准，再开启 `recall.vectorSupplement`。
- **后台抽取尚未实现。** GOAL.md 将其标为 NO-GO，直到 Phase 0–2 的故障与安全测试通过；设置 `extraction.enabled` 只会记录一条警告，不改变行为。
- **整份转录镜像尚未实现。** 在其同意、留存与清理前置条件具备之前保持关闭。

## 性能

`npm run bench` 会在自建并自动清理的临时 shelf 上，按配置的召回截止时间测量 CLI。在 hypatia 0.1.4、Node 22.22、darwin/arm64 上实测：

| 记录数 | 并发 | 完整召回 P50 | P95 | 是否满足 200 ms |
|---|---|---|---|---|
| 100 | 1 | 43 ms | 45 ms | 是 |
| 100 | 4 | 93 ms | 176 ms | 是 |
| 500 | 1 | 45 ms | 50 ms | 是 |
| 500 | 4 | 96 ms | 185 ms | 是 |

真正的成本来源是串行化后的并发，而不是数据规模：四个并发会话已逼近截止线，而记录数翻十倍几乎没有影响。如果你的部署需要更高并发，这就是首先要重新测量的数字。

## 开发

```sh
npm test                                    # 全量测试
node --test tests/ledger.spec.js            # 单个文件
npm run bench -- --sizes 100,1000           # 性能门禁
```

`skills/` 由本仓库自行维护 —— 它曾从 hypatia 仓库同步而来，现已解耦。直接编辑 `skills/*/SKILL.md`。

## 从 TRIGGER 桥接迁移

早期版本会注入 `[hypatia-memory] TRIGGER:*` 消息，并要求模型通过 Bash 运行 `hypatia`。该模式已废弃并默认关闭。它会把协议文本写进持久转录，没有持久 operation ID 与写入回执，可能丢失最后一条助手回复，并且把 `danger-full-access` 误当作记忆授权。

只有在迁移期需要让线上部署继续工作时，才设置 `legacyBridge.enabled: true`。它不再新增功能；在你验证新工具期间，它可以与宿主路径并存。

## 许可证

[MIT](./LICENSE)
