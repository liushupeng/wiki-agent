import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

let loaded = false;

/**
 * 按“进程环境变量 > .env > .env.example”的优先级加载配置。
 *
 * `.env.example` 是可提交的非敏感默认配置层；`.env` 只保存本机密钥和覆盖项。
 * 进程启动时已存在的环境变量始终优先，方便 CI、容器和命令行临时覆盖。
 */
export function loadEnvironment(cwd = process.cwd()): void {
    if (loaded) return;
    const inheritedKeys = new Set(Object.keys(process.env));
    const defaults = readEnvFile(path.join(cwd, '.env.example'));
    const local = readEnvFile(path.join(cwd, '.env'));

    for (const [key, value] of Object.entries(defaults)) {
        if (!inheritedKeys.has(key)) process.env[key] = value;
    }
    for (const [key, value] of Object.entries(local)) {
        if (!inheritedKeys.has(key)) process.env[key] = value;
    }

    loaded = true;
}

function readEnvFile(filePath: string): Record<string, string> {
    try {
        return dotenv.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error: any) {
        if (error?.code === 'ENOENT') return {};
        throw new Error(`cannot read environment file "${filePath}": ${error.message}`);
    }
}

loadEnvironment();
