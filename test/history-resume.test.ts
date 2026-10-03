import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { historyItems, mergeHistorySnapshot, type TimelineItem } from '../web/src/history-utils.js';
import { loadTimelineImages } from '../web/src/timeline-images.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';
import { MessageBubble } from '../web/src/message-bubble.js';

const row = (id: string, text: string, seconds: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id, kind: 'assistant', text, historyTurnId: 'long-turn', completedAt: 1_800_000_000 + seconds, ...extra,
});
const partial = (current: TimelineItem[], latest: TimelineItem[]) => mergeHistorySnapshot(
  current, latest, new Set(latest.map((item) => item.historyTurnId!)), { partial: true },
);

test('resume after a long turn retains inputs and images outside the bounded live tail', () => {
  const first = [row('page:0', 'question', 0, { kind: 'user' }),
    row('page:1', '', 1, { attachment: { path: '/first.png', name: 'first' } }),
    row('page:2', 'answer', 2)];
  const latest = [row('tail:0', 'answer', 2), row('tail:1', 'next update', 3, { kind: 'progress' })];
  let merged = partial(first, latest);
  assert.deepEqual(merged.map((item) => item.id), ['page:0', 'page:1', 'page:2', 'tail:1']);
  for (let index = 0; index < 5; index++) merged = partial(merged, latest);
  assert.equal(merged.length, 4);
  assert.equal(merged[1].attachment?.path, '/first.png');
});

test('moving tail indexes never reassign an old image DOM key to a different message', () => {
  const image = row('history:tail:0', '', 1, { attachment: { path: '/a.png', name: 'a' } });
  const update = row('history:tail:0', 'new message', 2);
  const merged = partial([image], [update]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, image.id);
  assert.notEqual(merged[1].id, image.id);
  assert.deepEqual(partial(merged, [update]), merged);
});

test('partial refresh preserves deliberately repeated text and orders omitted messages around common rows', () => {
  const old = [row('a', 'same', 1), row('b', 'image explanation', 2), row('c', 'same', 3)];
  const merged = partial(old, [row('new-c', 'same', 3), row('d', 'same', 4)]);
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(partial(merged, [row('new-d', 'same', 4)]), merged);
});

test('a growing progress block replaces its prefix instead of duplicating it in partial mode', () => {
  const current = [row('a', 'first update', 1, { kind: 'progress' })];
  const next = row('b', 'first update\n\nsecond update', 2, { kind: 'progress' });
  assert.deepEqual(partial(current, [next]).map((item) => [item.id, item.text]), [['a', next.text]]);
  const truncated = row('tail:0', 'second update\n\nthird update', 3, { kind: 'progress' });
  const merged = partial(partial(current, [next]), [truncated]);
  assert.deepEqual(merged.map((item) => [item.id, item.text]), [['a', 'first update\n\nsecond update\n\nthird update']]);
  assert.deepEqual(partial(merged, [truncated]), merged);
});

test('commentary images survive text coalescing and render their preview', () => {
  const items = historyItems([{ id: 'turn', items: [
    { type: 'agentMessage', phase: 'commentary', text: 'before' },
    { type: 'agentMessage', phase: 'commentary', text: '![preview](D:/preview.png)' },
    { type: 'agentMessage', phase: 'commentary', text: 'after' },
  ] }]);
  assert.equal(items.length, 3);
  assert.equal(items[1].attachment?.path, 'D:\\preview.png');
  const html = renderToStaticMarkup(createElement(MessageBubble, {
    item: items[1], imageSource: 'data:image/png;base64,aA==', onDownloadFile: () => {},
  }));
  assert.match(html, /<img /);
  const refreshed = partial(items, [{ ...items[2], id: 'new-progress' }]);
  assert.equal(refreshed.filter((item) => item.attachment).length, 1);
  assert.equal(new Set(refreshed.map((item) => item.id)).size, refreshed.length);
});

test('image reads are bounded and a failed request can be retried after reconnect', async () => {
  let active = 0;
  let peak = 0;
  const image = { mimeType: 'image/png', data: 'aA==', size: 1 };
  const request: BridgeRequest = (async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return image;
  }) as BridgeRequest;
  const attachments = Array.from({ length: 12 }, (_, index) => ({ path: `/${index}.png`, name: String(index) }));
  const published = new Map<string, string>();
  const signal = new AbortController().signal;
  await loadTimelineImages(attachments, request, signal, (path, url) => published.set(path, url));
  assert.equal(published.size, 12);
  assert.equal(peak, 3);
  await loadTimelineImages([attachments[0]], (async () => { throw new Error('request_timeout'); }) as BridgeRequest,
    signal, (path, url) => published.set(path, url));
  assert.equal(published.get('/0.png'), '');
  await loadTimelineImages([attachments[0]], request, signal, (path, url) => published.set(path, url));
  assert.ok(published.get('/0.png'));
});

test('late image responses after disconnect or session switch cannot publish or start more reads', async () => {
  let calls = 0;
  const pending: ((value: unknown) => void)[] = [];
  const request: BridgeRequest = (() => { calls++; return new Promise((resolve) => pending.push(resolve)); }) as BridgeRequest;
  const controller = new AbortController();
  const published: string[] = [];
  const done = loadTimelineImages(Array.from({ length: 5 }, (_, index) => ({ path: `/${index}`, name: '' })),
    request, controller.signal, (path) => published.push(path));
  controller.abort();
  pending.forEach((resolve) => resolve({ mimeType: 'image/png', data: 'aA==' }));
  await done;
  assert.equal(calls, 3);
  assert.deepEqual(published, []);
});
