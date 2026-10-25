import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { MessageMarkdown } from '../web/src/message-markdown.js';
import { MessageBubble } from '../web/src/message-bubble.js';

function render(text: string, filePreview = true) {
  return parseHTML(renderToStaticMarkup(createElement(MessageMarkdown, {
    text, filePreview, basePath: '/project/story.md', onDownloadFile() {},
  }))).document;
}

test('Markdown file previews preserve single newlines and render compact chapter headings', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = ['# 阅读示例', '第一段。', '第二段。', '###1.', '第一章正文。', '另一行。',
      '###第二章 **标题**', '第二章正文。', '', '最后一段。'].join(newline);
    const document = render(source);
    assert.equal(document.querySelector('h1')?.textContent, '阅读示例');
    assert.deepEqual([...document.querySelectorAll('h3')].map(node => node.textContent), ['1.', '第二章 标题']);
    assert.equal(document.querySelector('h3 strong')?.textContent, '标题');
    assert.equal(document.querySelectorAll('p').length, 4);
    assert.equal(document.querySelectorAll('p br').length, 2);
    const chat = render(source, false);
    assert.equal(chat.querySelectorAll('h3, br').length, 0, 'conversation Markdown keeps its existing semantics');
  }
});

test('file preview keeps fenced, indented and inline code, escaped hashes and HTML literal', () => {
  const document = render([
    '```md', '###1.', 'first', 'second', '```', '',
    '    ###2.', '    code', '', '\\###3.', 'plain text', '',
    '`###4.`', '', 'A ###5. stays inline.', '', '#######6.', '',
    '<script>alert(1)</script>', '', '[unsafe](javascript:alert%281%29)',
  ].join('\n'));
  assert.equal(document.querySelectorAll('h1,h2,h3,h4,h5,h6,script').length, 0);
  assert.equal(document.querySelector('pre code')?.textContent, '###1.\nfirst\nsecond\n');
  assert.equal(document.querySelectorAll('pre code')[1]?.textContent, '###2.\ncode\n');
  assert.equal(document.querySelector('p code')?.textContent, '###4.');
  assert.equal(document.querySelector('a')?.getAttribute('href'), '');
});

test('file previews retain GFM tables, lists, links and multiline emphasis', () => {
  const document = render([
    '| Name | Value |', '|---|---:|', '| **Item** | 2 |', '',
    '- [x] Done', '- [ ] Next', '', '> First line', '> Second line', '',
    '**First', 'Second**', '', '[notes](./notes.md)',
  ].join('\n'));
  assert.equal(document.querySelectorAll('table td').length, 2);
  assert.equal(document.querySelectorAll('li').length, 2);
  assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 2);
  assert.equal(document.querySelectorAll('blockquote br').length, 1);
  assert.equal(document.querySelectorAll('p strong br').length, 1);
  assert.equal(document.querySelector('a')?.getAttribute('href'), './notes.md');
});

test('opening an MD file uses reading layout while Download retains the original file', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const downloads: string[] = [];
  const content = '# Title\nFirst line\nSecond line\n###1.\nChapter text';
  const click = async (selector: string) => act(async () => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  });
  try {
    await act(async () => root.render(createElement(MessageBubble, {
      item: { id: 'markdown', kind: 'assistant', text: '[正文](/project/story.md)' },
      onDownloadFile: path => { downloads.push(path); }, onReadVisualization: async () => '',
      onReadTextFile: async path => {
        assert.equal(path, '/project/story.md');
        return { name: 'story.md', content, size: new Blob([content]).size, kind: 'markdown', language: '' };
      },
    })));
    await click('a');
    assert.equal(document.querySelector('.markdown-preview-content h3')?.textContent, '1.');
    assert.equal(document.querySelectorAll('.markdown-preview-content p br').length, 1);
    await click('.markdown-lightbox-actions button');
    assert.deepEqual(downloads, ['/project/story.md']);
    await click('[aria-label="关闭预览"]');
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
