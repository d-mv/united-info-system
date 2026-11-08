import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';
import { buildBackup, parseBackup, restoreBackup } from '../core/backup.js';

installBrowserGlobals();

test('StorageEngine.keys lists only its own namespace', () => {
  const storage = makeStorage({ 'app:todo': [1], config: { a: 1 } });
  localStorage.setItem('other-site:thing', 'x');
  assert.deepStrictEqual(storage.keys().sort(), ['app:todo', 'config']);
});

test('buildBackup captures every dashboard key with a header', () => {
  const storage = makeStorage({ 'app:todo': [{ id: 't1' }], config: { version: 3 } });
  const backup = buildBackup(storage, new Date('2026-11-08T10:00:00Z'));
  assert.strictEqual(backup.app, 'uis');
  assert.strictEqual(backup.format, 1);
  assert.strictEqual(backup.exportedAt, '2026-11-08T10:00:00.000Z');
  assert.deepStrictEqual(backup.data, { 'app:todo': [{ id: 't1' }], config: { version: 3 } });
});

test('parseBackup accepts a UIS backup and explains anything else', () => {
  const good = JSON.stringify({ app: 'uis', format: 1, exportedAt: 'x', data: { config: {} } });
  assert.strictEqual(parseBackup(good)._tag, 'Ok');
  assert.deepStrictEqual(parseBackup('not json'), { _tag: 'Err', error: 'This file is not valid JSON.' });
  assert.strictEqual(parseBackup(JSON.stringify({ app: 'other', data: {} }))._tag, 'Err');
  assert.strictEqual(parseBackup(JSON.stringify({ app: 'uis', format: 99, data: {} }))._tag, 'Err', 'newer format');
  assert.strictEqual(parseBackup(JSON.stringify({ app: 'uis', format: 1, data: [] }))._tag, 'Err');
  assert.strictEqual(parseBackup(JSON.stringify({ app: 'uis', format: 1, data: { 'bad key!': 1 } }))._tag, 'Err', 'unexpected key names');
});

test('restoreBackup replaces all dashboard data and leaves other sites alone', () => {
  const storage = makeStorage({ 'app:todo': [{ id: 'old' }], 'app:bookmarks': [] });
  localStorage.setItem('other-site:thing', 'keep');
  restoreBackup(storage, { app: 'uis', format: 1, data: { 'app:todo': [{ id: 'new' }], config: { version: 3 } } });
  assert.deepStrictEqual(storage.get('app:todo'), [{ id: 'new' }]);
  assert.strictEqual(storage.get('app:bookmarks', 'gone'), 'gone', 'keys missing from the backup are removed');
  assert.deepStrictEqual(storage.get('config'), { version: 3 });
  assert.strictEqual(localStorage.getItem('other-site:thing'), 'keep');
});
