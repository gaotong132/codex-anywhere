import { BrowserControlError } from './contracts.js';

// Native browser APIs may not support abort. Stop waiting for them and require
// callers to revalidate their grant before using any eventual result.
export async function boundedBrowserRead<T>(read: (signal: AbortSignal) => Promise<T>, revoked: AbortSignal, timeoutMs: number): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => { abort.abort(); reject(new BrowserControlError('browser_not_authorized')); };
    if (revoked.aborted) { onAbort(); return; }
    revoked.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      abort.abort();
      reject(new BrowserControlError('browser_request_expired'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new BrowserControlError('browser_not_authorized');
      return read(abort.signal);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    revoked.removeEventListener('abort', onAbort);
    abort.abort();
  }
}
