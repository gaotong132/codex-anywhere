import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseAssistantMessage, parseUserMessage } from '../shared/message-content.js';
import { readRolloutTail } from './rollout-tail.js';
import { extractGeneratedImageAttachment } from './generated-images.js';
import { needsDesktopPermissionRecovery } from './session-permissions.js';

const RPC_TIMEOUT_MS = 20_000;
const SUMMARY_LIMIT = 4_000;
const DEFAULT_HISTORY_PAGE_SIZE = 6;
const MAX_HISTORY_PAGE_SIZE = 10;
const MAX_LIVE_PAGE_SIZE = 2;
const LARGE_ROLLOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ACTIVE_WRITER_WAIT_MS = 10 * 60_000;
const DEFAULT_ACTIVE_WRITER_RETRY_MS = 2_000;

type JsonObject = Record<string, any>;
type CodexAppServerOptions = {
  bin?: string;
  runtimeCwd?: string;
  allowedRoots?: string[];
  networkAccess?: boolean;
  activeWriterWaitMs?: number;
  activeWriterRetryMs?: number;
};
type PendingRpc = {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};
type PendingApproval = {
  id: string | number;
  method: string;
  params: JsonObject;
  threadId: string;
  kind: string;
  summary: string;
};
type SessionMetadata = { cwd: string; path: string; canAcceptDirectInput: boolean };
type TurnContext = {
  clientId?: string;
  requestId?: string;
  threadId: string;
  turnId: string;
  cwd: string;
  state: string;
};
type StartTurnOptions = {
  text?: unknown;
  threadId?: unknown;
  cwd?: unknown;
  clientId?: string;
  requestId?: string;
  waitForActiveWriter?: boolean;
};

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

export class CodexAppServer extends EventEmitter {
  bin: string;
  runtimeCwd: string;
  allowedRoots: string[];
  networkAccess: boolean;
  activeWriterWaitMs: number;
  activeWriterRetryMs: number;
  child: ChildProcessWithoutNullStreams | null;
  readyPromise: Promise<void> | null;
  nextId: number;
  pending: Map<number, PendingRpc>;
  approvals: Map<string, PendingApproval>;
  activeTurn: TurnContext | null;
  sessionMetadata: Map<string, SessionMetadata>;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.bin = options.bin || 'codex';
    this.runtimeCwd = resolve(options.runtimeCwd || process.cwd());
    const configuredRoots = Array.isArray(options.allowedRoots)
      ? options.allowedRoots.map((root) => String(root).trim()).filter(Boolean).map((root) => resolve(root))
      : [];
    this.allowedRoots = configuredRoots.length ? configuredRoots : [this.runtimeCwd];
    this.networkAccess = options.networkAccess === true;
    this.activeWriterWaitMs = Number.isFinite(options.activeWriterWaitMs)
      ? Math.max(0, Number(options.activeWriterWaitMs)) : DEFAULT_ACTIVE_WRITER_WAIT_MS;
    this.activeWriterRetryMs = Number.isFinite(options.activeWriterRetryMs)
      ? Math.max(1, Number(options.activeWriterRetryMs)) : DEFAULT_ACTIVE_WRITER_RETRY_MS;
    this.child = null;
    this.readyPromise = null;
    this.nextId = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.activeTurn = null;
    this.sessionMetadata = new Map();
  }

  async ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    if (this.child?.stdin?.writable) return;
    this.readyPromise = this.startProcess();
    try { await this.readyPromise; } finally { this.readyPromise = null; }
  }

  async startProcess(): Promise<void> {
    const child = spawn(this.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.runtimeCwd,
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('diagnostic', String(chunk).slice(-SUMMARY_LIMIT)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.handleExit(error));
    child.on('close', (code, signal) => this.handleExit(new Error(`codex app-server exited (${code ?? signal})`)));
    await this.rpcRaw('initialize', {
      clientInfo: { name: 'codex-anywhere', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  async listSessions(options: { cwd?: string } = {}) {
    await this.ensureStarted();
    const cwd = options.cwd ? resolveAllowedWorkspace(this.allowedRoots, options.cwd) : '';
    const result = await this.rpcRaw('thread/list', {
      limit: 100,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true,
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
      ...(cwd ? { cwd: process.platform === 'win32' ? [cwd, cwd.toLowerCase()] : cwd } : {}),
    });
    const rows: JsonObject[] = Array.isArray(result?.data) ? result.data : [];
    return rows.map((thread: JsonObject) => {
      const threadCwd = thread.cwd || cwd;
      if (thread.id) this.sessionMetadata.set(thread.id, {
        cwd: threadCwd,
        path: thread.path || '',
        canAcceptDirectInput: thread.canAcceptDirectInput !== false,
      });
      return {
        id: thread.id,
        title: thread.name || thread.title || thread.preview || thread.id,
        preview: thread.preview || '',
        cwd: threadCwd,
        updatedAt: thread.recencyAt || thread.updatedAt || thread.createdAt || null,
        status: thread.status?.type || 'unknown',
        canAcceptDirectInput: thread.canAcceptDirectInput !== false,
        canStartNewSession: Boolean(threadCwd) && isAllowedWorkspace(this.allowedRoots, threadCwd),
      };
    }).filter((thread: JsonObject) => thread.id);
  }

  async readSession(threadId: string) {
    await this.ensureStarted();
    const result = await this.rpcRaw('thread/read', { threadId, includeTurns: false });
    const recordedCwd = result?.thread?.cwd || this.sessionMetadata.get(threadId)?.cwd;
    if (!recordedCwd) throw new Error('session_project_directory_unavailable');
    const cwd = resolveAllowedWorkspace(this.allowedRoots, recordedCwd);
    this.sessionMetadata.set(threadId, {
      cwd,
      path: result?.thread?.path || this.sessionMetadata.get(threadId)?.path || '',
      canAcceptDirectInput: result?.thread?.canAcceptDirectInput !== false,
    });
    const history = await this.listSessionTurns(threadId);
    return {
      id: result?.thread?.id || threadId,
      title: result?.thread?.name || result?.thread?.title || result?.thread?.preview || threadId,
      cwd,
      turns: history.turns,
      nextCursor: history.nextCursor,
    };
  }

  async listSessionTurns(threadId: unknown, options: { mode?: string; limit?: unknown; cursor?: unknown } = {}) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    const mode = options.mode === 'live' ? 'live' : 'conversation';
    const maxLimit = mode === 'live' ? MAX_LIVE_PAGE_SIZE : MAX_HISTORY_PAGE_SIZE;
    const defaultLimit = mode === 'live' ? MAX_LIVE_PAGE_SIZE : DEFAULT_HISTORY_PAGE_SIZE;
    const parsedLimit = Number.parseInt(String(options.limit || defaultLimit), 10);
    const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(parsedLimit)
      ? parsedLimit : defaultLimit));
    const cursor = String(options.cursor || '').trim();
    let metadata = this.sessionMetadata.get(resolvedThreadId);
    if (mode === 'live' && !metadata?.path) {
      await this.listSessions();
      metadata = this.sessionMetadata.get(resolvedThreadId);
    }
    if (!cursor && mode === 'live' && metadata?.path) {
      return this.readSessionTail(resolvedThreadId, metadata.path);
    }
    if (!cursor && await this.isLargeSession(resolvedThreadId)) {
      return this.readSessionTail(resolvedThreadId, metadata?.path);
    }
    try {
      const result = await this.rpcRaw('thread/turns/list', {
        threadId: resolvedThreadId,
        limit,
        sortDirection: 'desc',
        itemsView: mode === 'live' ? 'full' : 'summary',
        ...(cursor ? { cursor } : {}),
      });
      return {
        threadId: resolvedThreadId,
        turns: mapTurns(result?.data),
        nextCursor: result?.nextCursor || null,
        truncated: false,
        source: 'appServer',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!cursor && metadata?.path && /RPC timeout: thread\/turns\/list/i.test(message)) {
        return this.readSessionTail(resolvedThreadId, metadata.path);
      }
      throw error;
    }
  }

  async isLargeSession(threadId: unknown) {
    const filePath = this.sessionMetadata.get(String(threadId || '').trim())?.path;
    if (!filePath) return false;
    try { return (await stat(filePath)).size >= LARGE_ROLLOUT_BYTES; } catch { return false; }
  }

  canOwnSession(threadId: unknown) {
    const cwd = this.sessionMetadata.get(String(threadId || '').trim())?.cwd;
    return Boolean(cwd && isAllowedWorkspace(this.allowedRoots, cwd));
  }

  async needsDesktopPermissionRecovery(threadId: unknown) {
    const resolvedThreadId = String(threadId || '').trim();
    let filePath = this.sessionMetadata.get(resolvedThreadId)?.path;
    if (!filePath) {
      await this.listSessions();
      filePath = this.sessionMetadata.get(resolvedThreadId)?.path;
    }
    return filePath ? needsDesktopPermissionRecovery(filePath) : false;
  }

  getControllerThreadId(targetThreadId: unknown) {
    const target = String(targetThreadId || '').trim();
    // Desktop requires a valid caller task for app tool requests. Prefer a
    // different known task so the destination stays writable and explicit.
    return [...this.sessionMetadata.keys()].find((threadId) => threadId !== target) || target;
  }

  async readSessionTail(threadId: string, filePath?: string) {
    if (!filePath) throw new Error('session_history_unavailable');
    return readRolloutTail({ filePath, threadId });
  }

  async startTurn({
    text, threadId, cwd, clientId, requestId, waitForActiveWriter = true,
  }: StartTurnOptions) {
    if (this.activeTurn) throw new Error('another_turn_is_active');
    let resolvedThreadId = String(threadId || '').trim();
    const isNewThread = !resolvedThreadId;
    if (!resolvedThreadId && !String(cwd || '').trim()) throw new Error('project_directory_required');
    let turnCwd = '';
    const turnContext = {
      clientId, requestId, threadId: resolvedThreadId, turnId: '', cwd: turnCwd, state: 'starting',
    };
    this.activeTurn = turnContext;
    try {
      await this.ensureStarted();
      if (resolvedThreadId) {
        const cachedMetadata = this.sessionMetadata.get(resolvedThreadId);
        if (cachedMetadata?.cwd) {
          turnCwd = resolveAllowedWorkspace(this.allowedRoots, cachedMetadata.cwd);
        } else {
          const metadata = await this.rpcRaw('thread/read', { threadId: resolvedThreadId, includeTurns: false });
          if (!metadata?.thread?.cwd) throw new Error('session_project_directory_unavailable');
          turnCwd = resolveAllowedWorkspace(this.allowedRoots, metadata.thread.cwd);
        }
      } else {
        turnCwd = resolveAllowedWorkspace(this.allowedRoots, cwd);
      }
      turnContext.cwd = turnCwd;
      const secureDefaults = {
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        config: {
          sandbox_mode: 'workspace-write',
          sandbox_workspace_write: {
            writable_roots: [turnCwd],
            network_access: this.networkAccess,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      };
      const threadParams = isNewThread ? { cwd: turnCwd, ...secureDefaults } : { cwd: turnCwd };
      if (resolvedThreadId) {
        const result = await this.resumeWhenWritable(
          resolvedThreadId, threadParams, turnContext, waitForActiveWriter,
        );
        resolvedThreadId = result?.thread?.id || result?.id || resolvedThreadId;
      } else {
        const result = await this.rpcRaw('thread/start', threadParams);
        resolvedThreadId = result?.thread?.id || result?.id || result?.threadId;
        if (!resolvedThreadId) throw new Error('codex_did_not_return_thread_id');
      }
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      const startResult = await this.rpcRaw('turn/start', {
        threadId: resolvedThreadId,
        input: [{ type: 'text', text: String(text || '') }],
        cwd: turnCwd,
        ...(isNewThread ? {
          approvalPolicy: secureDefaults.approvalPolicy,
          approvalsReviewer: secureDefaults.approvalsReviewer,
        } : {}),
      });
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      const turnId = String(startResult?.turn?.id || startResult?.turnId || '').trim();
      if (!turnId) throw new Error('codex_did_not_return_turn_id');
      turnContext.threadId = resolvedThreadId;
      turnContext.turnId = turnId;
      turnContext.state = 'running';
      this.emitTurn('turn.started', { threadId: resolvedThreadId, turnId });
      return { threadId: resolvedThreadId };
    } catch (error) {
      if (this.activeTurn === turnContext) this.activeTurn = null;
      throw error;
    }
  }

  async steerTurn({ text, threadId, clientId, requestId }: StartTurnOptions) {
    const targetThreadId = String(threadId || '').trim();
    const prompt = String(text || '').trim();
    if (!targetThreadId) throw new Error('thread_id_required');
    if (!prompt) throw new Error('message_required');
    const turnContext = this.activeTurn;
    if (
      !turnContext
      || turnContext.threadId !== targetThreadId
      || turnContext.state !== 'running'
      || !turnContext.turnId
    ) {
      throw new Error('turn_not_active');
    }
    turnContext.clientId = clientId;
    turnContext.requestId = requestId;
    const result = await this.rpcRaw('turn/steer', {
      threadId: targetThreadId,
      input: [{ type: 'text', text: prompt }],
      expectedTurnId: turnContext.turnId,
    });
    const acceptedTurnId = String(result?.turnId || '').trim();
    if (acceptedTurnId && acceptedTurnId !== turnContext.turnId) throw new Error('turn_id_mismatch');
    return { threadId: targetThreadId, turnId: turnContext.turnId, steered: true };
  }

  async resumeWhenWritable(
    threadId: string,
    threadParams: JsonObject,
    turnContext: TurnContext,
    waitForActiveWriter = true,
  ) {
    const deadline = Date.now() + this.activeWriterWaitMs;
    let waitingNotified = false;
    while (this.activeTurn === turnContext) {
      try {
        return await this.rpcRaw('thread/resume', { threadId, ...threadParams });
      } catch (error) {
        if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
        if (!isActiveWriterError(error)) throw error;
        if (!waitForActiveWriter) throw new Error('thread_active_writer_conflict');
        if (Date.now() >= deadline) throw new Error('thread_active_writer_timeout');
        if (!waitingNotified) {
          waitingNotified = true;
          turnContext.state = 'waiting';
          this.emitTurn('turn.waiting', {
            threadId,
            reason: 'active_writer',
            retryMs: this.activeWriterRetryMs,
          });
        }
        await wait(this.activeWriterRetryMs);
      }
    }
    throw new Error('turn_cancelled');
  }

  listApprovals(threadId: unknown, clientId?: string) {
    const targetThreadId = String(threadId || '').trim();
    if (clientId && this.activeTurn?.threadId === targetThreadId) {
      this.activeTurn.clientId = clientId;
    }
    return {
      approvals: [...this.approvals.entries()]
        .filter(([, pending]) => !targetThreadId || pending.threadId === targetThreadId)
        .map(([approvalId, pending]) => ({
          approvalId,
          threadId: pending.threadId,
          kind: pending.kind,
          summary: pending.summary,
        })),
    };
  }

  async respondApproval(approvalId: unknown, approved: boolean, threadId?: unknown) {
    const pending = this.approvals.get(String(approvalId));
    if (!pending) throw new Error('approval_not_found');
    const expectedThreadId = String(threadId || '').trim();
    if (expectedThreadId && pending.threadId !== expectedThreadId) throw new Error('approval_thread_mismatch');
    this.writeRpc({
      jsonrpc: '2.0',
      id: pending.id,
      result: approvalResult(
        pending.method, approved, pending.params, this.allowedRoots, this.networkAccess,
      ),
    });
    this.approvals.delete(String(approvalId));
    return { approvalId: String(approvalId), approved: approved === true };
  }

  async stopTurn() {
    if (!this.child) return { stopped: false };
    const previous = this.activeTurn;
    this.activeTurn = null;
    this.clearApprovalsForThread(previous?.threadId);
    this.child.kill();
    this.child = null;
    this.emit('turn-event', {
      clientId: previous?.clientId,
      requestId: previous?.requestId,
      event: 'turn.ended',
      payload: { reason: 'cancelled', threadId: previous?.threadId },
    });
    return { stopped: true };
  }

  async close() {
    if (this.child) this.child.kill();
    this.child = null;
  }

  async rpcRaw<T = any>(method: string, params: JsonObject = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const id = ++this.nextId;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    this.writeRpc({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  sendRpcNotification(method: string, params: JsonObject, includeId = false) {
    this.writeRpc({ jsonrpc: '2.0', ...(includeId ? { id: ++this.nextId } : {}), method, params });
  }

  writeRpc(message: JsonObject) {
    if (!this.child?.stdin?.writable) throw new Error('codex_app_server_offline');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string) {
    let message: JsonObject;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || message);
      return;
    }
    if (message.id != null && message.method) {
      this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message.method || '', message.params || {});
  }

  handleServerRequest(message: JsonObject) {
    const method = message.method || '';
    if (!APPROVAL_METHODS.has(method)) {
      this.writeRpc({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${method}` },
      });
      return;
    }
    const params = message.params || {};
    const approvalId = String(message.id);
    const threadId = String(params.threadId || params.conversationId || this.activeTurn?.threadId || '');
    const kind = approvalKind(method);
    const summary = approvalSummary(method, params);
    this.approvals.set(approvalId, {
      id: message.id, method, params, threadId, kind, summary,
    });
    this.emitTurn('approval.requested', {
      approvalId,
      threadId,
      kind,
      summary,
    });
  }

  handleNotification(method: string, params: JsonObject) {
    if (isReasoningMethod(method)) {
      const text = extractText(params);
      if (text) this.emitTurn('turn.reasoning', { text });
      return;
    }
    const itemType = String(params.item?.type || params.type || '');
    if (
      method === 'item/agentMessage/delta'
      || method === 'item/agent_message/delta'
      || (method.endsWith('/delta') && /agent.?message/i.test(itemType))
    ) {
      const delta = String(params.delta || '');
      if (delta) this.emitTurn('turn.delta', { delta, phase: params.phase || params.item?.phase || '' });
      return;
    }
    if (method === 'item/started') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) this.emitTurn('tool.started', summarizeItem(item));
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) {
        this.emitTurn('tool.completed', summarizeItem(item));
        return;
      }
      const text = extractText(item);
      if (text && item.phase === 'final_answer') this.emitTurn('turn.final', { text });
      return;
    }
    if (method === 'turn/completed' || method === 'turn.completed') {
      const previous = this.activeTurn;
      this.clearApprovalsForThread(previous?.threadId);
      this.emitTurn('turn.ended', { reason: 'completed', threadId: previous?.threadId, usage: params.usage || params.turn?.usage });
      this.activeTurn = null;
      return;
    }
    if (method === 'error' || method.includes('error')) {
      this.emitTurn('turn.error', { error: String(params.message || params.error?.message || 'Codex error').slice(0, SUMMARY_LIMIT) });
    }
  }

  clearApprovalsForThread(threadId: unknown) {
    const targetThreadId = String(threadId || '').trim();
    if (!targetThreadId) return;
    for (const [approvalId, pending] of this.approvals) {
      if (pending.threadId === targetThreadId) this.approvals.delete(approvalId);
    }
  }

  emitTurn(event: string, payload: JsonObject) {
    if (!this.activeTurn) return;
    this.emit('turn-event', {
      clientId: this.activeTurn.clientId,
      requestId: this.activeTurn.requestId,
      event,
      payload,
    });
  }

  handleExit(error: Error) {
    if (!this.child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
    if (this.activeTurn) {
      this.emitTurn('turn.error', { error: error.message });
      this.activeTurn = null;
    }
  }
}

function approvalKind(method: string) {
  if (/commandExecution|execCommand/i.test(method)) return 'command';
  if (/fileChange|applyPatch/i.test(method)) return 'file-change';
  if (/permissions/i.test(method)) return 'permission';
  if (/requestUserInput/i.test(method)) return 'user-input';
  return 'action';
}

function approvalSummary(method: string, params: JsonObject) {
  const value = params.command || params.reason || params.grantRoot || params.permissions
    || params.path || params.input || method;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, SUMMARY_LIMIT);
}

function approvalResult(
  method: string,
  approved: boolean,
  params: JsonObject = {},
  allowedRoots: string[] = [],
  networkAccess = false,
) {
  if (/permissions\/requestApproval/i.test(method)) {
    return approved
      ? { permissions: approvedPermissions(params.permissions, allowedRoots, networkAccess), scope: 'turn' }
      : { permissions: {}, scope: 'turn' };
  }
  if (/applyPatchApproval|execCommandApproval/i.test(method)) {
    return {
      decision: approved ? 'approved' : { denied: { rejection: 'Rejected from Codex Anywhere' } },
    };
  }
  return { decision: approved ? 'accept' : 'decline' };
}

function approvedPermissions(requested: JsonObject = {}, allowedRoots: string[], networkAccess: boolean) {
  const permissions: JsonObject = {};
  const requestedFileSystem = requested?.fileSystem;
  if (requestedFileSystem && typeof requestedFileSystem === 'object') {
    const read = filterAllowedPaths(requestedFileSystem.read, allowedRoots);
    const write = filterAllowedPaths(requestedFileSystem.write, allowedRoots);
    const entries = (Array.isArray(requestedFileSystem.entries) ? requestedFileSystem.entries : [])
      .filter((entry: JsonObject) => entry?.path?.type === 'path'
        && isAllowedWorkspace(allowedRoots, entry.path.path));
    if (read.length || write.length || entries.length) {
      permissions.fileSystem = {
        read: read.length ? read : null,
        write: write.length ? write : null,
        ...(entries.length ? { entries } : {}),
      };
    }
  }
  if (networkAccess && requested?.network?.enabled === true) {
    permissions.network = { enabled: true };
  }
  return permissions;
}

function filterAllowedPaths(values: unknown, allowedRoots: string[]) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value && isAllowedWorkspace(allowedRoots, value));
}

function summarizeItem(item: JsonObject) {
  return {
    type: item.type || '',
    status: item.status || '',
  };
}

function isReasoningMethod(method: string) {
  return /reasoning/i.test(method) && /delta|summary|completed/i.test(method);
}

function extractText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.delta === 'string') return value.delta;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.summary === 'string') return value.summary;
  if (Array.isArray(value.summary)) return value.summary.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.content)) return value.content.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.input)) return value.input.map(extractText).filter(Boolean).join('\n');
  if (value.item) return extractText(value.item);
  return '';
}

function mapTurns(turns: unknown) {
  return (Array.isArray(turns) ? turns : []).map((turn: JsonObject) => ({
    id: turn.id,
    status: turn.status?.type || turn.status || '',
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null,
    items: (Array.isArray(turn.items) ? turn.items : [])
      .filter((item: JsonObject) => {
        const type = String(item.type || '');
        return Boolean(extractGeneratedImageAttachment(item))
          || (!/reasoning|command|tool|webSearch|fileChange|system|developer/i.test(type)
            && /user|agent|assistant|message/i.test(type));
      })
      .map((item: JsonObject) => {
        const attachment = extractGeneratedImageAttachment(item);
        const userMessage = /user/i.test(String(item.type || ''));
        const completedAt = item.completedAt || item.updatedAt || item.createdAt || item.timestamp
          || (userMessage ? turn.startedAt : turn.completedAt) || null;
        const timing = completedAt ? { completedAt } : {};
        if (attachment) {
          return {
            type: 'agentMessage', phase: 'final_answer', status: item.status || '', text: '', attachment,
            ...timing,
          };
        }
        const content = userMessage
          ? parseUserMessage(extractText(item)) : parseAssistantMessage(extractText(item));
        return {
          type: item.type,
          phase: item.phase || '',
          status: item.status || '',
          ...content,
          ...timing,
        };
      })
      .filter((item: JsonObject) => item.text || item.attachment),
  }));
}

function isActiveWriterError(error: unknown) {
  return /already has an active writer/i.test(String(error instanceof Error ? error.message : error || ''));
}

function wait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function resolveAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  const rawCandidate = String(candidate || '').trim();
  if (!rawCandidate) throw new Error('project_directory_required');
  const requested = resolve(rawCandidate);
  const allowedRoots = (Array.isArray(roots) ? roots : [roots])
    .map((root) => String(root || '').trim())
    .filter(Boolean)
    .map((root) => resolve(root));
  for (const allowedRoot of allowedRoots) {
    const pathFromRoot = relative(allowedRoot, requested);
    if (!pathFromRoot || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
      return requested;
    }
  }
  throw new Error('workspace_outside_allowed_root');
}

function isAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  try {
    resolveAllowedWorkspace(roots, candidate);
    return true;
  } catch {
    return false;
  }
}

export const internals = {
  approvedPermissions, approvalKind, approvalResult, extractText, isActiveWriterError, mapTurns,
  isAllowedWorkspace, resolveAllowedWorkspace, summarizeItem,
};
