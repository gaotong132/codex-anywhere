import { WebSocket } from 'ws';

/**
 * Keep the retry timer referenced: after a WebSocket disconnect this may be
 * the connector's only active handle. Unref'ing it lets Node exit before the
 * reconnect attempt can run.
 */
export function scheduleReferencedRetry(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}

/** A suspended laptop can retain an OPEN TCP socket after the relay drops it. */
export function monitorConnectorSocket(socket: WebSocket, options: {
  now?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  onTimeout?: () => void;
} = {}) {
  const now = options.now || Date.now;
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  let lastActivity = now();
  let stopped = false;
  const alive = () => { lastActivity = now(); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const event of ['open', 'ping', 'pong', 'message'] as const) socket.off(event, alive);
    socket.off('close', stop);
  };
  const fail = () => { stop(); socket.terminate(); };
  const check = () => {
    if (stopped) return;
    if (socket.readyState === WebSocket.CLOSED) { stop(); return; }
    // Wall-clock time includes sleep; a tick after wake must not start a fresh
    // grace period for a socket that was already silent for minutes.
    if (now() - lastActivity >= staleAfterMs) {
      options.onTimeout?.();
      fail();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.ping((error?: Error) => { if (error && !stopped) fail(); }); }
      catch { fail(); }
    }
  };
  const timer = setInterval(check, options.intervalMs ?? 10_000);
  timer.unref();
  for (const event of ['open', 'ping', 'pong', 'message'] as const) socket.on(event, alive);
  socket.on('close', stop);
  return { check, stop };
}
