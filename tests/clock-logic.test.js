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
} from '../widgets/clock/clock-logic.js';

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
