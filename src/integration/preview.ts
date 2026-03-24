import { readFileSync } from 'node:fs';
import {
  applyQingfuRouterIntegration,
  diffQingfuIntegrationPaths,
  rollbackQingfuRouterIntegration,
  summarizeQingfuIntegration,
} from './openclaw-config.js';

const inputPath = process.argv[2] ?? '/home/seax/.openclaw/openclaw.json';
const mode = process.argv[3] ?? 'apply';
const raw = readFileSync(inputPath, 'utf8');
const parsed = JSON.parse(raw);

let result;
let changedPaths;

if (mode === 'rollback') {
  const applied = applyQingfuRouterIntegration(parsed);
  result = rollbackQingfuRouterIntegration(applied);
  changedPaths = diffQingfuIntegrationPaths(applied, result);
} else {
  result = applyQingfuRouterIntegration(parsed);
  changedPaths = diffQingfuIntegrationPaths(parsed, result);
}

console.log(
  JSON.stringify(
    {
      mode,
      summary: summarizeQingfuIntegration(result),
      changedPaths,
      configPreview: {
        env: {
          QINGFU_ROUTER_API_KEY: result.env?.QINGFU_ROUTER_API_KEY ?? null,
        },
        agents: {
          defaults: {
            model: result.agents?.defaults?.model ?? null,
          },
        },
        models: {
          providers: {
            qingfuCodex: result.models?.providers?.qingfuCodex ?? null,
          },
        },
      },
    },
    null,
    2,
  ),
);
