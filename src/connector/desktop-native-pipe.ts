import net from 'node:net';

type JsonObject = Record<string, any>;
// Matches the Desktop native app-tools host's payload limit (header excluded).
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
type PendingRequest = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class NativeRequestError extends Error {
  constructor(message: string, public readonly dispatched: boolean, public readonly code = 'desktop_transport_error') {
    super(message);
  }
}

export function encodeNativeFrame(message: JsonObject) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) throw new NativeRequestError('desktop_request_too_large', false);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativePipeClient {
  socket: net.Socket | null = null;
  connected = false;
  connecting: Promise<void> | null = null;
  tools = new Set<string>();
  private closed = false;
  private cancelConnect: (() => void) | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private pendingData = Buffer.alloc(0);

  constructor(public readonly pipePath: string) {}

  async request(method: string, params: JsonObject, timeoutMs: number): Promise<any> {
    const id = ++this.nextId;
    // Reject oversized requests before connecting or handing anything to the host.
    const frame = encodeNativeFrame({ jsonrpc: '2.0', id, method, params });
    await this.connect(timeoutMs);
    const socket = this.socket;
    if (!socket || socket.destroyed || this.closed) throw new NativeRequestError('desktop pipe closed', false);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Expiry does not cancel host execution and must not close a shared socket.
        reject(new NativeRequestError(`${method} timeout`, true));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(frame, (error) => {
          if (error) this.disconnect(socket, error);
        });
      } catch (error) {
        this.disconnect(socket, error as Error);
      }
    });
  }

  connect(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new NativeRequestError('desktop pipe closed', false));
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.off('connect', ready);
        this.cancelConnect = null;
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        reject(new NativeRequestError(error.message, false));
      };
      const ready = () => {
        clearTimeout(timer);
        this.cancelConnect = null;
        socket.off('error', fail);
        this.connected = true;
        socket.on('data', chunk => this.onData(socket, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        socket.on('error', error => this.disconnect(socket, error));
        socket.on('close', () => this.disconnect(socket, new Error('desktop pipe closed')));
        resolve();
      };
      const timer = setTimeout(() => fail(new Error('desktop pipe connect timeout')), timeoutMs);
      timer.unref?.();
      this.cancelConnect = () => fail(new Error('desktop pipe closed'));
      socket.once('error', fail);
      socket.once('connect', ready);
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private onData(socket: net.Socket, chunk: Buffer) {
    if (socket !== this.socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) {
        this.disconnect(socket, new Error('desktop response invalid frame size'));
        return;
      }
      if (this.pendingData.length < length + 4) return;
      const payload = this.pendingData.subarray(4, length + 4);
      this.pendingData = this.pendingData.subarray(length + 4);
      let response: JsonObject;
      try {
        response = JSON.parse(payload.toString('utf8'));
        if (!response || response.jsonrpc !== '2.0') throw new Error('invalid response');
      } catch {
        this.disconnect(socket, new Error('desktop response invalid JSON-RPC'));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue; // Includes late responses to expired requests.
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.reject(new NativeRequestError(response.error.message || 'desktop request failed', true, 'desktop_host_error'));
      } else pending.resolve(response.result);
    }
  }

  private disconnect(socket: net.Socket, error: Error) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.connected = false;
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeRequestError(error.message, true));
    }
    this.pending.clear();
    socket.destroy();
  }

  close() {
    this.closed = true;
    this.cancelConnect?.();
    if (this.socket) this.disconnect(this.socket, new Error('desktop pipe closed'));
  }
}
