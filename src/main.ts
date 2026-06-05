import { AgentConfig } from './types.js';
import { MemoryManager } from './memory.js';
import { ClaudeMiniAgent, ToolRegistry } from './agent.js';
import { ShellExecuteTool } from './tools/shellTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './tools/fileTool.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 Claude Code Mini");
    console.log("=================================================\n");

    // 让智能体使用 思维链(COT) 进行思考和规划
    const CLAUDE_AUDITOR_SOUL = `
    你是一个极其资深的软件架构师兼高级自动化智能体 (Claude Code Mini)。
    现在你的主任务是对用户指定的代码库进行全量的技术栈与架构设计审计。

    【你的标准行动剖析路线】：
    1. 首先，务必使用 list_dir 或 Shell 命令查看项目根目录有哪些文件，切忌凭空盲猜。
    2. 发现核心配置文件（如 requirements.txt, package.json）时，优先调用 read_file 研判其依赖关系。
    3. 深入关键源码文件（如 main.py, database.py），读取内容并深度分析它们之间的模块引用与数据流向。
    4. 允许自发调用 Shell 命令（如 python -m py_compile 等或基础诊断）辅助你确认项目合法性。
    5. 汇总所有线索，最终输出一份结构极其漂亮、技术细节拉满的【项目全盘深度分析报告】。
    `.trim();

    // 初始化所有工程积木
    const config: AgentConfig = { modelName: process.env.DEEPSEEK_MODEL_NAME ?? "deepseek-v4-pro", temperature: 0.1, maxLoopSteps: 20 };
    const memory = new MemoryManager(CLAUDE_AUDITOR_SOUL);
    const registry = new ToolRegistry();

    // 挂载所有物理大杀器工具
    registry.register(new ListDirTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new ShellExecuteTool());

    const agent = new ClaudeMiniAgent(config, memory, registry);

    const AUDIT_INSTRUCTION = "分析当前安全沙盒内的 Python 项目。请帮我理清它的项目拓扑结构、核心功能模块、数据库设计情况、以及它引入了哪些外部依赖。最后在终端吐出最终报告。";

    await agent.run(AUDIT_INSTRUCTION, (chunk) => {
        // 实时流式打印大模型的自我思考
        process.stdout.write(chunk);
    });
}

main();
