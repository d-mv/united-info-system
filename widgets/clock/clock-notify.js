/**
 * System notifications for the clock's alarm and timer.
 * localhost counts as a secure context, so the Notification API is available
 * when the dashboard is served by start.sh.
 */

// Same tag in every tab, so a notification fired by two tabs shows once.
const TAG = 'uis-clock';
let current = null;

function api() {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : null;
}

/** Ask once, from a click handler (browsers ignore prompts without a user gesture). */
export async function requestNotifyPermission() {
  const N = api();
  if (!N || N.permission !== 'default') return;
  try {
    await N.requestPermission();
  } catch (err) {
    // Older Safari uses a callback form; a missed prompt just means no notification.
  }
}

/** True when the user has turned notifications off for this site. */
export function notificationsBlocked() {
  const N = api();
  return !!N && N.permission === 'denied';
}

export function showRingNotification(ringing) {
  const N = api();
  if (!N || N.permission !== 'granted' || !ringing) return;
  closeRingNotification();
  try {
    current = new N(ringing.label, {
      body: ringing.kind === 'timer' ? 'Countdown finished.' : 'Open the dashboard to dismiss.',
      tag: TAG,
      requireInteraction: true,
    });
    current.onclick = () => {
      if (typeof window !== 'undefined' && window.focus) window.focus();
      closeRingNotification();
    };
  } catch (err) {
    console.warn('[clock] Notification failed:', err);
    current = null;
  }
}

export function closeRingNotification() {
  if (current) {
    current.close();
    current = null;
  }
}
