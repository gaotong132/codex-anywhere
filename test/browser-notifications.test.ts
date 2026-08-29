import assert from 'node:assert/strict';
import test from 'node:test';
import { browserNotificationCopy } from '../web/src/browser-notifications.js';

test('browser notification copy stays generic in Chinese', () => {
  assert.deepEqual(browserNotificationCopy('completed', 'zh-CN'), {
    title: 'Codex Anywhere',
    body: 'Codex 已完成当前任务。',
  });
  assert.deepEqual(browserNotificationCopy('approval', 'zh-CN'), {
    title: 'Codex Anywhere',
    body: '有一项操作等待你的批准。',
  });
});

test('browser notification copy stays generic in English', () => {
  assert.deepEqual(browserNotificationCopy('completed', 'en-US'), {
    title: 'Codex Anywhere',
    body: 'Codex has finished the current task.',
  });
});
