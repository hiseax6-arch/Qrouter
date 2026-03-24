import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadRouterRuntimeConfig } from '../config/router.js';
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
  'Q_OPENROUTER_API_KEY',
];
const originalFetch = globalThis.fetch;

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
    expect(body.stream).toBe(false);

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

  test('normalizes tool history into a user message for codex responses input', async () => {
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
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'tool output here' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    ]);

    await app.close();
  });
});
