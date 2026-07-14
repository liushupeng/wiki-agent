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

内置工具：

- 文件工具：`list_dir`、`read_file`、`write_file`
- 搜索工具：`glob_search`、`grep_search`
- RAG 工具：`search_notes`、`read_note`、`related_notes`
- Skill 工具：`load_skill`
- Coding 工具：`git_status`、`git_diff`、`apply_patch`、`run_tests`
- Shell 工具：`execute_command`

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

建议排查顺序：

1. 看 `run_start.instruction`。
2. 看 `assistant_message.toolCalls`。
3. 看 `tool_result.args`。
4. 看 `tool_result.status` 和 `observationPreview`。
5. 需要更细信息时开启 `TRACE_LEVEL=debug`。

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
dist/tests/**/*.test.js
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
