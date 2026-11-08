import { test } from 'node:test';
import assert from 'node:assert';
import { collides, fits, place, nextFreeRow, setEnabled, normalizeModules } from '../core/layout.js';

const mods = [
  { id: 'a', enabled: true, col: 1, row: 1, cols: 2, rows: 2 },
  { id: 'b', enabled: true, col: 3, row: 1, cols: 4, rows: 4 },
  { id: 'off', enabled: false, col: 1, row: 3, cols: 2, rows: 2 },
];

test('collides checks enabled modules other than itself', () => {
  assert.strictEqual(collides(mods, { id: 'a', col: 2, row: 1, cols: 2, rows: 1 }), true, 'touches b');
  assert.strictEqual(collides(mods, { id: 'a', col: 1, row: 3, cols: 2, rows: 2 }), false, 'disabled module is ignored');
  assert.strictEqual(collides(mods, { id: 'b', col: 3, row: 1, cols: 4, rows: 4 }), false, 'itself');
  assert.strictEqual(collides(mods, { id: 'x', col: 7, row: 1, cols: 1, rows: 1 }), false, 'edge to edge is fine');
});

test('fits keeps modules inside the grid', () => {
  assert.strictEqual(fits({ col: 11, row: 1, cols: 2, rows: 1 }, 12), true);
  assert.strictEqual(fits({ col: 12, row: 1, cols: 2, rows: 1 }, 12), false);
  assert.strictEqual(fits({ col: 0, row: 1, cols: 1, rows: 1 }, 12), false);
  assert.strictEqual(fits({ col: 1, row: 1, cols: 0, rows: 1 }, 12), false);
});

test('place moves or resizes, or refuses', () => {
  assert.deepStrictEqual(place(mods, 'a', { row: 5 }, 12).find(m => m.id === 'a').row, 5);
  assert.strictEqual(place(mods, 'a', { cols: 3 }, 12), null, 'grows into b');
  assert.strictEqual(place(mods, 'b', { col: 10 }, 12), null, 'off the right edge');
  assert.strictEqual(place(mods, 'nope', { row: 1 }, 12), null);
});

test('place never produces overlaps (exhaustive small grid)', () => {
  for (let col = 0; col <= 8; col++) for (let row = 0; row <= 6; row++) for (const cols of [1, 2, 3]) {
    const out = place(mods, 'a', { col, row, cols, rows: 2 }, 8);
    if (!out) continue;
    const on = out.filter(m => m.enabled !== false);
    for (const m of on) assert.strictEqual(collides(on, m), false, JSON.stringify(m));
  }
});

test('setEnabled turns a module on in the first free spot and off in place', () => {
  const out = setEnabled(mods, 'off', true, 12).find(m => m.id === 'off');
  assert.deepStrictEqual([out.enabled, out.col, out.row], [true, 7, 1], 'right of b, the first gap that fits 2x2');
  assert.strictEqual(setEnabled(mods, 'a', false).find(m => m.id === 'a').enabled, false);
  assert.strictEqual(setEnabled(mods, 'a', true, 12).find(m => m.id === 'a').col, 1, 'already on: unchanged');
  assert.strictEqual(nextFreeRow(mods), 5);
});

test('normalizeModules keeps user placement, drops unknown ids, appends new defaults below', () => {
  const saved = [{ id: 'a', enabled: true, col: 5, row: 1, cols: 2, rows: 2 }, { id: 'gone', enabled: true, col: 1, row: 1, cols: 1, rows: 1 }];
  const defaults = [
    { id: 'a', enabled: true, col: 1, row: 1, cols: 2, rows: 2 },
    { id: 'new', enabled: true, col: 5, row: 1, cols: 2, rows: 2 },
  ];
  const out = normalizeModules(saved, defaults, ['a', 'new']);
  assert.deepStrictEqual(out.map(m => [m.id, m.col, m.row]), [['a', 5, 1], ['new', 1, 3]]);
});

test('keyChange: arrows move by one cell, Shift+arrows resize', async () => {
  globalThis.window ??= { addEventListener() {} };
  const { keyChange } = await import('../core/layout-editor.js');
  const mod = { col: 3, row: 2, cols: 2, rows: 2 };
  assert.deepStrictEqual(keyChange(mod, 'ArrowLeft', false), { col: 2, row: 2 });
  assert.deepStrictEqual(keyChange(mod, 'ArrowDown', false), { col: 3, row: 3 });
  assert.deepStrictEqual(keyChange(mod, 'ArrowRight', true), { cols: 3, rows: 2 });
  assert.deepStrictEqual(keyChange(mod, 'ArrowUp', true), { cols: 2, rows: 1 });
  assert.strictEqual(keyChange(mod, 'Enter', false), null);
});

test('turning a module on puts it in the first free spot that fits, from the top-left', async () => {
  const { firstFit } = await import('../core/layout.js');
  const empty = [
    { id: 'clock', enabled: false, col: 1, row: 1, cols: 2, rows: 2 },
    { id: 'todo', enabled: false, col: 7, row: 1, cols: 6, rows: 4 },
  ];
  let out = setEnabled(empty, 'todo', true, 12);
  assert.deepStrictEqual(pick(out, 'todo'), [1, 1], 'empty page: top-left, not the default column 7');
  out = setEnabled(out, 'clock', true, 12);
  assert.deepStrictEqual(pick(out, 'clock'), [7, 1], 'next to the first one');

  const full = [{ id: 'a', enabled: true, col: 1, row: 1, cols: 12, rows: 1 }, { id: 'b', enabled: false, col: 1, row: 1, cols: 2, rows: 2 }];
  assert.deepStrictEqual(pick(setEnabled(full, 'b', true, 12), 'b'), [1, 2], 'below a full row');
  assert.deepStrictEqual(firstFit([], { id: 'w', cols: 20, rows: 1 }, 12), { col: 1, row: 1, cols: 12 }, 'too wide: clamped to the grid');
});

function pick(list, id) {
  const m = list.find(x => x.id === id);
  return [m.col, m.row];
}
