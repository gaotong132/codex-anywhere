export type ContextCompaction = {
  sequence: number;
  contextWindow?: number;
  beforeTokens?: number;
  afterTokens?: number;
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

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
