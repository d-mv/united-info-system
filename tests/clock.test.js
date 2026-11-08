import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';

installBrowserGlobals();

test('ClockWidget defines static manifest and updates time', async () => {
  const { ClockWidget } = await import('../widgets/clock/clock-widget.js');

  assert.ok(ClockWidget.manifest);
  assert.strictEqual(ClockWidget.manifest.id, 'clock');
  assert.strictEqual(ClockWidget.manifest.type, 'widget');

  const clock = new ClockWidget();
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
  const { ClockWidget } = await import('../widgets/clock/clock-widget.js');
  const now = Date.now();
  const clock = new ClockWidget();
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
