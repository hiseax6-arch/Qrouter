import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadRouterRuntimeConfig } from '../config/router.js';
import { resetRoutingState } from '../routing/routes.js';
import { buildApp } from '../server.js';

const originalCwd = cwd();
const envKeys = [
  'Q_ROUTER_CONFIG_PATH',
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

function writeRouterConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'Q-router-provider-'));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'router.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
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

  test('does not eagerly parse a non-JSON terminal error body from responses upstream', async () => {
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
      expect(response.json()).toEqual({
        error: {
          message: 'Upstream returned a non-retryable error.',
          type: 'upstream_terminal_error',
          request_id: expect.any(String),
          attempts: 1,
          final_error_class: 'http_401',
          upstream_status: 401,
          upstream_error: {
            body_snippet: 'not-json',
          },
        },
      });
      expect(unhandled).toEqual([]);

      await app.close();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
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
    });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://codex.example.test/v1/responses');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      input: 'hi',
      stream: false,
    });

    await app.close();
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
    expect(response.body).toContain('data: {"type":"response.created"');
    expect(response.body).toContain('data: {"type":"response.output_text.delta"');
    expect(response.body).toContain('data: {"type":"response.completed"');
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

  test('retries LR/ms on the same backend before switching the sticky active model', async () => {
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
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: () => 0,
      },
    });

    const failedResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/ms',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(failedResponse.statusCode).toBe(502);

    const recoveredResponse = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'LR/ms',
        messages: [{ role: 'user', content: 'try next backend' }],
      },
    });

    expect(recoveredResponse.statusCode).toBe(200);
    expect(recoveredResponse.json()).toMatchObject({
      id: 'resp-modelscope-recovered',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'recovered via next modelscope backend',
          },
        },
      ],
    });

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
});
