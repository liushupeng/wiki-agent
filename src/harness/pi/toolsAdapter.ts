import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import OpenAI from 'openai';
import { buildToolObservation } from '../../context/toolObservation.js';
import { EvidenceLedger } from '../../context/evidenceSufficiency.js';
import { RuntimeEvidencePolicy } from '../../context/runtimeEvidencePolicy.js';
import { Color } from '../../cli/colors.js';
import { buildToolArgumentTraceAttributes } from '../../trace/artifacts.js';
import type { IAgentTool, IToolRegistry } from '../../types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { PiTraceRecorder } from './traceAdapter.js';

export type PiToolRuntimeContext = {
    toolExecutor: ToolExecutor;
    evidencePolicy: RuntimeEvidencePolicy;
    evidenceLedger: EvidenceLedger;
    traceRecorder?: PiTraceRecorder;
    /** Pi turn 内执行过工具时，由 PiAgent.run 用于打印 Replanning 提示。 */
    noteToolExecuted?: () => void;
};

export function listWikiToolsForPi(registry: IToolRegistry): IAgentTool[] {
    return registry.getSchemas()
        .map(schema => (schema.type === 'function' ? registry.getTool(schema.function.name) : undefined))
        .filter((tool): tool is IAgentTool => tool !== undefined);
}

export function collectPiToolNames(registry: IToolRegistry): string[] {
    return listWikiToolsForPi(registry).map(tool => tool.name);
}

export function buildPiCustomTools(registry: IToolRegistry, runtime: PiToolRuntimeContext) {
    return listWikiToolsForPi(registry).map(tool => adaptWikiTool(tool, runtime));
}

function adaptWikiTool(tool: IAgentTool, runtime: PiToolRuntimeContext) {
    const openAiSchema = tool.schema;
    if (openAiSchema.type !== 'function') {
        throw new Error(`Pi adapter 仅支持 function 工具：${tool.name}`);
    }

    const parameters = openAiParametersToTypeBox(openAiSchema.function.parameters);
    const description = openAiSchema.function.description ?? tool.name;

    return defineTool({
        name: tool.name,
        label: tool.name,
        description,
        promptSnippet: description,
        parameters,
        executionMode: tool.isReadOnly ? 'parallel' : 'sequential',
        execute: async (toolCallId: string, params: Record<string, unknown>) =>
            executeWikiTool(tool, runtime, toolCallId, params)
    });
}

async function executeWikiTool(
    tool: IAgentTool,
    runtime: PiToolRuntimeContext,
    toolCallId: string,
    params: Record<string, unknown>
): Promise<AgentToolResult> {
    const runTool = async () => executeWikiToolBody(tool, runtime, params);
    if (runtime.traceRecorder) {
        return mapToolResult(await runtime.traceRecorder.instrumentToolCall(
            tool.name,
            toolCallId,
            params,
            tool.permission,
            runTool
        ));
    }
    return mapToolResult(await runTool());
}

function mapToolResult(observation: import('../../types.js').ToolResult): AgentToolResult {
    const packed = buildToolObservation(observation);
    return {
        content: [{ type: 'text', text: packed.content }],
        details: {
            status: observation.status,
            ...(observation.error ? { error: observation.error } : {}),
            truncated: packed.truncated
        }
    };
}

async function executeWikiToolBody(
    tool: IAgentTool,
    runtime: PiToolRuntimeContext,
    params: Record<string, unknown>
): Promise<import('../../types.js').ToolResult> {
    if (tool.permission === 'rag' && !runtime.evidencePolicy.canCallRag()) {
        return {
            status: 'retry_limit_reached',
            error: 'RAG runtime budget exhausted; answer with established evidence and explicit gaps',
            metadata: { runtimePolicy: 'max_rag_calls' }
        };
    }

    if (tool.permission === 'rag') {
        runtime.evidencePolicy.recordRagCall();
    }

    const safeArguments = buildToolArgumentTraceAttributes(JSON.stringify(params))['tool.arguments.preview'];
    console.log(Color.magenta(`🔌 [工具激活] [${tool.name}] -> 参数: ${String(safeArguments)}`));
    const observation = await runtime.toolExecutor.execute(tool.name, JSON.stringify(params));
    runtime.noteToolExecuted?.();
    const recordedEvidence = runtime.evidenceLedger.recordToolResult(tool.name, observation);
    let assessment = runtime.evidenceLedger.assess();

    const buildPackedObservation = () => buildToolObservation(tool.permission === 'rag'
        ? {
            ...observation,
            metadata: {
                ...observation.metadata,
                runtimeEvidencePolicy: runtime.evidencePolicy.buildModelFeedback(assessment)
            }
        }
        : observation);

    let packed = buildPackedObservation();
    if (packed.truncated && recordedEvidence.length > 0) {
        for (const entry of recordedEvidence) {
            runtime.evidenceLedger.record({ ...entry, truncated: true });
        }
        assessment = runtime.evidenceLedger.assess();
        packed = buildPackedObservation();
    }

    if (tool.permission === 'rag') {
        return {
            ...observation,
            metadata: {
                ...observation.metadata,
                runtimeEvidencePolicy: runtime.evidencePolicy.buildModelFeedback(assessment)
            }
        };
    }
    return observation;
}

function openAiParametersToTypeBox(parameters: OpenAI.FunctionParameters | undefined): TSchema {
    if (parameters && typeof parameters === 'object') {
        return Type.Unsafe(parameters as Record<string, unknown>);
    }
    return Type.Object({});
}
