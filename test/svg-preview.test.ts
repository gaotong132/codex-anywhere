import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../web/src/message-bubble.js';
import { localFilePathFromHref, localFilePathFromRelativeHref } from '../web/src/file-utils.js';
import { DownloadManager } from '../src/connector/file-downloads.js';

const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><text x="5" y="20">图表</text></svg>';

test('SVG fences render the graphic preview while ordinary XML remains source code', () => {
  const render = (language: string) => renderToStaticMarkup(createElement(MessageBubble, {
    item: { id: 'svg', kind: 'assistant', text: `\`\`\`${language}\n${source}\n\`\`\`` },
    onDownloadFile() {}, onReadVisualization: async () => '',
  }));
  assert.match(render('svg'), /class="svg-preview"/);
  assert.match(render('svg'), /aria-pressed="true">图形/);
  assert.doesNotMatch(render('xml'), /class="svg-preview"/);
  assert.match(render('xml'), /&lt;svg/);
});

test('local SVG image references use the connector reader on Windows and ECS', () => {
  for (const path of ['D:/project/chart.svg', '/root/project/chart.svg']) {
    const markup = renderToStaticMarkup(createElement(MessageBubble, {
      item: { id: 'svg', kind: 'assistant', text: `![图表](${path})` },
      onDownloadFile() {}, onReadTextFile: async () => ({ name: 'chart.svg', content: source, size: source.length, kind: 'code', language: 'xml' }),
      onReadVisualization: async () => '',
    }));
    assert.match(markup, /class="local-svg-image"/);
    assert.doesNotMatch(markup, /<img[^>]*src="(?:D:|\/root)/);
  }
  assert.equal(localFilePathFromHref('file:///root/project/chart.svg'), '/root/project/chart.svg');
  assert.equal(localFilePathFromHref('/root/project/chart.svg:12'), '/root/project/chart.svg');
  assert.equal(localFilePathFromRelativeHref('../chart.svg', '/root/project/docs/README.md'), '/root/project/docs/../chart.svg');
  assert.equal(localFilePathFromHref('//other.example/chart.svg'), null);
  assert.equal(localFilePathFromHref('file://other.example/chart.svg'), null);
  assert.equal(localFilePathFromHref('https://other.example/chart.svg'), null);
});

test('SVG source previews retain the connector root boundary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'svg-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'allowed');
  await mkdir(root);
  const path = join(root, 'chart.svg');
  await writeFile(path, source);
  const outside = join(directory, 'outside.svg');
  await writeFile(outside, source);
  const downloads = new DownloadManager({ allowedRoots: [root], auditPath: null });
  t.after(() => downloads.closeAll());
  const document = await downloads.readText({ path });
  assert.equal(document.content, source);
  assert.equal(document.language, 'xml');
  await assert.rejects(() => downloads.readText({ path: outside }), /not_allowed|outside/);
});
