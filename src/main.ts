import OpenAI from 'openai';
import { IMemory, AgentConfig } from './types.js';
import { ClaudeMiniAgent, ToolRegistry } from './agent.js';

// 临时最简记忆，用于今日试车（明天 Day 23 将会被独立的工业级 memory.ts 彻底替换）
class TemporaryMemory implements IMemory {
    private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: "你是一个类似 Claude Code 的硬核终端自动化智能体。" }
    ];
    getMessages() { return this.history; }
    append(msg: OpenAI.Chat.Completions.ChatCompletionMessageParam) { this.history.push(msg); }
    clear() { this.history = []; }
}

async function main() {
    console.log("=================================================");
    console.log("🚀 Claude Code Mini 工厂：Day 22 架构契约搭建完毕");
    console.log("=================================================");

    // 1. 初始化组件
    const config: AgentConfig = { modelName: 'deepseek-chat', temperature: 0.1, maxLoopSteps: 5 };
    const memory = new TemporaryMemory();
    const registry = new ToolRegistry();

    // 2. 实例化真·Agent
    const agent = new ClaudeMiniAgent(config, memory, registry);

    // 3. 驱动测试
    await agent.run("分析当前项目", (chunk) => {
        console.log(`📝 终端即时回显 > ${chunk}`);
    });

    console.log("\n🎉 Day 22 编译与架构握手 100% 成功！骨架已锁死。");
}

main();
