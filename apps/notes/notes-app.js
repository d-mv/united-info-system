import { storage } from '../../core/storage.js';
import { escapeHtml, expandButton } from '../../core/html.js';
import { registerCommands } from '../../core/commands.js';
import {
  sanitizeHtml, cleanLinkUrl, linkFromInput, noteText, noteTitle, sortNotes,
  relativeTime, clockTime, plainTextToHtml, newNoteId,
} from './notes-logic.js';

const KEY = 'app:notes';
const SAVE_DELAY = 400;

// Toolbar: [command id, label, glyph, toggle?]
const TOOLS = [
  ['bold', 'Bold', 'B', true],
  ['italic', 'Italic', 'I', true],
  ['heading', 'Heading', 'H', true],
  ['ul', 'Bulleted list', '•', true],
  ['ol', 'Numbered list', '1.', true],
  ['link', 'Link', 'Link', false],
  ['clear', 'Clear formatting', 'Clear', false],
];

const STATE_QUERY = { bold: 'bold', italic: 'italic', ul: 'insertUnorderedList', ol: 'insertOrderedList' };

const hasDom = (el) => typeof el.querySelector === 'function';

export class NotesApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.unsubscribe = null;
    // Note open in the editor. While set, outside changes refresh only the list.
    this.openId = null;
    this.confirmingDelete = false;
    this.linkOpen = false;
    this.linkError = '';
    this.savedRange = null;
    this.saveTimer = null;
    this.dirty = false;
    this.onSelectionChange = this.onSelectionChange.bind(this);
    this.flush = this.flush.bind(this);
  }

  connectedCallback() {
    this.render();
    if (this.storage && this.storage.subscribe) {
      this.unsubscribe = this.storage.subscribe(KEY, () => this.onStoredChange());
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('selectionchange', this.onSelectionChange);
    }
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', this.flush);
    // Keep "5m ago" honest on a page that stays open.
    if (typeof setInterval === 'function') {
      this.tick = setInterval(() => this.renderList(), 60e3);
      if (this.tick && this.tick.unref) this.tick.unref();
    }
    this.offCommands = registerCommands('notes', () => [
      { title: 'New note', hint: 'Notes', keywords: 'create add write', run: () => this.createNote() },
      ...sortNotes(this.getNotes()).map(n => ({
        title: `Open note: ${noteTitle(n.html)}`,
        hint: 'Note',
        keywords: noteText(n.html).slice(0, 200),
        run: () => this.openNote(n.id),
      })),
    ]);
  }

  disconnectedCallback() {
    this.flush();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('selectionchange', this.onSelectionChange);
    }
    if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('pagehide', this.flush);
    if (this.tick) clearInterval(this.tick);
    if (this.offCommands) this.offCommands();
  }

  // ---------- data ----------

  getNotes() {
    const stored = this.storage.get(KEY, null);
    return Array.isArray(stored) ? stored.filter(n => n && typeof n.id === 'string') : [];
  }

  getNote(id) {
    return this.getNotes().find(n => n.id === id) || null;
  }

  createNote() {
    this.flush();
    this.discardIfEmpty(this.openId);
    const note = { id: newNoteId(), html: '', updatedAt: Date.now() };
    this.openId = note.id;
    this.resetEditorState();
    this.storage.set(KEY, [note, ...this.getNotes()]);
    this.render();
    this.focusEditor();
    return note.id;
  }

  /** Store `html` (sanitized) for note `id`. Returns whether anything was written. */
  saveNote(id, html) {
    const notes = this.getNotes();
    const note = notes.find(n => n.id === id);
    if (!note) return false;
    const clean = sanitizeHtml(html);
    if (clean === note.html) return false;
    this.storage.set(KEY, notes.map(n => (n.id === id ? { ...n, html: clean, updatedAt: Date.now() } : n)));
    return true;
  }

  deleteNote(id) {
    this.storage.set(KEY, this.getNotes().filter(n => n.id !== id));
  }

  // A note with no text is dropped when you leave it, so "+ New" can't pile up blanks.
  discardIfEmpty(id) {
    const note = id && this.getNote(id);
    if (note && !noteText(note.html)) this.deleteNote(id);
  }

  // ---------- editor lifecycle ----------

  resetEditorState() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.confirmingDelete = false;
    this.linkOpen = false;
    this.linkError = '';
    this.savedRange = null;
  }

  openNote(id) {
    if (!this.getNote(id)) return;
    if (id !== this.openId) {
      this.flush();
      this.discardIfEmpty(this.openId);
      this.openId = id;
      this.resetEditorState();
    }
    this.render();
    this.focusEditor();
  }

  /** Back to the list (compact view). Focus goes to the note's row. */
  closeNote() {
    const id = this.openId;
    this.flush();
    this.openId = null;
    this.resetEditorState();
    this.discardIfEmpty(id);
    this.render();
    this.focusSelector(id && this.getNote(id) ? `.note-item[data-id="${cssEscape(id)}"]` : '[data-action="new"]');
  }

  editor() {
    return hasDom(this) ? this.querySelector('.notes-editor') : null;
  }

  // Save what's in the editor now, if it changed since the last save.
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const editor = this.editor();
    if (!this.openId || !editor || !this.dirty) return;
    this.dirty = false;
    this.saveNote(this.openId, editor.innerHTML);
    this.showStatus();
  }

  scheduleSave() {
    this.dirty = true;
    this.showStatus('Editing');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  statusText() {
    const note = this.openId && this.getNote(this.openId);
    return note && noteText(note.html) ? `Saved ${clockTime(note.updatedAt)}` : '';
  }

  showStatus(text) {
    const el = hasDom(this) && this.querySelector('.notes-status');
    if (el) el.textContent = text === undefined ? this.statusText() : text;
  }

  // ---------- delete (inline confirm) ----------

  requestDelete() {
    this.flush();
    this.confirmingDelete = true;
    this.render();
    this.focusSelector('[data-action="confirm-delete"]');
  }

  cancelDelete() {
    this.confirmingDelete = false;
    this.render();
    this.focusSelector('[data-action="delete"]');
  }

  confirmDelete() {
    const id = this.openId;
    this.openId = null;
    this.resetEditorState();
    if (id) this.deleteNote(id);
    this.render();
    this.focusSelector('.note-item, [data-action="new"]');
  }

  // ---------- storage ----------

  onStoredChange() {
    if (this.openId && !this.getNote(this.openId)) {
      // Deleted here (already handled) or in another tab: close the editor.
      this.openId = null;
      this.resetEditorState();
      this.render();
      return;
    }
    if (this.openId) {
      this.renderList();
      return;
    }
    this.render();
  }

  // ---------- formatting ----------

  // Keep the editor's selection while focus is on the toolbar or the link field.
  onSelectionChange() {
    const editor = this.editor();
    if (!editor || typeof document.getSelection !== 'function') return;
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return;
    this.savedRange = sel.getRangeAt(0).cloneRange();
    this.updateToolbar();
  }

  restoreSelection() {
    const editor = this.editor();
    if (!editor) return;
    editor.focus();
    if (this.savedRange) {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
  }

  blockFormat() {
    try {
      return String(document.queryCommandValue('formatBlock') || '').toLowerCase();
    } catch {
      return '';
    }
  }

  runTool(tool) {
    if (tool === 'link') return this.openLinkForm();
    this.restoreSelection();
    // Real tags (<b>, <i>) rather than style spans; Enter makes <p>.
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (tool === 'bold' || tool === 'italic') document.execCommand(tool);
    else if (tool === 'heading') document.execCommand('formatBlock', false, this.blockFormat() === 'h2' ? '<p>' : '<h2>');
    else if (tool === 'ul') document.execCommand('insertUnorderedList');
    else if (tool === 'ol') document.execCommand('insertOrderedList');
    else if (tool === 'clear') {
      document.execCommand('removeFormat');
      document.execCommand('unlink');
      if (/^(h\d|pre|blockquote)$/.test(this.blockFormat())) document.execCommand('formatBlock', false, '<p>');
    }
    this.updateToolbar();
    this.scheduleSave();
  }

  updateToolbar() {
    if (!hasDom(this) || typeof document.queryCommandState !== 'function') return;
    for (const btn of this.querySelectorAll('.notes-tool[aria-pressed]')) {
      const tool = btn.getAttribute('data-tool');
      let on = false;
      try {
        on = tool === 'heading' ? this.blockFormat() === 'h2' : document.queryCommandState(STATE_QUERY[tool]);
      } catch {}
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  openLinkForm() {
    this.linkOpen = true;
    this.linkError = '';
    this.renderLinkSlot();
    this.focusSelector('.notes-link-input');
  }

  closeLinkForm() {
    this.linkOpen = false;
    this.linkError = '';
    this.renderLinkSlot();
    this.restoreSelection();
  }

  /** Turn the saved selection into a link to `input`. Returns false (with linkError) if refused. */
  applyLink(input) {
    const result = linkFromInput(input);
    if (!result.ok) {
      this.linkError = result.error;
      const err = hasDom(this) && this.querySelector('.notes-link-error');
      if (err) err.textContent = result.error;
      return false;
    }
    this.closeLinkForm();
    const collapsed = !this.savedRange || this.savedRange.collapsed;
    if (collapsed) document.execCommand('insertHTML', false, sanitizeHtml(`<a href="${escapeHtml(result.url)}">${escapeHtml(result.url)}</a>`));
    else document.execCommand('createLink', false, result.url);
    this.scheduleSave();
    return true;
  }

  insertSanitized(html) {
    if (html) document.execCommand('insertHTML', false, html);
    this.scheduleSave();
  }

  // ---------- rendering ----------

  listHtml(notes) {
    if (!notes.length) {
      return `
        <div class="notes-empty">
          <p class="label empty-state">No notes</p>
          <button type="button" class="action-button notes-empty__new" data-action="new">+ New note</button>
        </div>`;
    }
    const now = Date.now();
    const items = sortNotes(notes).map(n => {
      const id = escapeHtml(n.id);
      const current = n.id === this.openId;
      return `
        <li>
          <button type="button" class="note-item" data-id="${id}"${current ? ' aria-current="true"' : ''}>
            <span class="note-item__title">${escapeHtml(noteTitle(n.html))}</span>
            <span class="note-item__time num">${escapeHtml(relativeTime(n.updatedAt, now))}</span>
          </button>
        </li>`;
    }).join('');
    return `<ul class="notes-list" aria-label="Notes">${items}</ul>`;
  }

  linkSlotHtml() {
    if (!this.linkOpen) return '';
    return `
      <form class="notes-link-form" novalidate>
        <input type="text" class="input notes-link-input" inputmode="url" placeholder="https://" aria-label="Link URL" autocomplete="off">
        <button type="button" class="button-secondary" data-action="cancel-link">Cancel</button>
        <button type="submit" class="button-primary">Add link</button>
        <p class="notes-link-error" role="alert">${escapeHtml(this.linkError)}</p>
      </form>`;
  }

  editorHtml(note) {
    if (!note) {
      return '<p class="label empty-state notes-placeholder">Select a note or create one</p>';
    }
    const tools = TOOLS.map(([tool, label, glyph, toggle]) => `
      <button type="button" class="notes-tool notes-tool--${tool}" data-tool="${tool}" aria-label="${label}" title="${label}${tool === 'link' ? ' (⌘/Ctrl-click a link to open it)' : ''}"${toggle ? ' aria-pressed="false"' : ''}>${glyph}</button>`).join('');
    const head = this.confirmingDelete
      ? `
        <div class="notes-confirm" role="group" aria-label="Confirm delete">
          <span class="notes-confirm__text">Delete this note?</span>
          <button type="button" class="button-secondary" data-action="cancel-delete">Cancel</button>
          <button type="button" class="button-primary" data-action="confirm-delete">Delete</button>
        </div>`
      : `
        <div class="notes-editor-head">
          <button type="button" class="action-button notes-back" data-action="back" aria-label="Back to notes">← Notes</button>
          <span class="label notes-status num" aria-live="polite">${escapeHtml(this.statusText())}</span>
          <button type="button" class="action-button action-button--danger" data-action="delete">Delete</button>
        </div>`;
    return `
      ${head}
      <div class="notes-toolbar" role="toolbar" aria-label="Formatting">${tools}</div>
      <div class="notes-link-slot">${this.linkSlotHtml()}</div>
      <div class="notes-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note text"
        spellcheck="true" data-placeholder="Write something…" data-id="${escapeHtml(note.id)}">${sanitizeHtml(note.html)}</div>`;
  }

  render() {
    // Never throw away unsaved typing.
    if (this.dirty) this.flush();
    const notes = this.getNotes();
    if (this.openId && !notes.some(n => n.id === this.openId)) this.openId = null;
    const note = this.openId ? notes.find(n => n.id === this.openId) : null;
    const expanded = !!(this.classList && this.classList.contains('expanded'));

    this.innerHTML = `
      <style>
        .app-notes .notes-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .app-notes .notes-list-pane,
        .app-notes .notes-editor-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .app-notes .notes-body.is-open .notes-list-pane,
        .app-notes .notes-body:not(.is-open) .notes-editor-pane { display: none; }
        .app-notes.expanded .notes-body {
          display: grid;
          grid-template-columns: minmax(20rem, 30rem) 1fr;
          gap: 3.2rem;
        }
        .app-notes.expanded .notes-body .notes-list-pane,
        .app-notes.expanded .notes-body .notes-editor-pane { display: flex; }
        .app-notes.expanded .notes-list-pane { border-right: 1px solid var(--color-line); padding-right: 2.4rem; }
        .app-notes.expanded .notes-back { display: none; }
        .app-notes .notes-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; }
        .app-notes .notes-empty .empty-state { margin: 0; padding: 0; }
        .app-notes .notes-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
        .app-notes .note-item {
          display: flex;
          align-items: baseline;
          gap: 1.2rem;
          width: 100%;
          min-height: 4rem;
          padding: 0.8rem 0;
          border-bottom: 1px solid var(--color-line);
          text-align: left;
          color: var(--color-ink);
        }
        .app-notes .note-item:hover .note-item__title { text-decoration: underline; text-underline-offset: 0.3em; text-decoration-color: var(--color-line-strong); }
        .app-notes .note-item[aria-current="true"] { box-shadow: inset 2px 0 0 var(--color-accent); padding-left: 1rem; }
        .app-notes .note-item__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .app-notes .note-item__time {
          flex: none;
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-meta);
          text-transform: uppercase;
          color: var(--color-ink-muted);
        }
        .app-notes .notes-editor-head,
        .app-notes .notes-confirm {
          flex: none;
          display: flex;
          align-items: center;
          gap: 1.2rem;
          min-height: 3.4rem;
        }
        .app-notes .notes-status { margin-right: auto; }
        .app-notes .notes-back + .notes-status { margin-left: 0.4rem; }
        .app-notes .notes-confirm__text { margin-right: auto; font-size: var(--text-sm); }
        .app-notes .notes-toolbar {
          flex: none;
          display: flex;
          flex-wrap: wrap;
          gap: 0.2rem;
          padding: 0.4rem 0;
          border-top: 1px solid var(--color-line);
          border-bottom: 1px solid var(--color-line);
        }
        .app-notes .notes-tool {
          min-width: 2.8rem;
          height: 2.8rem;
          padding: 0 0.6rem;
          border-radius: var(--radius);
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          letter-spacing: var(--track-meta);
          color: var(--color-ink-muted);
          transition: color var(--duration) var(--ease), background var(--duration) var(--ease);
        }
        .app-notes .notes-tool:hover { color: var(--color-ink); }
        .app-notes .notes-tool[aria-pressed="true"] { background: var(--color-recessed); color: var(--color-ink); }
        .app-notes .notes-tool--bold { font-weight: 700; }
        .app-notes .notes-tool--italic { font-style: italic; font-family: var(--font-sans); }
        .app-notes .notes-tool--heading { font-weight: 600; }
        .app-notes .notes-tool--link,
        .app-notes .notes-tool--clear { text-transform: uppercase; font-size: var(--text-2xs); letter-spacing: var(--track-label); }
        .app-notes .notes-link-form {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.8rem;
          padding: 0.8rem 0;
        }
        .app-notes .notes-link-input { flex: 1; min-width: 12rem; }
        .app-notes .notes-link-error { flex-basis: 100%; margin: 0; font-size: var(--text-xs); color: var(--color-accent); }
        .app-notes .notes-link-error:empty { display: none; }
        .app-notes .notes-editor {
          flex: 1;
          min-height: 6rem;
          overflow-y: auto;
          padding: 1rem 0.2rem;
          outline: none;
          font-size: var(--text-base);
          line-height: 1.55;
          color: var(--color-ink);
          overflow-wrap: anywhere;
        }
        .app-notes .notes-editor:empty::before { content: attr(data-placeholder); color: var(--color-ink-faint); }
        .app-notes .notes-editor > :first-child { margin-top: 0; }
        .app-notes .notes-editor p { margin: 0 0 0.6em; }
        .app-notes .notes-editor h2 { margin: 0.8em 0 0.4em; font-size: 1.25em; font-weight: 600; letter-spacing: var(--track-tight); }
        .app-notes .notes-editor h3 { margin: 0.8em 0 0.4em; font-size: 1em; font-weight: 600; }
        .app-notes .notes-editor ul,
        .app-notes .notes-editor ol { margin: 0 0 0.6em; padding-left: 2.2rem; }
        .app-notes .notes-editor blockquote { margin: 0 0 0.6em; padding-left: 1.2rem; border-left: 2px solid var(--color-line-strong); color: var(--color-ink-muted); }
        .app-notes .notes-editor code,
        .app-notes .notes-editor pre { font-family: var(--font-mono); font-size: 0.92em; background: var(--color-recessed); border-radius: var(--radius); }
        .app-notes .notes-editor code { padding: 0.1em 0.3em; }
        .app-notes .notes-editor pre { padding: 0.8rem 1rem; white-space: pre-wrap; }
        .app-notes .notes-editor a { color: var(--color-accent); text-decoration: underline; text-underline-offset: 0.2em; }
        .app-notes.expanded .notes-editor { font-size: var(--text-md); max-width: 72rem; }
        .app-notes .notes-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; }
      </style>
      <div class="block-header">
        <p class="block-header__label">Notes</p>
        <div class="block-header__actions">
          <button type="button" class="action-button" data-action="new" aria-label="New note">+ New</button>
          ${expandButton('Notes', expanded)}
        </div>
      </div>
      <div class="notes-body${note ? ' is-open' : ''}">
        <nav class="notes-list-pane" aria-label="Notes list">${this.listHtml(notes)}</nav>
        <section class="notes-editor-pane" aria-label="Note">${this.editorHtml(note)}</section>
      </div>
    `;
    this.bind();
  }

  // Refresh only the list (keeps the editor, its caret and anything unsaved).
  renderList() {
    const pane = hasDom(this) && this.querySelector('.notes-list-pane');
    if (!pane) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const focusId = active && pane.contains(active) && active.getAttribute('data-id');
    pane.innerHTML = this.listHtml(this.getNotes());
    this.bindList();
    if (focusId) this.focusSelector(`.note-item[data-id="${cssEscape(focusId)}"]`);
    const status = this.querySelector('.notes-status');
    if (status && !this.dirty) status.textContent = this.statusText();
  }

  renderLinkSlot() {
    const slot = hasDom(this) && this.querySelector('.notes-link-slot');
    if (!slot) return;
    slot.innerHTML = this.linkSlotHtml();
    this.bindLinkForm();
  }

  focusSelector(selector) {
    const el = hasDom(this) && this.querySelector(selector);
    if (el && el.focus) el.focus();
  }

  focusEditor() {
    const editor = this.editor();
    if (!editor || !editor.focus) return;
    editor.focus();
    // Caret at the end.
    if (typeof document.createRange === 'function') {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // ---------- events ----------

  bind() {
    if (!hasDom(this)) return;
    const on = (selector, type, fn) => {
      const el = this.querySelector(selector);
      if (el) el.addEventListener(type, fn);
    };
    for (const btn of this.querySelectorAll('[data-action="new"]')) btn.addEventListener('click', () => this.createNote());
    on('[data-action="back"]', 'click', () => this.closeNote());
    on('[data-action="delete"]', 'click', () => this.requestDelete());
    on('[data-action="cancel-delete"]', 'click', () => this.cancelDelete());
    on('[data-action="confirm-delete"]', 'click', () => this.confirmDelete());
    on('.notes-confirm', 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.cancelDelete();
    });
    this.bindList();
    this.bindLinkForm();

    for (const btn of this.querySelectorAll('.notes-tool')) {
      // Keep the editor's selection when the toolbar is clicked.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.runTool(btn.getAttribute('data-tool')));
    }

    const editor = this.editor();
    if (!editor) return;
    editor.addEventListener('input', () => this.scheduleSave());
    editor.addEventListener('blur', () => this.flush());
    editor.addEventListener('keyup', () => this.updateToolbar());
    editor.addEventListener('focus', () => {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    });
    editor.addEventListener('paste', (e) => {
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      const html = data.getData('text/html');
      this.insertSanitized(html ? sanitizeHtml(html) : plainTextToHtml(data.getData('text/plain')));
    });
    editor.addEventListener('drop', (e) => {
      const data = e.dataTransfer;
      if (!data) return;
      e.preventDefault();
      const html = data.getData('text/html');
      const text = data.getData('text/plain');
      if (!html && !text) return; // files etc.: refused
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range) {
          const sel = document.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      this.insertSanitized(html ? sanitizeHtml(html) : plainTextToHtml(text));
    });
    editor.addEventListener('click', (e) => {
      // Plain click edits; Cmd/Ctrl+click follows the link.
      const link = e.target && e.target.closest && e.target.closest('a[href]');
      if (!link || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const url = cleanLinkUrl(link.getAttribute('href'));
      if (url) window.open(url, '_blank', 'noopener');
    });
    editor.addEventListener('keydown', (e) => {
      // In the small cell Escape goes back to the list; expanded, it collapses the module.
      if (e.key === 'Escape' && !this.classList.contains('expanded')) {
        e.preventDefault();
        this.closeNote();
      }
    });
  }

  bindList() {
    if (!hasDom(this)) return;
    for (const btn of this.querySelectorAll('.note-item')) {
      btn.addEventListener('click', () => this.openNote(btn.getAttribute('data-id')));
    }
  }

  bindLinkForm() {
    const form = hasDom(this) && this.querySelector('.notes-link-form');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.applyLink(form.querySelector('.notes-link-input').value);
    });
    form.querySelector('[data-action="cancel-link"]').addEventListener('click', () => this.closeLinkForm());
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // don't also collapse an expanded module
      this.closeLinkForm();
    });
  }
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-notes', NotesApp);
  } catch (e) {}
}
