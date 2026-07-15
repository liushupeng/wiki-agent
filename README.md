# wiki-agent

`wiki-agent` 是一个本地优先的 Agentic RAG 助手。它把 Markdown 笔记索引成可检索的知识库，把检索、文件读取、代码观察、测试运行等能力暴露为工具，由 LLM 按任务自主选择工具、读取证据并生成回答。

这个项目采用一个简单的 Agent 视角：

```text
概念上：agent = loop + memory + tool
工程上：agent = loop + memory + tool + policy + observability
```

其中 `loop` 负责持续规划和执行，`memory` 负责保存上下文和任务状态，`tool` 是广义工具，代表模型可调用的外部能力：RAG 检索、skill 加载、文件系统、Shell、API、测试命令都属于这个范畴。`policy` 提供权限、审批、预算和终止约束，`observability` 通过 trace、日志和评测让 Agent 行为可解释、可调试。

项目适合学习和实验：

- Agent loop 如何处理 `tool_calls`。
- RAG 索引、embedding、向量检索如何组合。
- 工具权限、人工审批、沙箱和 trace 如何形成安全边界。
- 多种 chunker、embedding、vector store 如何逐步替换实验。

## 前置要求

需要先准备这些本机依赖：

```powershell
# Node.js / npm
winget install OpenJS.NodeJS
node --version
npm --version

# Git，本地 Git 工具和 Git MCP 都会用到
winget install Git.Git
git --version

# uv / uvx，Git 和 SQLite MCP 使用 uv tool 安装 Python MCP server
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uvx --version
```

项目依赖和 MCP server 工具安装：

```powershell
# 如果是从代码库安装已有依赖，执行这一条即可
npm install

# 如果是从零给项目补齐 npm 依赖，对应的具体包安装命令是：
npm install openai dotenv @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem
npm install --save-dev typescript tsx @types/node

# 安装 Git / SQLite MCP server
uv tool install mcp-server-git
uv tool install mcp-server-sqlite

# 确认 MCP server 命令可被当前 shell 找到
where.exe mcp-server-filesystem
where.exe mcp-server-git
where.exe mcp-server-sqlite

# 检查 MCP server 是否能启动并列出工具
npm run mcp:check
```

安装完成后，`config/mcp.servers.json` 会直接调用 `mcp-server-filesystem`、`mcp-server-git` 和 `mcp-server-sqlite`，启动时不再依赖临时拉取。

还需要准备 DeepSeek 或其他 OpenAI-compatible LLM API key，并写入本地 `.env`。

## 快速开始

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少填入：

```env
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL_NAME=deepseek-v4-pro
```

常用命令：

```bash
npm run dev
npm run ask -- "检索我的 Agent 笔记"
npm run index:notes -- notes
npm run eval:rag
npm run mcp:check
npm test
```

## 目录结构

```text
wiki-agent/
├── src/                 # TypeScript 源码
├── scripts/             # 项目级辅助脚本，例如 RAG 索引和评测
├── skills/              # 可按需加载的 skill Markdown
├── notes/               # 默认 Markdown 知识源示例
├── examples/            # 示例数据，例如 RAG 评测问题
├── config/              # 示例配置，例如 MCP server 列表
├── var/                 # 运行产物：索引、trace 等，不进入 Git
├── docs/                # 代码导读
├── .env.example         # 运行配置模板
└── package.json
```

`src/` 主要模块：

```text
src/
├── main.ts              # CLI 入口，初始化 memory、registry、agent
├── agent.ts             # Agent loop：模型调用、工具调度、trace 写入
├── memory.ts            # 对话记忆和自动压缩
├── trace.ts             # JSONL trace 和 trace level 过滤
├── permissions.ts       # 工具权限决策
├── sandbox.ts           # 本地沙箱路径保护
├── limits.ts            # 工具输出和文件读取限制
├── config.ts            # 环境变量解析
├── cli/                 # CLI 适配器
├── prompts/             # system prompt
├── protocol/            # OpenAI tool-call 协议适配
├── mcp/                 # MCP server 配置、client 和 tool adapter
├── rag/                 # RAG 文档加载、chunk、embedding、vector store、pipeline
├── tools/               # Agent 工具实现
├── utils/               # 通用工具函数
└── tests/               # Node 内置测试
```

## 运行流程

### Agent Loop

```text
用户输入
-> MemoryManager 追加 user message
-> WikiAgent 调用 LLM
-> LLM 返回文本或 tool_calls
-> handleToolCalls 调度工具
-> ToolExecutor 执行权限检查、审批、参数校验和工具调用
-> 工具结果写回 memory
-> LLM 继续规划或输出最终答案
```

`handleToolCalls()` 会按工具的 `isReadOnly` 分流：

- 只读工具并发执行。
- 写文件、Shell、测试等有副作用工具串行执行。
- 工具结果按原始 tool call 顺序写回 memory，保持 OpenAI tool 协议合法。

### RAG 索引

默认索引命令：

```bash
npm run index:notes -- notes
```

默认输出：

```text
var/knowledge/index.json
```

索引数据流：

```text
loadSourceDocuments
-> chunkDocument
-> Embedder.embed
-> VectorStore.upsertChunks
```

默认实现：

- `RAG_CHUNKER=auto`：Markdown 使用 Markdown-aware chunker，文本使用固定长度 chunker。
- `RAG_EMBEDDER=tf`：本地词频向量，不依赖外部 embedding 服务。
- `RAG_STORE=json`：写入 JSON 文件，查询时全量加载并计算余弦相似度。

核心接口在：

- `src/rag/embeddings.ts`：`Embedder`
- `src/rag/vectorStore.ts`：`VectorStore`
- `src/rag/indexPipeline.ts`：索引编排

后续实验 LanceDB、pgvector、Qdrant、OpenAI embedding、本地 embedding 模型时，优先新增 adapter，不需要重写索引入口。

## 工具能力

工具统一继承 `BaseAgentTool`，并声明：

- `name`：LLM 调用工具时使用的唯一名称。
- `schema`：暴露给 LLM 的工具说明和参数结构。
- `permission`：能力类别，例如 `read`、`write`、`shell`、`rag`。
- `riskLevel`：权限策略使用的风险等级。
- `isReadOnly`：决定同一轮工具调用可否并发。
- `requiresApproval`：是否强制人工审批。

工具加载采用“核心工具 + 按需分组”：

- 启动时所有本地工具和 MCP 工具都会注册到 `ToolRegistry`，因此执行层知道完整工具全集。
- 每轮发给 LLM 的 schema 只包含当前已暴露的工具，避免工具数量增长后持续占用上下文。
- 默认暴露 `core` 工具：`search_notes`、`grep_notes`、`read_note`、`related_notes`、`load_skill`、`load_tool_group`。
- 当任务需要文件、Git、SQLite、代码修改或 shell 能力时，LLM 先调用 `load_tool_group` 激活对应分组；下一轮模型调用才会看到该组完整 schema。
- 每个新的用户任务开始前会重置为 `core`，避免 REPL 中上一轮加载过的工具组长期占用后续上下文。

工具分组：

- `core`：RAG 检索、笔记读取、skill 加载和 `load_tool_group`。
- `filesystem`：`list_dir`、`read_file`、`write_file`、`glob_search`、`grep_search`，以及 Filesystem MCP 工具。
- `git`：`git_status`、`git_diff`，以及 Git MCP 工具。
- `sqlite`：SQLite MCP 工具。
- `coding`：`apply_patch`、`run_tests`。
- `shell`：`execute_command`。

启动时会先注册 MCP 工具，再注册本地工具。如果 MCP 已经提供等价能力，本地对应工具会跳过，避免模型同时看到两套做同一件事的工具。当前过滤规则：

- Filesystem MCP 覆盖 `list_dir`、`read_file`、`write_file`、`glob_search`。
- Git MCP 覆盖 `git_status`、`git_diff`。
- `grep_search`、RAG、skill、`apply_patch`、`run_tests`、`execute_command` 仍由本地工具提供。

## MCP 接入

项目通过 `src/mcp/` 提供通用 MCP 接入层：

```text
MCP server config
-> StdioMcpClient
-> listTools()
-> McpAgentTool adapter
-> ToolRegistry
-> LLM tool schema
```

Agent loop 不感知具体 MCP server。Filesystem、Git、SQLite 或后续其他 MCP 都以相同方式接入：在 `.env` 中用 `MCP_CONFIG_PATH` 指向 MCP 配置文件，配置文件声明 stdio server 的 `command`、`args`、工具名前缀和默认风险等级。

```env
MCP_CONFIG_PATH=config/mcp.servers.json
```

MCP tool 的风险等级按以下顺序确定：

- server tool 标注 `readOnlyHint=true` 时视为 `safe`。
- server tool 标注 `destructiveHint=true` 时视为 `write`。
- server tool 标注 `openWorldHint=true` 时视为 `network`。
- 没有 annotation 时使用 server 配置中的 `defaultRiskLevel`。

因此，新增 MCP server 时通常只需要补一段配置；如果某个 server 的工具风险无法通过 annotation 表达，再调整该 server 的默认风险等级。

## 安全边界

### 审批模式

`APPROVAL_MODE` 支持：

- `prompt`：风险工具执行前询问用户。
- `auto`：通过安全检查的工具自动执行。
- `deny`：拒绝所有需要审批的工具。

`PermissionPolicy` 会综合工具风险、Shell 命令 allowlist、危险 token 和审批模式，返回 `allow`、`ask` 或 `deny`。

### 沙箱

文件、搜索和通用 Shell 工具使用 `AGENT_SANDBOX_ROOT`：

```env
AGENT_SANDBOX_ROOT=C:\AgentSandbox
```

`resolveSafePath()` 会拒绝目录穿越。`ShellExecuteTool` 的 `cwd` 固定为沙箱根目录。

Coding 工具使用独立工作区根目录：

```env
AGENT_WORKSPACE_ROOT=.
```

`ApplyPatchTool`、`GitStatusTool`、`GitDiffTool`、`RunTestsTool` 都在该工作区内运行。

## Trace

每次 `WikiAgent.run()` 都会写一个 JSONL trace：

```env
TRACE_DIR=var/traces
TRACE_LEVEL=info
```

基础事件：

- `run_start`
- `step_start`
- `assistant_message`
- `tool_result`
- `run_end`

`TRACE_LEVEL=debug` 时会写入更多内部事件：

- `permission_decision`
- `rag_search`
- `memory_compaction`
- `model_call_budget`

轻量成本观测也写在 trace 中，用字符数和 `chars / 4` 估算 token，不做精确计费：

- `model_call_budget.input`：本轮发给模型的 messages 体量。
- `model_call_budget.toolSchemas`：本轮工具 schema 体量。
- `model_call_budget.output`：本轮模型输出文本体量。
- `tool_result.observation`：单个工具 observation 写回模型前的体量。
- `memory_compaction.before/after`：memory 压缩前后的上下文体量。

建议排查顺序：

1. 看 `run_start.instruction`。
2. 看 `assistant_message.toolCalls`。
3. 看 `tool_result.args`。
4. 看 `tool_result.status` 和 `observationPreview`。
5. 如果怀疑 token 消耗过大，开启 `TRACE_LEVEL=debug`，看 `model_call_budget`、`tool_result.observation` 和 `memory_compaction`。

## Skill 懒加载

启动时只把 `skills/` 下每个 skill 的 `name` 和 `description` 注入 system prompt。任务命中 skill manifest 时，LLM 需要先调用：

```text
load_skill({ "name": "..." })
```

工具返回 skill 全文后，下一轮模型才能按 skill 的具体方法执行。这样避免把所有 skill 全文一次性塞进上下文。

## 配置

`.env.example` 中的主要配置：

```env
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL_NAME=deepseek-v4-pro

AGENT_SANDBOX_ROOT=C:\AgentSandbox
AGENT_WORKSPACE_ROOT=.
MAX_LOOP_STEPS=20
TRACE_DIR=var/traces
TRACE_LEVEL=info
APPROVAL_MODE=prompt

TOOL_OUTPUT_MAX_CHARS=12000
READ_FILE_MAX_BYTES=200000
SHELL_TIMEOUT_MS=5000
SHELL_MAX_BUFFER_BYTES=1048576
RUN_TESTS_MAX_TIMEOUT_MS=120000

MEMORY_MAX_MESSAGES=40
MEMORY_KEEP_RECENT_MESSAGES=18
MEMORY_MAX_CHARS=60000

NOTES_ROOT=notes
KNOWLEDGE_INDEX_PATH=var/knowledge/index.json
RAG_STORE=json
RAG_EMBEDDER=tf
RAG_CHUNKER=auto
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=120
```

## 测试

```bash
npm test
```

测试脚本会清理 `dist/`、编译 TypeScript，然后递归运行：

```text
dist/src/tests/**/*.test.js
```

测试覆盖：

- Agent loop
- tool call 协议适配
- 工具注册和执行管线
- 权限策略
- 沙箱、限制和 trace
- 文件、搜索、Shell、Coding、RAG 工具
- RAG pipeline 和 JSON vector store
- memory 压缩
- skill manifest 懒加载

`npm run eval:rag` 默认读取 `examples/rag-eval/questions.json`，可以通过第一个命令行参数指定评测问题文件。

RAG eval 支持对比向量检索和 grep 检索：

```bash
# 默认：只评估向量检索 search_notes
npm run eval:rag

# 只评估 grep 检索 grep_notes
$env:RAG_EVAL_MODE="grep"; npm run eval:rag

# 同时输出 vector 和 grep 两组结果，方便比较 accuracy、topSources
$env:RAG_EVAL_MODE="both"; npm run eval:rag
```

评测问题可以额外提供 `grepQuery`。`question` 用于向量检索，`grepQuery` 用于 grep 检索，适合把自然语言问题改写成明确关键词、配置名或函数名。

实际运行 Agent 时，可以用 trace 看 grep 是否有帮助：

- `assistant_message.toolCalls`：模型是否选择了 `grep_notes`。
- `rag_search.toolName`：区分 `search_notes` 和 `grep_notes`。
- `rag_search.matchCount/topMatches`：grep 是否命中正确文件和行。
- `tool_result.observation`：grep 返回内容是否过大、是否需要降低 `maxResults` 或 `contextLines`。
