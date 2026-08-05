# 《深入理解 AI Agent：设计原理与工程实践》：对 wiki-agent 的借鉴

## 来源

- 本地资料：[ai-agent-book](../../../ai-agent-book/)
- 阅读日期：2026-07-22
- 重点章节：`book/chapter1.md`、`book/chapter2.md`、`book/chapter3.md`、`book/chapter4.md`、`book/chapter6.md`

该书以“Agent = LLM + 上下文 + 工具”为主线，进一步将生产级系统归纳为 `Model + Harness`：除模型外，还应具备上下文、工具、约束、验证和纠正。本文只提炼对本地知识库 Agent 有直接工程价值的部分。

## 核心框架

| 主题 | 核心观点 | wiki-agent 的对应方向 |
|---|---|---|
| Harness 工程 | 模型之外的上下文、工具、约束、验证、纠正决定可靠性 | 用代码管理循环、审批、重试、结果预算和评测，而非只依赖 prompt。 |
| 上下文工程 | 上下文应提供充分、结构化、任务相关的信息；过长会导致成本和注意力退化 | 维持稳定静态前缀；按需加载 Skill；压缩工具观察和记忆。 |
| 缓存友好设计 | 静态提示与工具定义稳定，动态状态追加在末尾 | 避免按轮次重写系统提示或随机变更工具定义顺序；观测 Prompt Cache 命中。 |
| 工具接口 | 清晰的名称、参数、边界、示例与错误信息会显著改善工具选择 | 保持 RAG 工具职责互斥，并返回可操作错误和下一步提示。 |
| RAG | 检索、结构组织、重排序和 Agent 主导的迭代检索各有适用边界 | 继续以词法检索、语义检索、局部阅读和关联检索组合，而非单一“万能搜索”。 |
| 评估 | 评估模型与 Harness 的组合；用真实失败案例驱动回归集 | 已有检索评测和 Agent Policy 测试；下一步补全端到端任务评测。 |
| 可观测性 | trace 应覆盖模型、工具、检索、成本、错误，并能回流为评测资产 | 采用 OpenTelemetry 语义的 JSONL span 与 Jaeger 导出。 |

## 已落地的映射

| 本书观点 | 当前实现 | 说明 |
|---|---|---|
| 控制流、约束、纠正属于 Harness | `src/agent.ts`、`src/tools/executor.ts` | Agent 轮次、工具执行、审批、失败计数和结束条件在应用层实现。 |
| 工具结果必须有预算和信息密度 | `src/context/toolObservation.ts` | 对字符串、数组和对象进行压缩；保留状态、错误和缩减提示。 |
| 对上下文增长做分层处理 | `src/context/memory.ts`、`src/context/toolObservation.ts` | 已实现记忆管理与单次工具观察预算；尚未实现全轨迹压缩。 |
| Agent Skills 按需加载 | `src/skills.ts`、`src/tools/skillTool.ts` | Skill 元数据供路由使用，完整内容通过工具按需读取。 |
| 动态工具暴露 | `src/tools/exposure.ts`、`src/tools/defaultTools.ts` | 默认仅暴露核心工具；文件、Git、SQLite、代码和 shell 能力须先经 `load_tool_group` 启用。 |
| 工具应清晰分工 | `src/tools/ragTool.ts` | `search_notes` 做语义检索，`grep_notes` 做字词/正则定位，`read_note` 做局部证据阅读，`related_notes` 做范围内扩展。 |
| 执行风险分级与人工审批 | `src/permissions.ts`、`src/cli/approvalPrompt.ts`、`src/sandbox.ts` | `PermissionPolicy` 结合工具风险与 `APPROVAL_MODE` 作出 allow、ask 或 deny 决策。 |
| 失败应成为行动信号 | `src/tools/executor.ts` | 工具结果包含结构化错误；对相同失败调用实施重试上限。 |
| 可观测性采用 span 树 | `src/trace/telemetry.ts`、`src/trace/export.ts` | 统一记录 `wiki_agent.run`、step、`gen_ai.chat`、`tool.execute`、RAG 子 span。 |
| 评估要可重复且可诊断 | `src/rag/evaluation.ts`、`scripts/evaluation/evaluateRecall.ts` | 在统一题库上比较候选召回、排序与 Wiki 策略。 |
| 提示规则需要回归保护 | `src/tests/agentPolicy.test.ts` | 对工具路由、安全边界和渐进检索策略做无需 LLM 的契约测试。 |

## 近期优先级

### 1. 将 trace 中的失败案例沉淀为端到端评测

建立脱敏后的任务用例格式，至少覆盖：

- 查询意图 → 应使用的 RAG 工具组合；
- 预期证据来源与关键事实；
- 不应发生的工具调用、越权行为和重复失败；
- 完成质量、轮次、token 和延迟预算。

现有 `agentPolicy.test.ts` 只验证系统提示的静态契约；它不能证明特定模型在真实工具反馈下能完成任务。端到端评测应作为补充，而非替代。

### 2. 为长期任务设计“压缩 + 可回溯”的上下文策略

当前工具结果预算只处理单次观察；当任务跨很多轮时，历史消息仍会增长。建议按价值分层：

1. 保留原始、不可替代的标识符和引用：source、路径、标题、hash、工具调用 ID；
2. 压缩可重新检索的长工具正文，并保留定位信息；
3. 用结构化摘要记录已确认结论、失败路径、未完成事项；
4. 仅在有明确评测和真实长任务证据时启用全量压缩，避免为短 CLI 任务增加额外模型调用。

### 3. 为 RAG 引入端到端质量指标

除了当前 source 命中和词项匹配，还应逐步量化：

- 证据充分性：回答中的关键结论是否有 source 支撑；
- 引用准确性：给出的 source 是否实际包含该结论；
- 检索效率：轮次、工具调用数量、读取 chunk 数与输入字符数；
- 拒答质量：知识库缺少证据时是否明确说明边界而不编造。

评分应优先采用可验证的规则；开放性质量评判如需 LLM-as-a-Judge，先以人工金标样本校准。

### 4. 把 Prompt Cache 作为可测量的优化，而非假设

项目已记录 DeepSeek 的缓存命中/未命中 token。下一步不应仅凭理论调整提示，而应针对稳定前缀、Skill 元数据注入和压缩策略，比较缓存、成本、延迟与任务成功率。

## 暂不采纳

| 主题 | 原因 |
|---|---|
| 稠密向量数据库、ANN、GraphRAG/RAPTOR | 当前本地索引规模与检索需求尚未证明单 JSON 索引成为瓶颈；先用数据量、延迟和召回评测触发迁移。 |
| LLM 维护 Agent 状态栏 | 工具次数、失败次数和预算等应由确定性代码计算；错误的“高可信状态”会系统性误导模型。 |
| 自动后训练或 RL | 该项目仍处于 Harness 与评测建设阶段，缺少稳定任务环境和可靠奖励信号。 |
| 常驻多 Agent 协作 | 只有在上下文隔离或并行任务的收益经评测验证后引入，避免额外的协调与可观测性复杂度。 |

## 对当前项目的结论

本书最适合 wiki-agent 的部分不是新增一个庞大框架，而是把现有设计继续做成可验证的 Harness：

1. 将所有模型可见信息视为需要预算、来源标记和可测量的上下文；
2. 将工具调用视为可约束、可验证、可纠正的状态转换；
3. 将 trace 中真实失败转化为评测样本；
4. 仅在评测显示收益时，才升级索引、压缩或多 Agent 架构。
