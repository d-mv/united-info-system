import { test } from 'node:test';
import assert from 'node:assert';
import { GridEngine } from '../core/grid.js';
import { ConfigManager, CONFIG_VERSION } from '../core/config.js';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';

installBrowserGlobals();

// DOM mock for GridEngine
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this._children = [];
    // Like a browser, custom properties only stick via setProperty().
    const props = new Map();
    this.style = {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) ?? '',
    };
    this.dataset = {};
    this.attributes = {};
  }

  get children() {
    return this._children;
  }

  replaceChildren(...nodes) {
    this._children = [...nodes];
  }

  appendChild(child) {
    this._children.push(child);
  }

  replaceChild(newChild, oldChild) {
    const idx = this._children.indexOf(oldChild);
    if (idx !== -1) {
      this._children[idx] = newChild;
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

// Let pending module loads settle.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('GridEngine initializes grid properties and mounts module elements into shell', async () => {
  const shell = new MockElement('div');
  const mockConfig = new ConfigManager({
    storage: makeStorage({
      config: {
        version: CONFIG_VERSION,
        grid: { columns: 8, cellSize: 100, padding: 20 },
        modules: [
          { id: 'clock', enabled: true, cols: 2, rows: 1, col: 1, row: 1 },
          { id: 'todo', enabled: true, cols: 4, rows: 4, col: 5, row: 1 }
        ],
        secrets: {}
      }
    })
  });

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
  await flush();

  assert.strictEqual(shell.style.getPropertyValue('--grid-cols'), '8');
  assert.strictEqual(shell.style.getPropertyValue('--cell-size'), '100px');
  assert.strictEqual(shell.style.getPropertyValue('--module-padding'), '20px');
  assert.strictEqual(shell.children.length, 2);

  const clockEl = shell.children[0];
  assert.strictEqual(clockEl.tagName, 'WIDGET-CLOCK');
  assert.strictEqual(clockEl.dataset.module, 'clock');
  assert.strictEqual(clockEl.style['grid-column'], '1 / span 2');
  assert.strictEqual(clockEl.style['grid-row'], '1 / span 1');
});

function makeEngine() {
  const shell = new MockElement('div');
  const configManager = new ConfigManager({
    storage: makeStorage({
      config: {
        version: CONFIG_VERSION,
        grid: { columns: 12, cellSize: 100, padding: 20 },
        modules: [
          { id: 'clock', enabled: true, cols: 2, rows: 2, col: 1, row: 1 },
          { id: 'weather', enabled: true, cols: 2, rows: 2, col: 1, row: 3 }
        ],
        secrets: { weather: { provider: 'openmeteo', apiKey: '', city: 'Porto', units: 'metric' } }
      }
    })
  });
  const loaded = [];
  const loader = async (id) => { loaded.push(id); return { success: true, id, type: 'widget' }; };
  const engine = new GridEngine({ shellElement: shell, configManager, loader });
  return { shell, configManager, engine, loaded };
}

test('GridEngine keeps mounted modules when only widget settings change', async () => {
  const { shell, configManager, engine, loaded } = makeEngine();
  await engine.init();
  await flush();
  const before = [...shell.children];

  configManager.setSecret('weather', { city: 'Oslo' });
  await flush();

  assert.strictEqual(loaded.length, 2, 'no module is reloaded');
  assert.deepStrictEqual(shell.children, before, 'the same elements stay mounted');
  engine.destroy();
});

test('GridEngine re-renders when the layout changes', async () => {
  const { shell, configManager, engine } = makeEngine();
  await engine.init();
  await flush();

  const modules = configManager.get().modules.map(m => (m.id === 'weather' ? { ...m, enabled: false } : m));
  configManager.update({ modules });
  await flush();

  assert.strictEqual(shell.children.length, 1);
  assert.strictEqual(shell.children[0].dataset.module, 'clock');
  engine.destroy();
});
