import { test } from 'node:test';
import assert from 'node:assert';

class MockElement {
  constructor(className = '') {
    this.className = className;
    this.classList = {
      contains: (cls) => this.className.includes(cls),
      add: (cls) => { if (!this.className.includes(cls)) this.className += ' ' + cls; },
      remove: (cls) => { this.className = this.className.replace(cls, '').trim(); },
      toggle: (cls) => {
        if (this.className.includes(cls)) this.className = this.className.replace(cls, '').trim();
        else this.className += ' ' + cls;
      }
    };
  }
}

globalThis.document = {
  body: new MockElement(''),
  addEventListener: () => {},
  querySelector: () => null
};

test('ExpandController exports setupExpandController function', async () => {
  const { setupExpandController } = await import('../core/expand.js');
  assert.strictEqual(typeof setupExpandController, 'function');
});
