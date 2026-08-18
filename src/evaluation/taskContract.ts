export type ContractStrictness = 'soft' | 'hard';
export type RequiredEvidenceSufficiency = 'partial' | 'sufficient';

export type TaskContract = {
    schemaVersion: 1;
    strictness?: ContractStrictness;
    answer?: {
        minTermCoverage?: number;
    };
    evidence?: {
        expectedSources?: string[];
        requireSourceHit?: boolean;
        requireReadNote?: boolean;
        minDistinctSources?: number;
        minimumSufficiency?: RequiredEvidenceSufficiency;
    };
    tools?: {
        mustUseAny?: string[];
        mustUseAll?: string[];
        forbid?: string[];
        maxCalls?: number;
        maxRagCalls?: number;
        requireLoadGroupBefore?: Array<{ group: string; tools: string[] }>;
    };
    trajectory?: {
        maxSteps?: number;
        maxToolFailures?: number;
        allowedTerminationReasons?: string[];
        forbidRetryLimitReached?: boolean;
        forbidRepeatedFailures?: boolean;
    };
    safety?: {
        forbidPermissionDeny?: boolean;
        forbidApprovalDenied?: boolean;
    };
};

export function validateTaskContract(value: unknown, label = 'task contract'): TaskContract {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const contract = value as TaskContract;
    if (contract.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
    if (contract.strictness !== undefined && !['soft', 'hard'].includes(contract.strictness)) {
        throw new Error(`${label}.strictness must be soft or hard`);
    }
    validateUnitInterval(contract.answer?.minTermCoverage, `${label}.answer.minTermCoverage`);
    validateStringArray(contract.evidence?.expectedSources, `${label}.evidence.expectedSources`);
    validatePositiveInteger(contract.evidence?.minDistinctSources, `${label}.evidence.minDistinctSources`);
    if (contract.evidence?.minimumSufficiency !== undefined
        && !['partial', 'sufficient'].includes(contract.evidence.minimumSufficiency)) {
        throw new Error(`${label}.evidence.minimumSufficiency must be partial or sufficient`);
    }
    validateStringArray(contract.tools?.mustUseAny, `${label}.tools.mustUseAny`);
    validateStringArray(contract.tools?.mustUseAll, `${label}.tools.mustUseAll`);
    validateStringArray(contract.tools?.forbid, `${label}.tools.forbid`);
    validatePositiveInteger(contract.tools?.maxCalls, `${label}.tools.maxCalls`);
    validatePositiveInteger(contract.tools?.maxRagCalls, `${label}.tools.maxRagCalls`);
    validatePositiveInteger(contract.trajectory?.maxSteps, `${label}.trajectory.maxSteps`);
    validateNonNegativeInteger(contract.trajectory?.maxToolFailures, `${label}.trajectory.maxToolFailures`);
    validateStringArray(contract.trajectory?.allowedTerminationReasons, `${label}.trajectory.allowedTerminationReasons`);
    for (const [index, rule] of (contract.tools?.requireLoadGroupBefore ?? []).entries()) {
        if (!rule?.group?.trim()) throw new Error(`${label}.tools.requireLoadGroupBefore[${index}].group must be non-empty`);
        validateStringArray(rule.tools, `${label}.tools.requireLoadGroupBefore[${index}].tools`, true);
    }
    return contract;
}

function validateUnitInterval(value: number | undefined, label: string): void {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error(`${label} must be between 0 and 1`);
    }
}

function validatePositiveInteger(value: number | undefined, label: string): void {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new Error(`${label} must be a positive integer`);
    }
}

function validateNonNegativeInteger(value: number | undefined, label: string): void {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(`${label} must be a non-negative integer`);
    }
}

function validateStringArray(value: string[] | undefined, label: string, requireNonEmpty = false): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error(`${label} must contain only non-empty strings`);
    }
    if (requireNonEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
}
