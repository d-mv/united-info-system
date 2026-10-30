import { configManager } from './config.js';
import { loadModule } from './registry.js';

export class GridEngine {
  constructor(options = {}) {
    this.shellElement = options.shellElement || (typeof document !== 'undefined' ? document.getElementById('shell') : null);
    this.configManager = options.configManager || configManager;
    this.loader = options.loader || loadModule;
    this.unsubscribe = null;
  }

  async init() {
    if (!this.shellElement) return;

    this.renderGrid();

    if (this.configManager.subscribe) {
      this.unsubscribe = this.configManager.subscribe(() => {
        this.renderGrid();
      });
    }
  }

  async renderGrid() {
    if (!this.shellElement) return;

    const config = this.configManager.get();
    const gridOpts = config.grid || { columns: 8, cellSize: 100, padding: 20 };

    this.shellElement.style['--grid-cols'] = String(gridOpts.columns);
    this.shellElement.style['--cell-size'] = `${gridOpts.cellSize}px`;
    this.shellElement.style['--module-padding'] = `${gridOpts.padding}px`;

    this.shellElement.replaceChildren();
    // Any expanded module is gone after a re-render; release the page scroll lock and scrim.
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('modal-open');

    const enabledModules = (config.modules || []).filter(m => m.enabled !== false);

    for (const modConfig of enabledModules) {
      const placeholder = this._createSkeleton(modConfig);
      this.shellElement.appendChild(placeholder);

      this._loadAndMount(modConfig, placeholder);
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

  async _loadAndMount(modConfig, placeholder) {
    const res = await this.loader(modConfig.id);

    let tagName = res.tagName;
    if (!tagName) {
      tagName = res.type === 'app' ? `app-${modConfig.id}` : `widget-${modConfig.id}`;
    }

    let realElement;
    if (res.success) {
      realElement = document.createElement(tagName);
      realElement.className = `module ${res.type === 'app' ? 'app-' : 'widget-'}${modConfig.id}`;
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
