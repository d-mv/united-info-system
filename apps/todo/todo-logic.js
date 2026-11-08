/**
 * Pure todo rules (no DOM, no storage) so they can be tested directly.
 */

/**
 * Move the task `id` so it sits just before `beforeId` (or last when
 * `beforeId` is null). Returns a new array; unknown ids leave the list as is.
 */
export function moveBefore(list, id, beforeId) {
  const from = list.findIndex(t => t.id === id);
  if (from === -1 || id === beforeId) return list;
  const rest = list.filter(t => t.id !== id);
  const to = beforeId === null ? rest.length : rest.findIndex(t => t.id === beforeId);
  if (to === -1) return list;
  return [...rest.slice(0, to), list[from], ...rest.slice(to)];
}

/**
 * Move `id` one step up (-1) or down (+1) among the `visibleIds` (the tasks
 * on screen; hidden completed tasks don't count as steps).
 */
export function moveStep(list, id, step, visibleIds) {
  const at = visibleIds.indexOf(id);
  if (at === -1) return list;
  const target = at + step;
  if (target < 0 || target >= visibleIds.length) return list;
  if (step < 0) return moveBefore(list, id, visibleIds[target]);
  // Moving down: go before the task after the neighbour, or last.
  const after = visibleIds[target + 1];
  return moveBefore(list, id, after === undefined ? null : after);
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 'overdue' | 'today' | 'upcoming' for a YYYY-MM-DD due date, or null when there is none. */
export function dueStatus(due, today) {
  if (!due || !DAY.test(due)) return null;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short label for a due date: "Today", "Tomorrow", "12 Nov", or "12 Nov 2027" outside this year. */
export function dueLabel(due, today) {
  if (!due || !DAY.test(due)) return '';
  if (due === today) return 'Today';
  const [y, m, d] = due.split('-').map(Number);
  const t = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1);
  if (due === isoDay(t)) return 'Tomorrow';
  const base = `${d} ${MONTHS[m - 1]}`;
  return String(y) === today.slice(0, 4) ? base : `${base} ${y}`;
}

/** A valid YYYY-MM-DD string, or null (clears the due date). */
export function normalizeDue(value) {
  const v = String(value || '').trim();
  return DAY.test(v) ? v : null;
}
