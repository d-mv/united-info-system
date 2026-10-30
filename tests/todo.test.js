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

function makeApp(TodoApp, todos) {
  const app = new TodoApp();
  let stored = todos;
  app.storage = {
    get: () => stored,
    set: (key, val) => { stored = val; },
    subscribe: () => () => {}
  };
  return { app, read: () => stored };
}

test('TodoApp marks one task in progress at a time and toggles it off', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app, read } = makeApp(TodoApp, [
    { id: 'a', text: 'A', done: false, active: true },
    { id: 'b', text: 'B', done: false },
  ]);

  app.toggleActive('b');
  assert.deepStrictEqual(read().map(t => !!t.active), [false, true], 'B takes over from A');

  app.toggleActive('b');
  assert.deepStrictEqual(read().map(t => !!t.active), [false, false], 'clicking again clears it');
});

test('TodoApp clears in-progress when the task is completed, and ignores done tasks', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app, read } = makeApp(TodoApp, [
    { id: 'a', text: 'A', done: false, active: true },
    { id: 'b', text: 'B', done: true },
  ]);

  app.toggleTodo('a');
  assert.strictEqual(read()[0].done, true);
  assert.strictEqual(!!read()[0].active, false, 'finishing a task ends "in progress"');

  app.toggleActive('b');
  assert.strictEqual(!!read()[1].active, false, 'a done task cannot be in progress');
});

test('TodoApp renders an in-progress toggle with pressed state for open tasks only', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app } = makeApp(TodoApp, [
    { id: 'a', text: 'A', done: false, active: true },
    { id: 'b', text: 'B', done: false },
    { id: 'c', text: 'C', done: true },
  ]);
  app.connectedCallback();
  const toggles = app.innerHTML.match(/data-action="toggle-active"/g) || [];
  assert.strictEqual(toggles.length, 2, 'no toggle on the done task');
  assert.ok(app.innerHTML.includes('aria-pressed="true"'));
  assert.ok(app.innerHTML.includes('aria-pressed="false"'));
});
