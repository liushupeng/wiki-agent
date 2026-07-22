# 12-Factor Agents：对 wiki-agent 的借鉴

## 来源

- 本地资料：[12-factor-agents](../../../12-factor-agents/)
- 阅读日期：2026-07-22
- 原始资料：<https://github.com/humanlayer/12-factor-agents>

该资料讨论长时运行、可恢复的 Agent 应如何组织控制流、状态和人机协作。以下内容仅记录与本项目相关的工程启发。

## 核心观点

| Factor | 要点 | 对 wiki-agent 的含义 |
|---|---|---|
| 1. Natural language to tool calls | 自然语言负责高层决策，工具调用承载可执行动作 | 保持 `search_notes`、`grep_notes`、`read_note`、`related_notes` 的参数化接口，不把业务流程硬编码进提示词。 |
| 2. Own your control flow | 控制循环属于应用，不应完全交给框架黑箱 | `WikiAgent.run()` 持有轮次、工具执行、失败治理与结束条件。 |
| 3. Own your context window | 上下文是有限且需要主动管理的资源 | 工具结果预算、记忆压缩与按需加载 Skill 都应由项目明确控制。 |
| 4. Tools are structured outputs | 工具返回应机器可读、可诊断、可恢复 | `ToolResult` 保留状态、数据、错误和元数据；失败不伪装成普通文本。 |
| 5. Unify execution and business state | 执行状态与业务状态都需可查询、可恢复 | 当前项目已记录运行轨迹；若未来引入任务队列，应将任务状态显式持久化。 |
| 6. Launch/pause/resume with human input | 人工确认应成为控制流的一部分 | 高风险写入类 MCP 工具应通过权限策略暂停并等待明确决策。 |
| 7. Contact humans with tools | 主动通知属于工具能力，而非模型自由文本 | 当前 CLI 场景暂不需要；未来接入消息渠道时，应封装为受权限控制的工具。 |
| 8. Own your prompts | 提示词应版本化、可审查、可回归验证 | 系统提示位于 `src/prompts/systemPrompt.ts`，并以 Agent Policy 测试约束关键行为。 |
| 9. Compact errors | 错误应包含足够的可操作信息，但不污染上下文 | 工具失败返回结构化错误；连续相同失败触发熔断，避免重复消耗 token。 |
| 10. Small focused agents | 仅在上下文隔离或职责边界确有收益时拆分子 Agent | 当前单 Agent + 专用工具足够；大规模检索或异步研究任务才评估拆分。 |
| 11. Trigger from anywhere | 入口可多样，但核心任务模型应保持一致 | 当前以 CLI 为入口；未来 HTTP、定时任务或事件触发应复用同一运行核心。 |
| 12. Stateless reducer | 通过可重放事件构造状态，降低恢复与调试成本 | 现有 JSONL trace 可回放执行路径；真正的任务恢复仍需单独设计状态快照。 |

## 已落地的映射

| 设计 | 对应实现 | 价值 |
|---|---|---|
| 应用持有 Agent 循环 | `src/agent.ts` | 限制轮次、处理工具请求与最终回复的边界由本项目掌控。 |
| 显式、结构化的工具结果 | `src/types.ts`、`src/tools/executor.ts` | 让模型、日志和 trace 都能区分成功、失败及熔断。 |
| 连续失败熔断 | `src/tools/executor.ts` | 相同工具和参数连续失败两次后，第三次返回 `retry_limit_reached`。 |
| 工具结果上下文预算 | `src/context/toolObservation.ts` | 长结果在进入模型上下文前被压缩，控制 token 与上下文噪声。 |
| 可观测的执行树 | `src/trace/telemetry.ts`、`src/trace/export.ts` | `wiki_agent.run`、step、模型、工具和 RAG 操作拥有明确 span 父子关系。 |
| 人工权限边界 | `src/tools/executor.ts` | 工具执行可接入审批策略，不由模型单方面越权决定。 |

## 建议后续采纳

1. **可恢复任务状态**：若 `ask` 演进为长时、异步任务，为任务定义持久化状态（输入、进度、待审批动作、结果引用），而不是仅依赖 trace。
2. **暂停/恢复协议**：将“等待用户确认”从当前进程内流程扩展为可持久化的 `paused` 状态，恢复时重新建立必要上下文。
3. **触发器与运行核心分离**：新增 HTTP、计划任务或事件入口前，先提取稳定的任务命令模型，避免各入口复制 Agent 装配逻辑。
4. **子 Agent 隔离评估**：仅针对“高噪声、大规模检索、结果可摘要”的任务试验子 Agent；以 token、延迟和回答质量的评测结果决定是否保留。

## 暂不采纳

- **工作流/队列基础设施**：当前本地 CLI 的任务时长与并发度不足以抵消引入队列、数据库和恢复协议的复杂度。
- **常驻多 Agent 编排**：现有 RAG 工具已经提供较细粒度能力，过早拆分会增加上下文传递、调试和评测成本。
- **对外主动消息工具**：项目尚未有通知或协作产品需求，应在实际渠道与权限模型明确后再设计。

## 采纳判断

该资料最重要的提醒不是“实现全部 12 项”，而是将 Agent 视为受应用控制的、可观测的状态机。wiki-agent 已具备控制流、结构化工具结果、失败治理和 trace 基础；下一阶段的重点应是用真实长任务验证是否需要持久化恢复，而非提前堆叠工作流基础设施。
