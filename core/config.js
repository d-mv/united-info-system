import { storage } from './storage.js';
import { registry } from './registry.js';
import { normalizeModules } from './layout.js';

// v3: grid values are applied for the first time; padding default matches the theme (16px).
// v4: layout is user-editable, so saved module placement is kept from now on.
// New modules don't need a bump: normalizeModules() appends missing defaults.
export const CONFIG_VERSION = 4;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  grid: {
    cellSize: 100,
    columns: 12,
    padding: 16
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
    } else {
      // Modules added or removed since this config was saved.
      const modules = normalizeModules(currentConfig.modules, DEFAULT_CONFIG.modules, Object.keys(registry));
      if (JSON.stringify(modules) !== JSON.stringify(currentConfig.modules)) {
        currentConfig = { ...currentConfig, modules };
        this.storage.set(this.storageKey, currentConfig);
      }
    }
    return currentConfig;
  }

  // Before v3 the layout wasn't editable, so module positions come from the
  // defaults (keeping enabled flags); from v3 on the saved placement is kept.
  // Grid settings saved before v3 were never applied, so they reset to defaults.
  _migrate(oldConfig) {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const oldModules = Array.isArray(oldConfig.modules) ? oldConfig.modules : [];
    const enabledById = new Map(oldModules.map(m => [m.id, m.enabled]));
    const modules = oldConfig.version >= 3
      ? oldModules
      : defaults.modules.map(m => (enabledById.has(m.id) ? { ...m, enabled: enabledById.get(m.id) } : m));
    return {
      ...oldConfig,
      ...defaults,
      grid: oldConfig.version >= 3 ? { ...defaults.grid, ...(oldConfig.grid || {}) } : defaults.grid,
      modules: normalizeModules(modules, defaults.modules, Object.keys(registry)),
      secrets: { ...defaults.secrets, ...(oldConfig.secrets || {}) },
    };
  }

  getModules() {
    return this.get().modules || [];
  }

  setModules(modules) {
    return this.update({ modules });
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
