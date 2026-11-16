---
title: 在线评估采用健康度监控与同题回放
type: decision
created: 2026-08-25
updated: 2026-08-25
sources:
  - docs/system-guide.md
  - docs/project-reference.md
  - src/harness/index.ts
  - scripts/observability/summarizeOperations.ts
  - scripts/observability/harvestBadCases.ts
tags:
  - evaluation
  - observability
  - bad-case
status: active
---

# 在线评估采用健康度监控与同题回放

## 决策

`wiki-agent` 不建设百分比切流或搜索广告式在线 A/B 平台。真实运行质量闭环采用三层：

1. 离线题集继续作为检索与 Agent 变更门禁。
2. 本地 JSONL Trace 汇总运行健康度和无金标风险代理指标。
3. 从疑似 Trace 收割 bad case，经人工补金标后复核原轨迹，并在当前环境重跑。

完整流程是：

```text
ask Trace
-> ops:summary
-> trace:harvest
-> 人工标注
-> eval:verify
-> eval:agent
-> evaluation/badcases 回归集
```

## 理由

项目当前是 local-first CLI，不具备多租户服务的大流量、独立请求和点击转化指标。稀疏且会话相关的提问无法为百分比切流提供稳定统计功效。

Trace 已能记录工具、RAG、证据、成本和终止过程。补齐最终策略、检索身份与可选 run artifact 后，可以用更低成本发现风险并保留复现线索。

## 口径

- `insufficient | partial | sufficient` 描述已检索证据库存，不是答案正确率。
- fallback、空检索、预算耗尽和 forced abstention 都是候选信号，不自动等价为故障。
- `eval:verify` 只检查已有轨迹，不重新调用模型。
- `eval:agent` 在当前环境重新执行；模型、构建和索引身份差异必须进入报告。
- 精确历史复现还要求保存对应代码和索引快照，本决策只保证检测身份不一致。

## 隐私

完整 query 与最终回答只在显式启用 run artifact 时脱敏后写入本地 `var/`。脱敏不能保证删除所有个人或业务信息，因此产物不得自动进入版本控制或公开评测集。
