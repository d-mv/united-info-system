/**
 * Alarm and countdown timer rules for the clock widget. Pure functions, no DOM.
 *
 * Alarm: { id, time: 'HH:MM', enabled: boolean, days: number[], lastFiredDate: 'YYYY-MM-DD' | null }
 *   `days` are weekdays (0 = Sunday); empty means every day. Rings once per day. `lastFiredDate` stops it ringing twice and is shared
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

/** Does the alarm ring on weekday `day` (0 = Sunday)? No days set means every day. */
export function alarmOnDay(alarm, day) {
  const days = Array.isArray(alarm && alarm.days) ? alarm.days : [];
  return days.length === 0 || days.includes(day);
}

export function alarmDue(alarm, now) {
  if (!alarm || !alarm.enabled) return false;
  if (!alarmOnDay(alarm, new Date(now).getDay())) return false;
  const target = alarmTimeToday(alarm.time, now);
  if (target === null) return false;
  if (alarm.lastFiredDate === localDateKey(now)) return false;
  return now >= target && now < target + ALARM_GRACE_MS;
}

/** Enable an alarm. If its time already passed today, it doesn't ring until its next day. */
export function armAlarm(time, now, days = []) {
  const target = alarmTimeToday(time, now);
  const alarm = { time, enabled: true, days: [...days].sort((a, b) => a - b), lastFiredDate: null };
  const passed = target !== null && now >= target && alarmOnDay(alarm, new Date(now).getDay());
  if (passed) alarm.lastFiredDate = localDateKey(now);
  return alarm;
}

/**
 * Milliseconds until the alarm next rings, or null if it's off or invalid.
 * Today's time if still ahead and not yet rung, otherwise the same time tomorrow.
 */
export function msUntilAlarm(alarm, now) {
  if (!alarm || !alarm.enabled) return null;
  const today = alarmTimeToday(alarm.time, now);
  if (today === null) return null;
  if (today > now && alarm.lastFiredDate !== localDateKey(now) && alarmOnDay(alarm, new Date(now).getDay())) {
    return today - now;
  }
  // Step the calendar date rather than adding 24h, so DST changes stay correct.
  for (let offset = 1; offset <= 7; offset++) {
    const next = new Date(today);
    next.setDate(next.getDate() + offset);
    if (alarmOnDay(alarm, next.getDay())) return next.getTime() - now;
  }
  return null;
}

/** The enabled alarm that rings soonest, as { alarm, ms }, or null. */
export function nextAlarm(alarms, now) {
  let best = null;
  for (const alarm of alarms || []) {
    const ms = msUntilAlarm(alarm, now);
    if (ms !== null && (!best || ms < best.ms)) best = { alarm, ms };
  }
  return best;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const dayName = (d) => DAY_NAMES[d];

/** 'Daily', 'Weekdays', 'Weekends' or the days Monday first ('Mon Wed Fri'). */
export function formatDays(days) {
  const set = new Set(days || []);
  if (set.size === 0 || set.size === 7) return 'Daily';
  const key = WEEK_ORDER.filter(d => set.has(d)).join('');
  if (key === '12345') return 'Weekdays';
  if (key === '60') return 'Weekends';
  return WEEK_ORDER.filter(d => set.has(d)).map(dayName).join(' ');
}

// ---------- Pomodoro ----------
// { phase: 'focus' | 'break' | 'long', round: 1..rounds }; durations are fixed.
export const POMODORO = { focus: 25 * 60000, break: 5 * 60000, long: 15 * 60000, rounds: 4 };

export function nextPomodoro({ phase, round }) {
  if (phase === 'focus') return round >= POMODORO.rounds ? { phase: 'long', round } : { phase: 'break', round };
  if (phase === 'break') return { phase: 'focus', round: round + 1 };
  return { phase: 'focus', round: 1 };
}

export function pomodoroLabel({ phase, round }) {
  if (phase === 'focus') return `Focus ${round}/${POMODORO.rounds}`;
  return phase === 'long' ? 'Long break' : 'Break';
}

// ---------- Second time zone ----------

export function isValidZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 'HH:MM' (24h) in `zone`. */
export function zoneTime(now, zone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** 'America/New_York' -> 'New York'. */
export function zoneName(zone) {
  return String(zone).split('/').pop().replace(/_/g, ' ');
}

// Minutes `zone` is ahead of UTC at `now`.
function zoneOffsetMin(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((asUtc - Math.floor(now / 60000) * 60000) / 60000);
}

/** Difference from the local zone: '+5:30', '−4h', 'same time'. */
export function zoneOffsetLabel(now, zone, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const diff = zoneOffsetMin(now, zone) - zoneOffsetMin(now, localZone);
  if (diff === 0) return 'same time';
  const sign = diff > 0 ? '+' : '−';
  const h = Math.floor(Math.abs(diff) / 60);
  const m = Math.abs(diff) % 60;
  return m ? `${sign}${h}:${String(m).padStart(2, '0')}` : `${sign}${h}h`;
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
