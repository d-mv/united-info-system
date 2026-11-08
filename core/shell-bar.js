/**
 * <shell-bar>: the slim bar above the grid. Holds the Settings dialog
 * (data export/import for now).
 */
import { storage } from './storage.js';
import { configManager } from './config.js';
import { moduleName } from './registry.js';
import { setEnabled } from './layout.js';
import { TOGGLE_LAYOUT, LAYOUT_MODE } from './layout-editor.js';
import { escapeHtml } from './html.js';
import { buildBackup, parseBackup, restoreBackup, downloadBackup } from './backup.js';
import { registerCommands } from './commands.js';
import { OPEN_PALETTE } from './palette.js';

export class ShellBar extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.configManager = configManager;
    this.settingsOpen = false;
    this.layoutEditing = false;
    this._onLayoutMode = (e) => {
      this.layoutEditing = !!(e.detail && e.detail.editing);
      if (!this.settingsOpen) this.render();
    };
    // Import flow: null | { backup, summary } waiting for confirmation | { error }
    this.importState = null;
    this._onClick = (e) => this.handleClick(e);
  }

  connectedCallback() {
    if (typeof this.addEventListener === 'function') this.addEventListener('click', this._onClick);
    this.offCommands = registerCommands('shell', () => [
      { title: 'Settings', keywords: 'preferences options', run: () => this.openSettings() },
      { title: 'Export backup', keywords: 'download data json', run: () => this.exportData() },
      { title: this.layoutEditing ? 'Finish editing layout' : 'Edit layout', keywords: 'move resize arrange modules', run: () => this.toggleLayout() },
    ]);
    if (typeof document !== 'undefined') document.addEventListener(LAYOUT_MODE, this._onLayoutMode);
    this.render();
  }

  toggleLayout() {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(TOGGLE_LAYOUT));
  }

  toggleModule(id, enabled) {
    this.configManager.setModules(setEnabled(this.configManager.getModules(), id, enabled));
  }

  disconnectedCallback() {
    if (typeof this.removeEventListener === 'function') this.removeEventListener('click', this._onClick);
    if (this.offCommands) this.offCommands();
    if (typeof document !== 'undefined') document.removeEventListener(LAYOUT_MODE, this._onLayoutMode);
  }

  openSettings() {
    this.settingsOpen = true;
    this.importState = null;
    this.render();
  }

  closeSettings() {
    this.settingsOpen = false;
    this.importState = null;
    this.render();
    const btn = this.querySelector?.('[data-action="open-settings"]');
    if (btn && btn.focus) btn.focus();
  }

  exportData() {
    downloadBackup(buildBackup(this.storage));
  }

  /** Check a picked file; a valid backup waits for confirmation. */
  readImport(text) {
    const result = parseBackup(text);
    if (result._tag === 'Err') {
      this.importState = { error: result.error };
    } else {
      const count = Object.keys(result.value.data).length;
      const when = new Date(result.value.exportedAt);
      const date = Number.isNaN(when.getTime()) ? 'an unknown date' : when.toLocaleString();
      this.importState = { backup: result.value, summary: `Backup from ${date} · ${count} item${count === 1 ? '' : 's'}` };
    }
    this.render();
    return result._tag;
  }

  confirmImport() {
    if (!this.importState || !this.importState.backup) return;
    restoreBackup(this.storage, this.importState.backup);
    // Every module re-reads its data on a fresh load; simpler and safer than live-patching.
    if (typeof location !== 'undefined' && location.reload) location.reload();
  }

  handleClick(e) {
    const target = e.target;
    if (target && target.tagName === 'DIALOG') return this.closeSettings(); // backdrop
    const btn = target && target.closest ? target.closest('[data-action]') : null;
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'open-settings': return this.openSettings();
      case 'open-palette':
        if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(OPEN_PALETTE));
        return;
      case 'close-settings': return this.closeSettings();
      case 'export': return this.exportData();
      case 'import': {
        const input = this.querySelector('.backup-input');
        if (input) input.click();
        return;
      }
      case 'import-confirm': return this.confirmImport();
      case 'toggle-layout': return this.toggleLayout();
      case 'toggle-module': {
        const input = btn;
        this.toggleModule(input.dataset.id, !!input.checked);
        return;
      }
      case 'import-cancel':
        this.importState = null;
        return this.render();
    }
  }

  renderImportState() {
    const s = this.importState;
    if (!s) return '';
    if (s.error) return `<p class="settings-error" role="alert">${escapeHtml(s.error)}</p>`;
    return `
      <div class="settings-confirm" role="alert">
        <p>${escapeHtml(s.summary)}. Restoring replaces <strong>all</strong> current UIS data in this browser.</p>
        <div class="form-actions">
          <button type="button" class="button-secondary" data-action="import-cancel">Cancel</button>
          <button type="button" class="button-primary" data-action="import-confirm">Replace my data</button>
        </div>
      </div>`;
  }

  renderSettings() {
    return `
      <dialog class="dialog settings-dialog" aria-labelledby="settings-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="settings-title">Settings</h2>
          <button type="button" class="zoom-button" data-action="close-settings" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <div class="dialog__body">
          <section class="settings-section" aria-labelledby="settings-modules">
            <p class="label" id="settings-modules">Modules</p>
            <div class="settings-modules">
              ${this.configManager.getModules().map(m => `
                <label class="settings-module">
                  <input type="checkbox" class="todo-check" data-action="toggle-module" data-id="${escapeHtml(m.id)}" ${m.enabled !== false ? 'checked' : ''}>
                  <span>${escapeHtml(moduleName(m.id))}</span>
                </label>`).join('')}
            </div>
            <p class="settings-hint">Move and resize modules with Edit layout in the bar (wide windows only).</p>
          </section>
          <section class="settings-section" aria-labelledby="settings-data">
            <p class="label" id="settings-data">Data</p>
            <p class="settings-hint">Everything lives in this browser only. A backup file holds all of it, including API keys and tokens, so keep it private.</p>
            <div class="settings-row">
              <button type="button" class="button-secondary" data-action="export">Export backup</button>
              <button type="button" class="button-secondary" data-action="import">Import backup</button>
              <input type="file" class="backup-input" accept=".json,application/json" hidden>
            </div>
            ${this.renderImportState()}
          </section>
        </div>
      </dialog>`;
  }

  render() {
    this.innerHTML = `
      <nav class="shell-bar__pages" aria-label="Pages"></nav>
      <div class="shell-bar__actions">
        <button type="button" class="action-button shell-bar__layout${this.layoutEditing ? ' is-active' : ''}" data-action="toggle-layout" aria-pressed="${this.layoutEditing}">${this.layoutEditing ? 'Done' : 'Edit layout'}</button>
        <button type="button" class="action-button" data-action="open-palette" aria-label="Command palette" title="Command palette (⌘K or /)">⌘K</button>
        <button type="button" class="action-button" data-action="open-settings">Settings</button>
      </div>
      ${this.settingsOpen ? this.renderSettings() : ''}
    `;

    if (typeof this.querySelector !== 'function') return;
    const dialog = this.querySelector('dialog');
    if (dialog) {
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        this.closeSettings();
      });
    }
    const input = this.querySelector('.backup-input');
    if (input) {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (file) this.readImport(await file.text());
      });
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('shell-bar', ShellBar);
  } catch (e) {
    // already defined
  }
}
