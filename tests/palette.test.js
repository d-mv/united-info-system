import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';
import { clearCommands, collectCommands } from '../core/commands.js';

installBrowserGlobals();

test('palette shortcut: Cmd/Ctrl+K anywhere, "/" only when not typing', async () => {
  const { isPaletteShortcut } = await import('../core/palette.js');
  const body = { tagName: 'BODY' };
  assert.ok(isPaletteShortcut({ key: 'k', metaKey: true, target: body }));
  assert.ok(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT' } }));
  assert.ok(isPaletteShortcut({ key: '/', target: body }));
  assert.ok(!isPaletteShortcut({ key: '/', target: { tagName: 'TEXTAREA' } }));
  assert.ok(!isPaletteShortcut({ key: '/', target: { tagName: 'DIV', isContentEditable: true } }));
  assert.ok(!isPaletteShortcut({ key: 'k', target: body }));
});

test('palette runs the selected command and moves the selection with wrap-around', async () => {
  const { CommandPalette } = await import('../core/palette.js');
  clearCommands();
  const ran = [];
  const { registerCommands } = await import('../core/commands.js');
  registerCommands('t', () => [{ title: 'Alpha', run: () => ran.push('a') }, { title: 'Beta', run: () => ran.push('b') }]);
  const p = new CommandPalette();
  p.open();
  assert.deepStrictEqual(p.results.map(r => r.title), ['Alpha', 'Beta']);
  p.move(-1);
  assert.strictEqual(p.selected, 1, 'wraps to the last');
  p.run();
  assert.deepStrictEqual(ran, ['b']);
  assert.strictEqual(p.isOpen, false, 'closes after running');
});

test('apps contribute commands while mounted', async () => {
  clearCommands();
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const storage = makeStorage({
    'app:todo': [{ id: 't1', text: 'Write report', done: false }],
    'app:bookmarks': [{ id: 'b1', title: 'GitHub', url: 'https://github.com' }],
  });
  const todo = new TodoApp(); todo.storage = storage; todo.connectedCallback();
  const bm = new BookmarksApp(); bm.storage = storage; bm.connectedCallback();
  const clock = new ClockApp(); clock.storage = storage; clock.connectedCallback();

  assert.ok(collectCommands('git').some(c => c.title === 'GitHub'));
  const add = collectCommands('buy milk').find(c => c.title === 'Add task: buy milk');
  add.run();
  assert.strictEqual(storage.get('app:todo')[0].text, 'buy milk');
  collectCommands('report').find(c => c.title === 'Done: Write report').run();
  assert.strictEqual(storage.get('app:todo').find(t => t.id === 't1').done, true);

  collectCommands('10m').find(c => c.title === 'Start timer: 10 min').run();
  assert.strictEqual(storage.get('clock').timer.durationMs, 600000);
  assert.ok(!collectCommands('buy milk').some(c => /Start timer/.test(c.title)), 'no timer for plain text');

  clock.disconnectedCallback(); todo.disconnectedCallback(); bm.disconnectedCallback();
  assert.ok(!collectCommands('git').some(c => c.title === 'GitHub'), 'unmounted apps contribute nothing');
});
