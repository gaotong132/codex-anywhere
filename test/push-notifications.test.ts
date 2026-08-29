import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import webPush from 'web-push';
import { PushNotificationService } from '../src/server/push-notifications.js';

const DEVICE = { id: 'browser-test', publicKey: 'browser-public-key' };
const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscription/one',
  expirationTime: null,
  keys: {
    p256dh: 'A'.repeat(88),
    auth: 'B'.repeat(22),
  },
};

test('Web Push stores only approved subscriptions and sends generic event kinds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-push-'));
  const filePath = join(directory, 'push.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vapid = webPush.generateVAPIDKeys();
  const sent: Array<{ payload?: string; options?: { topic?: string } }> = [];
  let approved = true;
  const service = new PushNotificationService({
    ...vapid,
    subject: 'https://codex.example.test',
    filePath,
    isApproved: () => approved,
    sendNotification: (async (_subscription, payload, options) => {
      sent.push({ payload, options });
      return { statusCode: 201, headers: {}, body: '' };
    }) as typeof webPush.sendNotification,
  });

  assert.equal(service.subscribe(DEVICE, SUBSCRIPTION), true);
  await service.notify('completed', new Set([DEVICE.id]));
  assert.equal(sent.length, 0, 'an online browser handles its own local notification');

  await service.notify('completed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload, '{"kind":"completed"}');
  assert.equal(sent[0].options?.topic, 'codex-anywhere-completed');

  approved = false;
  await service.notify('approval');
  assert.equal(sent.length, 1, 'revoked devices must not receive a push');
  const stored = JSON.parse(await readFile(filePath, 'utf8')) as { subscriptions: unknown[] };
  assert.deepEqual(stored.subscriptions, []);
});

test('Web Push remains disabled when VAPID is not configured', () => {
  const service = new PushNotificationService({
    isApproved: () => true,
  });
  assert.equal(service.publicKey, '');
  assert.equal(service.subscribe(DEVICE, SUBSCRIPTION), false);
});

test('Web Push creates and reuses a protected VAPID key file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-vapid-'));
  const vapidFilePath = join(directory, 'vapid.json');
  const subscriptionsFilePath = join(directory, 'push.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const create = () => new PushNotificationService({
    subject: 'https://codex-anywhere.local',
    vapidFilePath,
    filePath: subscriptionsFilePath,
    isApproved: () => true,
  });

  const first = create();
  const second = create();
  assert.match(first.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(second.publicKey, first.publicKey);
  const stored = JSON.parse(await readFile(vapidFilePath, 'utf8')) as Record<string, string>;
  assert.equal(stored.publicKey, first.publicKey);
  assert.ok(stored.privateKey);
});
