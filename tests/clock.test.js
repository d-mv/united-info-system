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
