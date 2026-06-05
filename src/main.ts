import { AgentConfig } from './types.js';
import { ClaudeMiniAgent, ToolRegistry } from './agent.js';
import { MemoryManager } from './memory.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 Claude Code Mini 工厂：Day 23 记忆芯片装配完毕");
    console.log("=================================================\n");

    // 1. 定义 Claude Code Mini 的灵魂 System Prompt
    const CLAUDE_CODE_SOUL = `
    你是一个由 Node.js 驱动、高度专业且极其硬核的终端自动化 Agent (Claude Code Mini)。
    你拥有直接操作本地文件和执行 Shell 命令的最高特权。
    请始终保持冷静、严谨、多用数据说话，完美达成用户的重构与分析指标。
    `.trim();

    // 2. 初始化核心配置与组件
    const config: AgentConfig = {
        modelName: 'deepseek-chat',
        temperature: 0.1,
        maxLoopSteps: 5
    };

    // 🎯 核心变更：实例化真正的工业级记忆管理器，注入灵魂 Prompt
    const memory = new MemoryManager(CLAUDE_CODE_SOUL);
    const registry = new ToolRegistry();

    // 3. 实例化 Agent
    const agent = new ClaudeMiniAgent(config, memory, registry);

    // 4. 驱动测试第一轮
    console.log("--- 🪐 模拟测试：注入第一轮对话 ---");
    await agent.run("列出当前项目目录", (chunk) => {
        console.log(`🤖 Agent 响应 > ${chunk}`);
    });

    // 5. 验证记忆状态
    console.log("\n--- 🔍 记忆状态深度审计 ---");
    console.log(`当前记忆池中总消息数: ${memory.getMessages().length} 条`);
    console.log(`大模型感知到的多轮有效对话轮数: ${memory.getRoundCount()} 轮`);
    console.log("首条锁定记忆内容:", memory.getMessages()[0]);

    // 6. 测试重置
    console.log("\n--- 🧹 触发紧急重置防护 ---");
    memory.clear();
    console.log(`重置后剩余消息数: ${memory.getMessages().length} 条 (验证是否仅保留 System Prompt)`);
    console.log("剩余记忆:", memory.getMessages());

    console.log("\n🎉 Day 23 记忆芯片功能完美闭环！随时可向 Day 24 进化。");
}

main();
