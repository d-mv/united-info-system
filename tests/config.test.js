import { test } from 'node:test';
import assert from 'node:assert';
import { ConfigManager } from '../core/config.js';

// Setup Mock Window / LocalStorage
class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, val) {
    this.store.set(key, String(val));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(cb);
  }
  removeEventListener(type, cb) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(cb);
  }
  dispatchEvent(event) {
    if (this.listeners.has(event.type)) {
      for (const cb of this.listeners.get(event.type)) cb(event);
    }
  }
}

globalThis.window = new MockEventTarget();
globalThis.localStorage = new MockLocalStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
  }
};

test('ConfigManager generates default config on cold boot', () => {
  localStorage.clear();
  const configManager = new ConfigManager();
  const config = configManager.get();

  assert.ok(config);
  assert.strictEqual(config.grid.columns, 8);
  assert.strictEqual(config.grid.cellSize, 100);
  assert.ok(Array.isArray(config.modules));
  assert.strictEqual(config.modules.length, 4);

  // Assert stored in localStorage
  const rawStored = localStorage.getItem('dashboard:config');
  assert.ok(rawStored);
  assert.strictEqual(JSON.parse(rawStored).grid.columns, 8);
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
