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
    getSecret: () => ({ apiKey: '', city: 'London' }),
    setSecret: (id, secrets) => { widget.savedSecrets = secrets; }
  };
  widget.storage = {
    get: () => ({ temp: '15°', condition: 'Sunny', city: 'London', fetchedAt: Date.now() }),
    set: () => {}
  };

  widget.connectedCallback();
  assert.ok(widget.innerHTML.includes('Setup') || widget.innerHTML.includes('Weather'));

  // Test setup dialog toggle
  widget.openSetup();
  assert.ok(widget.innerHTML.includes('setup-dialog'));
  assert.ok(widget.innerHTML.includes('API Key'));
});
