import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../server.js';
import { createNoopTraceStore, createTraceStore, nowTraceTimestamp } from '../traces/store.js';

function streamFromChunks(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function streamThatFailsAfterFirstSemanticChunk(errorMessage = 'stream dropped after commit'): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield 'data: {"id":"resp-ok","choices":[{"delta":{"content":"hel"}}]}\n\n';
      throw new Error(errorMessage);
    },
  };
}

describe('POST /v1/chat/completions', () => {
  test('retries empty-success once and returns the later semantic success', async () => {
    let attempts = 0;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      fetchUpstream: async () => {
        attempts += 1;

        if (attempts === 1) {
          return {
            status: 200,
            headers: {},
            json: async () => ({
              id: 'resp-empty',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                  },
                },
              ],
            }),
          };
        }

        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-ok',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'hello from upstream',
                },
              },
            ],
          }),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-ok',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hello from upstream',
          },
        },
      ],
    });
    expect(attempts).toBe(2);

    await app.close();
  });

  test('retries a timeout-classified upstream failure and returns the later semantic success', async () => {
    let attempts = 0;
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-timeout-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async () => {
        attempts += 1;

        if (attempts === 1) {
          const error = new Error('upstream timed out');
          (error as Error & { name?: string }).name = 'TimeoutError';
          throw error;
        }

        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-timeout-recovered',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'timeout recovered',
                },
              },
            ],
          }),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-timeout-recovered',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'timeout recovered',
          },
        },
      ],
    });
    expect(attempts).toBe(2);

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'retry_scheduled', classification: 'timeout' }),
        expect.objectContaining({ event: 'request_completed', classification: 'semantic_success' }),
      ]),
    );

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare('SELECT attempts, final_classification, committed, error_class FROM request_summaries')
      .all() as Array<{
      attempts: number;
      final_classification: string;
      committed: number;
      error_class: string | null;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempts: 2,
      final_classification: 'semantic_success',
      committed: 0,
      error_class: 'timeout',
    });
  });

  test('surfaces explicit failure when all attempts end as empty-success', async () => {
    let attempts = 0;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
      fetchUpstream: async () => {
        attempts += 1;
        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: `resp-empty-${attempts}`,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '   ',
                },
              },
            ],
          }),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        message: 'Upstream response exhausted retries without semantic success.',
        type: 'upstream_empty_success',
        request_id: expect.any(String),
        attempts: 2,
        final_error_class: 'empty_success',
      },
    });
    expect(attempts).toBe(2);

    await app.close();
  });

  test('accumulates token usage across retries into the daily per-model stats', async () => {
    let attempts = 0;
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-token-retry-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async () => {
        attempts += 1;

        if (attempts === 1) {
          return {
            status: 200,
            headers: {},
            json: async () => ({
              id: 'resp-empty-usage',
              usage: {
                prompt_tokens: 50,
                completion_tokens: 10,
                total_tokens: 60,
              },
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                  },
                },
              ],
            }),
          };
        }

        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-ok-usage',
            usage: {
              prompt_tokens: 60,
              completion_tokens: 20,
              total_tokens: 80,
            },
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'recovered with usage',
                },
              },
            ],
          }),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(attempts).toBe(2);

    const statsResponse = await app.inject({
      method: 'GET',
      url: '/stats/tokens/daily?model=gpt-5.4',
    });

    expect(statsResponse.statusCode).toBe(200);
    expect(statsResponse.json()).toEqual({
      items: [
        {
          date: nowTraceTimestamp().slice(0, 10),
          model: 'gpt-5.4',
          requestCount: 1,
          promptTokens: 110,
          completionTokens: 30,
          totalTokens: 140,
          updatedAt: expect.stringMatching(/\+08:00$/),
        },
      ],
    });

    await app.close();
  });

  test('buffers streaming responses until semantic content appears and retries empty pre-commit streams', async () => {
    let attempts = 0;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      fetchUpstream: async () => {
        attempts += 1;

        if (attempts === 1) {
          return {
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
            },
            json: async () => ({ error: 'stream path should not call json here' }),
            textStream: streamFromChunks([
              'data: {"id":"resp-empty","choices":[{"delta":{"role":"assistant"}}]}\n\n',
              'data: [DONE]\n\n',
            ]),
          };
        }

        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
          },
          json: async () => ({ error: 'stream path should not call json here' }),
          textStream: streamFromChunks([
            'data: {"id":"resp-ok","choices":[{"delta":{"content":"hel"}}]}\n\n',
            'data: {"id":"resp-ok","choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).not.toContain('resp-empty');
    expect(response.body).toContain('resp-ok');
    expect(response.body).toContain('"content":"hel"');
    expect(response.body).toContain('[DONE]');
    expect(attempts).toBe(2);

    await app.close();
  });

  test('does not double-send after stream commit and surfaces an explicit SSE error with trace evidence', async () => {
    let attempts = 0;
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-stream-post-commit-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async () => {
        attempts += 1;
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
          },
          json: async () => ({ error: 'stream path should not call json here' }),
          textStream: streamThatFailsAfterFirstSemanticChunk(),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(attempts).toBe(1);
    expect(response.body).toContain('"content":"hel"');
    expect(response.body.match(/"content":"hel"/g)?.length ?? 0).toBe(1);
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('upstream_stream_interrupted');
    expect(response.body).toContain('stream_interrupted_after_commit');

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'semantic_success', committed: true }),
        expect.objectContaining({ event: 'post_commit_error', classification: 'stream_interrupted_after_commit' }),
        expect.objectContaining({ event: 'request_completed', classification: 'post_commit_interrupted', committed: true }),
      ]),
    );

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare('SELECT attempts, final_classification, committed, error_class FROM request_summaries')
      .all() as Array<{
      attempts: number;
      final_classification: string;
      committed: number;
      error_class: string | null;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempts: 1,
      final_classification: 'post_commit_interrupted',
      committed: 1,
      error_class: 'stream_interrupted_after_commit',
    });
  });

  test('returns explicit retry exhaustion for timeout failures and leaves enough diagnostics to explain the outcome', async () => {
    let attempts = 0;
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-timeout-exhausted-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
      traceStore,
      fetchUpstream: async () => {
        attempts += 1;
        const error = new Error('upstream timed out again');
        (error as Error & { name?: string }).name = 'TimeoutError';
        throw error;
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        message: 'Upstream request failed after retries.',
        type: 'upstream_retry_exhausted',
        request_id: expect.any(String),
        attempts: 2,
        final_error_class: 'timeout',
      },
    });
    expect(attempts).toBe(2);

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'request_received', model: 'gpt-5.4', stream: false }),
        expect.objectContaining({ event: 'attempt_started', attempt: 1 }),
        expect.objectContaining({ event: 'attempt_started', attempt: 2 }),
        expect.objectContaining({ event: 'retry_scheduled', classification: 'timeout' }),
        expect.objectContaining({ event: 'request_completed', classification: 'timeout', committed: false }),
      ]),
    );

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare('SELECT attempts, final_classification, committed, error_class FROM request_summaries')
      .all() as Array<{
      attempts: number;
      final_classification: string;
      committed: number;
      error_class: string | null;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempts: 2,
      final_classification: 'timeout',
      committed: 0,
      error_class: 'timeout',
    });
  });

  test('persists JSONL events and SQLite summaries for request forensics', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-traces-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async () => ({
        status: 200,
        headers: {},
        json: async () => ({
          id: 'resp-ok',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'trace me',
              },
            },
          ],
        }),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'request_received',
        'attempt_started',
        'upstream_response',
        'request_completed',
      ]),
    );
    expect(jsonl.every((event) => typeof event.timestamp === 'string' && event.timestamp.endsWith('+08:00'))).toBe(true);
    expect(jsonl.every((event) => typeof event.timestamp === 'string' && !event.timestamp.endsWith('Z'))).toBe(true);

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare('SELECT attempts, final_classification, committed, created_at, prompt_tokens, completion_tokens, total_tokens FROM request_summaries')
      .all() as Array<{
      attempts: number;
      final_classification: string;
      committed: number;
      created_at: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempts: 1,
      final_classification: 'semantic_success',
      committed: 0,
      created_at: expect.stringMatching(/\+08:00$/),
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  test('aggregates daily token usage by model and keeps models separated', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-token-stats-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async ({ body }) => {
        const model = String((body as { model?: string }).model ?? '');
        if (model === 'gpt-5.4') {
          return {
            status: 200,
            headers: {},
            json: async () => ({
              id: 'resp-gpt',
              usage: {
                prompt_tokens: 120,
                completion_tokens: 45,
                total_tokens: 165,
              },
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'hello gpt',
                  },
                },
              ],
            }),
          };
        }

        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-step',
            usage: {
              prompt_tokens: 60,
              completion_tokens: 15,
              total_tokens: 75,
            },
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'hello step',
                },
              },
            ],
          }),
        };
      },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'stepfun/step-3.5-flash:free',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/stats/tokens/daily',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: expect.arrayContaining([
        {
          date: nowTraceTimestamp().slice(0, 10),
          model: 'gpt-5.4',
          requestCount: 1,
          promptTokens: 120,
          completionTokens: 45,
          totalTokens: 165,
          updatedAt: expect.stringMatching(/\+08:00$/),
        },
        {
          date: nowTraceTimestamp().slice(0, 10),
          model: 'stepfun/step-3.5-flash:free',
          requestCount: 1,
          promptTokens: 60,
          completionTokens: 15,
          totalTokens: 75,
          updatedAt: expect.stringMatching(/\+08:00$/),
        },
      ]),
    });

    await app.close();
  });
});
