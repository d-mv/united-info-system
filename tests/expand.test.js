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

test('ExpandController toggles module expansion and updates aria-label preserving inner icon', async () => {
  let clickHandler = null;
  const attributes = new Map([['aria-label', 'Expand Bookmarks']]);
  
  const mockZoomBtn = {
    className: 'zoom-button',
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, val) => attributes.set(key, val),
    closest: (selector) => {
      if (selector === '.zoom-button') return mockZoomBtn;
      if (selector === '.module') return mockModule;
      return null;
    },
    innerHTML: '<img src="assets/zoom_icon.svg" alt="Zoom">'
  };

  const mockModule = {
    className: 'module',
    classList: {
      contains: (cls) => mockModule.className.includes(cls),
      add: (cls) => { if (!mockModule.className.includes(cls)) mockModule.className += ' ' + cls; },
      remove: (cls) => { mockModule.className = mockModule.className.replace(cls, '').trim(); }
    },
    querySelector: (selector) => (selector === '.zoom-button' ? mockZoomBtn : null)
  };

  globalThis.document.addEventListener = (event, fn) => {
    if (event === 'click') clickHandler = fn;
  };

  const { setupExpandController } = await import('../core/expand.js');
  setupExpandController();

  assert.strictEqual(typeof clickHandler, 'function');

  // Trigger click to expand
  clickHandler({ target: mockZoomBtn });
  assert.ok(mockModule.className.includes('expanded'), 'Module should have expanded class');
  assert.strictEqual(mockZoomBtn.getAttribute('aria-label'), 'Collapse Bookmarks');
  assert.strictEqual(mockZoomBtn.innerHTML, '<img src="assets/zoom_icon.svg" alt="Zoom">', 'Icon HTML must be preserved');

  // Trigger click to collapse
  clickHandler({ target: mockZoomBtn });
  assert.strictEqual(mockModule.className.includes('expanded'), false, 'Module should no longer have expanded class');
  assert.strictEqual(mockZoomBtn.getAttribute('aria-label'), 'Expand Bookmarks');
  assert.strictEqual(mockZoomBtn.innerHTML, '<img src="assets/zoom_icon.svg" alt="Zoom">', 'Icon HTML must be preserved');
});
