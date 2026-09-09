import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPendingCompactions, finishTimelineCompaction, startTimelineCompaction } from '../web/src/compaction-timeline.js';
import { mergeHistorySnapshot, type TimelineItem } from '../web/src/history-utils.js';

const start = 1788970200000;
const marker = (sequence: number, completedAt: number, turnId = 'turn'): TimelineItem => ({
  id: `history:${sequence}`, kind: 'system', text: '', historyTurnId: turnId, completedAt,
  compaction: { sequence, contextWindow: 100000, beforeTokens: 90000, afterTokens: 10000 },
});
const merge = (current: TimelineItem[], latest: TimelineItem[]) => mergeHistorySnapshot(current, latest, new Set(['turn']));

test('live compaction finishes and hydrates in the same timeline slot without duplicate markers', () => {
  const message: TimelineItem = { id: 'message', kind: 'assistant', text: 'Working', historyTurnId: 'turn' };
  let items = startTimelineCompaction([message], 'turn', start);
  const id = items[1].id;
  assert.equal(items[1].compactionProgress?.status, 'inProgress');
  assert.equal(startTimelineCompaction(items, 'turn', start), items);
  items = finishTimelineCompaction(items, 'turn', start + 5000);
  assert.equal(items[1].id, id);
  assert.equal(items[1].compactionProgress?.status, 'completed');
  const persisted = [message, marker(3, start + 5000)];
  items = merge(items, persisted);
  assert.equal(items.length, 2);
  assert.equal(items[1].id, id);
  assert.equal(items[1].compaction?.sequence, 3);
  for (let index = 0; index < 3; index++) {
    items = merge(items, persisted);
    assert.equal(items.length, 2);
    assert.equal(items[1].id, id, 'later polling retains the original DOM key');
  }
  assert.equal(startTimelineCompaction(items, 'turn', start), items, 'late start metadata cannot resurrect a completed marker');
});

test('Desktop history completes the pending marker directly, while older and other-turn records remain distinct', () => {
  let items = startTimelineCompaction([], 'turn', start);
  const id = items[0].id;
  items = merge(items, [marker(2, start - 5000), marker(3, start + 4000, 'other')]);
  assert.equal(items.find(item => item.id === id)?.compactionProgress?.status, 'inProgress');
  items = merge(items, [marker(2, start - 5000), marker(3, start + 4000)]);
  assert.equal(items.filter(item => item.compaction?.sequence === 3 && item.historyTurnId === 'turn').length, 1);
  assert.equal(items.find(item => item.id === id)?.compactionProgress?.status, 'completed');
});

test('successive compactions in one turn retain independent identities even when a poll covers only the newest', () => {
  let items = startTimelineCompaction([], 'turn', start);
  const firstId = items[0].id;
  items = finishTimelineCompaction(items, 'turn', start + 1000);
  items = startTimelineCompaction(items, 'turn', start + 3000);
  const secondId = items[1].id;
  items = merge(items, [marker(5, start + 1000), marker(6, start + 5000)]);
  assert.deepEqual(items.map(item => item.id), [firstId, secondId]);
  items = merge(items, [marker(6, start + 5000)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, secondId);
  assert.equal(items[0].compaction?.sequence, 6);
});

test('failure or cancellation removes only pending compactions without claiming they completed', () => {
  const complete = finishTimelineCompaction(startTimelineCompaction([], 'turn', start), 'turn', start + 1000);
  const items = startTimelineCompaction(complete, 'turn', start + 2000);
  assert.deepEqual(clearPendingCompactions(items), complete);
  assert.equal(clearPendingCompactions(complete), complete);
  assert.deepEqual(startTimelineCompaction([], '', start), []);
});
