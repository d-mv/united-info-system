import { storage } from './storage.js';

// Bump when DEFAULT_CONFIG.modules layout changes; older saved configs get the new layout.
export const CONFIG_VERSION = 2;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  grid: {
    cellSize: 100,
    columns: 12,
    padding: 20
  },
  modules: [
    { id: 'clock', enabled: true, cols: 2, rows: 2, col: 1, row: 1 },
    { id: 'weather', enabled: true, cols: 2, rows: 2, col: 1, row: 3 },
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
    } else if (currentConfig.version !== CONFIG_VERSION) {
      currentConfig = this._migrate(currentConfig);
      this.storage.set(this.storageKey, currentConfig);
    }
    return currentConfig;
  }

  // Layout isn't user-editable yet, so module positions come from the defaults.
  // Keep what the user did choose: enabled flags, grid settings and secrets.
  _migrate(oldConfig) {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const oldModules = Array.isArray(oldConfig.modules) ? oldConfig.modules : [];
    const enabledById = new Map(oldModules.map(m => [m.id, m.enabled]));
    return {
      ...defaults,
      grid: { ...defaults.grid, ...(oldConfig.grid || {}) },
      modules: defaults.modules.map(m => (
        enabledById.has(m.id) ? { ...m, enabled: enabledById.get(m.id) } : m
      )),
      secrets: { ...defaults.secrets, ...(oldConfig.secrets || {}) },
    };
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
