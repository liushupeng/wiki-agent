import { createHash } from 'node:crypto';
import {
    CANDIDATE_SIGNALS,
    candidateSignals,
    type CandidateSignal,
    type RunQualitySample
} from '../observability/runQuality.js';

export type BadCaseCandidate = {
    schemaVersion: 1;
    id: string;
    status: 'candidate' | 'promoted' | 'wontfix';
    question: string;
    originalAnswer?: string;
    failureTypes: CandidateSignal[];
    sourceTrace: {
        traceId: string;
        traceFile?: string;
        startedAt: string;
        harvestedAt: string;
    };
    observed: {
        terminationReason?: string;
        completed: boolean;
        durationMs: number;
        toolFailures: number;
        ragBudgetExhausted: boolean;
        evidenceState?: string;
        fallbackCount: number;
        emptyRetrievals: number;
        finalAnswerAction?: string;
    };
    runtime: {
        model?: string;
        buildId?: string;
        retrievalProfiles: string[];
        retrievalVariants: string[];
        indexIdentities: string[];
    };
    artifact?: {
        path: string;
        sha256?: string;
    };
    replayReady: boolean;
    notes?: string;
};

export type RunArtifactData = {
    traceId: string;
    instruction: string;
    answer: string;
};

export function createBadCaseCandidate(
    sample: RunQualitySample,
    artifact?: RunArtifactData,
    now = new Date()
): BadCaseCandidate | undefined {
    const failureTypes = candidateSignals(sample);
    if (failureTypes.length === 0) return undefined;
    const question = artifact?.instruction || sample.instructionPreview || '';
    if (!question) return undefined;
    const replayReady = Boolean(
        artifact?.instruction
        && artifact.answer
        && sample.model
        && sample.buildId
        && sample.retrievalProfiles.length
        && sample.retrievalVariants.length
        && sample.indexIdentities.length
    );
    return {
        schemaVersion: 1,
        id: stableCandidateId(sample.traceId, failureTypes),
        status: 'candidate',
        question,
        ...(artifact?.answer ? { originalAnswer: artifact.answer } : {}),
        failureTypes,
        sourceTrace: {
            traceId: sample.traceId,
            ...(sample.traceFile ? { traceFile: sample.traceFile } : {}),
            startedAt: sample.startedAt,
            harvestedAt: now.toISOString()
        },
        observed: {
            ...(sample.terminationReason ? { terminationReason: sample.terminationReason } : {}),
            completed: sample.completed,
            durationMs: sample.durationMs,
            toolFailures: sample.toolFailures,
            ragBudgetExhausted: sample.ragBudgetExhausted,
            ...(sample.evidence.state ? { evidenceState: sample.evidence.state } : {}),
            fallbackCount: sample.fallbackCount,
            emptyRetrievals: sample.emptyRetrievals,
            ...(sample.finalAnswerAction ? { finalAnswerAction: sample.finalAnswerAction } : {})
        },
        runtime: {
            ...(sample.model ? { model: sample.model } : {}),
            ...(sample.buildId ? { buildId: sample.buildId } : {}),
            retrievalProfiles: sample.retrievalProfiles,
            retrievalVariants: sample.retrievalVariants,
            indexIdentities: sample.indexIdentities
        },
        ...(sample.runArtifact ? {
            artifact: {
                path: sample.runArtifact.path,
                ...(sample.runArtifact.sha256 ? { sha256: sample.runArtifact.sha256 } : {})
            }
        } : {}),
        replayReady
    };
}

export function validateBadCaseCandidate(value: unknown): BadCaseCandidate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('bad case candidate must be an object');
    }
    const candidate = value as Partial<BadCaseCandidate>;
    if (candidate.schemaVersion !== 1) throw new Error('bad case candidate schemaVersion must be 1');
    if (!candidate.id?.trim()) throw new Error('bad case candidate id must be non-empty');
    if (!candidate.question?.trim()) throw new Error('bad case candidate question must be non-empty');
    if (!['candidate', 'promoted', 'wontfix'].includes(candidate.status ?? '')) {
        throw new Error('bad case candidate status is invalid');
    }
    if (!candidate.sourceTrace?.traceId?.trim()) {
        throw new Error('bad case candidate sourceTrace.traceId must be non-empty');
    }
    if (!Array.isArray(candidate.failureTypes) || candidate.failureTypes.length === 0) {
        throw new Error('bad case candidate failureTypes must be non-empty');
    }
    const unknownFailureTypes = candidate.failureTypes.filter(
        value => !CANDIDATE_SIGNALS.includes(value as CandidateSignal)
    );
    if (unknownFailureTypes.length) {
        throw new Error(`bad case candidate failureTypes are invalid: ${unknownFailureTypes.join(', ')}`);
    }
    return candidate as BadCaseCandidate;
}

function stableCandidateId(traceId: string, signals: CandidateSignal[]): string {
    return `trace-${createHash('sha256')
        .update(JSON.stringify([traceId, [...signals].sort()]))
        .digest('hex')
        .slice(0, 16)}`;
}
