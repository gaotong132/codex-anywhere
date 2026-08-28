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
  stopTurn(): Promise<any>;
  respondApproval(approvalId: unknown, approved: boolean): Promise<any>;
  getControllerThreadId(threadId: string): string;
  isLargeSession(threadId: string): Promise<boolean>;
};
type DesktopGateway = {
  listThreads(options: Payload): Promise<any[]>;
  sendMessage(options: Payload): Promise<any>;
};
type Dependencies = {
  codex: CodexGateway;
  desktop: DesktopGateway;
  attachments: { save(payload: Payload): Promise<any>; read(payload: Payload): Promise<any> };
  downloads: {
    open(payload: Payload, clientId?: string): Promise<any>;
    read(payload: Payload, clientId?: string): Promise<any>;
    close(payload: Payload, clientId?: string): Promise<any>;
  };
  deviceId: string;
  workspace: string;
};
type DispatchContext = Dependencies & Required<Pick<BridgeRequest, 'action'>> & {
  payload: Payload;
  requestId?: string;
  clientId?: string;
};

export function createRequestHandler({ codex, desktop, attachments, downloads, deviceId, workspace }: Dependencies) {
  return async function handleRequest(message: BridgeRequest) {
    const { action, payload = {}, requestId, clientId } = message;
    try {
      const data = await dispatchAction({
        action, payload, requestId, clientId,
        codex, desktop, attachments, downloads, deviceId, workspace,
      });
      return { type: 'response', clientId, requestId, ok: true, data };
    } catch (error) {
      return { type: 'response', clientId, requestId, ok: false, error: publicError(error) };
    }
  };
}

async function dispatchAction({
  action, payload, requestId, clientId,
  codex, desktop, attachments, downloads, deviceId, workspace,
}: DispatchContext) {
  if (action === 'connector.status') {
    return {
      deviceId,
      workspace,
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
  if (action === 'file.download.open') return downloads.open(payload, clientId);
  if (action === 'file.download.chunk') return downloads.read(payload, clientId);
  if (action === 'file.download.close') return downloads.close(payload, clientId);
  if (action === 'turn.start') return startTurn({ codex, desktop, payload, clientId, requestId });
  if (action === 'turn.stop') return codex.stopTurn();
  if (action === 'approval.respond') return codex.respondApproval(payload.approvalId, payload.approved === true);
  throw new Error('unsupported_action');
}

async function startTurn({
  codex, desktop, payload, clientId, requestId,
}: Pick<DispatchContext, 'codex' | 'desktop' | 'payload' | 'clientId' | 'requestId'>) {
  const threadId = String(payload.threadId || '').trim();
  if (!threadId) {
    return { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
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
    if (await codex.isLargeSession(threadId)) throw new Error('desktop_required_for_large_session');
    return { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
  }
}

export const internals = { dispatchAction, startTurn };
