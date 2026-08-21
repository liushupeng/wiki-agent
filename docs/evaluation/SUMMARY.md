# 公开评测摘要

本文记录 `wiki-agent` 在仓库内公开技术语料上的可复现评测结果。题集、语料与评测代码均进入版本控制；本地模型、索引、模型回答和 Trace 不进入 Git。

## 公开数据集

- 语料：`examples/public-knowledge/` 下 25 篇原创技术摘要
- 开发语料：10 篇，覆盖 HTTP、SQL、Git、Docker、Kubernetes、TypeScript、Node.js、测试、可观测性和 Web 安全
- Holdout 语料：15 篇，与开发集 expected source 零重叠
- 开发集：50 题
- Holdout：15 题、15 个唯一来源
- Agent E2E：12 个任务，其中 10 个可回答任务、2 个证据不足负例

这些数据只包含通用技术事实，不依赖个人笔记、雇主资料或未公开公司信息。

## 检索结果

### 开发集

- 日期：2026-08-21
- 语料变体：`raw-only`
- 检索配置：`hybrid-bge-m3-metadata-source-aggregate-v1`
- 严格通过：50/50（100%）
- 候选 Recall@20：100%
- 候选 Recall@100：100%
- 最终 Hit@5：100%
- 最终 Hit@1：100%
- MRR@5：1.000
- 单题总耗时：P50 38.2 秒，P95 61.6 秒

### 独立 Holdout

- 日期：2026-08-21
- 语料变体：`raw-only`
- 检索配置：`hybrid-bge-m3-metadata-source-aggregate-v1`
- 严格通过：15/15（100%）
- 候选 Recall@20：100%
- 候选 Recall@100：100%
- 最终 Hit@5：100%
- 最终 Hit@1：100%
- MRR@5：1.000
- 单题总耗时：P50 39.4 秒，P95 50.7 秒

“严格通过”要求最终 Top-5 命中预期来源，且预期关键词只能由该来源贡献。Holdout 的来源没有出现在开发集标注中，不参与 profile 参数选择。

本次是新语料上的首次冷启动评测：候选缓存命中率为 0%，本地 CPU BGE Reranker 是主要延迟来源。结果证明公开 fixture 与完整检索管线可以复现，不代表当前配置已达到在线服务延迟要求。

## Agent E2E 结果

- 日期：2026-08-21
- 代码 commit：`72de58ff6c822c1e17075f89be3acf6b15bfe6bd`
- 题集 SHA-256：`8a7bf42b4e09d9b57220010700aebad01bfb9676ea72cd952b927de02eac9f22`
- 模型：`deepseek-v4-flash`
- 温度：0.1
- 检索配置：`hybrid-bge-m3-metadata-source-aggregate-v1`
- TaskContract：10/12（83.3%）
- 人工 rubric：12/12
- 工具执行失败：0
- 平均步骤：2.67
- 端到端延迟：P50 83.3 秒，P95 185.4 秒
- 实际 token：输入 128,052，输出 11,770，共 139,822

两个 TaskContract 失败都来自 `answer.required_phrase`：模型明确拒绝了无证据问题，也没有编造数值，但分别使用“没有记录 / 没有任何……证据”，没有逐字命中契约中的“没有找到 / 未找到 / 证据不足 / 无法确认”。人工复核确认两题均满足 required facts、没有 forbidden claim，因此记录为确定性词面检查的 false negative，而不是 Agent 拒答失败。为避免在验收集上追着结果修改标准，本快照不回改契约。

E2E 题集覆盖：

- 单来源事实；
- 多条件回答；
- 跨来源综合；
- 指定来源解释；
- 无证据时明确拒答。

10 个可回答任务的 TaskContract 全部通过；2 个无证据负例均正确拒绝。

## 评测方法

检索评测逐阶段记录 BM25、Dense、RRF、Chunk Reranker、来源内检索、Evidence 组装和最终排序。Agent 评测同时使用：

1. 可离线重放的 `TaskContract + TrajectoryVerifier`；
2. 不依赖 LLM Judge 的人工 rubric；
3. 包含工具调用、证据来源、预算和终止原因的 JSONL Trace。

题集与评测代码位于 [`evaluation/`](../../evaluation/)，公开语料位于 [`examples/public-knowledge/`](../../examples/public-knowledge/)，完整设计见[项目参考文档](../wiki-agent-project-reference.md)。

## 复现

构建公开语料上的两个物理索引：

```bash
npm run index:knowledge -- -- --profile bm25-v1 --variant raw-only
npm run index:knowledge -- -- --profile bge-m3-v1 --variant raw-only
```

检索开发集：

```bash
npm run eval:recall -- -- --retrieval-profile hybrid-bge-m3-metadata-source-aggregate-v1 --variant raw-only --retriever vector
```

独立 Holdout：

```bash
npm run eval:recall -- -- --retrieval-profile hybrid-bge-m3-metadata-source-aggregate-v1 --variant raw-only --retriever vector evaluation/holdout/questions.json
```

Agent 端到端评测：

```bash
npm run index:knowledge -- -- --profile bm25-v1 --variant raw-wiki
npm run index:knowledge -- -- --profile bge-m3-v1 --variant raw-wiki
npm run eval:agent -- -- --retrieval-profile hybrid-bge-m3-metadata-source-aggregate-v1 --variant raw-wiki --all --preflight --max-steps 8 --max-output-tokens 2048 evaluation/e2e/questions.json
npm run eval:agent -- -- --retrieval-profile hybrid-bge-m3-metadata-source-aggregate-v1 --variant raw-wiki --all --max-steps 8 --max-output-tokens 2048 evaluation/e2e/questions.json
```

Recall 复现不需要私有语料或付费模型，但需要下载 BGE-M3 与 Reranker。Agent E2E 需要兼容的 LLM API，并会产生 token 成本。

## 适用边界

- 公开语料规模小、文档边界清晰，100% 指标不等价于通用问答准确率。
- 开发集指标不能代替 source-disjoint Holdout。
- 合成技术事实适合验证管线可复现性，不替代真实复杂语料上的历史工程经验。
- Agent 结果依赖模型版本、服务状态、本地 CPU 和索引缓存。
- 当前性能数据来自单机 CPU，不代表服务化并发性能。
- 新结果必须保留日期、代码版本、题集 SHA 和检索配置，不能覆盖旧快照。
