import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import '../../src/env.js';
import { parseJsonlV2 } from '../../src/evaluation/trajectoryModel.js';
import {
    buildRunQualitySample,
    CANDIDATE_SIGNALS,
    candidateSignals,
    type CandidateSignal,
    type RunQualitySample
} from '../../src/observability/runQuality.js';
import {
    createBadCaseCandidate,
    type BadCaseCandidate,
    type RunArtifactData
} from '../../src/evaluation/badCaseCandidate.js';

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const cutoff = Date.now() - options.sinceHours * 60 * 60 * 1000;
    const files = await listJsonlFiles(options.directory);
    const samples = (await Promise.all(files.map(readRun)))
        .filter((sample): sample is RunQualitySample => Boolean(sample))
        .filter(sample => Date.parse(sample.startedAt) >= cutoff)
        .filter(sample => !options.traceId || sample.traceId === options.traceId)
        .filter(sample => {
            const signals = candidateSignals(sample);
            return options.signals.length === 0 || signals.some(signal => options.signals.includes(signal));
        });
    const candidates = new Map<string, BadCaseCandidate>();
    for (const sample of samples) {
        const artifact = await readRunArtifact(sample);
        const candidate = createBadCaseCandidate(sample, artifact);
        if (candidate) candidates.set(candidate.id, candidate);
    }
    const outputPath = options.outputPath ?? path.resolve(
        'var/evals/candidates',
        new Date().toISOString().replace(/[:.]/g, '-'),
        'candidates.jsonl'
    );
    await writeJsonlAtomic(outputPath, [...candidates.values()]);
    console.log(JSON.stringify({
        scannedTraces: files.length,
        matchedRuns: samples.length,
        candidates: candidates.size,
        replayReady: [...candidates.values()].filter(candidate => candidate.replayReady).length,
        outputPath
    }, null, 2));
}

async function readRun(file: string): Promise<RunQualitySample | undefined> {
    try {
        const records = parseJsonlV2(await fs.readFile(file, 'utf-8'));
        return buildRunQualitySample(records, file);
    } catch {
        return undefined;
    }
}

async function readRunArtifact(sample: RunQualitySample): Promise<RunArtifactData | undefined> {
    if (!sample.runArtifact?.path) return undefined;
    const workspace = path.resolve('.');
    const artifactPath = path.resolve(sample.runArtifact.path);
    if (artifactPath !== workspace && !artifactPath.startsWith(`${workspace}${path.sep}`)) return undefined;
    try {
        const content = await fs.readFile(artifactPath, 'utf-8');
        if (sample.runArtifact.sha256) {
            const actual = createHash('sha256').update(content).digest('hex');
            if (actual !== sample.runArtifact.sha256) return undefined;
        }
        const value = JSON.parse(content) as {
            traceId?: unknown;
            request?: { instruction?: unknown };
            response?: { answer?: unknown };
        };
        if (
            value.traceId !== sample.traceId
            || typeof value.request?.instruction !== 'string'
            || typeof value.response?.answer !== 'string'
        ) {
            return undefined;
        }
        return {
            traceId: sample.traceId,
            instruction: value.request.instruction,
            answer: value.response.answer
        };
    } catch {
        return undefined;
    }
}

async function listJsonlFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map(entry => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory()
            ? listJsonlFiles(fullPath)
            : Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [fullPath] : []);
    }));
    return nested.flat();
}

async function writeJsonlAtomic(filePath: string, candidates: BadCaseCandidate[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    const content = candidates.map(candidate => JSON.stringify(candidate)).join('\n');
    try {
        await fs.writeFile(temporaryPath, content ? `${content}\n` : '', { encoding: 'utf-8', flag: 'wx' });
        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function parseArgs(args: string[]): {
    directory: string;
    sinceHours: number;
    signals: CandidateSignal[];
    traceId?: string;
    outputPath?: string;
} {
    let directory = path.resolve(process.env.TRACE_DIR ?? 'var/traces');
    let sinceHours = 24;
    let signals: CandidateSignal[] = [];
    let traceId: string | undefined;
    let outputPath: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--') continue;
        if (argument === '--dir') directory = path.resolve(requireValue(args, ++index, argument));
        else if (argument === '--since-hours') sinceHours = Number(requireValue(args, ++index, argument));
        else if (argument === '--signals') {
            const requested = requireValue(args, ++index, argument)
                .split(',')
                .map(value => value.trim())
                .filter(Boolean);
            const unknown = requested.filter(value => !CANDIDATE_SIGNALS.includes(value as CandidateSignal));
            if (unknown.length) throw new Error(`unknown candidate signals: ${unknown.join(', ')}`);
            signals = requested as CandidateSignal[];
        } else if (argument === '--trace-id') traceId = requireValue(args, ++index, argument);
        else if (argument === '--output') outputPath = path.resolve(requireValue(args, ++index, argument));
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new Error('--since-hours must be positive');
    return {
        directory,
        sinceHours,
        signals,
        ...(traceId ? { traceId } : {}),
        ...(outputPath ? { outputPath } : {})
    };
}

function requireValue(args: string[], index: number, argument: string): string {
    const value = args[index];
    if (!value) throw new Error(`${argument} requires a value`);
    return value;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
