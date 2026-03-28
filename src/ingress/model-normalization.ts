export function normalizeAllowedModel(model: string | null): string | null {
  if (!model) {
    return model;
  }

  return model.startsWith('LR/') ? model.slice(3) : model;
}

export function resolveRequestedModelAlias(
  model: string | null,
  allowedModels?: ReadonlySet<string>,
): string | null {
  if (!model || model.startsWith('LR/')) {
    return model;
  }

  const lrModel = `LR/${model}`;
  if (allowedModels?.has(lrModel)) {
    return lrModel;
  }

  return model;
}

export function buildAllowedModelCandidates(...models: Array<string | null | undefined>): string[] {
  const candidates = new Set<string>();

  for (const model of models) {
    if (typeof model !== 'string' || model.length === 0) {
      continue;
    }

    candidates.add(model);

    const normalized = normalizeAllowedModel(model);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}
