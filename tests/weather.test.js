import { test } from 'node:test';
import assert from 'node:assert';

// Mock DOM for Web Component testing
class MockHTMLElement {
  constructor() {
    this.innerHTML = '';
    this._listeners = new Map();
  }

  connectedCallback() {}
  disconnectedCallback() {}

  querySelector(selector) {
    if (selector === '.setup-button') return { addEventListener: (ev, fn) => this._listeners.set('setup-click', fn) };
    if (selector === '#save-secrets') return { addEventListener: (ev, fn) => this._listeners.set('save-click', fn) };
    return null;
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.customElements = {
  define: () => {}
};

test('WeatherWidget manifests setup dialog and handles secret configuration', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  assert.ok(WeatherWidget.manifest);
  assert.strictEqual(WeatherWidget.manifest.id, 'weather');

  const widget = new WeatherWidget();
  widget.configManager = {
    getSecret: () => ({ provider: 'openmeteo', apiKey: '', city: 'London', units: 'metric' }),
    setSecret: (id, secrets) => { widget.savedSecrets = secrets; }
  };
  widget.storage = {
    get: () => ({ temp: 15, condition: 'Sunny', city: 'London', provider: 'openmeteo', fetchedAt: Date.now() }),
    set: () => {}
  };

  widget.connectedCallback();
  assert.ok(widget.innerHTML.includes('Setup') || widget.innerHTML.includes('Weather'));

  // Test setup dialog toggle
  widget.openSetup();
  assert.ok(widget.innerHTML.includes('setup-dialog'));
  assert.ok(widget.innerHTML.includes('Open-Meteo'));
  assert.ok(widget.innerHTML.includes('OpenWeatherMap'));
});

test('WeatherWidget fetches data from Open-Meteo API', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  const widget = new WeatherWidget();
  let storedCache = null;
  widget.configManager = {
    getSecret: () => ({ provider: 'openmeteo', city: 'London', units: 'metric' })
  };
  widget.storage = {
    get: () => storedCache,
    set: (key, val) => { storedCache = val; }
  };

  // Mock global fetch for Open-Meteo geocoding and weather
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('geocoding-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [{ latitude: 51.5074, longitude: -0.1278, name: 'London' }]
        })
      };
    }
    if (url.includes('api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          current_weather: { temperature: 18.4, weathercode: 0, time: '2026-08-04T12:00' }
        })
      };
    }
    return { ok: false };
  };

  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.ok(storedCache);
    assert.strictEqual(storedCache.temp, 18);
    assert.strictEqual(storedCache.condition, 'Clear');
    assert.strictEqual(storedCache.city, 'London');
    assert.strictEqual(storedCache.provider, 'openmeteo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeatherWidget fetches data from OpenWeatherMap API when provider is openweathermap', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  const widget = new WeatherWidget();
  let storedCache = null;
  widget.configManager = {
    getSecret: () => ({ provider: 'openweathermap', apiKey: 'valid_key', city: 'Paris', units: 'metric' })
  };
  widget.storage = {
    get: () => storedCache,
    set: (key, val) => { storedCache = val; }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('api.openweathermap.org')) {
      return {
        ok: true,
        json: async () => ({
          main: { temp: 22.1 },
          weather: [{ main: 'Clouds' }],
          name: 'Paris'
        })
      };
    }
    return { ok: false };
  };

  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.ok(storedCache);
    assert.strictEqual(storedCache.temp, 22);
    assert.strictEqual(storedCache.condition, 'Clouds');
    assert.strictEqual(storedCache.city, 'Paris');
    assert.strictEqual(storedCache.provider, 'openweathermap');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

