import { makeId, replayPendingFrames } from './app-utils';
import { t } from './i18n';
import type { BridgeMessage } from './app-types';
import type { FrameSendOptions, FrameSendProgress } from './websocket-send';

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 60_000;
const IMAGE_TRANSFER_REQUEST_TIMEOUT_MS = 120_000;
const TURN_START_REQUEST_TIMEOUT_MS = 11 * 60_000;

function defaultRequestTimeout(action: string) {
  if (action === 'turn.start') return TURN_START_REQUEST_TIMEOUT_MS;
  if (action === 'attachment.upload' || action === 'attachment.read') return IMAGE_TRANSFER_REQUEST_TIMEOUT_MS;
  return DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
}

export type BridgeRequestOptions = {
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onUploadProgress?: (progress: FrameSendProgress) => void;
};
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
  send: () => boolean;
};

type BridgeRequestManagerOptions = {
  isConnected: () => boolean;
  send: (frame: RequestFrame, options?: FrameSendOptions) => boolean;
  createId?: () => string;
};

export class BridgeRequestManager {
  private readonly isConnected: () => boolean;
  private readonly send: (frame: RequestFrame, options?: FrameSendOptions) => boolean;
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
      ? defaultRequestTimeout(action)
      : options.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      let transfer: AbortController | null = null;
      const cleanup = () => {
        this.pending.delete(requestId);
        transfer?.abort();
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
        send: () => {
          transfer?.abort();
          const attempt = options.onUploadProgress ? new AbortController() : null;
          transfer = attempt;
          return this.send(frame, attempt ? {
            signal: attempt.signal,
            onProgress: (progress) => {
              if (!attempt.signal.aborted && this.pending.get(requestId) === pending) options.onUploadProgress?.(progress);
            },
          } : undefined);
        },
      };
      onAbort = () => pending.reject(new Error('download_cancelled'));
      if (options.signal?.aborted) {
        pending.reject(new Error('download_cancelled'));
        return;
      }
      if (timeoutMs != null) {
        pending.timer = setTimeout(() => {
          pending.reject(Object.assign(
            new Error(action === 'turn.start' ? 'turn_start_timeout' : 'request_timeout'),
            { timeoutMs },
          ));
        }, timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, pending);
      try {
        if (!pending.send()) throw new Error('secure_channel_not_ready');
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
    return replayPendingFrames(this.pending.values(), (frame) => this.pending.get(String(frame.requestId))?.send() === true);
  }

  rejectAll(message: string) {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
  }

  get size() {
    return this.pending.size;
  }
}
