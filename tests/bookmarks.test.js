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

test('BookmarksApp stores a group and shows group headings, ungrouped first', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const app = new BookmarksApp();
  app.storage = makeStorage({ 'app:bookmarks': [{ id: 'b1', title: 'Loose', url: 'https://loose.dev' }] });
  app.addBookmark({ title: 'Work site', url: 'work.dev', group: ' Work ' });
  const stored = app.storage.get('app:bookmarks');
  assert.strictEqual(stored[0].group, 'Work', 'group is trimmed');

  app.updateBookmark('b1', { title: 'Loose', url: 'https://loose.dev', group: 'Fun' });
  assert.strictEqual(app.storage.get('app:bookmarks').find(b => b.id === 'b1').group, 'Fun');
  app.updateBookmark('b1', { title: 'Loose', url: 'https://loose.dev', group: '' });
  assert.strictEqual(app.storage.get('app:bookmarks').find(b => b.id === 'b1').group, undefined, 'empty group removes it');

  app.connectedCallback();
  assert.ok(app.innerHTML.includes('class="bookmark-group__name'));
  assert.ok(app.innerHTML.indexOf('Loose') < app.innerHTML.indexOf('>Work<'), 'ungrouped before groups');
  app.disconnectedCallback();
});

test('BookmarksApp opens the Nth bookmark on keys 1-9, not while typing', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const app = new BookmarksApp();
  const list = Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, title: `Site ${i}`, url: `https://s${i}.dev` }));
  app.storage = makeStorage({ 'app:bookmarks': list });
  app.render();
  assert.strictEqual((app.innerHTML.match(/class="bookmark-key"/g) || []).length, 9, 'hints for the first nine only');

  const opened = [];
  globalThis.window.open = (url) => { opened.push(url); };
  const key = (k, extra = {}) => ({ key: k, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  app.onShortcut(key('3'));
  app.onShortcut(key('3', { target: { tagName: 'INPUT' } }));
  app.onShortcut(key('3', { target: { tagName: 'DIV', isContentEditable: true } }));
  app.onShortcut(key('3', { metaKey: true }));
  assert.deepStrictEqual(opened, ['https://s2.dev']);
});

test('BookmarksApp imports a browser bookmarks file and reports the result', async () => {
  const { BookmarksApp } = await import('../apps/bookmarks/bookmarks-app.js');
  const app = new BookmarksApp();
  app.storage = makeStorage({ 'app:bookmarks': [{ id: 'b1', title: 'A', url: 'https://a.dev' }] });
  app.connectedCallback();
  const result = app.importText('<DL><p><DT><A HREF="https://a.dev/">A</A><DT><H3>G</H3><DL><p><DT><A HREF="https://b.dev">B</A></DL><p></DL>');
  assert.deepStrictEqual(result, { added: 1, skipped: 1 });
  const stored = app.storage.get('app:bookmarks');
  assert.deepStrictEqual(stored.map(b => b.title), ['A', 'B']);
  assert.strictEqual(stored[1].group, 'G');
  assert.ok(app.innerHTML.includes('Imported 1'), 'result shown');

  app.importText('nothing here');
  assert.ok(app.innerHTML.includes('No bookmarks found'), 'empty file explained');
  app.disconnectedCallback();
});
