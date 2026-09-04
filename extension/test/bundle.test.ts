import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

type Sender = { id?: string; url?: string; tab?: object };
type Reply = { ok: boolean; result?: { origin?: string; nodes?: Array<{ text: string }> }; error?: string };
type Listener = (message: unknown, sender: Sender, respond: (value: Reply) => void) => boolean;

// Exercise the built worker and serialized functions in isolated JS contexts.
// Browser API doubles do not replace installed Chrome/Edge integration checks.
async function worker() {
  let onMessage!: Listener;
  let onUpdated!: (tabId: number, change: { url?: string; status?: string }) => void;
  let onRemoved!: (tabId: number) => void;
  let documentId = 'document-a';
  let reads = 0;
  const origin = 'https://example.com';
  const extensionId = 'browser-preview-test';
  const popup = `chrome-extension://${extensionId}/popup.html`;
  const { document } = parseHTML('<html><body><h1>Public fixture</h1><input value="private-secret"><textarea>private-secret</textarea></body></html>');
  Object.defineProperty(document, 'location', { value: new URL(`${origin}/path?private=secret`) });
  const chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { id: extensionId, getURL: () => popup, onMessage: { addListener: (value: Listener) => { onMessage = value; } } },
    tabs: {
      get: async () => ({ id: 1, url: `${origin}/path?private=secret` }),
      query: async () => [{ id: 1 }],
      onUpdated: { addListener: (value: typeof onUpdated) => { onUpdated = value; } },
      onRemoved: { addListener: (value: typeof onRemoved) => { onRemoved = value; } },
    },
    scripting: { executeScript: async (options: {
      target: { tabId: number; documentIds?: string[]; frameIds?: number[] };
      world: string; func: (...args: unknown[]) => unknown; args?: unknown[];
    }) => {
      assert.equal(options.world, 'ISOLATED');
      assert.equal(options.target.tabId, 1);
      if (options.target.documentIds) {
        assert.equal(options.target.documentIds[0], documentId);
        reads++;
      } else assert.equal(options.target.frameIds?.[0], 0);
      // No module helpers are available here, just like Chrome function injection.
      const result = runInNewContext(`(${options.func.toString()})(...args)`, {
        document, location: document.location, args: options.args ?? [],
      }, { timeout: 1_000 });
      return [{ documentId, result }];
    } },
  };
  runInNewContext(await readFile('extension/dist/background.js', 'utf8'), {
    chrome, URL, crypto, AbortController, setTimeout, clearTimeout,
  }, { timeout: 1_000 });
  const sender = { id: extensionId, url: popup };
  const send = (type: string) => new Promise<Reply>((resolve, reject) => {
    if (!onMessage({ type }, sender, resolve)) reject(new Error('popup rejected'));
  });
  return { send, sender, receive: (...args: Parameters<Listener>) => onMessage(...args),
    reads: () => reads, replaceDocument: () => { documentId = 'document-b'; },
    navigate: () => onUpdated(1, { status: 'loading' }), close: () => onRemoved(1) };
}

test('built extension grants, injects standalone bounded code, and revokes local reads', async () => {
  const w = await worker();
  assert.equal((await w.send('snapshot')).ok, false);
  assert.equal((await w.send('grant')).result?.origin, 'https://example.com');
  const result = await w.send('snapshot');
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /Public fixture/);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|\/path/);
  assert.equal(w.reads(), 1);
  assert.equal((await w.send('stop')).ok, true);
  assert.equal((await w.send('snapshot')).ok, false);
});

test('built worker rejects website, foreign-extension and tab senders', async () => {
  const w = await worker();
  for (const sender of [{ ...w.sender, url: 'https://example.com' }, { ...w.sender, id: 'other-extension' }, { ...w.sender, tab: { id: 1 } }]) {
    assert.equal(w.receive({ type: 'grant' }, sender, () => assert.fail('untrusted sender received a reply')), false);
  }
  assert.equal((await w.send('status')).result?.origin, null);
  assert.equal(w.reads(), 0);
});

test('built worker revokes on navigation, closure and same-origin document replacement', async () => {
  for (const action of ['navigate', 'close', 'replace'] as const) {
    const w = await worker();
    await w.send('grant');
    if (action === 'navigate') w.navigate();
    if (action === 'close') w.close();
    if (action === 'replace') w.replaceDocument();
    assert.equal((await w.send('snapshot')).ok, false);
    assert.equal(w.reads(), 0);
    assert.equal((await w.send('status')).result?.origin, null);
  }
});
