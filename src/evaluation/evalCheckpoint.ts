import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentEvalResult } from './agent.js';

export type EvalRunManifest = {
    schemaVersion: 1;
    questionsFile: string;
    questionSetSha256: string;
    selectedQuestionIds: string[];
    modes: string[];
    retrievalProfile: string;
    model: string;
    maxSteps: number;
    maxOutputTokens: number;
    gitCommit?: string;
    createdAt: string;
};

export type EvalQuestionCheckpoint = {
    schemaVersion: 1;
    mode: string;
    questionId: string;
    traceId?: string;
    traceFile: string;
    completedAt: string;
    result: AgentEvalResult;
};

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function loadEvalQuestionCheckpoint(
    filePath: string,
    expectedMode: string,
    expectedQuestionId: string
): Promise<EvalQuestionCheckpoint | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf-8');
    } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
    const value = JSON.parse(raw) as Partial<EvalQuestionCheckpoint>;
    if (value.schemaVersion !== 1 || value.mode !== expectedMode || value.questionId !== expectedQuestionId
        || !value.result || typeof value.traceFile !== 'string') {
        throw new Error(`invalid or mismatched evaluation checkpoint: ${filePath}`);
    }
    return value as EvalQuestionCheckpoint;
}

export async function validateEvalResumeManifest(
    outputDirectory: string,
    current: EvalRunManifest
): Promise<EvalRunManifest> {
    const manifestPath = path.join(outputDirectory, 'run-manifest.json');
    const persisted = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as EvalRunManifest;
    if (persisted.schemaVersion !== 1) throw new Error(`unsupported run manifest: ${manifestPath}`);
    const identity = (manifest: EvalRunManifest) => ({
        questionsFile: path.resolve(manifest.questionsFile),
        questionSetSha256: manifest.questionSetSha256,
        selectedQuestionIds: manifest.selectedQuestionIds,
        modes: manifest.modes,
        retrievalProfile: manifest.retrievalProfile,
        model: manifest.model,
        maxSteps: manifest.maxSteps,
        maxOutputTokens: manifest.maxOutputTokens,
        gitCommit: manifest.gitCommit
    });
    if (JSON.stringify(identity(persisted)) !== JSON.stringify(identity(current))) {
        throw new Error('resume configuration does not match run-manifest.json; start a new evaluation instead of mixing results');
    }
    return persisted;
}
