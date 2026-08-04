import { storage } from '../../core/storage.js';

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
      if (this.editingId === item.id) {
        return `
          <li class="editing-item">
            <form class="bookmark-form edit-bookmark-form" data-id="${item.id}">
              <input type="text" class="bookmark-title-input" placeholder="Title" value="${item.title}" aria-label="Bookmark Title" required>
              <input type="text" class="bookmark-url-input" placeholder="URL (e.g. https://example.com)" value="${item.url}" aria-label="Bookmark URL" required>
              <div class="form-actions">
                <button type="submit" class="save-btn">Save</button>
                <button type="button" class="cancel-btn">Cancel</button>
                <button type="button" class="delete-btn delete-form-btn" aria-label="Delete Bookmark">Delete</button>
              </div>
            </form>
          </li>
        `;
      }

      return `
        <li>
          <div class="bookmark-content">
            <a href="${item.url}" target="_blank" rel="noopener">${item.title}</a>
            <span class="domain">${this.extractDomain(item.url)}</span>
          </div>
          <div class="bookmark-actions">
            <button type="button" class="action-btn edit-bookmark-btn" data-id="${item.id}" aria-label="Edit ${item.title}">Edit</button>
            <button type="button" class="action-btn delete-bookmark-btn" data-id="${item.id}" aria-label="Delete ${item.title}">&times;</button>
          </div>
        </li>
      `;
    }).join('');

    const addFormHtml = this.isAdding ? `
      <div class="module-dialog__container">
      <div class="module-dialog__overlay" aria-hidden="true"/>
      <div class="module-dialog__content">
      <div class="module-dialog__content-header">
        <p class="module-dialog__title">Add Bookmark</p>
        <button id="close-button" class="close-button module-dialog__close" type="button" aria-label="Close Add Bookmark Form"><img src="assets/close_icon.svg" alt="Close" /></button>
      </div>
      <form id="bookmark-form" class="module-dialog__form">
        <input type="text" class="bookmark-title-input" placeholder="Title" aria-label="Bookmark Title" required>
        <input type="text" class="bookmark-url-input" placeholder="URL (e.g. https://example.com)" aria-label="Bookmark URL" required>
        <div class="form-actions">
          <button type="submit" class="button button-primary">Save</button>
          <button id="cancel-button" type="button" class="button button-secondary">Cancel</button>
        </div>
      </form>
      </div>
      </div>
    ` : '';

    this.innerHTML = `
      <style>
        .app-bookmarks {
          position: relative;
        }
        .app-bookmarks ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .app-bookmarks li {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .app-bookmarks .bookmark-content {
          flex: 1;
          min-width: 0;
        }
        .app-bookmarks a {
          color: var(--color-text);
          text-decoration: none;
          font-size: var(--text-size-body);
          display: block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .app-bookmarks a:hover { text-decoration: underline; }
        .app-bookmarks .domain {
          display: block;
          font-size: var(--text-size-label);
          letter-spacing: var(--text-tracking-label);
          color: var(--color-text-muted);
          margin-top: 2px;
        }
        .app-bookmarks .bookmark-actions {
          display: flex;
          gap: 6px;
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .app-bookmarks li:hover .bookmark-actions,
        .app-bookmarks li:focus-within .bookmark-actions {
          opacity: 1;
        }
        .app-bookmarks .action-btn {
          background: transparent;
          border: none;
          color: var(--color-text-muted);
          font-size: var(--text-size-label);
          cursor: pointer;
          padding: 2px 4px;
          line-height: 1;
          border-radius: 2px;
        }
        .app-bookmarks .action-btn:hover {
          color: var(--color-text);
        }
        .app-bookmarks .bookmark-form button.delete-form-btn {
          background: transparent;
          color: var(--color-accent);
          border: 1px solid var(--color-accent);
          margin-left: auto;
        }
      </style>
      <div class="block-header">
        <p class="block-header__label">Bookmarks</p>
        <div class="block-header__actions">
          <button id="add" class="button action-button" type="button" aria-label="Add Bookmark">+ Add</button>
          <button class="button zoom-button" type="button" aria-label="Expand Bookmarks"><img src="assets/zoom_icon.svg" alt="Zoom" /></button>
        </div>
      </div>
        ${addFormHtml}
        <ul>
          ${itemsHtml}
        </ul>
    `;

    this.bindEvents();
  }

  bindEvents() {
    if (typeof this.querySelector !== 'function') return;

    const addBtn = this.querySelector('#add');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isAdding = !this.isAdding;
        this.editingId = null;
        this.render();
        if (this.isAdding) {
          const titleInput = this.querySelector('.add-bookmark-form .bookmark-title-input');
          if (titleInput) titleInput.focus();
        }
      });
    }

    const addForm = this.querySelector('#bookmark-form');
    if (addForm) {
      const titleInput = addForm.querySelector('.bookmark-title-input');
      const urlInput = addForm.querySelector('.bookmark-url-input');
      const cancelBtn = addForm.querySelector('#cancel-button');
      const closeButton = this.querySelector('#close-button');

      const handleSave = (e) => {
        if (e) e.preventDefault();
        const title = titleInput ? titleInput.value : '';
        const url = urlInput ? urlInput.value : '';
        if (title.trim() && url.trim()) {
          this.addBookmark(title, url);
          this.isAdding = false;
          this.render();
        }
      };

      addForm.addEventListener('submit', handleSave);

      if (cancelBtn) {
        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.isAdding = false;
          this.render();
        });
      }

      if (closeButton) {
        closeButton.addEventListener('click', (e) => {
          e.preventDefault();
          this.isAdding = false;
          this.render();
        });
      }
      addForm.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.isAdding = false;
          this.render();
        }
      });
    }

    const editBtns = this.querySelectorAll('.edit-bookmark-btn');
    if (editBtns) {
      editBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          this.editingId = id;
          this.isAdding = false;
          this.render();
          const editForm = this.querySelector('.edit-bookmark-form');
          if (editForm) {
            const titleInput = editForm.querySelector('.bookmark-title-input');
            if (titleInput) titleInput.focus();
          }
        });
      });
    }

    const deleteBtns = this.querySelectorAll('.delete-bookmark-btn');
    if (deleteBtns) {
      deleteBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (id) {
            this.deleteBookmark(id);
            if (this.editingId === id) this.editingId = null;
            this.render();
          }
        });
      });
    }

    const editForm = this.querySelector('.edit-bookmark-form');
    if (editForm) {
      const id = editForm.getAttribute('data-id');
      const titleInput = editForm.querySelector('.bookmark-title-input');
      const urlInput = editForm.querySelector('.bookmark-url-input');
      const cancelBtn = editForm.querySelector('.cancel-btn');
      const deleteBtn = editForm.querySelector('.delete-btn');

      const handleUpdate = (e) => {
        if (e) e.preventDefault();
        const title = titleInput ? titleInput.value : '';
        const url = urlInput ? urlInput.value : '';
        if (title.trim() && url.trim()) {
          this.updateBookmark(id, title, url);
          this.editingId = null;
          this.render();
        }
      };

      editForm.addEventListener('submit', handleUpdate);

      if (cancelBtn) {
        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.editingId = null;
          this.render();
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.deleteBookmark(id);
          this.editingId = null;
          this.render();
        });
      }
      editForm.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.editingId = null;
          this.render();
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
