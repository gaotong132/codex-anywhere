import { EventEmitter } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeNativeFrame, MAX_FRAME_BYTES, NativeRequestError } from './desktop-native-pipe.js';

type Message = Record<string, any>;
type Pending = { method: string; targetClientId?: string; resolve(value: Message): void; reject(error: Error): void; timer: NodeJS.Timeout };

// Desktop's owner/follower IPC is length-prefixed JSON, NOT the app-tools JSON-RPC pipe.
// Versions are deliberately pinned: a future incompatible Desktop must fail closed.
const versions = {
  'thread-owner-discovery': 1,
  'thread-follower-read-model-settings': 1,
  'thread-follower-update-thread-settings': 2,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
} as const;
export type InputMethod = keyof typeof versions;

export class DesktopInputPipe extends EventEmitter {
  private socket: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private clientId = '';
  private closed = false;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private cancelConnect: (() => void) | null = null;

  constructor(readonly path = '\\\\.\\pipe\\codex-ipc') { super(); }

  async request(method: InputMethod, params: Message, timeoutMs: number, targetClientId?: string): Promise<Message> {
    // Snapshot and bound input before any asynchronous connection/initialization.
    const snapshot = JSON.parse(JSON.stringify(params));
    encodeNativeFrame({ type: 'request', requestId: randomUUID(), sourceClientId: randomUUID(),
      method, version: versions[method], params: snapshot, targetClientId });
    await this.connect(timeoutMs);
    return this.dispatch(method, versions[method], snapshot, timeoutMs, targetClientId);
  }

  async follow(conversationId: string, owner: string, following: boolean, timeoutMs: number) {
    await this.connect(timeoutMs);
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new NativeRequestError('desktop input pipe closed', false);
    socket.write(encodeNativeFrame({ type: 'broadcast', sourceClientId: this.clientId,
      method: 'thread-stream-following-changed', version: 1, targetClientIds: [owner],
      params: { conversationId, hostId: 'local', following } }), error => { if (error) this.disconnect(socket, error); });
  }

  connect(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new NativeRequestError('desktop input pipe closed', false));
    if (this.ready) return this.ready;
    let connectingSocket: net.Socket;
    const connection = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.path);
      connectingSocket = socket;
      this.socket = socket;
      const timer = setTimeout(() => fail(new Error('desktop input connect timeout')), timeoutMs);
      timer.unref?.();
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.cancelConnect = null;
        socket.off('connect', connected);
        this.disconnect(socket, error);
        reject(new NativeRequestError(error.message, false));
      };
      const connected = () => {
        clearTimeout(timer);
        this.cancelConnect = null;
        socket.off('error', fail);
        socket.on('error', error => this.disconnect(socket, error));
        socket.on('close', () => this.disconnect(socket, new Error('desktop input pipe closed')));
        socket.on('data', chunk => this.onData(socket, Buffer.from(chunk)));
        resolve();
      };
      this.cancelConnect = () => fail(new Error('desktop input pipe closed'));
      socket.once('error', fail);
      socket.once('connect', connected);
    }).then(async () => {
      const response = await this.dispatch('initialize', 0, { clientType: 'codex-anywhere' }, timeoutMs);
      if (typeof response.result?.clientId !== 'string' || !response.result.clientId) {
        throw new Error('desktop input invalid initialization');
      }
      this.clientId = response.result.clientId;
    }).catch(error => {
      if (this.socket === connectingSocket) this.disconnect(connectingSocket, error);
      if (this.ready === connection) this.ready = null;
      // Initialization cannot have delivered a user message.
      throw new NativeRequestError(error.message, false);
    });
    this.ready = connection;
    return connection;
  }

  private dispatch(method: string, version: number, params: Message, timeoutMs: number, targetClientId?: string): Promise<Message> {
    const requestId = randomUUID();
    const frame = encodeNativeFrame({ type: 'request', requestId,
      sourceClientId: this.clientId || 'initializing-client', version, method, params,
      ...(targetClientId ? { targetClientId } : {}), timeoutMs });
    const socket = this.socket;
    if (!socket || socket.destroyed || this.closed) return Promise.reject(new NativeRequestError('desktop input pipe closed', false));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NativeRequestError(`${method} timeout`, true));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { method, targetClientId, resolve, reject, timer });
      try { socket.write(frame, error => { if (error) this.disconnect(socket, error); }); }
      catch (error) { this.disconnect(socket, error as Error); }
    });
  }

  private onData(socket: net.Socket, chunk: Buffer) {
    if (this.socket !== socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) return this.disconnect(socket, new Error('desktop input invalid frame size'));
      if (this.buffer.length < length + 4) return;
      let message: Message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
      catch { return this.disconnect(socket, new Error('desktop input invalid JSON')); }
      this.buffer = this.buffer.subarray(length + 4);
      if (!message || typeof message.type !== 'string') return this.disconnect(socket, new Error('desktop input invalid message'));
      if (message.type === 'client-discovery-request') {
        // We are a caller only. Never claim ownership or execute Desktop requests.
        socket.write(encodeNativeFrame({ type: 'client-discovery-response', requestId: message.requestId,
          response: { canHandle: false } }), error => { if (error) this.disconnect(socket, error); });
        continue;
      }
      if (message.type === 'broadcast') { this.emit('broadcast', message); continue; }
      if (message.type !== 'response') continue;
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === 'error') {
        pending.reject(new NativeRequestError(String(message.error || 'desktop input rejected'), true, 'desktop_host_error'));
      } else if (message.resultType !== 'success' || message.method !== pending.method || !message.handledByClientId
        || (pending.targetClientId && pending.targetClientId !== message.handledByClientId)) {
        pending.reject(new NativeRequestError('desktop input invalid response', true));
      } else pending.resolve(message);
    }
  }

  private disconnect(socket: net.Socket, error: Error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = null;
    this.clientId = '';
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeRequestError(error.message, true));
    }
    this.pending.clear();
    socket.destroy();
    this.emit('disconnected');
  }

  close() {
    this.closed = true;
    this.cancelConnect?.();
    if (this.socket) this.disconnect(this.socket, new Error('desktop input pipe closed'));
  }
}
