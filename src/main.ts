import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { AgentConfig, ApprovalMode, ApprovalRequest } from './types.js';
import { MemoryManager } from './memory.js';
import { WikiAgent, ToolRegistry } from './agent.js';
import { buildSkillManifestPrompt, loadSkillManifests } from './skills.js';
import { ShellExecuteTool } from './tools/shellTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './tools/fileTool.js';
import { GlobSearchTool, GrepSearchTool } from './tools/searchTool.js';
import { ReadNoteTool, RelatedNotesTool, SearchNotesTool } from './tools/ragTool.js';
import { ApplyPatchTool, GitDiffTool, GitStatusTool, RunTestsTool } from './tools/codingTool.js';
import { LoadSkillTool } from './tools/skillTool.js';

type ReadlineInterface = ReturnType<typeof readline.createInterface>;

async function main() {
    console.log("=================================================");
    console.log("🚀 wiki-agent");
    console.log("=================================================\n");

    const WIKI_AGENT_SOUL = `
    你是 wiki-agent，一个面向个人和团队知识库的 Agentic RAG 助手。
    你的长期目标是连接多种知识来源，并基于可引用证据回答问题。当前阶段的内置知识源是本地 Markdown 笔记库。
    你的核心模式不能变：先根据任务规划，再把知识检索作为工具调用，观察结果写回上下文，必要时继续检索或读取，最后基于证据回答。

    【你的标准行动路线】：
    1. 用户问概念、经验、复盘、读书笔记、项目知识或历史决策时，优先调用 search_notes 检索当前已索引的知识库。
    2. 用户指定某篇 Markdown 笔记时，调用 read_note 查看该笔记的结构化片段。
    3. 用户想找关联主题、延伸阅读或知识网络时，调用 related_notes。
    4. 如果笔记索引证据不足，可以使用 grep_search / glob_search 在沙箱内做补充搜索。
    5. 回答必须区分“笔记中明确写到的内容”和“你的推断”，并尽量给出 source、titlePath、tags 或 citation。
    6. 处理代码任务时，优先使用 git_status / git_diff 观察变更，使用 glob_search / grep_search 定位代码，必要时使用 apply_patch 做精确修改，并用 run_tests 验证。
    7. 不要编造不存在的笔记内容；检索不到就明确说明，并建议补充哪些笔记。
    8. Shell、测试命令和写文件属于高风险能力，只有观察证据充分且确有必要时才使用，并遵守审批结果。
    `.trim();

    const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
    const systemPrompt = skillManifestPrompt
        ? `${WIKI_AGENT_SOUL}\n\n${skillManifestPrompt}`
        : WIKI_AGENT_SOUL;

    const rl = readline.createInterface({ input, output });
    const approvalMode = getApprovalMode();

    // 初始化 Agent 运行时配置
    const config: AgentConfig = {
        modelName: process.env.DEEPSEEK_MODEL_NAME ?? "deepseek-v4-pro",
        temperature: 0.1,
        maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
        traceDir: process.env.TRACE_DIR ?? 'traces',
        autoApproveDangerousTools: approvalMode === 'auto',
        approvalMode,
        requestApproval: request => askToolApproval(rl, request)
    };
    const memory = new MemoryManager(systemPrompt);
    const registry = new ToolRegistry();

    // 挂载所有物理大杀器工具
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
    const oneShotInstruction = process.argv.slice(2).join(' ').trim();

    if (oneShotInstruction) {
        await agent.run(oneShotInstruction, chunk => process.stdout.write(chunk));
        rl.close();
        return;
    }

    console.log('进入多轮 REPL。输入 exit / quit 退出，输入 clear 清空对话记忆。');

    while (true) {
        const instruction = (await rl.question('\n你 > ')).trim();
        if (!instruction) continue;
        if (['exit', 'quit'].includes(instruction.toLowerCase())) break;
        if (instruction.toLowerCase() === 'clear') {
            memory.clear();
            continue;
        }

        await agent.run(instruction, chunk => process.stdout.write(chunk));
        process.stdout.write('\n');
    }

    rl.close();
}

function getApprovalMode(): ApprovalMode {
    if (process.env.AUTO_APPROVE_DANGEROUS_TOOLS === 'true') return 'auto';
    const value = (process.env.APPROVAL_MODE ?? 'prompt').toLowerCase();
    return ['auto', 'prompt', 'deny'].includes(value) ? value as ApprovalMode : 'prompt';
}

async function askToolApproval(rl: ReadlineInterface, request: ApprovalRequest): Promise<boolean> {
    console.log('\n[Tool approval required]');
    console.log(`tool: ${request.toolName}`);
    console.log(`risk: ${request.riskLevel}`);
    console.log(`reason: ${request.reason}`);
    console.log(`args: ${JSON.stringify(request.args, null, 2)}`);

    const answer = (await rl.question('Approve tool execution? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
}

main();
