import { storage } from '../../core/storage.js';
import { escapeHtml } from '../../core/html.js';

export const DEFAULT_TODOS = [
  { id: 't1', text: 'Finish grid engine placement logic', done: false, active: true },
  { id: 't2', text: 'Wire up weather stale-while-revalidate', done: false },
  { id: 't3', text: 'Review theme.css contrast on mobile', done: false },
  { id: 't4', text: 'Draft start.sh', done: true },
  { id: 't5', text: 'Pick accent color', done: true }
];

export class TodoApp extends HTMLElement {
  static manifest = {
    id: 'todo',
    type: 'app',
    cols: 4,
    rows: 4,
    defaultCol: 5,
    defaultRow: 1,
    expandable: true,
  };

  constructor() {
    super();
    this.storage = storage;
    this.unsubscribe = null;
  }

  connectedCallback() {
    this.render();
    if (this.storage && this.storage.subscribe) {
      this.unsubscribe = this.storage.subscribe('app:todo', () => this.render());
    }
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  getTodos() {
    const stored = this.storage.get('app:todo', null);
    if (!stored || !Array.isArray(stored)) {
      this.storage.set('app:todo', DEFAULT_TODOS);
      return DEFAULT_TODOS;
    }
    return stored;
  }

  toggleTodo(id) {
    const todos = this.getTodos().map(t => {
      // Finishing a task ends "in progress" for it.
      if (t.id === id) return { ...t, done: !t.done, active: false };
      return t;
    });
    this.storage.set('app:todo', todos);
  }

  // Mark the task you're working on now. Only one at a time; click again to clear.
  toggleActive(id) {
    const todos = this.getTodos();
    const target = todos.find(t => t.id === id);
    if (!target || target.done) return;
    const turnOn = !target.active;
    this.storage.set('app:todo', todos.map(t => ({ ...t, active: turnOn && t.id === id })));
  }

  addTodo(text) {
    if (!text || !text.trim()) return;
    const todos = this.getTodos();
    const newTodo = {
      id: 't_' + Date.now(),
      text: text.trim(),
      done: false
    };
    this.storage.set('app:todo', [newTodo, ...todos]);
  }

  render() {
    const todos = this.getTodos();

    const itemsHtml = todos.map(item => {
      const id = escapeHtml(item.id);
      const text = escapeHtml(item.text);
      const active = !!item.active && !item.done;
      const toggle = item.done ? '' : `
        <button type="button" class="todo-now${active ? ' is-active' : ''}" data-action="toggle-active" data-id="${id}"
          aria-pressed="${active}" aria-label="${active ? 'Stop working on' : 'Working on'} ${text}"
          title="${active ? 'In progress' : 'Mark in progress'}"><span class="todo-now__dot" aria-hidden="true"></span></button>`;
      return `
      <li class="todo-item${item.done ? ' done' : ''}${active ? ' is-active' : ''}">
        <input type="checkbox" class="todo-check" id="todo-${id}" data-id="${id}" ${item.done ? 'checked' : ''}>
        <label for="todo-${id}" class="todo-text">${text}</label>
        ${toggle}
      </li>`;
    }).join('');

    const listHtml = todos.length
      ? `<ul class="todo-list">${itemsHtml}</ul>`
      : '<p class="label empty-state">Nothing to do</p>';

    this.innerHTML = `
      <style>
        .app-todo .todo-compose {
          display: flex;
          align-items: center;
          gap: 1rem;
          height: var(--control-height);
          margin-bottom: 0.4rem;
          border-bottom: 1px solid var(--color-line-strong);
        }
        .app-todo .todo-compose__plus {
          font-family: var(--font-mono);
          color: var(--color-ink-faint);
        }
        .app-todo .add-todo-input {
          flex: 1;
          min-width: 0;
          height: 100%;
          background: transparent;
          border: none;
          outline: none;
          color: var(--color-ink);
          font-size: var(--text-base);
        }
        .app-todo .add-todo-input::placeholder { color: var(--color-ink-faint); }
        .app-todo .todo-compose:focus-within { border-bottom-color: var(--color-ink); }
        .app-todo .keyhint {
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-meta);
          color: var(--color-ink-faint);
          border: 1px solid var(--color-line);
          border-radius: var(--radius);
          padding: 0.1rem 0.5rem;
        }
        .app-todo .todo-list {
          list-style: none;
          margin: 0;
          padding: 0;
          overflow-y: auto;
        }
        .app-todo .todo-item {
          display: flex;
          align-items: center;
          gap: 1.2rem;
          min-height: 4rem;
          border-bottom: 1px solid var(--color-line);
        }
        .app-todo .todo-check {
          appearance: none;
          flex: none;
          display: grid;
          place-content: center;
          width: 1.4rem;
          height: 1.4rem;
          margin: 0;
          border: 1px solid var(--color-line-strong);
          border-radius: var(--radius);
          background: transparent;
          cursor: pointer;
        }
        .app-todo .todo-check:hover { border-color: var(--color-ink); }
        .app-todo .todo-check:checked {
          background: var(--color-ink);
          border-color: var(--color-ink);
        }
        .app-todo .todo-check:checked::after {
          content: "";
          width: 0.7rem;
          height: 0.4rem;
          margin-top: -0.2rem;
          border-left: 1.5px solid var(--color-ink-inverse);
          border-bottom: 1.5px solid var(--color-ink-inverse);
          transform: rotate(-45deg);
        }
        .app-todo .todo-text {
          flex: 1;
          min-width: 0;
          cursor: pointer;
          overflow-wrap: anywhere;
        }
        .app-todo .todo-now {
          flex: none;
          display: grid;
          place-content: center;
          width: 2.4rem;
          height: 2.4rem;
          opacity: 0;
          transition: opacity var(--duration) var(--ease);
        }
        .app-todo .todo-item:hover .todo-now,
        .app-todo .todo-now:focus-visible,
        .app-todo .todo-now.is-active { opacity: 1; }
        @media (hover: none) {
          .app-todo .todo-now { opacity: 1; }
        }
        .app-todo .todo-now__dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          border: 1px solid var(--color-ink-faint);
          transition: border-color var(--duration) var(--ease), background var(--duration) var(--ease);
        }
        .app-todo .todo-now:hover .todo-now__dot { border-color: var(--color-accent); }
        .app-todo .todo-now.is-active .todo-now__dot {
          background: var(--color-accent);
          border-color: var(--color-accent);
        }
        .app-todo .todo-item.done .todo-text {
          color: var(--color-ink-faint);
          text-decoration: line-through;
        }
      </style>
      <div class="block-header">
        <p class="block-header__label">Today</p>
        <div class="block-header__actions">
          <button class="zoom-button" type="button" aria-label="Expand Tasks"><span class="icon icon--zoom" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="todo-compose">
        <span class="todo-compose__plus" aria-hidden="true">+</span>
        <input type="text" class="add-todo-input" placeholder="Add task" aria-label="Add new task">
        <span class="keyhint" aria-hidden="true">Enter</span>
      </div>
      ${listHtml}
    `;

    if (typeof this.querySelectorAll === 'function') {
      const checkboxes = this.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
          const id = e.target.getAttribute('data-id');
          if (id) this.toggleTodo(id);
        });
      });
    }

    if (typeof this.querySelectorAll === 'function') {
      this.querySelectorAll('[data-action="toggle-active"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          this.toggleActive(id);
          // The list re-rendered; keep keyboard focus on the same toggle.
          const again = this.querySelector(`[data-action="toggle-active"][data-id="${CSS.escape(id)}"]`);
          if (again) again.focus();
        });
      });
    }

    if (typeof this.querySelector === 'function') {
      const addInput = this.querySelector('.add-todo-input');
      if (addInput) {
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && addInput.value) {
            this.addTodo(addInput.value);
            // addTodo re-renders, which replaces the input; keep typing focus.
            const freshInput = this.querySelector('.add-todo-input');
            if (freshInput) freshInput.focus();
          }
        });
      }
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-todo', TodoApp);
  } catch (e) {}
}
