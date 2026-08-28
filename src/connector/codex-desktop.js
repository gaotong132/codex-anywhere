import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

const PIPE_PREFIX = 'codex-browser-use-';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class CodexDesktopClient {
  constructor(options = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.client = null;
  }

  async sendMessage({ threadId, text, requestId, callerThreadId }) {
    const targetThreadId = String(threadId || '').trim();
    const prompt = String(text || '').trim();
    if (!targetThreadId) throw new Error('thread_id_required');
    if (!prompt) throw new Error('message_required');
    let result;
    try {
      result = await this.callTool({
        tool: 'send_message_to_thread',
        arguments: { threadId: targetThreadId, prompt },
        callerThreadId: String(callerThreadId || targetThreadId),
        callId: `bridge-${requestId}`,
      });
    } catch (error) {
      if (/timeout/i.test(String(error?.message || error))) throw new Error('desktop_delivery_timeout');
      if (error?.code === 'desktop_host_error') {
        throw new Error(`desktop_delivery_failed:${error.message || 'unknown error'}`);
      }
      throw new Error('desktop_app_unavailable');
    }
    if (result?.success !== true) {
      const message = result?.contentItems?.map((item) => item?.text).filter(Boolean).join('\n');
      throw new Error(`desktop_delivery_failed:${message || 'unknown error'}`);
    }
    return { threadId: targetThreadId, delivery: 'desktop' };
  }

  async listThreads({ callerThreadId, limit = 50 } = {}) {
    const caller = String(callerThreadId || '').trim();
    if (!caller) return [];
    const result = await this.callTool({
      tool: 'list_threads',
      arguments: { limit: Math.min(50, Math.max(1, Number(limit) || 50)) },
      callerThreadId: caller,
      callId: `bridge-list-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_list_failed');
    const payload = parseToolPayload(result);
    const rows = [
      ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
      ...(Array.isArray(payload?.threads) ? payload.threads : []),
    ];
    return rows.filter((thread) => thread?.kind === 'codex' && thread?.id).map((thread) => ({
      id: String(thread.id),
      status: String(thread.status || 'unknown'),
    }));
  }

  async callTool({ tool, arguments: toolArguments, callerThreadId, callId }) {
    const client = await this.getClient();
    try {
      return await client.request('tools/call', {
        arguments: toolArguments,
        callId,
        namespace: 'codex_app',
        threadId: callerThreadId,
        tool,
        turnId: callId,
      }, this.timeoutMs);
    } catch (error) {
      client.close();
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  async getClient() {
    if (this.client?.connected) return this.client;
    if (process.platform !== 'win32') throw new Error('desktop_app_unavailable');
    let names;
    try {
      names = (await readdir('\\\\.\\pipe\\')).filter((name) => name.startsWith(PIPE_PREFIX));
    } catch {
      throw new Error('desktop_app_unavailable');
    }
    const candidates = await Promise.all(names.map((name) => probePipe(
      `\\\\.\\pipe\\${name}`, Math.min(this.timeoutMs, 5_000),
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

async function probePipe(pipePath, timeoutMs) {
  const client = new NativePipeClient(pipePath);
  try {
    const result = await client.request('tools/list', { threadStartKind: 'all' }, timeoutMs);
    if (!result?.tools?.some((tool) => tool.name === 'send_message_to_thread')) {
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
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
    this.pendingData = Buffer.alloc(0);
  }

  async request(method, params, timeoutMs) {
    await this.connect(timeoutMs);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeNativeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  connect(timeoutMs) {
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolveConnect, rejectConnect) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectConnect(new Error('desktop pipe connect timeout'));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error) => {
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
        socket.on('data', (chunk) => this.onData(socket, chunk));
        socket.on('error', (error) => this.onDisconnect(socket, error));
        socket.on('close', () => this.onDisconnect(socket, new Error('desktop pipe closed')));
        resolveConnect();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  onData(socket, chunk) {
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
      let response;
      try { response = JSON.parse(payload.toString('utf8')); } catch { continue; }
      const pending = this.pending.get(Number(response.id));
      if (!pending) continue;
      this.pending.delete(Number(response.id));
      clearTimeout(pending.timer);
      if (response.error) {
        const error = new Error(response.error.message || 'desktop request failed');
        error.code = 'desktop_host_error';
        pending.reject(error);
      } else pending.resolve(response.result);
    }
  }

  onDisconnect(socket, error) {
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

function encodeNativeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseToolPayload(result) {
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

export function mergeDesktopSessionStatuses(sessions, desktopThreads) {
  const statuses = new Map((desktopThreads || []).map((thread) => [thread.id, thread.status]));
  return (sessions || []).map((session) => statuses.has(session.id)
    ? { ...session, status: statuses.get(session.id) }
    : session);
}

export const internals = { encodeNativeFrame, parseToolPayload };
