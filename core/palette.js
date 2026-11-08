/**
 * <command-palette>: Cmd/Ctrl+K anywhere, or "/" when not typing.
 * Lists commands from core/commands.js providers; ↑/↓ to pick, Enter to run.
 * Also contributes module expand/collapse and a web search fallback.
 */
import { collectCommands, registerCommands } from './commands.js';
import { escapeHtml } from './html.js';
import { setExpanded } from './expand.js';

export const OPEN_PALETTE = 'uis:open-palette';
const WEB_SEARCH = 'https://duckduckgo.com/?q=';

const typingIn = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));

/** Should this keydown open the palette? */
export function isPaletteShortcut(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) return true;
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typingIn(e.target);
}

function moduleCommands() {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll('#shell > .module[data-module]')].map(el => {
    const label = el.querySelector('.block-header__label')?.textContent?.trim() || el.dataset.module;
    const expanded = el.classList.contains('expanded');
    return {
      title: `${expanded ? 'Collapse' : 'Expand'} ${label}`,
      keywords: el.dataset.module,
      run: () => {
        const change = () => setExpanded(expanded ? null : el);
        if (document.startViewTransition) document.startViewTransition(change);
        else change();
      },
    };
  });
}

function webSearch(query) {
  const q = query.trim();
  return [{
    title: `Search the web: ${q}`,
    dynamic: true,
    run: () => window.open(WEB_SEARCH + encodeURIComponent(q), '_blank', 'noopener'),
  }];
}

export class CommandPalette extends HTMLElement {
  constructor() {
    super();
    this.isOpen = false;
    this.query = '';
    this.selected = 0;
    this.results = [];
    this.returnFocus = null;
    this._onKeydown = (e) => {
      if (this.isOpen || !isPaletteShortcut(e)) return;
      if (e.key === '/' && document.querySelector('dialog[open]')) return;
      e.preventDefault();
      this.open();
    };
    this._onOpen = () => this.open();
  }

  connectedCallback() {
    this.offs = [registerCommands('modules', moduleCommands), registerCommands('web', webSearch)];
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._onKeydown);
      document.addEventListener(OPEN_PALETTE, this._onOpen);
    }
  }

  disconnectedCallback() {
    (this.offs || []).forEach(off => off());
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._onKeydown);
      document.removeEventListener(OPEN_PALETTE, this._onOpen);
    }
  }

  open() {
    if (this.isOpen) return;
    this.returnFocus = typeof document !== 'undefined' ? document.activeElement : null;
    this.isOpen = true;
    this.query = '';
    this.refresh();
    this.render();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.render();
    if (restoreFocus && this.returnFocus && this.returnFocus.focus) this.returnFocus.focus();
  }

  setQuery(query) {
    this.query = query;
    this.refresh();
    this.renderResults();
  }

  refresh() {
    this.results = collectCommands(this.query);
    this.selected = 0;
  }

  move(step) {
    if (!this.results.length) return;
    this.selected = (this.selected + step + this.results.length) % this.results.length;
    this.renderResults();
  }

  run(index = this.selected) {
    const cmd = this.results[index];
    if (!cmd) return;
    // Close first so whatever the command opens (a dialog, a tab) gets focus.
    this.close({ restoreFocus: false });
    try {
      cmd.run();
    } catch (err) {
      console.error('[palette] command failed:', err);
    }
  }

  resultsHtml() {
    if (!this.results.length) return '<li class="palette-empty label">No matches</li>';
    return this.results.map((cmd, i) => `
      <li id="palette-opt-${i}" role="option" class="palette-option${i === this.selected ? ' is-selected' : ''}" aria-selected="${i === this.selected}" data-index="${i}">
        <span class="palette-option__title">${escapeHtml(cmd.title)}</span>
        ${cmd.hint ? `<span class="palette-option__hint">${escapeHtml(cmd.hint)}</span>` : ''}
      </li>`).join('');
  }

  renderResults() {
    const list = this.querySelector?.('.palette-list');
    if (!list) return;
    list.innerHTML = this.resultsHtml();
    const input = this.querySelector('.palette-input');
    if (input && input.setAttribute) input.setAttribute('aria-activedescendant', this.results.length ? `palette-opt-${this.selected}` : '');
    const current = this.querySelector(`#palette-opt-${this.selected}`);
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
  }

  render() {
    if (!this.isOpen) {
      this.innerHTML = '';
      return;
    }
    this.innerHTML = `
      <dialog class="dialog palette-dialog" aria-label="Command palette">
        <input type="text" class="palette-input" placeholder="Type a command, a bookmark, or a search" aria-label="Command"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" autocomplete="off" spellcheck="false">
        <ul class="palette-list" id="palette-list" role="listbox">${this.resultsHtml()}</ul>
        <p class="palette-help label">↑↓ choose · Enter run · Esc close</p>
      </dialog>`;
    if (typeof this.querySelector !== 'function') return;
    const dialog = this.querySelector('dialog');
    const input = this.querySelector('.palette-input');
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    if (input) {
      input.focus();
      input.setAttribute('aria-activedescendant', this.results.length ? 'palette-opt-0' : '');
      input.addEventListener('input', () => this.setQuery(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.run(); }
      });
    }
    if (dialog) {
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) return this.close();
        const option = e.target.closest && e.target.closest('[data-index]');
        if (option) this.run(Number(option.dataset.index));
      });
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('command-palette', CommandPalette);
  } catch (e) {
    // already defined
  }
}
