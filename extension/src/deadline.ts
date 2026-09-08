// Timing out does not cancel a Chrome API call. Callers must recheck consent
// before subsequent actions and dispose late resources without replaying writes.
export function withinDeadline<T>(work: Promise<T>, deadline: number, errorCode: string,
  disposeLate?: (value: T) => void | Promise<void>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true; reject(new Error(errorCode));
    }, Math.max(0, deadline - Date.now()));
    work.then(value => {
      if (settled) {
        if (disposeLate) void Promise.resolve().then(() => disposeLate(value)).catch(() => {});
        return;
      }
      settled = true; clearTimeout(timer); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
  });
}
