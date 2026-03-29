import type { FastifyReply } from 'fastify';

export type QrouterObservability = {
  requestId: string;
  endpoint: 'chat.completions' | 'responses';
  finalClassification?: string | null;
  attempts?: number | null;
  requestedModel?: string | null;
  upstreamModel?: string | null;
  providerId?: string | null;
  routeId?: string | null;
  failoverUsed?: boolean;
  failoverFrom?: string | null;
  failoverTo?: string | null;
  visibleError?: boolean;
  localCommand?: boolean;
};

function resolveRetriesUsed(attempts: number | null | undefined): number {
  if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts <= 0) {
    return 0;
  }

  return Math.max(attempts - 1, 0);
}

function appendStringField(
  target: Record<string, unknown>,
  key: string,
  value: string | null | undefined,
): void {
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value;
  }
}

function setHeader(
  reply: FastifyReply,
  headerName: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value === undefined || value === null) {
    return;
  }

  reply.header(headerName, String(value));
}

export function applyQrouterObservabilityHeaders(
  reply: FastifyReply,
  observability: QrouterObservability,
): void {
  setHeader(reply, 'x-qrouter-request-id', observability.requestId);
  setHeader(reply, 'x-qrouter-endpoint', observability.endpoint);
  setHeader(reply, 'x-qrouter-retries-used', resolveRetriesUsed(observability.attempts));
  setHeader(reply, 'x-qrouter-failover-used', observability.failoverUsed === true ? 'true' : 'false');
  setHeader(reply, 'x-qrouter-final-classification', observability.finalClassification);
  setHeader(reply, 'x-qrouter-requested-model', observability.requestedModel);
  setHeader(reply, 'x-qrouter-upstream-model', observability.upstreamModel);
  setHeader(reply, 'x-qrouter-provider-id', observability.providerId);
  setHeader(reply, 'x-qrouter-route-id', observability.routeId);

  if (observability.failoverUsed) {
    setHeader(reply, 'x-qrouter-failover-from', observability.failoverFrom);
    setHeader(reply, 'x-qrouter-failover-to', observability.failoverTo);
  }
}

export function buildResponsesQrouterMetadata(
  observability: QrouterObservability,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    endpoint: observability.endpoint,
    request_id: observability.requestId,
    retries_used: resolveRetriesUsed(observability.attempts),
    failover_used: observability.failoverUsed === true,
  };

  if (typeof observability.attempts === 'number' && Number.isFinite(observability.attempts)) {
    metadata.attempts = observability.attempts;
  }

  appendStringField(metadata, 'final_classification', observability.finalClassification);
  appendStringField(metadata, 'requested_model', observability.requestedModel);
  appendStringField(metadata, 'upstream_model', observability.upstreamModel);
  appendStringField(metadata, 'provider_id', observability.providerId);
  appendStringField(metadata, 'route_id', observability.routeId);

  if (observability.failoverUsed) {
    appendStringField(metadata, 'failover_from', observability.failoverFrom);
    appendStringField(metadata, 'failover_to', observability.failoverTo);
  }

  if (observability.visibleError) {
    metadata.visible_error = true;
  }

  if (observability.localCommand) {
    metadata.local_command = true;
  }

  return metadata;
}

export function appendResponsesQrouterMetadata(
  payload: unknown,
  observability: QrouterObservability,
): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const existingMetadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};

  return {
    ...record,
    metadata: {
      ...existingMetadata,
      qrouter: buildResponsesQrouterMetadata(observability),
    },
  };
}
