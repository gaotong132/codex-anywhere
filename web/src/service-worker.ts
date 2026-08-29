/// <reference lib="webworker" />

const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('install', () => worker.skipWaiting());
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));
worker.addEventListener('push', (event) => {
  let kind: 'completed' | 'approval' = 'completed';
  try {
    const payload = event.data?.json() as { kind?: unknown } | undefined;
    if (payload?.kind === 'approval') kind = 'approval';
  } catch { /* use generic completion copy */ }
  const chinese = worker.navigator.language.toLowerCase().startsWith('zh');
  const body = kind === 'approval'
    ? chinese ? '有一项操作等待你的批准。' : 'An action is waiting for your approval.'
    : chinese ? 'Codex 已完成当前任务。' : 'Codex has finished the current task.';
  event.waitUntil(worker.registration.showNotification('Codex Anywhere', {
    body,
    tag: `codex-anywhere-${kind}`,
    data: { path: '/' },
  }));
});
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client): client is WindowClient => 'focus' in client);
    if (existing) {
      await existing.focus();
      return;
    }
    await worker.clients.openWindow('/');
  })());
});

export {};
