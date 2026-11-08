/**
 * Layout editing: an overlay on every shown module. Drag to move, drag the
 * corner to resize; or focus an overlay and use arrow keys (Shift = resize).
 * Changes that leave the grid or overlap another module are refused.
 *
 * Overlays are extra grid items in #shell placed over their module, so module
 * re-renders can't wipe them. Modules are inert while editing.
 */
import { configManager as defaultConfigManager } from './config.js';
import { place, setEnabled, moveWithPush } from './layout.js';
import { moduleName } from './registry.js';
import { setExpanded } from './expand.js';
import { escapeHtml } from './html.js';

export const TOGGLE_LAYOUT = 'uis:toggle-layout';
export const LAYOUT_MODE = 'uis:layout-mode';

const KEY_STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Placement change for a key press, or null. Shift resizes instead of moving. */
export function keyChange(mod, key, shift) {
  const step = KEY_STEP[key];
  if (!step) return null;
  const [dx, dy] = step;
  return shift
    ? { cols: (mod.cols || 1) + dx, rows: (mod.rows || 1) + dy }
    : { col: (mod.col || 1) + dx, row: (mod.row || 1) + dy };
}

export class LayoutEditor {
  constructor({ shell, configManager = defaultConfigManager } = {}) {
    this.shell = shell;
    this.configManager = configManager;
    this.editing = false;
    this.unsubscribe = null;
    this.drag = null;
  }

  toggle() {
    if (this.editing) this.stop();
    else this.start();
  }

  start() {
    if (this.editing || !this.shell) return;
    setExpanded(null);
    this.editing = true;
    document.body.classList.add('layout-editing');
    this.unsubscribe = this.configManager.subscribe(() => queueMicrotask(() => this.sync()));
    this.sync();
    const first = this.shell.querySelector('.layout-overlay');
    if (first) first.focus();
    this.announce();
  }

  stop() {
    if (!this.editing) return;
    this.editing = false;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    document.body.classList.remove('layout-editing');
    this.shell.querySelectorAll('.layout-overlay').forEach(el => el.remove());
    this.shell.querySelectorAll('.module').forEach(el => { el.inert = false; });
    this.announce();
  }

  announce() {
    document.dispatchEvent(new CustomEvent(LAYOUT_MODE, { detail: { editing: this.editing } }));
  }

  config() {
    const config = this.configManager.get();
    return { modules: config.modules || [], cols: (config.grid && config.grid.columns) || 12 };
  }

  /** Rebuild the overlays from the config (after any change, including other tabs). */
  sync() {
    if (!this.editing) return;
    const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.overlayFor : null;
    this.shell.querySelectorAll('.layout-overlay').forEach(el => el.remove());
    this.shell.querySelectorAll('.module').forEach(el => { el.inert = true; });
    const { modules } = this.config();
    for (const mod of modules.filter(m => m.enabled !== false)) {
      const el = document.createElement('div');
      el.className = 'layout-overlay';
      el.tabIndex = 0;
      el.dataset.overlayFor = mod.id;
      el.setAttribute('role', 'group');
      const name = moduleName(mod.id);
      el.setAttribute('aria-label', `${name}, ${mod.cols} by ${mod.rows}, column ${mod.col}, row ${mod.row}. Arrow keys move, Shift and arrow keys resize.`);
      el.innerHTML = `
        <span class="layout-overlay__name">${escapeHtml(name)}</span>
        <span class="layout-overlay__size num">${mod.cols}×${mod.rows}</span>
        <button type="button" class="action-button layout-overlay__hide" data-layout="hide">Hide</button>
        <span class="layout-overlay__resize" data-layout="resize" aria-hidden="true"></span>`;
      this.placeEl(el, mod);
      this.bind(el, mod.id);
      this.shell.appendChild(el);
    }
    if (focusedId) {
      const again = this.shell.querySelector(`.layout-overlay[data-overlay-for="${CSS.escape(focusedId)}"]`);
      if (again) again.focus();
    }
  }

  placeEl(el, mod) {
    el.style.gridColumn = `${mod.col} / span ${mod.cols}`;
    el.style.gridRow = `${mod.row} / span ${mod.rows}`;
  }

  /** Try a placement change; write it if allowed. Returns whether it was applied. */
  apply(id, change) {
    const { modules, cols } = this.config();
    const next = place(modules, id, change, cols);
    if (!next) return false;
    this.configManager.setModules(next);
    return true;
  }

  hide(id) {
    this.configManager.setModules(setEnabled(this.config().modules, id, false));
  }

  pitch() {
    const cs = getComputedStyle(this.shell);
    const cols = this.config().cols;
    const gap = parseFloat(cs.columnGap) || 0;
    const colPitch = (this.shell.getBoundingClientRect().width + gap) / cols;
    // Rows stretch with the window: use the drawn height of the first row.
    const firstRow = parseFloat(String(cs.gridTemplateRows).split(' ')[0]) || parseFloat(cs.gridAutoRows) || 100;
    const rowPitch = firstRow + (parseFloat(cs.rowGap) || 0);
    return { colPitch, rowPitch };
  }

  /**
   * Outside edit mode, dragging a module by its header label moves it: a
   * dashed outline shows where it will land (its saved size), and dropping it
   * pushes modules in the way down (moveWithPush).
   */
  startMove(e) {
    if (this.editing || e.button !== 0) return;
    const label = e.target.closest && e.target.closest('.block-header__label');
    const moduleEl = label && label.closest('#shell > .module');
    if (!moduleEl || moduleEl.classList.contains('expanded') || moduleEl.inert) return;
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches) return;
    const id = moduleEl.dataset.module;
    const mod = this.config().modules.find(m => m.id === id);
    if (!mod) return;
    e.preventDefault();

    const pitch = this.pitch();
    const rect = moduleEl.getBoundingClientRect();
    // Where in the module the pointer grabbed it, in cells, so the outline follows
    // the hand (clamped: the module may be drawn bigger than its saved size).
    const grabCol = Math.min(mod.cols - 1, Math.floor((e.clientX - rect.left) / pitch.colPitch));
    const grabRow = Math.min(mod.rows - 1, Math.floor((e.clientY - rect.top) / pitch.rowPitch));
    const ghost = document.createElement('div');
    ghost.className = 'layout-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    let target = null;

    const onMove = (ev) => {
      const shellRect = this.shell.getBoundingClientRect();
      const col = Math.floor((ev.clientX - shellRect.left) / pitch.colPitch) + 1 - grabCol;
      const row = Math.floor((ev.clientY - shellRect.top) / pitch.rowPitch) + 1 - grabRow;
      const next = { col: Math.max(1, col), row: Math.max(1, row) };
      if (!target && next.col === mod.col && next.row === mod.row) return;
      if (!ghost.isConnected) {
        this.shell.appendChild(ghost);
        moduleEl.classList.add('is-moving');
        document.body.classList.add('layout-moving');
      }
      target = next;
      const ok = !!moveWithPush(this.config().modules, id, target, this.config().cols);
      ghost.classList.toggle('is-invalid', !ok);
      this.placeEl(ghost, { ...mod, ...target });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      ghost.remove();
      moduleEl.classList.remove('is-moving');
      document.body.classList.remove('layout-moving');
      if (!target || (target.col === mod.col && target.row === mod.row)) return;
      const next = moveWithPush(this.config().modules, id, target, this.config().cols);
      if (next) this.configManager.setModules(next);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  bind(el, id) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.stop(); return; }
      const mod = this.config().modules.find(m => m.id === id);
      const change = mod && keyChange(mod, e.key, e.shiftKey);
      if (!change) return;
      e.preventDefault();
      if (!this.apply(id, change)) this.flashInvalid(el);
    });

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-layout="hide"]')) this.hide(id);
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const mod = this.config().modules.find(m => m.id === id);
      if (!mod) return;
      e.preventDefault();
      el.focus();
      el.setPointerCapture(e.pointerId);
      this.drag = {
        id, el, mod,
        mode: e.target.closest('[data-layout="resize"]') ? 'resize' : 'move',
        x: e.clientX, y: e.clientY, pitch: this.pitch(), change: null,
      };
      el.classList.add('is-dragging');
    });

    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.el !== el) return;
      const dc = Math.round((e.clientX - d.x) / d.pitch.colPitch);
      const dr = Math.round((e.clientY - d.y) / d.pitch.rowPitch);
      d.change = d.mode === 'move'
        ? { col: d.mod.col + dc, row: d.mod.row + dr }
        : { cols: Math.max(1, d.mod.cols + dc), rows: Math.max(1, d.mod.rows + dr) };
      const { modules, cols } = this.config();
      const ok = !!place(modules, id, d.change, cols);
      this.placeEl(el, { ...d.mod, ...d.change });
      el.classList.toggle('is-invalid', !ok);
    });

    const end = () => {
      const d = this.drag;
      if (!d || d.el !== el) return;
      this.drag = null;
      el.classList.remove('is-dragging', 'is-invalid');
      const moved = d.change && Object.keys(d.change).some(k => d.change[k] !== d.mod[k]);
      if (!moved || !this.apply(id, d.change)) this.placeEl(el, d.mod);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  flashInvalid(el) {
    el.classList.add('is-invalid');
    setTimeout(() => el.classList.remove('is-invalid'), 300);
  }
}

/** Create the editor for #shell and listen for toggle requests (shell bar, palette). */
export function setupLayoutEditor(options = {}) {
  const editor = new LayoutEditor({ shell: document.getElementById('shell'), ...options });
  document.addEventListener(TOGGLE_LAYOUT, () => editor.toggle());
  document.addEventListener('pointerdown', (e) => editor.startMove(e));
  return editor;
}
