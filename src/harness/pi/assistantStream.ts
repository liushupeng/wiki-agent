/** Pi message_update 提供累积全文；CLI 需要增量写入，避免 stdout 重复刷屏。 */
export function createAssistantStreamEmitter(onTextChunk: (text: string) => void) {
    let streamed = '';

    return {
        emit(fullText: string) {
            if (!fullText || fullText === streamed) return;
            if (fullText.startsWith(streamed)) {
                const delta = fullText.slice(streamed.length);
                if (delta) onTextChunk(delta);
            } else {
                onTextChunk(streamed ? `\n${fullText}` : fullText);
            }
            streamed = fullText;
        }
    };
}
