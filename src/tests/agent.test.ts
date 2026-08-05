import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { WikiAgent } from '../agent.js';
import type { TraceExportOptions, TraceExportReport } from '../trace/export.js';
import { AgentConfig, IAgentTool, IMemory, IToolRegistry, ToolResult } from '../types.js';
import { SafeTool } from './helpers.js';

type ChatChunk = {
    choices: Array<{
        delta: {
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
    };
};

class TestMemory implements IMemory {
    readonly messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    getMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return this.messages;
    }

    append(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void {
        this.messages.push(message);
    }

    clear(): void {
        this.messages.length = 0;
    }
}

class TestRegistry implements IToolRegistry {
    readonly tool = new SafeTool();
    readonly executeCalls: Array<{ name: string; argsStr: string }> = [];
    nextResult?: ToolResult;

    register(_tool: IAgentTool): void {}

    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return [this.tool.schema];
    }

    getTool(name: string): IAgentTool | undefined {
        return name === this.tool.name ? this.tool : undefined;
    }

    async execute(name: string, argsStr: string): Promise<ToolResult> {
        this.executeCalls.push({ name, argsStr });
        return this.nextResult ?? { status: 'success', data: { name, args: JSON.parse(argsStr || '{}') } };
    }

    has(name: string): boolean {
        return name === this.tool.name;
    }
}

function createAgent(options: {
    traceDir: string;
    memory?: TestMemory;
    registry?: TestRegistry;
    maxLoopSteps?: number;
    capturePromptArtifacts?: boolean;
    traceArtifactDir?: string;
    traceExporter?: (options: TraceExportOptions) => Promise<TraceExportReport>;
}): WikiAgent {
    process.env.API_KEY = process.env.API_KEY ?? 'test-api-key';

    const config: AgentConfig = {
        modelName: 'test-model',
        temperature: 0,
        maxLoopSteps: options.maxLoopSteps ?? 5,
        traceDir: options.traceDir,
        capturePromptArtifacts: options.capturePromptArtifacts,
        traceArtifactDir: options.traceArtifactDir,
        approvalMode: 'auto'
    };

    return new WikiAgent(
        config,
        options.memory ?? new TestMemory(),
        options.registry ?? new TestRegistry(),
        options.traceExporter ?? (async options => ({
            inputPath: options.inputPath,
            mode: 'exported',
            runCount: 1,
            spanCount: 0,
            eventCount: 0,
            skippedEventCount: 0,
            traceIds: []
        }))
    );
}

function attachFakeClient(agent: WikiAgent, streams: ChatChunk[][]): void {
    let callIndex = 0;
    const fakeClient = {
        chat: {
            completions: {
                create: async () => toAsyncIterable(streams[callIndex++] ?? [])
            }
        }
    };

    (agent as unknown as { client: unknown }).client = fakeClient;
}

async function* toAsyncIterable(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
    for (const chunk of chunks) {
        yield chunk;
    }
}

async function readTraceEvents(traceDir: string): Promise<Array<Record<string, unknown>>> {
    const files = await fs.readdir(traceDir);
    assert.equal(files.length, 1);

    const content = await fs.readFile(path.join(traceDir, files[0]), 'utf-8');
    return content.trim().split('\n').map(line => JSON.parse(line));
}

test('WikiAgent.run returns final streamed content without tool calls', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-'));
    const memory = new TestMemory();
    const agent = createAgent({ traceDir, memory });
    attachFakeClient(agent, [[
        { choices: [{ delta: { content: 'hello ' } }] },
        { choices: [{ delta: { content: 'world' } }] }
    ]]);

    let streamed = '';
    const result = await agent.run('hi', chunk => {
        streamed += chunk;
    });

    assert.equal(result, 'hello world');
    assert.equal(streamed, 'hello world');
    assert.equal(memory.messages[0].role, 'user');
    assert.equal(memory.messages[1].role, 'assistant');
    assert.equal(memory.messages[1].content, 'hello world');

    const events = await readTraceEvents(traceDir);
    const runEnd = events.find(event => event.type === 'span_end' && event.spanId === events.find(start => start.name === 'wiki_agent.run')?.spanId);
    assert.equal(runEnd?.status, 'ok');
});

test('WikiAgent records streamed cache usage on the model span', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-usage-'));
    const agent = createAgent({ traceDir });
    attachFakeClient(agent, [[
        { choices: [{ delta: { content: 'done' } }] },
        {
            choices: [],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_cache_hit_tokens: 75,
                prompt_cache_miss_tokens: 25
            }
        }
    ]]);

    await agent.run('trace usage', () => {});
    const events = await readTraceEvents(traceDir);
    const modelSpan = events.find(event => event.type === 'span_end' && event.spanId === events.find(start => start.name === 'gen_ai.chat')?.spanId);
    const attributes = modelSpan?.attributes as Record<string, unknown>;
    assert.equal(attributes['gen_ai.usage.total_tokens'], 120);
    assert.equal(attributes['gen_ai.usage.input_tokens'], 100);
    assert.equal(attributes['gen_ai.usage.output_tokens'], 20);
    assert.equal(attributes['gen_ai.usage.cache_hit_tokens'], 75);
    assert.equal(attributes['gen_ai.usage.cache_miss_tokens'], 25);
});

test('WikiAgent links an optional prompt artifact from its model span', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-artifact-trace-'));
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-artifact-'));
    const agent = createAgent({ traceDir, capturePromptArtifacts: true, traceArtifactDir: artifactDir });
    attachFakeClient(agent, [[{ choices: [{ delta: { content: 'done' } }] }]]);

    await agent.run('capture this prompt', () => {});

    const [artifactName] = await fs.readdir(artifactDir);
    const artifact = JSON.parse(await fs.readFile(path.join(artifactDir, artifactName!), 'utf-8')) as Record<string, unknown>;
    assert.equal((artifact.request as { messages: Array<{ content: string }> }).messages[0]?.content, 'capture this prompt');

    const events = await readTraceEvents(traceDir);
    const modelEnd = events.find(event => event.type === 'span_end' && event.spanId === events.find(start => start.name === 'gen_ai.chat')?.spanId);
    const attributes = modelEnd?.attributes as Record<string, unknown>;
    assert.match(attributes['wiki_agent.prompt_artifact.path'] as string, /prompt-/);
    assert.match(attributes['wiki_agent.prompt_artifact.sha256'] as string, /^[a-f0-9]{64}$/);
    assert.equal(attributes['wiki_agent.prompt_artifact.redacted'], true);
});

test('WikiAgent automatically exports its completed file trace to local Jaeger', async () => {
    let receivedOptions: TraceExportOptions | undefined;
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-auto-export-'));
    const agent = createAgent({
        traceDir,
        traceExporter: async options => {
            receivedOptions = options;
            return {
                inputPath: options.inputPath,
                mode: 'exported',
                runCount: 1,
                spanCount: 3,
                eventCount: 0,
                skippedEventCount: 0,
                traceIds: []
            };
        }
    });
    attachFakeClient(agent, [[{ choices: [{ delta: { content: 'done' } }] }]]);

    await agent.run('export this trace', () => {});

    assert.equal(receivedOptions?.endpoint, 'http://127.0.0.1:4318/v1/traces');
    assert.equal(receivedOptions?.timeoutMillis, 3_000);
    assert.match(await fs.readFile(receivedOptions!.inputPath, 'utf-8'), /"type":"span_end"/);
});

test('WikiAgent.run executes tool calls and continues replanning', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-'));
    const memory = new TestMemory();
    const registry = new TestRegistry();
    const agent = createAgent({ traceDir, memory, registry });
    attachFakeClient(agent, [
        [
            {
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'call_1',
                            function: { name: 'safe_tool', arguments: '{"value"' }
                        }]
                    }
                }]
            },
            {
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            function: { arguments: ':"ok"}' }
                        }]
                    }
                }]
            }
        ],
        [
            { choices: [{ delta: { content: 'done' } }] }
        ]
    ]);

    const result = await agent.run('use a tool', () => {});

    assert.equal(result, 'done');
    assert.deepEqual(registry.executeCalls, [{ name: 'safe_tool', argsStr: '{"value":"ok"}' }]);
    assert.equal(memory.messages.some(message => message.role === 'tool'), true);

    const events = await readTraceEvents(traceDir);
    assert.equal(events.filter(event => event.type === 'span_start' && event.name === 'tool.execute').length, 1);
    const spans = events.filter(event => event.type === 'span_start');
    const runSpan = spans.find(event => event.name === 'wiki_agent.run');
    const stepSpan = spans.find(event => event.name === 'wiki_agent.step.1');
    const toolSpan = spans.find(event => event.name === 'tool.execute');
    assert.equal(stepSpan?.parentSpanId, runSpan?.spanId);
    assert.equal(toolSpan?.parentSpanId, stepSpan?.spanId);
    assert.equal((toolSpan?.attributes as Record<string, unknown>)?.['tool.call_id'], 'call_1');
    assert.equal((toolSpan?.attributes as Record<string, unknown>)?.['tool.call_index'], 0);
    assert.equal((toolSpan?.attributes as Record<string, unknown>)?.['tool.arguments.preview'], '{"value":"ok"}');
    assert.match((toolSpan?.attributes as Record<string, unknown>)?.['tool.arguments.sha256'] as string, /^[a-f0-9]{64}$/);
    assert.equal(events.filter(event => event.type === 'span_end').length > 0, true);
});

test('WikiAgent records bounded tool error messages in failed tool spans', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-error-'));
    const registry = new TestRegistry();
    registry.nextResult = {
        status: 'execution_failed',
        error: 'remote filesystem denied access'
    };
    const agent = createAgent({ traceDir, registry });
    attachFakeClient(agent, [
        [{
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'call_error',
                        function: { name: 'safe_tool', arguments: '{}' }
                    }]
                }
            }]
        }],
        [{ choices: [{ delta: { content: 'recovered' } }] }]
    ]);

    await agent.run('use a failing tool', () => {});

    const events = await readTraceEvents(traceDir);
    const toolEnd = events.find(event => event.type === 'span_end'
        && event.spanId === events.find(start => start.type === 'span_start' && start.name === 'tool.execute')?.spanId);
    const attributes = toolEnd?.attributes as Record<string, unknown>;
    assert.equal(toolEnd?.status, 'error');
    assert.equal(attributes['tool.status'], 'execution_failed');
    assert.equal(attributes['error.message'], 'remote filesystem denied access');
    assert.equal(attributes['error.message.truncated'], false);
});

test('WikiAgent.run stops before model calls when maxLoopSteps is exceeded', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-agent-'));
    const agent = createAgent({ traceDir, maxLoopSteps: 0 });
    let modelCalls = 0;
    const fakeClient = {
        chat: {
            completions: {
                create: async () => {
                    modelCalls++;
                    return toAsyncIterable([]);
                }
            }
        }
    };
    (agent as unknown as { client: unknown }).client = fakeClient;

    const result = await agent.run('stop immediately', () => {});

    assert.equal(result, '');
    assert.equal(modelCalls, 0);

    const events = await readTraceEvents(traceDir);
    const runEnd = events.find(event => event.type === 'span_end' && event.spanId === events.find(start => start.name === 'wiki_agent.run')?.spanId);
    assert.equal((runEnd?.attributes as Record<string, unknown>)?.['wiki_agent.termination_reason'], 'max_loop_steps');
});
