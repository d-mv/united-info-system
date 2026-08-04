/**
 * StorageEngine — Thin, namespaced wrapper around localStorage
 * with safe JSON parsing and cross-tab reactivity via window 'storage' events.
 */
export class StorageEngine {
  constructor(options = {}) {
    this.prefix = options.prefix || 'dashboard:';
    this.subscribers = new Map();

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', (event) => this._handleWindowStorage(event));
    }
  }

  _formatKey(key) {
    return this.prefix + key;
  }

  _stripPrefix(fullKey) {
    if (fullKey && fullKey.startsWith(this.prefix)) {
      return fullKey.slice(this.prefix.length);
    }
    return fullKey;
  }

  get(key, defaultValue = null) {
    try {
      const fullKey = this._formatKey(key);
      const raw = localStorage.getItem(fullKey);
      if (raw === null || raw === undefined) return defaultValue;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[storage] Error reading key "${key}":`, err);
      return defaultValue;
    }
  }

  set(key, value) {
    try {
      const fullKey = this._formatKey(key);
      const serialized = JSON.stringify(value);
      localStorage.setItem(fullKey, serialized);
      this._notify(key, value);
    } catch (err) {
      console.error(`[storage] Quota exceeded or write error for key "${key}":`, err);
    }
  }

  remove(key) {
    try {
      const fullKey = this._formatKey(key);
      localStorage.removeItem(fullKey);
      this._notify(key, null);
    } catch (err) {
      console.error(`[storage] Error removing key "${key}":`, err);
    }
  }

  subscribe(key, callback) {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key).add(callback);

    return () => {
      const keySubscribers = this.subscribers.get(key);
      if (keySubscribers) {
        keySubscribers.delete(callback);
        if (keySubscribers.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  _notify(key, value) {
    const keySubscribers = this.subscribers.get(key);
    if (keySubscribers) {
      for (const cb of keySubscribers) {
        try {
          cb(value);
        } catch (err) {
          console.error(`[storage] Subscriber callback error for "${key}":`, err);
        }
      }
    }

    const wildcardSubscribers = this.subscribers.get('*');
    if (wildcardSubscribers) {
      for (const cb of wildcardSubscribers) {
        try {
          cb(key, value);
        } catch (err) {
          console.error(`[storage] Wildcard subscriber error:`, err);
        }
      }
    }
  }

  _handleWindowStorage(event) {
    if (!event || !event.key) return;
    if (!event.key.startsWith(this.prefix)) return;

    const unnamespacedKey = this._stripPrefix(event.key);
    let parsedValue = null;
    if (event.newValue !== null && event.newValue !== undefined) {
      try {
        parsedValue = JSON.parse(event.newValue);
      } catch (err) {
        parsedValue = event.newValue;
      }
    }

    this._notify(unnamespacedKey, parsedValue);
  }
}

export const storage = new StorageEngine();
