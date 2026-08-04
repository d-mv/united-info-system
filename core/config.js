import { storage } from './storage.js';

export const DEFAULT_CONFIG = {
  grid: {
    cellSize: 100,
    columns: 12,
    padding: 20
  },
  modules: [
    { id: 'clock', enabled: true, cols: 2, rows: 2, col: 1, row: 1 },
    { id: 'weather', enabled: true, cols: 2, rows: 2, col: 1, row: 2 },
    { id: 'bookmarks', enabled: true, cols: 4, rows: 4, col: 3, row: 1 },
    { id: 'todo', enabled: true, cols: 6, rows: 4, col: 7, row: 1 }
  ],
  secrets: {
    weather: {
      provider: 'openmeteo',
      apiKey: '',
      city: 'Porto',
      units: 'metric'
    }
  }
};

export class ConfigManager {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'config';
    this.storage = options.storage || storage;
  }

  get() {
    let currentConfig = this.storage.get(this.storageKey, null);
    if (!currentConfig) {
      currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.storage.set(this.storageKey, currentConfig);
    }
    return currentConfig;
  }

  update(partialConfig) {
    const existing = this.get();
    const merged = {
      ...existing,
      ...partialConfig,
      grid: {
        ...existing.grid,
        ...(partialConfig.grid || {})
      },
      secrets: {
        ...existing.secrets,
        ...(partialConfig.secrets || {})
      }
    };
    if (partialConfig.modules) {
      merged.modules = partialConfig.modules;
    }
    this.storage.set(this.storageKey, merged);
    return merged;
  }

  getSecret(widgetId) {
    const config = this.get();
    return (config.secrets && config.secrets[widgetId]) || {};
  }

  setSecret(widgetId, secretData) {
    const config = this.get();
    const secrets = config.secrets || {};
    secrets[widgetId] = {
      ...(secrets[widgetId] || {}),
      ...secretData
    };
    return this.update({ secrets });
  }

  subscribe(callback) {
    return this.storage.subscribe(this.storageKey, (newConfig) => {
      callback(newConfig || this.get());
    });
  }
}

export const configManager = new ConfigManager();
