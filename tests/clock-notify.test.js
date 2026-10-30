import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

let created;
let requested;

class MockNotification {
  static permission = 'default';
  static async requestPermission() {
    requested += 1;
    MockNotification.permission = 'granted';
    return 'granted';
  }
  constructor(title, options) {
    this.title = title;
    this.options = options;
    this.closed = false;
    created.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  created = [];
  requested = 0;
  MockNotification.permission = 'default';
  globalThis.Notification = MockNotification;
});

test('asks for permission only while it is undecided', async () => {
  const { requestNotifyPermission } = await import('../widgets/clock/clock-notify.js');
  await requestNotifyPermission();
  assert.strictEqual(requested, 1);
  await requestNotifyPermission();
  assert.strictEqual(requested, 1, 'already granted: no second prompt');

  MockNotification.permission = 'denied';
  await requestNotifyPermission();
  assert.strictEqual(requested, 1, 'denied: never re-prompt');
});

test('shows one tagged notification when allowed, closes it on dismiss', async () => {
  const { showRingNotification, closeRingNotification } = await import('../widgets/clock/clock-notify.js');
  MockNotification.permission = 'granted';

  showRingNotification({ kind: 'alarm', label: 'Alarm · 07:30' });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].title, 'Alarm · 07:30');
  assert.strictEqual(created[0].options.tag, 'uis-clock', 'same tag so several tabs collapse into one');
  assert.strictEqual(created[0].options.requireInteraction, true);

  closeRingNotification();
  assert.strictEqual(created[0].closed, true);
});

test('does nothing without permission or without the Notification API', async () => {
  const { showRingNotification, requestNotifyPermission, notificationsBlocked } = await import('../widgets/clock/clock-notify.js');
  MockNotification.permission = 'denied';
  showRingNotification({ kind: 'timer', label: 'Timer done' });
  assert.strictEqual(created.length, 0);
  assert.strictEqual(notificationsBlocked(), true);

  delete globalThis.Notification;
  showRingNotification({ kind: 'timer', label: 'Timer done' });
  await requestNotifyPermission();
  assert.strictEqual(notificationsBlocked(), false, 'no API is not "blocked"');
});
