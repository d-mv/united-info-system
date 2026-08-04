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
    const stored = this.storage.get('app:bookmarks', null);
    if (!stored || !Array.isArray(stored)) {
      this.storage.set('app:bookmarks', DEFAULT_BOOKMARKS);
      return DEFAULT_BOOKMARKS;
    }
    return stored;
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
    const itemsHtml = list.map(item => `
      <li>
        <a href="${item.url}" target="_blank" rel="noopener">${item.title}</a>
        <span class="domain">${this.extractDomain(item.url)}</span>
      </li>
    `).join('');

    this.innerHTML = `
      <style>
        .app-bookmarks ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .app-bookmarks a {
          color: var(--color-text);
          text-decoration: none;
          font-size: var(--text-size-body);
        }
        .app-bookmarks a:hover { text-decoration: underline; }
        .app-bookmarks .domain {
          display: block;
          font-size: var(--text-size-label);
          letter-spacing: var(--text-tracking-label);
          color: var(--color-text-muted);
          margin-top: 2px;
        }
      </style>
      <p class="label">Bookmarks</p>
      <button class="zoom-button" type="button" aria-label="Expand Bookmarks"><img src="assets/zoom_icon.svg" alt="Zoom" /></button>
      <ul>
        ${itemsHtml}
      </ul>
    `;
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-bookmarks', BookmarksApp);
  } catch (e) {}
}
