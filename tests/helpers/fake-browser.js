/**
 * Shared fake browser for node tests.
 *
 * Storage goes through the real StorageEngine over a fake localStorage, so tests
 * use the production contract (keyed reads, JSON copies, notify on write,
 * cross-tab `storage` events) instead of each file restating it.
 *
 * Call installBrowserGlobals() before importing any module that defines a
 * custom element or reads `window` at import time.
 */
import { StorageEngine } from '../../core/storage.js';

export class FakeLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, val) {
    this.store.set(key, String(val));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

export class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(cb);
  }
  removeEventListener(type, cb) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(cb);
  }
  dispatchEvent(event) {
    if (!this.listeners.has(event.type)) return;
    for (const cb of this.listeners.get(event.type)) cb(event);
  }
}

/** Bare custom-element base. Tests that need DOM lookups override them per instance. */
export class FakeHTMLElement {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
  }
  connectedCallback() {}
  disconnectedCallback() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

export function installBrowserGlobals() {
  globalThis.window = new FakeEventTarget();
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.detail = opts.detail;
    }
  };
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = { define: () => {} };
}

/** A real StorageEngine over an emptied fake localStorage, pre-seeded with `seed` ({ key: value }). */
export function makeStorage(seed = {}) {
  globalThis.localStorage.clear();
  const storage = new StorageEngine();
  for (const [key, value] of Object.entries(seed)) storage.set(key, value);
  return storage;
}

/** Simulate another tab writing `value` to `key` (unprefixed): updates localStorage and fires `storage`. */
export function writeFromOtherTab(key, value, prefix = 'dashboard:') {
  const fullKey = prefix + key;
  const newValue = value === null ? null : JSON.stringify(value);
  if (newValue === null) globalThis.localStorage.removeItem(fullKey);
  else globalThis.localStorage.setItem(fullKey, newValue);
  const event = new globalThis.CustomEvent('storage');
  event.key = fullKey;
  event.newValue = newValue;
  globalThis.window.dispatchEvent(event);
}
