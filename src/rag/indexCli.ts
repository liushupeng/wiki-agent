export type IndexKnowledgeArgs = {
    profileId: string;
    variantId?: string;
};

export type IndexKnowledgeCommand =
    | { action: 'help' }
    | { action: 'run'; args: IndexKnowledgeArgs };

export function parseIndexKnowledgeCommand(args: string[]): IndexKnowledgeCommand {
    const values = meaningfulArguments(args);
    if (values.length === 0 || isHelpRequest(values)) return { action: 'help' };

    const result: Partial<IndexKnowledgeArgs> = {};
    try {
        for (let index = 0; index < values.length; index += 1) {
            const option = values[index];
            if (option === '--profile') {
                result.profileId = requireValue(values, ++index, '--profile');
                continue;
            }
            if (option === '--variant') {
                result.variantId = requireValue(values, ++index, '--variant');
                continue;
            }
            throw new Error(indexKnowledgeUsage());
        }
        if (!result.profileId) {
            throw new Error(`--profile is required to build an index\n${indexKnowledgeUsage()}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.includes('usage:') ? message : `${message}\n${indexKnowledgeUsage()}`);
    }
    return { action: 'run', args: { profileId: result.profileId, ...(result.variantId ? { variantId: result.variantId } : {}) } };
}

export function indexKnowledgeUsage(): string {
    return [
        'usage:',
        '  npm run index:knowledge',
        '  npm run index:knowledge -- -- --profile <profileId> [--variant <variantId>]',
        '',
        'Run without arguments prints this help and does not build an index.'
    ].join('\n');
}

function meaningfulArguments(args: string[]): string[] {
    return args.filter(argument => argument !== '--');
}

function isHelpRequest(args: string[]): boolean {
    if (args.length === 1 && args[0] === '--help') return true;
    if (args.includes('--help')) throw new Error(indexKnowledgeUsage());
    return false;
}

function requireValue(args: string[], index: number, option: string): string {
    const value = args[index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value\n${indexKnowledgeUsage()}`);
    return value;
}
