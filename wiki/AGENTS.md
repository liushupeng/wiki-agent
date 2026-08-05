---
title: Wiki 维护规范
type: schema
status: active
---

# Wiki 维护规范

此目录是由 Agent 维护的 Wiki 层。原始来源仍是事实依据；Agent 负责将 Wiki 页面整理为结构化、可维护的知识资产。

## 分层

- `notes/`：不可变或基本只读的原始来源。
- `wiki/`：用于总结、关联与协调来源知识的维护型 Markdown 页面。
- `var/indexes/`：生成的索引和运行时产物。

## 页面类型

- `source`：单个原始来源的摘要页。
- `concept`：概念或重复出现观点的长期说明页。
- `project`：项目专属的上下文、状态与决策。
- `decision`：包含理由的架构或产品决策。
- `person`：相关人物或组织页面。
- `contradiction`：未解决冲突、过时观点或证据缺口。

## Frontmatter

维护型 Wiki 页面使用 YAML frontmatter。字段名、`type` 与 `status` 枚举值是机器可识别的标识，应保持英文：

```yaml
---
title: 简短、易读的标题
type: source | concept | project | decision | person | contradiction
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - notes/example.md
tags:
  - agent
status: draft | active | needs-review | stale
---
```

## 引用规则

- 每个重要事实性结论都应指向来源页或原始来源路径。
- 不要静默删除相互冲突的结论；应在 `contradictions.md` 中记录冲突。
- 区分有来源支持的结论与 Agent 的综合判断。

## 接入规则

接入原始来源时：

1. 阅读原始来源。
2. 创建或更新对应的 `wiki/sources/*.md` 摘要页。
3. 更新相关的概念、项目、决策或人物页。
4. 更新 `wiki/index.md`。
5. 向 `wiki/log.md` 追加记录。
6. 在 `wiki/contradictions.md` 中记录尚未解决的冲突。

## 问答规则

回答问题时：

1. 优先检索 Wiki。
2. 如果 Wiki 证据缺失或不足，再检索原始来源。
3. 分别引用 Wiki 页面与原始来源。
4. 如果回答形成可长期复用的综合判断，建议将其写回 Wiki。

## 内容质量检查规则

定期检查 Wiki 内容质量时，关注：

- 没有入链的孤立页面（orphan pages）。
- 来源缺失或过时的页面（stale sources）。
- 重复概念（duplicate concepts）。
- 与较新来源冲突的结论（conflict）。
- 高频出现但尚未建立概念页的重要术语。
