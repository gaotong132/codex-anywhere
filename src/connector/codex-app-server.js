import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { displayAssistantMessage, displayUserMessage } from '../shared/message-content.js';
import { readRolloutTail } from './rollout-tail.js';

const RPC_TIMEOUT_MS = 20_000;
const SUMMARY_LIMIT = 4_000;
const DEFAULT_HISTORY_PAGE_SIZE = 6;
const MAX_HISTORY_PAGE_SIZE = 10;
const MAX_LIVE_PAGE_SIZE = 2;
const LARGE_ROLLOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ACTIVE_WRITER_WAIT_MS = 10 * 60_000;
const DEFAULT_ACTIVE_WRITER_RETRY_MS = 2_000;

export class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin || 'codex';
    this.workspace = options.workspace || process.cwd();
    this.allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length
      ? options.allowedRoots.map((root) => resolve(String(root)))
      : [resolve(this.workspace)];
    resolveAllowedWorkspace(this.allowedRoots, this.workspace);
    this.networkAccess = options.networkAccess === true;
    this.activeWriterWaitMs = Number.isFinite(options.activeWriterWaitMs)
      ? Math.max(0, options.activeWriterWaitMs) : DEFAULT_ACTIVE_WRITER_WAIT_MS;
    this.activeWriterRetryMs = Number.isFinite(options.activeWriterRetryMs)
      ? Math.max(1, options.activeWriterRetryMs) : DEFAULT_ACTIVE_WRITER_RETRY_MS;
    this.child = null;
    this.readyPromise = null;
    this.nextId = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.activeTurn = null;
    this.sessionMetadata = new Map();
  }

  async ensureStarted() {
    if (this.readyPromise) return this.readyPromise;
    if (this.child?.stdin?.writable) return;
    this.readyPromise = this.startProcess();
    try { await this.readyPromise; } finally { this.readyPromise = null; }
  }

  async startProcess() {
    const child = spawn(this.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.workspace,
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

  async listSessions(options = {}) {
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
    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows.map((thread) => {
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
    }).filter((thread) => thread.id);
  }

  async readSession(threadId) {
    await this.ensureStarted();
    const result = await this.rpcRaw('thread/read', { threadId, includeTurns: false });
    const cwd = resolveAllowedWorkspace(this.allowedRoots, result?.thread?.cwd || this.workspace);
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

  async listSessionTurns(threadId, options = {}) {
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
      if (!cursor && metadata?.path && /RPC timeout: thread\/turns\/list/i.test(String(error?.message || error))) {
        return this.readSessionTail(resolvedThreadId, metadata.path);
      }
      throw error;
    }
  }

  async isLargeSession(threadId) {
    const filePath = this.sessionMetadata.get(String(threadId || '').trim())?.path;
    if (!filePath) return false;
    try { return (await stat(filePath)).size >= LARGE_ROLLOUT_BYTES; } catch { return false; }
  }

  getControllerThreadId(targetThreadId) {
    const target = String(targetThreadId || '').trim();
    // Codex Desktop owns existing-session delivery. A different known thread acts as
    // the tool caller so the target remains the destination; Desktop intentionally
    // exposes that provenance as a navigable “sent from another task” marker.
    return [...this.sessionMetadata.keys()].find((threadId) => threadId !== target) || target;
  }

  async readSessionTail(threadId, filePath) {
    if (!filePath) throw new Error('session_history_unavailable');
    return readRolloutTail({ filePath, threadId });
  }

  async startTurn({ text, threadId, cwd, clientId, requestId }) {
    if (this.activeTurn) throw new Error('another_turn_is_active');
    let resolvedThreadId = String(threadId || '').trim();
    let workspace = this.workspace;
    const turnContext = { clientId, requestId, threadId: resolvedThreadId, workspace, state: 'starting' };
    this.activeTurn = turnContext;
    try {
      await this.ensureStarted();
      if (resolvedThreadId) {
        const cachedMetadata = this.sessionMetadata.get(resolvedThreadId);
        if (cachedMetadata?.cwd) {
          workspace = resolveAllowedWorkspace(this.allowedRoots, cachedMetadata.cwd);
        } else {
          const metadata = await this.rpcRaw('thread/read', { threadId: resolvedThreadId, includeTurns: false });
          workspace = resolveAllowedWorkspace(this.allowedRoots, metadata?.thread?.cwd || this.workspace);
        }
      } else {
        workspace = resolveAllowedWorkspace(this.allowedRoots, cwd || this.workspace);
      }
      turnContext.workspace = workspace;
      const threadParams = {
        cwd: workspace,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        config: {
          sandbox_mode: 'workspace-write',
          sandbox_workspace_write: {
            writable_roots: [workspace],
            network_access: this.networkAccess,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
          },
        },
      };
      if (resolvedThreadId) {
        const result = await this.resumeWhenWritable(resolvedThreadId, threadParams, turnContext);
        resolvedThreadId = result?.thread?.id || result?.id || resolvedThreadId;
      } else {
        const result = await this.rpcRaw('thread/start', threadParams);
        resolvedThreadId = result?.thread?.id || result?.id || result?.threadId;
        if (!resolvedThreadId) throw new Error('codex_did_not_return_thread_id');
      }
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      turnContext.threadId = resolvedThreadId;
      turnContext.state = 'running';
      this.emitTurn('turn.started', { threadId: resolvedThreadId });
      this.sendRpcNotification('turn/start', {
        threadId: resolvedThreadId,
        input: [{ type: 'text', text: String(text || '') }],
        cwd: workspace,
      }, true);
      return { threadId: resolvedThreadId };
    } catch (error) {
      if (this.activeTurn === turnContext) this.activeTurn = null;
      throw error;
    }
  }

  async resumeWhenWritable(threadId, threadParams, turnContext) {
    const deadline = Date.now() + this.activeWriterWaitMs;
    let waitingNotified = false;
    while (this.activeTurn === turnContext) {
      try {
        return await this.rpcRaw('thread/resume', { threadId, ...threadParams });
      } catch (error) {
        if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
        if (!isActiveWriterError(error)) throw error;
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

  async respondApproval(approvalId, approved) {
    const pending = this.approvals.get(String(approvalId));
    if (!pending) throw new Error('approval_not_found');
    this.approvals.delete(String(approvalId));
    const workspace = this.activeTurn?.workspace || this.workspace;
    this.writeRpc({ jsonrpc: '2.0', id: pending.id, result: approvalResult(pending.method, approved, workspace) });
    return { approvalId: String(approvalId), approved: approved === true };
  }

  async stopTurn() {
    if (!this.child) return { stopped: false };
    const previous = this.activeTurn;
    this.activeTurn = null;
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

  async rpcRaw(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
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

  sendRpcNotification(method, params, includeId = false) {
    this.writeRpc({ jsonrpc: '2.0', ...(includeId ? { id: ++this.nextId } : {}), method, params });
  }

  writeRpc(message) {
    if (!this.child?.stdin?.writable) throw new Error('codex_app_server_offline');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
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

  handleServerRequest(message) {
    const method = message.method || '';
    const approvalId = String(message.id);
    this.approvals.set(approvalId, { id: message.id, method, params: message.params || {} });
    this.emitTurn('approval.requested', {
      approvalId,
      kind: approvalKind(method),
      summary: approvalSummary(method, message.params || {}),
    });
  }

  handleNotification(method, params) {
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
      this.emitTurn('turn.ended', { reason: 'completed', threadId: previous?.threadId, usage: params.usage || params.turn?.usage });
      this.activeTurn = null;
      return;
    }
    if (method === 'error' || method.includes('error')) {
      this.emitTurn('turn.error', { error: String(params.message || params.error?.message || 'Codex error').slice(0, SUMMARY_LIMIT) });
    }
  }

  emitTurn(event, payload) {
    if (!this.activeTurn) return;
    this.emit('turn-event', {
      clientId: this.activeTurn.clientId,
      requestId: this.activeTurn.requestId,
      event,
      payload,
    });
  }

  handleExit(error) {
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

function approvalKind(method) {
  if (/commandExecution|execCommand/i.test(method)) return 'command';
  if (/fileChange|applyPatch/i.test(method)) return 'file-change';
  if (/permissions/i.test(method)) return 'permission';
  if (/requestUserInput/i.test(method)) return 'user-input';
  return 'action';
}

function approvalSummary(method, params) {
  const value = params.command || params.tool || params.reason || params.path || params.input || params.questions || method;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, SUMMARY_LIMIT);
}

function approvalResult(method, approved, workspace) {
  if (/permissions\/requestApproval/i.test(method)) {
    return approved ? {
      permissions: {
        fileSystem: {
          read: [workspace], write: [workspace],
          entries: [
            { path: { type: 'path', path: workspace }, access: 'read' },
            { path: { type: 'path', path: workspace }, access: 'write' },
          ],
        },
        network: { enabled: false },
      },
      scope: 'session',
    } : { permissions: {}, scope: 'turn' };
  }
  if (/applyPatchApproval/i.test(method)) return { decision: approved ? 'approved' : 'denied' };
  if (/requestUserInput/i.test(method)) return { continue: approved === true };
  return { decision: approved ? 'accept' : 'reject' };
}

function summarizeItem(item) {
  const input = item.command || item.query || item.input || item.arguments || item.changes || item.path || '';
  const output = item.output || item.aggregatedOutput || item.result || '';
  return {
    id: item.id || '', type: item.type || '',
    name: item.name || item.tool || (item.type === 'commandExecution' ? 'exec' : item.type),
    input: (typeof input === 'string' ? input : JSON.stringify(input)).slice(0, SUMMARY_LIMIT),
    output: (typeof output === 'string' ? output : JSON.stringify(output)).slice(0, SUMMARY_LIMIT),
    status: item.status || '',
  };
}

function isReasoningMethod(method) {
  return /reasoning/i.test(method) && /delta|summary|completed/i.test(method);
}

function extractText(value) {
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

function mapTurns(turns) {
  return (Array.isArray(turns) ? turns : []).map((turn) => ({
    id: turn.id,
    status: turn.status?.type || turn.status || '',
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null,
    items: (Array.isArray(turn.items) ? turn.items : [])
      .filter((item) => {
        const type = String(item.type || '');
        return !/reasoning|command|tool|webSearch|fileChange|system|developer/i.test(type)
          && /user|agent|assistant|message/i.test(type);
      })
      .map((item) => ({
        type: item.type,
        phase: item.phase || '',
        status: item.status || '',
        text: /user/i.test(String(item.type || ''))
          ? displayUserMessage(extractText(item)) : displayAssistantMessage(extractText(item)),
      }))
      .filter((item) => item.text),
  }));
}

function isActiveWriterError(error) {
  return /already has an active writer/i.test(String(error?.message || error || ''));
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function resolveAllowedWorkspace(roots, candidate) {
  const allowedRoots = (Array.isArray(roots) ? roots : [roots])
    .map((root) => resolve(String(root || process.cwd())));
  const requested = resolve(String(candidate || allowedRoots[0]));
  for (const allowedRoot of allowedRoots) {
    const pathFromRoot = relative(allowedRoot, requested);
    if (!pathFromRoot || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
      return requested;
    }
  }
  throw new Error('workspace_outside_allowed_root');
}

function isAllowedWorkspace(roots, candidate) {
  try {
    resolveAllowedWorkspace(roots, candidate);
    return true;
  } catch {
    return false;
  }
}

export const internals = {
  approvalKind, approvalResult, extractText, isActiveWriterError, mapTurns,
  isAllowedWorkspace, resolveAllowedWorkspace, summarizeItem,
};
