import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { sendWebSocketFrame, type FrameSendProgress } from '../web/src/websocket-send.js';
import { ImageUploadProgress } from '../web/src/image-upload-progress.js';

test('send progress counts UTF-8 bytes and excludes frames queued before and after the upload', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(data: any) {
    sent.push(data); this.bufferedAmount += Buffer.byteLength(data);
  } };
  sendWebSocketFrame(socket, { before: 'queued' });
  const before = socket.bufferedAmount;
  const progress: FrameSendProgress[] = [];
  const controller = new AbortController();
  sendWebSocketFrame(socket, { image: '图片' }, { signal: controller.signal, onProgress: (p) => progress.push(p) });
  const total = Buffer.byteLength(sent[1]);
  assert.deepEqual(progress, [{ sentBytes: 0, totalBytes: total }]);
  sendWebSocketFrame(socket, { after: 'ping' });
  socket.bufferedAmount -= before;
  t.mock.timers.tick(100);
  assert.equal(progress.length, 1, 'earlier bytes do not advance this frame');
  socket.bufferedAmount -= 5;
  t.mock.timers.tick(100);
  assert.equal(progress.at(-1)!.sentBytes, 5);
  socket.bufferedAmount -= total - 5;
  t.mock.timers.tick(100);
  assert.deepEqual(progress.at(-1), { sentBytes: total, totalBytes: total });
  assert.ok(socket.bufferedAmount > 0, 'later frames do not delay completion');
  const count = progress.length;
  t.mock.timers.tick(120_000);
  assert.equal(progress.length, count);
});

test('aborting or closing a socket stops observations without claiming bytes were delivered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['abort', 'closed']) {
    const socket = { readyState: 1, bufferedAmount: 0, send(data: any) { this.bufferedAmount += Buffer.byteLength(data); } };
    const progress: FrameSendProgress[] = [];
    const controller = new AbortController();
    sendWebSocketFrame(socket, { image: 'data' }, { signal: controller.signal, onProgress: (p) => progress.push(p) });
    if (reason === 'abort') controller.abort(); else socket.readyState = 3;
    socket.bufferedAmount = 0;
    t.mock.timers.tick(120_000);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].sentBytes, 0);
  }
});

test('image progress distinguishes preparing, sending and waiting for the connector', () => {
  const preparing = renderToStaticMarkup(createElement(ImageUploadProgress, { state: { phase: 'preparing', percent: 0 } }));
  assert.match(preparing, /正在准备图片/);
  assert.doesNotMatch(preparing, /value=/);
  const sending = renderToStaticMarkup(createElement(ImageUploadProgress, { state: { phase: 'sending', percent: 42 } }));
  assert.match(sending, /42%/);
  assert.match(sending, /value="42"/);
  const confirming = renderToStaticMarkup(createElement(ImageUploadProgress, { state: { phase: 'confirming', percent: 100 } }));
  assert.match(confirming, /等待确认/);
  assert.doesNotMatch(confirming, /上传完成/);
});
