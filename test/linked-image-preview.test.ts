import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { MessageBubble } from '../web/src/message-bubble.js';
import { MessageMarkdown } from '../web/src/message-markdown.js';
import { isRasterImageFilePath } from '../web/src/file-utils.js';
import { readLinkedImagePreview } from '../web/src/file-preview-client.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';
import { readImageAttachment } from '../src/connector/attachments.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('linked generated images use the managed reader without allowing arbitrary files outside project roots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linked-image-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, 'project'), generated = join(directory, 'custom-codex-home', 'generated_images');
  await mkdir(local);
  await mkdir(generated, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const generatedPath = join(generated, 'result.png'), localPath = join(local, 'result.png'), outsidePath = join(directory, 'outside.png');
  for (const path of [generatedPath, localPath, outsidePath]) await writeFile(path, png);
  const sources: unknown[] = [];
  const request: BridgeRequest = (async (action, payload) => {
    assert.equal(action, 'attachment.read');
    sources.push(payload.source);
    return readImageAttachment(payload, { localAllowedRoots: [local], generatedDirectory: generated });
  }) as BridgeRequest;
  await assert.rejects(readImageAttachment({ path: generatedPath, source: 'local' }, {
    localAllowedRoots: [local], generatedDirectory: generated,
  }), /local_image_path_not_allowed/);
  assert.match(await readLinkedImagePreview(request, generatedPath), /^data:image\/webp;base64,/);
  assert.deepEqual(sources.splice(0), ['local', 'generated']);
  assert.match(await readLinkedImagePreview(request, localPath), /^data:image\/webp;base64,/);
  assert.deepEqual(sources.splice(0), ['local']);
  await assert.rejects(readLinkedImagePreview(request, outsidePath), /generated_image_path_not_allowed/);
  assert.deepEqual(sources.splice(0), ['local', 'generated']);
});

test('linked-image fallback neither retries network errors nor accepts unsupported preview types', async () => {
  for (const message of ['request_timeout', 'local_image_not_found', 'local_image_content_mismatch', 'download_cancelled']) {
    let calls = 0;
    const request: BridgeRequest = async () => { calls++; throw new Error(message); };
    await assert.rejects(readLinkedImagePreview(request, '/root/image.png'), { message });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const request: BridgeRequest = (async () => {
    if (++calls === 1) throw new Error('local_image_path_not_allowed');
    return { mimeType: 'image/svg+xml', data: 'bm90LWFuLWltYWdl' };
  }) as BridgeRequest;
  await assert.rejects(readLinkedImagePreview(request, 'D:\\custom-home\\generated_images\\result.png'), /attachment_content_mismatch/);
  assert.equal(calls, 2);
});

test('raster preview buttons handle ECS, Windows and relative Markdown links without fetching remote images', () => {
  const markup = renderToStaticMarkup(createElement(MessageMarkdown, {
    text: '[ECS](/root/output/a.png) [Windows](D:/output/b.JPG) [relative](../c.webp) '
      + '[external](https://example.com/d.png) [document](/root/a.pdf) ![inline](../e.jpeg)',
    basePath: '/root/output/readme.md', onDownloadFile() {}, onPreviewImage() {},
  }));
  const { document } = parseHTML(markup);
  assert.equal(document.querySelectorAll('.local-image-preview-button').length, 4);
  assert.equal(document.querySelectorAll('img').length, 0, 'previews are read only on demand');
  assert.equal(document.querySelector('a[href="https://example.com/d.png"]')?.getAttribute('target'), '_blank');
  assert.equal(isRasterImageFilePath('/a.PNG'), true);
  for (const path of ['/a.png.exe', '/a.svg', '/a.gif', '/a.txt']) assert.equal(isRasterImageFilePath(path), false);
  const fallback = renderToStaticMarkup(createElement(MessageMarkdown, {
    text: '[image](/root/a.png)', onDownloadFile() {},
  }));
  assert.doesNotMatch(fallback, /local-image-preview-button/);
});

test('image links preview on demand, preserve original downloads, retry failures, and ignore closed/stale reads', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const pending: { path: string; resolve: (url: string) => void; reject: (error: Error) => void }[] = [];
  const downloads: string[] = [];
  const click = async (selector: string) => act(async () => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  });
  try {
    await act(async () => root.render(createElement(MessageBubble, {
      item: { id: 'images', kind: 'assistant', text: '[机甲](/root/a.png) [动漫](/root/b.png)' },
      onDownloadFile: path => { downloads.push(path); },
      onReadVisualization: async () => '',
      onReadPreviewImage: path => new Promise<string>((resolve, reject) => pending.push({ path, resolve, reject })),
    })));
    assert.equal(pending.length, 0);
    await click('a[href="/root/a.png"]');
    assert.equal(pending[0].path, '/root/a.png');
    assert.equal(document.querySelector('[role="dialog"]')?.parentElement, document.body,
      'the preview must escape the scrolling/animated message bubble');
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /正在读取文件/);
    await act(async () => pending[0].resolve('data:image/webp;base64,YQ=='));
    assert.equal(document.querySelector('.linked-image-preview img')?.getAttribute('src'), 'data:image/webp;base64,YQ==');
    await click('.markdown-lightbox-actions button');
    assert.deepEqual(downloads, ['/root/a.png']);
    await click('[aria-label="关闭预览"]');
    await click('[aria-label="预览图片：b.png"]');
    await act(async () => pending[1].reject(new Error('local_image_not_found')));
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /预览失败/);
    await click('.markdown-preview-state button');
    assert.equal(pending[2].path, '/root/b.png');
    await click('[aria-label="关闭预览"]');
    await act(async () => pending[2].resolve('data:image/webp;base64,Yg=='));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click('[aria-label="预览图片：a.png"]');
    await click('[aria-label="预览图片：b.png"]');
    await act(async () => pending[3].resolve('data:image/webp;base64,YQ=='));
    assert.equal(document.querySelector('.linked-image-preview img'), null);
    await act(async () => pending[4].resolve('data:image/webp;base64,Yg=='));
    assert.equal(document.querySelector('.linked-image-preview img')?.getAttribute('alt'), 'b.png');
    await act(async () => {
      const event = new window.Event('keydown');
      Object.defineProperty(event, 'key', { value: 'Escape' });
      document.dispatchEvent(event);
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('inline generated-image preview button opens without starting an original download', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const path = '/root/.codex/generated_images/thread/exec-result.png';
  const requests: unknown[] = [];
  let downloads = 0;
  const request: BridgeRequest = (async (_action, payload) => {
    requests.push(payload);
    if (payload.source === 'local') throw new Error('local_image_path_not_allowed');
    return { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
  }) as BridgeRequest;
  try {
    await act(async () => root.render(createElement(MessageBubble, {
      item: { id: 'generated', kind: 'assistant', text: `![修改后的黑金战舰](${path})` },
      onReadVisualization: async () => '',
      onDownloadFile: () => { downloads++; },
      onReadPreviewImage: path => readLinkedImagePreview(request, path),
    })));
    await act(async () => document.querySelector('.local-image-preview-button')!.dispatchEvent(
      new window.Event('click', { bubbles: true, cancelable: true }),
    ));
    assert.deepEqual(requests, [{ path, source: 'local' }, { path, source: 'generated' }]);
    assert.equal(downloads, 0);
    assert.match(document.querySelector('.linked-image-preview img')!.getAttribute('src')!, /^data:image\/png;base64,/);
    assert.equal(document.querySelector('.markdown-lightbox')?.parentElement, document.body);
  } finally {
    await act(async () => root.unmount());
    assert.equal(document.querySelector('.markdown-lightbox'), null);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
