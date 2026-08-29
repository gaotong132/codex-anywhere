/**
 * Keep the retry timer referenced: after a WebSocket disconnect this may be
 * the connector's only active handle. Unref'ing it lets Node exit before the
 * reconnect attempt can run.
 */
export function scheduleReferencedRetry(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}
