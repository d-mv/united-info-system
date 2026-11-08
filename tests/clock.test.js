import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';

installBrowserGlobals();

test('ClockApp renders time and alarm/timer controls', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');

  const clock = new ClockApp();
  clock.storage = makeStorage();
  clock.querySelector = (selector) => (clock.innerHTML.includes('id="clock-text"') ? { textContent: '' } : null);
  clock.connectedCallback();
  assert.ok(clock.innerHTML.includes('Clock'));
  assert.ok(clock.innerHTML.includes('live-dot'));
  assert.ok(clock.innerHTML.includes('data-action="open-alarm"'), 'alarm control is rendered');
  assert.ok(clock.innerHTML.includes('data-action="open-timer"'), 'timer control is rendered');

  clock.disconnectedCallback();
});

test('A finishing timer waits until a ringing alarm is dismissed', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const now = Date.now();
  const clock = new ClockApp();
  clock.storage = makeStorage({
    clock: {
      alarm: { time: '07:00', enabled: true, lastFiredDate: null },
      timer: { state: 'running', durationMs: 60000, endsAt: now - 1000, remainingMs: null },
      ringing: { kind: 'alarm', label: 'Alarm · 07:00', since: now - 5000 },
    }
  });

  clock._tick();
  let state = clock.storage.get('clock');
  assert.strictEqual(state.ringing.kind, 'alarm', 'the alarm keeps ringing');
  assert.strictEqual(state.timer.state, 'running', 'the timer is not consumed yet');

  clock.storage.set('clock', { ...state, ringing: null }); // Dismiss
  clock._tick();
  state = clock.storage.get('clock');
  assert.strictEqual(state.ringing.kind, 'timer', 'then the timer rings');
});

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('an old single alarm becomes the first entry of the alarm list', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const clock = new ClockApp();
  clock.storage = makeStorage({ clock: { alarm: { time: '06:15', enabled: true, lastFiredDate: null } } });
  const { alarms } = clock.getState();
  assert.strictEqual(alarms.length, 1);
  assert.strictEqual(alarms[0].time, '06:15');
  assert.deepStrictEqual(alarms[0].days, []);
  assert.ok(alarms[0].id);

  const off = new ClockApp();
  off.storage = makeStorage({ clock: { alarm: { time: '07:00', enabled: false, lastFiredDate: null } } });
  assert.strictEqual(off.getState().alarms.length, 0, 'a switched-off default alarm is not carried over');
});

test('alarms can be added, switched off and on, and deleted', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const clock = new ClockApp();
  clock.storage = makeStorage();
  clock.addAlarm('08:00', [1, 2, 3, 4, 5]);
  clock.addAlarm('10:30', []);
  let { alarms } = clock.getState();
  assert.deepStrictEqual(alarms.map(a => a.time), ['08:00', '10:30'], 'sorted by time');
  clock.toggleAlarm(alarms[0].id);
  assert.strictEqual(clock.getState().alarms[0].enabled, false);
  clock.toggleAlarm(alarms[0].id);
  assert.strictEqual(clock.getState().alarms[0].enabled, true);
  clock.deleteAlarm(alarms[1].id);
  assert.deepStrictEqual(clock.getState().alarms.map(a => a.time), ['08:00']);
});

test('the alarm due now rings and is marked rung for today', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const now = Date.now();
  const clock = new ClockApp();
  clock.storage = makeStorage({ clock: { alarms: [
    { id: 'x', time: '23:59', enabled: true, days: [], lastFiredDate: null },
    { id: 'y', time: hhmm(now), enabled: true, days: [new Date(now).getDay()], lastFiredDate: null },
  ] } });
  clock._tick();
  const state = clock.storage.get('clock');
  assert.strictEqual(state.ringing.kind, 'alarm');
  assert.ok(state.ringing.label.includes(hhmm(now)));
  assert.ok(state.alarms.find(a => a.id === 'y').lastFiredDate, 'marked');
});

test('pomodoro: finishing focus rings and starts the break; reset ends it', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const clock = new ClockApp();
  clock.storage = makeStorage();
  clock.startPomodoro();
  let state = clock.storage.get('clock');
  assert.deepStrictEqual(state.pomodoro, { phase: 'focus', round: 1 });
  assert.strictEqual(state.timer.state, 'running');
  assert.strictEqual(state.timer.durationMs, 25 * 60000);

  clock.storage.set('clock', { ...state, timer: { ...state.timer, endsAt: Date.now() - 1 } });
  clock._tick();
  state = clock.storage.get('clock');
  assert.deepStrictEqual(state.pomodoro, { phase: 'break', round: 1 });
  assert.strictEqual(state.timer.state, 'running', 'break starts by itself');
  assert.strictEqual(state.timer.durationMs, 5 * 60000);
  assert.ok(/Focus 1\/4 done/.test(state.ringing.label), state.ringing.label);

  clock.resetTimerAndPomodoro();
  state = clock.storage.get('clock');
  assert.strictEqual(state.pomodoro, null);
  assert.strictEqual(state.timer.state, 'idle');
});

test('second time zone shows in the header and rejects unknown zones', async () => {
  const { ClockApp } = await import('../apps/clock/clock-app.js');
  const clock = new ClockApp();
  clock.storage = makeStorage();
  assert.strictEqual(clock.setZone('Mars/Base'), false);
  assert.strictEqual(clock.getState().zone, null);
  assert.strictEqual(clock.setZone('Asia/Tokyo'), true);
  clock.render();
  assert.ok(clock.innerHTML.includes('Tokyo'));
  assert.ok(clock.innerHTML.includes('data-action="open-zone"'));
  clock.setZone('');
  assert.strictEqual(clock.getState().zone, null, 'empty clears it');
});
