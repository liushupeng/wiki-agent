import assert from 'node:assert/strict';
import test from 'node:test';
import { WIKI_AGENT_SYSTEM_PROMPT } from '../prompts/systemPrompt.js';

const POLICY_CONTRACTS = [
    {
        name: '概念与经验问题使用语义检索',
        userRequest: '总结我关于投资体系的核心观点',
        requiredRules: ['优先调用 search_notes 做语义检索']
    },
    {
        name: '精确术语与错误文本使用关键词检索',
        userRequest: '搜索知识库中包含 ERROR_CONNECTION_REFUSED 的内容',
        requiredRules: ['优先调用 grep_notes 做关键词/正则检索', 'maxResults<=10']
    },
    {
        name: '已知大笔记必须局部读取',
        userRequest: '读取指定笔记中的投资体系章节',
        requiredRules: ['read_note 必须优先带 query、titlePath 或较小 maxChunks', '不要把整篇大文件读入上下文']
    },
    {
        name: '关联笔记默认限制在同目录',
        userRequest: '查找这篇笔记的延伸阅读',
        requiredRules: ['调用 related_notes', '默认保持同目录范围']
    },
    {
        name: '代码修改先观察再加载高风险能力',
        userRequest: '修改代码并运行测试',
        requiredRules: ['先加载 git 分组观察变更', '再加载 coding 分组使用 apply_patch', 'Shell、测试命令和写文件属于高风险能力']
    }
] as const;

for (const contract of POLICY_CONTRACTS) {
    test(`Agent policy contract: ${contract.name}`, () => {
        for (const rule of contract.requiredRules) {
            assert.match(
                WIKI_AGENT_SYSTEM_PROMPT,
                new RegExp(escapeRegExp(rule)),
                `用户请求“${contract.userRequest}”缺少行为规则：${rule}`
            );
        }
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
