export const HARNESS_KINDS = ['native', 'pi'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export function isHarnessKind(value: string): value is HarnessKind {
    return (HARNESS_KINDS as readonly string[]).includes(value);
}

export function resolveHarnessFromEnv(env: NodeJS.ProcessEnv = process.env): HarnessKind {
    const raw = env.HARNESS?.trim().toLowerCase();
    return raw === 'pi' ? 'pi' : 'native';
}

export function parseHarnessFromArgv(argv: string[], env: NodeJS.ProcessEnv = process.env): {
    harness: HarnessKind;
    argv: string[];
} {
    const remaining: string[] = [];
    let harness: HarnessKind | undefined;

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument !== '--harness') {
            remaining.push(argument);
            continue;
        }
        const value = argv[++index]?.trim().toLowerCase();
        if (!value || !isHarnessKind(value)) {
            throw new Error('--harness requires native or pi');
        }
        harness = value;
    }

    return { harness: harness ?? resolveHarnessFromEnv(env), argv: remaining };
}
