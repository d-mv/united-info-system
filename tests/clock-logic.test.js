import { test } from 'node:test';
import assert from 'node:assert';
import {
  alarmDue,
  armAlarm,
  timerRemaining,
  startTimer,
  pauseTimer,
  resetTimer,
  timerFinished,
  formatCountdown,
  localDateKey,
  msUntilAlarm,
  formatTimeLeft,
} from '../apps/clock/clock-logic.js';

// 2026-10-29 07:30:00 local time
const at = (h, m, s = 0) => new Date(2026, 9, 29, h, m, s).getTime();

test('alarm fires at its time and only once per day', () => {
  const alarm = { time: '07:30', enabled: true, lastFiredDate: null };
  assert.strictEqual(alarmDue(alarm, at(7, 29, 59)), false);
  assert.strictEqual(alarmDue(alarm, at(7, 30, 0)), true);
  assert.strictEqual(alarmDue({ ...alarm, lastFiredDate: localDateKey(at(7, 30)) }, at(7, 30, 5)), false);
});

test('alarm still fires if the tab was throttled for a few minutes, but not hours later', () => {
  const alarm = { time: '07:30', enabled: true, lastFiredDate: null };
  assert.strictEqual(alarmDue(alarm, at(7, 34, 0)), true);
  assert.strictEqual(alarmDue(alarm, at(9, 0, 0)), false);
});

test('disabled or malformed alarm never fires', () => {
  assert.strictEqual(alarmDue({ time: '07:30', enabled: false }, at(7, 30)), false);
  assert.strictEqual(alarmDue({ time: '', enabled: true }, at(7, 30)), false);
  assert.strictEqual(alarmDue(null, at(7, 30)), false);
});

test('arming an alarm for a time already passed today waits until tomorrow', () => {
  const armed = armAlarm('07:30', at(7, 31));
  assert.strictEqual(armed.enabled, true);
  assert.strictEqual(alarmDue(armed, at(7, 32)), false);

  const armedEarly = armAlarm('07:30', at(7, 0));
  assert.strictEqual(alarmDue(armedEarly, at(7, 30)), true);
});

test('timer counts down from start, pauses and resets', () => {
  const t0 = at(10, 0, 0);
  let timer = startTimer(resetTimer(5 * 60 * 1000), t0);
  assert.strictEqual(timer.state, 'running');
  assert.strictEqual(timerRemaining(timer, t0 + 1000), 299000);

  timer = pauseTimer(timer, t0 + 60000);
  assert.strictEqual(timer.state, 'paused');
  assert.strictEqual(timerRemaining(timer, t0 + 600000), 240000, 'paused time does not move');

  timer = startTimer(timer, t0 + 600000);
  assert.strictEqual(timerRemaining(timer, t0 + 660000), 180000, 'resume continues from paused value');

  timer = resetTimer(timer.durationMs);
  assert.strictEqual(timer.state, 'idle');
  assert.strictEqual(timerRemaining(timer, t0), 300000);
});

test('timer finishes at zero and never goes negative', () => {
  const t0 = at(10, 0, 0);
  const timer = startTimer(resetTimer(10000), t0);
  assert.strictEqual(timerFinished(timer, t0 + 9999), false);
  assert.strictEqual(timerFinished(timer, t0 + 10000), true);
  assert.strictEqual(timerRemaining(timer, t0 + 50000), 0);
});

test('countdown formats as MM:SS, or H:MM:SS above an hour, rounding up', () => {
  assert.strictEqual(formatCountdown(299001), '05:00');
  assert.strictEqual(formatCountdown(59000), '00:59');
  assert.strictEqual(formatCountdown(0), '00:00');
  assert.strictEqual(formatCountdown(3723000), '1:02:03');
});

test('time until alarm counts to today, or to tomorrow once passed or already rung', () => {
  const alarm = { time: '07:30', enabled: true, lastFiredDate: null };
  assert.strictEqual(msUntilAlarm(alarm, at(5, 0)), (2 * 60 + 30) * 60000);
  assert.strictEqual(msUntilAlarm(alarm, at(8, 0)), (23 * 60 + 30) * 60000);
  assert.strictEqual(
    msUntilAlarm({ ...alarm, lastFiredDate: localDateKey(at(7, 30)) }, at(7, 30, 30)),
    24 * 3600000 - 30000,
    'rang today -> next is tomorrow'
  );
  assert.strictEqual(msUntilAlarm({ ...alarm, enabled: false }, at(5, 0)), null);
  assert.strictEqual(msUntilAlarm({ time: 'bad', enabled: true }, at(5, 0)), null);
});

test('time left formats as hours and minutes, rounding up to the minute', () => {
  assert.strictEqual(formatTimeLeft((9 * 60 + 12) * 60000), '9h 12m');
  assert.strictEqual(formatTimeLeft(9 * 3600000), '9h 0m');
  assert.strictEqual(formatTimeLeft(12 * 60000 + 1), '13m');
  assert.strictEqual(formatTimeLeft(30000), '1m');
  assert.strictEqual(formatTimeLeft(0), '0m');
});

// 2026-10-29 is a Thursday (getDay() === 4).
import { alarmOnDay, nextAlarm, formatDays, nextPomodoro, pomodoroLabel, POMODORO, zoneTime, zoneName, zoneOffsetLabel, isValidZone } from '../apps/clock/clock-logic.js';

test('weekday alarms ring only on their days', () => {
  const thuOnly = { time: '07:30', enabled: true, lastFiredDate: null, days: [4] };
  const friOnly = { ...thuOnly, days: [5] };
  assert.strictEqual(alarmDue(thuOnly, at(7, 30)), true);
  assert.strictEqual(alarmDue(friOnly, at(7, 30)), false);
  assert.strictEqual(alarmOnDay({ days: [] }, 0), true, 'no days = every day');
});

test('time until a weekday alarm skips to its next day', () => {
  const friOnly = { time: '07:30', enabled: true, lastFiredDate: null, days: [5] };
  assert.strictEqual(msUntilAlarm(friOnly, at(8, 0)), (23 * 60 + 30) * 60000, 'Thu 08:00 -> Fri 07:30');
  const thuOnly = { ...friOnly, days: [4] };
  // Calendar arithmetic, so a DST change during that week (e.g. US, 1 Nov) is accounted for.
  assert.strictEqual(msUntilAlarm(thuOnly, at(8, 0)), new Date(2026, 9, 29 + 7, 7, 30).getTime() - at(8, 0), 'passed today -> next week');
});

test('arming a weekday alarm passed today on another weekday does not block today', () => {
  const armed = armAlarm('07:30', at(8, 0), [5]);
  assert.strictEqual(armed.lastFiredDate, null, 'today is not one of its days, nothing to skip');
  assert.deepStrictEqual(armed.days, [5]);
  const today = armAlarm('07:30', at(8, 0), [4]);
  assert.strictEqual(today.lastFiredDate, localDateKey(at(8, 0)));
});

test('nextAlarm picks the enabled alarm that rings soonest', () => {
  const alarms = [
    { id: 'a', time: '09:00', enabled: true, days: [] },
    { id: 'b', time: '08:00', enabled: true, days: [] },
    { id: 'c', time: '07:45', enabled: false, days: [] },
  ];
  assert.strictEqual(nextAlarm(alarms, at(7, 0)).alarm.id, 'b');
  assert.strictEqual(nextAlarm([], at(7, 0)), null);
});

test('formatDays names common sets', () => {
  assert.strictEqual(formatDays([]), 'Daily');
  assert.strictEqual(formatDays([0, 1, 2, 3, 4, 5, 6]), 'Daily');
  assert.strictEqual(formatDays([1, 2, 3, 4, 5]), 'Weekdays');
  assert.strictEqual(formatDays([6, 0]), 'Weekends');
  assert.strictEqual(formatDays([5, 1, 3]), 'Mon Wed Fri');
});

test('pomodoro cycles focus/break and takes a long break after the last round', () => {
  let p = { phase: 'focus', round: 1 };
  const seen = [];
  for (let i = 0; i < 9; i++) { seen.push(`${p.phase}${p.round}`); p = nextPomodoro(p); }
  assert.deepStrictEqual(seen, ['focus1', 'break1', 'focus2', 'break2', 'focus3', 'break3', 'focus4', 'long4', 'focus1']);
  assert.strictEqual(POMODORO.focus, 25 * 60000);
  assert.strictEqual(pomodoroLabel({ phase: 'focus', round: 2 }), 'Focus 2/4');
  assert.strictEqual(pomodoroLabel({ phase: 'long', round: 4 }), 'Long break');
});

test('second time zone helpers', () => {
  const t = Date.UTC(2026, 9, 29, 12, 0, 0);
  assert.strictEqual(zoneTime(t, 'Asia/Tokyo'), '21:00');
  assert.strictEqual(zoneName('America/New_York'), 'New York');
  assert.strictEqual(zoneName('UTC'), 'UTC');
  assert.strictEqual(isValidZone('Europe/Berlin'), true);
  assert.strictEqual(isValidZone('Mars/Base'), false);
  assert.strictEqual(isValidZone(''), false);
  assert.strictEqual(zoneOffsetLabel(t, 'Asia/Kolkata', 'UTC'), '+5:30');
  assert.strictEqual(zoneOffsetLabel(t, 'America/New_York', 'UTC'), '−4h');
  assert.strictEqual(zoneOffsetLabel(t, 'UTC', 'UTC'), 'same time');
});
