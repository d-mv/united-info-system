import { storage } from '../../core/storage.js';
import { escapeHtml, safeHref, expandButton } from '../../core/html.js';
import { parseBookmarkHtml, mergeImported, groupBookmarks, faviconUrl, shortcutKey } from './bookmarks-logic.js';

const newId = () => 'b_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

// Hosts whose /favicon.ico failed this session; they get the letter tile without asking again.
const missingIcons = new Set();

function readFields(titleOrObj, urlStr, groupStr) {
  const obj = typeof titleOrObj === 'object' && titleOrObj !== null;
  return {
    title: obj ? titleOrObj.title : titleOrObj,
    url: obj ? titleOrObj.url : urlStr,
    group: obj ? titleOrObj.group : groupStr,
  };
}

const withGroup = (item, group) => {
  const name = typeof group === 'string' ? group.trim() : '';
  const { group: _old, ...rest } = item;
  return name ? { ...rest, group: name } : rest;
};

const typingIn = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));

export const DEFAULT_BOOKMARKS = [
  { id: 'b1', title: 'Refactoring UI notes', url: 'https://refactoringui.com' },
  { id: 'b2', title: 'OTP supervision trees', url: 'https://erlang.org' },
  { id: 'b3', title: 'View Transitions API', url: 'https://developer.mozilla.org' },
  { id: 'b4', title: 'Braun D45 archive', url: 'https://braun-design.de' }
];

export class BookmarksApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.unsubscribe = null;
    this.isAdding = false;
    this.editingId = null;
    // Result of the last import, shown until the next render that isn't the import's own.
    this.notice = '';
    this.onShortcut = this.onShortcut.bind(this);
  }

  connectedCallback() {
    this.render();
    if (this.storage && this.storage.subscribe) {
      this.unsubscribe = this.storage.subscribe('app:bookmarks', () => this.onStoredChange());
    }
    if (typeof document !== 'undefined') document.addEventListener('keydown', this.onShortcut);
  }

  // Keys 1-9 open the bookmarks shown with those numbers, unless you're typing,
  // a dialog is open, or another module is expanded over this one.
  onShortcut(e) {
    const index = shortcutKey(e);
    if (index < 0 || e.defaultPrevented || e.repeat || typingIn(e.target) || this.inert) return;
    if (typeof document !== 'undefined' && document.querySelector && document.querySelector('dialog[open]')) return;
    const item = this.orderedBookmarks()[index];
    if (!item || safeHref(item.url) === '#') return;
    e.preventDefault();
    window.open(item.url, '_blank', 'noopener');
  }

  // Bookmarks in the order they are drawn (grouped), which is the order of the 1-9 keys.
  orderedBookmarks() {
    return groupBookmarks(this.getBookmarks()).flatMap(g => g.items);
  }

  importText(text) {
    const parsed = parseBookmarkHtml(text);
    if (!parsed.length) {
      this.notice = 'No bookmarks found in that file';
      this.render();
      return { added: 0, skipped: 0 };
    }
    const { list, added, skipped } = mergeImported(this.getBookmarks(), parsed, newId);
    this.notice = `Imported ${added}${skipped ? ` · ${skipped} already saved` : ''}`;
    if (added) this.storage.set('app:bookmarks', list);
    else this.render();
    return { added, skipped };
  }

  groupNames() {
    return groupBookmarks(this.getBookmarks()).map(g => g.name).filter(Boolean);
  }

  // Bookmarks changed (here or in another tab). Don't rebuild an open form and
  // lose what is typed in it; every way of closing a form re-renders.
  onStoredChange() {
    if (this.editingId && !this.getBookmarks().some(item => item.id === this.editingId)) {
      this.editingId = null;
    }
    if (this.isAdding || this.editingId) return;
    this.render();
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this.onShortcut);
  }

  getBookmarks() {
    const stored = this.storage ? this.storage.get('app:bookmarks', null) : null;
    if (!stored || !Array.isArray(stored)) {
      if (this.storage && this.storage.set) {
        this.storage.set('app:bookmarks', DEFAULT_BOOKMARKS);
      }
      return DEFAULT_BOOKMARKS;
    }
    return stored;
  }

  addBookmark(titleOrObj, urlStr, groupStr) {
    let { title, url, group } = readFields(titleOrObj, urlStr, groupStr);
    if (!title || !title.trim() || !url || !url.trim()) return null;

    title = title.trim();
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const list = this.getBookmarks();
    const newItem = withGroup({ id: newId(), title, url }, group);
    const updated = [newItem, ...list];
    if (this.storage && this.storage.set) {
      this.storage.set('app:bookmarks', updated);
    }
    return newItem;
  }

  // `group` undefined keeps the current group; '' removes it.
  updateBookmark(id, titleOrObj, urlStr, groupStr) {
    if (!id) return;
    const { title, url, group } = readFields(titleOrObj, urlStr, groupStr);

    const list = this.getBookmarks();
    const updated = list.map(item => {
      if (item.id === id) {
        const newTitle = (title && title.trim()) ? title.trim() : item.title;
        let newUrl = (url && url.trim()) ? url.trim() : item.url;
        if (newUrl && !/^https?:\/\//i.test(newUrl)) {
          newUrl = 'https://' + newUrl;
        }
        const updated = { ...item, title: newTitle, url: newUrl };
        return group === undefined ? updated : withGroup(updated, group);
      }
      return item;
    });

    if (this.storage && this.storage.set) {
      this.storage.set('app:bookmarks', updated);
    }
  }

  deleteBookmark(id) {
    if (!id) return;
    const list = this.getBookmarks();
    const updated = list.filter(item => item.id !== id);
    if (this.storage && this.storage.set) {
      this.storage.set('app:bookmarks', updated);
    }
  }

  extractDomain(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  }

  render() {
    const list = this.getBookmarks();
    const notice = this.notice;
    this.notice = '';
    let shortcut = 0;
    const groupOptions = this.groupNames().map(n => `<option value="${escapeHtml(n)}"></option>`).join('');

    const itemHtml = (item) => {
      const key = ++shortcut;
      const id = escapeHtml(item.id);
      const title = escapeHtml(item.title);
      if (this.editingId === item.id) {
        return `
          <li class="bookmark-item editing-item">
            <form class="edit-bookmark-form" data-id="${id}">
              <input type="text" class="input bookmark-title-input" placeholder="Title" value="${title}" aria-label="Bookmark title" required>
              <input type="text" class="input bookmark-url-input" placeholder="https://example.com" value="${escapeHtml(item.url)}" aria-label="Bookmark URL" required>
              <input type="text" class="input bookmark-group-input" placeholder="Group (optional)" value="${escapeHtml(item.group || '')}" aria-label="Bookmark group" list="bookmark-groups">
              <div class="form-actions">
                <button type="button" class="action-button action-button--danger delete-btn">Delete</button>
                <span class="form-actions__spacer"></span>
                <button type="button" class="button-secondary cancel-btn">Cancel</button>
                <button type="submit" class="button-primary save-btn">Save</button>
              </div>
            </form>
          </li>
        `;
      }

      const icon = faviconUrl(item.url);
      let host = '';
      try { host = new URL(item.url).host; } catch { host = ''; }
      const letter = escapeHtml((item.title || host || '?').trim().charAt(0).toUpperCase());
      const img = icon && !missingIcons.has(host)
        ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-host="${escapeHtml(host)}">`
        : '';
      const keyHint = key <= 9 ? `<span class="bookmark-key" aria-hidden="true">${key}</span>` : '';
      return `
        <li class="bookmark-item">
          <span class="bookmark-icon" aria-hidden="true">${letter}${img}</span>
          <div class="bookmark-content">
            <a href="${safeHref(item.url)}" target="_blank" rel="noopener">${title}</a>
            <span class="domain">${escapeHtml(this.extractDomain(item.url))}</span>
          </div>
          ${keyHint}
          <div class="bookmark-actions">
            <button type="button" class="action-button edit-bookmark-btn" data-id="${id}" aria-label="Edit ${title}">Edit</button>
            <button type="button" class="action-button action-button--danger delete-bookmark-btn" data-id="${id}" aria-label="Delete ${title}">Delete</button>
          </div>
        </li>
      `;
    };

    const groupsHtml = groupBookmarks(list).map(({ name, items }) => {
      const rows = items.map(itemHtml).join('');
      if (!name) return `<ul class="bookmark-list">${rows}</ul>`;
      return `
        <section class="bookmark-group" aria-label="${escapeHtml(name)}">
          <p class="bookmark-group__name label">${escapeHtml(name)}</p>
          <ul class="bookmark-list">${rows}</ul>
        </section>`;
    }).join('');

    const listHtml = list.length
      ? `<div class="bookmark-scroll">${groupsHtml}</div>`
      : '<p class="label empty-state">No bookmarks yet</p>';
    const noticeHtml = `<p class="bookmark-notice label" role="status">${escapeHtml(notice)}</p>`;

    const addDialogHtml = this.isAdding ? `
      <dialog class="dialog add-bookmark-dialog" aria-labelledby="add-bookmark-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="add-bookmark-title">Add bookmark</h2>
          <button id="close-button" class="zoom-button" type="button" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form id="bookmark-form" class="dialog__body add-bookmark-form">
          <label class="field">
            <span class="label">Title</span>
            <input type="text" class="input bookmark-title-input" autofocus required>
          </label>
          <label class="field">
            <span class="label">URL</span>
            <input type="text" class="input bookmark-url-input" placeholder="https://example.com" required>
          </label>
          <label class="field">
            <span class="label">Group</span>
            <input type="text" class="input bookmark-group-input" placeholder="Optional" list="bookmark-groups">
          </label>
          <div class="form-actions">
            <button id="cancel-button" type="button" class="button-secondary">Cancel</button>
            <button type="submit" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>
    ` : '';

    this.innerHTML = `
      <style>
        .app-bookmarks .bookmark-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }
        .app-bookmarks .bookmark-list {
          list-style: none;
          margin: 0;
          padding: 0;
          border-top: 1px solid var(--color-line);
        }
        .app-bookmarks .bookmark-group__name {
          margin: 1.6rem 0 0.6rem;
        }
        .app-bookmarks .bookmark-scroll > .bookmark-group:first-child .bookmark-group__name { margin-top: 0; }
        .app-bookmarks .bookmark-icon {
          position: relative;
          flex: none;
          display: grid;
          place-content: center;
          width: 1.6rem;
          height: 1.6rem;
          overflow: hidden;
          border-radius: var(--radius);
          background: var(--color-recessed);
          color: var(--color-ink-muted);
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
        }
        .app-bookmarks .bookmark-icon img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          background: var(--color-raised);
        }
        .app-bookmarks .bookmark-key {
          flex: none;
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          color: var(--color-ink-faint);
          border: 1px solid var(--color-line);
          border-radius: var(--radius);
          padding: 0.1rem 0.5rem;
        }
        .app-bookmarks .bookmark-notice:empty { display: none; }
        .app-bookmarks .bookmark-notice { margin: 0 0 0.8rem; color: var(--color-ink); }
        .app-bookmarks .import-input { display: none; }
        .app-bookmarks .bookmark-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.2rem;
          padding: 1rem 0;
          border-bottom: 1px solid var(--color-line);
        }
        .app-bookmarks .bookmark-content {
          flex: 1;
          min-width: 0;
        }
        .app-bookmarks a {
          display: block;
          color: var(--color-ink);
          text-decoration: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .app-bookmarks a:hover { text-decoration: underline; text-underline-offset: 0.3rem; }
        .app-bookmarks .domain {
          display: block;
          margin-top: 0.2rem;
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          letter-spacing: var(--track-meta);
          color: var(--color-ink-muted);
        }
        .app-bookmarks .bookmark-actions {
          display: flex;
          gap: 1.2rem;
          opacity: 0;
          transition: opacity var(--duration) var(--ease);
        }
        .app-bookmarks .bookmark-item:hover .bookmark-actions,
        .app-bookmarks .bookmark-item:focus-within .bookmark-actions {
          opacity: 1;
        }
        @media (hover: none) {
          .app-bookmarks .bookmark-actions { opacity: 1; }
        }
        .app-bookmarks .edit-bookmark-form {
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
          width: 100%;
        }
        .app-bookmarks .form-actions__spacer { flex: 1; }
      </style>
      <div class="block-header">
        <p class="block-header__label">Bookmarks</p>
        <div class="block-header__actions">
          <button id="add" class="action-button" type="button" aria-label="Add bookmark">+ Add</button>
          <button id="import" class="action-button" type="button" aria-label="Import bookmarks from a browser export file">Import</button>
          <input type="file" class="import-input" accept=".html,.htm,text/html" tabindex="-1" aria-hidden="true">
          ${expandButton('Bookmarks', !!this.classList?.contains('expanded'))}
        </div>
      </div>
      ${noticeHtml}
      ${listHtml}
      <datalist id="bookmark-groups">${groupOptions}</datalist>
      ${addDialogHtml}
    `;

    this.bindEvents();
  }

  closeAddDialog() {
    this.isAdding = false;
    this.render();
    const addBtn = typeof this.querySelector === 'function' ? this.querySelector('#add') : null;
    if (addBtn && addBtn.focus) addBtn.focus();
  }

  bindEvents() {
    if (typeof this.querySelector !== 'function') return;

    this.querySelectorAll('.bookmark-icon img').forEach(img => {
      img.addEventListener('error', () => {
        missingIcons.add(img.getAttribute('data-host'));
        img.remove();
      });
    });

    const importBtn = this.querySelector('#import');
    const fileInput = this.querySelector('.import-input');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        this.importText(await file.text());
        const again = this.querySelector('#import');
        if (again) again.focus();
      });
    }

    const addBtn = this.querySelector('#add');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isAdding = true;
        this.editingId = null;
        this.render();
      });
    }

    const dialog = this.querySelector('.add-bookmark-dialog');
    if (dialog) {
      // showModal moves focus to the first field, traps focus and handles Escape.
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        this.closeAddDialog();
      });
      // Click on the backdrop (outside the dialog box) closes it.
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) this.closeAddDialog();
      });
    }

    const addForm = this.querySelector('#bookmark-form');
    if (addForm) {
      const titleInput = addForm.querySelector('.bookmark-title-input');
      const urlInput = addForm.querySelector('.bookmark-url-input');
      const groupInput = addForm.querySelector('.bookmark-group-input');

      addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = titleInput ? titleInput.value : '';
        const url = urlInput ? urlInput.value : '';
        if (title.trim() && url.trim()) {
          this.isAdding = false;
          this.addBookmark(title, url, groupInput ? groupInput.value : '');
          this.closeAddDialog();
        }
      });

      for (const sel of ['#cancel-button', '#close-button']) {
        const btn = this.querySelector(sel);
        if (btn) btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.closeAddDialog();
        });
      }
    }

    this.querySelectorAll('.edit-bookmark-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingId = btn.getAttribute('data-id');
        this.isAdding = false;
        this.render();
        const titleInput = this.querySelector('.edit-bookmark-form .bookmark-title-input');
        if (titleInput) titleInput.focus();
      });
    });

    this.querySelectorAll('.delete-bookmark-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (id) {
          if (this.editingId === id) this.editingId = null;
          this.deleteBookmark(id);
          this.render();
        }
      });
    });

    const editForm = this.querySelector('.edit-bookmark-form');
    if (editForm) {
      const id = editForm.getAttribute('data-id');
      const titleInput = editForm.querySelector('.bookmark-title-input');
      const urlInput = editForm.querySelector('.bookmark-url-input');
      const groupInput = editForm.querySelector('.bookmark-group-input');

      const stopEditing = () => {
        this.editingId = null;
        this.render();
      };

      editForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = titleInput ? titleInput.value : '';
        const url = urlInput ? urlInput.value : '';
        if (title.trim() && url.trim()) {
          this.editingId = null;
          this.updateBookmark(id, title, url, groupInput ? groupInput.value : undefined);
          this.render();
        }
      });

      const cancelBtn = editForm.querySelector('.cancel-btn');
      if (cancelBtn) cancelBtn.addEventListener('click', (e) => { e.preventDefault(); stopEditing(); });

      const deleteBtn = editForm.querySelector('.delete-btn');
      if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.editingId = null;
        this.deleteBookmark(id);
        this.render();
      });

      editForm.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          // Don't also collapse an expanded module.
          e.stopPropagation();
          stopEditing();
        }
      });
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-bookmarks', BookmarksApp);
  } catch (e) { }
}
