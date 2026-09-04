import { publicError } from '../shared/protocol.js';
import {
  mergeDesktopSessionStatuses,
  type DesktopThreadStatus,
} from './codex-desktop.js';

type Payload = Record<string, any>;
type BridgeRequest = {
  action: string;
  payload?: Payload;
  requestId?: string;
  clientId?: string;
  clientDeviceId?: string;
};
type CodexGateway = {
  child: unknown;
  activeTurn: unknown;
  listSessions(options: Payload): Promise<any[]>;
  readSession(threadId: string): Promise<any>;
  renameSession(threadId: string, name: unknown): Promise<any>;
  listSessionTurns(threadId: string, options: Payload): Promise<any>;
  readTurnDiff(threadId: string, turnId: string): Promise<any>;
  readModelConfig(threadId: string): Promise<any>;
  updateModelConfig(threadId: string, value: Payload): Promise<any>;
  readPermissionMode(threadId: string): Promise<any>;
  updatePermissionMode(threadId: string, mode: unknown): Promise<any>;
  startTurn(options: Payload): Promise<Record<string, any>>;
  steerTurn(options: Payload): Promise<Record<string, any>>;
  stopTurn(threadId?: unknown): Promise<any>;
  listApprovals(threadId: unknown, clientId?: string): any;
  respondApproval(approvalId: unknown, approved: boolean, threadId?: unknown): Promise<any>;
  getDesktopTurnOverrides(threadId: string): Promise<Payload> | Payload;
  isLargeSession(threadId: string): Promise<boolean>;
  canOwnSession(threadId: string): boolean;
  needsDesktopPermissionRecovery(threadId: string): Promise<boolean>;
};
type DesktopGateway = {
  listThreads(options: Payload): Promise<DesktopThreadStatus[]>;
  readThreadState(options: Payload): Promise<any>;
  sendMessage(options: Payload): Promise<any>;
  renameThread(options: Payload): Promise<any>;
};
type Dependencies = {
  codex: CodexGateway;
  desktop?: DesktopGateway | null;
  attachments: { save(payload: Payload): Promise<any>; read(payload: Payload): Promise<any> };
  visualizations: { read(payload: Payload): Promise<any> };
  downloads: {
    open(payload: Payload, clientId?: string): Promise<any>;
    read(payload: Payload, clientId?: string): Promise<any>;
    readMarkdown(payload: Payload): Promise<any>;
    readText(payload: Payload): Promise<any>;
    close(payload: Payload, clientId?: string): Promise<any>;
  };
  deviceId: string;
  deviceLabel?: string;
  mode?: 'desktop' | 'headless';
  networkAccess?: boolean;
  allowFullAccess?: boolean;
};
type DispatchContext = Dependencies & Required<Pick<BridgeRequest, 'action'>> & {
  payload: Payload;
  requestId?: string;
  clientId?: string;
  clientDeviceId?: string;
  getDesktopThreads(): DesktopThreadStatus[];
  refreshDesktopThreads(callerThreadId: unknown): void;
};

const DESKTOP_STATUS_CACHE_MS = 15_000;

export function createRequestHandler({
  codex, desktop, attachments, visualizations, downloads, deviceId,
  deviceLabel = deviceId, mode = desktop ? 'desktop' : 'headless',
  networkAccess = false, allowFullAccess = false,
}: Dependencies) {
  let desktopStatusCache: { threads: DesktopThreadStatus[]; updatedAt: number } | null = null;
  let desktopStatusRefresh: Promise<void> | null = null;
  const getDesktopThreads = () => (
    desktopStatusCache && Date.now() - desktopStatusCache.updatedAt <= DESKTOP_STATUS_CACHE_MS
      ? desktopStatusCache.threads : []
  );
  const refreshDesktopThreads = (callerThreadId: unknown) => {
    const caller = String(callerThreadId || '').trim();
    if (mode !== 'desktop' || !desktop || !caller || desktopStatusRefresh) return;
    desktopStatusRefresh = desktop.listThreads({ callerThreadId: caller, limit: 50 })
      .then((threads) => {
        desktopStatusCache = { threads: Array.isArray(threads) ? threads : [], updatedAt: Date.now() };
      })
      .catch(() => { /* app-server status remains the fallback when Desktop is unavailable */ })
      .finally(() => { desktopStatusRefresh = null; });
  };
  return async function handleRequest(message: BridgeRequest) {
    const {
      action, payload = {}, requestId, clientId, clientDeviceId,
    } = message;
    try {
      const data = await dispatchAction({
        action, payload, requestId, clientId, clientDeviceId,
        codex, desktop, attachments, visualizations, downloads, deviceId, deviceLabel, mode,
        networkAccess, allowFullAccess, getDesktopThreads, refreshDesktopThreads,
      });
      return { type: 'response', clientId, requestId, ok: true, data };
    } catch (error) {
      return { type: 'response', clientId, requestId, ok: false, error: publicError(error) };
    }
  };
}

async function dispatchAction({
  action, payload, requestId, clientId, clientDeviceId,
  codex, desktop, attachments, visualizations, downloads, deviceId, deviceLabel, mode,
  networkAccess, allowFullAccess, getDesktopThreads, refreshDesktopThreads,
}: DispatchContext) {
  if (action === 'connector.status') {
    return {
      deviceId,
      deviceLabel,
      mode,
      platform: process.platform,
      codexOnline: Boolean(codex.child),
      activeTurn: Boolean(codex.activeTurn),
      capabilities: { networkAccess, fullAccess: allowFullAccess },
    };
  }
  if (action === 'sessions.list') {
    const sessions = await codex.listSessions({ cwd: payload.cwd });
    const desktopThreads = getDesktopThreads();
    refreshDesktopThreads(sessions[0]?.id);
    return {
      sessions: mergeDesktopSessionStatuses(
        sessions,
        desktopThreads,
        String((codex.activeTurn as { threadId?: unknown } | null)?.threadId || ''),
      ),
    };
  }
  if (action === 'session.read') return codex.readSession(String(payload.threadId || ''));
  if (action === 'session.rename') {
    const threadId = String(payload.threadId || '');
    if (mode === 'desktop') {
      if (!desktop) throw new Error('desktop_app_unavailable');
      return desktop.renameThread({
        threadId,
        name: payload.name,
      });
    }
    return codex.renameSession(threadId, payload.name);
  }
  if (action === 'session.turns.list') {
    return codex.listSessionTurns(String(payload.threadId || ''), {
      cursor: payload.cursor,
      limit: payload.limit,
      mode: payload.mode,
    });
  }
  if (action === 'session.turn.diff.read') {
    return codex.readTurnDiff(String(payload.threadId || ''), String(payload.turnId || ''));
  }
  if (action === 'session.model-config.read') {
    return codex.readModelConfig(String(payload.threadId || ''));
  }
  if (action === 'session.model-config.update') {
    return codex.updateModelConfig(String(payload.threadId || ''), payload);
  }
  if (action === 'session.permissions.read') {
    return {
      ...await codex.readPermissionMode(String(payload.threadId || '')),
      editable: mode === 'headless',
      networkAccess,
      allowFullAccess,
    };
  }
  if (action === 'session.permissions.update') {
    if (mode !== 'headless') throw new Error('desktop_permission_mode_managed_on_computer');
    return {
      ...await codex.updatePermissionMode(String(payload.threadId || ''), payload.mode),
      editable: true,
      networkAccess,
      allowFullAccess,
    };
  }
  if (action === 'attachment.upload') return attachments.save(payload);
  if (action === 'attachment.read') return attachments.read(payload);
  if (action === 'visualization.read') return visualizations.read(payload);
  const downloadOwner = clientDeviceId || clientId;
  if (action === 'file.download.open') return downloads.open(payload, downloadOwner);
  if (action === 'file.download.chunk') return downloads.read(payload, downloadOwner);
  if (action === 'file.download.close') return downloads.close(payload, downloadOwner);
  if (action === 'file.markdown.read') return downloads.readMarkdown(payload);
  if (action === 'file.text.read') return downloads.readText(payload);
  if (action === 'turn.start') return startTurn({
    codex, desktop, mode, payload, clientId, requestId,
  });
  if (action === 'turn.steer') {
    return {
      ...await codex.steerTurn({ ...payload, clientId, requestId }),
      delivery: 'appServer',
    };
  }
  if (action === 'turn.stop') return codex.stopTurn(payload.threadId);
  if (action === 'approval.pending') {
    const pending = await codex.listApprovals(payload.threadId, clientId);
    if (pending.approvals?.length) return pending;
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) return pending;
    if (mode !== 'desktop' || !desktop) return pending;
    try {
      const state = await desktop.readThreadState({
        threadId,
      });
      if (state.waitingOnApproval) {
        return {
          ...pending,
          externalApproval: {
            approvalId: '',
            threadId,
            kind: 'desktop',
            summary: 'This approval is owned by Codex Desktop.',
            actionable: false,
          },
        };
      }
    } catch { /* absence of Desktop status must not block app-server approvals */ }
    return pending;
  }
  if (action === 'approval.respond') {
    return codex.respondApproval(payload.approvalId, payload.approved === true, payload.threadId);
  }
  throw new Error('unsupported_action');
}

async function startTurn({
  codex, desktop, mode, payload, clientId, requestId,
}: Pick<DispatchContext, 'codex' | 'desktop' | 'mode' | 'payload' | 'clientId' | 'requestId'>) {
  const threadId = String(payload.threadId || '').trim();
  if (!threadId || mode === 'headless') {
    return { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
  }
  // Existing Desktop tasks must keep their original writer. Starting or
  // resuming them through the bridge's app-server creates a second writer and
  // makes later Desktop delivery fail with "already has an active writer".
  if (!desktop) throw new Error('desktop_app_unavailable');
  const { model, thinking } = await codex.getDesktopTurnOverrides(threadId);
  return desktop.sendMessage({
    threadId,
    text: payload.text,
    requestId,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  });
}
