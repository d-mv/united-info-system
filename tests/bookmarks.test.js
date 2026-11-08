import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage, writeFromOtherTab } from './helpers/fake-browser.js';

installBrowserGlobals();

test('BookmarksApp renders bookmarks, add button, zoom button, and subscribes to storage changes', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');

  const app = new BookmarksApp();
  app.storage = makeStorage({
    'app:bookmarks': [{ id: 'b1', title: 'MDN Web Docs', url: 'https://developer.mozilla.org' }]
  });

  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Bookmarks'));
  assert.ok(app.innerHTML.includes('id="add"'));
  assert.ok(app.innerHTML.includes('zoom-button'));
  assert.ok(app.innerHTML.includes('MDN Web Docs'));
  assert.ok(app.innerHTML.includes('developer.mozilla.org'));
});

test('BookmarksApp supports add, update, and delete bookmark operations', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');

  const app = new BookmarksApp();
  app.storage = makeStorage({
    'app:bookmarks': [{ id: 'b1', title: 'Initial Title', url: 'https://initial.com' }]
  });
  const stored = () => app.storage.get('app:bookmarks');

  // Test addBookmark
  const newItem = app.addBookmark('New Site', 'example.com');
  assert.strictEqual(stored().length, 2);
  assert.strictEqual(stored()[0].title, 'New Site');
  assert.strictEqual(stored()[0].url, 'https://example.com');

  // Test updateBookmark
  app.updateBookmark('b1', 'Updated Title', 'https://updated.com');
  const updatedItem = stored().find(b => b.id === 'b1');
  assert.strictEqual(updatedItem.title, 'Updated Title');
  assert.strictEqual(updatedItem.url, 'https://updated.com');

  // Test deleteBookmark
  app.deleteBookmark(newItem.id);
  assert.strictEqual(stored().length, 1);
  assert.strictEqual(stored()[0].id, 'b1');
});

test('BookmarksApp toggles add and edit forms during rendering', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');

  const app = new BookmarksApp();
  app.storage = makeStorage({
    'app:bookmarks': [{ id: 'b1', title: 'Test Bookmark', url: 'https://test.com' }]
  });

  app.connectedCallback();
  assert.ok(!app.innerHTML.includes('id="bookmark-form"'));

  // Toggle add mode
  app.isAdding = true;
  app.render();
  assert.ok(app.innerHTML.includes('id="bookmark-form"'));

  // Toggle edit mode for b1
  app.isAdding = false;
  app.editingId = 'b1';
  app.render();
  assert.ok(app.innerHTML.includes('<form class="edit-bookmark-form"'));
  assert.ok(app.innerHTML.includes('value="Test Bookmark"'));
});

test('BookmarksApp keeps an open add dialog when another tab writes bookmarks', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const app = new BookmarksApp();
  app.storage = makeStorage({ 'app:bookmarks': [{ id: 'b1', title: 'One', url: 'https://one.test' }] });
  app.connectedCallback();
  app.isAdding = true;
  app.render();
  const withDialog = app.innerHTML;

  writeFromOtherTab('app:bookmarks', [{ id: 'b2', title: 'Two', url: 'https://two.test' }]);
  assert.strictEqual(app.innerHTML, withDialog, 'the dialog (and what is typed in it) is not rebuilt');

  app.closeAddDialog();
  assert.ok(app.innerHTML.includes('Two'), 'the change shows once the dialog closes');
  app.disconnectedCallback();
});

test('BookmarksApp keeps an inline edit, and ends it if the bookmark is deleted elsewhere', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const app = new BookmarksApp();
  const one = { id: 'b1', title: 'One', url: 'https://one.test' };
  const two = { id: 'b2', title: 'Two', url: 'https://two.test' };
  app.storage = makeStorage({ 'app:bookmarks': [one, two] });
  app.connectedCallback();
  app.editingId = 'b1';
  app.render();
  const editing = app.innerHTML;

  writeFromOtherTab('app:bookmarks', [one, { ...two, title: 'Two renamed' }]);
  assert.strictEqual(app.innerHTML, editing, 'the edit form is not reset');

  writeFromOtherTab('app:bookmarks', [two]);
  assert.strictEqual(app.editingId, null);
  assert.ok(!app.innerHTML.includes('<form class="edit-bookmark-form"'), 'back to the list');
  assert.ok(app.innerHTML.includes('Two'));
  app.disconnectedCallback();
});
