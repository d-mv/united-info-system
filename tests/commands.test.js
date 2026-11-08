import { test } from 'node:test';
import assert from 'node:assert';
import { registerCommands, collectCommands, scoreMatch, clearCommands } from '../core/commands.js';

test('scoreMatch prefers prefix, then word start, then substring, then in-order letters', () => {
  const s = (q, t) => scoreMatch(q, t);
  assert.ok(s('git', 'GitHub') > s('git', 'Open GitHub'));
  assert.ok(s('git', 'Open GitHub') > s('git', 'digits'));
  assert.ok(s('git', 'digits') > s('gth', 'GitHub'));
  assert.strictEqual(s('xyz', 'GitHub'), -1);
  assert.strictEqual(s('', 'anything'), 0);
});

test('collectCommands ranks matches and appends query-built commands', () => {
  clearCommands();
  registerCommands('a', () => [
    { title: 'Open GitHub', keywords: 'github.com', run() {} },
    { title: 'Open Gmail', run() {} },
    { title: 'Settings', run() {} },
  ]);
  registerCommands('b', (q) => [{ title: `Add task: ${q}`, dynamic: true, run() {} }]);
  assert.deepStrictEqual(collectCommands('gith').map(c => c.title), ['Open GitHub', 'Add task: gith']);
  assert.deepStrictEqual(collectCommands('').map(c => c.title), ['Open GitHub', 'Open Gmail', 'Settings'], 'no dynamic commands without a query');
  assert.strictEqual(collectCommands('', 2).length, 2, 'limit');
});

test('a failing provider does not break the palette; unregister removes it', () => {
  clearCommands();
  registerCommands('bad', () => { throw new Error('boom'); });
  const off = registerCommands('ok', () => [{ title: 'Fine', run() {} }]);
  assert.deepStrictEqual(collectCommands('fi').map(c => c.title), ['Fine']);
  off();
  assert.deepStrictEqual(collectCommands('fi'), []);
});
