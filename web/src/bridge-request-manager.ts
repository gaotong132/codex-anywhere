import { makeId, replayPendingFrames } from './app-utils';
import { t } from './i18n';
import type { BridgeMessage } from './app-types';

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const TURN_START_REQUEST_TIMEOUT_MS = 11 * 60_000;

export type BridgeRequestOptions = { timeoutMs?: number | null; signal?: AbortSignal };
export type BridgeRequest = <T>(
  action: string,
  payload: Record<string, unknown>,
  options?: BridgeRequestOptions,
) => Promise<T>;

type RequestFrame = {
  type: 'request';
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  frame: RequestFrame;
  acknowledged: boolean;
};

type BridgeRequestManagerOptions = {
  isConnected: () => boolean;
  send: (frame: RequestFrame) => boolean;
  createId?: () => string;
};

export class BridgeRequestManager {
  private readonly isConnected: () => boolean;
  private readonly send: (frame: RequestFrame) => boolean;
  private readonly createId: () => string;
  private readonly pending = new Map<string, PendingRequest>();

  constructor({ isConnected, send, createId = makeId }: BridgeRequestManagerOptions) {
    this.isConnected = isConnected;
    this.send = send;
    this.createId = createId;
  }

  request<T>(
    action: string,
    payload: Record<string, unknown>,
    options: BridgeRequestOptions = {},
  ): Promise<T> {
    if (!this.isConnected()) {
      return Promise.reject(new Error(t('连接未建立', 'Connection is not established')));
    }
    const requestId = this.createId();
    const timeoutMs = options.timeoutMs === undefined
      ? (action === 'turn.start' ? TURN_START_REQUEST_TIMEOUT_MS : DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS)
      : options.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      };
      const frame: RequestFrame = { type: 'request', requestId, action, payload };
      const pending: PendingRequest = {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (reason) => { cleanup(); reject(reason); },
        timer: null,
        frame,
        acknowledged: false,
      };
      onAbort = () => pending.reject(new Error('download_cancelled'));
      if (options.signal?.aborted) {
        pending.reject(new Error('download_cancelled'));
        return;
      }
      if (timeoutMs != null) {
        pending.timer = setTimeout(() => {
          pending.reject(new Error(action === 'turn.start' ? 'turn_start_timeout' : 'request_timeout'));
        }, timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, pending);
      try {
        if (!this.send(frame)) throw new Error('secure_channel_not_ready');
      } catch {
        pending.reject(new Error(t('连接已断开', 'Connection closed')));
      }
    });
  }

  handle(message: BridgeMessage) {
    if (message.type === 'ack' && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (pending) pending.acknowledged = true;
      return true;
    }
    if (message.type !== 'response' || !message.requestId) return false;
    const pending = this.pending.get(message.requestId);
    if (!pending) return true;
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error || t('请求失败', 'Request failed')));
    return true;
  }

  replay() {
    return replayPendingFrames(this.pending.values(), (frame) => this.send(frame as RequestFrame));
  }

  rejectAll(message: string) {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
  }

  get size() {
    return this.pending.size;
  }
}
