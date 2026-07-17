import { isWikiSource } from './sourceRoots.js';
import { SearchResult } from './types.js';

/**
 * 将维护型 wiki 结果排在原始资料之前；同类结果仍按检索分数降序排列。
 */
export function prioritizeWikiMatches(matches: SearchResult[], topK: number): SearchResult[] {
    return [...matches]
        .sort((left, right) => {
            const priorityDelta = Number(isWikiSource(right.source)) - Number(isWikiSource(left.source));
            return priorityDelta === 0 ? right.score - left.score : priorityDelta;
        })
        .slice(0, topK);
}
