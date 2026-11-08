import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage, writeFromOtherTab } from './helpers/fake-browser.js';

installBrowserGlobals();

const { NotesApp } = await import('../apps/notes/notes-app.js');
const { collectCommands, clearCommands } = await import('../core/commands.js');

function makeApp(notes) {
  const app = new NotesApp();
  app.storage = makeStorage(notes === undefined ? {} : { 'app:notes': notes });
  return { app, read: () => app.storage.get('app:notes') };
}

const NOTES = [
  { id: 'a', html: '<p>Older note</p>', updatedAt: 1000 },
  { id: 'b', html: '<h2>Newer note</h2><p>body</p>', updatedAt: 5000 },
  { id: 'c', html: '<p><br></p>', updatedAt: 3000 },
];

test('NotesApp shows an empty state when there are no notes', () => {
  const { app } = makeApp();
  app.connectedCallback();
  assert.ok(app.innerHTML.includes('class="label empty-state'), app.innerHTML);
  assert.ok(app.innerHTML.includes('No notes'));
  assert.ok(app.innerHTML.includes('data-action="new"'));
  app.disconnectedCallback();
});

test('NotesApp lists notes most recently updated first, titled by their first line', () => {
  const { app } = makeApp(NOTES);
  app.connectedCallback();
  const html = app.innerHTML;
  assert.ok(html.indexOf('Newer note') < html.indexOf('Untitled'));
  assert.ok(html.indexOf('Untitled') < html.indexOf('Older note'));
  assert.strictEqual((html.match(/class="note-item"/g) || []).length, 3);
  assert.ok(!html.includes('contenteditable'), 'no editor until a note is opened');
  app.disconnectedCallback();
});

test('NotesApp escapes titles in the list', () => {
  const { app } = makeApp([{ id: 'x', html: '&lt;img src=x onerror=alert(1)&gt;', updatedAt: 1 }]);
  app.connectedCallback();
  assert.ok(!app.innerHTML.includes('<img'));
  assert.ok(app.innerHTML.includes('&lt;img'));
  app.disconnectedCallback();
});

test('NotesApp creates a note and opens it in the editor', () => {
  const { app, read } = makeApp([]);
  app.connectedCallback();
  const id = app.createNote();
  assert.strictEqual(read().length, 1);
  assert.strictEqual(read()[0].id, id);
  assert.strictEqual(app.openId, id);
  assert.ok(app.innerHTML.includes('contenteditable="true"'));
  assert.ok(app.innerHTML.includes('notes-body is-open'));
  assert.ok(app.innerHTML.includes('role="toolbar"'));
  app.disconnectedCallback();
});

test('NotesApp toolbar has labelled buttons for every format', () => {
  const { app } = makeApp(NOTES);
  app.connectedCallback();
  app.openNote('a');
  for (const label of ['Bold', 'Italic', 'Heading', 'Bulleted list', 'Numbered list', 'Link', 'Clear formatting']) {
    assert.ok(app.innerHTML.includes(`aria-label="${label}"`), label);
  }
  assert.strictEqual((app.innerHTML.match(/aria-pressed="false"/g) || []).length, 5, 'toggles start unpressed');
  app.disconnectedCallback();
});

test('NotesApp renders stored note HTML through the sanitizer', () => {
  const { app } = makeApp([{ id: 'x', html: '<p>hi<img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a><script>bad()</script></p>', updatedAt: 1 }]);
  app.connectedCallback();
  app.openNote('x');
  const html = app.innerHTML;
  assert.ok(html.includes('<p>hil</p>'), html);
  assert.ok(!/onerror|javascript:|<script|<img/i.test(html));
  app.disconnectedCallback();
});

test('NotesApp saves sanitized HTML with a new updatedAt, and skips unchanged saves', () => {
  const { app, read } = makeApp([{ id: 'a', html: '<p>old</p>', updatedAt: 1 }]);
  app.connectedCallback();
  assert.strictEqual(app.saveNote('a', '<p onclick="x()">new <b>text</b></p><img src=x>'), true);
  assert.strictEqual(read()[0].html, '<p>new <b>text</b></p>');
  assert.ok(read()[0].updatedAt > 1);
  const stamp = read()[0].updatedAt;
  assert.strictEqual(app.saveNote('a', '<p>new <b>text</b></p>'), false, 'nothing changed');
  assert.strictEqual(read()[0].updatedAt, stamp);
  assert.strictEqual(app.saveNote('gone', '<p>x</p>'), false, 'a missing note is not recreated');
  assert.strictEqual(read().length, 1);
  app.disconnectedCallback();
});

test('NotesApp delete asks first, then removes the note and closes the editor', () => {
  const { app, read } = makeApp(NOTES);
  app.connectedCallback();
  app.openNote('b');
  app.requestDelete();
  assert.strictEqual(read().length, 3, 'nothing deleted yet');
  assert.ok(app.innerHTML.includes('Delete this note?'));
  app.cancelDelete();
  assert.ok(!app.innerHTML.includes('Delete this note?'));
  app.requestDelete();
  app.confirmDelete();
  assert.deepStrictEqual(read().map(n => n.id).sort(), ['a', 'c']);
  assert.strictEqual(app.openId, null);
  assert.ok(!app.innerHTML.includes('contenteditable'));
  app.disconnectedCallback();
});

test('NotesApp discards a note left empty when going back to the list', () => {
  const { app, read } = makeApp([]);
  app.connectedCallback();
  app.createNote();
  app.closeNote();
  assert.strictEqual(read().length, 0);
  assert.ok(app.innerHTML.includes('No notes'));

  app.openNote(app.createNote());
  app.saveNote(app.openId, '<p>keep me</p>');
  app.closeNote();
  assert.strictEqual(read().length, 1);
  app.disconnectedCallback();
});

test('NotesApp does not re-render over the open note when another tab writes', () => {
  const { app } = makeApp(NOTES);
  app.connectedCallback();
  app.openNote('a');
  let full = 0;
  let list = 0;
  const render = app.render.bind(app);
  const renderList = app.renderList.bind(app);
  app.render = () => { full++; render(); };
  app.renderList = () => { list++; renderList(); };

  writeFromOtherTab('app:notes', [...NOTES, { id: 'z', html: '<p>From elsewhere</p>', updatedAt: 9000 }]);
  assert.strictEqual(full, 0, 'editor kept');
  assert.strictEqual(list, 1, 'list refreshed');
  assert.strictEqual(app.openId, 'a');

  writeFromOtherTab('app:notes', NOTES.filter(n => n.id !== 'a'));
  assert.strictEqual(app.openId, null, 'open note deleted elsewhere closes the editor');
  assert.strictEqual(full, 1);
  assert.ok(!app.innerHTML.includes('contenteditable'));
  app.disconnectedCallback();
});

test('NotesApp re-renders the list from other tabs when no note is open', () => {
  const { app } = makeApp(NOTES);
  app.connectedCallback();
  writeFromOtherTab('app:notes', [{ id: 'z', html: '<p>From elsewhere</p>', updatedAt: 9000 }]);
  assert.ok(app.innerHTML.includes('From elsewhere'));
  assert.ok(!app.innerHTML.includes('Older note'));
  app.disconnectedCallback();
});

test('NotesApp palette: New note and Open note: <title>, removed on disconnect', () => {
  clearCommands();
  const { app, read } = makeApp(NOTES);
  app.connectedCallback();
  const titles = collectCommands('note', 20).map(c => c.title);
  assert.ok(titles.includes('New note'));
  assert.ok(titles.includes('Open note: Newer note'));
  assert.ok(titles.includes('Open note: Older note'));

  collectCommands('Open note: Older', 20).find(c => c.title === 'Open note: Older note').run();
  assert.strictEqual(app.openId, 'a');
  collectCommands('New note', 20).find(c => c.title === 'New note').run();
  assert.strictEqual(read().length, 4);

  app.disconnectedCallback();
  assert.strictEqual(collectCommands('note', 20).length, 0);
});

test('NotesApp link form refuses unsafe URLs with a message', () => {
  const { app } = makeApp(NOTES);
  app.connectedCallback();
  app.openNote('a');
  assert.strictEqual(app.applyLink('javascript:alert(1)'), false);
  assert.ok(app.linkError.includes('http'));
  app.disconnectedCallback();
});
