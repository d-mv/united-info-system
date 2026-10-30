/**
 * Alarm and countdown timer rules for the clock widget. Pure functions, no DOM.
 *
 * Alarm: { time: 'HH:MM', enabled: boolean, lastFiredDate: 'YYYY-MM-DD' | null }
 *   Rings once per day. `lastFiredDate` stops it ringing twice and is shared
 *   across tabs through storage.
 * Timer: { state: 'idle' | 'running' | 'paused', durationMs, endsAt, remainingMs }
 *   Running timers store an absolute end time, so reloads and other tabs agree.
 */

// Background tabs can be throttled to one tick per minute; ring if we're up to
// this late, but don't ring for an alarm missed hours ago.
const ALARM_GRACE_MS = 5 * 60 * 1000;

export function localDateKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function alarmTimeToday(time, now) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const d = new Date(now);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

export function alarmDue(alarm, now) {
  if (!alarm || !alarm.enabled) return false;
  const target = alarmTimeToday(alarm.time, now);
  if (target === null) return false;
  if (alarm.lastFiredDate === localDateKey(now)) return false;
  return now >= target && now < target + ALARM_GRACE_MS;
}

/** Enable an alarm. If its time already passed today, it first rings tomorrow. */
export function armAlarm(time, now) {
  const target = alarmTimeToday(time, now);
  const passed = target !== null && now >= target;
  return { time, enabled: true, lastFiredDate: passed ? localDateKey(now) : null };
}

/**
 * Milliseconds until the alarm next rings, or null if it's off or invalid.
 * Today's time if still ahead and not yet rung, otherwise the same time tomorrow.
 */
export function msUntilAlarm(alarm, now) {
  if (!alarm || !alarm.enabled) return null;
  const today = alarmTimeToday(alarm.time, now);
  if (today === null) return null;
  if (today > now && alarm.lastFiredDate !== localDateKey(now)) return today - now;
  // Step the calendar date rather than adding 24h, so DST changes stay correct.
  const next = new Date(today);
  next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

/** '9h 12m' or '13m'. Rounds up so it never shows 0m before the alarm. */
export function formatTimeLeft(ms) {
  const totalMin = Math.ceil(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function resetTimer(durationMs) {
  return { state: 'idle', durationMs, endsAt: null, remainingMs: durationMs };
}

export function startTimer(timer, now) {
  const remaining = timer.state === 'paused' ? timer.remainingMs : timer.durationMs;
  return { ...timer, state: 'running', endsAt: now + remaining, remainingMs: remaining };
}

export function pauseTimer(timer, now) {
  return { ...timer, state: 'paused', endsAt: null, remainingMs: timerRemaining(timer, now) };
}

export function timerRemaining(timer, now) {
  if (!timer) return 0;
  if (timer.state === 'running') return Math.max(0, timer.endsAt - now);
  return Math.max(0, timer.remainingMs ?? timer.durationMs ?? 0);
}

export function timerFinished(timer, now) {
  return !!timer && timer.state === 'running' && now >= timer.endsAt;
}

/** MM:SS, or H:MM:SS from one hour up. Rounds up so 00:00 shows only at the end. */
export function formatCountdown(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
