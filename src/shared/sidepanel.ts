export const SIDEPANEL_PATH = '/extension/sidepanel';
export const SIDEPANEL_MESSAGE = 'anywhere.sidepanel.selection';
export const SIDEPANEL_VERSION = 1;

export type SidePanelSession = {
  environmentId: string;
  threadId: string | null;
  title: string;
  online: boolean;
};

export function sidePanelTarget(location: { pathname: string; search: string }) {
  if (location.pathname !== SIDEPANEL_PATH) return null;
  const params = new URLSearchParams(location.search);
  const id = params.get('extensionId') || '';
  const channel = params.get('channel') || '';
  if (params.getAll('extensionId').length !== 1 || params.getAll('channel').length !== 1
    || !/^[a-p]{32}$/.test(id) || !/^[a-f0-9]{32}$/.test(channel)) return null;
  return { origin: `chrome-extension://${id}`, channel };
}

export function parseSidePanelSession(value: unknown, channel: string): (SidePanelSession & { sequence: number }) | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== SIDEPANEL_MESSAGE || frame.version !== SIDEPANEL_VERSION || frame.channel !== channel
    || !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 1
    || typeof frame.environmentId !== 'string' || frame.environmentId.length > 128
    || /[\u0000-\u001f]/.test(frame.environmentId)
    || (frame.threadId !== null && (typeof frame.threadId !== 'string' || !frame.threadId
      || frame.threadId.length > 256 || /[\u0000-\u001f]/.test(frame.threadId)))
    || typeof frame.title !== 'string' || frame.title.length > 160 || typeof frame.online !== 'boolean') return null;
  return { environmentId: frame.environmentId, threadId: frame.threadId as string | null,
    title: frame.title, online: frame.online, sequence: Number(frame.sequence) };
}
