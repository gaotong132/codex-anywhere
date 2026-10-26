import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { EnvironmentSwitcher } from '../web/src/environment-switcher.js';
import {
  DEFAULT_ENVIRONMENT_ID,
  environmentDisplayName,
  environmentOfflineLabel,
  environmentOnlineLabel,
  environmentShortName,
  environmentStorageKey,
  loadEnvironmentValue,
  loadKnownEnvironmentIds,
  loadSelectedEnvironmentId,
  mergeKnownEnvironmentIds,
  normalizeEnvironmentIds,
  readEnvironmentInventory,
  storeEnvironmentValue,
  storeKnownEnvironmentIds,
  storeSelectedEnvironmentId,
} from '../web/src/execution-environments.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('two environments have direct controls with stable positions and an accessible offline choice', () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(EnvironmentSwitcher, {
    value: 'ecs', environmentIds: ['ecs', 'personal-pc'], onlineEnvironmentIds: ['ecs'], onChange: () => {},
  })));
  const buttons = [...document.querySelectorAll('button')];
  assert.deepEqual(buttons.map(button => button.querySelector('strong')?.textContent), ['我的电脑', 'ECS']);
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(buttons[0].hasAttribute('disabled'), false, 'offline environments remain selectable');
  assert.match(buttons[0].textContent || '', /离线/);
  assert.match(buttons[1].textContent || '', /在线/);
  assert.equal(document.querySelector('[aria-haspopup]'), null);
});

test('two online devices stay one-click choices despite additional offline devices', () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(EnvironmentSwitcher, {
    value: 'lab', environmentIds: ['old-pc', 'ecs', 'personal-pc', 'lab'], onlineEnvironmentIds: ['lab', 'ecs'], onChange: () => {},
  })));
  assert.deepEqual([...document.querySelectorAll('.environment-shortcuts strong')].map(node => node.textContent), ['ECS', 'lab']);
  assert.equal(document.querySelector('[aria-haspopup]'), null);
  assert.equal(document.querySelector('.environment-offline')!.hasAttribute('open'), false);
  assert.equal(document.querySelectorAll('.environment-offline-list button').length, 2);
  assert.equal(document.querySelector('.environment-offline-count')!.textContent, '2');
});

test('more than two online environments retain an accessible selector', () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(EnvironmentSwitcher, {
    value: 'lab', environmentIds: ['ecs', 'personal-pc', 'lab'], onlineEnvironmentIds: ['lab', 'ecs', 'personal-pc'], onChange: () => {},
  })));
  const trigger = document.querySelector('button[aria-haspopup="listbox"]');
  assert(trigger);
  assert.match(trigger.textContent || '', /lab/);
  assert.equal(trigger.getAttribute('aria-label'), '切换执行环境');
});

test('presence changes preserve the selected route and direct clicks target only their own device', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const calls: string[] = [];
  const render = (onlineEnvironmentIds: string[], value = 'lab') => act(async () => root.render(createElement(EnvironmentSwitcher, {
    value, environmentIds: ['ecs', 'lab', 'personal-pc'], onlineEnvironmentIds, onChange: id => calls.push(id),
  })));
  const click = (selector: string) => act(async () => {
    document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  try {
    await render(['lab', 'ecs', 'personal-pc']);
    assert.ok(document.querySelector('[aria-haspopup="listbox"]'));
    await render(['lab', 'ecs']);
    await click('.environment-shortcuts button[aria-pressed="true"]');
    assert.deepEqual(calls, [], 'clicking the current device does not reconnect');
    await click('.environment-shortcuts button[aria-pressed="false"]');
    assert.deepEqual(calls, ['ecs']);
    await render(['ecs']);
    assert.equal(document.querySelector('.environment-offline')!.hasAttribute('open'), true);
    assert.equal(document.querySelector('.environment-offline-list [aria-pressed="true"] strong')!.textContent, 'lab');
    await click('.environment-offline-list button[aria-pressed="false"]');
    assert.deepEqual(calls, ['ecs', 'personal-pc']);
    await render(['lab', 'ecs']);
    assert.equal(document.querySelector('.environment-shortcuts [aria-pressed="true"] strong')!.textContent, 'lab');
    assert.equal(document.querySelector('.environment-offline')!.hasAttribute('open'), false);
    await render(['lab', 'ecs', 'personal-pc']);
    assert.match(document.querySelector('[aria-haspopup="listbox"]')!.textContent!, /lab/);
    assert.deepEqual(calls, ['ecs', 'personal-pc'], 'presence changes never switch devices automatically');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('execution environment inventory is normalized without injecting a phantom PC', () => {
  assert.deepEqual(normalizeEnvironmentIds([' ecs ', 'personal-pc', 'ecs', '', null]), ['ecs', 'personal-pc']);
  assert.deepEqual(
    mergeKnownEnvironmentIds(['studio'], ['ecs', 'studio'], 'offline-lab'),
    ['ecs', 'offline-lab', 'studio'],
  );
});

test('execution environment labels are defined in one place', () => {
  assert.equal(environmentDisplayName('personal-pc'), '我的电脑');
  assert.equal(environmentDisplayName('ecs'), 'ECS · 7×24');
  assert.equal(environmentShortName('ecs'), 'ECS');
  assert.equal(environmentOnlineLabel('ecs'), 'ECS在线');
  assert.equal(environmentOfflineLabel('lab'), 'lab离线');
});

test('selected and known execution environments persist without trusting malformed storage', () => {
  const storage = new MemoryStorage();
  assert.equal(loadSelectedEnvironmentId(storage), DEFAULT_ENVIRONMENT_ID);
  assert.equal(storeSelectedEnvironmentId(' ecs ', storage), 'ecs');
  assert.equal(loadSelectedEnvironmentId(storage), 'ecs');
  assert.deepEqual(storeKnownEnvironmentIds(['ecs', 'lab', 'ecs'], storage), ['ecs', 'lab']);
  assert.deepEqual(loadKnownEnvironmentIds(storage), ['ecs', 'lab']);
  storage.values.set('bridge.knownEnvironments.v1', '{bad json');
  assert.deepEqual(loadKnownEnvironmentIds(storage), []);
});

test('approved offline devices and custom names survive inventories larger than 24', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `node-${index}`, label: `电脑 ${index}`, online: false }));
  const inventory = readEnvironmentInventory(rows)!;
  assert.equal(inventory.ids.length, 40);
  assert.ok(inventory.ids.includes('node-39'));
  assert.equal(environmentDisplayName('node-39', inventory.labels), '电脑 39');
  assert.equal(environmentShortName('ecs', { ecs: '生产服务器' }), '生产服务器');
  assert.equal(readEnvironmentInventory(undefined), null);
  assert.deepEqual(readEnvironmentInventory([])?.ids, []);
  const { document } = parseHTML(renderToStaticMarkup(createElement(EnvironmentSwitcher, {
    value: 'node-39', environmentIds: inventory.ids, labels: inventory.labels, onlineEnvironmentIds: [], onChange: () => {},
  })));
  assert.match(document.querySelector('.environment-empty')!.textContent!, /暂无在线设备/);
  assert.equal(document.querySelector('[aria-haspopup]'), null);
  assert.equal(document.querySelector('.environment-offline')!.hasAttribute('open'), true);
  assert.equal(document.querySelectorAll('.environment-offline-list button').length, 40);
  assert.match(document.querySelector('.environment-offline summary')!.textContent!, /电脑 39/);
  assert.match(document.querySelector('[aria-pressed="true"]')!.textContent!, /电脑 39/);
});
test('connector-scoped storage migrates the legacy local-computer value only', () => {
  const storage = new MemoryStorage();
  storage.setItem('bridge.lastThreadId', 'legacy-thread');
  assert.equal(loadEnvironmentValue('bridge.lastThreadId', 'personal-pc', storage), 'legacy-thread');
  assert.equal(loadEnvironmentValue('bridge.lastThreadId', 'ecs', storage), null);
  storeEnvironmentValue('bridge.lastThreadId', 'ecs', 'ecs-thread', storage);
  assert.equal(loadEnvironmentValue('bridge.lastThreadId', 'ecs', storage), 'ecs-thread');
  assert.equal(
    environmentStorageKey('bridge.lastThreadId', 'ecs west'),
    'bridge.lastThreadId.ecs%20west',
  );
});
