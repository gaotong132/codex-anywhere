import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { browserContext } from '../src/shared/browser-context.js';
import { parseUserMessage, parseAssistantMessage } from '../src/shared/message-content.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { internals as rollout } from '../src/connector/rollout-tail.js';
import { historyItems, mergeHistorySnapshot } from '../web/src/history-utils.js';

test('authorized and revoked browser context preserves one original user message across history paths', () => {
  const broker = new BrowserSessionBroker('pc', () => true);
  const client = { clientId: 'extension', clientDeviceId: 'browser-a' };
  const grant = broker.bind(client, 'task-a', {
    browserDeviceId: client.clientDeviceId, tabId: 1, documentId: 'doc-a', origin: 'https://example.com',
  });
  broker.heartbeat(client, grant.grantId);
  const original = '读取这个页面。\n\n保留我的说明。';
  for (const revoked of [false, true]) {
    if (revoked) broker.revoke(client, grant.grantId);
    const raw = String(broker.withContext('task-a', original));
    assert.match(raw, /anywhere_browser_list_pages/);
    assert.equal(parseUserMessage(raw).text, original);
    const delegated = `<codex_delegation><source_thread_id>task-a</source_thread_id><input>${raw}</input></codex_delegation>`;
    assert.equal(parseUserMessage(delegated).text, original);
    const rows = rollout.mapRolloutRows([{ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }],
    } }]);
    assert.equal(rows[0].text, original);
    const latest = historyItems(mapTurns([{ id: 'turn-a', status: 'completed', items: [
      { type: 'userMessage', text: raw }, { type: 'agentMessage', phase: 'final_answer', text: '完成' },
    ] }]));
    const merged = mergeHistorySnapshot([
      { id: 'optimistic-a', kind: 'user', text: original, transient: true },
    ], latest, new Set(['turn-a']));
    assert.deepEqual(merged.filter((item) => item.kind === 'user').map(({ id, text }) => ({ id, text })), [
      { id: 'optimistic-a', text: original },
    ]);
    assert.ok(latest.some((item) => item.kind === 'user' && item.text.trim() === original), 'Desktop delivery matches its original text');
    assert.equal(parseUserMessage(`${original}\n<image path="/tmp/example.png"/>\n\n${browserContext(1, 1)}`).text, original);
  }
});

test('browser context examples, incomplete or modified suffixes and assistant text remain content', () => {
  const suffix = browserContext(1, 1);
  for (const raw of [
    `示例：\n\n\`\`\`text\n${suffix}\n\`\`\``,
    `示例：\n\n${suffix.split('\n').map((line) => `> ${line}`).join('\n')}`,
    `说明\n\n${suffix.replace('[End Anywhere browser context]', '')}`,
    `说明\n\n${suffix.replace('This Session has', 'My edited example has')}`,
    `说明\n\n${suffix}\n后面的用户正文不能丢失`,
  ]) assert.equal(parseUserMessage(raw).text, raw.trim());
  assert.equal(parseAssistantMessage(`说明\n\n${suffix}`).text, `说明\n\n${suffix}`);
});
