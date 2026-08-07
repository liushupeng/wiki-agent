import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/env.js';
import { exportTrace } from '../../src/trace/export.js';
import type { TraceExportOptions } from '../../src/trace/export.js';

export { exportTrace, TraceExportOptions };

function usage(): string {
    return [
        'usage:',
        '  npm run trace:import',
        '  npm run trace:import -- -- --input <trace.jsonl> [--endpoint <OTLP HTTP traces URL>] [--service-name <name>] [--dry-run]',
        '',
        'Default endpoint: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or http://127.0.0.1:4318/v1/traces. Use --dry-run to validate locally without network requests.'
    ].join('\n');
}

/**
 * 离线 Trace 导出入口。
 *
 * 将本地 schema version 2 JSONL trace 转换并发送到 OTLP 后端；
 * 端点优先级为 --endpoint、环境变量、默认本机 Jaeger。--dry-run 时仅校验和统计输入文件。
 */
type ImportTraceOptions = TraceExportOptions & { dryRun: boolean };

function parseArgs(args: string[]): ImportTraceOptions | undefined {
    if (args.length === 0 || args.includes('--help')) return undefined;

    let inputPath: string | undefined;
    let endpoint: string | undefined;
    let serviceName: string | undefined;
    let dryRun = false;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === '--input') inputPath = args[++index];
        else if (value === '--endpoint') endpoint = args[++index];
        else if (value === '--service-name') serviceName = args[++index];
        else if (value === '--dry-run') dryRun = true;
        else throw new Error(`unknown argument: ${value}`);
    }
    if (!inputPath) throw new Error(usage());
    if (dryRun && endpoint) throw new Error('--dry-run cannot be used with --endpoint');
    return { inputPath, endpoint, serviceName, dryRun };
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
        console.log(usage());
        return;
    }
    const endpoint = options.dryRun
        ? undefined
        : options.endpoint ?? (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || 'http://127.0.0.1:4318/v1/traces');
    const report = await exportTrace({ inputPath: options.inputPath, endpoint, serviceName: options.serviceName });
    const message = report.mode === 'exported'
        ? `已导入至 OTLP 后端：${endpoint}`
        : 'Dry run 完成：未发送任何网络请求。';
    console.log(`${message}\n根 Span=${report.rootSpanCount}，Span=${report.spanCount}，事件=${report.eventCount}，跳过=${report.skippedEventCount}，Trace ID=${report.traceIds.join(', ') || '无'}，文件=${report.inputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Trace 导出失败: ${error.message}`);
        process.exitCode = 1;
    });
}
