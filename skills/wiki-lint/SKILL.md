---
name: wiki-lint
description: 用于检查维护型 Wiki 的孤立页面、缺失引用、过时结论、重复概念和冲突。
---

# Wiki 质量检查技能

当用户要求检查 Wiki 质量、一致性、过时页面、缺失链接或冲突时，使用此技能。

## 检查项

1. 阅读 `wiki/AGENTS.md`、`wiki/index.md`、`wiki/log.md` 和 `wiki/contradictions.md`。
2. 检查重要页面是否列在 `wiki/index.md` 中。
3. 查找缺失 frontmatter 或 `sources` 的页面。
4. 查找未从 index 或相关页面链接的孤立页面。
5. 查找语义重叠的重复概念。
6. 检查结论是否已被较新的来源摘要淘汰。
7. 识别值得建立 concept 页面的重要高频术语。
8. 报告应添加到 `wiki/contradictions.md` 的未解决冲突。
9. 给出建议写入 `wiki/log.md` 的记录。

## 输出要求

- 按严重程度报告问题：阻塞、警告、建议。
- 每项问题都应包含页面路径和具体修复建议。
- 默认将 lint 视为只读；仅在用户明确要求应用发现结果时，才更新 `wiki/contradictions.md` 或 `wiki/log.md`。
- 优先建议能改善 Wiki 导航的小型维护编辑。
