import { test } from 'node:test';
import assert from 'node:assert';
import { ConfigManager } from '../core/config.js';
import { installBrowserGlobals } from './helpers/fake-browser.js';

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
