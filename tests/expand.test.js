import { test } from 'node:test';
import assert from 'node:assert';

// Small fake DOM: modules with one expand toggle each, plus a dialog Close button.
function makeClassList(el) {
  const set = new Set();
  return {
    contains: (c) => set.has(c),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function makeButton(module, { expand, label }) {
  const attrs = new Map([['aria-label', label]]);
  if (expand) attrs.set('aria-expanded', 'false');
  const btn = {
    innerHTML: '<span class="icon icon--zoom" aria-hidden="true"></span>',
    focused: false,
    getAttribute: (k) => attrs.get(k),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    hasAttribute: (k) => (k === 'data-expand' ? expand : attrs.has(k)),
    focus: () => { doc.activeElement = btn; },
    closest: (sel) => {
      if (sel === '[data-expand]') return expand ? btn : null;
      if (sel === '.module') return module;
      return null;
    },
  };
  return btn;
}

function makeModule(name) {
  const mod = { name, inert: false };
  mod.classList = makeClassList(mod);
  mod.classList.add('module');
  mod.toggle = makeButton(mod, { expand: true, label: `Expand ${name}` });
  mod.close = makeButton(mod, { expand: false, label: 'Close' });
  mod.querySelector = (sel) => (sel === '[data-expand]' ? mod.toggle : null);
  return mod;
}

const listeners = {};
const modules = [makeModule('Bookmarks'), makeModule('Weather')];
const [bookmarks, weather] = modules;
const doc = {
  activeElement: null,
  body: { classList: makeClassList() },
  addEventListener: (type, fn) => { listeners[type] = fn; },
  querySelector: (sel) => {
    if (sel === '.module.expanded') return modules.find(m => m.classList.contains('expanded')) || null;
    if (sel === 'dialog[open]') return doc.openDialog || null;
    return null;
  },
  querySelectorAll: (sel) => (sel === '.module' ? modules : []),
};
globalThis.document = doc;

const { setupExpandController } = await import('../core/expand.js');
setupExpandController();
const click = (target) => listeners.click({ target });
const escape = () => listeners.keydown({ key: 'Escape' });

test('Expand toggles one module, sets aria-expanded and makes the rest inert', () => {
  click(bookmarks.toggle);
  assert.ok(bookmarks.classList.contains('expanded'));
  assert.strictEqual(bookmarks.toggle.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(bookmarks.toggle.getAttribute('aria-label'), 'Collapse Bookmarks');
  assert.ok(doc.body.classList.contains('modal-open'));
  assert.strictEqual(weather.inert, true, 'other modules are out of the tab order');
  assert.strictEqual(bookmarks.inert, false);
  assert.strictEqual(doc.activeElement, bookmarks.toggle, 'focus stays inside the expanded module');
  assert.ok(bookmarks.toggle.innerHTML.includes('icon--zoom'), 'icon markup is kept');

  click(bookmarks.toggle);
  assert.ok(!bookmarks.classList.contains('expanded'));
  assert.strictEqual(bookmarks.toggle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(bookmarks.toggle.getAttribute('aria-label'), 'Expand Bookmarks');
  assert.ok(!doc.body.classList.contains('modal-open'));
  assert.strictEqual(weather.inert, false);
});

test('Expanding another module collapses the first, so only one is ever expanded', () => {
  click(bookmarks.toggle);
  click(weather.toggle);
  assert.ok(!bookmarks.classList.contains('expanded'));
  assert.strictEqual(bookmarks.toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(weather.classList.contains('expanded'));
  assert.ok(doc.body.classList.contains('modal-open'));
  assert.strictEqual(bookmarks.inert, true);
  click(weather.toggle);
});

test('Escape collapses and returns focus to the toggle, unless a dialog is open', () => {
  click(weather.toggle);
  doc.openDialog = {};
  escape();
  assert.ok(weather.classList.contains('expanded'), 'the dialog handles its own Escape');
  doc.openDialog = null;

  doc.activeElement = null;
  escape();
  assert.ok(!weather.classList.contains('expanded'));
  assert.ok(!doc.body.classList.contains('modal-open'));
  assert.strictEqual(doc.activeElement, weather.toggle);
  assert.strictEqual(bookmarks.inert, false);
});

test('Buttons that only share the zoom-button look (dialog Close) do not toggle expansion', () => {
  click(bookmarks.close);
  assert.ok(!bookmarks.classList.contains('expanded'));
  assert.ok(!doc.body.classList.contains('modal-open'));
});

test('expandButton renders the toggle from the current state', async () => {
  const { expandButton } = await import('../core/html.js');
  assert.ok(expandButton('Weather', false).includes('aria-expanded="false" aria-label="Expand Weather"'));
  assert.ok(expandButton('Weather', true).includes('aria-expanded="true" aria-label="Collapse Weather"'));
  assert.ok(expandButton('Weather', true).includes('data-expand'));
});
