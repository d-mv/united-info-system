import { test } from 'node:test';
import assert from 'node:assert';
import {
  addDays,
  weekdayOf,
  isIsoDate,
  localIso,
  localMs,
  occurrenceDates,
  occurrencesBetween,
  dayLabel,
  agenda,
  formatWhen,
  monthGrid,
  monthLabel,
  shiftMonth,
  reminderAt,
  dueReminders,
  pruneFired,
  normalizeEvent,
  mergeImported,
  removeSource,
  importedSources,
  upcomingOccurrences,
  describeRule,
  REMINDER_OPTIONS,
} from '../apps/calendar/calendar-logic.js';

const ev = (over = {}) => ({ id: 'e1', title: 'Standup', date: '2026-11-09', start: '10:00', end: null, reminder: null, source: 'local', ...over });
const dates = (event, from, to) => occurrenceDates(event, from, to);

test('date helpers work on calendar dates, independent of time zone', () => {
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2028-03-01', -1), '2028-02-29');
  assert.strictEqual(addDays('2026-03-29', 1), '2026-03-30', 'no DST drift');
  assert.strictEqual(weekdayOf('2026-11-08'), 0, 'Sunday');
  assert.strictEqual(weekdayOf('2026-11-09'), 1, 'Monday');
  assert.strictEqual(weekdayOf('1969-12-31'), 3, 'before 1970 is fine');
  assert.ok(isIsoDate('2026-02-28'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('26-1-1'));
  const at = new Date(2026, 10, 8, 23, 59).getTime();
  assert.strictEqual(localIso(at), '2026-11-08');
  assert.strictEqual(localMs('2026-11-08', '23:59'), at);
});

test('a single event occurs on its date only', () => {
  assert.deepStrictEqual(dates(ev(), '2026-11-01', '2026-11-30'), ['2026-11-09']);
  assert.deepStrictEqual(dates(ev(), '2026-11-10', '2026-11-30'), []);
});

test('daily rule with INTERVAL and COUNT', () => {
  const e = ev({ rrule: { freq: 'DAILY', interval: 2, count: 3 } });
  assert.deepStrictEqual(dates(e, '2026-11-01', '2026-12-31'), ['2026-11-09', '2026-11-11', '2026-11-13']);
});

test('daily rule far from its start jumps ahead and stays on the interval', () => {
  const e = ev({ date: '2020-01-01', rrule: { freq: 'DAILY', interval: 3 } });
  const got = dates(e, '2026-11-01', '2026-11-07');
  assert.ok(got.length >= 2);
  for (const d of got) {
    const diff = Math.round((Date.UTC(...d.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(2020, 0, 1)) / 86400000);
    assert.strictEqual(diff % 3, 0, d);
  }
});

test('weekly rule with BYDAY and INTERVAL, Monday week start', () => {
  // Starts Wed 11 Nov 2026; every 2 weeks on Mon, Wed, Fri.
  const e = ev({ date: '2026-11-11', rrule: { freq: 'WEEKLY', interval: 2, byday: [1, 3, 5] } });
  assert.deepStrictEqual(dates(e, '2026-11-01', '2026-11-30'), ['2026-11-11', '2026-11-13', '2026-11-23', '2026-11-25', '2026-11-27']);
});

test('weekly rule without BYDAY repeats on the start weekday; COUNT and EXDATE', () => {
  const e = ev({ rrule: { freq: 'WEEKLY', interval: 1, count: 3 }, exdates: ['2026-11-16'] });
  assert.deepStrictEqual(dates(e, '2026-11-01', '2026-12-31'), ['2026-11-09', '2026-11-23'], 'the excluded date still counts');
});

test('weekly rule jumps ahead for a long-running series', () => {
  const e = ev({ date: '2015-01-05', rrule: { freq: 'WEEKLY', interval: 1, byday: [1, 4] } });
  assert.deepStrictEqual(dates(e, '2026-11-09', '2026-11-15'), ['2026-11-09', '2026-11-12']);
});

test('monthly rule skips months without that day; UNTIL is inclusive', () => {
  const e = ev({ date: '2026-01-31', rrule: { freq: 'MONTHLY', interval: 1, until: '2026-05-31' } });
  assert.deepStrictEqual(dates(e, '2026-01-01', '2026-12-31'), ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('yearly rule on 29 February only in leap years', () => {
  const e = ev({ date: '2024-02-29', rrule: { freq: 'YEARLY', interval: 1 } });
  assert.deepStrictEqual(dates(e, '2024-01-01', '2032-12-31'), ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('occurrences are sorted: by date, all-day first, then by start time', () => {
  const list = [
    ev({ id: 'a', title: 'Late', start: '15:00' }),
    ev({ id: 'b', title: 'Holiday', start: null }),
    ev({ id: 'c', title: 'Early', start: '08:30' }),
    ev({ id: 'd', title: 'Earlier day', date: '2026-11-08', start: '20:00' }),
  ];
  const got = occurrencesBetween(list, '2026-11-01', '2026-11-30').map(o => o.event.id);
  assert.deepStrictEqual(got, ['d', 'b', 'c', 'a']);
});

test('day labels and agenda for the next days', () => {
  assert.strictEqual(dayLabel('2026-11-08', '2026-11-08'), 'Today');
  assert.strictEqual(dayLabel('2026-11-09', '2026-11-08'), 'Tomorrow');
  assert.strictEqual(dayLabel('2026-11-11', '2026-11-08'), 'Wed 11 Nov');
  const list = [ev({ date: '2026-11-08' }), ev({ id: 'x', date: '2026-11-12' }), ev({ id: 'far', date: '2026-11-20' })];
  const days = agenda(list, '2026-11-08', 7);
  assert.deepStrictEqual(days.map(d => d.label), ['Today', 'Thu 12 Nov']);
  assert.strictEqual(days[0].items[0].event.title, 'Standup');
});

test('formatWhen', () => {
  assert.strictEqual(formatWhen(ev({ start: null })), 'All day');
  assert.strictEqual(formatWhen(ev()), '10:00');
  assert.strictEqual(formatWhen(ev({ end: '11:30' })), '10:00–11:30');
});

test('month grid is Monday-first and covers whole weeks', () => {
  const weeks = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.strictEqual(weeks[0][0].date, '2026-10-26');
  assert.strictEqual(weeks[0][6].date, '2026-11-01');
  assert.strictEqual(weeks[0][0].inMonth, false);
  assert.strictEqual(weeks[0][6].inMonth, true);
  assert.strictEqual(weeks.length, 6);
  assert.ok(weeks.every(w => w.length === 7));
  assert.strictEqual(weeks.at(-1).at(-1).date, '2026-12-06');
  assert.strictEqual(monthGrid(2027, 1).length, 4, 'Feb 2027 starts on a Monday: four weeks');
  assert.strictEqual(monthLabel(2026, 10), 'November 2026');
  assert.deepStrictEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepStrictEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
});

test('reminder time: before the start; all-day events relative to 09:00', () => {
  assert.strictEqual(reminderAt(ev({ reminder: 15 }), '2026-11-09'), new Date(2026, 10, 9, 9, 45).getTime());
  assert.strictEqual(reminderAt(ev({ start: null, reminder: 0 }), '2026-11-09'), new Date(2026, 10, 9, 9, 0).getTime());
  assert.strictEqual(reminderAt(ev({ reminder: 1440 }), '2026-11-09'), new Date(2026, 10, 8, 10, 0).getTime());
  assert.strictEqual(reminderAt(ev(), '2026-11-09'), null);
});

test('due reminders: from the reminder time, within a 5-minute grace, once', () => {
  const list = [ev({ reminder: 15 })];
  const at = (h, m) => new Date(2026, 10, 9, h, m).getTime();
  assert.deepStrictEqual(dueReminders(list, at(9, 44), {}), []);
  const due = dueReminders(list, at(9, 45), {});
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].key, 'e1@2026-11-09');
  assert.strictEqual(due[0].at, at(9, 45));
  assert.strictEqual(dueReminders(list, at(9, 49), {}).length, 1);
  assert.deepStrictEqual(dueReminders(list, at(9, 50), {}), [], 'missed by more than the grace window');
  assert.deepStrictEqual(dueReminders(list, at(9, 46), { 'e1@2026-11-09': { at: at(9, 45) } }), [], 'already fired');
});

test('due reminders for a recurring event and a day-before reminder', () => {
  const weekly = ev({ id: 'w', date: '2026-01-05', start: '10:00', reminder: 5, rrule: { freq: 'WEEKLY', interval: 1 } });
  const dayBefore = ev({ id: 'd', date: '2026-11-10', start: '08:00', reminder: 1440 });
  const now = new Date(2026, 10, 9, 9, 56).getTime(); // Monday
  const keys = dueReminders([weekly], now, {}).map(r => r.key);
  assert.deepStrictEqual(keys, ['w@2026-11-09']);
  const tomorrow = dueReminders([dayBefore], new Date(2026, 10, 9, 8, 1).getTime(), {});
  assert.deepStrictEqual(tomorrow.map(r => r.key), ['d@2026-11-10']);
});

test('pruneFired drops entries older than two days', () => {
  const now = new Date(2026, 10, 9, 12, 0).getTime();
  const fired = { old: { at: now - 3 * 86400000 }, recent: { at: now - 3600000 } };
  assert.deepStrictEqual(Object.keys(pruneFired(fired, now)), ['recent']);
});

test('normalizeEvent validates and cleans input', () => {
  assert.strictEqual(normalizeEvent({ title: ' ', date: '2026-11-09', start: '10:00' }).ok, false);
  assert.strictEqual(normalizeEvent({ title: 'X', date: 'nope', start: '10:00' }).ok, false);
  assert.strictEqual(normalizeEvent({ title: 'X', date: '2026-11-09', start: '' }).ok, false, 'timed events need a start');
  const bad = normalizeEvent({ title: 'X', date: '2026-11-09', start: '10:00', end: '09:00' });
  assert.deepStrictEqual(bad, { ok: false, error: 'End must be after start.' });
  const allDay = normalizeEvent({ id: 'k', title: ' Trip ', date: '2026-11-09', allDay: true, start: '10:00', end: '11:00', reminder: '60', notes: '  ' });
  assert.deepStrictEqual(allDay, { ok: true, event: { id: 'k', title: 'Trip', date: '2026-11-09', start: null, end: null, reminder: 60, source: 'local' } });
  const weird = normalizeEvent({ title: 'X', date: '2026-11-09', start: '10:00', reminder: '7' });
  assert.strictEqual(weird.event.reminder, null, 'unknown reminder values become none');
  const kept = normalizeEvent({ title: 'X', date: '2026-11-09', start: '10:00', source: 'work.ics', uid: 'u1', rrule: { freq: 'DAILY', interval: 1 }, exdates: ['2026-11-10'], notes: 'Room 4' });
  assert.deepStrictEqual(kept.event.rrule, { freq: 'DAILY', interval: 1 });
  assert.strictEqual(kept.event.source, 'work.ics');
  assert.strictEqual(kept.event.uid, 'u1');
  assert.strictEqual(kept.event.notes, 'Room 4');
  assert.ok(REMINDER_OPTIONS.some(o => o.value === null) && REMINDER_OPTIONS.some(o => o.value === 1440));
});

test('mergeImported updates by UID, keeps ids and reminders, adds new ones', () => {
  const existing = [
    ev({ id: 'local1' }),
    ev({ id: 'imp1', uid: 'u1', title: 'Old', source: 'work.ics', reminder: 10 }),
  ];
  const imported = [
    { uid: 'u1', title: 'New', date: '2026-11-12', start: '09:00', end: null },
    { uid: 'u2', title: 'Fresh', date: '2026-11-13', start: null, end: null },
  ];
  let n = 0;
  const { list, added, updated } = mergeImported(existing, imported, 'work.ics', () => `new${++n}`);
  assert.strictEqual(added, 1);
  assert.strictEqual(updated, 1);
  assert.strictEqual(list.length, 3);
  const u1 = list.find(e => e.uid === 'u1');
  assert.strictEqual(u1.id, 'imp1');
  assert.strictEqual(u1.title, 'New');
  assert.strictEqual(u1.reminder, 10, 'a reminder set here survives a re-import');
  const u2 = list.find(e => e.uid === 'u2');
  assert.deepStrictEqual(u2, { id: 'new1', uid: 'u2', title: 'Fresh', date: '2026-11-13', start: null, end: null, reminder: null, source: 'work.ics' });
});

test('importedSources and removeSource', () => {
  const list = [ev(), ev({ id: 'a', source: 'work.ics' }), ev({ id: 'b', source: 'work.ics' }), ev({ id: 'c', source: 'family.ics' })];
  assert.deepStrictEqual(importedSources(list), [{ source: 'family.ics', count: 1 }, { source: 'work.ics', count: 2 }]);
  assert.deepStrictEqual(removeSource(list, 'work.ics').map(e => e.id), ['e1', 'c']);
});

test('upcoming occurrences skip what is over', () => {
  const now = new Date(2026, 10, 9, 12, 0).getTime();
  const list = [
    ev({ id: 'past', start: '10:00' }),
    ev({ id: 'running', start: '11:00', end: '13:00' }),
    ev({ id: 'later', start: '15:00' }),
    ev({ id: 'allday', start: null }),
    ev({ id: 'next', date: '2026-11-10' }),
  ];
  assert.deepStrictEqual(upcomingOccurrences(list, now, 30).map(o => o.event.id), ['allday', 'running', 'later', 'next']);
});

test('describeRule', () => {
  assert.strictEqual(describeRule({ freq: 'DAILY', interval: 1 }), 'Repeats daily');
  assert.strictEqual(describeRule({ freq: 'WEEKLY', interval: 2, byday: [1, 3] }), 'Repeats every 2 weeks on Mon, Wed');
  assert.strictEqual(describeRule({ freq: 'MONTHLY', interval: 1, count: 5 }), 'Repeats monthly · 5 times');
  assert.strictEqual(describeRule({ freq: 'YEARLY', interval: 1, until: '2030-01-01' }), 'Repeats yearly · until 2030-01-01');
});
