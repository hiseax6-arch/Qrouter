import { describe, expect, test } from 'vitest';
import {
  applyQingfuRouterIntegration,
  diffQingfuIntegrationPaths,
  rollbackQingfuRouterIntegration,
  summarizeQingfuIntegration,
} from '../integration/openclaw-config.js';

describe('applyQingfuRouterIntegration', () => {
  test('adds a dedicated qingfuCodex provider without overwriting existing providers', () => {
    const input = {
      env: {
        SOME_OTHER_ENV: '1',
      },
      agents: {
        defaults: {
          model: {
            primary: 'codex/gpt-5.4',
          },
        },
      },
      models: {
        providers: {
          codex: {
            api: 'openai-responses',
            baseUrl: 'https://codex.0u0o.com/v1',
            models: [{ id: 'gpt-5.4' }],
          },
        },
      },
    };

    const output = applyQingfuRouterIntegration(input);
    const summary = summarizeQingfuIntegration(output);

    expect((output.models?.providers as Record<string, unknown>).codex).toMatchObject({
      api: 'openai-responses',
      baseUrl: 'https://codex.0u0o.com/v1',
    });
    expect(summary).toEqual({
      primary: 'qingfuCodex/gpt-5.4',
      fallbacks: ['codex/gpt-5.4'],
      providerId: 'qingfuCodex',
      providerApi: 'openai-completions',
      providerBaseUrl: 'http://127.0.0.1:4318/v1',
      providerModelIds: ['gpt-5.4'],
    });
  });

  test('preserves existing router env value if already present', () => {
    const output = applyQingfuRouterIntegration({
      env: {
        QINGFU_ROUTER_API_KEY: 'already-set',
      },
      agents: {
        defaults: {
          model: {
            primary: 'codex/gpt-5.4',
          },
        },
      },
    });

    expect(output.env?.QINGFU_ROUTER_API_KEY).toBe('already-set');
  });

  test('supports skipping fallback preservation when requested', () => {
    const output = applyQingfuRouterIntegration(
      {
        agents: {
          defaults: {
            model: {
              primary: 'codex/gpt-5.4',
            },
          },
        },
      },
      {
        preserveCurrentPrimaryAsFallback: false,
      },
    );

    expect(output.agents?.defaults?.model).toEqual({
      primary: 'qingfuCodex/gpt-5.4',
    });
  });
});

describe('rollbackQingfuRouterIntegration', () => {
  test('restores the original primary path and removes qingfu provider artifacts', () => {
    const original = {
      agents: {
        defaults: {
          model: {
            primary: 'codex/gpt-5.4',
          },
          models: {},
        },
      },
      models: {
        providers: {
          codex: {
            api: 'openai-responses',
            baseUrl: 'https://codex.0u0o.com/v1',
            models: [{ id: 'gpt-5.4' }],
          },
        },
      },
    };

    const applied = applyQingfuRouterIntegration(original);
    const rolledBack = rollbackQingfuRouterIntegration(applied);

    expect(rolledBack.agents?.defaults?.model).toEqual({
      primary: 'codex/gpt-5.4',
      fallbacks: [],
    });
    expect((rolledBack.models?.providers as Record<string, unknown>).qingfuCodex).toBeUndefined();
    expect((rolledBack.agents?.defaults?.models as Record<string, unknown>)['qingfuCodex/gpt-5.4']).toBeUndefined();
  });

  test('can clean up router env var on rollback when requested', () => {
    const applied = applyQingfuRouterIntegration({
      env: {},
      agents: {
        defaults: {
          model: {
            primary: 'codex/gpt-5.4',
          },
        },
      },
    });

    const rolledBack = rollbackQingfuRouterIntegration(applied, {
      cleanupRouterEnvVarOnRollback: true,
    });

    expect(rolledBack.env?.QINGFU_ROUTER_API_KEY).toBeUndefined();
  });

  test('reports the exact changed path set for apply and rollback', () => {
    const original = {
      agents: {
        defaults: {
          model: {
            primary: 'codex/gpt-5.4',
          },
          models: {},
        },
      },
      models: {
        providers: {
          codex: {
            api: 'openai-responses',
          },
        },
      },
      env: {},
    };

    const applied = applyQingfuRouterIntegration(original);
    const rolledBack = rollbackQingfuRouterIntegration(applied);

    expect(diffQingfuIntegrationPaths(original, applied)).toEqual([
      'agents.defaults.model.primary',
      'agents.defaults.model.fallbacks',
      'models.providers.qingfuCodex',
      'agents.defaults.models.qingfuCodex/gpt-5.4',
      'env.QINGFU_ROUTER_API_KEY',
    ]);
    expect(diffQingfuIntegrationPaths(applied, rolledBack)).toEqual([
      'agents.defaults.model.primary',
      'agents.defaults.model.fallbacks',
      'models.providers.qingfuCodex',
      'agents.defaults.models.qingfuCodex/gpt-5.4',
    ]);
  });
});
