/// <reference lib="webworker" />

const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('install', () => worker.skipWaiting());
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));
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
