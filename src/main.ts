import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import './env.js';
import { AgentConfig } from './types.js';
import { askToolApproval } from './cli/approvalPrompt.js';
import { getApprovalMode } from './config.js';
import { MemoryManager } from './context/memory.js';
import { WikiAgent } from './agent.js';
import { registerConfiguredMcpTools } from './mcp/register.js';
import { WIKI_AGENT_SYSTEM_PROMPT } from './prompts/systemPrompt.js';
import { buildSkillManifestPrompt, loadSkillManifests } from './skills.js';
import { createDefaultTools, getLocalToolNamesCoveredByMcp } from './tools/defaultTools.js';
import { ToolExposureController } from './tools/exposure.js';
import { ToolRegistry } from './tools/registry.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 wiki-agent");
    console.log("=================================================\n");

    const rl = readline.createInterface({ input, output });

    // 初始化 Agent 运行时配置
    const config: AgentConfig = {
        modelName: process.env.MODEL_NAME ?? "deepseek-v4-pro",
        temperature: 0.1,
        maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
        traceDir: process.env.TRACE_DIR ?? 'var/traces',
        telemetryBackend: process.env.TELEMETRY_BACKEND === 'otlp' ? 'otlp' : 'file',
        otlpTracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        otlpProtocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL === 'grpc' ? 'grpc' : 'http',
        capturePromptArtifacts: process.env.TRACE_CAPTURE_PROMPTS === 'true',
        traceArtifactDir: process.env.TRACE_ARTIFACT_DIR ?? 'var/traces/artifacts',
        approvalMode: getApprovalMode(),
        requestApproval: request => askToolApproval(rl, request)
    };

    // 初始化 Memory (system prompt + skill manifest)
    const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
    const systemPrompt = skillManifestPrompt
        ? `${WIKI_AGENT_SYSTEM_PROMPT}\n\n${skillManifestPrompt}`
        : WIKI_AGENT_SYSTEM_PROMPT;
    const memory = new MemoryManager(systemPrompt);

    // 初始化工具注册中心：MCP 优先注册，等价本地工具作为兜底能力按需跳过。
    const registry = new ToolRegistry();
    const toolExposureController = new ToolExposureController();
    const mcpRegistration = await registerConfiguredMcpTools(registry);
    const localToolNamesCoveredByMcp = getLocalToolNamesCoveredByMcp(mcpRegistration.tools);
    for (const tool of createDefaultTools({ skipToolNames: localToolNamesCoveredByMcp, exposureController: toolExposureController })) {
        registry.register(tool);
    }
    registry.setSchemaFilter(tool => toolExposureController.shouldExpose(tool));

    const agent = new WikiAgent(config, memory, registry);

    try {
        // 单次运行模式: npm run ask -- "检索我的 Agent 笔记"
        const oneShotInstruction = process.argv.slice(2).join(' ').trim();
        if (oneShotInstruction) {
            toolExposureController.resetToCore();
            await agent.run(oneShotInstruction, chunk => process.stdout.write(chunk));
            return;
        }

        console.log('进入多轮 REPL。输入 exit / quit 退出，输入 clear 清空对话记忆。');

        while (true) {
            const instruction = (await rl.question('\n你 > ')).trim();
            if (!instruction) continue;
            if (['exit', 'quit'].includes(instruction.toLowerCase())) break;
            if (instruction.toLowerCase() === 'clear') {
                memory.clear();
                continue;
            }

            toolExposureController.resetToCore();
            await agent.run(instruction, chunk => process.stdout.write(chunk));
            process.stdout.write('\n');
        }
    } finally {
        rl.close();
        await mcpRegistration.close();
    }
}

main();
