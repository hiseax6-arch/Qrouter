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
  endpoint?: 'chat.completions' | 'responses';
  model: string | null;
  stream: boolean;
  attempts: number;
  finalClassification: string;
  committed: boolean;
  lastStatus: number | null;
  errorClass: string | null;
  requestedModel?: string | null;
  upstreamModel?: string | null;
  providerId?: string | null;
  routeId?: string | null;
  failoverUsed?: boolean;
  failoverFrom?: string | null;
  failoverTo?: string | null;
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

export type RequestSummaryRow = {
  requestId: string;
  endpoint: string | null;
  model: string | null;
  stream: boolean;
  attempts: number;
  finalClassification: string;
  committed: boolean;
  lastStatus: number | null;
  errorClass: string | null;
  requestedModel: string | null;
  upstreamModel: string | null;
  providerId: string | null;
  routeId: string | null;
  failoverUsed: boolean;
  failoverFrom: string | null;
  failoverTo: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
};

export type RequestSummaryFilters = {
  endpoint?: string;
  providerId?: string;
  routeId?: string;
  failoverUsed?: boolean;
  model?: string;
  requestedModel?: string;
  upstreamModel?: string;
  finalClassification?: string;
  committed?: boolean;
  limit?: number;
};

export type RequestSummaryAggregateRow = {
  endpoint: string | null;
  providerId: string | null;
  routeId: string | null;
  failoverUsed: boolean;
  finalClassification: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latestCreatedAt: string;
};

export type RouteHealthRow = {
  endpoint: string | null;
  providerId: string | null;
  routeId: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  failoverRequests: number;
  failureRate: number;
  failoverHitRate: number;
  latestRequestAt: string;
  latestSuccessAt: string | null;
  latestFailureAt: string | null;
  latestErrorClassification: string | null;
  status: 'healthy' | 'degraded' | 'failing';
};

export type TraceStore = {
  appendEvent(event: TraceEvent): void;
  recordSummary(summary: TraceSummary): void;
  listDailyTokenUsage(filters?: DailyTokenUsageFilters): ReadonlyArray<DailyTokenUsageRow>;
  listRequestSummaries(filters?: RequestSummaryFilters): ReadonlyArray<RequestSummaryRow>;
  aggregateRequestSummaries(filters?: RequestSummaryFilters): ReadonlyArray<RequestSummaryAggregateRow>;
  listRouteHealth(filters?: RequestSummaryFilters): ReadonlyArray<RouteHealthRow>;
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

function buildRequestSummaryFilterParts(filters: RequestSummaryFilters): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.endpoint) {
    conditions.push('endpoint = ?');
    params.push(filters.endpoint);
  }

  if (filters.providerId) {
    conditions.push('provider_id = ?');
    params.push(filters.providerId);
  }

  if (filters.routeId) {
    conditions.push('route_id = ?');
    params.push(filters.routeId);
  }

  if (filters.model) {
    conditions.push('model = ?');
    params.push(filters.model);
  }

  if (filters.requestedModel) {
    conditions.push('requested_model = ?');
    params.push(filters.requestedModel);
  }

  if (filters.upstreamModel) {
    conditions.push('upstream_model = ?');
    params.push(filters.upstreamModel);
  }

  if (filters.finalClassification) {
    conditions.push('final_classification = ?');
    params.push(filters.finalClassification);
  }

  if (typeof filters.failoverUsed === 'boolean') {
    conditions.push('COALESCE(failover_used, 0) = ?');
    params.push(filters.failoverUsed ? 1 : 0);
  }

  if (typeof filters.committed === 'boolean') {
    conditions.push('committed = ?');
    params.push(filters.committed ? 1 : 0);
  }

  return {
    conditions,
    params,
  };
}

function resolveRouteHealthStatus(args: {
  successRequests: number;
  failedRequests: number;
  failoverRequests: number;
}): 'healthy' | 'degraded' | 'failing' {
  if (args.failedRequests > 0 && args.successRequests === 0) {
    return 'failing';
  }

  if (args.failedRequests > 0 || args.failoverRequests > 0) {
    return 'degraded';
  }

  return 'healthy';
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
      endpoint TEXT,
      model TEXT,
      stream INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      final_classification TEXT NOT NULL,
      committed INTEGER NOT NULL,
      last_status INTEGER,
      error_class TEXT,
      requested_model TEXT,
      upstream_model TEXT,
      provider_id TEXT,
      route_id TEXT,
      failover_used INTEGER,
      failover_from TEXT,
      failover_to TEXT,
      created_at TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER
    );
  `);

  ensureColumn(db, 'request_summaries', 'endpoint TEXT');
  ensureColumn(db, 'request_summaries', 'prompt_tokens INTEGER');
  ensureColumn(db, 'request_summaries', 'completion_tokens INTEGER');
  ensureColumn(db, 'request_summaries', 'total_tokens INTEGER');
  ensureColumn(db, 'request_summaries', 'requested_model TEXT');
  ensureColumn(db, 'request_summaries', 'upstream_model TEXT');
  ensureColumn(db, 'request_summaries', 'provider_id TEXT');
  ensureColumn(db, 'request_summaries', 'route_id TEXT');
  ensureColumn(db, 'request_summaries', 'failover_used INTEGER');
  ensureColumn(db, 'request_summaries', 'failover_from TEXT');
  ensureColumn(db, 'request_summaries', 'failover_to TEXT');

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
  const baseDir = overrides.dir ?? process.env.Q_TRACE_DIR ?? process.env.QINGFU_TRACE_DIR ?? join(process.cwd(), '.Q-router');
  return {
    jsonlPath: overrides.jsonlPath ?? process.env.Q_TRACE_JSONL_PATH ?? process.env.QINGFU_TRACE_JSONL_PATH ?? join(baseDir, 'events.jsonl'),
    sqlitePath: overrides.sqlitePath ?? process.env.Q_TRACE_SQLITE_PATH ?? process.env.QINGFU_TRACE_SQLITE_PATH ?? join(baseDir, 'summaries.sqlite'),
  };
}

export function createNoopTraceStore(): TraceStore {
  return {
    appendEvent() {},
    recordSummary() {},
    listDailyTokenUsage() {
      return [];
    },
    listRequestSummaries() {
      return [];
    },
    aggregateRequestSummaries() {
      return [];
    },
    listRouteHealth() {
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
          endpoint,
          model,
          stream,
          attempts,
          final_classification,
          committed,
          last_status,
          error_class,
          requested_model,
          upstream_model,
          provider_id,
          route_id,
          failover_used,
          failover_from,
          failover_to,
          created_at,
          prompt_tokens,
          completion_tokens,
          total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summary.requestId,
        summary.endpoint ?? null,
        summary.model,
        summary.stream ? 1 : 0,
        summary.attempts,
        summary.finalClassification,
        summary.committed ? 1 : 0,
        summary.lastStatus,
        summary.errorClass,
        summary.requestedModel ?? null,
        summary.upstreamModel ?? null,
        summary.providerId ?? null,
        summary.routeId ?? null,
        summary.failoverUsed === undefined ? null : (summary.failoverUsed ? 1 : 0),
        summary.failoverFrom ?? null,
        summary.failoverTo ?? null,
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
    listRequestSummaries(filters = {}) {
      const { conditions, params } = buildRequestSummaryFilterParts(filters);

      let sql = `
        SELECT
          request_id,
          endpoint,
          model,
          stream,
          attempts,
          final_classification,
          committed,
          last_status,
          error_class,
          requested_model,
          upstream_model,
          provider_id,
          route_id,
          failover_used,
          failover_from,
          failover_to,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          created_at
        FROM request_summaries
      `;

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ' ORDER BY created_at DESC';

      if (typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0) {
        sql += ' LIMIT ?';
        params.push(Math.trunc(filters.limit));
      }

      return db.prepare(sql).all(...params).map((row) => ({
        requestId: String(row.request_id ?? ''),
        endpoint: row.endpoint == null ? null : String(row.endpoint),
        model: row.model == null ? null : String(row.model),
        stream: toNumber(row.stream) === 1,
        attempts: toNumber(row.attempts),
        finalClassification: String(row.final_classification ?? ''),
        committed: toNumber(row.committed) === 1,
        lastStatus: row.last_status == null ? null : toNumber(row.last_status),
        errorClass: row.error_class == null ? null : String(row.error_class),
        requestedModel: row.requested_model == null ? null : String(row.requested_model),
        upstreamModel: row.upstream_model == null ? null : String(row.upstream_model),
        providerId: row.provider_id == null ? null : String(row.provider_id),
        routeId: row.route_id == null ? null : String(row.route_id),
        failoverUsed: toNumber(row.failover_used) === 1,
        failoverFrom: row.failover_from == null ? null : String(row.failover_from),
        failoverTo: row.failover_to == null ? null : String(row.failover_to),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        totalTokens: toNumber(row.total_tokens),
        createdAt: String(row.created_at ?? ''),
      }));
    },
    aggregateRequestSummaries(filters = {}) {
      const { conditions, params } = buildRequestSummaryFilterParts(filters);

      let sql = `
        SELECT
          endpoint,
          provider_id,
          route_id,
          COALESCE(failover_used, 0) AS failover_used,
          final_classification,
          COUNT(*) AS request_count,
          SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
          SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens,
          MAX(created_at) AS latest_created_at
        FROM request_summaries
      `;

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += `
        GROUP BY
          endpoint,
          provider_id,
          route_id,
          COALESCE(failover_used, 0),
          final_classification
        ORDER BY latest_created_at DESC, request_count DESC
      `;

      if (typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0) {
        sql += ' LIMIT ?';
        params.push(Math.trunc(filters.limit));
      }

      return db.prepare(sql).all(...params).map((row) => ({
        endpoint: row.endpoint == null ? null : String(row.endpoint),
        providerId: row.provider_id == null ? null : String(row.provider_id),
        routeId: row.route_id == null ? null : String(row.route_id),
        failoverUsed: toNumber(row.failover_used) === 1,
        finalClassification: String(row.final_classification ?? ''),
        requestCount: toNumber(row.request_count),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        totalTokens: toNumber(row.total_tokens),
        latestCreatedAt: String(row.latest_created_at ?? ''),
      }));
    },
    listRouteHealth(filters = {}) {
      const { conditions, params } = buildRequestSummaryFilterParts(filters);

      let sql = `
        WITH filtered AS (
          SELECT * FROM request_summaries
      `;

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += `
        ),
        grouped AS (
          SELECT
            endpoint,
            provider_id,
            route_id,
            COUNT(*) AS total_requests,
            SUM(CASE WHEN final_classification = 'semantic_success' THEN 1 ELSE 0 END) AS success_requests,
            SUM(CASE WHEN final_classification != 'semantic_success' THEN 1 ELSE 0 END) AS failed_requests,
            SUM(CASE WHEN COALESCE(failover_used, 0) = 1 THEN 1 ELSE 0 END) AS failover_requests,
            MAX(created_at) AS latest_request_at,
            MAX(CASE WHEN final_classification = 'semantic_success' THEN created_at END) AS latest_success_at,
            MAX(CASE WHEN final_classification != 'semantic_success' THEN created_at END) AS latest_failure_at
          FROM filtered
          GROUP BY endpoint, provider_id, route_id
        )
        SELECT
          grouped.endpoint,
          grouped.provider_id,
          grouped.route_id,
          grouped.total_requests,
          grouped.success_requests,
          grouped.failed_requests,
          grouped.failover_requests,
          grouped.latest_request_at,
          grouped.latest_success_at,
          grouped.latest_failure_at,
          (
            SELECT filtered2.final_classification
            FROM filtered filtered2
            WHERE
              ((filtered2.endpoint = grouped.endpoint) OR (filtered2.endpoint IS NULL AND grouped.endpoint IS NULL))
              AND ((filtered2.provider_id = grouped.provider_id) OR (filtered2.provider_id IS NULL AND grouped.provider_id IS NULL))
              AND ((filtered2.route_id = grouped.route_id) OR (filtered2.route_id IS NULL AND grouped.route_id IS NULL))
              AND filtered2.final_classification != 'semantic_success'
            ORDER BY filtered2.created_at DESC
            LIMIT 1
          ) AS latest_error_classification
        FROM grouped
        ORDER BY grouped.latest_request_at DESC, grouped.total_requests DESC
      `;

      if (typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0) {
        sql += ' LIMIT ?';
        params.push(Math.trunc(filters.limit));
      }

      return db.prepare(sql).all(...params).map((row) => {
        const totalRequests = toNumber(row.total_requests);
        const successRequests = toNumber(row.success_requests);
        const failedRequests = toNumber(row.failed_requests);
        const failoverRequests = toNumber(row.failover_requests);

        return {
          endpoint: row.endpoint == null ? null : String(row.endpoint),
          providerId: row.provider_id == null ? null : String(row.provider_id),
          routeId: row.route_id == null ? null : String(row.route_id),
          totalRequests,
          successRequests,
          failedRequests,
          failoverRequests,
          failureRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
          failoverHitRate: totalRequests > 0 ? failoverRequests / totalRequests : 0,
          latestRequestAt: String(row.latest_request_at ?? ''),
          latestSuccessAt: row.latest_success_at == null ? null : String(row.latest_success_at),
          latestFailureAt: row.latest_failure_at == null ? null : String(row.latest_failure_at),
          latestErrorClassification:
            row.latest_error_classification == null ? null : String(row.latest_error_classification),
          status: resolveRouteHealthStatus({
            successRequests,
            failedRequests,
            failoverRequests,
          }),
        };
      });
    },
    close() {
      db.close();
    },
  };
}
