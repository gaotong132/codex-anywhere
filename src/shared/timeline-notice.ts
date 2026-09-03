export type TurnStatusNotice = {
  kind: 'turnStatus';
  status: 'failed' | 'aborted' | 'error';
  detail?: string;
};

export type ModelSettingsNotice = {
  kind: 'modelSettings';
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
};

export type ApprovalNotice = {
  kind: 'approval';
  decision: 'approved' | 'rejected';
  approvalKind?: string;
  summary?: string;
};

export type ToolSummaryNotice = {
  kind: 'toolSummary';
  total: number;
  commands?: number;
  edits?: number;
  searches?: number;
  connectedTools?: number;
  generations?: number;
  other?: number;
};

export type TimelineNotice = TurnStatusNotice | ModelSettingsNotice | ApprovalNotice | ToolSummaryNotice;

const TEXT_LIMIT = 500;

export function normalizeTimelineNotice(value: unknown): TimelineNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'turnStatus') {
    const status = String(candidate.status || '');
    if (!['failed', 'aborted', 'error'].includes(status)) return undefined;
    const detail = boundedText(candidate.detail);
    return {
      kind: 'turnStatus',
      status: status as TurnStatusNotice['status'],
      ...(detail ? { detail } : {}),
    };
  }
  if (candidate.kind === 'modelSettings') {
    const model = boundedText(candidate.model);
    const reasoningEffort = boundedText(candidate.reasoningEffort);
    const serviceTier = boundedText(candidate.serviceTier);
    if (!model && !reasoningEffort && !serviceTier) return undefined;
    return {
      kind: 'modelSettings',
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
    };
  }
  if (candidate.kind === 'approval') {
    const decision = String(candidate.decision || '');
    if (decision !== 'approved' && decision !== 'rejected') return undefined;
    const approvalKind = boundedText(candidate.approvalKind);
    const summary = boundedText(candidate.summary);
    return {
      kind: 'approval',
      decision,
      ...(approvalKind ? { approvalKind } : {}),
      ...(summary ? { summary } : {}),
    };
  }
  if (candidate.kind === 'toolSummary') {
    const counts = {
      commands: nonNegativeInteger(candidate.commands),
      edits: nonNegativeInteger(candidate.edits),
      searches: nonNegativeInteger(candidate.searches),
      connectedTools: nonNegativeInteger(candidate.connectedTools),
      generations: nonNegativeInteger(candidate.generations),
      other: nonNegativeInteger(candidate.other),
    };
    const computedTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const total = positiveInteger(candidate.total) || computedTotal;
    if (!total) return undefined;
    return {
      kind: 'toolSummary',
      total,
      ...Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)),
    } as ToolSummaryNotice;
  }
  return undefined;
}

function boundedText(value: unknown) {
  const text = typeof value === 'string' ? value.replace(/[\0\r]+/g, ' ').trim() : '';
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1).trimEnd()}…`;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
