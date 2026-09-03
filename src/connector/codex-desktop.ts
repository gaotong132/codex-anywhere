import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { normalizeSessionName } from '../shared/session-name.js';

const PIPE_PREFIX = 'codex-browser-use-';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const STATUS_ENRICHMENT_TIMEOUT_MS = 1_000;

type JsonObject = Record<string, any>;
type DesktopClientOptions = { timeoutMs?: number };
type DesktopMessage = {
  threadId: unknown;
  text: unknown;
  requestId: unknown;
  callerThreadId?: unknown;
  model?: unknown;
  thinking?: unknown;
};
export type DesktopThreadStatus = { id: string; status: string };
type ToolCall = { tool: string; arguments: JsonObject; callerThreadId: string; callId: string };
type PendingNativeRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};
type DesktopHostError = Error & { code?: string };

export class CodexDesktopClient {
  timeoutMs: number;
  client: NativePipeClient | null;

  constructor(options: DesktopClientOptions = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    this.client = null;
  }

  async sendMessage({ threadId, text, requestId, callerThreadId, model, thinking }: DesktopMessage) {
    const targetThreadId = String(threadId || '').trim();
    const prompt = String(text || '').trim();
    if (!targetThreadId) throw new Error('thread_id_required');
    if (!prompt) throw new Error('message_required');
    let result: JsonObject;
    try {
      result = await this.callTool({
        tool: 'send_message_to_thread',
        arguments: {
          threadId: targetThreadId,
          prompt,
          ...(String(model || '').trim() ? { model: String(model).trim() } : {}),
          ...(String(thinking || '').trim() ? { thinking: String(thinking).trim() } : {}),
        },
        callerThreadId: String(callerThreadId || targetThreadId),
        callId: `bridge-${requestId}`,
      });
    } catch (error) {
      const desktopError = error as DesktopHostError;
      if (/timeout/i.test(String(desktopError?.message || error))) throw new Error('desktop_delivery_timeout');
      if (desktopError?.code === 'desktop_host_error') {
        throw new Error(`desktop_delivery_failed:${desktopError.message || 'unknown error'}`);
      }
      throw new Error('desktop_app_unavailable');
    }
    if (result?.success !== true) {
      const message = result?.contentItems?.map((item: JsonObject) => item?.text).filter(Boolean).join('\n');
      throw new Error(`desktop_delivery_failed:${message || 'unknown error'}`);
    }
    return { threadId: targetThreadId, delivery: 'desktop' };
  }

  async renameThread({ threadId, name, callerThreadId }: {
    threadId?: unknown;
    name?: unknown;
    callerThreadId?: unknown;
  }) {
    const targetThreadId = String(threadId || '').trim();
    const caller = String(callerThreadId || '').trim();
    if (!targetThreadId || targetThreadId.length > 256 || /[\0\r\n]/.test(targetThreadId) || !caller) {
      throw new Error('thread_id_required');
    }
    const title = normalizeSessionName(name);
    let result: JsonObject;
    try {
      result = await this.callTool({
        tool: 'set_thread_title',
        arguments: { threadId: targetThreadId, title },
        callerThreadId: caller,
        callId: `bridge-rename-${randomUUID()}`,
      });
    } catch (error) {
      const desktopError = error as DesktopHostError;
      if (/timeout/i.test(String(desktopError?.message || error))) throw new Error('desktop_rename_timeout');
      if (desktopError?.code === 'desktop_host_error') {
        throw new Error(`desktop_rename_failed:${desktopError.message || 'unknown error'}`);
      }
      throw new Error('desktop_app_unavailable');
    }
    if (result?.success !== true) {
      const message = result?.contentItems?.map((item: JsonObject) => item?.text).filter(Boolean).join('\n');
      throw new Error(`desktop_rename_failed:${message || 'unknown error'}`);
    }
    return { threadId: targetThreadId, title };
  }

  async listThreads({ callerThreadId, limit = 50 }: { callerThreadId?: unknown; limit?: number } = {}) {
    const caller = String(callerThreadId || '').trim();
    if (!caller) return [];
    const result = await this.callTool({
      tool: 'list_threads',
      arguments: { limit: Math.min(50, Math.max(1, Number(limit) || 50)) },
      callerThreadId: caller,
      callId: `bridge-list-${randomUUID()}`,
    }, { timeoutMs: STATUS_ENRICHMENT_TIMEOUT_MS, resetOnError: false });
    if (result?.success !== true) throw new Error('desktop_thread_list_failed');
    const payload = parseToolPayload(result);
    const rows = [
      ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
      ...(Array.isArray(payload?.threads) ? payload.threads : []),
    ];
    return rows.filter((thread: JsonObject) => thread?.kind === 'codex' && thread?.id).map((thread: JsonObject) => ({
      id: String(thread.id),
      status: String(thread.status || 'unknown'),
    }));
  }

  async readThreadState({ threadId, callerThreadId }: { threadId?: unknown; callerThreadId?: unknown }) {
    const targetThreadId = String(threadId || '').trim();
    const caller = String(callerThreadId || '').trim();
    if (!targetThreadId || !caller) throw new Error('thread_id_required');
    const result = await this.callTool({
      tool: 'read_thread',
      arguments: {
        threadId: targetThreadId,
        turnLimit: 1,
        includeOutputs: false,
        maxOutputCharsPerItem: 1_000,
      },
      callerThreadId: caller,
      callId: `bridge-read-state-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_read_failed');
    const payload = parseToolPayload(result);
    const status = payload?.thread?.status;
    const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
    return {
      status: String(status?.type || status || 'unknown'),
      waitingOnApproval: activeFlags.includes('waitingOnApproval'),
    };
  }

  async callTool(
    { tool, arguments: toolArguments, callerThreadId, callId }: ToolCall,
    options: { timeoutMs?: number; resetOnError?: boolean } = {},
  ): Promise<JsonObject> {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(250, Number(options.timeoutMs)) : this.timeoutMs;
    const client = await this.getClient(timeoutMs);
    try {
      return await client.request('tools/call', {
        arguments: toolArguments,
        callId,
        namespace: 'codex_app',
        threadId: callerThreadId,
        tool,
        turnId: callId,
      }, timeoutMs);
    } catch (error) {
      if (options.resetOnError !== false) {
        client.close();
        if (this.client === client) this.client = null;
      }
      throw error;
    }
  }

  async getClient(timeoutMs = this.timeoutMs): Promise<NativePipeClient> {
    if (this.client?.connected) return this.client;
    if (process.platform !== 'win32') throw new Error('desktop_app_unavailable');
    let names;
    try {
      names = (await readdir('\\\\.\\pipe\\')).filter((name) => name.startsWith(PIPE_PREFIX));
    } catch {
      throw new Error('desktop_app_unavailable');
    }
    const candidates = await Promise.all(names.map((name) => probePipe(
      `\\\\.\\pipe\\${name}`, Math.min(timeoutMs, 5_000),
    )));
    const client = candidates.find(Boolean);
    for (const candidate of candidates) {
      if (candidate && candidate !== client) candidate.close();
    }
    if (!client) throw new Error('desktop_app_unavailable');
    this.client = client;
    return client;
  }

  close() {
    this.client?.close();
    this.client = null;
  }
}

async function probePipe(pipePath: string, timeoutMs: number): Promise<NativePipeClient | null> {
  const client = new NativePipeClient(pipePath);
  try {
    const result = await client.request('tools/list', { threadStartKind: 'all' }, timeoutMs);
    if (!result?.tools?.some((tool: JsonObject) => tool.name === 'send_message_to_thread')) {
      client.close();
      return null;
    }
    return client;
  } catch {
    client.close();
    return null;
  }
}

class NativePipeClient {
  pipePath: string;
  socket: net.Socket | null;
  connected: boolean;
  connecting: Promise<void> | null;
  nextId: number;
  pending: Map<number, PendingNativeRequest>;
  pendingData: Buffer;

  constructor(pipePath: string) {
    this.pipePath = pipePath;
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
    this.pendingData = Buffer.alloc(0);
  }

  async request(method: string, params: JsonObject, timeoutMs: number): Promise<any> {
    await this.connect(timeoutMs);
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(encodeNativeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  connect(timeoutMs: number): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolveConnect, rejectConnect) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectConnect(new Error('desktop pipe connect timeout'));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        rejectConnect(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        this.socket = socket;
        this.connected = true;
        socket.on('data', (chunk) => this.onData(socket, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        socket.on('error', (error) => this.onDisconnect(socket, error));
        socket.on('close', () => this.onDisconnect(socket, new Error('desktop pipe closed')));
        resolveConnect();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  onData(socket: net.Socket, chunk: Buffer) {
    if (socket !== this.socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onDisconnect(socket, new Error('desktop response too large'));
        socket.destroy();
        return;
      }
      if (this.pendingData.length < length + 4) return;
      const payload = this.pendingData.subarray(4, length + 4);
      this.pendingData = this.pendingData.subarray(length + 4);
      let response: JsonObject;
      try { response = JSON.parse(payload.toString('utf8')); } catch { continue; }
      const pending = this.pending.get(Number(response.id));
      if (!pending) continue;
      this.pending.delete(Number(response.id));
      clearTimeout(pending.timer);
      if (response.error) {
        const error = new Error(response.error.message || 'desktop request failed') as DesktopHostError;
        error.code = 'desktop_host_error';
        pending.reject(error);
      } else pending.resolve(response.result);
    }
  }

  onDisconnect(socket: net.Socket, error: Error) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.connected = false;
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
}

function encodeNativeFrame(message: JsonObject) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseToolPayload(result: JsonObject): JsonObject {
  for (const candidate of [result?.structuredContent, result?.data, result?.output]) {
    if (candidate && typeof candidate === 'object') return candidate;
  }
  for (const item of Array.isArray(result?.contentItems) ? result.contentItems : []) {
    if (item?.json && typeof item.json === 'object') return item.json;
    if (typeof item?.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next content item */ }
  }
  throw new Error('desktop_thread_list_invalid');
}

export function mergeDesktopSessionStatuses<T extends { id: string; status?: string }>(
  sessions: T[], desktopThreads: DesktopThreadStatus[], locallyActiveThreadId = '',
) {
  const statuses = new Map((desktopThreads || []).map((thread) => [thread.id, thread.status]));
  return (sessions || []).map((session) => {
    if (session.id === locallyActiveThreadId) return { ...session, status: 'active' };
    return statuses.has(session.id)
      ? { ...session, status: statuses.get(session.id) }
      : session;
  });
}

export const internals = { encodeNativeFrame, parseToolPayload };
