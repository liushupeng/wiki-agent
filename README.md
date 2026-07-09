# wiki-agent

`wiki-agent` 是一个面向个人和团队知识库的 Agentic RAG 助手。项目目标是连接多种知识来源（Markdown 笔记、文档库、网页、数据库、API 等），由 Agent 根据任务自主规划检索、读取和推理步骤，并基于可引用证据生成回答。

当前版本聚焦本地 Markdown 笔记库和基础 Coding Agent 能力，提供索引构建、结构化切分、轻量检索、工具调用、HITL 审批、权限策略、运行 trace 和基础评测能力。

## 架构

项目由运行时源码、知识源、索引产物、技能提示词和文档组成：

```bash
wiki-agent/
├── src/                  # Agent 运行时源码：loop、memory、tools、RAG、sandbox、trace
├── skills/               # 启动时加载进 system prompt 的任务方法和行为策略
├── notes/                # 默认 Markdown 知识源示例，可替换为外部笔记库
├── knowledge/            # RAG 索引、评测问题和生成产物（如 knowledge/index.json）
├── docs/                 # 学习文档、业务实践说明和代码导读
├── .env.example          # 运行配置模板：模型、沙箱、trace、RAG 参数
├── package.json          # npm 命令和依赖声明
└── package-lock.json     # 依赖锁定文件
```

`src/` 包含 Agent 运行时实现：

```bash
src/
├── main.ts              # 程序入口：初始化 Agent、工具和记忆
├── agent.ts             # 核心智能体循环 + ToolRegistry
├── memory.ts            # 对话记忆管理（system prompt + 历史消息）
├── types.ts             # TypeScript 接口（IAgent, IAgentTool, IMemory 等）
├── permissions.ts       # 工具风险级别、审批和 Shell 命令权限策略
├── limits.ts            # 工具输出和文件读取大小限制
├── sandbox.ts           # 沙箱路径解析与越权保护
├── trace.ts             # Agent 运行 trace 记录
├── rag/                 # RAG chunk、embedding、检索（当前支持 Markdown-aware）
├── scripts/             # 知识库索引与评测脚本
└── tools/
    ├── base.ts          # 抽象基类 BaseAgentTool
    ├── fileTool.ts      # 文件系统工具（list_dir, read_file, write_file）
    ├── searchTool.ts    # 只读搜索工具（glob_search, grep_search）
    ├── ragTool.ts       # 知识库检索工具（当前提供 search_notes, read_note, related_notes）
    ├── codingTool.ts    # Coding Agent 工具（git_status, git_diff, apply_patch, run_tests）
    └── shellTool.ts     # Shell 命令执行工具
```

**核心设计：**

- **ReAct 循环** — Agent 迭代执行“模型决策 -> 工具调用 -> 观察结果 -> 重新规划”的控制流。当模型不再请求工具调用或触发熔断器时，循环结束。
- **工具注册中心** — 工具通过 `ToolRegistry` 统一注册和分发。新增工具只需实现 `BaseAgentTool` 并在入口注册，Agent 核心不依赖具体工具实现。
- **权限分级与并发调度** — 工具分为 `read` / `write` / `shell` / `rag`，并声明 `riskLevel`。同一轮只读工具可并发执行，有副作用工具串行执行并受审批策略保护。
- **HITL 审批** — `write`、`shell`、`network` 等风险工具默认进入人工确认流程。CLI 会展示工具名、风险级别、审批原因和参数，并等待用户确认。
- **工具结果标准化** — 工具统一返回 `{ status, data, error, metadata }`，Agent trace 可稳定记录状态、参数、耗时和摘要。
- **流式响应** — LLM 响应通过 OpenAI SDK 流式传输。文本增量实时输出，工具调用增量按索引组装为完整请求。
- **Agentic RAG** — 知识检索以工具形式暴露给 Agent，由 Agent 自主决定检索、读取和关联策略。当前内置工具包括 `search_notes`、`read_note` 和 `related_notes`。
- **可扩展知识源** — Markdown 索引保留标题层级、frontmatter、tags、`[[wiki links]]` 和来源引用。后续可扩展到网页、数据库、API、PDF 等知识源。
- **Trace 可观测性** — 每次运行都会在 `traces/` 生成 JSONL，记录 step、工具调用、结果摘要和耗时。
- **沙箱隔离** — 文件工具将路径限制在 `C:\AgentSandbox` 内，并阻止目录穿越。Shell 工具使用命令 allowlist 和危险 token 拦截，并强制 `cwd` 为沙箱目录。
- **上下文与输出控制** — Memory 支持消息数和字符预算；文件读取、Shell 输出、Git diff 和测试输出会按配置截断，避免大结果污染上下文。
- **错误反馈** — 工具执行错误会被捕获并序列化为 JSON observation，反馈给模型用于后续规划。
- **熔断器** — `maxLoopSteps`（默认 20）限制单次任务的最大规划步数，避免非预期资源消耗。

## 技术栈

| 层级 | 技术 |
|---|---|
| 语言 | TypeScript 6.x (ESM) |
| 运行时 | Node.js |
| LLM SDK | OpenAI SDK（指向 DeepSeek API） |
| 开发运行 | tsx（无需预编译） |

## 配置

`.env.example` 提供主要运行时配置：

- `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL_NAME`：模型服务配置。
- `AGENT_SANDBOX_ROOT`：文件和通用 Shell 工具的沙箱根目录。
- `AGENT_WORKSPACE_ROOT`：Coding Agent 工具的工作区根目录，默认使用当前进程目录。
- `APPROVAL_MODE`：审批模式，支持 `prompt`、`auto`、`deny`。
- `TOOL_OUTPUT_MAX_CHARS` / `READ_FILE_MAX_BYTES`：工具输出和文件读取上限。
- `MEMORY_MAX_MESSAGES` / `MEMORY_MAX_CHARS`：上下文压缩触发阈值。
- `TRACE_DIR`：JSONL trace 输出目录。

## 安装

```bash
npm install
cp .env.example .env   # 编辑 .env 填入你的 DeepSeek API Key
```

## 使用

```bash
npm run dev                              # 启动多轮 REPL
npm run ask -- "检索我的 Agent 笔记"      # 单次运行
npm run index:notes -- notes             # 将 notes/ 索引到 knowledge/index.json
npm run eval:rag                         # 用 knowledge/eval-questions.json 评测 RAG 命中率
npm test                                 # 构建并运行 Node 内置测试
npm run build                            # 编译 TypeScript 到 dist/
npm start                                # 运行编译后的 JS
```

系统提示词在 `src/main.ts` 中配置。`skills/` 下的 Markdown 文件会在启动时加载进系统上下文，用于提供可复用任务策略。

## 当前支持：本地 Markdown 笔记

1. 将 Markdown 笔记放入 `notes/`，或通过命令行参数指定外部目录。
2. 运行 `npm run index:notes -- notes` 生成 `knowledge/index.json`。
3. 启动 REPL 后提交问题，Agent 会按需调用 `search_notes`、`read_note` 或 `related_notes`。
4. 回答结果包含可用的 `source`、`titlePath`、`tags`、`links` 和 citation。
5. `knowledge/eval-questions.json` 提供固定评测问题，可通过 `npm run eval:rag` 评估检索命中情况。

## 知识库工具

- `search_notes`：按问题或关键词检索当前已索引的 Markdown 笔记。
- `read_note`：按相对路径读取某篇笔记在索引中的结构化片段。
- `related_notes`：根据某篇笔记的标题、正文、tags、wiki links 找相关笔记。

## Coding Agent 工具

- `glob_search` / `grep_search`：在沙箱内执行文件名和文本搜索。
- `git_status` / `git_diff`：读取工作区 Git 状态和 diff。
- `apply_patch`：在工作区内执行单文件精确替换，默认需要审批。
- `run_tests`：在工作区运行测试或构建命令，默认需要审批。
- `execute_command`：在沙箱内执行 allowlist 命令，默认需要审批。


## 安全性

- 文件操作限制在 `AGENT_SANDBOX_ROOT` 内，默认 `C:\AgentSandbox`，具有路径穿越保护。
- Shell 执行采用 allowlist 和危险 token 拦截，并强制超时。
- `write_file`、`apply_patch`、`run_tests` 和 `execute_command` 默认需要 HITL 审批。
- `APPROVAL_MODE=auto` 会跳过人工确认，仅建议在受控环境中使用。
- 工具参数会在执行前校验；无效参数会返回 `invalid_args` observation。
- 大文件读取、Shell 输出、Git diff 和测试输出会按配置截断。
- `src/tests/` 提供最小安全回归测试，覆盖路径沙箱、权限策略和输出截断。
- 默认索引和检索本地文件。若使用云端 LLM，最终被发送的是用户问题和检索出的相关片段。
- 仅建议在受信任环境中运行。当前沙箱是应用层约束，不是容器级隔离。
