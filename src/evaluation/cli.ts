import { parseEvaluationMode } from './experiments.js';

export type RecallEvalArgs = {
    questionsFile?: string;
    variant: 'raw-only' | 'raw-wiki' | 'both';
    retriever: 'vector' | 'grep' | 'both';
};

export type AgentEvalArgs = {
    questionsFile?: string;
    variant: 'raw-only' | 'raw-wiki' | 'both';
    randomCount?: number;
    seed?: string;
    questionIds?: string[];
};

export function parseRecallEvalArgs(args: string[]): RecallEvalArgs {
    const result: RecallEvalArgs = { variant: 'both', retriever: 'vector' };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--') continue;
        if (argument === '--variant') {
            result.variant = parseVariant(requireValue(args, ++index, '--variant'));
            continue;
        }
        if (argument === '--retriever') {
            result.retriever = parseRetriever(requireValue(args, ++index, '--retriever'));
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

export function parseAgentEvalArgs(args: string[]): AgentEvalArgs {
    const result: AgentEvalArgs = { variant: 'both' };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--') continue;
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
        if (!argument?.startsWith('--') && !result.questionsFile) {
            result.questionsFile = argument;
            continue;
        }
        throw new Error(agentUsage());
    }
    if (result.questionIds && result.randomCount !== undefined) {
        throw new Error('--random-count and --question-ids cannot be used together');
    }
    if (result.seed !== undefined && result.randomCount === undefined) {
        throw new Error('--seed requires --random-count');
    }
    return result;
}

export function recallUsage(): string {
    return 'usage: npm run eval:recall -- -- [questionsFile] --variant raw-only|raw-wiki|both --retriever vector|grep|both';
}

export function agentUsage(): string {
    return 'usage: npm run eval:agent -- -- [questionsFile] --variant raw-only|raw-wiki|both [--random-count <n> --seed <seed> | --question-ids <id1,id2,...>]';
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
