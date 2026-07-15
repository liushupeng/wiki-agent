# wiki-agent 代码导读

这份文档按当前源码结构解释 `wiki-agent` 的实现。它不记录重构历史，只说明各模块承担什么职责、数据如何流动、排查问题时应该看哪里。

## 阅读顺序

建议按这个顺序读：

1. `src/main.ts`
2. `src/agent.ts`
3. `src/tools/base.ts`、`src/tools/registry.ts`、`src/tools/executor.ts`
4. `src/permissions.ts`
5. `src/memory.ts`
6. `src/trace.ts`
7. `src/mcp/`
8. `src/rag/`
9. `src/tools/`
10. `scripts/rag/`
11. `src/tests/`

## 运行时总览

```text
main.ts
-> 读取配置
-> 构造 system prompt + skill manifest
-> 初始化 MemoryManager
-> 注册工具
-> 创建 WikiAgent
-> REPL 或单次运行
```

一次 Agent 运行：

```text
用户输入
-> MemoryManager.append(user)
-> TraceLogger.write(run_start)
-> callModel()
-> LLM 返回 assistant message
-> assistant message 写入 memory 和 trace
-> 如果有 tool_calls，执行工具并继续下一轮
-> 如果没有 tool_calls，返回最终答案
-> TraceLogger.write(run_end)
```

## `src/main.ts`

`main.ts` 是 CLI 入口。它做四件事：

1. 解析运行配置。
2. 拼装 system prompt。
3. 注册工具。
4. 启动单次运行或 REPL。

关键配置：

```ts
const config: AgentConfig = {
    modelName: process.env.DEEPSEEK_MODEL_NAME ?? "deepseek-v4-pro",
    temperature: 0.1,
    maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
    traceDir: process.env.TRACE_DIR ?? 'var/traces',
    approvalMode: getApprovalMode(),
    requestApproval: request => askToolApproval(rl, request)
};
```

`requestApproval` 是 CLI 层的人机确认适配器。是否需要审批不由 CLI 决定，而由 `PermissionPolicy` 决定。

System prompt 由基础 prompt 和 skill manifest 拼成：

```ts
const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
const systemPrompt = skillManifestPrompt
    ? `${WIKI_AGENT_SYSTEM_PROMPT}\n\n${skillManifestPrompt}`
    : WIKI_AGENT_SYSTEM_PROMPT;
```

工具注册通过 `ToolRegistry` 完成。LLM 能看到的工具 schema 来自 registry。

工具注册采用 MCP 优先策略：`registerConfiguredMcpTools()` 先按 `MCP_CONFIG_PATH` 动态加载 MCP 工具，随后 `createDefaultTools()` 注册本地工具。`getLocalToolNamesCoveredByMcp()` 会根据 MCP 暴露的远程工具名跳过等价本地工具，例如 Filesystem MCP 覆盖 `read_file`、`write_file`、`list_dir`、`glob_search`，Git MCP 覆盖 `git_status`、`git_diff`。最终内置工具和 MCP 工具都进入同一个 `ToolRegistry`，Agent loop 不需要区分来源。

## `src/agent.ts`

`WikiAgent` 是主循环。它不直接实现具体工具，也不直接决定权限细节，而是编排以下对象：

- `OpenAI` client
- `IMemory`
- `IToolRegistry`
- `ToolExecutor`
- `TraceLogger`

### `run()`

`run()` 管理一次任务的生命周期：

```text
append user message
-> create TraceLogger
-> loop until final answer / max steps / system error
-> write run_end
```

`MAX_LOOP_STEPS` 用于防止模型无限循环调用工具。

### `runStep()`

`runStep()` 执行一轮模型决策：

1. 写 `step_start` trace。
2. 调用 `callModel()`。
3. 把 assistant message 写入 memory。
4. 写 `assistant_message` trace。
5. 如果有 tool calls，调用 `handleToolCalls()` 并返回 `continue`。
6. 如果没有 tool calls，返回最终文本。

### `callModel()`

`callModel()` 把当前 memory 和工具 schema 发给模型：

```ts
const toolSchemas = this.registry.getSchemas();
const stream = await this.client.chat.completions.create({
    model: this.config.modelName,
    messages: this.memory.getMessages() as any,
    temperature: this.config.temperature,
    reasoning_effort: "high",
    tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    stream: true,
});
```

文本增量直接回调给 CLI。tool call 增量由 `protocol/toolCalls.ts` 拼成完整的 OpenAI function tool call。

### `handleToolCalls()`

一个 assistant message 可以包含多个 tool calls。`handleToolCalls()` 负责同一轮工具调用的调度：

- 不支持的 tool call 类型转成标准 tool observation。
- `isReadOnly=true` 的工具并发执行。
- `isReadOnly=false` 的工具串行执行。
- 所有结果按原始 tool call 顺序写回 memory。

这个顺序很重要。OpenAI 工具协议要求 `tool` message 跟在对应的 assistant `tool_calls` 之后。

### `executeToolCall()`

`executeToolCall()` 是 agent loop 和工具执行管线之间的边界：

1. 从 function tool call 中取出工具名、参数字符串和 `tool_call_id`。
2. 如果工具支持 `setTraceLogger()`，注入当前 trace。
3. 调用 `ToolExecutor.execute()`。
4. 写 `tool_result` trace。
5. 返回 `role="tool"` 的 message。

真正的参数解析、权限决策、审批和工具执行都在 `ToolExecutor` 中。

## `src/tools/base.ts`

所有工具继承 `BaseAgentTool`。

核心字段：

- `name`：工具唯一名称，也是 LLM 发起 tool call 时使用的名称。
- `schema`：暴露给 LLM 的工具说明。
- `permission`：工具能力类别，例如 `read`、`write`、`shell`、`rag`。
- `riskLevel`：权限策略使用的风险等级。
- `isReadOnly`：决定同一轮是否可以并发执行。
- `requiresApproval`：是否强制人工审批。

工具返回统一的 `ToolResult`：

```ts
{
    status: 'success' | 'error' | 'invalid_args' | 'security_error' | 'approval_required' | 'approval_denied' | 'execution_failed' | 'runtime_error',
    data?: unknown,
    error?: string,
    metadata?: Record<string, unknown>
}
```

## `src/tools/registry.ts`

`ToolRegistry` 是工具注册中心：

- `register()` 保存工具实例。
- `getSchemas()` 返回所有工具 schema 给 LLM。
- `getTool()` 根据名称取工具。
- `execute()` 解析 JSON 参数、调用工具自身 `validateArgs()`，再执行工具。

JSON 参数解析由 `utils/json.ts` 的 `parseToolArguments()` 完成。空参数按 `{}` 处理。

## `src/mcp/`

`src/mcp/` 是通用 MCP 接入层，用来把外部 MCP server 暴露的 tools 适配成项目内部的 `IAgentTool`。

主要文件：

- `config.ts`：读取 `MCP_CONFIG_PATH` 指向的 JSON 文件，得到一组 stdio MCP server 配置。
- `client.ts`：用 MCP SDK 创建 `StdioMcpClient`，负责 `connect()`、`listTools()` 和 `callTool()`。
- `toolAdapter.ts`：把单个 MCP `Tool` 包装成 `McpAgentTool`。
- `register.ts`：连接配置中的 server，读取 tools，并注册到 `ToolRegistry`。

数据流：

```text
MCP_CONFIG_PATH
-> config/mcp.servers.json
-> loadMcpServerConfigs()
-> StdioMcpClient.connect()
-> client.listTools()
-> new McpAgentTool(...)
-> registry.register(...)
```

`McpAgentTool` 做三件关键事情：

1. 把 MCP tool 的 `inputSchema` 转成 OpenAI function tool 的 `parameters`。
2. 用 `toolNamePrefix + remoteTool.name` 生成本地唯一工具名。
3. 根据 MCP annotation 和默认配置推断 `riskLevel`、`permission`、`isReadOnly`。

风险推断规则：

- `readOnlyHint=true`：`riskLevel=safe`。
- `destructiveHint=true`：`riskLevel=write`。
- `openWorldHint=true`：`riskLevel=network`。
- 没有 annotation：使用 server 配置的 `defaultRiskLevel`，默认是 `write`。

这个默认值偏保守。因为 MCP server 是外部能力入口，未知工具默认进入审批流程更合适。

## `src/tools/executor.ts`

`ToolExecutor` 是单个工具调用的安全执行管线：

```text
get tool
-> parse args
-> validate args
-> PermissionPolicy.evaluate
-> ask user if needed
-> registry.execute
-> catch runtime error as ToolResult
```

它会在 `TRACE_LEVEL=debug` 时写 `permission_decision` 事件，用来查看工具为什么被允许、询问或拒绝。

## `src/permissions.ts`

`PermissionPolicy` 对一次工具调用返回三种决策：

- `allow`：可以直接执行。
- `ask`：需要人工确认。
- `deny`：不执行，把拒绝原因返回给模型。

`ApprovalMode` 是全局策略：

- `prompt`：风险工具执行前询问用户。
- `auto`：通过安全检查的工具自动执行。
- `deny`：拒绝需要审批的工具。

Shell 工具还有 allowlist 和危险 token 检查。危险工具或危险命令会被拒绝。

## `src/memory.ts`

`MemoryManager` 保存 OpenAI messages：

- 初始化时写入 system prompt。
- `append()` 忽略空消息。
- `clear()` 只保留 system prompt。
- `getRoundCount()` 统计 user 消息数。
- 超过消息数或字符预算时自动压缩较早上下文。

Memory 压缩会保护 tool call 协议连续性：

```ts
while (splitIndex > 0 && nonSystem[splitIndex]?.role === 'tool') {
    splitIndex--;
}
```

这避免保留区从 `tool` message 开始，因为 `tool` message 必须跟在对应 assistant `tool_calls` 后面。

`TRACE_LEVEL=debug` 时，压缩会写 `memory_compaction` 事件。

## `src/trace.ts`

Trace 是 JSONL 文件，每行一个结构化事件。默认输出目录：

```text
var/traces
```

支持级别：

- `debug`
- `info`
- `warn`
- `error`

默认：

```env
TRACE_LEVEL=info
```

基础事件：

- `run_start`
- `step_start`
- `assistant_message`
- `tool_result`
- `run_end`

debug 事件：

- `permission_decision`
- `rag_search`
- `memory_compaction`
- `model_call_budget`

轻量成本观测使用 `utils/tokenBudget.ts` 里的估算函数。它不依赖 tokenizer，只记录字符数和 `chars / 4` 得到的近似 token，用来定位上下文体量来源：

- `model_call_budget.input`：本轮发给模型的 messages 体量。
- `model_call_budget.toolSchemas`：工具 schema 体量，MCP 工具增多时重点看这里。
- `model_call_budget.output`：模型输出文本体量。
- `tool_result.observation`：工具结果写回 memory 前的体量。
- `memory_compaction.before/after`：压缩前后上下文体量。

排查问题时优先看 trace：

1. `run_start.instruction`
2. `assistant_message.toolCalls`
3. `tool_result.args`
4. `tool_result.status`
5. `observationPreview`
6. 怀疑 token 消耗过大时看 `model_call_budget`、`tool_result.observation`、`memory_compaction`

## `src/protocol/toolCalls.ts`

这个模块处理 OpenAI tool call 协议：

- `isFunctionToolCall()` 判断是否是 function tool call。
- `appendToolCallDeltas()` 组装流式返回的 tool call 分片。
- `buildToolCalls()` 得到完整 function tool calls。
- `buildSkippedToolResult()` 为不支持的 tool call 类型构造 observation。

它是纯协议适配层，不依赖具体工具实现。

## `src/rag/`

RAG 模块分成几层。

### 类型

`types.ts` 定义：

- `SourceDocument`
- `TextChunk`
- `Vector`
- `IndexedChunk`
- `SearchResult`
- `KnowledgeIndex`

这些类型是 chunker、embedding、vector store 和工具层之间的稳定边界。

### 文档加载

`documentLoader.ts` 负责：

- 遍历知识源目录。
- 跳过 `.git`、`node_modules`、`dist` 等目录。
- 读取 `.md`、`.markdown`、`.txt` 文件。
- 生成 `SourceDocument`。

### 切分

`chunker.ts` 提供：

- `chunkText()`：按固定长度切文本。
- `chunkMarkdown()`：识别 frontmatter、标题层级、tags、wiki links。
- `selectChunker()`：按扩展名选择 chunker。
- `chunkDocument()`：pipeline 使用的统一入口。

### Embedding

`embeddings.ts` 定义 `Embedder` 接口。默认 `TfEmbedder` 使用归一化词频向量，不调用外部服务。

```text
文本 -> tokenize -> 词频统计 -> 向量归一化
```

后续替换 OpenAI embedding 或本地模型时，实现新的 `Embedder` 即可。

### Vector Store

`vectorStore.ts` 定义 `VectorStore`：

- `upsertChunks()`
- `search()`
- `findBySource()`
- `findRelated()`

默认 `JsonVectorStore` 写入：

```text
var/knowledge/index.json
```

它适合本地实验。后续接入 LanceDB、pgvector、Qdrant 时新增 adapter 即可。

### 索引 Pipeline

`indexPipeline.ts` 固定数据流：

```text
load documents
-> chunk documents
-> embed chunks
-> upsert vector store
```

可替换的是 loader、chunker、embedder、vector store。

## `src/tools/ragTool.ts`

RAG 能力被包装成三个工具：

- `search_notes`：按 query 检索相关片段。
- `read_note`：按 source 读取某篇笔记的 chunks。
- `related_notes`：根据某篇笔记找相关 chunks。

工具层通过 `createVectorStoreFromEnv()` 获取后端，不直接依赖 JSON 文件实现。

`search_notes` 在 `TRACE_LEVEL=debug` 时写 `rag_search`，包含：

- query
- indexPath
- topK
- matchCount
- topMatches

## `src/tools/fileTool.ts`

文件工具运行在 `AGENT_SANDBOX_ROOT` 内：

- `list_dir`：列目录。
- `read_file`：读取文件，受 `READ_FILE_MAX_BYTES` 和 `TOOL_OUTPUT_MAX_CHARS` 限制。
- `write_file`：写文件，风险等级为 `write`，需要审批。

路径都通过 `resolveSafePath()` 检查，防止目录穿越。

## `src/tools/searchTool.ts`

搜索工具运行在沙箱内：

- `glob_search`：按 glob 查找文件。
- `grep_search`：按字符串或正则搜索文本内容。

返回路径通过 `toSandboxRelativePath()` 转成沙箱相对路径，避免暴露绝对路径。

## `src/tools/shellTool.ts`

`execute_command` 在沙箱目录下运行 Shell 命令：

- `cwd` 固定为 `getSandboxRoot()`。
- 输出经过 `limitText()` 截断。
- 工具内保留一层危险 token 拦截。
- 权限层还会通过 `PermissionPolicy` 做 allowlist 和审批。

## `src/tools/codingTool.ts`

Coding 工具使用 `AGENT_WORKSPACE_ROOT`：

- `git_status`
- `git_diff`
- `apply_patch`
- `run_tests`

`apply_patch` 要求 `oldText` 在目标文件中唯一匹配。`run_tests` 默认执行 `npm test`，超时受 `RUN_TESTS_MAX_TIMEOUT_MS` 限制。

## `src/tools/skillTool.ts` 与 `src/skills.ts`

`skills.ts` 只在启动时加载 skill manifest：

```text
- name
- description
```

不会把所有 skill 全文塞进 system prompt。

`load_skill` 工具按名称读取单个 skill 全文。任务匹配某个 skill 时，LLM 应先调用 `load_skill`，再按 skill 内容继续执行。

## `scripts/rag/indexKnowledgeBase.ts`

RAG 索引入口脚本。它位于顶层 `scripts/rag/`，作为项目级辅助命令使用；核心索引逻辑仍在 `src/rag/indexPipeline.ts`。

用法：

```bash
npm run index:notes
npm run index:notes -- notes
npm run index:notes -- D:\my-notes var/knowledge/index.json
```

相关配置：

- `NOTES_ROOT`
- `KNOWLEDGE_INDEX_PATH`
- `RAG_STORE`
- `RAG_EMBEDDER`
- `RAG_CHUNKER`
- `RAG_CHUNK_SIZE`
- `RAG_CHUNK_OVERLAP`

## `scripts/rag/evaluateRag.ts`

RAG 检索层评测脚本。它位于顶层 `scripts/rag/`，不调用 LLM，只验证检索是否召回预期内容。

默认输入：

```text
examples/rag-eval/questions.json
```

默认索引：

```text
var/knowledge/index.json
```

问题格式：

```json
{
  "question": "Markdown 笔记索引应该保留哪些结构化信息？",
  "expectedSource": "markdown-notes.md",
  "expectedTerms": ["标题层级", "frontmatter", "tags", "wiki links"]
}
```

评测逻辑：

1. 调用 `VectorStore.search()`。
2. 检查 `expectedSource` 是否命中。
3. 检查 `expectedTerms` 命中率。
4. source 命中且 terms 命中率至少 60% 算通过。

## `src/config.ts` 和 `src/cli/`

`config.ts` 负责解析 `APPROVAL_MODE`。

`cli/approvalPrompt.ts` 只负责展示审批请求并读取用户输入。它不参与权限决策。

`cli/colors.ts` 提供 CLI 输出颜色。

## `src/utils/json.ts`

JSON 工具函数：

- `parseJsonSafely()`
- `parseToolArguments()`
- `parseJsonForTrace()`

工具参数解析和 trace 参数展示都使用这里的函数，避免重复实现。

## `src/tests/`

测试按源码目录组织。重要覆盖点：

- `agent.test.ts`：Agent loop、工具调用、熔断。
- `memory.test.ts`：记忆追加、清空、压缩和 tool 协议连续性。
- `trace.test.ts`：trace 文件、level、过滤、preview。
- `permissions.test.ts`：权限策略。
- `sandbox.test.ts`、`limits.test.ts`：本地安全基础设施。
- `tools/*.test.ts`：各类工具行为。
- `rag/*.test.ts`：索引 pipeline 和 JSON vector store。
- `protocol/toolCalls.test.ts`：流式 tool call 拼装。
- `utils/json.test.ts`：JSON 解析工具。

运行：

```bash
npm test
```

测试命令会先清理 `dist/`，再编译，然后运行 `dist/src/tests/**/*.test.js`。

## 扩展建议

新增向量库：

1. 实现 `VectorStore`。
2. 在 `createVectorStoreFromEnv()` 中增加 `RAG_STORE` 分支。
3. 给 adapter 增加测试。
4. RAG 工具无需改动。

新增 embedding：

1. 实现 `Embedder`。
2. 在 `createEmbedderFromEnv()` 中增加 `RAG_EMBEDDER` 分支。
3. 用 `indexPipeline` 测试验证生成索引。
