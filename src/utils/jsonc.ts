import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';

export function parseJsonc(content: string, label: string): unknown {
    const errors: ParseError[] = [];
    const value = parse(content, errors, {
        allowTrailingComma: true,
        disallowComments: false
    });

    if (errors.length > 0) {
        const details = errors
            .map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
            .join(', ');
        throw new Error(`invalid ${label}: ${details}`);
    }

    return value;
}
