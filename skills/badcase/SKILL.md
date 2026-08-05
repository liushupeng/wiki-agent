---
name: badcase
description: 当 Agent 失败、回答薄弱、检索遗漏、工具选择错误或用户纠正需要转化为评测与改进数据时使用。
---

# Badcase 收集技能

当用户指出回答错误、证据薄弱、工具使用不当、遗漏来源或执行低效时，使用此技能。

## 目标

将一次失败转化为可持续改进的数据：

```text
失败
-> evaluation/badcases/*.md
-> 评测用例
-> schema、skill、prompt 或 tool 的更新建议
```

## 失败类型

- `retrieval_miss`：未召回相关的 Wiki 或原始来源。
- `routing_error`：选择了错误的工具或工具组。
- `weak_evidence`：结论看似正确，但引用证据不足。
- `hallucination`：声称了没有证据支持的内容。
- `stale_wiki`：维护型 Wiki 内容已经过时。
- `schema_gap`：Wiki 规则没有说明如何处理该情况。
- `permission_gap`：权限或审批行为错误地允许或阻止了操作。

## 工作流

1. 记录用户问题与预期行为。
2. 概述实际行为。
3. 如有可用的追踪记录，检查关键 span 与工具调用。
4. 归类失败类型。
5. 在 `evaluation/badcases/` 下创建 badcase Markdown 文件。
6. 在 `evaluation/questions.json` 中新增或建议新增检索评测题。
7. 建议最小、可持续的修复：schema、skill、prompt、工具说明、测试或评测。

## Badcase 模板

```markdown
# 简短标题

## 用户问题

## 预期行为

## 实际行为

## 失败类型

## 证据

## 追踪说明

## 修复计划

## 候选评测题
```
