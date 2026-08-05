# wiki-agent 代码导读

这份文档按当前源码结构解释 `wiki-agent` 的实现。它不记录重构历史，只说明各模块承担什么职责、数据如何流动、排查问题时应该看哪里。

## 阅读顺序

建议按这个顺序读：

1. `src/main.ts`
2. `src/agent.ts`
3. `src/tools/base.ts`、`src/tools/registry.ts`、`src/tools/exposure.ts`、`src/tools/executor.ts`
4. `src/permissions.ts`
5. `src/context/memory.ts`、`src/context/memoryStore.ts`
6. `src/trace/`
7. `src/mcp/`
8. `src/rag/`
9. `src/tools/`
10. `scripts/rag/`
11. `wiki/`、`skills/`、`evaluation/`
12. `src/tests/`

## 运行时总览

```text
main.ts
-> 读取配置
-> 构造 system prompt + skill manifest
-> 初始化 MemoryManager（内部创建 MemoryStore）
-> 注册工具
-> 创建 WikiAgent
-> REPL 或单次运行
```

一次 Agent 运行：

```text
用户输入
-> MemoryManager.append(user)
-> start wiki_agent.run span
-> callModel()
-> LLM 返回 assistant message
-> assistant message 写入 memory，并在当前 step span 记录 event
-> 如果有 tool_calls，执行工具并继续下一轮
-> 如果没有 tool_calls，返回最终答案
-> end wiki_agent.run span
```

知识层运行逻辑：

```text
raw sources
-> ingest skill
-> wiki/ maintained pages
-> search_notes / grep_notes
-> wiki-answer skill
-> evaluation/badcases + eval updates
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
    modelName: process.env.MODEL_NAME ?? "deepseek-v4-pro",
    temperature: 0.1,
    maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
    traceDir: process.env.TRACE_DIR ?? 'var/traces',
    capturePromptArtifacts: process.env.TRACE_CAPTURE_PROMPTS === 'true',
    traceArtifactDir: process.env.TRACE_ARTIFACT_DIR ?? 'var/traces/artifacts',
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

工具注册通过 `ToolRegistry` 完成。registry 保存完整工具全集，但 `getSchemas()` 会经过 `ToolExposureController` 过滤，所以 LLM 默认只看到 core 工具和当前已加载分组。

工具注册采用 MCP 优先策略：`registerConfiguredMcpTools()` 先按 `MCP_CONFIG_PATH` 动态加载 MCP 工具，随后 `createDefaultTools()` 注册本地工具。`getLocalToolNamesCoveredByMcp()` 会根据 MCP 实际注册的远程工具名跳过等价本地工具，例如 Filesystem MCP 覆盖 `read_file`、`list_dir`、`glob_search`，Git MCP 覆盖 `git_status`、`git_diff`。`write_file` 需执行作用域策略，因此通过 Filesystem server 的 `disabledTools` 排除同名远端工具，始终由本地实现注册。最终内置工具和 MCP 工具都进入同一个 `ToolRegistry`，Agent loop 不需要区分来源。

工具暴露采用“核心工具 + 按需分组”：`core` 默认暴露，包含 RAG、笔记读取、skill 和 `load_tool_group`；`filesystem`、`git`、`sqlite`、`coding`、`shell` 只在模型调用 `load_tool_group` 后暴露完整 schema。

每次新用户任务开始前，CLI 会调用 `ToolExposureController.resetToCore()`，让 REPL 中上一轮加载过的工具组不会持续影响下一轮任务的上下文预算。

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
-> create Telemetry backend
-> loop until final answer / max steps / system error
-> end run span
```

`MAX_LOOP_STEPS` 用于防止模型无限循环调用工具。

### `runStep()`

`runStep()` 执行一轮模型决策：

1. 创建 `wiki_agent.step` span。
2. 调用 `callModel()`。
3. 把 assistant message 写入 memory。
4. 在 step span 中记录 `assistant_message` event。
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
2. 创建带 `tool.call_id`、`tool.call_index` 和脱敏参数预览的 `tool.execute` span。
3. 调用 `ToolExecutor.execute()`。
4. 通过 `context/toolObservation.ts` 对结果执行统一上下文预算；保留结构化字段，压缩超长字符串、数组和对象。
5. 在 tool span 中分别记录原始结果规模、写回上下文规模、是否截断与耗时。
6. 返回受预算约束的 `role="tool"` message。

真正的参数解析、权限决策、审批和工具执行都在 `ToolExecutor` 中。同一 run 中，同一工具的等价参数连续失败两次后，第三次调用会被 `retry_limit_reached` observation 拦截，避免无效重试耗尽循环与上下文预算。

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
- `getSchemas()` 返回当前允许暴露给 LLM 的工具 schema。
- `setSchemaFilter()` 设置 schema 暴露过滤器，当前由 `ToolExposureController` 提供。
- `getTool()` 根据名称取工具。
- `execute()` 解析 JSON 参数、调用工具自身 `validateArgs()`，再执行工具。

JSON 参数解析由 `utils/json.ts` 的 `parseToolArguments()` 完成。空参数按 `{}` 处理。

注意：schema 过滤只影响 LLM 当前“看得到哪些工具”，不影响执行层按名称执行已注册工具。这样可以让 registry 保存完整工具全集，同时把上下文里的工具说明控制在较小范围。

## `src/tools/exposure.ts`

`ToolExposureController` 管理工具 schema 的可见性：

```text
activeGroups 初始为 core
-> registry.getSchemas()
-> 按 resolveToolGroup(tool.name) 过滤
-> LLM 只看到 active group 里的工具
```

`LoadToolGroupTool` 是默认 core 工具。模型需要额外能力时调用它，例如：

- 需要读写普通文件或搜索代码库：加载 `filesystem`。
- 需要观察 Git 变更：加载 `git`。
- 需要 SQLite MCP：加载 `sqlite`。
- 需要改代码或跑测试：加载 `coding`。
- 必须执行 shell 命令：加载 `shell`。

工具组加载后不会在同一轮 tool call 中立刻改变模型已收到的 schema，而是在下一轮 `callModel()` 中生效。
每个新用户任务开始时 active group 会重置为 `core`。

## `src/mcp/`

`src/mcp/` 是通用 MCP 接入层，用来把外部 MCP server 暴露的 tools 适配成项目内部的 `IAgentTool`。

主要文件：

- `config.ts`：读取 `MCP_CONFIG_PATH` 指向的 JSONC 文件，得到一组 stdio MCP server 配置。
- `client.ts`：用 MCP SDK 创建 `StdioMcpClient`，负责 `connect()`、`listTools()` 和 `callTool()`。
- `toolAdapter.ts`：把单个 MCP `Tool` 包装成 `McpAgentTool`。
- `register.ts`：连接配置中的 server，读取 tools，并注册到 `ToolRegistry`。

数据流：

```text
MCP_CONFIG_PATH
-> config/mcp.servers.jsonc
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

它会在当前 `tool.execute` span 中写 `tool.permission_decision` event，用来查看工具为什么被允许、询问或拒绝。

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

## `src/context/memory.ts`

`MemoryManager` 保存 OpenAI messages：

- 初始化时写入 system prompt。
- `append()` 忽略空消息。
- 接入持久化存储时，启动会恢复指定 `sessionId` 的会话消息和显式长期记忆。
- `clear()` 清空当前会话消息；显式长期记忆保持不变。
- `getRoundCount()` 统计 user 消息数。
- 超过消息数或字符预算时自动压缩较早上下文。

Memory 压缩会保护 tool call 协议连续性：

```ts
while (splitIndex > 0 && nonSystem[splitIndex]?.role === 'tool') {
    splitIndex--;
}
```

这避免保留区从 `tool` message 开始，因为 `tool` message 必须跟在对应 assistant `tool_calls` 后面。

压缩会在当前 run span 中写入 `memory.compaction` event。

`MemoryManager` 内部使用 `src/context/memoryStore.ts` 的 `MemoryStore` 保存 `var/memory/agent.db` 中的会话全文和长期记忆，并在 `var/memory/journals/YYYY-MM-DD.md` 写入可人工阅读的用户/assistant 摘要。`main.ts` 只创建 `MemoryManager`，默认新建 `sessionId`；在 Windows 上通过 npm 恢复时使用 `npm run ask -- -- --session <sessionId> "问题"`。只有 REPL 的 `remember <内容>` 命令会写入长期记忆，避免模型自动把临时推断沉淀为跨会话事实。

## `src/trace/`

追踪通过后端无关的 `Telemetry` / `SpanHandle` 输出。默认 file backend 每行写一个 schema version 2 JSONL span 事件。默认输出目录：

```text
var/traces
```

核心对象：

- `Telemetry`：后端无关的 span 创建接口。
- `SpanHandle`：创建子 span、写 event、结束 span。
- `FileTelemetry`：默认后端，写 schema version 2 JSONL。
- `OtelTelemetry`：可选后端，通过 OTLP HTTP 或 gRPC 发送原生 OpenTelemetry span。

调用树固定为 `wiki_agent.run` → `wiki_agent.step` → `gen_ai.chat` / `tool.execute` → RAG 子 span。每条 JSONL span event 都带有 `traceId`、`spanId`、`parentSpanId` 和起止时间；工具调用还带 `tool.call_id` 与 `tool.call_index`，可稳定表达并发同名工具。

每次 `wiki_agent.run` 对应一个文件，名称为 `<UTC 时间戳>_<traceId>.jsonl`。文件名既可按时间排序，也能直接映射到 Jaeger 中的 Trace。

设置 `TRACE_CAPTURE_PROMPTS=true` 后，`gen_ai.chat` 会将脱敏后的完整请求保存到 `TRACE_ARTIFACT_DIR`。span 仅以 `wiki_agent.prompt_artifact.path`、`sha256`、`chars` 和 `redacted` 属性关联 artifact，避免把大体积 prompt 写入 trace 后端。artifact 写入失败会在该 span 中记录 `prompt_artifact.capture_failed` event，但不会阻断模型调用。

默认 file backend 会在当前 run 的根 span 结束、JSONL 写入完整后，自动通过 OTLP HTTP 导出至本机 Jaeger 的 `http://127.0.0.1:4318/v1/traces`，最长等待 3 秒。导出失败不会影响 Agent 的回答，也不会删除本地 trace。

文件 trace 只接受当前 schema version 2；离线导出脚本也会拒绝旧的扁平事件格式。排查时应从根 run span 开始，沿父子关系定位耗时或失败的模型、工具及 RAG span。

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

`sourceRoots.ts` 负责多知识源配置。默认读取 `config/knowledge.sources.jsonc`，也可以通过环境变量指定其他配置：

```text
KNOWLEDGE_SOURCES_CONFIG_PATH=config/knowledge.sources.jsonc
```

配置中每个 source 的 `name` 会写入 `SourceDocument.source`，例如 `wiki/index.md`、`raw/agent-rag.md`。这让检索层可以区分 maintained wiki 和 raw sources。配置还能声明 `kind`、`priority`、`ignore` 等 source policy。`enabled=false` 或 `index=false` 的 source 不会进入索引。

`iterateSourceDocumentsFromRoots()` 会依次遍历多个 root，并且只在 pipeline
请求下一项时读取对应文件。这样不会把所有文档正文同时保存在内存中。

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

- `replaceChunks()`
- `search()`
- `findBySource()`
- `findRelated()`

默认 `JsonVectorStore` 写入：

```text
var/indexes/<profileId>/index.json
var/indexes/<profileId>/manifest.json
```

构建索引时，`JsonVectorStore` 把 chunk 逐条写入临时 JSON 文件，全部成功后
再替换正式索引。这样既限制内存占用，也避免失败时破坏已有索引。它适合
当前约 26 MiB 的 Markdown/Text 数据；后续接入固定维度 embedding 和更大
数据集时，可新增 LanceDB、pgvector、Qdrant adapter。

### 索引 Pipeline

`indexPipeline.ts` 固定数据流：

```text
scan file paths
-> lazily read one document
-> chunk current document
-> embed each chunk
-> stream chunks into vector store
```

可替换的是 loader、chunker、embedder、vector store。`config/rag.indexes.jsonc` 的 profile 固定这些选择；manifest 记录构建时的 profile 指纹和 embedding 身份。查询端必须先通过 `openActiveIndex()` 校验 manifest，再创建对应的 runtime。

`bm25-v1` 使用原始词频向量。JSON Store 在查询时按当前索引计算文档频率、平均长度，并以 Okapi BM25（默认 `k1=1.2`、`b=0.75`）评分；它不下载或调用任何模型，适合精确术语和低成本本地检索对比。

## `src/tools/ragTool.ts`

RAG 能力被包装成四个工具：

- `search_notes`：按 query 检索相关片段，优先返回 `wiki/` source。
- `grep_notes`：在 configured knowledge roots 中做关键词/正则搜索，并保留 source prefix。
- `read_note`：按 source 读取某篇笔记的 chunks。
- `related_notes`：根据某篇笔记找相关 chunks。

工具层通过 `openActiveIndex()` 获取已校验的 Index Runtime，不直接依赖 JSON 文件或环境变量中的 embedding 名称。

当前检索策略是 wiki-first：`search_notes` 会扩大候选集，再把 `wiki/` source 排在 raw source 前面；`grep_notes` 会按 knowledge sources 配置搜索多个目录。这样保留现有 RAG 管线，同时让 LLM Wiki 层成为默认优先证据来源。

四个 RAG 工具会在当前 `tool.execute` span 下创建对应子 span：`rag.search`、`rag.read_note` 或 `rag.related_notes`。其中 query、topK 与命中规模作为 attributes 写入。

## `src/tools/fileTool.ts`

读取类文件工具运行在 `AGENT_SANDBOX_ROOT` 内：

- `list_dir`：列目录。
- `read_file`：读取文件，受 `READ_FILE_MAX_BYTES` 和 `TOOL_OUTPUT_MAX_CHARS` 限制。
- `write_file`：写文件，风险等级为 `write`，需要审批。它独立读取 `WRITE_SCOPES_CONFIG_PATH` 指向的 JSONC 作用域配置；省略 `scope` 时写入默认 `sandbox`，显式 `scope: "wiki"` 时写入配置的 `wiki/` 根目录。

`write_file` 的根路径必须是工作区内的配置相对路径；调用者只能选择预声明的 scope，且会拒绝目录穿越、工作区外根目录和符号链接逃逸。

## `src/tools/searchTool.ts`

搜索工具运行在沙箱内：

- `glob_search`：按 glob 查找文件。
- `grep_search`：按字符串或正则搜索文本内容。

返回路径通过 `toSandboxRelativePath()` 转成沙箱相对路径，避免暴露绝对路径。

## `wiki/`

`wiki/` 是 agent-maintained knowledge layer，不是运行产物。它保存 LLM 长期维护的 Markdown 知识结构：

- `AGENTS.md`：wiki schema，规定页面类型、frontmatter、引用、ingest/query/lint 规则。
- `index.md`：内容索引。
- `log.md`：ingest、query、lint 的时间线。
- `contradictions.md`：冲突、过期结论和证据缺口。
- `sources/`、`concepts/`、`projects/`、`decisions/`、`people/`：不同页面类型的目录。

设计目标是让知识从 query-time RAG 的临时综合，逐步变成可审阅、可版本管理、可复利的 Markdown 资产。

## Wiki Maintenance Skills

`skills/` 中的维护型 wiki skills 把业务方法论沉淀为可按需加载的流程：

- `source-audit`：真实目录接入前做 source audit，输出 source policy、ignore 规则和首批验证范围。
- `ingest`：把 raw source 编译进 wiki。
- `wiki-answer`：先查 wiki，证据不足再查 raw sources。
- `wiki-lint`：检查 wiki 健康度。
- `badcase`：把失败样例转成 bad case 和 eval 候选。

这些 skill 先保持 Markdown 形式。只有当某个流程稳定、高频且需要严格参数时，再固化成 TypeScript 工具。

## Bad Case And Eval

`evaluation/badcases/TEMPLATE.md` 定义失败样例格式。推荐把检索遗漏、工具路由错误、证据不足、幻觉、schema 缺口等问题都记录下来。

评测样例分两类：

- `evaluation/rag/questions.json`：普通 RAG 检索。
- `evaluation/wiki/questions.json`：wiki-first 检索。

RAG 和 Wiki eval 分别由 `scripts/rag/evaluateRag.ts`、`scripts/rag/evaluateWiki.ts`
作为独立 CLI 入口；两者共享 `src/rag/evaluation.ts` 中的 retriever 构造与判分逻辑。

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
npm run index:notes -- --profile tf-v1
```

相关配置：

- `KNOWLEDGE_SOURCES_CONFIG_PATH`
- `RAG_INDEXES_CONFIG_PATH`

## `scripts/rag/evaluateRag.ts` 与 `scripts/rag/evaluateWiki.ts`

RAG 检索层评测脚本。它位于顶层 `scripts/rag/`，不调用 LLM，只验证检索是否召回预期内容。

默认输入：

```text
evaluation/rag/questions.json
```

两个入口都打开 `activeProfile` 对应的 manifest，并拒绝 profile 与索引不一致的情况。

问题格式：

```json
{
  "question": "Markdown 笔记索引应该保留哪些结构化信息？",
  "grepTerms": ["Markdown", "frontmatter", "tags", "wiki links"],
  "expectedSource": "markdown-notes.md",
  "expectedTerms": ["标题层级", "frontmatter", "tags", "wiki links"]
}
```

评测逻辑：

1. 根据 `RAG_EVAL_MODE` 构造 `vector` 或 `grep` 的 `EvalRetriever`。
2. 两种 retriever 都调用 `evaluateRetriever()` 执行评测和汇总。
3. 检查 `expectedSource` 是否命中。
4. 检查 `expectedTerms` 命中率。
5. source 命中且 terms 命中率至少 60% 算通过。

`grepTerms` 会作为多个独立词项进行 OR 召回，并按单行命中的不同词项数量排序；它们只影响 grep 评测，不影响向量检索。

`npm run eval:rag` 是独立的普通 RAG 评测入口，使用基础检索策略，默认评测
`evaluation/rag/questions.json`。`npm run eval:wiki` 是独立的 Wiki 评测入口，
默认评测 `evaluation/wiki/questions.json`，先检索更多候选，再将 `wiki/` 结果
排到 raw 资料之前。

## `src/config.ts` 和 `src/cli/`

`config.ts` 负责解析 `APPROVAL_MODE`。

`cli/approvalPrompt.ts` 只负责展示审批请求并读取用户输入。它不参与权限决策。

`cli/colors.ts` 提供 CLI 输出颜色。

## `src/utils/json.ts`

JSON 工具函数：

- `parseJsonSafely()`
- `parseToolArguments()`
工具参数解析统一使用这里的函数。

## `src/tests/`

测试按源码目录组织。重要覆盖点：

- `agent.test.ts`：Agent loop、工具调用、熔断。
- `memory.test.ts`：记忆追加、清空、压缩和 tool 协议连续性。
- `trace.test.ts`：JSONL v2 span 父子关系和 preview。
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
2. 在 `createVectorStore()` 中注册后端。
3. 给 adapter 增加测试。
4. 在 profile 中声明新后端；RAG 工具无需改动。

新增 embedding：

1. 实现 `Embedder`。
2. 在 `createEmbedder()` 中支持 profile 的 embedding 类型。
3. 在 `config/rag.indexes.jsonc` 新增 profile，并全量构建其独立索引。
4. 使用 `eval:rag` 与 `eval:wiki` 比较结果后才切换 `activeProfile`。
