import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import type { RouterRuntimeConfig } from '../config/router.js';
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

const minimalResponsesRuntimeConfig: RouterRuntimeConfig = {
  configPath: '/tmp/qrouter-test-router.json',
  server: {
    host: '127.0.0.1',
    port: 0,
  },
  upstream: {
    timeoutMs: 45_000,
  },
  providers: {},
  routes: [],
  models: {
    allow: ['gpt-5.4'],
  },
  thinking: {},
  traces: {},
};

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

  test('intercepts OpenClaw slash commands like /agents on chat-completions without upstream fetch', async () => {
    let called = false;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      fetchUpstream: async () => {
        called = true;
        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-should-not-run',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'should not happen',
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
        messages: [{ role: 'user', content: '/agents' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('/agents'),
          },
        },
      ],
    });
    expect(response.body).toContain('Q-router 已在本地拦截该命令');
    expect(called).toBe(false);

    await app.close();
  });

  test('intercepts OpenClaw slash commands like /agents on responses without upstream fetch', async () => {
    let called = false;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      fetchUpstream: async () => {
        called = true;
        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-should-not-run',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'should not happen',
                  },
                ],
              },
            ],
          }),
        };
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: '/agents',
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      metadata: {
        qrouter_local_command: true,
        command_name: 'agents',
        command_text: '/agents',
      },
      output: [
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: expect.stringContaining('/agents'),
            },
          ],
        },
      ],
    });
    expect(response.body).toContain('Q-router 已在本地拦截该命令');
    expect(called).toBe(false);

    await app.close();
  });

  test('emits responses_request_completed for semantic success on /v1/responses', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-responses-success-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      routerConfig: minimalResponsesRuntimeConfig,
      fetchUpstream: async () => ({
        status: 200,
        headers: {},
        providerId: 'codex',
        routeId: 'codex-main',
        upstreamUrl: 'https://codex.example.test/v1/responses',
        json: async () => ({
          id: 'resp-ok',
          object: 'response',
          model: 'gpt-5.4',
          output: [],
        }),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hi',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-ok',
      object: 'response',
    });

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'responses_request_received',
          model: 'gpt-5.4',
          stream: false,
        }),
        expect.objectContaining({ event: 'responses_attempt_started', attempt: 1 }),
        expect.objectContaining({
          event: 'responses_upstream_response',
          status: 200,
          providerId: 'codex',
          routeId: 'codex-main',
          upstreamUrl: 'https://codex.example.test/v1/responses',
        }),
        expect.objectContaining({
          event: 'responses_request_completed',
          classification: 'semantic_success',
          committed: false,
          upstreamStatus: 200,
          providerId: 'codex',
          routeId: 'codex-main',
        }),
      ]),
    );
  });

  test('emits responses_request_completed for terminal failures on /v1/responses', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-responses-terminal-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      routerConfig: minimalResponsesRuntimeConfig,
      fetchUpstream: async () => ({
        status: 401,
        headers: {},
        providerId: 'codex',
        routeId: 'codex-main',
        upstreamUrl: 'https://codex.example.test/v1/responses',
        json: async () => ({
          error: {
            type: 'invalid_api_key',
            message: 'Bad credentials',
          },
        }),
        bodyText: async () => JSON.stringify({
          error: {
            type: 'invalid_api_key',
            message: 'Bad credentials',
          },
        }),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hi',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        type: 'upstream_terminal_error',
        final_error_class: 'http_401',
      },
    });

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'responses_terminal_failure_returned',
          classification: 'http_401',
          upstreamStatus: 401,
        }),
        expect.objectContaining({
          event: 'responses_request_completed',
          classification: 'http_401',
          committed: false,
          upstreamStatus: 401,
          providerId: 'codex',
          routeId: 'codex-main',
        }),
      ]),
    );
  });

  test('retries 403 usage-limit responses and returns the later semantic success', async () => {
    let attempts = 0;
    const app = buildApp({
      traceStore: createNoopTraceStore(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
      fetchUpstream: async () => {
        attempts += 1;

        if (attempts === 1) {
          return {
            status: 403,
            headers: {},
            json: async () => ({
              error: {
                type: 'usage_limit_reached',
                message: 'The usage limit has been reached',
              },
            }),
            bodyText: async () => JSON.stringify({
              error: {
                type: 'usage_limit_reached',
                message: 'The usage limit has been reached',
              },
            }),
          };
        }

        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-usage-recovered',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'recovered after transient quota gate',
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
      id: 'resp-usage-recovered',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'recovered after transient quota gate',
          },
        },
      ],
    });
    expect(attempts).toBe(2);

    await app.close();
  });

  test('returns a visible assistant reply when all attempts end as empty-success', async () => {
    let attempts = 0;
    const app = buildApp({
      routerConfig: minimalResponsesRuntimeConfig,
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('上游模型返回了空响应'),
          },
        },
      ],
    });
    expect((response.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toContain('当前没有可连通模型');
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

  test('returns a visible assistant reply for timeout failures after retry exhaustion and keeps diagnostics', async () => {
    let attempts = 0;
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-timeout-exhausted-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      routerConfig: minimalResponsesRuntimeConfig,
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('上游模型请求超时'),
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
        expect.objectContaining({ event: 'request_received', model: 'gpt-5.4', stream: false }),
        expect.objectContaining({ event: 'attempt_started', attempt: 1 }),
        expect.objectContaining({ event: 'attempt_started', attempt: 2 }),
        expect.objectContaining({ event: 'retry_scheduled', classification: 'timeout' }),
        expect.objectContaining({ event: 'visible_failure_returned', classification: 'timeout' }),
        expect.objectContaining({ event: 'request_completed', classification: 'timeout', committed: true }),
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
      committed: 1,
      error_class: 'timeout',
    });
  });

  test('returns a visible assistant reply after retry exhaustion on 429', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-429-exhausted-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    let attempts = 0;
    const app = buildApp({
      routerConfig: minimalResponsesRuntimeConfig,
      traceStore,
      fetchUpstream: async () => {
        attempts += 1;
        return {
          status: 429,
          headers: {},
          providerId: 'codex',
          upstreamUrl: 'https://codex.example.test/v1/responses',
          json: async () => ({
            error: {
              type: 'rate_limit_error',
              code: 'USAGE_LIMIT_EXCEEDED',
              message: 'daily usage limit exceeded',
            },
          }),
          bodyText: async () => JSON.stringify({
            error: {
              type: 'rate_limit_error',
              code: 'USAGE_LIMIT_EXCEEDED',
              message: 'daily usage limit exceeded',
            },
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
      object: 'chat.completion',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('当前没有可连通模型'),
          },
        },
      ],
    });
    expect(response.body).toContain('上游模型当前限流或额度已耗尽：daily usage limit exceeded');
    expect(attempts).toBe(4);

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'upstream_error', status: 429, retryable: true }),
        expect.objectContaining({ event: 'retry_scheduled', classification: 'http_429' }),
        expect.objectContaining({ event: 'visible_failure_returned', classification: 'http_429' }),
        expect.objectContaining({ event: 'request_completed', classification: 'http_429', committed: true }),
      ]),
    );
  });

  test('surfaces parsed upstream error details for non-retryable terminal failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'Q-router-terminal-error-'));
    const jsonlPath = join(tempDir, 'events.jsonl');
    const sqlitePath = join(tempDir, 'summaries.sqlite');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });

    const app = buildApp({
      traceStore,
      fetchUpstream: async () => ({
        status: 403,
        headers: {},
        providerId: 'codex',
        upstreamUrl: 'https://codex.example.test/v1/responses',
        json: async () => ({
          error: {
            type: 'forbidden',
            code: 'plan_forbidden',
            message: 'Plan does not allow this model',
          },
        }),
        bodyText: async () => JSON.stringify({
          error: {
            type: 'forbidden',
            code: 'plan_forbidden',
            message: 'Plan does not allow this model',
          },
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

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        type: 'upstream_terminal_error',
        message: '上游拒绝当前请求（HTTP 403）：Plan does not allow this model',
        request_id: expect.any(String),
        attempts: 1,
        final_error_class: 'http_403',
        upstream_status: 403,
        upstream_error: {
          type: 'forbidden',
          code: 'plan_forbidden',
          message: 'Plan does not allow this model',
        },
      },
    });

    await app.close();

    const jsonl = readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(jsonl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'upstream_response',
          status: 403,
          providerId: 'codex',
          upstreamUrl: 'https://codex.example.test/v1/responses',
        }),
        expect.objectContaining({
          event: 'upstream_error',
          status: 403,
          providerId: 'codex',
          upstreamUrl: 'https://codex.example.test/v1/responses',
          retryable: false,
          upstreamErrorType: 'forbidden',
          upstreamErrorCode: 'plan_forbidden',
          upstreamErrorMessage: 'Plan does not allow this model',
        }),
        expect.objectContaining({
          event: 'terminal_failure_returned',
          classification: 'http_403',
          upstreamStatus: 403,
          upstreamErrorType: 'forbidden',
        }),
        expect.objectContaining({
          event: 'request_completed',
          classification: 'http_403',
          committed: false,
        }),
      ]),
    );
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
