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
    const runtimeArguments = parseRuntimeArguments(process.argv.slice(2));

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
    const memory = new MemoryManager(systemPrompt, {
        sessionId: runtimeArguments.sessionId,
        memoryDirectory: process.env.MEMORY_DIR ?? 'var/memory'
    });
    console.log(`🗂️ [会话] ${memory.resumedSession ? '已恢复' : '已创建'}：${memory.sessionId}`);

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
        const oneShotInstruction = runtimeArguments.instruction;
        if (oneShotInstruction) {
            toolExposureController.resetToCore();
            await agent.run(oneShotInstruction, chunk => process.stdout.write(chunk));
            return;
        }

        console.log('进入多轮 REPL。输入 exit / quit 退出，输入 clear 清空会话历史，输入 remember <内容> 保存长期记忆，输入 memories / forget <ID> 查看或删除长期记忆。');

        while (true) {
            const instruction = (await rl.question('\n你 > ')).trim();
            if (!instruction) continue;
            if (['exit', 'quit'].includes(instruction.toLowerCase())) break;
            if (instruction.toLowerCase() === 'clear') {
                memory.clear();
                continue;
            }
            if (instruction.toLowerCase().startsWith('remember ')) {
                const content = instruction.slice('remember '.length).trim();
                if (!content) {
                    console.log('请输入要保存的长期记忆，例如：remember 我偏好使用中文回答。');
                    continue;
                }
                const item = memory.remember(content);
                console.log(`💾 [长期记忆] 已保存 ${item.id}`);
                continue;
            }
            if (instruction.toLowerCase() === 'memories') {
                const items = memory.getLongTermMemories();
                if (items.length === 0) {
                    console.log('当前没有长期记忆。');
                } else {
                    for (const item of items) {
                        console.log(`- ${item.id} [${item.kind}] ${item.content}`);
                    }
                }
                continue;
            }
            if (instruction.toLowerCase().startsWith('forget ')) {
                const memoryId = instruction.slice('forget '.length).trim();
                if (!memoryId) {
                    console.log('请输入要删除的长期记忆 ID；可先输入 memories 查看。');
                    continue;
                }
                console.log(memory.forget(memoryId) ? '🗑️ [长期记忆] 已删除。' : '未找到对应的长期记忆 ID。');
                continue;
            }

            toolExposureController.resetToCore();
            await agent.run(instruction, chunk => process.stdout.write(chunk));
            process.stdout.write('\n');
        }
    } finally {
        rl.close();
        await mcpRegistration.close();
        memory.close();
    }
}

main();

function parseRuntimeArguments(args: string[]): { instruction: string; sessionId?: string } {
    const instructionParts: string[] = [];
    let sessionId: string | undefined;

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument !== '--session') {
            instructionParts.push(argument);
            continue;
        }
        const value = args[++index]?.trim();
        if (!value) throw new Error('--session requires a non-empty session ID');
        sessionId = value;
    }

    return { instruction: instructionParts.join(' ').trim(), sessionId };
}

