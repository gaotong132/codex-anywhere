import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { parseAgentInstructions } from '../src/shared/agent-instructions.js';
import { parseAssistantMessage, parseUserMessage } from '../src/shared/message-content.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { internals as rollout } from '../src/connector/rollout-tail.js';
import { historyItems } from '../web/src/history-utils.js';
import { MessageBubble } from '../web/src/message-bubble.js';

const body = '# 本地偏好\n\n## 验证约定\n\n- 执行 `npm test`。\n\n## 文件约定\n\n- 保留 `a &lt; b` 和 `<tag>`。';
const source = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${body}\n</INSTRUCTIONS>`;
const escapedHtml = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapedMarkdown = (value: string) => value.replaceAll('<', '\\<');
const messageProps = {
  onDownloadFile: (_path: string) => {}, onReadVisualization: async (_path: string) => '',
  onEditMessage: () => assert.fail('instruction metadata must not be resent as a user edit'),
};

test('standalone instruction documents retain their body and support both Desktop headings and escaped wrappers', () => {
  for (const scope of ['', ' for /workspace/example-project']) {
    for (const encode of [(value: string) => value, escapedHtml, escapedMarkdown]) {
      const raw = encode(source.replace('instructions\n', `instructions${scope}\n`));
      const document = parseAgentInstructions(raw)!;
      assert.equal(document.scope, scope ? '/workspace/example-project' : undefined);
      assert.equal(document.body, encode(body));
      assert.equal(parseUserMessage(raw).text, raw);
    }
  }
  assert.equal(parseAgentInstructions(source.replaceAll('\n', '\r\n'))!.body, body.replaceAll('\n', '\r\n'));
  const example = source.replace('执行 `npm test`。', '## My request:\n<environment_context>示例</environment_context>');
  assert.equal(parseUserMessage(example).text, example, 'instruction examples are not interpreted as injected control metadata');
});

test('quotes, code examples, incomplete instructions and trailing user prose stay ordinary messages', () => {
  for (const raw of [
    `解释这个格式\n${source}`, source.split('\n').map(line => `> ${line}`).join('\n'),
    `\`\`\`xml\n${source}\n\`\`\``, source.split('\n').map(line => `    ${line}`).join('\n'),
    source.replace('</INSTRUCTIONS>', ''), source.replace('<INSTRUCTIONS>', '&lt;INSTRUCTIONS&gt;'),
    `${source}\n继续检查问题`, source.replace('# AGENTS.md instructions', '# Other instructions'),
  ]) {
    assert.equal(parseAgentInstructions(raw), null);
    const html = renderToStaticMarkup(createElement(MessageBubble, { ...messageProps, item: { id: 'ordinary', kind: 'user', text: raw } }));
    assert.doesNotMatch(html, /agent-instructions-card/);
  }
  assert.equal(parseAssistantMessage(source).text, source);
  const assistant = renderToStaticMarkup(createElement(MessageBubble, { ...messageProps, item: { id: 'assistant', kind: 'assistant', text: source } }));
  assert.doesNotMatch(assistant, /agent-instructions-card/);
});

test('instruction cards survive app-server summaries, complete items, raw browser history and rollout history', () => {
  const environment = '\n<environment_context><cwd>/workspace/example-project</cwd><shell>sh</shell></environment_context>';
  for (const encode of [(value: string) => value, escapedHtml, escapedMarkdown]) {
    const raw = encode(source + environment);
    const expected = encode(source);
    for (const item of [{ type: 'userMessage', text: raw }, { type: 'userMessage', content: [{ type: 'text', text: raw }] }]) {
      const mapped = mapTurns([{ id: 'instructions-turn', items: [item] }]);
      assert.equal(historyItems(mapped)[0]?.text, expected);
    }
    assert.equal(historyItems([{ id: 'old-connector', items: [{ type: 'userMessage', text: raw }] }])[0]?.text, expected);
    const rows = rollout.mapRolloutRows([{ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }],
    } }]);
    assert.equal(rows.find(row => row.type === 'userMessage')?.text, expected);
  }
  const forwarded = `<codex_delegation><source_thread_id>source-task</source_thread_id><input>${source}</input></codex_delegation>`;
  assert.ok(parseAgentInstructions(parseUserMessage(forwarded).text));
});

test('instruction card is collapsed initially, expands Markdown, copies clean instructions and collapses on replacement', async () => {
  const keys = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const copies: string[] = [];
  for (const [key, value] of [['window', window], ['document', document], ['navigator', { clipboard: {
    writeText: async (value: string) => { copies.push(value); },
  } }], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const render = (text = source) => act(async () => root.render(createElement(MessageBubble, {
    ...messageProps, item: { id: 'instructions', kind: 'user', text, historyTurnId: 'turn' },
  })));
  const click = async (selector: string) => act(async () => {
    document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  try {
    await render();
    assert.match(document.body.textContent!, /本地偏好|AGENTS\.md/);
    assert.match(document.body.textContent!, /2 个章节/);
    assert.equal(document.querySelector('.agent-instructions-toggle')!.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.agent-instructions-body'), null, 'closed instructions do not render the full document');
    assert.equal(document.querySelector('.message-edit'), null);
    await click('.agent-instructions-toggle');
    assert.equal(document.querySelector('.agent-instructions-toggle')!.getAttribute('aria-expanded'), 'true');
    const content = document.querySelector('.agent-instructions-body')!;
    assert.equal(content.id, document.querySelector('.agent-instructions-toggle')!.getAttribute('aria-controls'));
    assert.equal(content.querySelectorAll('h2').length, 2);
    assert.match(content.textContent!, /执行 npm test/);
    assert.doesNotMatch(content.textContent!, /<\/?INSTRUCTIONS>/);
    await click('.message-copy');
    assert.deepEqual(copies, [body]);
    await click('.agent-instructions-toggle');
    assert.equal(document.querySelector('.agent-instructions-body'), null);
    await click('.agent-instructions-toggle');
    await render(source.replace('本地偏好', '更新后的偏好'));
    assert.equal(document.querySelector('.agent-instructions-body'), null);
    assert.match(document.body.textContent!, /更新后的偏好/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
