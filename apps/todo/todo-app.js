import { storage } from '../../core/storage.js';

export const DEFAULT_TODOS = [
  { id: 't1', text: 'Finish grid engine placement logic', done: false, active: true },
  { id: 't2', text: 'Wire up weather stale-while-revalidate', done: false },
  { id: 't3', text: 'Review theme.css contrast on mobile', done: false },
  { id: 't4', text: 'Draft serve.rb', done: true },
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
      if (t.id === id) return { ...t, done: !t.done };
      return t;
    });
    this.storage.set('app:todo', todos);
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

    const itemsHtml = todos.map(item => `
      <li class="${item.done ? 'done' : ''}">
        ${item.active && !item.done ? '<span class="live-dot" aria-hidden="true"></span>' : ''}
        <input type="checkbox" id="todo-${item.id}" data-id="${item.id}" ${item.done ? 'checked' : ''}>
        <label for="todo-${item.id}"><span>${item.text}</span></label>
      </li>
    `).join('');

    this.innerHTML = `
      <style>
        .app-todo ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .app-todo li {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .app-todo input[type="checkbox"] {
          accent-color: var(--color-accent);
          width: 14px;
          height: 14px;
          flex: none;
          cursor: pointer;
        }
        .app-todo li.done span {
          color: var(--color-text-muted);
          text-decoration: line-through;
        }
        .app-todo .add-todo-input {
          background: transparent;
          border: none;
          border-bottom: 1px solid var(--color-hairline);
          color: var(--color-text);
          font-family: var(--font-body);
          font-size: var(--text-size-body);
          padding: 4px 0;
          margin-bottom: 12px;
          width: 100%;
          outline: none;
        }
        .app-todo .add-todo-input::placeholder {
          color: var(--color-text-muted);
          font-size: var(--text-size-label);
          letter-spacing: var(--text-tracking-label);
          text-transform: uppercase;
        }
      </style>
      <p class="label">Today</p>
      <button class="zoom-button" type="button" aria-label="Expand Tasks"><img src="assets/zoom_icon.svg" alt="Zoom" /></button>
      <input type="text" class="add-todo-input" placeholder="+ Add task..." aria-label="Add new task">
      <ul>
        ${itemsHtml}
      </ul>
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

    if (typeof this.querySelector === 'function') {
      const addInput = this.querySelector('.add-todo-input');
      if (addInput) {
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && addInput.value) {
            this.addTodo(addInput.value);
            addInput.value = '';
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
