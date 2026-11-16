import { createHash } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, ToolResult } from '../../types.js';
import type { FinalAnswerPolicyResult } from '../../context/runtimeEvidencePolicy.js';
import { buildToolArgumentTraceAttributes, redactSensitiveText } from '../../trace/artifacts.js';
import {
    createTelemetry,
    preview,
    runWithSpan,
    type SpanHandle,
    type Telemetry,
    type TerminationReason
} from '../../trace/telemetry.js';

export type PiTraceRecorder = {
    readonly filePath?: string;
    getStepCount(): number;
    attachSessionListeners(session: AgentSession): () => void;
    instrumentToolCall<T extends ToolResult>(
        toolName: string,
        toolCallId: string,
        params: Record<string, unknown>,
        permission: string,
        execute: () => Promise<T>
    ): Promise<T>;
    finalize(input: {
        terminationReason: TerminationReason;
        finalAnswerPolicy?: FinalAnswerPolicyResult;
        evidence: ReturnType<import('../../context/runtimeEvidencePolicy.js').RuntimeEvidencePolicy['snapshot']>;
        stepCount: number;
    }): Promise<void>;
    abort(): Promise<void>;
};

type ActiveRecorder = {
    telemetry: Telemetry;
    runSpan: SpanHandle;
    stepSpan?: SpanHandle;
    stepCount: number;
    modelCallCount: number;
    aborted: boolean;
};

export async function beginPiTraceRecorder(
    config: AgentConfig,
    userInstruction: string
): Promise<PiTraceRecorder | undefined> {
    if (!config.traceDir && config.telemetryBackend !== 'otlp') return undefined;

    const telemetry = createTelemetry({
        backend: config.telemetryBackend ?? 'file',
        traceDir: config.traceDir,
        otlpEndpoint: config.otlpTracesEndpoint,
        otlpProtocol: config.otlpProtocol
    });
    const runSpan = await telemetry.startSpan('wiki_agent.run', {
        attributes: {
            'wiki_agent.instruction': preview(redactSensitiveText(userInstruction)),
            'wiki_agent.instruction.sha256': createHash('sha256').update(userInstruction).digest('hex'),
            'gen_ai.request.model': config.modelName,
            'wiki_agent.harness': 'pi',
            ...(config.buildId ? { 'wiki_agent.build_id': config.buildId } : {})
        }
    });
    const state: ActiveRecorder = { telemetry, runSpan, stepCount: 0, modelCallCount: 0, aborted: false };
    return createRecorderFacade(state);
}

function createRecorderFacade(state: ActiveRecorder): PiTraceRecorder {
    return {
        get filePath() {
            return state.telemetry.filePath;
        },
        getStepCount() {
            return state.stepCount;
        },
        attachSessionListeners(session) {
            return session.subscribe(event => {
                if (state.aborted) return;
                if (event.type === 'turn_start') {
                    void onTurnStart(state);
                    return;
                }
                if (event.type === 'turn_end') {
                    void onTurnEnd(state);
                    return;
                }
                if (event.type === 'message_end') {
                    const message = (event as { message?: { role?: string; usage?: Record<string, unknown> } }).message;
                    if (message?.role === 'assistant') {
                        void onAssistantMessageEnd(state, message);
                    }
                }
            });
        },
        async instrumentToolCall(toolName, toolCallId, params, permission, execute) {
            const parent = state.stepSpan ?? state.runSpan;
            const argsStr = JSON.stringify(params);
            const startedAt = Date.now();
            const toolSpan = await parent.startChild('tool.execute', {
                attributes: {
                    'wiki_agent.step': state.stepCount,
                    'tool.name': toolName,
                    'tool.call_id': toolCallId,
                    ...buildToolArgumentTraceAttributes(argsStr)
                }
            });
            return runWithSpan(toolSpan, async () => {
                const observation = await execute();
                if (permission === 'rag') {
                    await toolSpan.addEvent('evidence.sufficiency', {
                        'tool.status': observation.status
                    });
                }
                await toolSpan.end({
                    status: observation.status === 'success' ? 'ok' : 'error',
                    attributes: {
                        'tool.status': observation.status,
                        'tool.duration_ms': Date.now() - startedAt
                    }
                });
                return observation;
            });
        },
        async finalize({ terminationReason, finalAnswerPolicy, evidence, stepCount }) {
            if (state.aborted) return;
            state.aborted = true;
            if (finalAnswerPolicy && state.stepSpan) {
                await state.stepSpan.addEvent('final_answer.policy', {
                    'wiki_agent.final_answer.action': finalAnswerPolicy.action,
                    'wiki_agent.final_answer.reason': finalAnswerPolicy.reason,
                    'wiki_agent.rag.calls_used': finalAnswerPolicy.snapshot.ragCallsUsed,
                    'evidence.state': finalAnswerPolicy.snapshot.inventoryState,
                    'evidence.count': finalAnswerPolicy.snapshot.evidenceCount,
                    'evidence.distinct_sources': finalAnswerPolicy.snapshot.distinctSources,
                    'evidence.cited_count': finalAnswerPolicy.snapshot.citedCount,
                    'evidence.truncated_count': finalAnswerPolicy.snapshot.truncatedCount,
                    'evidence.conflicted_count': finalAnswerPolicy.snapshot.conflictedCount,
                    'evidence.low_authority_count': finalAnswerPolicy.snapshot.lowAuthorityCount
                });
            }
            await state.stepSpan?.end().catch(() => undefined);
            await state.runSpan.end({
                status: terminationReason === 'completed' ? 'ok' : 'error',
                attributes: {
                    'wiki_agent.termination_reason': terminationReason,
                    'wiki_agent.step_count': stepCount,
                    'wiki_agent.rag.calls_used': evidence.ragCallsUsed,
                    'wiki_agent.rag.budget_exhausted': evidence.ragBudgetExhausted,
                    'evidence.state': evidence.inventoryState,
                    'evidence.count': evidence.evidenceCount,
                    'evidence.distinct_sources': evidence.distinctSources,
                    'evidence.cited_count': evidence.citedCount,
                    'evidence.truncated_count': evidence.truncatedCount,
                    'evidence.conflicted_count': evidence.conflictedCount,
                    'evidence.low_authority_count': evidence.lowAuthorityCount,
                    ...(evidence.ragCallsRemaining === undefined
                        ? {}
                        : { 'wiki_agent.rag.calls_remaining': evidence.ragCallsRemaining }),
                    ...(finalAnswerPolicy ? {
                        'wiki_agent.final_answer.action': finalAnswerPolicy.action,
                        'wiki_agent.final_answer.reason': finalAnswerPolicy.reason
                    } : {})
                }
            });
            await state.telemetry.shutdown();
        },
        async abort() {
            if (state.aborted) return;
            state.aborted = true;
            await state.stepSpan?.end({ status: 'error' }).catch(() => undefined);
            await state.runSpan.end({ status: 'error', attributes: { 'wiki_agent.termination_reason': 'system_error' } });
            await state.telemetry.shutdown();
        }
    };
}

async function onTurnStart(state: ActiveRecorder): Promise<void> {
    await state.stepSpan?.end().catch(() => undefined);
    state.stepCount += 1;
    state.stepSpan = await state.runSpan.startChild(`wiki_agent.step.${state.stepCount}`, {
        attributes: { 'wiki_agent.step': state.stepCount }
    });
}

async function onTurnEnd(state: ActiveRecorder): Promise<void> {
    await state.stepSpan?.addEvent('assistant_message', {
        'wiki_agent.step': state.stepCount
    });
}

async function onAssistantMessageEnd(
    state: ActiveRecorder,
    message: { usage?: Record<string, unknown>; stopReason?: string; errorMessage?: string }
): Promise<void> {
    const parent = state.stepSpan ?? state.runSpan;
    state.modelCallCount += 1;
    const modelSpan = await parent.startChild('gen_ai.chat', {
        kind: 'client',
        attributes: {
            'gen_ai.operation.name': 'chat',
            'wiki_agent.step': state.stepCount,
            'wiki_agent.model_call_index': state.modelCallCount
        }
    });
    const usage = normalizePiUsage(message.usage);
    const isError = message.stopReason === 'error';
    await modelSpan.end({
        status: isError ? 'error' : 'ok',
        attributes: {
            ...(usage.promptTokens !== undefined ? { 'gen_ai.usage.input_tokens': usage.promptTokens } : {}),
            ...(usage.completionTokens !== undefined ? { 'gen_ai.usage.output_tokens': usage.completionTokens } : {}),
            ...(usage.totalTokens !== undefined ? { 'gen_ai.usage.total_tokens': usage.totalTokens } : {}),
            ...(message.errorMessage ? { 'error.message': preview(message.errorMessage, 512) } : {})
        }
    });
}

function normalizePiUsage(usage: Record<string, unknown> | undefined): {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
} {
    if (!usage) return {};
    return {
        promptTokens: readUsageNumber(usage.input ?? usage.prompt_tokens),
        completionTokens: readUsageNumber(usage.output ?? usage.completion_tokens),
        totalTokens: readUsageNumber(usage.totalTokens ?? usage.total_tokens)
    };
}

function readUsageNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
