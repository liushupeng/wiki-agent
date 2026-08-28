import { TaskContract, validateTaskContract } from './taskContract.js';
import {
    JsonlV2Record,
    TrajectoryView,
    buildTrajectoryView,
    isRagToolName,
    toolNameMatches
} from './trajectoryModel.js';

export type VerificationVerdict = 'pass' | 'fail' | 'skipped';
export type VerificationLayer = 'result' | 'process' | 'safety';

export type VerificationCheck = {
    dimension: string;
    layer: VerificationLayer;
    verdict: VerificationVerdict;
    message: string;
    evidence?: Record<string, unknown>;
};

export type VerificationReport = {
    contractSchemaVersion: 1;
    strictness: 'soft' | 'hard';
    passed: boolean;
    checks: VerificationCheck[];
    summary: {
        failedDimensions: string[];
        toolNames: string[];
        stepCount: number;
        terminationReason?: string;
        evidenceSources: string[];
        finalAnswerAction?: string;
        retrievalProfiles: string[];
        retrievalVariants: string[];
        indexIdentities: string[];
        model?: string;
        buildId?: string;
    };
};

export type QualityJudgment = {
    passed: boolean;
    reasons: string[];
};

/**
 * Optional paid/subjective evaluation seam. The deterministic verifier never
 * constructs or invokes an implementation of this interface.
 */
export interface QualityJudge {
    judge(input: {
        question: VerifiableQuestion;
        answer: string;
        trajectory: TrajectoryView;
    }): Promise<QualityJudgment>;
}

export type VerifiableQuestion = {
    expectedSource?: string;
    expectedSources?: string[];
    expectedTerms?: string[];
};

export function verifyTrajectory(input: {
    contract: TaskContract;
    question: VerifiableQuestion;
    answer: string;
    records: JsonlV2Record[];
}): VerificationReport {
    const contract = validateTaskContract(input.contract);
    const trajectory = buildTrajectoryView(input.records);
    const checks: VerificationCheck[] = [];
    verifyAnswer(checks, contract, input.question, input.answer);
    verifyEvidence(checks, contract, input.question, trajectory);
    verifyTools(checks, contract, trajectory);
    verifyTrajectoryRules(checks, contract, trajectory);
    verifySafety(checks, contract, trajectory);
    const failedDimensions = checks.filter(check => check.verdict === 'fail').map(check => check.dimension);
    return {
        contractSchemaVersion: 1,
        strictness: contract.strictness ?? 'soft',
        passed: failedDimensions.length === 0,
        checks,
        summary: {
            failedDimensions,
            toolNames: trajectory.toolCalls.map(call => call.name),
            stepCount: trajectory.stepCount,
            ...(trajectory.terminationReason ? { terminationReason: trajectory.terminationReason } : {}),
            evidenceSources: trajectory.evidenceSources,
            ...(trajectory.finalAnswerAction ? { finalAnswerAction: trajectory.finalAnswerAction } : {}),
            retrievalProfiles: trajectory.retrievalProfiles,
            retrievalVariants: trajectory.retrievalVariants,
            indexIdentities: trajectory.indexIdentities,
            ...(trajectory.model ? { model: trajectory.model } : {}),
            ...(trajectory.buildId ? { buildId: trajectory.buildId } : {})
        }
    };
}

function verifyAnswer(
    checks: VerificationCheck[],
    contract: TaskContract,
    question: VerifiableQuestion,
    answer: string
): void {
    if (!contract.answer) return;
    const normalized = answer.toLowerCase();
    if (contract.answer.minTermCoverage !== undefined) {
        const terms = question.expectedTerms ?? [];
        const coverage = terms.length
            ? terms.filter(term => normalized.includes(term.toLowerCase())).length / terms.length
            : 1;
        checks.push(check(
            'answer.term_coverage',
            'result',
            coverage >= contract.answer.minTermCoverage,
            `term coverage ${coverage.toFixed(4)}; required ${contract.answer.minTermCoverage.toFixed(4)}`,
            { coverage, expectedTerms: terms }
        ));
    }
    if (contract.answer.requiredPhrasesAny?.length) {
        const matched = contract.answer.requiredPhrasesAny.filter(phrase => normalized.includes(phrase.toLowerCase()));
        checks.push(check(
            'answer.required_phrase',
            'result',
            matched.length > 0,
            matched.length ? `matched required phrase: ${matched[0]}` : 'no required phrase was found',
            { requiredAny: contract.answer.requiredPhrasesAny, matched }
        ));
    }
    if (contract.answer.forbiddenPhrases?.length) {
        const matched = contract.answer.forbiddenPhrases.filter(phrase => normalized.includes(phrase.toLowerCase()));
        checks.push(check(
            'answer.forbidden_phrase',
            'result',
            matched.length === 0,
            matched.length ? `forbidden phrases found: ${matched.join(', ')}` : 'no forbidden phrase was found',
            { forbidden: contract.answer.forbiddenPhrases, matched }
        ));
    }
}

function verifyEvidence(
    checks: VerificationCheck[],
    contract: TaskContract,
    question: VerifiableQuestion,
    trajectory: TrajectoryView
): void {
    const rule = contract.evidence;
    if (!rule) return;
    const expectedSources = rule.expectedSources
        ?? question.expectedSources
        ?? (question.expectedSource ? [question.expectedSource] : []);
    if (rule.requireSourceHit ?? expectedSources.length > 0) {
        const matched = trajectory.evidenceSources.filter(source =>
            expectedSources.some(expected => source.toLowerCase().includes(expected.toLowerCase()))
        );
        checks.push(check(
            'evidence.source_hit',
            'result',
            expectedSources.length === 0 || matched.length > 0,
            matched.length ? `matched ${matched.length} expected source(s)` : 'no expected source was observed',
            { expectedSources, matched, observed: trajectory.evidenceSources }
        ));
    }
    if (rule.requireAllExpectedSources && expectedSources.length > 0) {
        const missing = expectedSources.filter(expected => !trajectory.evidenceSources.some(source =>
            source.toLowerCase().includes(expected.toLowerCase())
        ));
        checks.push(check(
            'evidence.all_sources',
            'result',
            missing.length === 0,
            missing.length ? `missing expected sources: ${missing.join(', ')}` : 'all expected sources were observed',
            { expectedSources, missing, observed: trajectory.evidenceSources }
        ));
    }
    if (rule.requireReadNote) {
        checks.push(check(
            'evidence.read_note',
            'process',
            trajectory.readNotePaths.length > 0,
            trajectory.readNotePaths.length ? 'read_note evidence observed' : 'read_note evidence required',
            { paths: trajectory.readNotePaths }
        ));
    }
    if (rule.minDistinctSources !== undefined) {
        checks.push(check(
            'evidence.distinct_sources',
            'result',
            trajectory.evidenceSources.length >= rule.minDistinctSources,
            `observed ${trajectory.evidenceSources.length}; required ${rule.minDistinctSources}`,
            { sources: trajectory.evidenceSources }
        ));
    }
    if (rule.minimumSufficiency) {
        const observed = trajectory.evidenceSufficiency ?? (trajectory.evidenceSources.length === 0
            ? 'insufficient'
            : trajectory.readNotePaths.length > 0 || trajectory.evidenceSources.length >= 2
                ? 'sufficient'
                : 'partial');
        const levels = { insufficient: 0, partial: 1, sufficient: 2 } as const;
        checks.push(check(
            'evidence.sufficiency',
            'result',
            levels[observed] >= levels[rule.minimumSufficiency],
            `evidence is ${observed}; required ${rule.minimumSufficiency}`,
            { observed }
        ));
    }
}

function verifyTools(checks: VerificationCheck[], contract: TaskContract, trajectory: TrajectoryView): void {
    const rule = contract.tools;
    if (!rule) return;
    const names = trajectory.toolCalls.map(call => call.name);
    const used = (expected: string) => names.some(actual => toolNameMatches(actual, expected));
    if (rule.mustUseAny?.length) {
        checks.push(check(
            'tools.must_use_any',
            'process',
            rule.mustUseAny.some(used),
            `must use at least one of: ${rule.mustUseAny.join(', ')}`,
            { observed: names }
        ));
    }
    if (rule.mustUseAll?.length) {
        const missing = rule.mustUseAll.filter(expected => !used(expected));
        checks.push(check(
            'tools.must_use_all',
            'process',
            missing.length === 0,
            missing.length ? `missing tools: ${missing.join(', ')}` : 'all required tools were used',
            { observed: names }
        ));
    }
    if (rule.forbid?.length) {
        const forbidden = names.filter(actual => rule.forbid!.some(expected => toolNameMatches(actual, expected)));
        checks.push(check(
            'tools.forbid',
            'safety',
            forbidden.length === 0,
            forbidden.length ? `forbidden tools used: ${forbidden.join(', ')}` : 'no forbidden tool was used',
            { observed: names }
        ));
    }
    if (rule.maxCalls !== undefined) {
        checks.push(check('tools.max_calls', 'process', names.length <= rule.maxCalls, `observed ${names.length}; maximum ${rule.maxCalls}`));
    }
    if (rule.maxRagCalls !== undefined) {
        const ragCalls = names.filter(isRagToolName);
        checks.push(check(
            'tools.max_rag_calls',
            'process',
            ragCalls.length <= rule.maxRagCalls,
            `observed ${ragCalls.length}; maximum ${rule.maxRagCalls}`,
            { observed: ragCalls }
        ));
    }
    for (const groupRule of rule.requireLoadGroupBefore ?? []) {
        const firstProtectedIndex = trajectory.toolCalls.findIndex(call =>
            groupRule.tools.some(expected => toolNameMatches(call.name, expected))
        );
        if (firstProtectedIndex < 0) continue;
        const loaded = trajectory.toolCalls.slice(0, firstProtectedIndex).some(call =>
            toolNameMatches(call.name, 'load_tool_group') && readGroup(call.argumentsPreview) === groupRule.group
        );
        checks.push(check(
            `tools.group_before.${groupRule.group}`,
            'safety',
            loaded,
            loaded ? `group ${groupRule.group} loaded before protected tool` : `group ${groupRule.group} was not loaded first`
        ));
    }
}

function verifyTrajectoryRules(checks: VerificationCheck[], contract: TaskContract, trajectory: TrajectoryView): void {
    const rule = contract.trajectory;
    if (!rule) return;
    if (rule.maxSteps !== undefined) {
        checks.push(check(
            'trajectory.max_steps',
            'process',
            trajectory.stepCount <= rule.maxSteps,
            `observed ${trajectory.stepCount}; maximum ${rule.maxSteps}`
        ));
    }
    if (rule.maxToolFailures !== undefined) {
        const failures = trajectory.toolCalls.filter(call => call.status && call.status !== 'success');
        checks.push(check(
            'trajectory.tool_failures',
            'process',
            failures.length <= rule.maxToolFailures,
            `observed ${failures.length} tool failure(s); maximum ${rule.maxToolFailures}`,
            { tools: failures.map(call => ({ name: call.name, status: call.status })) }
        ));
    }
    if (rule.allowedTerminationReasons?.length) {
        checks.push(check(
            'trajectory.termination',
            'result',
            Boolean(trajectory.terminationReason && rule.allowedTerminationReasons.includes(trajectory.terminationReason)),
            `termination reason: ${trajectory.terminationReason ?? 'missing'}`,
            { allowed: rule.allowedTerminationReasons }
        ));
    }
    if (rule.forbidRetryLimitReached) {
        checks.push(check(
            'trajectory.retry_limit',
            'process',
            !trajectory.retryLimitReached,
            trajectory.retryLimitReached ? 'retry limit was reached' : 'retry limit was not reached'
        ));
    }
    if (rule.forbidRepeatedFailures) {
        const counts = new Map<string, number>();
        for (const call of trajectory.toolCalls) {
            if (!call.status || call.status === 'success') continue;
            const key = `${call.name}:${call.argumentsSha256 ?? call.argumentsPreview ?? call.callId ?? call.spanId}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const repeated = [...counts.entries()].filter(([, count]) => count > 1);
        checks.push(check(
            'trajectory.repeated_failures',
            'process',
            repeated.length === 0,
            repeated.length ? 'identical failing tool calls were repeated' : 'no repeated identical failure observed',
            { repeated }
        ));
    }
}

function verifySafety(checks: VerificationCheck[], contract: TaskContract, trajectory: TrajectoryView): void {
    if (contract.safety?.forbidPermissionDeny) {
        const denied = trajectory.toolCalls.filter(call =>
            call.permissionAction === 'deny' || call.status === 'security_error'
        );
        checks.push(check(
            'safety.permission_deny',
            'safety',
            denied.length === 0,
            denied.length ? `${denied.length} tool call(s) denied by policy` : 'no policy denial observed',
            { tools: denied.map(call => call.name) }
        ));
    }
    if (contract.safety?.forbidApprovalDenied) {
        const denied = trajectory.toolCalls.filter(call => call.status === 'approval_denied');
        checks.push(check(
            'safety.approval_denied',
            'safety',
            denied.length === 0,
            denied.length ? `${denied.length} approval(s) denied` : 'no approval denial observed',
            { tools: denied.map(call => call.name) }
        ));
    }
}

function check(
    dimension: string,
    layer: VerificationLayer,
    passed: boolean,
    message: string,
    evidence?: Record<string, unknown>
): VerificationCheck {
    return { dimension, layer, verdict: passed ? 'pass' : 'fail', message, ...(evidence ? { evidence } : {}) };
}

function readGroup(preview: string | undefined): string | undefined {
    if (!preview || preview.endsWith('...')) return undefined;
    try {
        const value = JSON.parse(preview);
        return value && typeof value === 'object' && typeof value.group === 'string' ? value.group : undefined;
    } catch {
        return undefined;
    }
}
