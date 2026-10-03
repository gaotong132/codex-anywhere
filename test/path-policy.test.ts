import assert from 'node:assert/strict';
import test from 'node:test';
import { isPathWithinRoot } from '../src/connector/path-policy.js';

test('POSIX roots remain case-sensitive and backslashes are literal filename characters', () => {
  assert.equal(isPathWithinRoot('/data/allowed/file', '/data/allowed'), true);
  assert.equal(isPathWithinRoot('/data/Allowed/file', '/data/allowed'), false);
  assert.equal(isPathWithinRoot('/data/allowed-sibling/file', '/data/allowed'), false);
  assert.equal(isPathWithinRoot('/data/allowed/../secret', '/data/allowed'), false);
  assert.equal(isPathWithinRoot('/data/allowed\\file', '/data/allowed'), false);
  assert.equal(isPathWithinRoot('/data/allowed/a\\b', '/data/allowed'), true);
});

test('drive and UNC roots retain Windows semantics without mixing path formats', () => {
  assert.equal(isPathWithinRoot('C:/DATA/allowed/file', 'c:\\data\\allowed'), true);
  assert.equal(isPathWithinRoot('D:/data/allowed/file', 'C:/data/allowed'), false);
  assert.equal(isPathWithinRoot('C:/data/allowed/../secret', 'C:/data/allowed'), false);
  assert.equal(isPathWithinRoot('\\\\server\\share\\dir\\file', '\\\\SERVER\\share\\dir'), true);
  assert.equal(isPathWithinRoot('\\\\server\\other\\file', '\\\\server\\share'), false);
  assert.equal(isPathWithinRoot('C:/data/allowed', '/data/allowed'), false);
  assert.equal(isPathWithinRoot('/data/allowed', 'C:/data/allowed'), false);
});
