import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { WikiAgent } from '../agent.js';
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

    register(_tool: IAgentTool): void {}

    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return [this.tool.schema];
    }

    getTool(name: string): IAgentTool | undefined {
        return name === this.tool.name ? this.tool : undefined;
    }

    async execute(name: string, argsStr: string): Promise<ToolResult> {
        this.executeCalls.push({ name, argsStr });
        return { status: 'success', data: { name, args: JSON.parse(argsStr || '{}') } };
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
}): WikiAgent {
    process.env.API_KEY = process.env.API_KEY ?? 'test-api-key';

    const config: AgentConfig = {
        modelName: 'test-model',
        temperature: 0,
        maxLoopSteps: options.maxLoopSteps ?? 5,
        traceDir: options.traceDir,
        approvalMode: 'auto'
    };

    return new WikiAgent(config, options.memory ?? new TestMemory(), options.registry ?? new TestRegistry());
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
    assert.equal(events.at(-1)?.type, 'run_end');
    assert.equal(events.at(-1)?.terminationReason, 'completed');
});

test('WikiAgent records streamed cache usage in the debug trace', async () => {
    const previousTraceLevel = process.env.TRACE_LEVEL;
    process.env.TRACE_LEVEL = 'debug';
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

    try {
        await agent.run('trace usage', () => {});
        const events = await readTraceEvents(traceDir);
        const budgetEvent = events.find(event => event.type === 'model_call_budget');
        assert.deepEqual(budgetEvent?.usage, {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cacheHitTokens: 75,
            cacheMissTokens: 25,
            cacheHitRate: 0.75
        });
    } finally {
        if (previousTraceLevel === undefined) {
            delete process.env.TRACE_LEVEL;
        } else {
            process.env.TRACE_LEVEL = previousTraceLevel;
        }
    }
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
    assert.equal(events.filter(event => event.type === 'tool_result').length, 1);
    assert.equal(events.at(-1)?.terminationReason, 'completed');
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
    assert.equal(events.at(-1)?.type, 'run_end');
    assert.equal(events.at(-1)?.terminationReason, 'max_loop_steps');
});
