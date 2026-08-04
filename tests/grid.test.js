import { test } from 'node:test';
import assert from 'node:assert';
import { GridEngine } from '../core/grid.js';

// DOM mock for GridEngine
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
  }

  appendChild(child) {
    this.children.push(child);
  }

  replaceChild(newChild, oldChild) {
    const idx = this.children.indexOf(oldChild);
    if (idx !== -1) {
      this.children[idx] = newChild;
    }
  }

  setAttribute(name, val) {
    this.attributes[name] = val;
  }

  getAttribute(name) {
    return this.attributes[name];
  }
}

globalThis.document = {
  createElement: (tagName) => new MockElement(tagName)
};

test('GridEngine initializes grid properties and mounts module elements into shell', async () => {
  const shell = new MockElement('div');
  const mockConfig = {
    get: () => ({
      grid: { columns: 8, cellSize: 100, padding: 20 },
      modules: [
        { id: 'clock', enabled: true, cols: 2, rows: 1, col: 1, row: 1 },
        { id: 'todo', enabled: true, cols: 4, rows: 4, col: 5, row: 1 }
      ]
    }),
    subscribe: () => () => {}
  };

  const mockLoader = async (id) => {
    if (id === 'clock') return { success: true, id, type: 'widget', tagName: 'widget-clock' };
    if (id === 'todo') return { success: true, id, type: 'app', tagName: 'app-todo' };
    return { success: false, id, error: new Error('Unknown') };
  };

  const engine = new GridEngine({
    shellElement: shell,
    configManager: mockConfig,
    loader: mockLoader
  });

  await engine.init();

  assert.strictEqual(shell.style['--grid-cols'], '8');
  assert.strictEqual(shell.style['--cell-size'], '100px');
  assert.strictEqual(shell.children.length, 2);

  const clockEl = shell.children[0];
  assert.strictEqual(clockEl.tagName, 'WIDGET-CLOCK');
  assert.strictEqual(clockEl.dataset.module, 'clock');
  assert.strictEqual(clockEl.style['grid-column'], '1 / span 2');
  assert.strictEqual(clockEl.style['grid-row'], '1 / span 1');
});
