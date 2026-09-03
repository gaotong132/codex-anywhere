import assert from 'node:assert/strict';
import test from 'node:test';
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
  storeEnvironmentValue,
  storeKnownEnvironmentIds,
  storeSelectedEnvironmentId,
} from '../web/src/execution-environments.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('execution environment inventory is normalized, stable, and keeps the local default', () => {
  assert.deepEqual(normalizeEnvironmentIds([' ecs ', 'personal-pc', 'ecs', '', null]), ['ecs', 'personal-pc']);
  assert.deepEqual(
    mergeKnownEnvironmentIds(['studio'], ['ecs', 'studio'], 'offline-lab'),
    ['ecs', 'offline-lab', 'personal-pc', 'studio'],
  );
});

test('execution environment labels are defined in one place', () => {
  assert.equal(environmentDisplayName('personal-pc'), '我的电脑');
  assert.equal(environmentDisplayName('ecs'), 'ECS · 24×7');
  assert.equal(environmentShortName('ecs'), 'ECS');
  assert.equal(environmentOnlineLabel('ecs'), 'ECS在线');
  assert.equal(environmentOfflineLabel('lab'), 'lab离线');
});

test('selected and known execution environments persist without trusting malformed storage', () => {
  const storage = new MemoryStorage();
  assert.equal(loadSelectedEnvironmentId(storage), DEFAULT_ENVIRONMENT_ID);
  assert.equal(storeSelectedEnvironmentId(' ecs ', storage), 'ecs');
  assert.equal(loadSelectedEnvironmentId(storage), 'ecs');
  assert.deepEqual(storeKnownEnvironmentIds(['ecs', 'lab', 'ecs'], storage), ['ecs', 'lab', 'personal-pc']);
  assert.deepEqual(loadKnownEnvironmentIds(storage), ['ecs', 'lab', 'personal-pc']);
  storage.values.set('bridge.knownEnvironments.v1', '{bad json');
  assert.deepEqual(loadKnownEnvironmentIds(storage), [DEFAULT_ENVIRONMENT_ID]);
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
