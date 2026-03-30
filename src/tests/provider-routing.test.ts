import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadRouterRuntimeConfig } from '../config/router.js';
import { resetRoutingState } from '../routing/routes.js';
import { buildApp } from '../server.js';
import { createTraceStore } from '../traces/store.js';

const originalCwd = cwd();
const envKeys = [
  'Q_ROUTER_CONFIG_PATH',
  'Q_ROUTER_MAPPINGS_PATH',
  'QINGFU_ROUTER_MAPPINGS_PATH',
  'Q_ROUTER_PORT',
  'Q_ROUTER_HOST',
  'Q_UPSTREAM_BASE_URL',
  'Q_UPSTREAM_API_KEY',
  'Q_UPSTREAM_TIMEOUT_MS',
  'Q_CODEX_API_KEY',
  'Q_CUSTOM_API_KEY',
  'Q_OPENROUTER_API_KEY',
  'Q_MODELSCOPE_API_KEY',
];
const originalFetch = globalThis.fetch;
const modelScopePool = [
  'MiniMax/MiniMax-M2.5',
  'ZhipuAI/GLM-5',
  'Qwen/Qwen3-235B-A22B',
  'moonshotai/Kimi-K2.5',
] as const;

function writeRouterConfig(config: unknown, mappings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'Q-router-provider-'));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'router.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (mappings !== undefined) {
    writeFileSync(join(configDir, 'model-mappings.json'), JSON.stringify(mappings, null, 2));
  }
  return dir;
}

afterEach(() => {
  chdir(originalCwd);
  for (const key of envKeys) {
    delete process.env[key];
  }
  resetRoutingState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('provider-aware upstream routing', () => {
  test('routes LR/gpt-5.4 through codex responses with OpenClaw-style headers', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'hello from codex',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-codex',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hello from codex',
          },
        },
      ],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer codex-secret',
      'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
      Accept: 'application/json',
    });

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      stream: false,
    });
    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    ]);

    await app.close();
  });

  test('routes codex/gpt-5.4 through the codex provider instead of falling back upstream', async () => {
    const dir = writeRouterConfig({
      upstream: {
        baseUrl: 'https://fallback.example.test/v1',
      },
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['codex/gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-prefixed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'prefixed ok',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'codex/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer codex-secret',
    });

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      stream: false,
    });

    await app.close();
  });

  test('uses config/model-mappings.json for provider routing when router.json omits routes', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
    }, {
      routes: [
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4', 'gpt-5.4', 'codex/gpt-5.4'],
          model: 'gpt-5.4',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-mapping-file',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'hello from mapping file',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-codex-mapping-file',
      choices: [
        {
          message: {
            content: 'hello from mapping file',
          },
        },
      ],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    expect(JSON.parse(String(init.body)).model).toBe('gpt-5.4');

    await app.close();
  });

  test('routes explicit route aliases through the configured provider without legacy models.allow', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      routes: [
        {
          id: 'explicit-codex-main',
          provider: 'codex',
          aliases: ['writer/gpt54'],
          model: 'gpt-5.4',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-explicit-route',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'explicit route ok',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'writer/gpt54',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer codex-secret',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      stream: false,
    });

    await app.close();
  });

  test('adapts codex responses output into chat-completions SSE for streaming requests', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-stream',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'streamed from codex',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
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
    expect(response.body).toContain('resp-codex-stream');
    expect(response.body).toContain('streamed from codex');
    expect(response.body).toContain('[DONE]');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);

    await app.close();
  });

  test('returns a structured terminal error for a non-JSON upstream 401 without unhandled rejection', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const fetchSpy = vi.fn(async () => {
      return new Response('not-json', {
        status: 401,
        headers: {
          'content-type': 'text/plain',
        },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const app = buildApp({
        routerConfig: loadRouterRuntimeConfig(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: {
          type: 'upstream_terminal_error',
          message: 'Upstream returned a non-retryable error.',
          request_id: expect.any(String),
          attempts: 1,
          final_error_class: 'http_401',
          upstream_status: 401,
          upstream_error: {
            body_snippet: 'not-json',
          },
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);

      await app.close();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('returns a structured terminal error on /v1/responses 401', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            type: 'invalid_api_key',
            code: 'invalid_api_key',
            message: 'Bad credentials',
          },
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
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
        message: 'Upstream 401: Bad credentials',
        request_id: expect.any(String),
        attempts: 1,
        final_error_class: 'http_401',
        upstream_status: 401,
        upstream_error: {
          type: 'invalid_api_key',
          code: 'invalid_api_key',
          message: 'Bad credentials',
        },
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  test('encodes assistant history as output_text for codex responses input', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-history',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '成功',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        messages: [
          { role: 'assistant', content: "I'm back,少东家. 又见面了，这次想聊点啥？" },
          { role: 'user', content: '这是一个连通性测试，如果收到，回复成功' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: "I'm back,少东家. 又见面了，这次想聊点啥？" }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '这是一个连通性测试，如果收到，回复成功' }],
      },
    ]);

    await app.close();
  });

  test('preserves assistant text alongside tool_calls in responses input history', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-mixed-tool-history',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '成功',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'assistant',
            content: '先解释一下，然后调用工具',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'lookup_weather',
                  arguments: '{"city":"Shanghai"}',
                },
              },
            ],
          },
          { role: 'user', content: '继续' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '先解释一下，然后调用工具' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup_weather',
        arguments: '{"city":"Shanghai"}',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续' }],
      },
    ]);

    await app.close();
  });

  test('rewrites low thinking to reasoning.effort low for gpt-5.4 without forcing xhigh', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
      thinking: {
        defaultMode: 'pass-through',
        mappingsEnabled: false,
        mappings: [
          {
            match: ['LR/gpt-5.4', 'gpt-5.4'],
            when: { thinking: 'low' },
            rewrite: { reasoning: { effort: 'xhigh' } },
          },
        ],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-thinking-map',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'mapped',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        thinking: 'low',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      reasoning: {
        effort: 'low',
      },
    });
    expect(body.thinking).toBeUndefined();

    await app.close();
  });

  test('rewrites OpenClaw reasoning_effort low to reasoning.effort xhigh for gpt-5.4 via configured mapping', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    }, {
      thinking: {
        defaultMode: 'pass-through',
        mappings: [
          {
            match: ['LR/gpt-5.4', 'gpt-5.4'],
            when: { thinking: 'low' },
            rewrite: { reasoning: { effort: 'xhigh' } },
          },
        ],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-reasoning-effort-map',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'mapped',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      reasoning: {
        effort: 'xhigh',
      },
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();

    await app.close();
  });

  test('normalizes chat-completions tools into responses tools for codex upstream', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-tools-pass',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'ok',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const tools = [
      {
        type: 'function',
        function: {
          name: 'implement_json_alignment',
          description: 'Align InkOS JSON output',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
            },
            required: ['mode'],
          },
        },
      },
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: '实施对齐inkos json' }],
        tools,
        tool_choice: 'auto',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'implement_json_alignment',
        description: 'Align InkOS JSON output',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
          },
          required: ['mode'],
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');

    await app.close();
  });

  test('adapts codex function_call output into chat-completions tool_calls', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-tool-call',
          output: [
            {
              type: 'function_call',
              id: 'fc_123',
              call_id: 'call_123',
              name: 'implement_json_alignment',
              arguments: '{"mode":"apply"}',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }));

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: '实施' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-codex-tool-call',
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'implement_json_alignment',
                  arguments: '{"mode":"apply"}',
                },
              },
            ],
          },
        },
      ],
    });

    await app.close();
  });

  test('streams codex function_call output into chat-completions SSE tool_calls', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    vi.stubGlobal('fetch', vi.fn(async () => {
      const sse = [
        'data: {"type":"response.created","response":{"id":"resp-codex-tool-call-stream"}}',
        'data: {"type":"response.output_item.added","item":{"id":"fc_456","type":"function_call","status":"in_progress","arguments":"","call_id":"call_456","name":"implement_json_alignment"},"output_index":0}',
        'data: {"type":"response.function_call_arguments.done","arguments":"{\\"mode\\":\\"apply\\"}","item_id":"fc_456","output_index":0}',
        'data: {"type":"response.completed","response":{"id":"resp-codex-tool-call-stream"}}',
        'data: [DONE]',
      ].join('\n\n');
      return new Response(
        `${sse}\n\n`,
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
          },
        },
      );
    }));

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: '实施' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('resp-codex-tool-call-stream');
    expect(response.body).toContain('tool_calls');
    expect(response.body).toContain('call_456');
    expect(response.body).toContain('implement_json_alignment');
    expect(response.body).not.toContain('fc_456');
    expect(response.body).toContain('[DONE]');

    await app.close();
  });

  test('maps tool result history to function_call_output for codex responses input', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-tool-output',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'done',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'implement_json_alignment',
                  arguments: '{"mode":"apply"}',
                },
              },
            ],
            content: '',
          },
          {
            role: 'tool',
            tool_call_id: 'call_123',
            content: '{"status":"ok"}',
          },
          {
            role: 'user',
            content: '继续',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'implement_json_alignment',
        arguments: '{"mode":"apply"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: '{"status":"ok"}',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续' }],
      },
    ]);

    await app.close();
  });

  test('maps bare tool history to function_call_output even without explicit tool_call_id', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          headers: {
            'User-Agent': 'Mozilla/5.0 OpenClaw/Test',
            Accept: 'application/json',
          },
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-codex-tool-history',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '成功',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        stream: true,
        messages: [
          { role: 'tool', content: 'tool output here' },
          { role: 'user', content: 'hi' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      {
        type: 'function_call_output',
        call_id: '',
        output: 'tool output here',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    ]);

    await app.close();
  });

  test('proxies /v1/responses requests to codex upstream with model normalization', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'Q-router-provider-summary-'));
    const sqlitePath = join(traceDir, 'summaries.sqlite');
    const jsonlPath = join(traceDir, 'events.jsonl');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['LR/gpt-5.4', 'gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-passthrough',
          object: 'response',
          output: [],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      traceStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'LR/gpt-5.4',
        input: 'hi',
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-passthrough',
      object: 'response',
      metadata: {
        qrouter: {
          endpoint: 'responses',
          request_id: expect.any(String),
          final_classification: 'semantic_success',
          attempts: 1,
          retries_used: 0,
          requested_model: 'LR/gpt-5.4',
          upstream_model: 'gpt-5.4',
          provider_id: 'codex',
          route_id: 'codex:gpt-5.4',
          failover_used: false,
        },
      },
    });
    expect(response.headers['x-qrouter-request-id']).toBeTruthy();
    expect(response.headers['x-qrouter-endpoint']).toBe('responses');
    expect(response.headers['x-qrouter-final-classification']).toBe('semantic_success');
    expect(response.headers['x-qrouter-requested-model']).toBe('LR/gpt-5.4');
    expect(response.headers['x-qrouter-upstream-model']).toBe('gpt-5.4');
    expect(response.headers['x-qrouter-provider-id']).toBe('codex');
    expect(response.headers['x-qrouter-route-id']).toBe('codex:gpt-5.4');
    expect(response.headers['x-qrouter-retries-used']).toBe('0');
    expect(response.headers['x-qrouter-failover-used']).toBe('false');

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      input: 'hi',
      stream: false,
    });

    await app.close();

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare(`
        SELECT
          endpoint,
          final_classification,
          requested_model,
          upstream_model,
          provider_id,
          route_id,
          failover_used
        FROM request_summaries
      `)
      .all() as Array<{
      endpoint: string;
      final_classification: string;
      requested_model: string;
      upstream_model: string;
      provider_id: string;
      route_id: string;
      failover_used: number;
    }>;
    db.close();

    expect(rows).toEqual([
      {
        endpoint: 'responses',
        final_classification: 'semantic_success',
        requested_model: 'LR/gpt-5.4',
        upstream_model: 'gpt-5.4',
        provider_id: 'codex',
        route_id: 'codex:gpt-5.4',
        failover_used: 0,
      },
    ]);
  });

  test('accepts bare model ids on /v1/responses when only the LR-prefixed allow entry exists', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['LR/gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-passthrough-bare',
          object: 'response',
          output: [],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hi',
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      input: 'hi',
      stream: false,
    });

    await app.close();
  });

  test('uses sticky-failover routes on /v1/responses within the same request after the active member exhausts its retries', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
            {
              id: 'gpt-5.4-mini',
              name: 'GPT-5.4 Mini',
            },
          ],
        },
      },
      routes: [
        {
          id: 'codex-failover',
          provider: 'codex',
          aliases: ['LR/codex-failover'],
          strategy: 'sticky-failover',
          members: ['gpt-5.4', 'gpt-5.4-mini'],
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'gpt-5.4') {
        return new Response(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'primary backend unavailable',
            },
          }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-codex-failover',
          object: 'response',
          model: 'gpt-5.4-mini',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'recovered via secondary responses model',
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
    });

    const recoveredResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'LR/codex-failover',
        input: 'hi',
      },
    });

    expect(recoveredResponse.statusCode).toBe(200);
    expect(recoveredResponse.json()).toMatchObject({
      id: 'resp-codex-failover',
      object: 'response',
      metadata: {
        qrouter: {
          requested_model: 'LR/codex-failover',
          upstream_model: 'gpt-5.4-mini',
          provider_id: 'codex',
          route_id: 'codex-failover',
          failover_used: true,
          failover_from: 'gpt-5.4',
          failover_to: 'gpt-5.4-mini',
        },
      },
      output: [
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'recovered via secondary responses model',
            },
          ],
        },
      ],
    });
    expect(recoveredResponse.headers['x-qrouter-route-id']).toBe('codex-failover');
    expect(recoveredResponse.headers['x-qrouter-upstream-model']).toBe('gpt-5.4-mini');
    expect(recoveredResponse.headers['x-qrouter-failover-used']).toBe('true');
    expect(recoveredResponse.headers['x-qrouter-failover-from']).toBe('gpt-5.4');
    expect(recoveredResponse.headers['x-qrouter-failover-to']).toBe('gpt-5.4-mini');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);

    await app.close();
  });


  test('adapts raw responses SSE into chat-completions chunks for streaming requests', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const encoder = new TextEncoder();
    const fetchSpy = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: response.created\n`));
            controller.enqueue(encoder.encode(`:\n`));
            controller.enqueue(encoder.encode(`data: {"type":"response.created","response":{"id":"resp-chat-stream"}}\n\n`));
            controller.enqueue(encoder.encode(`event: response.output_text.delta\n`));
            controller.enqueue(encoder.encode(`data: {"type":"response.output_text.delta","delta":"hello ","item_id":"msg_1"}\n\n`));
            controller.enqueue(encoder.encode(`data: {"type":"response.output_text.delta","delta":"world","item_id":"msg_1"}\n\n`));
            controller.enqueue(encoder.encode(`event: response.completed\n`));
            controller.enqueue(encoder.encode(`data: {"type":"response.completed","response":{"id":"resp-chat-stream"}}\n\n`));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
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
    expect(response.body).toContain('chat.completion.chunk');
    expect(response.body).toContain('resp-chat-stream');
    expect(response.body).toContain('hello ');
    expect(response.body).toContain('world');
    expect(response.body).toContain('[DONE]');
    expect(response.body).not.toContain('event: response.created');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);

    await app.close();
  });

  test('sanitizes responses SSE so downstream only sees data frames', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['LR/gpt-5.4', 'gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const encoder = new TextEncoder();
    const fetchSpy = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: response.created\n'));
            controller.enqueue(encoder.encode(':\n'));
            controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_passthrough"}}\n\n'));
            controller.enqueue(encoder.encode('event: response.output_text.delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
            controller.enqueue(encoder.encode('event: response.completed\n'));
            controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_passthrough"}}\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'LR/gpt-5.4',
        input: 'hi',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-qrouter-endpoint']).toBe('responses');
    expect(response.headers['x-qrouter-final-classification']).toBe('semantic_success');
    expect(response.headers['x-qrouter-requested-model']).toBe('LR/gpt-5.4');
    expect(response.headers['x-qrouter-upstream-model']).toBe('gpt-5.4');
    expect(response.body).toContain('data: {"type":"response.created"');
    expect(response.body).toContain('data: {"type":"response.output_text.delta"');
    expect(response.body).toContain('data: {"type":"response.completed"');
    expect(response.body).toContain('"metadata":{"qrouter":{');
    expect(response.body).toContain('"endpoint":"responses"');
    expect(response.body).toContain('"requested_model":"LR/gpt-5.4"');
    expect(response.body).toContain('"upstream_model":"gpt-5.4"');
    expect(response.body).toContain('"provider_id":"codex"');
    expect(response.body).toContain('"route_id":"codex:gpt-5.4"');
    expect(response.body).not.toContain('event: response.created');
    expect(response.body).not.toContain('\n:\n');

    await app.close();
  });

  test('uses x-api-key when auth is api-key and authHeader is false', async () => {
    const dir = writeRouterConfig({
      providers: {
        custom: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: false,
          baseUrl: 'https://custom.example.test/v1',
          models: [
            {
              id: 'demo-model',
              name: 'Demo Model',
            },
          ],
        },
      },
      models: {
        allow: ['custom/demo-model'],
      },
    });

    chdir(dir);
    process.env.Q_CUSTOM_API_KEY = 'custom-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-custom-auth',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom/demo-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'x-api-key': 'custom-secret',
    });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();

    await app.close();
  });

  test('pins repeated LR/ms requests to the same modelscope backend until failover', async () => {
    const dir = writeRouterConfig({
      providers: {
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
      models: {
        allow: ['LR/ms'],
      },
    });

    chdir(dir);
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-modelscope-sticky',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    for (let index = 0; index < modelScopePool.length; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'LR/ms',
          messages: [{ role: 'user', content: `hi ${index}` }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(modelScopePool.length);
    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual(Array(modelScopePool.length).fill(modelScopePool[0]));

    const [firstUrl, firstInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstUrl).toBe('https://modelscope.example.test/v1/chat/completions');
    expect(firstInit.headers).toMatchObject({
      authorization: 'Bearer ms-secret',
    });

    await app.close();
  });

  test('accepts bare ms by canonicalizing it to LR/ms before routing', async () => {
    const dir = writeRouterConfig({
      providers: {
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
      models: {
        allow: ['LR/ms'],
      },
    });

    chdir(dir);
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-modelscope-bare-ms',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'ms',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://modelscope.example.test/v1/chat/completions');
    expect(JSON.parse(String(init.body)).model).toBe(modelScopePool[0]);

    await app.close();
  });

  test('retries LR/ms on the same backend before switching to the next sticky candidate within the same request', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'Q-router-failover-summary-'));
    const sqlitePath = join(traceDir, 'summaries.sqlite');
    const jsonlPath = join(traceDir, 'events.jsonl');
    const traceStore = createTraceStore({ jsonlPath, sqlitePath });
    const dir = writeRouterConfig({
      providers: {
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
      models: {
        allow: ['LR/ms'],
      },
    });

    chdir(dir);
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestModel = JSON.parse(String(init?.body ?? '{}')).model as string;
      if (requestModel === modelScopePool[0]) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
            },
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-modelscope-recovered',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'recovered via next modelscope backend',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      traceStore,
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: () => 0,
      },
    });

    const recoveredResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/ms',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(recoveredResponse.statusCode).toBe(200);
    expect(recoveredResponse.json()).toMatchObject({
      id: 'resp-modelscope-recovered',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('recovered via next modelscope backend'),
          },
        },
      ],
    });
    expect(recoveredResponse.body).toContain('[Q-router 提示]');
    expect(recoveredResponse.body).toContain(`候选模型：${modelScopePool[1]}`);
    expect(recoveredResponse.headers['x-qrouter-request-id']).toBeTruthy();
    expect(recoveredResponse.headers['x-qrouter-endpoint']).toBe('chat.completions');
    expect(recoveredResponse.headers['x-qrouter-final-classification']).toBe('semantic_success');
    expect(recoveredResponse.headers['x-qrouter-requested-model']).toBe('LR/ms');
    expect(recoveredResponse.headers['x-qrouter-upstream-model']).toBe(modelScopePool[1]);
    expect(recoveredResponse.headers['x-qrouter-provider-id']).toBe('modelscope');
    expect(recoveredResponse.headers['x-qrouter-route-id']).toBe('legacy:modelscope:ms');
    expect(recoveredResponse.headers['x-qrouter-retries-used']).toBe('3');
    expect(recoveredResponse.headers['x-qrouter-failover-used']).toBe('true');
    expect(recoveredResponse.headers['x-qrouter-failover-from']).toBe(modelScopePool[0]);
    expect(recoveredResponse.headers['x-qrouter-failover-to']).toBe(modelScopePool[1]);

    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels.slice(0, 3)).toEqual([
      modelScopePool[0],
      modelScopePool[0],
      modelScopePool[0],
    ]);
    expect(routedModels[3]).toBe(modelScopePool[1]);

    const statsResponse = await app.inject({
      method: 'GET',
      url: '/stats/requests?provider_id=modelscope&route_id=legacy:modelscope:ms&failover_used=1&limit=5',
    });

    expect(statsResponse.statusCode).toBe(200);
    expect(statsResponse.json()).toMatchObject({
      items: [
        {
          endpoint: 'chat.completions',
          finalClassification: 'semantic_success',
          requestedModel: 'LR/ms',
          upstreamModel: modelScopePool[1],
          providerId: 'modelscope',
          routeId: 'legacy:modelscope:ms',
          failoverUsed: true,
          failoverFrom: modelScopePool[0],
          failoverTo: modelScopePool[1],
        },
      ],
    });

    const noFailoverStatsResponse = await app.inject({
      method: 'GET',
      url: '/stats/requests?provider_id=modelscope&route_id=legacy:modelscope:ms&failover_used=0&limit=5',
    });

    expect(noFailoverStatsResponse.statusCode).toBe(200);
    expect(noFailoverStatsResponse.json()).toMatchObject({ items: [] });

    const aggregateStatsResponse = await app.inject({
      method: 'GET',
      url: '/stats/requests/aggregate?provider_id=modelscope&route_id=legacy:modelscope:ms&limit=5',
    });

    expect(aggregateStatsResponse.statusCode).toBe(200);
    expect(aggregateStatsResponse.json()).toMatchObject({
      items: [
        {
          endpoint: 'chat.completions',
          providerId: 'modelscope',
          routeId: 'legacy:modelscope:ms',
          failoverUsed: true,
          finalClassification: 'semantic_success',
          requestCount: 1,
        },
      ],
    });

    const routeHealthResponse = await app.inject({
      method: 'GET',
      url: '/stats/routes/health?provider_id=modelscope&route_id=legacy:modelscope:ms&limit=5',
    });

    expect(routeHealthResponse.statusCode).toBe(200);
    expect(routeHealthResponse.json()).toMatchObject({
      items: [
        {
          endpoint: 'chat.completions',
          providerId: 'modelscope',
          routeId: 'legacy:modelscope:ms',
          totalRequests: 1,
          successRequests: 1,
          failedRequests: 0,
          failoverRequests: 1,
          failureRate: 0,
          failoverHitRate: 1,
          latestErrorClassification: null,
          status: 'degraded',
          latestRequestAt: expect.any(String),
          latestSuccessAt: expect.any(String),
          latestFailureAt: null,
        },
      ],
    });

    await app.close();

    const db = new DatabaseSync(sqlitePath);
    const rows = db
      .prepare(`
        SELECT
          endpoint,
          final_classification,
          requested_model,
          upstream_model,
          provider_id,
          route_id,
          failover_used,
          failover_from,
          failover_to
        FROM request_summaries
        WHERE final_classification = 'semantic_success'
        ORDER BY created_at ASC
      `)
      .all() as Array<{
      endpoint: string;
      final_classification: string;
      requested_model: string;
      upstream_model: string;
      provider_id: string;
      route_id: string;
      failover_used: number;
      failover_from: string | null;
      failover_to: string | null;
    }>;
    db.close();

    expect(rows).toEqual([
      {
        endpoint: 'chat.completions',
        final_classification: 'semantic_success',
        requested_model: 'LR/ms',
        upstream_model: modelScopePool[1],
        provider_id: 'modelscope',
        route_id: 'legacy:modelscope:ms',
        failover_used: 1,
        failover_from: modelScopePool[0],
        failover_to: modelScopePool[1],
      },
    ]);
  });

  test('switches LR/gpt-5.4 to LR/ms after three retryable failures and appends the actual model notice', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
    }, {
      routes: [
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4', 'gpt-5.4', 'codex/gpt-5.4'],
          fallbacks: ['LR/ms'],
          model: 'gpt-5.4',
        },
        {
          id: 'modelscope-ms-pool',
          provider: 'modelscope',
          strategy: 'sticky-failover',
          aliases: ['LR/ms', 'ms'],
          members: [...modelScopePool],
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };

      if (url.endsWith('/responses')) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'primary backend unavailable',
            },
          }),
          {
            status: 504,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-modelscope-fallback',
          choices: [
            {
              message: {
                role: 'assistant',
                content: `recovered via ${body.model}`,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-modelscope-fallback',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining(`recovered via ${modelScopePool[0]}`),
          },
        },
      ],
    });
    expect(response.body).toContain('[Q-router 提示]');
    expect(response.body).toContain(`候选模型：${modelScopePool[0]}`);
    expect(response.headers['x-qrouter-route-id']).toBe('modelscope-ms-pool');
    expect(response.headers['x-qrouter-upstream-model']).toBe(modelScopePool[0]);
    expect(response.headers['x-qrouter-failover-used']).toBe('true');
    expect(response.headers['x-qrouter-failover-from']).toBe('gpt-5.4');
    expect(response.headers['x-qrouter-failover-to']).toBe(modelScopePool[0]);

    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4',
      modelScopePool[0],
    ]);

    await app.close();
  });

  test('honors request-level no-fallback and keeps retrying only the originally requested model', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
        openrouter: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://openrouter.example.test/v1',
          models: [
            {
              id: 'stepfun/step-3.5-flash:free',
              name: 'step3fresh',
            },
          ],
        },
      },
    }, {
      routes: [
        {
          id: 'openrouter-stepfun',
          provider: 'openrouter',
          aliases: ['LR/stepfun/step-3.5-flash:free'],
          model: 'stepfun/step-3.5-flash:free',
        },
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4'],
          fallbacks: ['LR/stepfun/step-3.5-flash:free'],
          model: 'gpt-5.4',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';
    process.env.Q_OPENROUTER_API_KEY = 'openrouter-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            type: 'server_error',
            message: 'primary backend unavailable',
          },
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-qrouter-no-fallback': 'true',
      },
      payload: {
        model: 'LR/gpt-5.4',
        qrouter: {
          noFallback: true,
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('请稍后重试');
    expect(response.headers['x-qrouter-failover-used']).toBe('false');

    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual(['gpt-5.4', 'gpt-5.4']);

    const routedBodies = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)) as Record<string, unknown>;
    });
    expect(routedBodies.every((body) => body.qrouter === undefined)).toBe(true);

    await app.close();
  });

  test('prefers stepfun as the first fallback alias for LR/gpt-5.4 after three retryable failures', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
        openrouter: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://openrouter.example.test/v1',
          models: [
            {
              id: 'stepfun/step-3.5-flash:free',
              name: 'step3fresh',
            },
          ],
        },
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
    }, {
      routes: [
        {
          id: 'openrouter-stepfun',
          provider: 'openrouter',
          aliases: [
            'LR/stepfun/step-3.5-flash:free',
            'stepfun/step-3.5-flash:free',
            'openrouter/stepfun/step-3.5-flash:free',
          ],
          model: 'stepfun/step-3.5-flash:free',
        },
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4', 'gpt-5.4', 'codex/gpt-5.4'],
          fallbacks: ['LR/stepfun/step-3.5-flash:free', 'LR/ms'],
          model: 'gpt-5.4',
        },
        {
          id: 'modelscope-ms-pool',
          provider: 'modelscope',
          strategy: 'sticky-failover',
          aliases: ['LR/ms', 'ms'],
          members: [...modelScopePool],
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';
    process.env.Q_OPENROUTER_API_KEY = 'openrouter-secret';
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };

      if (url.endsWith('/responses')) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'primary backend unavailable',
            },
          }),
          {
            status: 504,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-stepfun-fallback',
          choices: [
            {
              message: {
                role: 'assistant',
                content: `recovered via ${body.model}`,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-stepfun-fallback',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('recovered via stepfun/step-3.5-flash:free'),
          },
        },
      ],
    });
    expect(response.body).toContain('[Q-router 提示]');
    expect(response.body).toContain('候选模型：stepfun/step-3.5-flash:free');
    expect(response.headers['x-qrouter-route-id']).toBe('openrouter-stepfun');
    expect(response.headers['x-qrouter-upstream-model']).toBe('stepfun/step-3.5-flash:free');
    expect(response.headers['x-qrouter-failover-used']).toBe('true');
    expect(response.headers['x-qrouter-failover-from']).toBe('gpt-5.4');
    expect(response.headers['x-qrouter-failover-to']).toBe('stepfun/step-3.5-flash:free');

    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4',
      'stepfun/step-3.5-flash:free',
    ]);

    const routedUrls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(routedUrls).toEqual([
      'https://codex.example.test/v1/responses',
      'https://codex.example.test/v1/responses',
      'https://codex.example.test/v1/responses',
      'https://codex.example.test/v1/responses',
      'https://openrouter.example.test/v1/chat/completions',
    ]);

    await app.close();
  });

  test('automatically fails back sticky routes to the primary member after the configured cooldown', async () => {
    let now = Date.parse('2026-03-31T00:00:00Z');
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const dir = writeRouterConfig({
        providers: {
          codex: {
            api: 'openai-responses',
            auth: 'api-key',
            authHeader: true,
            baseUrl: 'https://codex.example.test/v1',
            models: [
              { id: 'gpt-5.4', name: 'GPT-5.4' },
              { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
            ],
          },
        },
        routes: [
          {
            id: 'codex-failover',
            provider: 'codex',
            aliases: ['LR/codex-failover'],
            strategy: 'sticky-failover',
            members: ['gpt-5.4', 'gpt-5.4-mini'],
            failbackAfterMs: 1000,
          },
        ],
      });

      chdir(dir);
      process.env.Q_CODEX_API_KEY = 'codex-secret';

      let primaryShouldFail = true;
      const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };

        if (body.model === 'gpt-5.4' && primaryShouldFail) {
          return new Response(
            JSON.stringify({
              error: {
                type: 'server_error',
                message: 'primary backend unavailable',
              },
            }),
            {
              status: 503,
              headers: {
                'content-type': 'application/json',
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            id: `resp-${body.model}`,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: `served by ${body.model}`,
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      });
      vi.stubGlobal('fetch', fetchSpy);

      const app = buildApp({
        routerConfig: loadRouterRuntimeConfig(),
        retryPolicy: {
          maxAttempts: 1,
          backoffMs: () => 0,
        },
      });

      const failoverResponse = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'LR/codex-failover',
          input: 'first request',
        },
      });

      expect(failoverResponse.statusCode).toBe(200);
      expect(failoverResponse.body).toContain('served by gpt-5.4-mini');

      now = Date.parse('2026-03-31T00:00:00.500Z');
      primaryShouldFail = false;

      const stillSecondaryResponse = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'LR/codex-failover',
          input: 'second request',
        },
      });

      expect(stillSecondaryResponse.statusCode).toBe(200);
      expect(stillSecondaryResponse.body).toContain('served by gpt-5.4-mini');

      now = Date.parse('2026-03-31T00:00:01.500Z');

      const failbackResponse = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'LR/codex-failover',
          input: 'third request',
        },
      });

      expect(failbackResponse.statusCode).toBe(200);
      expect(failbackResponse.body).toContain('served by gpt-5.4');

      const routedModels = fetchSpy.mock.calls.map((call) => {
        const [, init] = call as unknown as [string, RequestInit];
        return JSON.parse(String(init.body)).model as string;
      });
      expect(routedModels).toEqual([
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.4-mini',
        'gpt-5.4',
      ]);

      await app.close();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test('automatically includes newly added routes in the default fallback chain', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
        openrouter: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://openrouter.example.test/v1',
          models: [
            {
              id: 'stepfun/step-3.5-flash:free',
              name: 'step3fresh',
            },
          ],
        },
      },
    }, {
      routes: [
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['writer/main'],
          model: 'gpt-5.4',
        },
        {
          id: 'openrouter-stepfun',
          provider: 'openrouter',
          aliases: ['LR/stepfun/step-3.5-flash:free', 'stepfun/step-3.5-flash:free'],
          model: 'stepfun/step-3.5-flash:free',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';
    process.env.Q_OPENROUTER_API_KEY = 'openrouter-secret';

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };

      if (url.endsWith('/responses')) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'primary backend unavailable',
            },
          }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp-auto-fallback',
          choices: [
            {
              message: {
                role: 'assistant',
                content: `recovered via ${body.model}`,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'writer/main',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'resp-auto-fallback',
      choices: [
        {
          message: {
            role: 'assistant',
            content: expect.stringContaining('recovered via stepfun/step-3.5-flash:free'),
          },
        },
      ],
    });
    expect(response.headers['x-qrouter-route-id']).toBe('openrouter-stepfun');
    expect(response.headers['x-qrouter-upstream-model']).toBe('stepfun/step-3.5-flash:free');
    expect(response.headers['x-qrouter-failover-used']).toBe('true');

    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'stepfun/step-3.5-flash:free',
    ]);

    await app.close();
  });

  test('appends a failover notice to streaming replies when sticky-failover advances to a candidate model within the same request', async () => {
    const dir = writeRouterConfig({
      providers: {
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
      models: {
        allow: ['LR/ms'],
      },
    });

    chdir(dir);
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const encoder = new TextEncoder();
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === modelScopePool[0]) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
            },
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: 'resp-modelscope-stream',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: 'stream recovered via next modelscope backend',
                  },
                },
              ],
            })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: 'resp-modelscope-stream',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
            })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: () => 0,
      },
    });

    const streamedResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/ms',
        stream: true,
        messages: [{ role: 'user', content: 'now use candidate' }],
      },
    });

    expect(streamedResponse.statusCode).toBe(200);
    expect(streamedResponse.headers['content-type']).toContain('text/event-stream');
    expect(streamedResponse.body).toContain('stream recovered via next modelscope backend');
    expect(streamedResponse.body).toContain('[Q-router 提示]');
    expect(streamedResponse.body).toContain(`候选模型：${modelScopePool[1]}`);
    expect(streamedResponse.body).toContain('[DONE]');

    await app.close();
  });

  test('routes explicit round-robin aliases without relying on hardcoded allow-list wiring', async () => {
    const dir = writeRouterConfig({
      providers: {
        modelscope: {
          api: 'openai-completions',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://modelscope.example.test/v1',
          models: modelScopePool.map((id) => ({
            id,
            name: id,
          })),
        },
      },
      routes: [
        {
          id: 'explicit-ms-pool',
          provider: 'modelscope',
          strategy: 'round-robin',
          aliases: ['LR/ms', 'ms'],
          members: [...modelScopePool],
        },
      ],
    });

    chdir(dir);
    process.env.Q_MODELSCOPE_API_KEY = 'ms-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'resp-explicit-ms-route',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'ms',
          messages: [{ role: 'user', content: `hi ${index}` }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const routedModels = fetchSpy.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit];
      return JSON.parse(String(init.body)).model as string;
    });
    expect(routedModels).toEqual([modelScopePool[0], modelScopePool[1]]);

    await app.close();
  });

  test('rejects oversized chat completions requests locally before upstream fetch', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              contextWindow: 10,
            },
          ],
        },
      },
      routes: [
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4', 'gpt-5.4'],
          model: 'gpt-5.4',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/gpt-5.4',
        messages: [{ role: 'user', content: 'x'.repeat(200) }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: 'context_window_exceeded',
        model: 'LR/gpt-5.4',
        normalized_model: 'gpt-5.4',
        context_window: 10,
        provider_id: 'codex',
        route_id: 'codex-main',
      },
    });
    expect((response.json() as { error: { estimated_input_tokens: number } }).error.estimated_input_tokens).toBeGreaterThan(10);
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  test('returns a visible reply on /v1/responses 429 after retries', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
            },
          ],
        },
      },
      models: {
        allow: ['LR/gpt-5.4', 'gpt-5.4'],
      },
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            code: 'USAGE_LIMIT_EXCEEDED',
            message: 'daily usage limit exceeded',
          },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'LR/gpt-5.4',
        input: 'hi',
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: expect.stringContaining('当前没有可连通模型'),
            },
          ],
        },
      ],
    });
    expect(response.body).toContain('上游模型当前限流或额度已耗尽：daily usage limit exceeded');

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await app.close();
  });

  test('rejects oversized responses requests locally before upstream fetch', async () => {
    const dir = writeRouterConfig({
      providers: {
        codex: {
          api: 'openai-responses',
          auth: 'api-key',
          authHeader: true,
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              contextWindow: 10,
            },
          ],
        },
      },
      routes: [
        {
          id: 'codex-main',
          provider: 'codex',
          aliases: ['LR/gpt-5.4', 'gpt-5.4'],
          model: 'gpt-5.4',
        },
      ],
    });

    chdir(dir);
    process.env.Q_CODEX_API_KEY = 'codex-secret';

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'LR/gpt-5.4',
        input: 'x'.repeat(200),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: 'context_window_exceeded',
        model: 'LR/gpt-5.4',
        normalized_model: 'gpt-5.4',
        context_window: 10,
        provider_id: 'codex',
        route_id: 'codex-main',
      },
    });
    expect((response.json() as { error: { estimated_input_tokens: number } }).error.estimated_input_tokens).toBeGreaterThan(10);
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });
});
