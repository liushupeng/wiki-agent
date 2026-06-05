# mini-claude-code

一个轻量级的、基于命令行的自主 AI 编程智能体（约 450 行 TypeScript），使用 ReAct（思考-行动-观察）智能体循环，通过函数调用工具来分析和与代码库交互。

## 架构

```bash
src/
├── main.ts              # 入口 — 初始化智能体、工具和记忆
├── agent.ts             # 核心智能体循环 + ToolRegistry
├── memory.ts            # 对话记忆管理（系统提示词 + 历史记录）
├── types.ts             # TypeScript 接口（IAgent, IAgentTool, IMemory 等）
└── tools/
    ├── base.ts          # 抽象基类 BaseAgentTool
    ├── fileTool.ts      # 文件系统工具（list_dir, read_file, write_file）
    └── shellTool.ts     # Shell 命令执行工具
```

**核心设计模式：**

- **ReAct 循环** — 智能体迭代运行：LLM 推断下一步行动，请求工具调用，智能体执行工具，观察结果反馈给 LLM 重新规划。当 LLM 生成最终答案（不再调用工具）或触发熔断器时循环结束。
- **工具注册中心** — 工具统一注册管理。添加新工具只需继承 `BaseAgentTool` 并注册即可——智能体本身不直接接触任何具体工具实现。
- **流式响应** — LLM 响应通过 OpenAI SDK 流式传输，文本块实时输出给用户，分散的工具调用 delta 按索引组装成完整的工具调用。
- **沙箱隔离** — 文件工具将所有路径限制在 `C:\AgentSandbox` 内，并阻止目录穿越攻击。Shell 工具黑名单拦截危险命令（`rm`、`mv`、`shutdown` 等），并强制 `cwd` 为沙箱目录。
- **自愈能力** — 工具执行错误会被捕获，序列化为 JSON 观察结果反馈给 LLM，使其能够自行纠错而非崩溃。
- **熔断器** — `maxLoopSteps`（默认 20）防止 LLM 陷入无限工具调用循环导致 Token 失控消耗。

## 技术栈

| 层级 | 技术 |
|---|---|
| 语言 | TypeScript 6.x (ESM) |
| 运行时 | Node.js |
| LLM SDK | OpenAI SDK（指向 DeepSeek API） |
| 开发运行 | tsx（无需预编译） |

## 安装

```bash
npm install
cp .env.example .env   # 编辑 .env 填入你的 DeepSeek API Key
```

## 使用

```bash
npm run dev    # 通过 tsx 运行（开发模式）
npm run build  # 编译 TypeScript 到 dist/
npm start      # 运行编译后的 JS
```

智能体的系统提示词和任务在 `src/main.ts` 中配置。修改目标项目路径和审计指令即可分析不同的代码库。

## 安全性

- 文件操作限制在 `C:\AgentSandbox` 内，具有路径穿越保护。
- Shell 执行黑名单拦截危险命令，并强制 5 秒超时。
- 仅可在受信任的环境中运行——沙箱是约定而非容器。
