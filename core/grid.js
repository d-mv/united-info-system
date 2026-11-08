import { configManager } from './config.js';
import { loadModule } from './registry.js';

// The part of the config the grid draws. Widget settings live in the same
// config key but must not tear down the dashboard when they change.
const layoutOf = (config) => JSON.stringify({ grid: config.grid, modules: config.modules });

// What needs a remount: the grid settings and which modules are shown, in order.
// Moving or resizing a shown module only changes its placement.
const mountsOf = (config) => JSON.stringify({
  grid: config.grid,
  ids: (config.modules || []).filter(m => m.enabled !== false).map(m => m.id),
});

export class GridEngine {
  constructor(options = {}) {
    this.shellElement = options.shellElement || (typeof document !== 'undefined' ? document.getElementById('shell') : null);
    this.configManager = options.configManager || configManager;
    this.loader = options.loader || loadModule;
    this.unsubscribe = null;
    this.renderedLayout = null;
    // Bumped on every render; a load started by an older render must not mount.
    this.renderGen = 0;
  }

  async init() {
    if (!this.shellElement) return;

    this.renderGrid();

    if (this.configManager.subscribe) {
      this.unsubscribe = this.configManager.subscribe((config) => {
        if (layoutOf(config) === this.renderedLayout) return;
        if (mountsOf(config) === this.renderedMounts) this.updatePlacement(config);
        else this.renderGrid();
      });
    }
  }

  async renderGrid() {
    if (!this.shellElement) return;

    const config = this.configManager.get();
    this.renderedLayout = layoutOf(config);
    this.renderedMounts = mountsOf(config);
    const gridOpts = config.grid || { columns: 8, cellSize: 100, padding: 20 };

    // Custom properties only take effect through setProperty().
    this.shellElement.style.setProperty('--grid-cols', String(gridOpts.columns));
    this.shellElement.style.setProperty('--cell-size', `${gridOpts.cellSize}px`);
    this.shellElement.style.setProperty('--module-padding', `${gridOpts.padding}px`);

    const gen = ++this.renderGen;
    this.shellElement.replaceChildren();
    // Any expanded module is gone after a re-render; release the page scroll lock and scrim.
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('modal-open');

    const enabledModules = (config.modules || []).filter(m => m.enabled !== false);
    if (!enabledModules.length) {
      const empty = document.createElement('p');
      empty.className = 'shell-empty label';
      empty.textContent = 'This page is empty. Turn modules on in Settings → Modules.';
      this.shellElement.appendChild(empty);
    }

    for (const modConfig of enabledModules) {
      const placeholder = this._createSkeleton(modConfig);
      this.shellElement.appendChild(placeholder);

      this._loadAndMount(modConfig, placeholder, gen);
    }
  }

  /** Re-place mounted modules (and skeletons still loading) without remounting them. */
  updatePlacement(config) {
    this.renderedLayout = layoutOf(config);
    const byId = new Map((config.modules || []).map(m => [m.id, m]));
    for (const el of this.shellElement.children) {
      const modConfig = el.dataset && byId.get(el.dataset.module);
      if (modConfig) this._applyGridStyle(el, modConfig);
    }
  }

  _createSkeleton(modConfig) {
    const el = document.createElement('div');
    el.className = 'module module-skeleton';
    el.dataset.module = modConfig.id;
    this._applyGridStyle(el, modConfig);
    return el;
  }

  _applyGridStyle(el, modConfig) {
    el.style['grid-column'] = `${modConfig.col || 1} / span ${modConfig.cols || 1}`;
    el.style['grid-row'] = `${modConfig.row || 1} / span ${modConfig.rows || 1}`;
  }

  async _loadAndMount(modConfig, placeholder, gen) {
    const res = await this.loader(modConfig.id);
    if (gen !== this.renderGen) return;

    let realElement;
    if (res.success) {
      // Custom element tag and class follow the module type: widget-weather, app-todo.
      const name = `${res.type === 'app' ? 'app' : 'widget'}-${modConfig.id}`;
      realElement = document.createElement(name);
      realElement.className = `module ${name}`;
    } else {
      realElement = document.createElement('div');
      realElement.className = 'module module-error';
      realElement.innerHTML = `<p class="label">Error</p><span>Failed to load ${modConfig.id}</span>`;
    }

    realElement.dataset.module = modConfig.id;
    this._applyGridStyle(realElement, modConfig);

    this.shellElement.replaceChild(realElement, placeholder);
  }

  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
