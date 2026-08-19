export type ReviewDimension = 'correctness' | 'completeness' | 'groundedness' | 'citationAccuracy' | 'abstention';
export type ReviewScore = '0' | '1' | 'na';

export type ReviewAnnotation = {
    reviewId: string;
    questionId: string;
    expectedBehavior: 'answer' | 'insufficient-evidence';
    correctness: ReviewScore;
    completeness: ReviewScore;
    groundedness: ReviewScore;
    citationAccuracy: ReviewScore;
    abstention: ReviewScore;
    overallPass: '0' | '1';
    failureTag?: string;
    notes?: string;
};

export type ReviewSummary = {
    total: number;
    passed: number;
    passRate: number;
    dimensions: Record<ReviewDimension, { rated: number; passed: number; passRate: number }>;
    byExpectedBehavior: Record<string, { total: number; passed: number; passRate: number }>;
    failureTags: Record<string, number>;
    failedQuestionIds: string[];
};

const DIMENSIONS: ReviewDimension[] = [
    'correctness',
    'completeness',
    'groundedness',
    'citationAccuracy',
    'abstention'
];

export function parseReviewAnnotations(csv: string): ReviewAnnotation[] {
    const rows = parseCsv(csv);
    if (rows.length === 0) throw new Error('annotation CSV must contain a header');
    const headers = rows[0]!;
    const requiredHeaders = [
        'reviewId',
        'questionId',
        'expectedBehavior',
        ...DIMENSIONS,
        'overallPass',
        'failureTag',
        'notes'
    ];
    const missingHeaders = requiredHeaders.filter(header => !headers.includes(header));
    if (missingHeaders.length) throw new Error(`annotation CSV is missing headers: ${missingHeaders.join(', ')}`);

    return rows.slice(1).filter(row => row.some(value => value.trim())).map((row, index) => {
        const value = Object.fromEntries(headers.map((header, column) => [header, row[column]?.trim() ?? '']));
        const line = index + 2;
        if (!value.reviewId || !value.questionId) throw new Error(`annotation line ${line} requires reviewId and questionId`);
        if (value.expectedBehavior !== 'answer' && value.expectedBehavior !== 'insufficient-evidence') {
            throw new Error(`annotation line ${line} has invalid expectedBehavior`);
        }
        for (const dimension of DIMENSIONS) {
            if (!['0', '1', 'na'].includes(value[dimension])) {
                throw new Error(`annotation line ${line} ${dimension} must be 0, 1, or na`);
            }
        }
        if (value.overallPass !== '0' && value.overallPass !== '1') {
            throw new Error(`annotation line ${line} overallPass must be 0 or 1`);
        }
        if (value.overallPass === '0' && !value.failureTag) {
            throw new Error(`annotation line ${line} requires failureTag when overallPass is 0`);
        }
        return value as ReviewAnnotation;
    });
}

export function summarizeReviewAnnotations(annotations: readonly ReviewAnnotation[]): ReviewSummary {
    const passed = annotations.filter(annotation => annotation.overallPass === '1').length;
    const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => {
        const rated = annotations.filter(annotation => annotation[dimension] !== 'na');
        const dimensionPassed = rated.filter(annotation => annotation[dimension] === '1').length;
        return [dimension, {
            rated: rated.length,
            passed: dimensionPassed,
            passRate: rate(dimensionPassed, rated.length)
        }];
    })) as ReviewSummary['dimensions'];
    const behaviorGroups = new Map<string, ReviewAnnotation[]>();
    const failureTags = new Map<string, number>();
    for (const annotation of annotations) {
        const group = behaviorGroups.get(annotation.expectedBehavior) ?? [];
        group.push(annotation);
        behaviorGroups.set(annotation.expectedBehavior, group);
        for (const tag of annotation.failureTag?.split(/[;,|]+/).map(value => value.trim()).filter(Boolean) ?? []) {
            failureTags.set(tag, (failureTags.get(tag) ?? 0) + 1);
        }
    }
    const byExpectedBehavior = Object.fromEntries([...behaviorGroups].map(([behavior, values]) => {
        const behaviorPassed = values.filter(value => value.overallPass === '1').length;
        return [behavior, { total: values.length, passed: behaviorPassed, passRate: rate(behaviorPassed, values.length) }];
    }));
    return {
        total: annotations.length,
        passed,
        passRate: rate(passed, annotations.length),
        dimensions,
        byExpectedBehavior,
        failureTags: Object.fromEntries([...failureTags].sort((left, right) => right[1] - left[1])),
        failedQuestionIds: [...new Set(annotations
            .filter(annotation => annotation.overallPass === '0')
            .map(annotation => annotation.questionId))]
    };
}

function rate(passed: number, total: number): number {
    return total ? Number((passed / total).toFixed(4)) : 0;
}

function parseCsv(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < content.length; index += 1) {
        const character = content[index]!;
        if (quoted) {
            if (character === '"' && content[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === ',') {
            row.push(field);
            field = '';
        } else if (character === '\n') {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += character;
        }
    }
    if (quoted) throw new Error('annotation CSV has an unterminated quoted field');
    if (field || row.length) {
        row.push(field.replace(/\r$/, ''));
        rows.push(row);
    }
    return rows;
}
