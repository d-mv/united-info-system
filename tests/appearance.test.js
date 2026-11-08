import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';
import { resolveAppearance, applyAppearance, THEMES, ACCENTS } from '../core/appearance.js';

installBrowserGlobals();

test('resolveAppearance falls back to auto + red for anything unknown', () => {
  assert.deepStrictEqual(resolveAppearance(undefined), { theme: 'auto', accent: 'red' });
  assert.deepStrictEqual(resolveAppearance({ theme: 'dark', accent: 'blue' }), { theme: 'dark', accent: 'blue' });
  assert.deepStrictEqual(resolveAppearance({ theme: 'neon', accent: 'pink' }), { theme: 'auto', accent: 'red' });
  assert.deepStrictEqual(THEMES, ['auto', 'light', 'dark']);
  assert.ok(ACCENTS.includes('red') && ACCENTS.includes('graphite'));
});

test('applyAppearance sets data attributes only for non-defaults', () => {
  const root = { dataset: {} };
  applyAppearance({ theme: 'dark', accent: 'green' }, root);
  assert.deepStrictEqual({ ...root.dataset }, { theme: 'dark', accent: 'green' });
  applyAppearance({ theme: 'auto', accent: 'red' }, root);
  assert.deepStrictEqual({ ...root.dataset }, {});
});

test('Settings changes theme and accent; palette offers theme commands', async () => {
  const { ShellBar } = await import('../core/shell-bar.js');
  const { ConfigManager } = await import('../core/config.js');
  const { collectCommands, clearCommands } = await import('../core/commands.js');
  clearCommands();
  const bar = new ShellBar();
  bar.storage = makeStorage();
  bar.configManager = new ConfigManager({ storage: bar.storage });
  bar.connectedCallback();
  bar.openSettings();
  assert.ok(bar.innerHTML.includes('name="theme" value="dark"'));
  assert.ok(bar.innerHTML.includes('name="accent" value="blue"'));
  bar.setAppearance({ theme: 'dark' });
  bar.setAppearance({ accent: 'blue' });
  assert.deepStrictEqual(bar.configManager.get().appearance, { theme: 'dark', accent: 'blue' });

  collectCommands('light').find(c => c.title === 'Theme: Light').run();
  assert.strictEqual(bar.configManager.get().appearance.theme, 'light');
  bar.disconnectedCallback();
});
