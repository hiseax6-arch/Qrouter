import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TokenUsage } from '../domain/token-usage.js';

const require = createRequire(import.meta.url);
const TRACE_TIME_ZONE = 'Asia/Shanghai';

function formatTimestampInShanghai(date: Date): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TRACE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${get('fractionalSecond')}+08:00`;
}

export function nowTraceTimestamp(): string {
  return formatTimestampInShanghai(new Date());
}

export type TraceEvent = {
  timestamp: string;
  requestId: string;
  event: string;
  attempt?: number;
  model?: string | null;
  stream?: boolean;
  status?: number;
  classification?: string;
  detail?: Record<string, unknown>;
};

export type TraceSummary = {
  requestId: string;
  model: string | null;
  stream: boolean;
  attempts: number;
  finalClassification: string;
  committed: boolean;
  lastStatus: number | null;
  errorClass: string | null;
  tokenUsage?: TokenUsage | null;
  createdAt: string;
};

export type DailyTokenUsageRow = {
  date: string;
  model: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  updatedAt: string;
};

export type DailyTokenUsageFilters = {
  date?: string;
  model?: string;
  limit?: number;
};

export type TraceStore = {
  appendEvent(event: TraceEvent): void;
  recordSummary(summary: TraceSummary): void;
  listDailyTokenUsage(filters?: DailyTokenUsageFilters): ReadonlyArray<DailyTokenUsageRow>;
  close(): void;
};

export type TracePaths = {
  jsonlPath: string;
  sqlitePath: string;
};

export type TracePathOverrides = {
  dir?: string;
  jsonlPath?: string;
  sqlitePath?: string;
};

type SqliteStatement = {
  run(...params: ReadonlyArray<unknown>): unknown;
  all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function resolveTokenUsageDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function createNodeSqliteDatabase(path: string): SqliteDatabase {
  const db = new DatabaseSync(path);
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run(...params) {
          return statement.run(...(params as Array<string | number | bigint | Uint8Array | null>));
        },
        all(...params) {
          return statement.all(...(params as Array<string | number | bigint | Uint8Array | null>)) as ReadonlyArray<Record<string, unknown>>;
        },
      };
    },
    close() {
      db.close();
    },
  };
}

function createBetterSqliteDatabase(path: string): SqliteDatabase {
  const BetterSqlite3 = require('better-sqlite3') as new (filename: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      run(...params: ReadonlyArray<unknown>): unknown;
      all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>;
    };
  };
  const db = new BetterSqlite3(path);

  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run(...params) {
          return statement.run(...params);
        },
        all(...params) {
          return statement.all(...params) as ReadonlyArray<Record<string, unknown>>;
        },
      };
    },
    close() {
      db.close();
    },
  };
}

function openTraceDatabase(path: string): SqliteDatabase {
  try {
    return createBetterSqliteDatabase(path);
  } catch {
    return createNodeSqliteDatabase(path);
  }
}

function ensureColumn(db: SqliteDatabase, tableName: string, definition: string): void {
  const columnName = definition.split(/\s+/, 1)[0];
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const existing = new Set(rows.map((row) => String(row.name ?? '')));
  if (!existing.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_summaries (
      request_id TEXT PRIMARY KEY,
      model TEXT,
      stream INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      final_classification TEXT NOT NULL,
      committed INTEGER NOT NULL,
      last_status INTEGER,
      error_class TEXT,
      created_at TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER
    );
  `);

  ensureColumn(db, 'request_summaries', 'prompt_tokens INTEGER');
  ensureColumn(db, 'request_summaries', 'completion_tokens INTEGER');
  ensureColumn(db, 'request_summaries', 'total_tokens INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_model_token_usage (
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (usage_date, model)
    );
  `);
}

export function resolveTracePaths(overrides: TracePathOverrides = {}): TracePaths {
  const baseDir = overrides.dir ?? process.env.Q_TRACE_DIR ?? join(process.cwd(), '.Q-router');
  return {
    jsonlPath: overrides.jsonlPath ?? process.env.Q_TRACE_JSONL_PATH ?? join(baseDir, 'events.jsonl'),
    sqlitePath: overrides.sqlitePath ?? process.env.Q_TRACE_SQLITE_PATH ?? join(baseDir, 'summaries.sqlite'),
  };
}

export function createNoopTraceStore(): TraceStore {
  return {
    appendEvent() {},
    recordSummary() {},
    listDailyTokenUsage() {
      return [];
    },
    close() {},
  };
}

export function createTraceStore(paths: TracePaths): TraceStore {
  ensureParent(paths.jsonlPath);
  ensureParent(paths.sqlitePath);

  const db = openTraceDatabase(paths.sqlitePath);
  initializeSchema(db);

  return {
    appendEvent(event) {
      appendFileSync(paths.jsonlPath, `${JSON.stringify(event)}\n`, 'utf8');
    },
    recordSummary(summary) {
      const promptTokens = summary.tokenUsage?.promptTokens ?? 0;
      const completionTokens = summary.tokenUsage?.completionTokens ?? 0;
      const totalTokens = summary.tokenUsage?.totalTokens ?? 0;

      db.prepare(`
        INSERT OR REPLACE INTO request_summaries (
          request_id,
          model,
          stream,
          attempts,
          final_classification,
          committed,
          last_status,
          error_class,
          created_at,
          prompt_tokens,
          completion_tokens,
          total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summary.requestId,
        summary.model,
        summary.stream ? 1 : 0,
        summary.attempts,
        summary.finalClassification,
        summary.committed ? 1 : 0,
        summary.lastStatus,
        summary.errorClass,
        summary.createdAt,
        promptTokens,
        completionTokens,
        totalTokens,
      );

      if (summary.model) {
        db.prepare(`
          INSERT INTO daily_model_token_usage (
            usage_date,
            model,
            request_count,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(usage_date, model) DO UPDATE SET
            request_count = daily_model_token_usage.request_count + excluded.request_count,
            prompt_tokens = daily_model_token_usage.prompt_tokens + excluded.prompt_tokens,
            completion_tokens = daily_model_token_usage.completion_tokens + excluded.completion_tokens,
            total_tokens = daily_model_token_usage.total_tokens + excluded.total_tokens,
            updated_at = excluded.updated_at
        `).run(
          resolveTokenUsageDate(summary.createdAt),
          summary.model,
          1,
          promptTokens,
          completionTokens,
          totalTokens,
          summary.createdAt,
        );
      }
    },
    listDailyTokenUsage(filters = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters.date) {
        conditions.push('usage_date = ?');
        params.push(filters.date);
      }

      if (filters.model) {
        conditions.push('model = ?');
        params.push(filters.model);
      }

      let sql = `
        SELECT
          usage_date,
          model,
          request_count,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          updated_at
        FROM daily_model_token_usage
      `;

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ' ORDER BY usage_date DESC, model ASC';

      if (typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0) {
        sql += ' LIMIT ?';
        params.push(Math.trunc(filters.limit));
      }

      return db.prepare(sql).all(...params).map((row) => ({
        date: String(row.usage_date ?? ''),
        model: String(row.model ?? ''),
        requestCount: toNumber(row.request_count),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        totalTokens: toNumber(row.total_tokens),
        updatedAt: String(row.updated_at ?? ''),
      }));
    },
    close() {
      db.close();
    },
  };
}
