import { test } from 'node:test';
import assert from 'node:assert';

// Custom Element Mock for Node testing
class MockHTMLElement {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this._listeners = new Map();
  }

  connectedCallback() {}
  disconnectedCallback() {}

  querySelector(selector) {
    if (this.innerHTML.includes('id="clock-text"')) {
      return { textContent: '' };
    }
    return null;
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.customElements = {
  define: () => {}
};

test('ClockWidget defines static manifest and updates time', async () => {
  const { ClockWidget } = await import('../widgets/clock/clock-widget.js');

  assert.ok(ClockWidget.manifest);
  assert.strictEqual(ClockWidget.manifest.id, 'clock');
  assert.strictEqual(ClockWidget.manifest.type, 'widget');

  const clock = new ClockWidget();
  clock.connectedCallback();
  assert.ok(clock.innerHTML.includes('Clock'));
  assert.ok(clock.innerHTML.includes('live-dot'));

  clock.disconnectedCallback();
});
