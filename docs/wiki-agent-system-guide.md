# wiki-agent 架构指南

本文面向希望理解、使用或贡献 `wiki-agent` 的外部读者。
它描述当前代码已经实现的边界、主要运行时组件、关键调用流和扩展方式。

## 1. 系统定位

`wiki-agent` 是一个 local-first 的 TypeScript Agentic RAG 工程：

- 面向本地 Markdown 知识库；
- 使用 OpenAI-compatible Chat Completions API 驱动 Agent；
- 通过受控工具读取、检索或修改本地资源；
- 使用 Hybrid RAG 提供可引用的上下文；
- 使用证据策略约束无证据回答；
- 使用 Trace 和离线评测分离运行调试与质量验证。

它不是多租户 SaaS，也不包含 Web UI、账号系统或远程控制面。
核心运行模式是单机 CLI；模型服务可以远程调用，知识库、索引和运行产物默认保留在本地。

## 2. 顶层边界

```text
User / CLI / Eval Runner
        |
        v
WikiAgent Loop <----> OpenAI-compatible LLM
        |
        +---- Memory
        |
        +---- Tool Registry / Exposure / Executor
                         |
                         +---- Local tools / MCP / Skills
                         |
                         +---- RAG tools
                                  |
                                  v
                     Hybrid Retrieval Runtime
                                  |
                                  v
                    EvidenceLedger + Runtime Policy

Markdown sources -> Offline index pipeline -> BM25 / Dense indexes

Agent / tools -> Trace -> Offline evaluation and review
```

系统分为四个边界：

1. **在线 Agent Runtime**：模型调用、循环控制、工具调度、Memory 和证据策略。
2. **检索 Runtime**：查询 BM25/Dense 索引，融合、重排并生成证据窗口。
3. **离线索引与知识治理**：加载 Markdown、切分、构建索引并绑定语料清单。
4. **可观测性与评测**：记录运行轨迹，离线检查检索结果和 Agent 行为。

Wiki 维护目前主要由 Markdown skill 协议和人工审批驱动。
评测结果不会自动写回知识库。

## 3. Agent Loop

入口位于：

- `src/main.ts`：装配配置、Memory、工具和 Agent；
- `src/agent.ts`：实现 `WikiAgent` 循环。

一次运行的主要过程是：

1. 清空本轮工具失败计数和证据状态；
2. 将用户输入追加到 Memory；
3. 创建运行级 Trace span；
4. 从 Memory 取得模型消息；
5. 根据当前暴露范围和 RAG 预算生成工具 schema；
6. 流式调用模型并组装文本与 tool call；
7. 如果存在 tool call，执行工具并把 observation 写回 Memory；
8. 进入下一步，让模型基于新 observation 重新规划；
9. 如果模型不再调用工具，应用最终答案证据策略并返回；
10. 达到循环上限或发生系统错误时终止，并记录终止原因。

只读工具可以并行执行。
可能产生副作用的工具串行执行，以避免多个写操作同时修改外部状态。
工具结果始终按模型原始 tool call 顺序写回消息历史。

`maxLoopSteps` 限制单次任务的规划轮数。
这个限制控制成本和失控循环，但不保证模型一定完成任务。

## 4. 工具体系

### 4.1 Tool Registry

`src/tools/registry.ts` 的 `ToolRegistry` 负责：

- 按名称注册工具；
- 生成模型可见的 function schema；
- 根据名称查找工具；
- 将已解析的调用委派给具体工具。

公共工具契约定义在 `src/types.ts`。
工具需要声明名称、schema、权限类别、风险级别和只读属性，并返回统一的 `ToolResult`。

### 4.2 Tool Exposure

`src/tools/exposure.ts` 的 `ToolExposureController` 控制模型当前能看到哪些工具。

默认只暴露 `core` 组，包括知识检索、笔记读取、skill 加载和工具组加载。
模型可通过 `load_tool_group` 按需启用：

- `filesystem`
- `git`
- `sqlite`
- `coding`
- `shell`

按需暴露减少每轮工具 schema 的上下文成本，也缩小默认能力面。
它不是安全沙箱；真正的执行决策仍由权限、审批和各工具内部校验承担。

### 4.3 Tool Executor

`src/tools/executor.ts` 的 `ToolExecutor` 是工具调用的统一执行边界：

1. 查找工具；
2. 解析 JSON 参数；
3. 运行工具级参数校验；
4. 调用 `PermissionPolicy` 得到 `allow | ask | deny`；
5. 在需要时请求用户审批；
6. 委派给 Registry 执行；
7. 把异常转换为结构化 observation；
8. 记录相同参数的连续失败，并在达到上限后停止重复执行。

路径沙箱、写入 scope、超时和输出限制由对应配置及工具实现共同承担。
新增高风险工具时，不应绕过 Executor 直接执行。

### 4.4 MCP 与 Skills

MCP 工具通过适配器转换为统一的 Agent tool。
本地 skills 是按需加载的操作协议，用于提供特定任务的步骤和约束。

两者都扩展 Agent 能力，但不自动获得信任：

- MCP 服务的实际权限取决于其进程和配置；
- skill 文本是模型上下文，不是强制隔离机制；
- 涉及写入或命令执行的能力仍应经过权限与审批。

## 5. Memory

Memory 实现位于 `src/context/`，主要入口是 `MemoryManager` 和 `MemoryStore`。

运行时需要维护：

- 当前对话消息；
- 工具调用与工具 observation；
- 压缩后的上下文快照；
- 可选的长期记忆提案；
- 供轨迹分析使用的结构化步骤记录。

当上下文增长时，Memory 可压缩较早消息并保留近期交互。
工具 observation 进入上下文前会经过大小控制，避免单个结果占满窗口。

长期记忆不是任意自动写入。
设计路径是先提出候选内容，再做校验和审批，最后事务化保存。
部署者仍需把 Memory 文件视为可能包含用户数据的本地敏感产物。

## 6. Hybrid RAG

RAG 实现位于 `src/rag/`，工具入口位于 `src/tools/ragTool.ts`。

核心工具包括：

- `search_notes`：混合语义检索；
- `grep_notes`：确定性文本匹配；
- `read_note`：读取来源内容；
- `related_notes`：查找相关笔记。

典型 Hybrid Retrieval 流程：

1. 根据 product mode 选择 retrieval profile；
2. 加载与目标语料 manifest 匹配的索引；
3. 执行 BM25 稀疏召回；
4. 执行 BGE-M3 Dense 召回；
5. 使用 Reciprocal Rank Fusion 合并候选；
6. 使用 reranker 和元数据特征精排；
7. 在同一来源内选择更准确的 anchor；
8. 扩展相邻片段形成 evidence window；
9. 返回带来源、chunk 和治理元数据的结果。

支持的常用检索档位为 `fast`、`balanced` 和 `deep`。
不同档位在候选规模、重排和回退行为上取舍延迟与召回。

Dense 索引使用本地 embedding 模型和 LanceDB。
首次使用 Hybrid 模式通常需要下载模型。
BM25 可用于无需 Dense 模型的本地验证。

索引与查询必须使用兼容的 profile、variant 和 manifest。
运行时会尽量拒绝明显不匹配的索引，避免静默查询过期语料。

## 7. EvidenceLedger 与运行时证据策略

`src/context/evidenceSufficiency.ts` 的 `EvidenceLedger` 记录本轮 RAG observation 中的证据：

- 来源与 chunk；
- 引用位置；
- 查询；
- 版本、权威性与一致性；
- observation 是否被截断。

账本去重后给出三态评估：

- `insufficient`：没有可用证据；
- `partial`：有证据，但存在缺项、冲突、低权威或截断等问题；
- `sufficient`：满足当前评估要求。

`src/context/runtimeEvidencePolicy.ts` 的 `RuntimeEvidencePolicy`：

- 统计 RAG 调用；
- 把证据库存和剩余预算反馈给模型；
- 预算耗尽后从后续模型请求中隐藏 RAG 工具；
- 当本轮使用过 RAG、却没有任何可引用证据时，将无依据的最终回答替换为明确拒答。

这些机制是 groundedness 的运行时护栏，不是事实正确性的证明。
只要存在一条证据，最终覆盖度仍主要由模型判断；策略不会验证答案中的每个断言。

## 8. 索引与 KnowledgeCatalog

离线索引管线负责：

1. 从配置指定的 source roots 加载 Markdown；
2. 规范化来源并切分文本；
3. 使用 KnowledgeCatalog 过滤不应索引的文档；
4. 将治理元数据装饰到 chunk；
5. 构建 BM25 或 Dense 索引；
6. 写入与语料、配置和模型身份绑定的 manifest。

`src/rag/knowledgeCatalog.ts` 的 `KnowledgeCatalog` 描述来源治理状态：

- 生命周期：`active | superseded | archived | quarantined | deleted`
- 权威性：`high | normal | low`
- 一致性：`clear | conditional | conflicted | unknown`
- 质量分数、有效期、替代版本和可选 claims

只有 `active` 且处于有效期内的来源会进入索引。
Catalog 元数据也可以参与证据评估和排序。

Catalog 提供治理结构，但不会自动判断元数据是否真实。
维护者仍需审核状态、版本、权威性和冲突标记。

## 9. Trace 与评测

运行时通过 `src/trace/` 和 `src/observability/` 记录：

- Agent run 与 step；
- 模型调用及估算 token；
- 工具名称、状态、时延与权限决策；
- RAG 预算和证据状态；
- 终止原因；
- 可选的脱敏 prompt artifact。

Trace 可写入本地 JSONL，也可导出到 OTLP 后端。
原始 Trace 仍可能包含用户输入、来源路径或工具结果，不能仅因存在脱敏逻辑就视为可公开。

离线质量层包含：

- 检索开发集和 Holdout；
- Recall、Hit@K 等检索指标；
- Agent E2E TaskContract；
- `TrajectoryVerifier` 对 JSONL Trace 的轨迹检查；
- 不依赖 LLM Judge 的人工 rubric 和 review artifact；
- bad case 汇总。

检索指标证明特定语料、问题集和 profile 上的可复现性，不代表通用问答准确率。
真实模型 E2E 可能产生费用，因此不会作为默认 CI 步骤运行。

## 10. 关键调用流

### 10.1 普通知识问答

```text
user
 -> WikiAgent.run
 -> model requests search_notes
 -> ToolExecutor
 -> RetrievalRuntime
 -> BM25 + Dense -> RRF -> reranker -> evidence windows
 -> ToolResult
 -> EvidenceLedger
 -> Memory tool observation + runtime evidence feedback
 -> model replans
 -> RuntimeEvidencePolicy.finalizeAnswer
 -> cited answer or explicit abstention
```

### 10.2 受控写操作

```text
model requests tool group
 -> ToolExposureController activates group
 -> next model step sees write-capable schema
 -> model requests write tool
 -> ToolExecutor validates arguments
 -> PermissionPolicy returns allow / ask / deny
 -> optional user approval
 -> tool enforces path and write scope
 -> structured result returns to Memory
```

### 10.3 索引构建

```text
source configuration
 -> Markdown loader
 -> chunker
 -> KnowledgeCatalog filter/decorate
 -> embed or BM25 encode
 -> vector/sparse store
 -> manifest-bound index
```

## 11. 扩展点

### 新增工具

1. 实现 `IAgentTool` 或继承 `BaseAgentTool`；
2. 提供严格 schema 和参数校验；
3. 正确声明 `permission`、`riskLevel` 和 `isReadOnly`；
4. 注册到默认工具集合；
5. 在 Exposure 中分配适当工具组；
6. 为成功、拒绝、非法参数和异常路径添加测试。

### 新增检索实现或 profile

1. 实现 `Retriever`、`Embedder`、`Reranker` 或存储接口；
2. 在索引和检索配置中增加显式 profile；
3. 保持 manifest 身份校验；
4. 运行开发集和 source-disjoint Holdout；
5. 比较质量、延迟、内存和模型加载成本。

### 新增知识源

1. 在 source 配置中声明受控根目录；
2. 保持稳定、可移植的 source ID；
3. 在 KnowledgeCatalog 中补充生命周期与权威性；
4. 重建所需索引；
5. 检查引用路径不会暴露本地绝对路径。

### 新增评测

评测应同时覆盖最终结果与执行过程。
TaskContract 适合验证工具、预算、证据和终止行为；人工 rubric 适合判断语义质量。
不要在观察结果后修改同一次评测的通过条件。

## 12. 已知边界

- 系统依赖模型遵循工具协议和系统提示，不能保证模型行为完全确定。
- 权限、审批和路径校验降低风险，但不是操作系统级隔离。
- Prompt injection 可能来自用户输入、知识文档、工具输出、MCP 服务或 skill；当前机制不能宣称彻底解决该问题。
- EvidenceLedger 记录检索证据，不验证答案每个句子都被证据支持。
- Hybrid RAG 质量受语料、切分、模型、profile 和 Catalog 元数据影响。
- 默认面向单机运行；公开性能结果不能推导为并发服务容量。
- Wiki 自动维护闭环尚未由统一 TypeScript workflow 完整编排。
- 长期记忆与 Trace 可能保存敏感内容，部署者需自行制定保留和访问策略。
- MCP 和 shell 能力扩大攻击面，只应在可信配置与最小权限下启用。
- 自动测试不调用付费评测，也不能替代依赖审计和人工发布检查。

## 13. 阅读与贡献入口

建议按以下顺序阅读：

1. `README.md`
2. `src/main.ts`
3. `src/agent.ts`
4. `src/tools/registry.ts`、`exposure.ts`、`executor.ts`
5. `src/context/`
6. `src/rag/`
7. `scripts/evaluation/`
8. `docs/evaluation/SUMMARY.md`
9. `docs/security/SECURITY.md`

提交变更前至少运行：

```bash
npm test
npm run check:config
npm run check:knowledge-catalog
```

涉及 RAG 的变更还应使用与目标索引一致的公开数据集运行离线检索评测。
涉及真实模型的 E2E 评测应由维护者显式选择和授权。
