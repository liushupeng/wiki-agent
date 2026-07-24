import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';

type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type LongTermMemoryKind = 'preference' | 'constraint' | 'fact';

export type LongTermMemoryItem = {
    id: string;
    kind: LongTermMemoryKind;
    content: string;
    createdAt: string;
    updatedAt: string;
};

type PersistedMessageRow = {
    payload: string;
};

type LongTermMemoryRow = {
    id: string;
    kind: LongTermMemoryKind;
    content: string;
    created_at: string;
    updated_at: string;
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
