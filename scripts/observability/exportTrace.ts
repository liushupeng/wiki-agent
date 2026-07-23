import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/env.js';
import { exportTrace, TraceExportOptions } from '../../src/trace/export.js';

export { exportTrace, TraceExportOptions };

function parseArgs(args: string[]): TraceExportOptions {
    let inputPath: string | undefined;
    let endpoint: string | undefined;
    let serviceName: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === '--input') inputPath = args[++index];
        else if (value === '--endpoint') endpoint = args[++index];
        else if (value === '--service-name') serviceName = args[++index];
        else throw new Error(`unknown argument: ${value}`);
    }
    if (!inputPath) throw new Error('usage: npm run trace:export -- --input <trace.jsonl> [--endpoint <OTLP HTTP traces URL>] [--service-name <name>]');
    return { inputPath, endpoint, serviceName };
}

async function main(): Promise<void> {
    const report = await exportTrace(parseArgs(process.argv.slice(2)));
    const message = report.mode === 'exported' ? `已导出 ${report.spanCount} 个 span 至 OTLP 后端。` : 'Dry run 完成：未发送任何网络请求。';
    console.log(`${message}\n运行=${report.runCount}，事件=${report.eventCount}，跳过=${report.skippedEventCount}，文件=${report.inputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Trace 导出失败: ${error.message}`);
        process.exitCode = 1;
    });
}
