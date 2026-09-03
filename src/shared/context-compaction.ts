export type ContextCompaction = {
  sequence: number;
  contextWindow?: number;
  beforeTokens?: number;
  afterTokens?: number;
};

export type ContextUsage = {
  tokens?: number;
  contextWindow?: number;
  updatedAt?: number | null;
};

export function normalizeContextCompaction(value: unknown): ContextCompaction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ContextCompaction>;
  const sequence = positiveInteger(candidate.sequence);
  if (!sequence) return undefined;
  const contextWindow = positiveInteger(candidate.contextWindow);
  const beforeTokens = nonNegativeInteger(candidate.beforeTokens);
  const afterTokens = nonNegativeInteger(candidate.afterTokens);
  return {
    sequence,
    ...(contextWindow ? { contextWindow } : {}),
    ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    ...(afterTokens !== undefined ? { afterTokens } : {}),
  };
}

export function normalizeContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ContextUsage>;
  const tokens = nonNegativeInteger(candidate.tokens);
  const contextWindow = positiveInteger(candidate.contextWindow);
  const updatedAt = finiteTimestamp(candidate.updatedAt);
  if (tokens === undefined && !contextWindow) return undefined;
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function finiteTimestamp(value: unknown) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
