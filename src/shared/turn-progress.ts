export type TurnPlanProgress = { current: number; total: number };
export type TurnFileProgress = { changed: number; additions: number; deletions: number };
export type TurnProgress = { plan?: TurnPlanProgress; files?: TurnFileProgress };

export type PatchProgress = TurnFileProgress & { paths: string[] };

const PLAN_STATUS_PATTERN = /status\s*:\s*["'](pending|in_progress|inProgress|completed)["']/g;

export function summarizePlanSteps(value: unknown): TurnPlanProgress | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const statuses = value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return String((entry as Record<string, unknown>).status || '');
    return '';
  });
  if (statuses.some((status) => !/^(pending|in_progress|inProgress|completed)$/.test(status))) return undefined;
  const activeIndex = statuses.findIndex((status) => status === 'in_progress' || status === 'inProgress');
  const completed = statuses.filter((status) => status === 'completed').length;
  return {
    current: activeIndex >= 0 ? activeIndex + 1 : Math.min(statuses.length, Math.max(1, completed)),
    total: statuses.length,
  };
}

export function extractPlanProgressFromToolInput(value: unknown): TurnPlanProgress | undefined {
  const input = typeof value === 'string' ? value : '';
  const callIndex = input.lastIndexOf('tools.update_plan');
  const scopedInput = callIndex >= 0 ? input.slice(callIndex) : input;
  const statuses = [...scopedInput.matchAll(PLAN_STATUS_PATTERN)].map((match) => match[1]);
  return summarizePlanSteps(statuses);
}

export function summarizeUnifiedDiff(value: unknown): TurnFileProgress | undefined {
  const diff = typeof value === 'string' ? value : '';
  if (!diff) return undefined;
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (gitHeader) {
      paths.add(gitHeader[2]);
      continue;
    }
    const targetHeader = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (targetHeader && targetHeader[1] !== '/dev/null') paths.add(targetHeader[1]);
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  if (!paths.size && !additions && !deletions) return undefined;
  return { changed: paths.size, additions, deletions };
}

export function summarizePatchChanges(value: unknown): PatchProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const changes = value as Record<string, unknown>;
  const paths = Object.keys(changes);
  let additions = 0;
  let deletions = 0;
  for (const change of Object.values(changes)) {
    if (!change || typeof change !== 'object') continue;
    const entry = change as Record<string, unknown>;
    const type = String(entry.type || '');
    const contentLines = countContentLines(entry.content);
    if (type === 'add') additions += contentLines;
    else if (type === 'delete') deletions += contentLines;
    else {
      const diff = summarizeUnifiedDiff(entry.unified_diff || entry.diff);
      additions += diff?.additions || 0;
      deletions += diff?.deletions || 0;
    }
  }
  if (!paths.length && !additions && !deletions) return undefined;
  return { changed: new Set(paths).size, additions, deletions, paths };
}

export function normalizeTurnProgress(value: unknown): TurnProgress {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const planSource = source.plan as Record<string, unknown> | undefined;
  const filesSource = source.files as Record<string, unknown> | undefined;
  const plan = normalizePair(planSource, 'current', 'total');
  const files = normalizeFiles(filesSource);
  return {
    ...(plan ? { plan: { current: plan.first, total: plan.second } } : {}),
    ...(files ? { files } : {}),
  };
}

function normalizePair(
  source: Record<string, unknown> | undefined,
  firstKey: string,
  secondKey: string,
) {
  const first = Number(source?.[firstKey]);
  const second = Number(source?.[secondKey]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || second < first) return undefined;
  return { first, second };
}

function normalizeFiles(source: Record<string, unknown> | undefined): TurnFileProgress | undefined {
  const changed = Number(source?.changed);
  const additions = Number(source?.additions);
  const deletions = Number(source?.deletions);
  if (![changed, additions, deletions].every((number) => Number.isSafeInteger(number) && number >= 0)) return undefined;
  if (!changed && !additions && !deletions) return undefined;
  return { changed, additions, deletions };
}

function countContentLines(value: unknown) {
  const content = typeof value === 'string' ? value : '';
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}
