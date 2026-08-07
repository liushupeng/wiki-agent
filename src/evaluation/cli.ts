import { parseEvaluationMode } from './experiments.js';

export type RecallEvalArgs = {
    questionsFile?: string;
    profile: string;
    variant: 'raw-only' | 'raw-wiki' | 'both';
    retriever: 'vector' | 'grep' | 'both';
    wikiFirst?: boolean;
};

export type AgentEvalArgs = {
    questionsFile?: string;
    profile: string;
    variant: 'raw-only' | 'raw-wiki' | 'both';
    randomCount?: number;
    seed?: string;
    questionIds?: string[];
};

export type EvaluationCommand<T> =
    | { action: 'help' }
    | { action: 'run'; args: T };

export function parseRecallEvalCommand(args: string[]): EvaluationCommand<RecallEvalArgs> {
    const values = meaningfulArguments(args);
    if (values.length === 0 || isHelpRequest(values, recallUsage)) return { action: 'help' };
    return { action: 'run', args: parseWithUsage(values, parseRecallEvalArgs, recallUsage) };
}

export function parseRecallEvalArgs(args: string[]): RecallEvalArgs {
    const result: RecallEvalArgs = { profile: 'bm25-v1', variant: 'both', retriever: 'vector' };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--') continue;
        if (argument === '--profile') {
            result.profile = requireValue(args, ++index, '--profile');
            continue;
        }
        if (argument === '--variant') {
            result.variant = parseVariant(requireValue(args, ++index, '--variant'));
            continue;
        }
        if (argument === '--retriever') {
            result.retriever = parseRetriever(requireValue(args, ++index, '--retriever'));
            continue;
        }
        if (argument === '--wiki-first') {
            result.wikiFirst = parseBoolean(requireValue(args, ++index, '--wiki-first'), '--wiki-first');
            continue;
        }
        if (!argument?.startsWith('--') && !result.questionsFile) {
            result.questionsFile = argument;
            continue;
        }
        throw new Error(recallUsage());
    }
    return result;
}

export function parseAgentEvalCommand(args: string[]): EvaluationCommand<AgentEvalArgs> {
    const values = meaningfulArguments(args);
    if (values.length === 0 || isHelpRequest(values, agentUsage)) return { action: 'help' };
    return { action: 'run', args: parseWithUsage(values, parseAgentEvalArgs, agentUsage) };
}

export function parseAgentEvalArgs(args: string[]): AgentEvalArgs {
    const result: AgentEvalArgs = { profile: 'bm25-v1', variant: 'both' };
    let runAll = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--') continue;
        if (argument === '--profile') {
            result.profile = requireValue(args, ++index, '--profile');
            continue;
        }
        if (argument === '--variant') {
            result.variant = parseVariant(requireValue(args, ++index, '--variant'));
            continue;
        }
        if (argument === '--random-count') {
            result.randomCount = parsePositiveInteger(requireValue(args, ++index, '--random-count'), '--random-count');
            continue;
        }
        if (argument === '--seed') {
            const seed = requireValue(args, ++index, '--seed').trim();
            if (!seed) throw new Error('--seed must be non-empty');
            result.seed = seed;
            continue;
        }
        if (argument === '--question-ids') {
            result.questionIds = parseQuestionIds(requireValue(args, ++index, '--question-ids'));
            continue;
        }
        if (argument === '--all') {
            runAll = true;
            continue;
        }
        if (!argument?.startsWith('--') && !result.questionsFile) {
            result.questionsFile = argument;
            continue;
        }
        throw new Error(agentUsage());
    }
    const selectionCount = Number(runAll) + Number(result.questionIds !== undefined) + Number(result.randomCount !== undefined);
    if (selectionCount > 1) {
        throw new Error(`--all, --random-count, and --question-ids cannot be used together\n${agentUsage()}`);
    }
    if (result.seed !== undefined && result.randomCount === undefined) {
        throw new Error(`--seed requires --random-count\n${agentUsage()}`);
    }
    if (selectionCount === 0) {
        throw new Error(`choose --all, --random-count <n>, or --question-ids <id1,id2,...> before running agent evaluation\n${agentUsage()}`);
    }
    return result;
}

export function recallUsage(): string {
    return [
        'usage:',
        '  npm run eval:recall',
        '  npm run eval:recall -- -- --profile <profileId> --variant raw-only|raw-wiki|both --retriever vector|grep|both [--wiki-first true|false] [questionsFile]',
        '',
        'Default profile: bm25-v1. Run without arguments prints this help and does not run an evaluation.'
    ].join('\n');
}

export function agentUsage(): string {
    return [
        'usage:',
        '  npm run eval:agent',
        '  npm run eval:agent -- -- --profile <profileId> --variant raw-only|raw-wiki|both (--all | --random-count <n> [--seed <seed>] | --question-ids <id1,id2,...>) [questionsFile]',
        '',
        'Default profile: bm25-v1. Run without arguments prints this help and never calls an LLM. --all explicitly permits the full evaluation.'
    ].join('\n');
}

function requireValue(args: string[], index: number, option: string): string {
    const value = args[index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function parseVariant(value: string): RecallEvalArgs['variant'] {
    parseEvaluationMode(value);
    return value as RecallEvalArgs['variant'];
}

function parseRetriever(value: string): RecallEvalArgs['retriever'] {
    if (value === 'vector' || value === 'grep' || value === 'both') return value;
    throw new Error(`unsupported retriever "${value}"; expected vector, grep, or both`);
}

function parseBoolean(value: string, option: string): boolean {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${option} must be true or false`);
}

function parsePositiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
    return parsed;
}

function parseQuestionIds(value: string): string[] {
    const ids = value.split(',').map(item => item.trim()).filter(Boolean);
    if (!ids.length || new Set(ids).size !== ids.length) {
        throw new Error('--question-ids must be a non-empty CSV without duplicates');
    }
    return ids;
}

function meaningfulArguments(args: string[]): string[] {
    return args.filter(argument => argument !== '--');
}

function isHelpRequest(args: string[], usage: () => string): boolean {
    if (args.length === 1 && args[0] === '--help') return true;
    if (args.includes('--help')) throw new Error(usage());
    return false;
}

function parseWithUsage<T>(args: string[], parse: (args: string[]) => T, usage: () => string): T {
    try {
        return parse(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.includes('usage:') ? message : `${message}\n${usage()}`);
    }
}
