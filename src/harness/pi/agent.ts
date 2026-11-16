import { Color } from '../../cli/colors.js';
import { EvidenceLedger } from '../../context/evidenceSufficiency.js';
import { RuntimeEvidencePolicy } from '../../context/runtimeEvidencePolicy.js';
import { PermissionPolicy } from '../../permissions.js';
import type { AgentConfig, IAgent, IMemory, IToolRegistry } from '../../types.js';
import { ToolExecutor } from '../../tools/executor.js';
import type { TerminationReason } from '../../trace/telemetry.js';
import type { WikiPiSessionBundle } from './sessionFactory.js';
import { createWikiPiSession } from './sessionFactory.js';
import { readPiAssistantText, readPiSessionFailure } from './runOutcome.js';
import { beginPiTraceRecorder } from './traceAdapter.js';
import { syncWikiEvidenceToolExposure } from './evidenceExtension.js';
import type { PiToolRuntimeContext } from './toolsAdapter.js';
import { createAssistantStreamEmitter } from './assistantStream.js';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

type PiStreamEvent = {
    type: string;
    message?: { role?: string; content?: unknown };
};

export class PiAgent implements IAgent {
    private readonly toolExecutor: ToolExecutor;
    private readonly evidencePolicy: RuntimeEvidencePolicy;
    private readonly evidenceLedger = new EvidenceLedger();
    private readonly piToolRuntime: PiToolRuntimeContext;
    private sessionBundle: WikiPiSessionBundle | undefined;

    constructor(
        public config: AgentConfig,
        public memory: IMemory,
        public registry: IToolRegistry
    ) {
        this.toolExecutor = new ToolExecutor(
            registry,
            new PermissionPolicy(config.approvalMode ?? 'prompt'),
            config.requestApproval
        );
        this.evidencePolicy = new RuntimeEvidencePolicy(config.maxRagCalls);
        this.piToolRuntime = {
            toolExecutor: this.toolExecutor,
            evidencePolicy: this.evidencePolicy,
            evidenceLedger: this.evidenceLedger
        };
    }

    async run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string> {
        await assertPiPackageAvailable();

        this.toolExecutor.resetFailureCounts();
        this.evidenceLedger.clear();
        this.evidencePolicy.reset();

        if (!shouldKeepPiSession()) {
            await this.disposeSessionOnly();
        }

        this.memory.append({ role: 'user', content: userInstruction });

        const traceRecorder = await beginPiTraceRecorder(this.config, userInstruction);
        this.piToolRuntime.traceRecorder = traceRecorder;

        let terminationReason: TerminationReason = 'completed';
        let finalAnswerPolicy: ReturnType<RuntimeEvidencePolicy['finalizeAnswer']> | undefined;
        let assistantText = '';

        try {
            const bundle = await this.ensureSession();
            syncWikiEvidenceToolExposure(this.registry, this.evidencePolicy, bundle.session);
            const streamAssistant = createAssistantStreamEmitter(onTextChunk);
            let cliStep = 0;
            let toolsThisTurn = 0;
            this.piToolRuntime.noteToolExecuted = () => {
                toolsThisTurn += 1;
            };
            const unsubscribers = [
                bundle.session.subscribe((event: PiStreamEvent) => {
                    if (event.type === 'turn_start') {
                        cliStep += 1;
                        toolsThisTurn = 0;
                        console.log(Color.cyan(`\n🧠 [Step ${cliStep}] Agent 正在审视环境并推演下一步规划...`));
                        return;
                    }
                    if (event.type === 'turn_end') {
                        if (toolsThisTurn > 0) {
                            console.log(Color.cyan(`📡 [Replanning] 数据链已更新，重新唤醒大脑决策...`));
                        }
                        return;
                    }
                    if (event.type !== 'message_update' || event.message?.role !== 'assistant') return;
                    const fullText = assistantMessageToText(event.message ?? {});
                    streamAssistant.emit(fullText);
                }),
                ...(traceRecorder ? [traceRecorder.attachSessionListeners(bundle.session)] : [])
            ];

            try {
                await bundle.session.prompt(userInstruction, { expandPromptTemplates: false });
            } finally {
                for (const unsubscribe of unsubscribers) unsubscribe();
            }

            const failure = readPiSessionFailure(bundle.session);
            if (failure) {
                terminationReason = 'system_error';
                throw new Error(
                    `Pi harness 模型调用失败：${failure}。请先运行 npm run check:llm；或改用 npm run ask:native。`
                );
            }

            assistantText = readPiAssistantText(bundle.session);
            if (!assistantText.trim()) {
                terminationReason = 'system_error';
                throw new Error(
                    'Pi harness 未收到模型文本回复。请确认 MODEL_NAME 与供应商一致，并运行 npm run check:llm。'
                );
            }

            finalAnswerPolicy = this.evidencePolicy.finalizeAnswer(assistantText, this.evidenceLedger.assess());
            assistantText = finalAnswerPolicy.content;
            if (finalAnswerPolicy.action === 'forced-abstention') {
                console.log(Color.yellow('\n⚠️ [证据闸门] 检索未产生可引用证据，最终回答已降级为明确拒答。'));
            }
            streamAssistant.emit(assistantText);

            const evidenceSnapshot = this.evidencePolicy.snapshot(this.evidenceLedger.assess());
            const stepCount = traceRecorder ? Math.max(1, traceRecorder.getStepCount()) : Math.max(1, cliStep);
            if (this.config.maxLoopSteps > 0 && stepCount > this.config.maxLoopSteps) {
                terminationReason = 'max_loop_steps';
                console.log(Color.red(`\n🚨 [安全熔断] 侦测到当前任务链式思考已达步数上限 (${this.config.maxLoopSteps} 步)，为保护您的账户额度，已强制熔断。`));
            } else {
                console.log(Color.green(`\n✅ [任务完成] Agent 已在 Step ${stepCount} 生成最终回答，任务正常结束。`));
            }

            await traceRecorder?.finalize({
                terminationReason,
                finalAnswerPolicy,
                evidence: evidenceSnapshot,
                stepCount
            });

            this.memory.append({ role: 'assistant', content: assistantText });
            return assistantText;
        } catch (error) {
            terminationReason = 'system_error';
            await traceRecorder?.abort();
            throw error;
        } finally {
            this.piToolRuntime.traceRecorder = undefined;
            this.piToolRuntime.noteToolExecuted = undefined;
        }
    }

    async dispose(): Promise<void> {
        await this.disposeSessionOnly();
    }

    private async disposeSessionOnly(): Promise<void> {
        this.sessionBundle?.dispose();
        this.sessionBundle = undefined;
    }

    private async ensureSession(): Promise<WikiPiSessionBundle> {
        if (this.sessionBundle) return this.sessionBundle;
        this.sessionBundle = await createWikiPiSession(this.config, this.memory, this.registry, this.piToolRuntime);
        return this.sessionBundle;
    }
}

export function createPiAgent(
    config: AgentConfig,
    memory: IMemory,
    registry: IToolRegistry
): IAgent {
    return new PiAgent(config, memory, registry);
}

function shouldKeepPiSession(): boolean {
    return process.env.PI_KEEP_SESSION === 'true';
}

async function assertPiPackageAvailable(): Promise<void> {
    try {
        await import(PI_PACKAGE);
    } catch {
        throw new Error(
            `Pi harness 需要依赖 ${PI_PACKAGE}。请执行 npm install，或改用 --harness native / npm run ask:native。`
        );
    }
}

function assistantMessageToText(message: { content?: unknown }): string {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content
        .filter(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text')
        .map(block => (block as { text?: string }).text ?? '')
        .join('');
}
