import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseReviewAnnotations, summarizeReviewAnnotations } from '../../src/evaluation/reviewSummary.js';

const USAGE = `Usage:
  npm run eval:review -- -- --review-dir <agent-eval-review-directory>

Reads a completed annotation-template.csv, writes review-summary.json, and never calls a model.`;

async function main(): Promise<void> {
    const args = meaningfulArguments(process.argv.slice(2));
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
        console.log(USAGE);
        return;
    }
    if (args.length !== 2 || args[0] !== '--review-dir' || !args[1]?.trim()) throw new Error(USAGE);
    const reviewDirectory = path.resolve(args[1]);
    const annotationPath = path.join(reviewDirectory, 'annotation-template.csv');
    const content = await fs.readFile(annotationPath, 'utf-8');
    const annotations = parseReviewAnnotations(content);
    if (annotations.length === 0) throw new Error('annotation-template.csv contains no completed review rows');
    const summary = summarizeReviewAnnotations(annotations);
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        annotationFile: annotationPath,
        annotationSha256: createHash('sha256').update(content).digest('hex'),
        ...summary,
        rerunQuestionIds: summary.failedQuestionIds.join(','),
        rerunCommand: summary.failedQuestionIds.length
            ? `npm run eval:agent -- -- --retrieval-profile hybrid-bge-m3-metadata-source-aggregate-v1 --variant raw-wiki --question-ids ${summary.failedQuestionIds.join(',')} evaluation/e2e/questions.json`
            : undefined
    };
    const outputPath = path.join(reviewDirectory, 'review-summary.json');
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(JSON.stringify(report, null, 2));
    console.log(`Review summary: ${outputPath}`);
}

function meaningfulArguments(args: string[]): string[] {
    return args.filter(argument => argument !== '--');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
