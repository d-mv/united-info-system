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

test('TodoApp lets several tasks be in progress and toggles each on its own', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app, read } = makeApp(TodoApp, [
    { id: 'a', text: 'A', done: false, active: true },
    { id: 'b', text: 'B', done: false },
  ]);

  app.toggleActive('b');
  assert.deepStrictEqual(read().map(t => !!t.active), [true, true], 'A stays in progress when B is added');

  app.toggleActive('a');
  assert.deepStrictEqual(read().map(t => !!t.active), [false, true], 'clicking again clears only that task');
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

function makeAppWithPrefs(TodoApp, todos, prefs = null) {
  const app = new TodoApp();
  const store = { 'app:todo': todos, 'app:todo:view': prefs };
  app.storage = {
    get: (key, fallback = null) => (store[key] ?? fallback),
    set: (key, val) => { store[key] = val; },
    subscribe: () => () => {}
  };
  return { app, store };
}

test('TodoApp hides completed tasks by default and shows a count toggle', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app } = makeAppWithPrefs(TodoApp, [
    { id: 'a', text: 'Open task', done: false },
    { id: 'b', text: 'Finished one', done: true },
    { id: 'c', text: 'Finished two', done: true },
  ]);
  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Open task'));
  assert.ok(!app.innerHTML.includes('Finished one'), 'done tasks hidden by default');
  assert.ok(app.innerHTML.includes('data-action="toggle-completed"'));
  assert.ok(/Completed · 2/.test(app.innerHTML), 'shows how many are hidden');
});

test('TodoApp show-completed toggle reveals done tasks and is remembered', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app, store } = makeAppWithPrefs(TodoApp, [
    { id: 'a', text: 'Open task', done: false },
    { id: 'b', text: 'Finished one', done: true },
  ]);
  app.connectedCallback();
  app.toggleShowCompleted();
  assert.strictEqual(store['app:todo:view'].showCompleted, true, 'preference saved');
  assert.ok(app.innerHTML.includes('Finished one'), 'done tasks now visible');
  assert.ok(app.innerHTML.includes('aria-pressed="true"'));
});

test('TodoApp has no completed toggle when nothing is done, and says so when all are done', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const none = makeAppWithPrefs(TodoApp, [{ id: 'a', text: 'Open task', done: false }]);
  none.app.connectedCallback();
  assert.ok(!none.app.innerHTML.includes('data-action="toggle-completed"'));

  const all = makeAppWithPrefs(TodoApp, [{ id: 'b', text: 'Finished one', done: true }]);
  all.app.connectedCallback();
  assert.ok(all.app.innerHTML.includes('All done'), 'hidden-everything state is explained');
  assert.ok(all.app.innerHTML.includes('data-action="toggle-completed"'));
});
