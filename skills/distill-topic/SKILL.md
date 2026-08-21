---
name: distill-topic
description: 当需要将某个主题、一次高质量回答、trace 或多份原始来源沉淀为维护型 Wiki 主题页时使用。
---

# 主题沉淀技能

当用户要求把一个主题沉淀进 Wiki、把一次回答写回 Wiki、从 trace 中提炼长期知识、或将多份原始来源综合为概念页时，使用此技能。

## 目标

将临时回答或跨来源证据转化为可持续维护的 Wiki 主题页：

```text
主题 / trace / 高质量回答 / 多个 raw sources
-> 维护型 topic 页面
-> 明确证据、综合和不确定性
-> `index.md` 更新
-> `log.md` 记录
-> 必要时向 `contradictions.md` 添加边界或冲突
```

## 适用场景

- 用户说“把某个主题沉淀到 Wiki”。
- 用户提供一次 `ask` 结果或 trace，希望将其中的稳定结论写入 Wiki。
- 多个原始来源共同指向一个长期主题，例如系统架构、检索策略、Agent 方法论。
- 某个高频问题或 badcase 需要通过 Wiki 页面做持久化干预。

如果任务是接入单个原始来源并为它创建来源摘要页，优先使用 `ingest`。如果任务是回答问题而不是写回 Wiki，优先使用 `wiki-answer`。

## 工作流

1. 先阅读 `wiki/AGENTS.md` 并遵循其中 schema。
2. 明确主题名称、目标页面路径和页面类型。概念或方法论主题通常写入 `wiki/concepts/`。
3. 检索现有 Wiki，确认是否已经存在相同或相近主题页，避免重复创建。
4. 读取用户提供的 trace、回答片段或相关原始来源；检索结果中的 `raw/` 是逻辑来源前缀，不是文件系统目录。
5. 提炼稳定结论，只保留可长期复用的知识，不原样复制一次性回答口吻。
6. 为每个重要结论标注证据来源。证据可以是维护型 Wiki 页面或原始来源路径。
7. 明确区分：
   - `evidence`：来源明确支持的事实或原文观点；
   - `synthesis`：Agent 对多个来源的综合整理；
   - `uncertainty`：仍需用户确认、实战验证或后续补证据的问题。
8. 加载 `filesystem` 工具组后，创建或更新目标 Wiki 页面时必须调用 `write_file` 并传入 `scope: "wiki"`；`filename` 相对于 `wiki/` 根目录，例如 `concepts/agent-rag.md`。不得省略该 scope，否则文件会写入默认 sandbox。
9. 为页面使用 `draft`、`active`、`needs-review` 或 `stale` 标记状态。
10. 更新 `wiki/index.md`，为新增或修改的主题页添加一行摘要和链接；同样使用 `scope: "wiki"`，路径为 `index.md`。
11. 在 `wiki/log.md` 追加带日期的维护记录，说明本次沉淀的输入来源；同样使用 `scope: "wiki"`，路径为 `log.md`。
12. 如果发现来源之间存在冲突、观点归属不清或证据不足，更新 `wiki/contradictions.md`，不要静默消解。
13. 建议重新运行索引，并用原始问题做回归验证。

## 页面结构建议

```markdown
---
title: <主题名>
type: concept
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/example.md
tags:
  - topic-tag
---

# <主题名>

## 核心结论

## 结构框架

## 关键原则

## 证据来源

## 综合判断

## 待验证问题

## 关联页面
```

## 输出要求

- 不要把一次 `ask` 的回答原样粘贴成 Wiki 页面。
- 删除临时对话口吻、过度排版、emoji 和不必要的长表格。
- 保留稳定结论、结构化框架、引用路径和待验证问题。
- 观点归属必须谨慎：区分“用户已经验证的观点”“用户吸收并认可的观点”“来源作者的观点”和“Agent 综合推断”。
- 优先小而聚焦的主题页；主题过大时，拆成多个 concept 页并在父页面建立索引。
- 完成后说明需要运行 `npm run index:knowledge` 重建 `raw-wiki` variant，并建议用原问题回归测试 Wiki-first 是否生效。
