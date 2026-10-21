import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { MessageMarkdown } from '../web/src/message-markdown.js';

function render(text: string) {
  return parseHTML(renderToStaticMarkup(createElement(MessageMarkdown, { text, onDownloadFile() {} }))).document;
}

test('Markdown tables preserve CJK emphasis, safe line breaks and column alignment', () => {
  const document = render([
    '| 场景 | 目标 | 数量 |', '|---|---|---:|',
    '| **团队协作。**对标现有产品 | **1. 沟通：**围绕目标讨论。<br><br>**2. 协作：**共同完成任务。<BR />后续内容 | 12 |',
  ].join('\n'));
  assert.equal(document.querySelectorAll('table').length, 1);
  assert.equal(document.querySelectorAll('td').length, 3);
  assert.equal(document.querySelectorAll('strong').length, 3);
  assert.equal(document.querySelectorAll('td br').length, 3);
  assert.equal(document.querySelector('td:last-child')?.getAttribute('style'), 'text-align:right');
  assert.doesNotMatch(document.textContent || document.documentElement.textContent || '', /\*\*/);
  assert.equal(document.querySelector('table')?.parentElement?.getAttribute('tabindex'), '0');
});

test('line-break support does not enable raw HTML or rewrite escaped Markdown and code', () => {
  const document = render([
    '| 内容 |', '|---|', '| `<br>**原样：**` <br onmouseover="alert(1)"> <img src=x onerror="alert(1)"> |',
    '', '\\*\\*不是加粗：\\*\\*后文', '',
    '```html', '<br>**代码：**<script>alert(1)</script>', '```', '',
    '[链接](javascript:alert%281%29)',
  ].join('\n'));
  assert.equal(document.querySelectorAll('br,img,script,strong').length, 0);
  assert.equal(document.querySelector('td code')?.textContent, '<br>**原样：**');
  assert.match(document.querySelector('pre code')?.textContent || '', /<br>\*\*代码：\*\*<script>/);
  assert.equal(document.querySelector('a')?.getAttribute('href'), '');
});
