import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

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
  createdAt: string;
};

export type TraceStore = {
  appendEvent(event: TraceEvent): void;
  recordSummary(summary: TraceSummary): void;
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

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
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
    close() {},
  };
}

export function createTraceStore(paths: TracePaths): TraceStore {
  ensureParent(paths.jsonlPath);
  ensureParent(paths.sqlitePath);

  const db = new Database(paths.sqlitePath);
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
      created_at TEXT NOT NULL
    );
  `);

  return {
    appendEvent(event) {
      appendFileSync(paths.jsonlPath, `${JSON.stringify(event)}\n`, 'utf8');
    },
    recordSummary(summary) {
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
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
    },
    close() {
      if (existsSync(paths.sqlitePath)) {
        db.close();
      }
    },
  };
}
