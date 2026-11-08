import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';

installBrowserGlobals();

test('ShellBar opens Settings with export and import', async () => {
  const { ShellBar } = await import('../core/shell-bar.js');
  const bar = new ShellBar();
  bar.storage = makeStorage();
  bar.connectedCallback();
  assert.ok(bar.innerHTML.includes('data-action="open-settings"'));
  assert.ok(!bar.innerHTML.includes('<dialog'));
  bar.openSettings();
  assert.ok(bar.innerHTML.includes('data-action="export"'));
  assert.ok(bar.innerHTML.includes('data-action="import"'));
});

test('ShellBar import asks before replacing data and explains bad files', async () => {
  const { ShellBar } = await import('../core/shell-bar.js');
  const bar = new ShellBar();
  bar.storage = makeStorage({ 'app:todo': [{ id: 'old' }] });
  bar.openSettings();

  assert.strictEqual(bar.readImport('nope'), 'Err');
  assert.ok(bar.innerHTML.includes('not valid JSON'));

  const backup = { app: 'uis', format: 1, exportedAt: '2026-11-08T10:00:00Z', data: { 'app:todo': [{ id: 'new' }] } };
  assert.strictEqual(bar.readImport(JSON.stringify(backup)), 'Ok');
  assert.ok(bar.innerHTML.includes('1 item'));
  assert.deepStrictEqual(bar.storage.get('app:todo'), [{ id: 'old' }], 'nothing written before confirming');

  globalThis.location = { reload: () => { globalThis.__reloaded = true; } };
  bar.confirmImport();
  assert.deepStrictEqual(bar.storage.get('app:todo'), [{ id: 'new' }]);
  assert.strictEqual(globalThis.__reloaded, true, 'page reloads so modules re-read their data');
  delete globalThis.location;
});

test('Settings lists modules and switches them on and off', async () => {
  const { ShellBar } = await import('../core/shell-bar.js');
  const { ConfigManager } = await import('../core/config.js');
  const bar = new ShellBar();
  bar.storage = makeStorage();
  bar.configManager = new ConfigManager({ storage: bar.storage });
  bar.openSettings();
  assert.ok(bar.innerHTML.includes('data-action="toggle-module" data-id="weather"'));
  bar.toggleModule('weather', false);
  assert.strictEqual(bar.configManager.getModules().find(m => m.id === 'weather').enabled, false);
  bar.toggleModule('weather', true);
  assert.strictEqual(bar.configManager.getModules().find(m => m.id === 'weather').enabled, true);
});

test('page tabs appear with two pages; palette can switch and add pages', async () => {
  const { ShellBar } = await import('../core/shell-bar.js');
  const { ConfigManager } = await import('../core/config.js');
  const { collectCommands, clearCommands } = await import('../core/commands.js');
  clearCommands();
  globalThis.history = { replaceState: (a, b, url) => { globalThis.__hash = url; } };
  const bar = new ShellBar();
  bar.storage = makeStorage();
  bar.configManager = new ConfigManager({ storage: bar.storage });
  bar.connectedCallback();
  assert.ok(!bar.innerHTML.includes('class="shell-tab'), 'no tabs with one page');

  collectCommands('new page').find(c => c.title === 'New page').run();
  bar.render();
  assert.strictEqual((bar.innerHTML.match(/class="shell-tab/g) || []).length, 2);
  assert.ok(/^#page=p_/.test(globalThis.__hash), 'URL follows the page');

  collectCommands('home').find(c => c.title === 'Go to page: Home').run();
  assert.strictEqual(bar.configManager.currentPageId(), 'home');
  assert.strictEqual(globalThis.__hash, '#page=home');
  bar.disconnectedCallback();
  delete globalThis.history;
});
