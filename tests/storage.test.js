import { test } from 'node:test';
import assert from 'node:assert';
import { StorageEngine } from '../core/storage.js';
import { installBrowserGlobals } from './helpers/fake-browser.js';

installBrowserGlobals();

test('StorageEngine gets, sets, and removes namespaced keys safely', () => {
  localStorage.clear();
  const storage = new StorageEngine({ prefix: 'dashboard:' });

  assert.strictEqual(storage.get('test_key', 'default'), 'default');

  storage.set('test_key', { foo: 'bar' });
  assert.deepStrictEqual(storage.get('test_key'), { foo: 'bar' });

  storage.remove('test_key');
  assert.strictEqual(storage.get('test_key', null), null);
});

test('StorageEngine triggers subscription on local updates', () => {
  localStorage.clear();
  const storage = new StorageEngine({ prefix: 'dashboard:' });
  let notifiedValue = null;

  const unsubscribe = storage.subscribe('app:todo', (val) => {
    notifiedValue = val;
  });

  storage.set('app:todo', [{ id: 1, text: 'Buy milk' }]);
  assert.deepStrictEqual(notifiedValue, [{ id: 1, text: 'Buy milk' }]);

  unsubscribe();
});

test('StorageEngine reacts to cross-tab window storage events', () => {
  localStorage.clear();
  const storage = new StorageEngine({ prefix: 'dashboard:' });
  let crossTabVal = null;

  storage.subscribe('app:todo', (val) => {
    crossTabVal = val;
  });

  // Simulate cross-tab event fired by browser when another tab updates localStorage
  const storageEvent = new CustomEvent('storage');
  storageEvent.key = 'dashboard:app:todo';
  storageEvent.newValue = JSON.stringify([{ id: 2, text: 'Cross-tab item' }]);
  storageEvent.oldValue = null;

  window.dispatchEvent(storageEvent);

  assert.deepStrictEqual(crossTabVal, [{ id: 2, text: 'Cross-tab item' }]);
});
