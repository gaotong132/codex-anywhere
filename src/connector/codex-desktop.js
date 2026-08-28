import { readdir } from 'node:fs/promises';
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
    const client = await this.getClient();
    let result;
    try {
      result = await client.request('tools/call', {
        arguments: { threadId: targetThreadId, prompt },
        callId: `bridge-${requestId}`,
        namespace: 'codex_app',
        threadId: String(callerThreadId || targetThreadId),
        tool: 'send_message_to_thread',
        turnId: `bridge-${requestId}`,
      }, this.timeoutMs);
    } catch (error) {
      client.close();
      if (this.client === client) this.client = null;
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

export const internals = { encodeNativeFrame };
