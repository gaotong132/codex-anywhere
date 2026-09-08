export type FrameSendProgress = { sentBytes: number; totalBytes: number };
export type FrameSendOptions = {
  signal: AbortSignal;
  onProgress: (progress: FrameSendProgress) => void;
};

type Socket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>;
const queuedBytes = new WeakMap<Socket, number>();

// Count every frame on a socket so later pings/requests cannot distort an
// earlier frame's progress. Drained bytes mean sent, not saved by the connector.
export function sendWebSocketFrame(socket: Socket, frame: unknown, options?: FrameSendOptions) {
  if (socket.readyState !== 1 || options?.signal.aborted) return false;
  const data = JSON.stringify(frame);
  const totalBytes = new TextEncoder().encode(data).byteLength;
  const start = queuedBytes.get(socket) || 0;
  socket.send(data);
  queuedBytes.set(socket, start + totalBytes);
  if (!options) return true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reported = -1;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
  };
  const sample = () => {
    if (stopped || options.signal.aborted || socket.readyState !== 1) { stop(); return; }
    const drained = (queuedBytes.get(socket) || 0) - socket.bufferedAmount;
    const sentBytes = Math.max(reported, Math.min(totalBytes, Math.max(0, drained - start)));
    if (sentBytes !== reported) {
      reported = sentBytes;
      options.onProgress({ sentBytes, totalBytes });
    }
    if (sentBytes === totalBytes || stopped) stop();
    else timer = setTimeout(sample, 100);
  };
  options.signal.addEventListener('abort', stop, { once: true });
  sample();
  return true;
}
