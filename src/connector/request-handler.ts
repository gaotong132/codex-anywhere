import { publicError } from '../shared/protocol.js';
import { mergeDesktopSessionStatuses } from './codex-desktop.js';

type Payload = Record<string, any>;
type BridgeRequest = {
  action: string;
  payload?: Payload;
  requestId?: string;
  clientId?: string;
};
type CodexGateway = {
  child: unknown;
  activeTurn: unknown;
  listSessions(options: Payload): Promise<any[]>;
  readSession(threadId: string): Promise<any>;
  listSessionTurns(threadId: string, options: Payload): Promise<any>;
  startTurn(options: Payload): Promise<Record<string, any>>;
  steerTurn(options: Payload): Promise<Record<string, any>>;
  queueTurn(options: Payload): Record<string, any>;
  stopTurn(): Promise<any>;
  listApprovals(threadId: unknown, clientId?: string): any;
  respondApproval(approvalId: unknown, approved: boolean, threadId?: unknown): Promise<any>;
  getControllerThreadId(threadId: string): string;
  isLargeSession(threadId: string): Promise<boolean>;
  canOwnSession(threadId: string): boolean;
  needsDesktopPermissionRecovery(threadId: string): Promise<boolean>;
};
type DesktopGateway = {
  listThreads(options: Payload): Promise<any[]>;
  readThreadState(options: Payload): Promise<any>;
  sendMessage(options: Payload): Promise<any>;
};
type Dependencies = {
  codex: CodexGateway;
  desktop: DesktopGateway;
  attachments: { save(payload: Payload): Promise<any>; read(payload: Payload): Promise<any> };
  visualizations: { read(payload: Payload): Promise<any> };
  downloads: {
    open(payload: Payload, clientId?: string): Promise<any>;
    read(payload: Payload, clientId?: string): Promise<any>;
    close(payload: Payload, clientId?: string): Promise<any>;
  };
  deviceId: string;
};
type DispatchContext = Dependencies & Required<Pick<BridgeRequest, 'action'>> & {
  payload: Payload;
  requestId?: string;
  clientId?: string;
};

export function createRequestHandler({
  codex, desktop, attachments, visualizations, downloads, deviceId,
}: Dependencies) {
  return async function handleRequest(message: BridgeRequest) {
    const { action, payload = {}, requestId, clientId } = message;
    try {
      const data = await dispatchAction({
        action, payload, requestId, clientId,
        codex, desktop, attachments, visualizations, downloads, deviceId,
      });
      return { type: 'response', clientId, requestId, ok: true, data };
    } catch (error) {
      return { type: 'response', clientId, requestId, ok: false, error: publicError(error) };
    }
  };
}

async function dispatchAction({
  action, payload, requestId, clientId,
  codex, desktop, attachments, visualizations, downloads, deviceId,
}: DispatchContext) {
  if (action === 'connector.status') {
    return {
      deviceId,
      codexOnline: Boolean(codex.child),
      activeTurn: Boolean(codex.activeTurn),
    };
  }
  if (action === 'sessions.list') {
    const sessions = await codex.listSessions({ cwd: payload.cwd });
    let desktopThreads = [];
    try {
      desktopThreads = await desktop.listThreads({ callerThreadId: sessions[0]?.id, limit: 50 });
    } catch { /* app-server status remains the fallback when Desktop is unavailable */ }
    return { sessions: mergeDesktopSessionStatuses(sessions, desktopThreads) };
  }
  if (action === 'session.read') return codex.readSession(String(payload.threadId || ''));
  if (action === 'session.turns.list') {
    return codex.listSessionTurns(String(payload.threadId || ''), {
      cursor: payload.cursor,
      limit: payload.limit,
      mode: payload.mode,
    });
  }
  if (action === 'attachment.upload') return attachments.save(payload);
  if (action === 'attachment.read') return attachments.read(payload);
  if (action === 'visualization.read') return visualizations.read(payload);
  if (action === 'file.download.open') return downloads.open(payload, clientId);
  if (action === 'file.download.chunk') return downloads.read(payload, clientId);
  if (action === 'file.download.close') return downloads.close(payload, clientId);
  if (action === 'turn.start') return startTurn({ codex, desktop, payload, clientId, requestId });
  if (action === 'turn.steer') {
    return {
      ...await codex.steerTurn({ ...payload, clientId, requestId }),
      delivery: 'appServer',
    };
  }
  if (action === 'turn.queue') {
    return { ...codex.queueTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
  }
  if (action === 'turn.stop') return codex.stopTurn();
  if (action === 'approval.pending') {
    const pending = await codex.listApprovals(payload.threadId, clientId);
    if (pending.approvals?.length) return pending;
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) return pending;
    try {
      const state = await desktop.readThreadState({
        threadId,
        callerThreadId: codex.getControllerThreadId(threadId),
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
  codex, desktop, payload, clientId, requestId,
}: Pick<DispatchContext, 'codex' | 'desktop' | 'payload' | 'clientId' | 'requestId'>) {
  const threadId = String(payload.threadId || '').trim();
  if (!threadId) {
    return { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
  }
  const largeSession = await codex.isLargeSession(threadId);
  if (!largeSession && await codex.needsDesktopPermissionRecovery(threadId)) {
    try {
      return await desktop.sendMessage({
        threadId,
        text: payload.text,
        requestId,
        callerThreadId: codex.getControllerThreadId(threadId),
      });
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== 'desktop_app_unavailable') throw error;
    }
  }
  if (codex.canOwnSession(threadId) && !largeSession) {
    try {
      return {
        ...await codex.startTurn({
          ...payload, clientId, requestId, waitForActiveWriter: false,
        }),
        delivery: 'appServer',
      };
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== 'thread_active_writer_conflict') throw error;
    }
  }
  try {
    return await desktop.sendMessage({
      threadId,
      text: payload.text,
      requestId,
      callerThreadId: codex.getControllerThreadId(threadId),
    });
  } catch (error) {
    if (String(error instanceof Error ? error.message : error) !== 'desktop_app_unavailable') throw error;
    if (largeSession) throw new Error('desktop_required_for_large_session');
    return { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
  }
}
