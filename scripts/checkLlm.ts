import dns from 'node:dns/promises';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_TIMEOUT_MS = 20_000;

type ProbeConfig = {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
};

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
        return new URL('models', `${baseUrl.replace(/\/+$/, '')}/`);
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

main().catch(error => {
    console.error(`LLM connectivity check failed: ${error.message}`);
    process.exit(1);
});
