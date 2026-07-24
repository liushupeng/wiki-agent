---
name: note-curation
description: 当用户要求整理、总结、关联或改进本地 Markdown 笔记时使用。
---

# 笔记整理技能

## 触发场景

用户要求整理知识体系、总结某组笔记、发现重复主题、生成索引页、找关联概念或改进笔记结构。

## 方法

1. 先用 `search_notes` 找相关笔记片段，不要凭空总结。
2. 如果用户指定笔记路径，使用 `read_note` 读取该笔记的索引片段。
3. 使用 `related_notes` 发现相邻主题、重复概念和可建立链接的笔记。
4. 输出时区分原文事实、结构化整理和你的建议。
5. 如果建议新建链接或标签，说明依据来自哪些笔记。
6. 只有需要按文件路径进行 `grep_search` 或 `glob_search` 时，才先加载 `filesystem` tool group。

## 可用工具

- 默认 core 工具：`search_notes`、`read_note`、`related_notes`
- 需要加载 `filesystem` tool group：`grep_search`、`glob_search`
