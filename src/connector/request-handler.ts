import { publicError } from '../shared/protocol.js';
import { measureOperation, operationMetrics } from './operation-metrics.js';
import type { DesktopControls } from './desktop-controls.js';
import type { FileUploadManager } from './file-uploads.js';
import type { BrowserSessionBroker } from '../browser-control/session-broker.js';
import { SESSION_STATUS_MAX_AGE_MS, type SessionStatusSnapshot } from '../shared/session-status.js';
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
  activeTurns: ReadonlyMap<unknown, { threadId: string; turnId?: string; state?: string }>;
  getActiveTurn(threadId: string): { threadId: string; turnId?: string; state?: string } | null;
  listSessions(options: Payload): Promise<any[]>;
  readSession(threadId: string): Promise<any>;
  renameSession(threadId: string, name: unknown): Promise<any>;
  deleteSession(threadId: unknown): Promise<any>;
  listSessionTurns(threadId: string, options: Payload): Promise<any>;
  readTurnDiff(threadId: string, turnId: string): Promise<any>;
  readModelConfig(threadId: string): Promise<any>;
  readStoredModelConfig?(threadId: string, catalog: any[] | Promise<any[]>): Promise<any>;
  readStoredPermissionConfig?(threadId: string): Promise<any>;
  updateStoredPermissionConfig?(threadId: string, value: any): Promise<any>;
  listModels?(options?: { allowStale?: boolean }): Promise<any[]>;
  updateModelConfig(threadId: string, value: Payload): Promise<any>;
  readPermissionMode(threadId: string, options?: { fresh?: boolean }): Promise<any>;
  updatePermissionMode(threadId: string, mode: unknown): Promise<any>;
  startTurn(options: Payload): Promise<Record<string, any>>;
  steerTurn(options: Payload): Promise<Record<string, any>>;
  stopTurn(threadId?: unknown): Promise<any>;
  listApprovals(threadId: unknown, clientId?: string): any;
  respondApproval(approvalId: unknown, approved: boolean, threadId?: unknown): Promise<any>;
  getDesktopTurnOverrides(threadId: string): Promise<Payload> | Payload;
  prepareDesktopTurn?(): Promise<void>;
  isLargeSession(threadId: string): Promise<boolean>;
  canOwnSession(threadId: string): boolean;
  needsDesktopPermissionRecovery(threadId: string): Promise<boolean>;
};
type DesktopGateway = {
  controls?: Pick<DesktopControls, 'read' | 'modelConfig' | 'updateModel' | 'stop' | 'respond'>
    & Partial<Pick<DesktopControls, 'permissions' | 'updatePermissions'>>;
  getCapabilities?(): Promise<{ available: boolean; tools: string[]; inputAvailable?: boolean }>;
  listThreads(options: Payload): Promise<DesktopThreadStatus[]>;
  readThreadState(options: Payload): Promise<any>;
  sendMessage(options: Payload): Promise<any>;
  renameThread(options: Payload): Promise<any>;
  openThread?(options: Payload): Promise<any>;
  archiveThread?(options: Payload): Promise<any>;
  restoreThread?(options: Payload): Promise<any>;
};
type Dependencies = {
  onSessionStatuses?(snapshot: SessionStatusSnapshot): void;
  browser?: BrowserSessionBroker;
  codex: CodexGateway;
  desktop?: DesktopGateway | null;
  attachments: { save(payload: Payload): Promise<any>; read(payload: Payload): Promise<any>; nativeInput?(payload: Payload): Promise<string> };
  fileUploads?: Pick<FileUploadManager, 'begin' | 'chunk' | 'complete' | 'cancel'>;
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
  getDesktopStatuses(): SessionStatusSnapshot | null;
  refreshDesktopThreads(callerThreadId: unknown): void;
};

const DESKTOP_STATUS_REFRESH_MS = 6_000;
const MEASURED_ACTIONS = new Set(['sessions.list', 'session.model-config.read', 'session.turns.list',
  'approval.pending', 'connector.status', 'session.permissions.read', 'turn.start']);

async function headerModelCatalog(codex: CodexGateway) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      measureOperation('model.catalog', () => codex.listModels!({ allowStale: true })),
      new Promise<any[]>(resolve => { timer = setTimeout(() => resolve([]), 1500); }),
    ]);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

export function createRequestHandler({
  codex, desktop, attachments, fileUploads, visualizations, downloads, deviceId, browser,
  deviceLabel = deviceId, mode = desktop ? 'desktop' : 'headless',
  networkAccess = false, allowFullAccess = false, onSessionStatuses,
}: Dependencies) {
  let desktopStatusCache: (SessionStatusSnapshot & { updatedAt: number }) | null = null;
  let desktopStatusRefresh: Promise<void> | null = null;
  let lastRefreshStarted = -Infinity;
  let revision = 0;
  const getDesktopStatuses = () => (
    desktopStatusCache && Date.now() - desktopStatusCache.updatedAt <= SESSION_STATUS_MAX_AGE_MS
      ? { revision: desktopStatusCache.revision, threads: desktopStatusCache.threads } : null
  );
  const refreshDesktopThreads = (callerThreadId: unknown) => {
    const caller = String(callerThreadId || '').trim();
    if (mode !== 'desktop' || !desktop || !caller || desktopStatusRefresh
      || Date.now() - lastRefreshStarted < DESKTOP_STATUS_REFRESH_MS) return;
    lastRefreshStarted = Date.now();
    desktopStatusRefresh = desktop.listThreads({ callerThreadId: caller, limit: 50 })
      .then((threads) => {
        const rows = (Array.isArray(threads) ? threads : []).slice().sort((a, b) => a.id.localeCompare(b.id));
        const changed = !desktopStatusCache || Date.now() - desktopStatusCache.updatedAt > SESSION_STATUS_MAX_AGE_MS
          || JSON.stringify(rows) !== JSON.stringify(desktopStatusCache.threads);
        desktopStatusCache = { threads: rows, updatedAt: Date.now(), revision: ++revision };
        if (changed) onSessionStatuses?.({ revision, threads: rows });
      })
      .catch(() => { /* app-server status remains the fallback when Desktop is unavailable */ })
      .finally(() => { desktopStatusRefresh = null; });
  };
  return async function handleRequest(message: BridgeRequest) {
    const {
      action, payload = {}, requestId, clientId, clientDeviceId,
    } = message;
    try {
      const run = () => dispatchAction({
        action, payload, requestId, clientId, clientDeviceId,
        codex, desktop, attachments, fileUploads, visualizations, downloads, deviceId, deviceLabel, mode, browser,
        networkAccess, allowFullAccess, getDesktopStatuses, refreshDesktopThreads,
      });
      const data = await (MEASURED_ACTIONS.has(action) ? measureOperation(action, run) : run());
      return { type: 'response', clientId, requestId, ok: true, data };
    } catch (error) {
      return { type: 'response', clientId, requestId, ok: false, error: publicError(error) };
    }
  };
}

async function dispatchAction({
  action, payload, requestId, clientId, clientDeviceId,
  codex, desktop, attachments, fileUploads, visualizations, downloads, deviceId, deviceLabel, mode, browser,
  networkAccess, allowFullAccess, getDesktopStatuses, refreshDesktopThreads,
}: DispatchContext) {
  if (action === 'connector.diagnostics') return { operations: operationMetrics() };
  if (action.startsWith('browser.')) {
    if (!browser) throw new Error('browser_control_not_enabled_on_connector');
    if (!clientId || !clientDeviceId) throw new Error('browser_authenticated_device_required');
    const client = { clientId, clientDeviceId };
    if (action === 'browser.bind') {
      // Validate the existing Session. Never create, resume, or send a prompt here.
      return browser.validateAndBind(client, payload.threadId, payload.target, (threadId) => codex.readSession(threadId), {
        replaceExisting: payload.replaceExisting === true, recoverOnly: payload.recoverOnly === true,
      });
    }
    if (action === 'browser.status') return browser.status(payload.threadId);
    if (action === 'browser.adopt') return browser.adopt(client, payload.operationRequestId, payload.parentGrantId, payload.target);
    if (action === 'browser.restore') return browser.restore(client, payload.grantId, payload.target);
    if (action === 'browser.navigate') return browser.navigate(client, payload.grantId, payload.target);
    if (action === 'browser.heartbeat') return browser.heartbeat(client, payload.grantId);
    if (action === 'browser.revoke') return browser.revoke(client, payload.grantId);
    if (action === 'browser.result') return browser.result(client, payload);
    throw new Error('browser_unknown_action');
  }
  if (action === 'connector.status') {
    const desktopState = mode === 'desktop' ? await desktop?.getCapabilities?.() : undefined;
    const supports = (...tools: string[]) => desktopState?.available === true && tools.every(tool => desktopState.tools.includes(tool));
    return {
      deviceId,
      deviceLabel,
      mode,
      platform: process.platform,
      codexOnline: Boolean(codex.child),
      ...(mode === 'desktop' ? { desktopOnline: desktopState?.available === true, desktopTools: desktopState?.tools || [], desktopInputOnline: desktopState?.inputAvailable === true } : {}),
      activeTurn: codex.activeTurns.size > 0,
      capabilities: { sessionDelete: mode === 'headless', networkAccess, fullAccess: allowFullAccess,
        ...(mode === 'desktop' && desktop?.controls && desktopState?.inputAvailable ? { desktopNativeState: true, desktopNativeImages: Boolean(attachments.nativeInput) } : {}),
        ...(mode === 'desktop' && desktop?.archiveThread && supports('read_thread', 'set_thread_archived') ? { sessionArchive: true, sessionArchivePendingApproval: true } : {}),
        ...(mode === 'desktop' && desktop?.restoreThread && supports('set_thread_archived') ? { sessionRestore: true } : {}),
        ...(fileUploads ? { fileUpload: true } : {}), ...(browser ? { browserControl: true, browserGrantReplacement: true } : {}) },
    };
  }
  if (action === 'sessions.list') {
    const sessions = await codex.listSessions({ cwd: payload.cwd });
    const desktopStatuses = getDesktopStatuses();
    refreshDesktopThreads(sessions[0]?.id);
    return {
      sessions: mergeDesktopSessionStatuses(
        sessions,
        desktopStatuses?.threads || [],
        [...codex.activeTurns.values()].map(turn => turn.threadId),
      ),
      desktopStatuses,
    };
  }
  if (action === 'session.read') return codex.readSession(String(payload.threadId || ''));
  if (action === 'session.archive') {
    if (mode !== 'desktop' || !desktop?.archiveThread) throw new Error('session_archive_unsupported');
    if (payload.confirm !== true) throw new Error('session_archive_confirmation_required');
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw new Error('thread_id_required');
    if (codex.getActiveTurn(threadId)) {
      throw new Error('session_archive_not_idle');
    }
    const result = await desktop.archiveThread({ threadId, cancelPendingApproval: payload.cancelPendingApproval === true });
    if (result.threadId !== threadId || result.archived !== true) throw new Error('session_delivery_mismatch');
    browser?.clearSession(threadId);
    return result;
  }
  if (action === 'session.restore') {
    if (mode !== 'desktop' || !desktop?.restoreThread) throw new Error('session_restore_unsupported');
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) throw new Error('thread_id_required');
    const result = await desktop.restoreThread({ threadId });
    if (result.threadId !== threadId || result.archived !== false) throw new Error('session_delivery_mismatch');
    return result;
  }
  if (action === 'session.delete') {
    if (mode !== 'headless') throw new Error('session_delete_headless_only');
    if (payload.confirm !== true) throw new Error('session_delete_confirmation_required');
    const result = await codex.deleteSession(payload.threadId);
    browser?.clearSession(result.threadId);
    return result;
  }
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
      questionIds: payload.questionIds,
    });
  }
  if (action === 'session.turn.diff.read') {
    return codex.readTurnDiff(String(payload.threadId || ''), String(payload.turnId || ''));
  }
  if (action === 'session.model-config.read') {
    if (mode === 'desktop') {
      if (!desktop?.controls || !codex.listModels) throw new Error('desktop_input_unsupported');
      const threadId = String(payload.threadId || '');
      const catalog = headerModelCatalog(codex);
      try { return await desktop.controls.modelConfig(threadId, catalog); }
      catch (error) {
        if (!codex.readStoredModelConfig) throw error;
        return measureOperation('model.persisted', () => codex.readStoredModelConfig!(threadId, catalog));
      }
    }
    return codex.readModelConfig(String(payload.threadId || ''));
  }
  if (action === 'session.model-config.update') {
    if (mode === 'desktop') {
      if (!desktop?.controls || !codex.listModels) throw new Error('desktop_input_unsupported');
      return desktop.controls.updateModel(String(payload.threadId || ''), payload, await codex.listModels());
    }
    return codex.updateModelConfig(String(payload.threadId || ''), payload);
  }
  if (action === 'session.permissions.read') {
    if (mode === 'desktop' && desktop?.controls?.permissions) {
      const threadId = String(payload.threadId || '');
      try {
        return await desktop.controls.permissions(threadId, { networkAccess: Boolean(networkAccess), allowFullAccess: Boolean(allowFullAccess) });
      } catch (error) {
        if ((error as Error).message !== 'desktop_input_not_ready' || !codex.readStoredPermissionConfig) throw error;
        return { ...await codex.readStoredPermissionConfig(threadId), allowFullAccess: Boolean(allowFullAccess) };
      }
    }
    const desktopState = mode === 'desktop' ? await desktop?.getCapabilities?.() : undefined;
    return {
      ...await codex.readPermissionMode(String(payload.threadId || ''), { fresh: mode === 'desktop' }),
      editable: mode === 'headless',
      networkAccess,
      allowFullAccess,
      ...(mode === 'desktop' && desktop?.openThread && desktopState?.available && desktopState.tools.includes('navigate_to_codex_page') ? { canOpenOnDesktop: true } : {}),
    };
  }
  if (action === 'session.desktop.open') {
    if (mode !== 'desktop' || !desktop?.openThread) throw new Error('desktop_app_unavailable');
    return desktop.openThread({ threadId: payload.threadId });
  }
  if (action === 'session.permissions.update') {
    if (mode === 'desktop' && desktop?.controls?.updatePermissions) {
      const threadId = String(payload.threadId || '').trim();
      try {
        return await desktop.controls.updatePermissions(threadId, payload,
          { networkAccess: Boolean(networkAccess), allowFullAccess: Boolean(allowFullAccess) });
      } catch (error) {
        // Only a pre-mutation owner lookup failure can use the cold path.
        if ((error as Error).message !== 'desktop_input_not_ready' || !codex.updateStoredPermissionConfig) throw error;
        return { ...await codex.updateStoredPermissionConfig(threadId, payload), allowFullAccess: Boolean(allowFullAccess) };
      }
    }
    if (mode !== 'headless') throw new Error('desktop_permission_mode_managed_on_computer');
    return {
      ...await codex.updatePermissionMode(String(payload.threadId || ''), payload.mode),
      editable: true,
      networkAccess,
      allowFullAccess,
    };
  }
  if (action === 'attachment.upload') return attachments.save(payload);
  if (action.startsWith('file.upload.')) {
    if (!fileUploads) throw new Error('file_upload_unsupported');
    const owner = clientDeviceId || clientId || '';
    if (action === 'file.upload.begin') return fileUploads.begin(payload, owner);
    if (action === 'file.upload.chunk') return fileUploads.chunk(payload, owner);
    if (action === 'file.upload.complete') return fileUploads.complete(payload, owner);
    if (action === 'file.upload.cancel') return fileUploads.cancel(payload, owner);
    throw new Error('unsupported_action');
  }
  if (action === 'attachment.read') return attachments.read(payload);
  if (action === 'visualization.read') return visualizations.read(payload);
  const downloadOwner = clientDeviceId || clientId;
  if (action === 'file.download.open') return downloads.open(payload, downloadOwner);
  if (action === 'file.download.chunk') return downloads.read(payload, downloadOwner);
  if (action === 'file.download.close') return downloads.close(payload, downloadOwner);
  if (action === 'file.markdown.read') return downloads.readMarkdown(payload);
  if (action === 'file.text.read') return downloads.readText(payload);
  if (action === 'turn.start') return startTurn({
    codex, desktop, mode, payload, clientId, requestId, browser, attachments,
  });
  if (action === 'turn.steer') {
    return {
      ...await sendWithBrowserContext(browser, String(payload.threadId || '').trim(), payload.text,
        (text) => codex.steerTurn({ ...payload, text, clientId, requestId })),
      delivery: 'appServer',
    };
  }
  if (action === 'session.desktop.state') {
    if (mode !== 'desktop' || !desktop?.controls) throw new Error('desktop_input_unsupported');
    return desktop.controls.read(String(payload.threadId || ''));
  }
  if (action === 'turn.stop') {
    if (payload.source === 'desktop') {
      if (mode !== 'desktop' || !desktop?.controls) throw new Error('desktop_input_unsupported');
      return desktop.controls.stop(String(payload.threadId || ''), payload.expectedTurnId);
    }
    return codex.stopTurn(payload.threadId);
  }
  if (action === 'approval.pending') {
    const pending = await codex.listApprovals(payload.threadId, clientId);
    if (pending.approvals?.length || pending.activeTurn) return pending;
    const threadId = String(payload.threadId || '').trim();
    if (!threadId) return pending;
    if (mode !== 'desktop' || !desktop) return pending;
    try {
      if (desktop.controls) {
        const state = await desktop.controls.read(threadId);
        return { ...pending, approvals: state.approvals, desktopState: state,
          ...(state.waitingOnApproval && !state.approvals.length ? { externalApproval: {
            approvalId: '', threadId, kind: 'desktop', source: 'desktop', actionable: false,
          } } : {}) };
      }
      const state = await desktop.readThreadState({
        threadId,
      });
      if (state.waitingOnApproval) {
        return {
          ...pending,
          desktopState: state,
          externalApproval: {
            approvalId: '',
            threadId,
            kind: 'desktop',
            summary: 'This approval is owned by Codex Desktop.',
            actionable: false,
          },
        };
      }
      return { ...pending, desktopState: state };
    } catch {
      // Unknown is not approval resolution. Keep the last state and retry.
      return { ...pending, desktopStatusUnavailable: true };
    }
  }
  if (action === 'approval.respond') {
    if (String(payload.approvalId || '').startsWith('desktop:')) {
      if (mode !== 'desktop' || !desktop?.controls) throw new Error('desktop_input_unsupported');
      if (typeof payload.approved !== 'boolean') throw new Error('approval_decision_required');
      return desktop.controls.respond(String(payload.threadId || ''), payload.approvalId, payload.approved);
    }
    return codex.respondApproval(payload.approvalId, payload.approved === true, payload.threadId);
  }
  throw new Error('unsupported_action');
}

async function startTurn({
  codex, desktop, mode, payload, clientId, requestId, browser, attachments,
}: Pick<DispatchContext, 'codex' | 'desktop' | 'mode' | 'payload' | 'clientId' | 'requestId' | 'browser' | 'attachments'>) {
  const threadId = String(payload.threadId || '').trim();
  if (!threadId || mode === 'headless') {
    // A reloaded/reconnected browser may have missed turn.started. Resolve
    // delivery from the connector's ownership, never from browser hints.
    const active = threadId ? codex.getActiveTurn(threadId) : null;
    const steer = threadId && active?.threadId === threadId
      && active.state === 'running' && active.turnId;
    return { ...await sendWithBrowserContext(browser, threadId, payload.text,
      (text) => steer
        ? codex.steerTurn({ ...payload, text, clientId, requestId })
        : codex.startTurn({ ...payload, text, clientId, requestId })), delivery: 'appServer' };
  }
  // Existing Desktop tasks must keep their original writer. Starting or
  // resuming them through the bridge's app-server creates a second writer and
  // makes later Desktop delivery fail with "already has an active writer".
  if (!desktop) throw new Error('desktop_app_unavailable');
  const imagePath = payload.image && attachments.nativeInput ? await attachments.nativeInput(payload.image) : undefined;
  if (payload.image && !imagePath) throw new Error('desktop_image_unsupported');
  await codex.prepareDesktopTurn?.();
  return sendWithBrowserContext(browser, threadId, payload.text, (text) => desktop.sendMessage({
    threadId,
    text,
    requestId,
    ...(imagePath ? { imagePath } : {}),
  }));
}

function sendWithBrowserContext<T>(browser: BrowserSessionBroker | undefined, threadId: string, text: unknown, deliver: (text: unknown) => Promise<T>) {
  return browser ? browser.withContext(threadId, text, deliver) : deliver(text);
}
