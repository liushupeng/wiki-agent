---
title: Agentic RAG
type: concept
created: 2026-08-21
updated: 2026-08-21
sources:
  - raw/agent-runtime.md
  - raw/hybrid-retrieval.md
  - raw/evidence-policy.md
tags:
  - agent
  - rag
  - evidence
  - evaluation
status: active
---

# Agentic RAG

## 核心结论

Agentic RAG 将检索作为 Agent 可规划、可约束、可观测的工具，而不是在模型调用前执行一次固定的 Top-K 查询。

系统由四个闭环组成：

1. Agent 根据任务和当前证据选择检索工具。
2. Hybrid Retrieval 组合词法召回、语义召回与精排。
3. Evidence Policy 判断证据是否足以支持回答。
4. Trace 与 Evaluation 将失败转化为下一轮工程改进输入。

## 检索闭环

`wiki-agent` 的公开示例管线使用以下阶段：

```text
BM25 + Dense
-> RRF fusion
-> chunk rerank
-> source-local selection
-> evidence assembly
-> cited answer
```

精确术语、错误文本和配置名称优先使用 grep；概念与经验问题优先使用语义检索。两种路径共享来源约束和证据账本。

## 证据约束

EvidenceLedger 保存来源、chunk、引用和治理元数据。证据充分性分为：

- `insufficient`：没有足够证据，应明确说明缺口；
- `partial`：存在证据，但覆盖、权威性或一致性不足；
- `sufficient`：证据覆盖任务要求，可形成带引用的回答。

运行时策略限制 RAG 调用次数。预算耗尽后，Agent 只能基于已有证据回答或拒答；检索结果为空时，不允许继续输出无来源断言。

## 知识治理

KnowledgeCatalog 为来源记录版本、状态、权威性、质量、有效期和冲突状态。非 active 文档不会进入新索引，低权威或冲突证据会降低充分性判断。

治理的目标不是让模型自动决定真相，而是让来源选择和冲突处理变得可审阅、可追踪。

## 评测闭环

公开评测分为三层：

- 开发集用于定位召回和排序瓶颈；
- source-disjoint Holdout 用于阶段性验收；
- Agent E2E 同时检查答案、证据、工具预算和执行轨迹。

TaskContract 负责确定性约束，人工 rubric 负责正确性、完整性、Groundedness、引用和拒答质量。核心验收不依赖 LLM Judge。

## 待验证问题

- 不同规模语料下，Balanced 与 Deep 模式的延迟拐点在哪里？
- 文档冲突时，治理先验应如何与语义相关性共同排序？
- 多轮任务中，证据预算应按工具调用、来源数还是 token 成本分配？
- 服务化并发场景下，Retriever 复用与 CPU 门控需要怎样的容量模型？
