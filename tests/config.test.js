import { test } from 'node:test';
import assert from 'node:assert';
import { ConfigManager, CONFIG_VERSION } from '../core/config.js';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';

installBrowserGlobals();

test('ConfigManager generates default config on cold boot', () => {
  localStorage.clear();
  const configManager = new ConfigManager();
  const config = configManager.get();

  assert.ok(config);
  assert.strictEqual(config.grid.columns, 12);
  assert.strictEqual(config.grid.cellSize, 100);
  assert.ok(Array.isArray(config.modules));
  assert.strictEqual(config.modules.length, 4);

  // Assert stored in localStorage
  const rawStored = localStorage.getItem('dashboard:config');
  assert.ok(rawStored);
  assert.strictEqual(JSON.parse(rawStored).grid.columns, 12);
});

test('ConfigManager updates config and secret settings', () => {
  localStorage.clear();
  const configManager = new ConfigManager();

  configManager.setSecret('weather', { apiKey: 'test_key_123', city: 'Tokyo' });
  const weatherSecrets = configManager.getSecret('weather');
  assert.deepStrictEqual(weatherSecrets, { provider: 'openmeteo', apiKey: 'test_key_123', city: 'Tokyo', units: 'metric' });

  let updated = false;
  configManager.subscribe((cfg) => {
    if (cfg.grid.columns === 12) updated = true;
  });

  configManager.update({ grid: { columns: 12, cellSize: 120, padding: 20 } });
  assert.strictEqual(updated, true);
  assert.strictEqual(configManager.get().grid.columns, 12);
});

test('ConfigManager migrates an old saved layout and keeps secrets and enabled flags', () => {
  localStorage.clear();
  localStorage.setItem('dashboard:config', JSON.stringify({
    grid: { cellSize: 100, columns: 12, padding: 20 },
    modules: [
      { id: 'clock', enabled: true, cols: 2, rows: 2, col: 1, row: 1 },
      { id: 'weather', enabled: true, cols: 2, rows: 2, col: 1, row: 2 },
      { id: 'bookmarks', enabled: false, cols: 4, rows: 4, col: 3, row: 1 },
      { id: 'todo', enabled: true, cols: 6, rows: 4, col: 7, row: 1 }
    ],
    secrets: { weather: { provider: 'openweathermap', apiKey: 'k', city: 'Oslo', units: 'metric' } }
  }));

  const config = new ConfigManager().get();
  const byId = Object.fromEntries(config.modules.map(m => [m.id, m]));

  assert.strictEqual(byId.weather.row, 3, 'weather moves below the clock');
  assert.strictEqual(byId.bookmarks.enabled, false, 'enabled flag is kept');
  assert.strictEqual(config.secrets.weather.city, 'Oslo', 'secrets are kept');
  assert.strictEqual(JSON.parse(localStorage.getItem('dashboard:config')).version, config.version, 'migration is saved');
});

test('Default layout has no overlapping modules', async () => {
  const { DEFAULT_CONFIG } = await import('../core/config.js');
  const cells = new Set();
  for (const m of DEFAULT_CONFIG.modules) {
    for (let c = m.col; c < m.col + m.cols; c++) {
      for (let r = m.row; r < m.row + m.rows; r++) {
        const key = `${c}:${r}`;
        assert.ok(!cells.has(key), `${m.id} overlaps at column ${c}, row ${r}`);
        cells.add(key);
      }
    }
  }
});

test('ConfigManager resets grid settings saved before they were applied (v3)', () => {
  localStorage.clear();
  localStorage.setItem('dashboard:config', JSON.stringify({
    version: 2,
    grid: { cellSize: 100, columns: 12, padding: 20 },
    modules: [],
    secrets: {}
  }));
  const config = new ConfigManager().get();
  assert.strictEqual(config.grid.padding, 16, 'matches the theme default, so the look does not change');
});

test('v3 -> v4 keeps the saved module placement', () => {
  const storage = makeStorage({ config: {
    version: 3,
    grid: { cellSize: 100, columns: 12, padding: 16 },
    modules: [
      { id: 'clock', enabled: true, cols: 2, rows: 2, col: 9, row: 5 },
      { id: 'weather', enabled: false, cols: 2, rows: 2, col: 1, row: 3 },
      { id: 'bookmarks', enabled: true, cols: 4, rows: 4, col: 3, row: 1 },
      { id: 'todo', enabled: true, cols: 6, rows: 4, col: 7, row: 1 },
    ],
    secrets: {},
  } });
  const config = new ConfigManager({ storage }).get();
  assert.strictEqual(config.version, CONFIG_VERSION);
  const clock = config.modules.find(m => m.id === 'clock');
  assert.deepStrictEqual([clock.col, clock.row], [9, 5]);
  assert.strictEqual(config.modules.find(m => m.id === 'weather').enabled, false);
});

test('a current config gains modules added to the defaults later', async () => {
  const { registerModule } = await import('../core/registry.js');
  const { DEFAULT_CONFIG } = await import('../core/config.js');
  const storage = makeStorage();
  const manager = new ConfigManager({ storage });
  manager.get();
  registerModule('later', { type: 'app', load: async () => ({}) });
  DEFAULT_CONFIG.modules.push({ id: 'later', enabled: true, cols: 2, rows: 2, col: 1, row: 1 });
  try {
    const later = manager.get().modules.find(m => m.id === 'later');
    assert.ok(later, 'appended');
    assert.strictEqual(later.row, 5, 'below everything instead of on top of the clock');
  } finally {
    DEFAULT_CONFIG.modules.pop();
  }
});

test('pages: an older config becomes one "Home" page holding its modules', () => {
  const storage = makeStorage({ config: {
    version: 4, grid: { cellSize: 100, columns: 12, padding: 16 },
    modules: [{ id: 'clock', enabled: true, cols: 2, rows: 2, col: 5, row: 5 }], secrets: {},
  } });
  const manager = new ConfigManager({ storage });
  const config = manager.get();
  const stored = storage.get('config');
  assert.strictEqual(stored.modules, undefined, 'modules live inside pages now');
  assert.deepStrictEqual(stored.pages.map(p => p.name), ['Home']);
  assert.deepStrictEqual([config.modules[0].col, config.modules[0].row], [5, 5], 'placement kept');
  assert.ok(config.modules.some(m => m.id === 'todo'), 'missing defaults appended');
});

test('pages: add, switch, rename, delete; modules are per page', () => {
  const storage = makeStorage();
  const manager = new ConfigManager({ storage });
  const home = manager.currentPageId();
  const work = manager.addPage('Work');
  assert.ok(manager.getModules().some(m => m.enabled !== false), 'still on Home');

  manager.switchPage(work);
  assert.strictEqual(manager.currentPageId(), work);
  assert.ok(manager.getModules().every(m => m.enabled === false), 'a new page starts empty');
  assert.strictEqual(storage.get('config').activePage, work, 'remembered for new tabs');

  manager.setModules(manager.getModules().map(m => (m.id === 'todo' ? { ...m, enabled: true } : m)));
  manager.switchPage(home);
  assert.ok(manager.getModules().find(m => m.id === 'clock').enabled, 'Home untouched');

  manager.renamePage(work, '  Office ');
  assert.deepStrictEqual(manager.getPages().map(p => p.name), ['Home', 'Office']);
  assert.strictEqual(manager.renamePage(work, '   '), false, 'blank name refused');

  manager.switchPage(work);
  manager.deletePage(work);
  assert.strictEqual(manager.currentPageId(), home, 'deleting the current page goes to another');
  assert.strictEqual(manager.deletePage(home), false, 'the last page cannot be deleted');
});

test('pages: each ConfigManager (tab) keeps its own current page', () => {
  const storage = makeStorage();
  const tabA = new ConfigManager({ storage });
  tabA.currentPageId(); // the tab has booted on Home
  const work = tabA.addPage('Work');
  const tabB = new ConfigManager({ storage });
  tabB.switchPage(work);
  assert.notStrictEqual(tabA.currentPageId(), work, 'tab A stays where it was');
  const tabC = new ConfigManager({ storage });
  assert.strictEqual(tabC.currentPageId(), work, 'a new tab opens the last used page');
});
