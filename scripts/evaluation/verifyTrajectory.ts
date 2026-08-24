import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentEvalQuestion } from '../../src/evaluation/agent.js';
import { validateTaskContract } from '../../src/evaluation/taskContract.js';
import { parseJsonlV2 } from '../../src/evaluation/trajectoryModel.js';
import { verifyTrajectory } from '../../src/evaluation/trajectoryVerifier.js';

const USAGE = `Usage:
  npm run eval:verify -- -- --trace <trace.jsonl> --question-id <id> [--questions <questions.json>] [--answer-file <answer.txt>]

Reads an existing trace and evaluates its TaskContract without creating an Agent or calling a model.`;

/**
 * 已有 Agent 轨迹的确定性离线复核入口。
 *
 * 通过 `npm run eval:verify` 显式调用，读取题目的 TaskContract、JSONL v2
 * Trace 和可选答案文件，检查答案词面、证据来源、工具使用、预算、终止轨迹
 * 与安全约束并输出 JSON 报告；不创建 Agent、不调用 LLM、不修改原始 Trace。
 * hard contract 未通过时返回非零退出码，soft contract 仅报告检查结果。
 */
async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return;
    }
    if (!args.trace || !args.questionId) throw new Error(`--trace and --question-id are required\n\n${USAGE}`);
    const questionsFile = path.resolve(args.questions ?? 'evaluation/questions.json');
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as AgentEvalQuestion[];
    const question = questions.find(item => item.id === args.questionId);
    if (!question) throw new Error(`unknown question id: ${args.questionId}`);
    if (!question.contract) throw new Error(`question ${args.questionId} has no TaskContract`);
    const contract = validateTaskContract(question.contract, `question ${question.id}.contract`);
    const [trace, answer] = await Promise.all([
        fs.readFile(path.resolve(args.trace), 'utf-8'),
        args.answerFile ? fs.readFile(path.resolve(args.answerFile), 'utf-8') : Promise.resolve('')
    ]);
    const report = verifyTrajectory({ contract, question, answer, records: parseJsonlV2(trace) });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed && contract.strictness === 'hard') process.exitCode = 1;
}

type VerifyArgs = {
    help: boolean;
    trace?: string;
    questions?: string;
    questionId?: string;
    answerFile?: string;
};

function parseArgs(args: string[]): VerifyArgs {
    const result: VerifyArgs = { help: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--') continue;
        if (arg === '--help' || arg === '-h') {
            result.help = true;
            continue;
        }
        const value = args[++index];
        if (!value) throw new Error(`${arg} requires a value`);
        if (arg === '--trace') result.trace = value;
        else if (arg === '--questions') result.questions = value;
        else if (arg === '--question-id') result.questionId = value;
        else if (arg === '--answer-file') result.answerFile = value;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return result;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
