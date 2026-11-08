import { storage } from '../../core/storage.js';
import { escapeHtml, expandButton } from '../../core/html.js';
import { moveBefore, moveStep, dueStatus, dueLabel, normalizeDue, isoDay } from './todo-logic.js';

export const DEFAULT_TODOS = [
  { id: 't1', text: 'Finish grid engine placement logic', done: false, active: true },
  { id: 't2', text: 'Wire up weather stale-while-revalidate', done: false },
  { id: 't3', text: 'Review theme.css contrast on mobile', done: false },
  { id: 't4', text: 'Draft start.sh', done: true },
  { id: 't5', text: 'Pick accent color', done: true }
];

const VIEW_KEY = 'app:todo:view';

export class TodoApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.unsubscribes = [];
    // Id of the task whose edit form is open; while set, outside changes don't re-render.
    this.editingId = null;
    this.draggingId = null;
  }

  connectedCallback() {
    this.render();
    if (this.storage && this.storage.subscribe) {
      this.unsubscribes = [
        this.storage.subscribe('app:todo', () => this.onStoredChange()),
        this.storage.subscribe(VIEW_KEY, () => this.render()),
      ];
    }
  }

  disconnectedCallback() {
    this.unsubscribes.forEach(off => off && off());
    this.unsubscribes = [];
  }

  // Tasks changed (here or in another tab). Keep an open edit form and what is
  // typed in it, unless its task was deleted; closing the form re-renders.
  onStoredChange() {
    if (this.editingId && !this.getTodos().some(t => t.id === this.editingId)) this.editingId = null;
    if (this.editingId) return;
    this.render();
  }

  // View preference, kept apart from the task list. Completed tasks are hidden by default.
  getShowCompleted() {
    const view = this.storage.get(VIEW_KEY, null);
    return !!(view && view.showCompleted);
  }

  toggleShowCompleted() {
    this.storage.set(VIEW_KEY, { showCompleted: !this.getShowCompleted() });
    this.render();
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

  // Mark a task as in progress, or clear it. Any number of open tasks can be in progress.
  toggleActive(id) {
    const todos = this.getTodos();
    const target = todos.find(t => t.id === id);
    if (!target || target.done) return;
    this.storage.set('app:todo', todos.map(t => (t.id === id ? { ...t, active: !t.active } : t)));
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

  deleteTodo(id) {
    if (this.editingId === id) this.editingId = null;
    this.storage.set('app:todo', this.getTodos().filter(t => t.id !== id));
  }

  // Blank text keeps the old text; an empty or invalid date clears the due date.
  updateTodo(id, { text, due }) {
    const clean = typeof text === 'string' ? text.trim() : '';
    this.storage.set('app:todo', this.getTodos().map(t => (
      t.id === id ? { ...t, text: clean || t.text, due: normalizeDue(due) } : t
    )));
  }

  // Put task `id` before `beforeId` (null = last).
  moveTodo(id, beforeId) {
    const todos = this.getTodos();
    const moved = moveBefore(todos, id, beforeId);
    if (moved !== todos) this.storage.set('app:todo', moved);
  }

  startEdit(id) {
    this.editingId = id;
    this.render();
    const input = this.querySelector('.todo-edit-form .todo-edit-text');
    if (input && input.focus) input.focus();
  }

  stopEdit(focusId) {
    this.editingId = null;
    this.render();
    const btn = focusId && this.querySelector(`[data-action="edit"][data-id="${CSS.escape(focusId)}"]`);
    if (btn && btn.focus) btn.focus();
  }

  visibleIds() {
    const showCompleted = this.getShowCompleted();
    return this.getTodos().filter(t => showCompleted || !t.done).map(t => t.id);
  }

  render() {
    const todos = this.getTodos();
    const today = isoDay(new Date());
    const showCompleted = this.getShowCompleted();
    const doneCount = todos.filter(t => t.done).length;
    const visible = showCompleted ? todos : todos.filter(t => !t.done);

    const itemsHtml = visible.map(item => {
      const id = escapeHtml(item.id);
      const text = escapeHtml(item.text);
      const active = !!item.active && !item.done;
      const toggle = item.done ? '' : `
        <button type="button" class="todo-now${active ? ' is-active' : ''}" data-action="toggle-active" data-id="${id}"
          aria-pressed="${active}" aria-label="${active ? 'Stop working on' : 'Working on'} ${text}"
          title="${active ? 'In progress' : 'Mark in progress'}"><span class="todo-now__dot" aria-hidden="true"></span></button>`;
      if (this.editingId === item.id) {
        return `
      <li class="todo-item todo-item--editing">
        <form class="todo-edit-form" data-id="${id}">
          <input type="text" class="input todo-edit-text" value="${text}" aria-label="Task text" required>
          <label class="field todo-edit-due">
            <span class="label">Due</span>
            <input type="date" class="input todo-edit-date" value="${escapeHtml(item.due || '')}">
          </label>
          <div class="form-actions">
            <button type="button" class="action-button action-button--danger" data-action="delete" data-id="${id}">Delete</button>
            <span class="form-actions__spacer"></span>
            <button type="button" class="button-secondary" data-action="cancel-edit">Cancel</button>
            <button type="submit" class="button-primary">Save</button>
          </div>
        </form>
      </li>`;
      }
      const status = item.done ? null : dueStatus(item.due, today);
      const due = status ? `<span class="todo-due todo-due--${status}">${escapeHtml(dueLabel(item.due, today))}</span>` : '';
      return `
      <li class="todo-item${item.done ? ' done' : ''}${active ? ' is-active' : ''}" draggable="true" data-id="${id}">
        <button type="button" class="todo-grip" data-action="reorder" data-id="${id}" aria-label="Reorder ${text}" title="Drag, or use arrow keys"><span aria-hidden="true">⋮⋮</span></button>
        <input type="checkbox" class="todo-check" id="todo-${id}" data-id="${id}" ${item.done ? 'checked' : ''}>
        <label for="todo-${id}" class="todo-text">${text}</label>
        ${due}
        <button type="button" class="action-button todo-edit" data-action="edit" data-id="${id}" aria-label="Edit ${text}">Edit</button>
        ${toggle}
      </li>`;
    }).join('');

    let listHtml;
    if (visible.length) listHtml = `<ul class="todo-list">${itemsHtml}</ul>`;
    else if (doneCount) listHtml = '<p class="label empty-state">All done</p>';
    else listHtml = '<p class="label empty-state">Nothing to do</p>';

    const completedToggleHtml = doneCount ? `
      <button type="button" class="todo-completed-toggle" data-action="toggle-completed" aria-pressed="${showCompleted}">
        <span class="label">Completed · ${doneCount}</span>
        <span class="todo-completed-toggle__value">${showCompleted ? 'Hide' : 'Show'}</span>
      </button>` : '';

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
        .app-todo .todo-completed-toggle {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          height: 3.2rem;
          margin-top: auto;
          border-top: 1px solid var(--color-line);
        }
        .app-todo .todo-completed-toggle__value {
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-label);
          text-transform: uppercase;
          color: var(--color-ink-muted);
        }
        .app-todo .todo-completed-toggle:hover .todo-completed-toggle__value { color: var(--color-ink); }
        .app-todo .todo-grip,
        .app-todo .todo-edit {
          flex: none;
          opacity: 0;
          transition: opacity var(--duration) var(--ease);
        }
        .app-todo .todo-grip {
          width: 1.6rem;
          margin-right: -0.6rem;
          color: var(--color-ink-faint);
          font-size: var(--text-xs);
          letter-spacing: -0.2em;
          cursor: grab;
        }
        .app-todo .todo-item:hover .todo-grip,
        .app-todo .todo-item:hover .todo-edit,
        .app-todo .todo-grip:focus-visible,
        .app-todo .todo-edit:focus-visible { opacity: 1; }
        @media (hover: none) {
          .app-todo .todo-grip, .app-todo .todo-edit { opacity: 1; }
        }
        .app-todo .todo-item.is-dragging { opacity: 0.4; }
        .app-todo .todo-item.is-drop-target { box-shadow: inset 0 2px 0 var(--color-ink); }
        .app-todo .todo-due {
          flex: none;
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-meta);
          text-transform: uppercase;
          color: var(--color-ink-muted);
        }
        .app-todo .todo-due--today { color: var(--color-ink); }
        .app-todo .todo-due--overdue { color: var(--color-accent); }
        .app-todo .todo-item--editing { padding: 0.8rem 0; }
        .app-todo .todo-edit-form {
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
          width: 100%;
        }
        .app-todo .form-actions__spacer { flex: 1; }
        .app-todo .todo-item.done .todo-text {
          color: var(--color-ink-faint);
          text-decoration: line-through;
        }
      </style>
      <div class="block-header">
        <p class="block-header__label">Today</p>
        <div class="block-header__actions">
          ${expandButton('Tasks', !!this.classList?.contains('expanded'))}
        </div>
      </div>
      <div class="todo-compose">
        <span class="todo-compose__plus" aria-hidden="true">+</span>
        <input type="text" class="add-todo-input" placeholder="Add task" aria-label="Add new task">
        <span class="keyhint" aria-hidden="true">Enter</span>
      </div>
      ${listHtml}
      ${completedToggleHtml}
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

    const completedToggle = typeof this.querySelector === 'function' ? this.querySelector('[data-action="toggle-completed"]') : null;
    if (completedToggle && completedToggle.addEventListener) {
      completedToggle.addEventListener('click', () => {
        this.toggleShowCompleted();
        const again = this.querySelector('[data-action="toggle-completed"]');
        if (again) again.focus();
      });
    }

    this.bindEditing();
    this.bindReorder();

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

  bindEditing() {
    if (typeof this.querySelectorAll !== 'function') return;
    this.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => this.startEdit(btn.getAttribute('data-id')));
    });

    const form = this.querySelector('.todo-edit-form');
    if (!form) return;
    const id = form.getAttribute('data-id');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.editingId = null;
      this.updateTodo(id, {
        text: form.querySelector('.todo-edit-text').value,
        due: form.querySelector('.todo-edit-date').value,
      });
      this.stopEdit(id);
    });
    form.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => this.stopEdit(id));
    form.querySelector('[data-action="delete"]').addEventListener('click', () => {
      this.deleteTodo(id);
      this.stopEdit(null);
      const input = this.querySelector('.add-todo-input');
      if (input) input.focus();
    });
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // don't also collapse an expanded module
      this.stopEdit(id);
    });
  }

  // Drag a row to a new place, or focus its grip and press ArrowUp / ArrowDown.
  bindReorder() {
    if (typeof this.querySelectorAll !== 'function') return;
    this.querySelectorAll('[data-action="reorder"]').forEach(grip => {
      grip.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!step) return;
        e.preventDefault();
        const id = grip.getAttribute('data-id');
        const todos = this.getTodos();
        const moved = moveStep(todos, id, step, this.visibleIds());
        if (moved === todos) return;
        this.storage.set('app:todo', moved);
        const again = this.querySelector(`[data-action="reorder"][data-id="${CSS.escape(id)}"]`);
        if (again) again.focus();
      });
    });

    const clearTargets = () => this.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
    this.querySelectorAll('.todo-item[draggable="true"]').forEach(row => {
      const id = row.getAttribute('data-id');
      row.addEventListener('dragstart', (e) => {
        this.draggingId = id;
        row.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        }
      });
      row.addEventListener('dragend', () => {
        this.draggingId = null;
        row.classList.remove('is-dragging');
        clearTargets();
      });
      row.addEventListener('dragover', (e) => {
        if (!this.draggingId || this.draggingId === id) return;
        e.preventDefault();
        clearTargets();
        row.classList.add('is-drop-target');
      });
      row.addEventListener('drop', (e) => {
        if (!this.draggingId) return;
        e.preventDefault();
        const dragged = this.draggingId;
        this.draggingId = null;
        this.moveTodo(dragged, id);
      });
    });
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-todo', TodoApp);
  } catch (e) {}
}
