import { clearLine, cursorTo } from 'node:readline';

export type CliProgressReporter = {
    start(message: string): void;
    update(message: string, force?: boolean): void;
    stop(): void;
};

/**
 * 在交互终端覆盖同一行进度；在重定向输出或 CI 中定期写入普通日志，
 * 使长任务既不刷屏，也保留可审计的非交互输出。
 */
export function createCliProgressReporter(): CliProgressReporter {
    const interactive = Boolean(process.stdout.isTTY);
    const outputIntervalMs = interactive ? 250 : 5_000;
    let active = false;
    let lastOutputAt = 0;

    const writeInteractiveLine = (message: string) => {
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write(message);
    };

    const write = (message: string, force = false) => {
        if (!active) return;
        const now = performance.now();
        if (!force && now - lastOutputAt < outputIntervalMs) return;
        lastOutputAt = now;
        if (interactive) {
            writeInteractiveLine(message);
        } else {
            console.log(message);
        }
    };

    return {
        start(message) {
            active = true;
            write(message, true);
        },
        update(message, force = false) {
            write(message, force);
        },
        stop() {
            if (!active) return;
            if (interactive) {
                writeInteractiveLine('');
            }
            active = false;
        }
    };
}
