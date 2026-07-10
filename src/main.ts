import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { AgentConfig } from './types.js';
import { askToolApproval } from './cli/approvalPrompt.js';
import { getApprovalMode } from './config.js';
import { MemoryManager } from './memory.js';
import { WikiAgent } from './agent.js';
import { WIKI_AGENT_SYSTEM_PROMPT } from './prompts/systemPrompt.js';
import { buildSkillManifestPrompt, loadSkillManifests } from './skills.js';
import { ShellExecuteTool } from './tools/shellTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './tools/fileTool.js';
import { GlobSearchTool, GrepSearchTool } from './tools/searchTool.js';
import { ReadNoteTool, RelatedNotesTool, SearchNotesTool } from './tools/ragTool.js';
import { ToolRegistry } from './tools/registry.js';
import { ApplyPatchTool, GitDiffTool, GitStatusTool, RunTestsTool } from './tools/codingTool.js';
import { LoadSkillTool } from './tools/skillTool.js';

async function main() {
    console.log("=================================================");
    console.log("🚀 wiki-agent");
    console.log("=================================================\n");

    const rl = readline.createInterface({ input, output });

    // 初始化 Agent 运行时配置
    const config: AgentConfig = {
        modelName: process.env.DEEPSEEK_MODEL_NAME ?? "deepseek-v4-pro",
        temperature: 0.1,
        maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
        traceDir: process.env.TRACE_DIR ?? 'trace_dir',
        approvalMode: getApprovalMode(),
        requestApproval: request => askToolApproval(rl, request)
    };

    // 初始化 Memory (system prompt + skill manifest)
    const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
    const systemPrompt = skillManifestPrompt
        ? `${WIKI_AGENT_SYSTEM_PROMPT}\n\n${skillManifestPrompt}`
        : WIKI_AGENT_SYSTEM_PROMPT;
    const memory = new MemoryManager(systemPrompt);

    // 初始化工具注册中心 (TODO: 未来可以支持动态加载工具)
    const registry = new ToolRegistry();
    registry.register(new ListDirTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new GlobSearchTool());
    registry.register(new GrepSearchTool());
    registry.register(new SearchNotesTool());
    registry.register(new ReadNoteTool());
    registry.register(new RelatedNotesTool());
    registry.register(new LoadSkillTool());
    registry.register(new GitStatusTool());
    registry.register(new GitDiffTool());
    registry.register(new ApplyPatchTool());
    registry.register(new RunTestsTool());
    registry.register(new ShellExecuteTool());

    const agent = new WikiAgent(config, memory, registry);

    // 单次运行模式: npm run ask -- "检索我的 Agent 笔记"
    const oneShotInstruction = process.argv.slice(2).join(' ').trim();
    if (oneShotInstruction) {
        await agent.run(oneShotInstruction, chunk => process.stdout.write(chunk));
        rl.close();
        return;
    }

    console.log('进入多轮 REPL。输入 exit / quit 退出，输入 clear 清空对话记忆。');

    while (true) {
        const instruction = (await rl.question('\n你 > ')).trim();
        if (!instruction) { continue; }
        if (['exit', 'quit'].includes(instruction.toLowerCase())) { break; }
        if (instruction.toLowerCase() === 'clear') {
            memory.clear();
            continue;
        }

        await agent.run(instruction, chunk => process.stdout.write(chunk));
        process.stdout.write('\n');
    }

    rl.close();
}

main();
