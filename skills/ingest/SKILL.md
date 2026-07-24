---
name: ingest
description: 当需要将原始来源整理为维护型 Wiki 页面、更新 `index.md` / `log.md` 并记录冲突时使用。
---

# 知识接入技能

当用户要求将来源添加、整理、接入、编译或维护到 Wiki 时，使用此技能。

## 目标

将一个原始来源转化为可持续维护的 Wiki 结构：

```text
原始来源
-> 来源摘要页
-> 相关概念、项目或决策页
-> `index.md` 更新
-> `log.md` 记录
-> 必要时向 `contradictions.md` 添加记录
```

## 工作流

1. 先阅读 `wiki/AGENTS.md` 并遵循其中 schema。
2. 从配置的 `notes/` 根目录或用户提供的路径读取原始来源。检索结果中的 `raw/` 是逻辑来源前缀，不是文件系统目录。
3. 在 `wiki/sources/` 中创建或更新来源页。
4. 提取可长期维护的概念、项目背景、决策、人物和开放问题。
5. 更新 `wiki/concepts/`、`wiki/projects/`、`wiki/decisions/` 或 `wiki/people/` 下的相关页面。
6. 为每个新增或修改页面在 `wiki/index.md` 中更新一行摘要和链接。
7. 在 `wiki/log.md` 中追加带日期的记录。
8. 新证据若与既有结论冲突，向 `wiki/contradictions.md` 添加条目，不得静默覆盖。

## 输出要求

- 区分有来源支撑的事实与综合推断。
- 引用保留为 Wiki 路径或原始来源路径。
- 优先小而聚焦的页面更新，而非一个包罗万象的大页面。
- 证据不足时，明确记录缺口。
