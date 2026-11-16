import dns from 'node:dns/promises';
import '../src/env.js';
import { normalizeOpenAiCompatibleBaseUrl } from '../src/harness/pi/openAiBaseUrl.js';

const DEFAULT_TIMEOUT_MS = 20_000;

type ProbeConfig = {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
};

/**
 * LLM API 连通性检查入口。
 *
 * 依次验证 DNS 解析、HTTPS 可达性和 Bearer API key 认证，调用轻量的 `/models`
 * 端点而不触发模型生成，因此不会消耗生成 token。
 */
async function main() {
    const config = resolveProbeConfig();
    const endpoint = buildModelsEndpoint(config.baseUrl);

    console.log('LLM connectivity check');
    console.log(`  Endpoint: ${endpoint.toString()}`);
    console.log(`  Timeout:  ${config.timeoutMs} ms`);

    try {
        const dnsResult = await dns.lookup(endpoint.hostname);
        console.log(`  DNS:      ${endpoint.hostname} -> ${dnsResult.address}`);
    } catch (error: any) {
        fail(`DNS lookup failed: ${error.message}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = performance.now();

    try {
        const response = await fetch(endpoint, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal: controller.signal
        });
        const elapsedMs = Math.round(performance.now() - startedAt);
        console.log(`  HTTP:     ${response.status} ${response.statusText} (${elapsedMs} ms)`);

        if (response.ok) {
            console.log('  Result:   reachable and authenticated');
            return;
        }

        if ([401, 403].includes(response.status)) {
            fail('API host is reachable, but the API key is invalid or lacks permission.');
        }

        fail('API host is reachable, but the configured endpoint or provider response is not successful.');
    } catch (error: any) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (error.name === 'AbortError') {
            fail(`HTTPS request timed out after ${elapsedMs} ms. Check the corporate network, proxy, or provider availability.`);
        }
        if (isTlsCertificateError(error)) {
            printTlsCertificateRemediation();
        }
        fail(`HTTPS request failed after ${elapsedMs} ms: ${describeNetworkError(error)}`);
    } finally {
        clearTimeout(timeout);
    }
}

function resolveProbeConfig(env = process.env): ProbeConfig {
    const baseUrl = env.BASE_URL?.trim();
    const apiKey = env.API_KEY?.trim();
    const timeoutMs = DEFAULT_TIMEOUT_MS;

    if (!baseUrl) {
        throw new Error('missing BASE_URL.');
    }
    if (!apiKey) {
        throw new Error('missing API_KEY.');
    }

    return { baseUrl, apiKey, timeoutMs };
}

function buildModelsEndpoint(baseUrl: string): URL {
    try {
        return new URL('models', `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/`);
    } catch {
        throw new Error(`invalid API base URL: ${baseUrl}`);
    }
}

function fail(message: string): never {
    throw new Error(message);
}

function describeNetworkError(error: any): string {
    const cause = error.cause;
    if (!cause) return error.message;
    const code = cause.code ? `${cause.code}: ` : '';
    return `${error.message} (${code}${cause.message ?? 'unknown network error'})`;
}

function isTlsCertificateError(error: unknown): boolean {
    const parts = [error, (error as { cause?: unknown })?.cause];
    const text = parts.map(value => {
        if (!value || typeof value !== 'object') return String(value ?? '');
        const record = value as { code?: string; message?: string };
        return `${record.code ?? ''} ${record.message ?? ''}`;
    }).join(' ');
    return /UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_|unable to verify the first certificate/i.test(text);
}

function printTlsCertificateRemediation(): void {
    console.error([
        '',
        'TLS 提示：Node 不信任当前 HTTPS 证书链（常见于 Zscaler 等公司 HTTPS 代理）。',
        '修复方式（任选其一）：',
        '  1. 持久：在 Windows 用户环境变量中设置 NODE_OPTIONS=--use-system-ca（需 Node 23+），然后重启终端。',
        '  2. 当前终端临时：PowerShell 执行 $env:NODE_OPTIONS=\'--use-system-ca\' 后再运行本命令。',
        '  3. 仅本地临时调试：$env:NODE_TLS_REJECT_UNAUTHORIZED=\'0\'（勿用于生产）。',
        ''
    ].join('\n'));
}

main().catch(error => {
    console.error(`LLM connectivity check failed: ${error.message}`);
    process.exit(1);
});
