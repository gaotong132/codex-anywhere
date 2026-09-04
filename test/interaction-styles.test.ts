import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compile } from 'sass';
import { isHoverPointer } from '../web/src/pointer-interaction.js';

const css = compile('web/src/styles.scss').css;

test('every control inherits transparent tap feedback with keyboard focus preserved', () => {
  assert.match(css, /:root\s*\{\s*-webkit-tap-highlight-color: transparent;/);
  assert.equal((css.match(/-webkit-tap-highlight-color:/g) || []).length, 1);
  assert.match(css, /button\s*\{\s*appearance: none;\s*-webkit-appearance: none;/);
  assert.match(css, /:where\(button, a\[href\], summary, \[role=button\], \[role=option\]\)\s*\{\s*touch-action: manipulation;/);
  assert.match(css, /:focus:not\(:focus-visible\)\s*\{\s*outline: none;/);
  assert.match(css, /:where\([^}]+\):focus-visible\s*\{\s*outline: 2px solid #[\da-f]+;/);
  assert.doesNotMatch(css, /touch-action: none/);
});

test('all hover decoration is limited to devices with a fine hover pointer', () => {
  const guardedHover = /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g;
  const blocks = [...css.matchAll(guardedHover)].map((match) => match[0]);
  assert.ok(blocks.length >= 20, 'cover buttons, dialogs, links, previews, and status controls');
  assert.doesNotMatch(css.replace(guardedHover, ''), /:hover/);
  assert.ok(blocks.some((block) => block.includes('.model-fast-button:hover:not(:disabled):not(.active)')));
  assert.ok(blocks.some((block) => block.includes('.permission-mode-options > button:hover:not(:disabled):not(.selected)')));
});

test('fast mode and permission selections remain visible independently of hover', () => {
  assert.match(css, /\.model-fast-button\.active\s*\{[^}]*color: #75a5ff;/);
  assert.match(css, /\.permission-mode-options > button\.selected\s*\{[^}]*background: #142037;/);
  assert.match(css, /\.environment-picker-select \.custom-select-trigger:focus-visible\s*\{[^}]*outline: 2px solid/);
});

test('range sliders do not inherit text-field focus halos but retain keyboard focus', () => {
  assert.match(css, /input:not\(\[type=range\]\):focus, textarea:focus/);
  assert.doesNotMatch(css, /(?:^|\n)input:focus, textarea:focus/);
  assert.match(css, /input:focus-visible::-webkit-slider-thumb/);
  assert.match(css, /input:focus-visible::-moz-range-thumb/);
});

test('touch scrolling and pointer drags do not change the hovered menu option', async () => {
  assert.equal(isHoverPointer({ pointerType: 'touch', buttons: 0 }), false);
  assert.equal(isHoverPointer({ pointerType: 'touch', buttons: 1 }), false);
  assert.equal(isHoverPointer({ pointerType: 'mouse', buttons: 1 }), false);
  assert.equal(isHoverPointer({ pointerType: 'pen', buttons: 1 }), false);
  assert.equal(isHoverPointer({ pointerType: 'mouse', buttons: 0 }), true);
  assert.equal(isHoverPointer({ pointerType: 'pen', buttons: 0 }), true);
  const source = await readFile('web/src/ui-components.tsx', 'utf8');
  assert.match(source, /onPointerMove=\{\(event\) => \{ if \(isHoverPointer\(event\)\)/);
  assert.match(source, /event.key === 'ArrowDown'/);
});
