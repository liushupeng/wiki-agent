# Wiki 维护日志

按时间追加的 Wiki 维护记录。

使用以下格式：

```text
## [YYYY-MM-DD] ingest | 来源标题
- 原始来源：notes/raw/example.md
- 更新页面：wiki/sources/example.md, wiki/concepts/example.md
- 说明：本次变更的简短摘要
```

## 记录

## [2026-08-21] distill-topic | Agentic RAG
- 输入：公开技术语料中的 Agent runtime、Hybrid Retrieval 与 Evidence Policy
- 创建：wiki/concepts/agentic-rag.md
- 更新：wiki/index.md
- 来源：agent-runtime.md, hybrid-retrieval.md, evidence-policy.md
- 说明：基于公开合成语料沉淀 Agentic RAG 的检索、证据、治理与评测闭环。

## [2026-08-25] decision | 在线评估闭环
- 输入：真实 ask Trace、运行 SLO、离线 TrajectoryVerifier 与 Agent E2E
- 创建：wiki/decisions/online-evaluation-loop.md
- 更新：wiki/index.md
- 来源：docs/system-guide.md, docs/project-reference.md, src/agent.ts, scripts/observability/
- 说明：确定采用“离线门禁 + 在线健康度 + bad case 同题回放”，不建设百分比小流量平台。
