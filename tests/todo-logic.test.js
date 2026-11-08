import { test } from 'node:test';
import assert from 'node:assert';
import { moveBefore, moveStep, dueStatus, dueLabel, normalizeDue, isoDay } from '../apps/todo/todo-logic.js';

const list = ['a', 'b', 'c', 'd'].map(id => ({ id }));
const ids = (l) => l.map(t => t.id).join('');

test('moveBefore places a task before another, or last with null', () => {
  assert.strictEqual(ids(moveBefore(list, 'd', 'a')), 'dabc');
  assert.strictEqual(ids(moveBefore(list, 'a', 'c')), 'bacd');
  assert.strictEqual(ids(moveBefore(list, 'a', null)), 'bcda');
  assert.strictEqual(ids(moveBefore(list, 'b', 'b')), 'abcd', 'dropping on itself changes nothing');
  assert.strictEqual(ids(moveBefore(list, 'x', 'a')), 'abcd', 'unknown id');
  assert.strictEqual(ids(moveBefore(list, 'a', 'x')), 'abcd', 'unknown target');
});

test('moveBefore never loses or duplicates tasks', () => {
  for (const id of 'abcd') {
    for (const before of [...'abcd', null]) {
      const out = moveBefore(list, id, before);
      assert.strictEqual([...ids(out)].sort().join(''), 'abcd', `${id} before ${before}`);
    }
  }
});

test('moveStep moves among visible tasks, skipping hidden ones', () => {
  // b is hidden (completed), so moving c up lands it before a.
  const visible = ['a', 'c', 'd'];
  assert.strictEqual(ids(moveStep(list, 'c', -1, visible)), 'cabd');
  assert.strictEqual(ids(moveStep(list, 'a', +1, visible)), 'bcad');
  assert.strictEqual(ids(moveStep(list, 'd', +1, visible)), 'abcd', 'already last');
  assert.strictEqual(ids(moveStep(list, 'a', -1, visible)), 'abcd', 'already first');
});

test('dueStatus compares calendar days', () => {
  assert.strictEqual(dueStatus('2026-11-07', '2026-11-08'), 'overdue');
  assert.strictEqual(dueStatus('2026-11-08', '2026-11-08'), 'today');
  assert.strictEqual(dueStatus('2026-12-01', '2026-11-08'), 'upcoming');
  assert.strictEqual(dueStatus(null, '2026-11-08'), null);
  assert.strictEqual(dueStatus('soon', '2026-11-08'), null);
});

test('dueLabel is short and relative where it helps', () => {
  assert.strictEqual(dueLabel('2026-11-08', '2026-11-08'), 'Today');
  assert.strictEqual(dueLabel('2026-11-09', '2026-11-08'), 'Tomorrow');
  assert.strictEqual(dueLabel('2026-12-31', '2026-12-30'), 'Tomorrow');
  assert.strictEqual(dueLabel('2027-01-01', '2026-12-31'), 'Tomorrow', 'across a year');
  assert.strictEqual(dueLabel('2026-11-03', '2026-11-08'), '3 Nov');
  assert.strictEqual(dueLabel('2027-02-01', '2026-11-08'), '1 Feb 2027');
});

test('normalizeDue keeps valid dates only', () => {
  assert.strictEqual(normalizeDue('2026-11-08'), '2026-11-08');
  assert.strictEqual(normalizeDue(''), null);
  assert.strictEqual(normalizeDue('11/08/2026'), null);
});

test('isoDay uses the local calendar date', () => {
  assert.strictEqual(isoDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
