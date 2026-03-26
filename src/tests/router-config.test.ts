import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, describe, expect, test } from 'vitest';
import { buildApp } from '../server.js';
import { loadRouterRuntimeConfig } from '../config/router.js';

const originalCwd = cwd();
const envKeys = [
  'Q_ROUTER_CONFIG_PATH',
  'Q_ROUTER_PORT',
  'Q_ROUTER_HOST',
  'Q_UPSTREAM_BASE_URL',
  'Q_UPSTREAM_API_KEY',
  'Q_UPSTREAM_TIMEOUT_MS',
];

afterEach(() => {
  chdir(originalCwd);
  for (const key of envKeys) {
    delete process.env[key];
  }
});

function writeRouterConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'Q-router-config-'));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'router.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return dir;
}

describe('router config file', () => {
  test('loads config/router.json and applies env overrides', () => {
    const dir = writeRouterConfig({
      server: {
        host: '127.0.0.1',
        port: 4318,
      },
      upstream: {
        baseUrl: 'https://example.test/v1',
        timeoutMs: 12345,
      },
      providers: {
        openrouter: {
          api: 'openai-completions',
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [
            {
              id: 'stepfun/step-3.5-flash:free',
              name: 'step3fresh',
              contextWindow: 128000,
              maxTokens: 32000,
            },
          ],
        },
        codex: {
          api: 'openai-responses',
          baseUrl: 'https://codex.example.test/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              reasoning: true,
              input: ['text', 'image'],
              cost: {
                input: 1.75,
                output: 14,
                cacheRead: 0.175,
                cacheWrite: 0.175,
              },
              contextWindow: 270000,
              maxTokens: 128000,
            },
          ],
        },
      },
      models: {
        allow: ['stepfun/step-3.5-flash:free', 'gpt-5.4'],
      },
      thinking: {
        defaultMode: 'pass-through',
        mappingsEnabled: true,
        mappings: [
          {
            match: ['LR/gpt-5.4', 'gpt-5.4'],
            when: { thinking: 'low' },
            rewrite: { thinking: 'xhigh' },
          },
        ],
      },
    });

    chdir(dir);
    process.env.Q_UPSTREAM_API_KEY = 'env-secret';
    process.env.Q_ROUTER_PORT = '9999';

    const runtime = loadRouterRuntimeConfig();

    expect(runtime.server.host).toBe('127.0.0.1');
    expect(runtime.server.port).toBe(9999);
    expect(runtime.upstream.baseUrl).toBe('https://example.test/v1');
    expect(runtime.upstream.apiKey).toBe('env-secret');
    expect(runtime.upstream.timeoutMs).toBe(12345);
    expect(runtime.models.allow).toEqual([
      'stepfun/step-3.5-flash:free',
      'gpt-5.4',
    ]);
    expect(runtime.thinking).toEqual({
      defaultMode: 'pass-through',
      mappingsEnabled: true,
      mappings: [
        {
          match: ['LR/gpt-5.4', 'gpt-5.4'],
          when: { thinking: 'low' },
          rewrite: { thinking: 'xhigh' },
        },
      ],
    });
    expect(runtime.providers.openrouter).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        {
          id: 'stepfun/step-3.5-flash:free',
          name: 'step3fresh',
          contextWindow: 128000,
          maxTokens: 32000,
        },
      ],
    });
    expect(runtime.providers.codex).toMatchObject({
      api: 'openai-responses',
      baseUrl: 'https://codex.example.test/v1',
      models: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          reasoning: true,
          input: ['text', 'image'],
          cost: {
            input: 1.75,
            output: 14,
            cacheRead: 0.175,
            cacheWrite: 0.175,
          },
          contextWindow: 270000,
          maxTokens: 128000,
        },
      ],
    });
  });

  test('rejects models that are not listed in config/router.json', async () => {
    const dir = writeRouterConfig({
      upstream: {
        baseUrl: 'https://example.test/v1',
        timeoutMs: 12345,
      },
      models: {
        allow: ['stepfun/step-3.5-flash:free'],
      },
    });

    chdir(dir);

    let called = false;
    const app = buildApp({
      routerConfig: loadRouterRuntimeConfig(),
      fetchUpstream: async () => {
        called = true;
        return {
          status: 200,
          headers: {},
          json: async () => ({
            id: 'resp-ok',
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
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        type: 'model_not_allowed',
        message: 'Model is not configured in Q-router.',
        model: 'gpt-5.4',
      },
    });
    expect(called).toBe(false);

    await app.close();
  });

  test('falls back to the project config when started outside the project directory', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'Q-router-outside-'));
    chdir(outsideDir);

    const runtime = loadRouterRuntimeConfig();

    expect(runtime.configPath).toBe(join(originalCwd, 'config', 'router.json'));
    expect(runtime.models.allow.length).toBeGreaterThan(0);
  });

  test('exposes startup metadata through /health', async () => {
    const dir = writeRouterConfig({
      server: {
        host: '127.0.0.1',
        port: 4318,
      },
      providers: {
        codex: {
          api: 'openai-responses',
          baseUrl: 'https://codex.example.test/v1',
          models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
        },
      },
      models: {
        allow: ['gpt-5.4'],
      },
      traces: {
        dir: '.qingfu-router',
      },
    });

    chdir(dir);
    const runtime = loadRouterRuntimeConfig();
    const app = buildApp({
      routerConfig: runtime,
      fetchUpstream: async () => {
        throw new Error('should not be called by /health');
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      cwd: dir,
      configPath: join(dir, 'config', 'router.json'),
      server: {
        host: '127.0.0.1',
        port: 4318,
      },
      providers: ['codex'],
      modelsAllowCount: 1,
      traces: {
        dir: '.qingfu-router',
      },
    });

    await app.close();
  });
});
