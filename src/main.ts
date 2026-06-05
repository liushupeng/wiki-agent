import { AgentConfig } from './types.js';
import { MemoryManager } from './memory.js';
import { ClaudeMiniAgent, ToolRegistry } from './agent.js';
import { ShellExecuteTool } from './tools/shellTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './tools/fileTool.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 Claude Code Mini 工厂：Day 25 真·终端命令工具链就绪");
    console.log("=================================================\n");

    const CLAUDE_CODE_SOUL = "你是一个高度专业且具备本地真实终端命令执行特权的 AI 智能体。";

    // 1. 初始化核心组件
    const config: AgentConfig = { modelName: 'deepseek-chat', temperature: 0.1, maxLoopSteps: 5 };
    const memory = new MemoryManager(CLAUDE_CODE_SOUL);

    // 2. 将昨天的文件系统和今天的 Shell 外壳工具全部注册进底盘
    const registry = new ToolRegistry();
    registry.register(new ListDirTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new ShellExecuteTool()); // 🎯 注入系统级外壳超能力

    const agent = new ClaudeMiniAgent(config, memory, registry);

    // ===================================================
    // 🧪 物理层真实终端链路压测
    // ===================================================
    console.log("\n--- 💻 阶段一：进行操作系统真实 Shell 链路测试 ---");

    // 测试 1：执行基础安全命令（查看当前沙盒的绝对路径）
    // 提示：Windows 下用 'cd'，Mac/Linux 下用 'pwd'。为了跨平台兼容，我们测试跑一个通用的查看平台命令
    const isWin = process.platform === "win32";
    const testCmd = isWin ? "echo %cd%" : "pwd";

    console.log(`\n[测试] 尝试让子进程执行查看路径命令: [${testCmd}]...`);
    const pathResult = await registry.execute("execute_command", JSON.stringify({ command: testCmd }));
    console.log(`操作系统回执 -> ${pathResult}`);

    // 测试 2：利用 Shell 列出当前沙盒目录（与昨天的 fs 形成跨界双重验证）
    const listCmd = isWin ? "dir /b" : "ls";
    console.log(`\n[测试] 尝试让子进程执行列出目录命令: [${listCmd}]...`);
    const listResult = await registry.execute("execute_command", JSON.stringify({ command: listCmd }));
    console.log(`操作系统回执 -> ${listResult}`);

    // 测试 3：高危命令毁灭性拦截测试
    console.log("\n[高危测试] 故意让大模型执行 rm -rf 毁灭性删除命令，验证防火墙是否有效...");
    const dangerResult = await registry.execute("execute_command", JSON.stringify({ command: "rm -rf subfolder" }));
    console.log(`安全卫士拦截反馈 -> ${dangerResult}`);

    // 3. 工作流握手
    console.log("\n--- 🪐 阶段二：工作流握手 ---");
    await agent.run("确认命令外壳工作状态", (chunk) => {
        console.log(`🤖 Agent > ${chunk}`);
    });

    console.log("\n🎉 Day 25 真实系统终端操控接口完美激活！防线坚不可摧。");
}

main();
