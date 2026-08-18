import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';
import type { MemoryProposal, MemoryProposalStatus } from './memoryProposal.js';
import { transitionMemoryProposal } from './memoryProposal.js';

type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type LongTermMemoryKind = 'preference' | 'constraint' | 'fact';

export type LongTermMemoryItem = {
    id: string;
    kind: LongTermMemoryKind;
    content: string;
    createdAt: string;
    updatedAt: string;
};

export type SessionListItem = {
    id: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    preview: string;
};

export type SessionOverview = SessionListItem & {
    firstUserMessage?: string;
    lastUserMessage?: string;
    lastAssistantMessage?: string;
};

type PersistedMessageRow = {
    payload: string;
};

type SessionRow = {
    id: string;
    created_at: string;
    updated_at: string;
    message_count: number;
};

type LongTermMemoryRow = {
    id: string;
    kind: LongTermMemoryKind;
    content: string;
    created_at: string;
    updated_at: string;
};

type MemoryProposalRow = {
    payload: string;
};

/**
 * 可清理的本地会话与长期记忆存储。
 *
 * SQLite 保存可恢复的结构化状态；按日 Markdown 仅记录便于人工浏览的摘要。
 * 二者都位于 `var/memory/`，不属于知识库，也不应提交到版本控制。
 */
export class MemoryStore {
    private readonly database: DatabaseSync;
    private readonly journalDirectory: string;

    constructor(
        readonly directory = process.env.MEMORY_DIR ?? 'var/memory',
        private readonly now: () => Date = () => new Date()
    ) {
        fs.mkdirSync(directory, { recursive: true });
        this.journalDirectory = path.join(directory, 'journals');
        fs.mkdirSync(this.journalDirectory, { recursive: true });
        this.database = new DatabaseSync(path.join(directory, 'agent.db'));
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (session_id, sequence),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS long_term_memories (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('preference', 'constraint', 'fact')),
                content TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT
            );

            CREATE TABLE IF NOT EXISTS memory_proposals (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                session_id TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_proposals_status_updated
            ON memory_proposals(status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS memory_proposal_events (
                proposal_id TEXT NOT NULL,
                status TEXT NOT NULL,
                at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (proposal_id, status, at),
                FOREIGN KEY (proposal_id) REFERENCES memory_proposals(id) ON DELETE CASCADE
            );
        `);
    }

    createSessionId(): string {
        return randomUUID();
    }

    hasSession(sessionId: string): boolean {
        return Boolean(
            this.database.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
        );
    }

    ensureSession(sessionId: string): void {
        const timestamp = this.timestamp();
        this.database.prepare(`
            INSERT INTO sessions (id, created_at, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `).run(sessionId, timestamp, timestamp);
    }

    loadSessionMessages(sessionId: string): MemoryMessage[] {
        const rows = this.database.prepare(`
            SELECT payload
            FROM session_messages
            WHERE session_id = ?
            ORDER BY sequence ASC
        `).all(sessionId) as PersistedMessageRow[];

        return rows.flatMap(row => {
            try {
                const message = JSON.parse(row.payload);
                return isMemoryMessage(message) ? [message] : [];
            } catch {
                return [];
            }
        });
    }

    appendSessionMessage(sessionId: string, message: MemoryMessage): void {
        this.ensureSession(sessionId);
        const timestamp = this.timestamp();
        const sequence = this.database.prepare(`
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM session_messages
            WHERE session_id = ?
        `).get(sessionId) as { next_sequence: number };
        this.database.prepare(`
            INSERT INTO session_messages (session_id, sequence, created_at, payload)
            VALUES (?, ?, ?, ?)
        `).run(sessionId, sequence.next_sequence, timestamp, JSON.stringify(message));
        this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
        this.appendJournal(sessionId, message);
    }

    clearSessionMessages(sessionId: string): void {
        this.database.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
        this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(this.timestamp(), sessionId);
    }

    listSessions(limit = 20, previewChars = 120): SessionListItem[] {
        const normalizedLimit = normalizePositiveInteger(limit, 20, 100);
        const rows = this.database.prepare(`
            SELECT sessions.id, sessions.created_at, sessions.updated_at, COUNT(session_messages.session_id) AS message_count
            FROM sessions
            LEFT JOIN session_messages ON session_messages.session_id = sessions.id
            GROUP BY sessions.id
            ORDER BY sessions.updated_at DESC
            LIMIT ?
        `).all(normalizedLimit) as SessionRow[];

        return rows.map(row => {
            const messages = this.loadSessionMessages(row.id);
            return {
                id: row.id,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                messageCount: row.message_count,
                preview: buildSessionPreview(messages, previewChars)
            };
        });
    }

    getSessionOverview(sessionId: string, previewChars = 1000): SessionOverview | undefined {
        const row = this.database.prepare(`
            SELECT sessions.id, sessions.created_at, sessions.updated_at, COUNT(session_messages.session_id) AS message_count
            FROM sessions
            LEFT JOIN session_messages ON session_messages.session_id = sessions.id
            WHERE sessions.id = ?
            GROUP BY sessions.id
        `).get(sessionId) as SessionRow | undefined;
        if (!row) return undefined;

        const messages = this.loadSessionMessages(row.id);
        const userMessages = messages
            .filter(message => message.role === 'user')
            .map(getTextContent)
            .filter((content): content is string => Boolean(content));
        const assistantMessages = messages
            .filter(message => message.role === 'assistant')
            .map(getTextContent)
            .filter((content): content is string => Boolean(content));

        return {
            id: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messageCount: row.message_count,
            preview: buildSessionPreview(messages, previewChars),
            firstUserMessage: userMessages[0],
            lastUserMessage: userMessages.at(-1),
            lastAssistantMessage: assistantMessages.at(-1)
        };
    }

    loadLongTermMemories(): LongTermMemoryItem[] {
        const now = this.timestamp();
        const rows = this.database.prepare(`
            SELECT id, kind, content, created_at, updated_at
            FROM long_term_memories
            WHERE expires_at IS NULL OR expires_at > ?
            ORDER BY updated_at DESC
        `).all(now) as LongTermMemoryRow[];
        return rows.map(row => ({
            id: row.id,
            kind: row.kind,
            content: row.content,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    remember(content: string, kind: LongTermMemoryKind = 'fact'): LongTermMemoryItem {
        const normalizedContent = content.trim().replace(/\s+/g, ' ');
        if (!normalizedContent) throw new Error('long-term memory content must be non-empty');
        const timestamp = this.timestamp();
        const existing = this.database.prepare(`
            SELECT id, kind, content, created_at, updated_at
            FROM long_term_memories
            WHERE content = ?
        `).get(normalizedContent) as LongTermMemoryRow | undefined;
        if (existing) {
            this.database.prepare(`
                UPDATE long_term_memories
                SET kind = ?, updated_at = ?, expires_at = NULL
                WHERE id = ?
            `).run(kind, timestamp, existing.id);
            return {
                id: existing.id,
                kind,
                content: existing.content,
                createdAt: existing.created_at,
                updatedAt: timestamp
            };
        }

        const item: LongTermMemoryItem = {
            id: randomUUID(),
            kind,
            content: normalizedContent,
            createdAt: timestamp,
            updatedAt: timestamp
        };
        this.database.prepare(`
            INSERT INTO long_term_memories (id, kind, content, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(item.id, item.kind, item.content, item.createdAt, item.updatedAt);
        return item;
    }

    forget(memoryId: string): boolean {
        const result = this.database.prepare('DELETE FROM long_term_memories WHERE id = ?').run(memoryId);
        return result.changes > 0;
    }

    saveMemoryProposal(proposal: MemoryProposal): MemoryProposal {
        this.database.prepare(`
            INSERT INTO memory_proposals (id, status, kind, content, session_id, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                kind = excluded.kind,
                content = excluded.content,
                session_id = excluded.session_id,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        `).run(
            proposal.id,
            proposal.status,
            proposal.kind,
            proposal.content,
            proposal.sessionId ?? null,
            JSON.stringify(proposal),
            proposal.createdAt,
            proposal.updatedAt
        );
        this.database.prepare(`
            INSERT OR IGNORE INTO memory_proposal_events (proposal_id, status, at, payload)
            VALUES (?, ?, ?, ?)
        `).run(proposal.id, proposal.status, proposal.updatedAt, JSON.stringify(proposal));
        return proposal;
    }

    getMemoryProposal(proposalId: string): MemoryProposal | undefined {
        const row = this.database.prepare('SELECT payload FROM memory_proposals WHERE id = ?')
            .get(proposalId) as MemoryProposalRow | undefined;
        return row ? parseMemoryProposal(row.payload) : undefined;
    }

    listMemoryProposals(status?: MemoryProposalStatus): MemoryProposal[] {
        const rows = (status
            ? this.database.prepare(`
                SELECT payload FROM memory_proposals WHERE status = ? ORDER BY updated_at DESC
            `).all(status)
            : this.database.prepare(`
                SELECT payload FROM memory_proposals ORDER BY updated_at DESC
            `).all()) as MemoryProposalRow[];
        return rows.flatMap(row => {
            const proposal = parseMemoryProposal(row.payload);
            return proposal ? [proposal] : [];
        });
    }

    commitApprovedProposal(proposalId: string): { proposal: MemoryProposal; memory: LongTermMemoryItem } {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const proposal = this.getMemoryProposal(proposalId);
            if (!proposal) throw new Error(`memory proposal not found: ${proposalId}`);
            if (proposal.status !== 'approved') {
                throw new Error(`only approved proposal can be committed; current status is ${proposal.status}`);
            }
            const memory = this.remember(proposal.content, proposal.kind);
            const committed = transitionMemoryProposal(
                proposal,
                'committed',
                { committedMemoryId: memory.id },
                this.now
            );
            this.saveMemoryProposal(committed);
            this.database.exec('COMMIT');
            return { proposal: committed, memory };
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }

    prune(options: { sessionRetentionDays: number; journalRetentionDays: number }): void {
        const sessionCutoff = this.daysAgo(options.sessionRetentionDays);
        this.database.prepare('DELETE FROM sessions WHERE updated_at < ?').run(sessionCutoff);
        this.database.prepare('DELETE FROM long_term_memories WHERE expires_at IS NOT NULL AND expires_at <= ?').run(this.timestamp());

        const journalCutoff = this.daysAgo(options.journalRetentionDays).slice(0, 10);
        for (const entry of fs.readdirSync(this.journalDirectory, { withFileTypes: true })) {
            if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue;
            if (entry.name.slice(0, 10) < journalCutoff) {
                fs.rmSync(path.join(this.journalDirectory, entry.name), { force: true });
            }
        }
    }

    close(): void {
        this.database.close();
    }

    private appendJournal(sessionId: string, message: MemoryMessage): void {
        if (message.role !== 'user' && message.role !== 'assistant') return;
        const content = typeof message.content === 'string' ? message.content.trim().replace(/\s+/g, ' ') : '';
        if (!content) return;

        const date = this.timestamp().slice(0, 10);
        const journalPath = path.join(this.journalDirectory, `${date}.md`);
        if (!fs.existsSync(journalPath)) {
            fs.writeFileSync(journalPath, `# 会话日志：${date}\n`, 'utf-8');
        }
        fs.appendFileSync(
            journalPath,
            `\n- ${this.timestamp()} [${sessionId}] ${message.role}：${content.slice(0, 400)}\n`,
            'utf-8'
        );
    }

    private timestamp(): string {
        return this.now().toISOString();
    }

    private daysAgo(days: number): string {
        const date = this.now();
        date.setUTCDate(date.getUTCDate() - Math.max(0, days));
        return date.toISOString();
    }
}

function isMemoryMessage(value: unknown): value is MemoryMessage {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { role?: unknown }).role === 'string';
}

function parseMemoryProposal(payload: string): MemoryProposal | undefined {
    try {
        const value = JSON.parse(payload);
        return value && typeof value === 'object' && typeof value.id === 'string'
            && typeof value.status === 'string' && typeof value.content === 'string'
            ? value as MemoryProposal
            : undefined;
    } catch {
        return undefined;
    }
}

function buildSessionPreview(messages: MemoryMessage[], maxChars: number): string {
    const preview = messages
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => {
            const content = getTextContent(message);
            return content ? `${message.role === 'user' ? '用户' : '助手'}：${content}` : '';
        })
        .filter(Boolean)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
    const limit = normalizePositiveInteger(maxChars, 120, 10000);
    return preview.length > limit ? `${preview.slice(0, limit)}...` : preview;
}

function getTextContent(message: MemoryMessage): string | undefined {
    return typeof message.content === 'string' && message.content.trim()
        ? message.content.trim().replace(/\s+/g, ' ')
        : undefined;
}

function normalizePositiveInteger(value: number, fallback: number, maximum: number): number {
    return Number.isFinite(value) && value > 0
        ? Math.min(Math.floor(value), maximum)
        : fallback;
}
