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

test('fillGaps grows modules right, then down, into empty cells without overlaps', async () => {
  const { fillGaps } = await import('../core/layout.js');
  const layout = [
    { id: 'clock', enabled: true, col: 1, row: 1, cols: 2, rows: 2 },
    { id: 'todo', enabled: true, col: 7, row: 1, cols: 6, rows: 4 },
    { id: 'cur', enabled: true, col: 1, row: 5, cols: 3, rows: 2 },
    { id: 'off', enabled: false, col: 3, row: 1, cols: 2, rows: 2 },
  ];
  const out = fillGaps(layout, 12);
  assert.deepStrictEqual(out.clock, { col: 1, row: 1, cols: 6, rows: 4 }, 'right to todo, then down to the bottom of todo');
  assert.deepStrictEqual(out.todo, { col: 7, row: 1, cols: 6, rows: 4 });
  assert.deepStrictEqual(out.cur, { col: 1, row: 5, cols: 12, rows: 2 }, 'full last row');
  assert.strictEqual(out.off, undefined, 'hidden modules are not placed');
});

test('fillGaps also grows left/up into gaps nobody borders from the left or top', async () => {
  const { fillGaps } = await import('../core/layout.js');
  const out = fillGaps([{ id: 'a', enabled: true, col: 4, row: 3, cols: 2, rows: 1 }], 6);
  assert.deepStrictEqual(out.a, { col: 1, row: 1, cols: 6, rows: 3 });
});

test('fillGaps never overlaps and never shrinks (random layouts)', async () => {
  const { fillGaps } = await import('../core/layout.js');
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 300; round++) {
    let mods = [];
    for (let i = 0; i < 6; i++) {
      const cand = { id: `m${i}`, enabled: true, col: 1 + rand(10), row: 1 + rand(8), cols: 1 + rand(4), rows: 1 + rand(3) };
      if (cand.col + cand.cols - 1 <= 12 && !collides(mods, cand)) mods.push(cand);
    }
    const out = fillGaps(mods, 12);
    const rects = Object.entries(out).map(([id, r]) => ({ id, enabled: true, ...r }));
    for (const r of rects) {
      assert.strictEqual(collides(rects, r), false, `overlap in round ${round}`);
      const orig = mods.find(m => m.id === r.id);
      assert.ok(r.col <= orig.col && r.row <= orig.row && r.col + r.cols >= orig.col + orig.cols && r.row + r.rows >= orig.row + orig.rows, 'contains original');
      assert.ok(r.col + r.cols - 1 <= 12, 'inside the grid');
    }
  }
});

test('moveWithPush: the dropped module takes the spot, overlapped ones move down, the rest close up', async () => {
  const { moveWithPush } = await import('../core/layout.js');
  const layout = [
    { id: 'a', enabled: true, col: 1, row: 1, cols: 2, rows: 2 },
    { id: 'b', enabled: true, col: 1, row: 3, cols: 2, rows: 2 },
    { id: 'c', enabled: true, col: 3, row: 1, cols: 4, rows: 4 },
    { id: 'off', enabled: false, col: 1, row: 1, cols: 2, rows: 2 },
  ];
  // Drop b on top of a: a is pushed below b.
  let out = moveWithPush(layout, 'b', { col: 1, row: 1 }, 12);
  const at = (id) => { const m = out.find(x => x.id === id); return [m.col, m.row]; };
  assert.deepStrictEqual(at('b'), [1, 1]);
  assert.deepStrictEqual(at('a'), [1, 3]);
  assert.deepStrictEqual(at('c'), [3, 1]);
  assert.deepStrictEqual(at('off'), [1, 1], 'hidden modules are left alone');

  // Drop a far below: others close the hole it leaves, a stays where dropped.
  out = moveWithPush(layout, 'a', { col: 1, row: 9 }, 12);
  assert.deepStrictEqual(at('b'), [1, 1], 'b closes up');
  assert.deepStrictEqual(at('a'), [1, 9]);

  assert.strictEqual(moveWithPush(layout, 'c', { col: 10, row: 1 }, 12), null, 'off the right edge');
});

test('moveWithPush never leaves overlaps (random drops)', async () => {
  const { moveWithPush } = await import('../core/layout.js');
  const base = [
    { id: 'a', enabled: true, col: 1, row: 1, cols: 2, rows: 2 },
    { id: 'b', enabled: true, col: 1, row: 3, cols: 2, rows: 2 },
    { id: 'c', enabled: true, col: 3, row: 1, cols: 4, rows: 4 },
    { id: 'd', enabled: true, col: 7, row: 1, cols: 6, rows: 4 },
    { id: 'e', enabled: true, col: 1, row: 5, cols: 3, rows: 2 },
  ];
  for (const m of base) for (let col = 1; col <= 12; col++) for (let row = 1; row <= 8; row++) {
    const out = moveWithPush(base, m.id, { col, row }, 12);
    if (!out) continue;
    for (const x of out) assert.strictEqual(collides(out, x), false, `${m.id} -> ${col},${row}`);
    const moved = out.find(x => x.id === m.id);
    assert.deepStrictEqual([moved.col, moved.row], [col, row]);
  }
});
