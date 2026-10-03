import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationScroll } from '../web/src/conversation-scroll.js';
import { mergeHistorySnapshot, prependHistoryPage, type TimelineItem } from '../web/src/history-utils.js';

function viewport() {
  let top = 0;
  const rows = [{ id: 'a', y: 0, height: 300 }, { id: 'b', y: 300, height: 300 }, { id: 'c', y: 600, height: 400 }];
  const root = {
    clientHeight: 500, scrollHeight: 1000,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => rows.map((row) => ({
      dataset: { timelineId: row.id },
      getBoundingClientRect: () => ({ top: row.y - top + 100, bottom: row.y + row.height - top + 100 }),
    })),
  } as unknown as HTMLElement;
  return { root, rows, controller: new ConversationScroll() };
}

test('reading even 80px above the bottom survives live updates; reaching bottom resumes following', () => {
  const { root, controller } = viewport();
  controller.restore(root);
  root.scrollTop -= 80;
  assert.equal(controller.onScroll(root), true);
  root.scrollHeight += 120;
  controller.restore(root);
  assert.equal(root.scrollTop, 420);
  assert.equal(controller.following, false);
  root.scrollTop = root.scrollHeight;
  controller.onScroll(root);
  root.scrollHeight += 90;
  controller.restore(root);
  assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
  assert.equal(controller.onScroll(root), false, 'own correction is not user input');
});

test('prepend preserves the visible message rather than compensating for unrelated growth below it', () => {
  const { root, rows, controller } = viewport();
  root.scrollTop = 320;
  controller.pause(root);
  // A poll arrives while the older-history request is still pending.
  root.scrollHeight += 200;
  controller.restore(root);
  assert.equal(root.scrollTop, 320);
  rows.forEach((row) => { row.y += 450; });
  root.scrollHeight += 450;
  controller.restore(root);
  assert.equal(root.scrollTop, 770);
  // A lazy image above the anchor finishes decoding later.
  rows.forEach((row) => { row.y += 170; });
  root.scrollHeight += 170;
  controller.restore(root);
  assert.equal(root.scrollTop, 940);
});

test('user scrolling during a pending page replaces the old anchor; a removed anchor uses the next row', () => {
  const { root, rows, controller } = viewport();
  root.scrollTop = 320;
  controller.pause(root);
  root.scrollTop = 200;
  controller.onScroll(root);
  rows.forEach((row) => { row.y += 400; });
  root.scrollHeight += 400;
  rows.shift();
  controller.restore(root);
  assert.equal(root.scrollTop, 600);
});

test('upward input cancels a pending bottom correction and session reset discards anchors', () => {
  const { root, controller } = viewport();
  controller.restore(root);
  controller.forceBottom = true;
  controller.pause(root);
  root.scrollTop -= 20;
  controller.onScroll(root);
  controller.restore(root);
  assert.equal(root.scrollTop, 480);
  controller.reset();
  controller.restore(root);
  assert.equal(root.scrollTop, 500);
});

test('persisted image DOM identities survive moving rollout offsets and overlapping pagination', () => {
  const old: TimelineItem = { id: 'page:1', historyTurnId: 'rollout:1', kind: 'assistant', text: '',
    attachment: { name: 'image.png', path: 'C:/image.png' }, completedAt: 1_800_000_000_000 };
  const live = { ...old, id: 'tail:5', historyTurnId: 'tail:thread' };
  const merged = mergeHistorySnapshot([old], [live], new Set(['tail:thread']));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, old.id);
  const earlier = { ...old, id: 'previous', completedAt: 1_799_999_000_000 };
  const prepended = prependHistoryPage([earlier, old], merged);
  assert.deepEqual(prepended.map((item) => item.id), ['previous', 'page:1']);
});
