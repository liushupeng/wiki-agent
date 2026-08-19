import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import './env.js';
import { AgentConfig } from './types.js';
import { askToolApproval } from './cli/approvalPrompt.js';
import { getApprovalMode } from './config.js';
import { MemoryManager } from './context/memory.js';
import type { MemoryProposalStatus } from './context/memoryProposal.js';
import { WikiAgent } from './agent.js';
import { registerConfiguredMcpTools } from './mcp/register.js';
import { WIKI_AGENT_SYSTEM_PROMPT } from './prompts/systemPrompt.js';
import { buildSkillManifestPrompt, loadSkillManifests } from './skills.js';
import { createDefaultTools, getLocalToolNamesCoveredByMcp } from './tools/defaultTools.js';
import { ToolExposureController } from './tools/exposure.js';
import { ToolRegistry } from './tools/registry.js';
import { parsePositiveInteger } from './utils/number.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 wiki-agent");
    console.log("=================================================\n");

    const rl = readline.createInterface({ input, output });
    const runtimeArguments = parseRuntimeArguments(process.argv.slice(2));

    // 初始化 Agent 运行时配置
    const config: AgentConfig = {
        modelName: process.env.MODEL_NAME ?? "deepseek-v4-flash",
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
    for (const tool of await createDefaultTools({
        skipToolNames: localToolNamesCoveredByMcp,
        exposureController: toolExposureController,
        memoryProposalService: memory,
        rag: process.env.RAG_RETRIEVAL_PROFILE
            ? {
                retrievalProfile: process.env.RAG_RETRIEVAL_PROFILE,
                indexVariant: process.env.RAG_INDEX_VARIANT
            }
            : undefined
    })) {
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

        console.log('进入多轮 REPL。输入 exit / quit 退出，输入 clear 清空会话历史；输入 sessions [数量] [预览字符数] 列出会话，输入 session <ID> [预览字符数] 查看会话概览；输入 remember <内容> 直接保存已明确批准的长期记忆；输入 propose [kind] <内容> 创建提案，proposals / approve <ID> / reject <ID> 管理提案；输入 memories / forget <ID> 查看或删除长期记忆。');

        while (true) {
            const instruction = (await rl.question('\n你 > ')).trim();
            if (!instruction) continue;
            if (['exit', 'quit'].includes(instruction.toLowerCase())) break;
            if (handleSessionCommand(instruction, memory)) continue;
            if (handleLongTermMemoryCommand(instruction, memory)) continue;

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
        if (argument === '--') continue;
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

function handleSessionCommand(instruction: string, memory: MemoryManager): boolean {
    const normalized = instruction.toLowerCase();
    if (normalized === 'clear') {
        memory.clear();
        return true;
    }
    if (normalized === 'sessions' || normalized.startsWith('sessions ')) {
        const [limitArgument, previewArgument] = instruction.slice('sessions'.length).trim().split(/\s+/);
        const limit = resolveReplPositiveInteger(limitArgument, 20, 100, '数量');
        const previewChars = resolveReplPositiveInteger(previewArgument, 120, 10000, '预览字符数');
        const sessions = memory.listSessions(limit, previewChars);
        if (sessions.length === 0) {
            console.log('当前没有可恢复的会话。');
        } else {
            for (const session of sessions) {
                console.log(`- ${session.id} | 创建：${session.createdAt} | 最后活动：${session.updatedAt} | 消息：${session.messageCount} | ${session.preview || '（无文本消息）'}`);
            }
        }
        return true;
    }
    if (!normalized.startsWith('session ')) return false;

    const [sessionId, previewArgument] = instruction.slice('session '.length).trim().split(/\s+/);
    if (!sessionId) {
        console.log('请输入 session ID，例如：session <ID>');
        return true;
    }
    const previewChars = resolveReplPositiveInteger(previewArgument, 1000, 10000, '预览字符数');
    const session = memory.getSessionOverview(sessionId, previewChars);
    if (!session) {
        console.log('未找到对应 session ID；可先输入 sessions 查看可恢复会话。');
    } else {
        console.log([
            `会话：${session.id}`,
            `创建：${session.createdAt}`,
            `最后活动：${session.updatedAt}`,
            `消息：${session.messageCount}`,
            `首条用户消息：${session.firstUserMessage ?? '（无）'}`,
            `最近用户消息：${session.lastUserMessage ?? '（无）'}`,
            `最近助手回复：${session.lastAssistantMessage ?? '（无）'}`,
            `会话预览：${session.preview || '（无文本消息）'}`
        ].join('\n'));
    }
    return true;
}

function handleLongTermMemoryCommand(instruction: string, memory: MemoryManager): boolean {
    const normalized = instruction.toLowerCase();
    if (normalized.startsWith('propose ')) {
        const raw = instruction.slice('propose '.length).trim();
        const [first, ...rest] = raw.split(/\s+/);
        const hasKind = ['preference', 'constraint', 'fact'].includes(first?.toLowerCase());
        const content = hasKind ? rest.join(' ') : raw;
        if (!content) {
            console.log('请输入提案内容，例如：propose preference 我偏好中文回答。');
        } else {
            const proposal = memory.proposeMemory({
                content,
                kind: hasKind ? first.toLowerCase() as 'preference' | 'constraint' | 'fact' : 'fact',
                userRequest: instruction,
                sourceMessageRefs: [`repl:${memory.sessionId ?? 'ephemeral'}`]
            });
            console.log(`📝 [记忆提案] ${proposal.id} 状态=${proposal.status}${proposal.verification?.reasons.length ? `：${proposal.verification.reasons.join('；')}` : ''}`);
        }
        return true;
    }
    if (normalized === 'proposals' || normalized.startsWith('proposals ')) {
        const status = instruction.slice('proposals'.length).trim() || undefined;
        const allowed = ['proposed', 'verified', 'rejected_verify', 'pending_approval', 'approved', 'committed', 'rejected_user'];
        if (status && !allowed.includes(status)) {
            console.log(`未知提案状态：${status}`);
            return true;
        }
        const proposals = memory.listMemoryProposals(status as MemoryProposalStatus | undefined);
        if (!proposals.length) console.log('当前没有匹配的记忆提案。');
        for (const proposal of proposals) {
            console.log(`- ${proposal.id} [${proposal.status}/${proposal.kind}] ${proposal.content}`);
        }
        return true;
    }
    if (normalized.startsWith('approve ') || normalized.startsWith('reject ')) {
        const approve = normalized.startsWith('approve ');
        const proposalId = instruction.slice(approve ? 'approve '.length : 'reject '.length).trim();
        if (!proposalId) {
            console.log(`请输入提案 ID，例如：${approve ? 'approve' : 'reject'} <ID>`);
        } else {
            try {
                const proposal = approve
                    ? memory.approveMemoryProposal(proposalId)
                    : memory.rejectMemoryProposal(proposalId);
                console.log(`📝 [记忆提案] ${proposal.id} 状态=${proposal.status}`);
            } catch (error: any) {
                console.log(`记忆提案操作失败：${error.message}`);
            }
        }
        return true;
    }
    if (normalized.startsWith('remember ')) {
        const content = instruction.slice('remember '.length).trim();
        if (!content) {
            console.log('请输入要保存的长期记忆，例如：remember 我偏好使用中文回答。');
        } else {
            const item = memory.remember(content);
            console.log(`💾 [长期记忆] 已保存 ${item.id}`);
        }
        return true;
    }
    if (normalized === 'memories') {
        const items = memory.getLongTermMemories();
        if (items.length === 0) {
            console.log('当前没有长期记忆。');
        } else {
            for (const item of items) {
                console.log(`- ${item.id} [${item.kind}] ${item.content}`);
            }
        }
        return true;
    }
    if (!normalized.startsWith('forget ')) return false;

    const memoryId = instruction.slice('forget '.length).trim();
    if (!memoryId) {
        console.log('请输入要删除的长期记忆 ID；可先输入 memories 查看。');
    } else {
        console.log(memory.forget(memoryId) ? '🗑️ [长期记忆] 已删除。' : '未找到对应的长期记忆 ID。');
    }
    return true;
}

function resolveReplPositiveInteger(value: string | undefined, fallback: number, maximum: number, label: string): number {
    if (!value) return fallback;
    const parsed = parsePositiveInteger(value, maximum);
    if (parsed !== undefined) return parsed;
    console.log(`${label}必须是正整数；已使用默认值 ${fallback}。`);
    return fallback;
}

