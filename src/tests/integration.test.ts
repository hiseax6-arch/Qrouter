import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../server.js';
import { createTraceStore } from '../traces/store.js';

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
    const tempDir = mkdtempSync(join(tmpdir(), 'qingfu-router-timeout-'));
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

    const db = new Database(sqlitePath, { readonly: true });
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

  test('buffers streaming responses until semantic content appears and retries empty pre-commit streams', async () => {
    let attempts = 0;
    const app = buildApp({
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
    const tempDir = mkdtempSync(join(tmpdir(), 'qingfu-router-stream-post-commit-'));
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

    const db = new Database(sqlitePath, { readonly: true });
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
    const tempDir = mkdtempSync(join(tmpdir(), 'qingfu-router-timeout-exhausted-'));
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

    const db = new Database(sqlitePath, { readonly: true });
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
    const tempDir = mkdtempSync(join(tmpdir(), 'qingfu-router-traces-'));
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

    const db = new Database(sqlitePath, { readonly: true });
    const rows = db
      .prepare('SELECT attempts, final_classification, committed FROM request_summaries')
      .all() as Array<{ attempts: number; final_classification: string; committed: number }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempts: 1,
      final_classification: 'semantic_success',
      committed: 0,
    });
  });
});
