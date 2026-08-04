import { test } from 'node:test';
import assert from 'node:assert';

// Mock DOM for Web Component testing
class MockHTMLElement {
  constructor() {
    this.innerHTML = '';
  }

  connectedCallback() {}
  disconnectedCallback() {}

  querySelector(selector) {
    return null;
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.customElements = {
  define: () => {}
};

test('TodoApp renders task list and toggles completion status', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');

  assert.ok(TodoApp.manifest);
  assert.strictEqual(TodoApp.manifest.id, 'todo');
  assert.strictEqual(TodoApp.manifest.type, 'app');

  const app = new TodoApp();
  app.storage = {
    get: () => [
      { id: 't1', text: 'Test todo item', done: false }
    ],
    set: (key, val) => { app.savedTodos = val; },
    subscribe: () => () => {}
  };

  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Today') || app.innerHTML.includes('Todo'));
  assert.ok(app.innerHTML.includes('Test todo item'));

  app.toggleTodo('t1');
  assert.strictEqual(app.savedTodos[0].done, true);
});
