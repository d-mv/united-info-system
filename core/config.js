import { storage } from './storage.js';
import { registry } from './registry.js';
import { normalizeModules } from './layout.js';

// v3: grid values are applied for the first time; padding default matches the theme (16px).
// v4: layout is user-editable, so saved module placement is kept from now on.
// v5: pages. Modules (which ones are on, and where) live in pages[]; the old
//     top-level `modules` becomes the first page, "Home".
// New modules don't need a bump: normalizeModules() appends missing defaults.
export const CONFIG_VERSION = 5;

const clone = (value) => JSON.parse(JSON.stringify(value));
const newPageId = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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
    { id: 'todo', enabled: true, cols: 6, rows: 4, col: 7, row: 1 },
    { id: 'notes', enabled: true, cols: 4, rows: 4, col: 1, row: 5 }
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

/**
 * Stored: { version, grid, pages: [{ id, name, modules }], activePage, appearance, secrets }.
 *
 * Each manager (one per tab) has its own current page: `pageId` when set,
 * else the stored `activePage` (the last page switched to, in any tab).
 * get() returns the stored config plus `modules` = the current page's
 * modules, and update({ modules }) writes them back into that page, so the
 * grid and layout editor work on "the modules of this page" unchanged.
 */
export class ConfigManager {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'config';
    this.storage = options.storage || storage;
    this.pageId = options.pageId || null;
  }

  /** The stored config, created / migrated / normalized as needed (writes back if it changed). */
  read() {
    const raw = this.storage.get(this.storageKey, null);
    let config;
    if (!raw) config = this._fresh();
    else if (raw.version !== CONFIG_VERSION) config = this._migrate(raw);
    else config = raw;
    const normalized = this._normalize(config);
    if (!raw || JSON.stringify(normalized) !== JSON.stringify(raw)) this.storage.set(this.storageKey, normalized);
    return normalized;
  }

  get() {
    const config = this.read();
    return { ...config, modules: this._page(config).modules };
  }

  _fresh() {
    const { modules, ...rest } = clone(DEFAULT_CONFIG);
    return { ...rest, pages: [{ id: 'home', name: 'Home', modules }], activePage: 'home' };
  }

  // Before v3 the layout wasn't editable, so module positions come from the
  // defaults (keeping enabled flags); from v3 on the saved placement is kept.
  // Grid settings saved before v3 were never applied, so they reset to defaults.
  _migrate(oldConfig) {
    const defaults = clone(DEFAULT_CONFIG);
    const oldModules = Array.isArray(oldConfig.modules) ? oldConfig.modules : [];
    const enabledById = new Map(oldModules.map(m => [m.id, m.enabled]));
    const modules = oldConfig.version >= 3
      ? oldModules
      : defaults.modules.map(m => (enabledById.has(m.id) ? { ...m, enabled: enabledById.get(m.id) } : m));
    const { modules: _old, ...rest } = oldConfig;
    return {
      ...rest,
      version: CONFIG_VERSION,
      grid: oldConfig.version >= 3 ? { ...defaults.grid, ...(oldConfig.grid || {}) } : defaults.grid,
      pages: Array.isArray(oldConfig.pages) ? oldConfig.pages : [{ id: 'home', name: 'Home', modules }],
      activePage: oldConfig.activePage || 'home',
      secrets: { ...defaults.secrets, ...(oldConfig.secrets || {}) },
    };
  }

  // Every page holds every known module. The first page gets missing defaults
  // switched on (a module added to UIS shows up); other pages get them off.
  _normalize(config) {
    const known = Object.keys(registry);
    let pages = Array.isArray(config.pages) && config.pages.length
      ? config.pages
      : [{ id: 'home', name: 'Home', modules: Array.isArray(config.modules) ? config.modules : DEFAULT_CONFIG.modules }];
    pages = pages.map((page, i) => {
      const defaults = i === 0 ? DEFAULT_CONFIG.modules : DEFAULT_CONFIG.modules.map(m => ({ ...m, enabled: false }));
      return { ...page, modules: normalizeModules(page.modules, defaults, known) };
    });
    const activePage = pages.some(p => p.id === config.activePage) ? config.activePage : pages[0].id;
    const { modules: _legacy, ...rest } = config;
    return { ...rest, version: CONFIG_VERSION, pages, activePage };
  }

  // The first page this tab reads is its page from then on, so another tab
  // switching pages doesn't move this one.
  _page(config) {
    const page = config.pages.find(p => p.id === this.pageId)
      || config.pages.find(p => p.id === config.activePage)
      || config.pages[0];
    this.pageId = page.id;
    return page;
  }

  _write(config) {
    const { modules: _derived, ...stored } = config;
    this.storage.set(this.storageKey, stored);
  }

  // ---------- Pages ----------

  getPages() {
    return this.read().pages.map(({ id, name }) => ({ id, name }));
  }

  currentPageId() {
    return this._page(this.read()).id;
  }

  /** Show page `id` in this tab; also the page new tabs open on. */
  switchPage(id) {
    const config = this.read();
    if (!config.pages.some(p => p.id === id)) return false;
    this.pageId = id;
    this._write({ ...config, activePage: id });
    return true;
  }

  /** Add an empty page (every module off). Returns its id. */
  addPage(name) {
    const config = this.read();
    const id = newPageId();
    const clean = String(name || '').trim() || `Page ${config.pages.length + 1}`;
    const modules = DEFAULT_CONFIG.modules.map(m => ({ ...m, enabled: false }));
    this._write({ ...config, pages: [...config.pages, { id, name: clean, modules }] });
    return id;
  }

  renamePage(id, name) {
    const clean = String(name || '').trim();
    const config = this.read();
    if (!clean || !config.pages.some(p => p.id === id)) return false;
    this._write({ ...config, pages: config.pages.map(p => (p.id === id ? { ...p, name: clean } : p)) });
    return true;
  }

  /** Delete a page (never the last one). A tab showing it moves to the first page. */
  deletePage(id) {
    const config = this.read();
    if (config.pages.length <= 1 || !config.pages.some(p => p.id === id)) return false;
    const pages = config.pages.filter(p => p.id !== id);
    const activePage = config.activePage === id ? pages[0].id : config.activePage;
    if (this.pageId === id) this.pageId = activePage;
    this._write({ ...config, pages, activePage });
    return true;
  }

  // ---------- Modules of the current page ----------

  getModules() {
    return this.get().modules || [];
  }

  setModules(modules) {
    return this.update({ modules });
  }

  update(partialConfig) {
    const existing = this.read();
    const { modules, ...rest } = partialConfig;
    const merged = {
      ...existing,
      ...rest,
      grid: { ...existing.grid, ...(rest.grid || {}) },
      secrets: { ...existing.secrets, ...(rest.secrets || {}) },
    };
    if (modules) {
      const current = this._page(existing).id;
      merged.pages = existing.pages.map(p => (p.id === current ? { ...p, modules } : p));
    }
    this._write(merged);
    return { ...merged, modules: this._page(merged).modules };
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

  /** Called with get() (so `modules` is this tab's page) after every change, in any tab. */
  subscribe(callback) {
    return this.storage.subscribe(this.storageKey, () => callback(this.get()));
  }
}

export const configManager = new ConfigManager();
