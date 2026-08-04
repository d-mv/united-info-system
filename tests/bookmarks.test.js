import { test } from 'node:test';
import assert from 'node:assert';

// Mock DOM for Web Component testing
class MockHTMLElement {
  constructor() {
    this.innerHTML = '';
  }

  connectedCallback() {}
  disconnectedCallback() {}

  querySelector(selector) {
    return null;
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.customElements = {
  define: () => {}
};

test('BookmarksApp renders bookmarks and subscribes to storage changes', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');

  assert.ok(BookmarksApp.manifest);
  assert.strictEqual(BookmarksApp.manifest.id, 'bookmarks');
  assert.strictEqual(BookmarksApp.manifest.type, 'app');

  const app = new BookmarksApp();
  app.storage = {
    get: () => [
      { title: 'MDN Web Docs', url: 'https://developer.mozilla.org' }
    ],
    set: () => {},
    subscribe: (key, cb) => {
      app.subCb = cb;
      return () => {};
    }
  };

  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Bookmarks'));
  assert.ok(app.innerHTML.includes('MDN Web Docs'));
  assert.ok(app.innerHTML.includes('developer.mozilla.org'));
});
