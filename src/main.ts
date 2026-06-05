import { AgentConfig } from './types.js';
import { ClaudeMiniAgent, ToolRegistry } from './agent.js';
import { MemoryManager } from './memory.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './tools/fileTool.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 Claude Code Mini 工厂：Day 24 真·文件工具链就绪");
    console.log("=================================================\n");

    const CLAUDE_CODE_SOUL = "你是一个具备真实本地文件系统读写能力的硬核终端自动化 Agent。";

    // 1. 初始化核心组件
    const config: AgentConfig = { modelName: 'deepseek-chat', temperature: 0.1, maxLoopSteps: 5 };
    const memory = new MemoryManager(CLAUDE_CODE_SOUL);

    // 2. 实例化工具注册中心，并将工具疯狂挂载上去
    const registry = new ToolRegistry();
    registry.register(new ListDirTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());

    // 3. 实例化大脑
    const agent = new ClaudeMiniAgent(config, memory, registry);

    // ===================================================
    // 🧪 物理层真实链路压测
    // ===================================================
    console.log("\n--- 🔧 阶段一：进行本地文件系统真实 I/O 测试 ---");

    // 测试 1：动态写入一个真正的物理文件
    console.log("\n[测试] 尝试调用 write_file 写入磁盘...");
    const writeResult = await registry.execute("write_file", JSON.stringify({
        filename: "subfolder/hello_day24.txt",
        content: "Hello Node.js Real File System! This is written by Day24 Tool."
    }));
    console.log(`回执回显 -> ${writeResult}`);

    // 测试 2：扫描当前沙盒目录，验证文件是否真实存在
    console.log("\n[测试] 尝试调用 list_dir 扫描沙盒根目录...");
    const listResult = await registry.execute("list_dir", JSON.stringify({ relativePath: "." }));
    console.log(`目录扫描回显 -> ${listResult}`);

    // 测试 3：拦截恶意逃逸测试
    console.log("\n[安全测试] 故意传入逃逸相对路径，验证守卫是否有效...");
    try {
        await registry.execute("read_file", JSON.stringify({ filename: "../../../../etc/passwd" }));
    } catch (err: any) {
        console.log(`🚨 安全防火墙成功拦截报错: ${err.message}`);
    }

    // 4. 驱动大脑跑通最基础的工作流接口
    console.log("\n--- 🪐 阶段二：工作流握手 ---");
    await agent.run("确认工具箱工作状态", (chunk) => {
        console.log(`🤖 Agent > ${chunk}`);
    });

    console.log("\n🎉 Day 24 真实文件操控双手完美接入！且防御拉满。");
}

main();
