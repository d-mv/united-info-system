import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage, writeFromOtherTab } from './helpers/fake-browser.js';

installBrowserGlobals();

function makeApp(TodoApp, todos, prefs = null) {
  const app = new TodoApp();
  const seed = { 'app:todo': todos };
  if (prefs) seed['app:todo:view'] = prefs;
  app.storage = makeStorage(seed);
  return { app, read: () => app.storage.get('app:todo'), readPrefs: () => app.storage.get('app:todo:view') };
}

test('TodoApp renders task list and toggles completion status', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');

  assert.ok(TodoApp.manifest);
  assert.strictEqual(TodoApp.manifest.id, 'todo');
  assert.strictEqual(TodoApp.manifest.type, 'app');

  const { app, read } = makeApp(TodoApp, [
    { id: 't1', text: 'Test todo item', done: false }
  ]);

  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Today') || app.innerHTML.includes('Todo'));
  assert.ok(app.innerHTML.includes('Test todo item'));

  app.toggleTodo('t1');
  assert.strictEqual(read()[0].done, true);
});

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

test('TodoApp hides completed tasks by default and shows a count toggle', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app } = makeApp(TodoApp, [
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
  const { app, readPrefs } = makeApp(TodoApp, [
    { id: 'a', text: 'Open task', done: false },
    { id: 'b', text: 'Finished one', done: true },
  ]);
  app.connectedCallback();
  app.toggleShowCompleted();
  assert.strictEqual(readPrefs().showCompleted, true, 'preference saved');
  assert.ok(app.innerHTML.includes('Finished one'), 'done tasks now visible');
  assert.ok(app.innerHTML.includes('aria-pressed="true"'));
});

test('TodoApp has no completed toggle when nothing is done, and says so when all are done', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const none = makeApp(TodoApp, [{ id: 'a', text: 'Open task', done: false }]);
  none.app.connectedCallback();
  assert.ok(!none.app.innerHTML.includes('data-action="toggle-completed"'));

  const all = makeApp(TodoApp, [{ id: 'b', text: 'Finished one', done: true }]);
  all.app.connectedCallback();
  assert.ok(all.app.innerHTML.includes('All done'), 'hidden-everything state is explained');
  assert.ok(all.app.innerHTML.includes('data-action="toggle-completed"'));
});

test('TodoApp re-renders when tasks change, including from another tab', async () => {
  const { TodoApp } = await import('../apps/todo/todo-app.js');
  const { app } = makeApp(TodoApp, [{ id: 'a', text: 'Open task', done: false }]);
  app.connectedCallback();

  app.addTodo('Written here');
  assert.ok(app.innerHTML.includes('Written here'), 'own write re-renders through the subscription');

  writeFromOtherTab('app:todo', [{ id: 'z', text: 'Written elsewhere', done: false }]);
  assert.ok(app.innerHTML.includes('Written elsewhere'), 'cross-tab write re-renders');
  assert.ok(!app.innerHTML.includes('Open task'));
  app.disconnectedCallback();
});
