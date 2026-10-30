import { storage } from '../../core/storage.js';
import { escapeHtml, safeHref } from '../../core/html.js';

export const DEFAULT_BOOKMARKS = [
  { id: 'b1', title: 'Refactoring UI notes', url: 'https://refactoringui.com' },
  { id: 'b2', title: 'OTP supervision trees', url: 'https://erlang.org' },
  { id: 'b3', title: 'View Transitions API', url: 'https://developer.mozilla.org' },
  { id: 'b4', title: 'Braun D45 archive', url: 'https://braun-design.de' }
];

export class BookmarksApp extends HTMLElement {
  static manifest = {
    id: 'bookmarks',
    type: 'app',
    cols: 2,
    rows: 4,
    defaultCol: 3,
    defaultRow: 1,
    expandable: true,
  };

  constructor() {
    super();
    this.storage = storage;
    this.unsubscribe = null;
    this.isAdding = false;
    this.editingId = null;
  }

  connectedCallback() {
    this.render();
    if (this.storage && this.storage.subscribe) {
      this.unsubscribe = this.storage.subscribe('app:bookmarks', () => this.render());
    }
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
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

  addBookmark(titleOrObj, urlStr) {
    let title = typeof titleOrObj === 'object' ? titleOrObj.title : titleOrObj;
    let url = typeof titleOrObj === 'object' ? titleOrObj.url : urlStr;
    if (!title || !title.trim() || !url || !url.trim()) return null;

    title = title.trim();
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const list = this.getBookmarks();
    const newItem = {
      id: 'b_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      title,
      url
    };
    const updated = [newItem, ...list];
    if (this.storage && this.storage.set) {
      this.storage.set('app:bookmarks', updated);
    }
    return newItem;
  }

  updateBookmark(id, titleOrObj, urlStr) {
    if (!id) return;
    let title = typeof titleOrObj === 'object' ? titleOrObj.title : titleOrObj;
    let url = typeof titleOrObj === 'object' ? titleOrObj.url : urlStr;

    const list = this.getBookmarks();
    const updated = list.map(item => {
      if (item.id === id) {
        const newTitle = (title && title.trim()) ? title.trim() : item.title;
        let newUrl = (url && url.trim()) ? url.trim() : item.url;
        if (newUrl && !/^https?:\/\//i.test(newUrl)) {
          newUrl = 'https://' + newUrl;
        }
        return { ...item, title: newTitle, url: newUrl };
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

    const itemsHtml = list.map(item => {
      const id = escapeHtml(item.id);
      const title = escapeHtml(item.title);
      if (this.editingId === item.id) {
        return `
          <li class="bookmark-item editing-item">
            <form class="edit-bookmark-form" data-id="${id}">
              <input type="text" class="input bookmark-title-input" placeholder="Title" value="${title}" aria-label="Bookmark title" required>
              <input type="text" class="input bookmark-url-input" placeholder="https://example.com" value="${escapeHtml(item.url)}" aria-label="Bookmark URL" required>
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

      return `
        <li class="bookmark-item">
          <div class="bookmark-content">
            <a href="${safeHref(item.url)}" target="_blank" rel="noopener">${title}</a>
            <span class="domain">${escapeHtml(this.extractDomain(item.url))}</span>
          </div>
          <div class="bookmark-actions">
            <button type="button" class="action-button edit-bookmark-btn" data-id="${id}" aria-label="Edit ${title}">Edit</button>
            <button type="button" class="action-button action-button--danger delete-bookmark-btn" data-id="${id}" aria-label="Delete ${title}">Delete</button>
          </div>
        </li>
      `;
    }).join('');

    const listHtml = list.length
      ? `<ul class="bookmark-list">${itemsHtml}</ul>`
      : '<p class="label empty-state">No bookmarks yet</p>';

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
          <div class="form-actions">
            <button id="cancel-button" type="button" class="button-secondary">Cancel</button>
            <button type="submit" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>
    ` : '';

    this.innerHTML = `
      <style>
        .app-bookmarks .bookmark-list {
          list-style: none;
          margin: 0;
          padding: 0;
          overflow-y: auto;
          border-top: 1px solid var(--color-line);
        }
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
          <button class="zoom-button" type="button" aria-label="Expand Bookmarks"><span class="icon icon--zoom" aria-hidden="true"></span></button>
        </div>
      </div>
      ${listHtml}
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

      addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = titleInput ? titleInput.value : '';
        const url = urlInput ? urlInput.value : '';
        if (title.trim() && url.trim()) {
          this.isAdding = false;
          this.addBookmark(title, url);
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
          this.updateBookmark(id, title, url);
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
