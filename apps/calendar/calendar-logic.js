/**
 * Calendar rules. Pure functions, no DOM.
 *
 * Event: { id, title, date: 'YYYY-MM-DD', start: 'HH:MM' | null (null = all day),
 *          end: 'HH:MM' | null, reminder: minutes before | null, notes?, rrule?, exdates?,
 *          source: 'local' | <import file name>, uid? }
 * Times are local wall-clock. Calendar-date arithmetic runs on day numbers
 * (days since 1970-01-01, via Date.UTC), so it never drifts across DST changes.
 *
 * rrule: { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, count?, until?: 'YYYY-MM-DD' (inclusive),
 *          byday?: weekday numbers (0 = Sunday, WEEKLY only), wkst?: weekday the week starts on (default Monday) }
 * Occurrences are expanded on the fly for the range asked for, never stored.
 * An occurrence is keyed by its date: `${event.id}@${date}`.
 */

const DAY_MS = 86400000;
// Reminder fires up to this late (background tabs can be throttled to one tick a minute).
export const REMINDER_GRACE_MS = 5 * 60 * 1000;
// All-day events have no start time; their reminder counts back from this local time.
export const ALL_DAY_REMINDER_TIME = '09:00';
const FIRED_MAX_AGE_MS = 2 * DAY_MS;
// Safety net against a malformed rule spinning forever.
const MAX_STEPS = 50000;

export const REMINDER_OPTIONS = [
  { value: null, label: 'None' },
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min before' },
  { value: 10, label: '10 min before' },
  { value: 15, label: '15 min before' },
  { value: 30, label: '30 min before' },
  { value: 60, label: '1 hour before' },
  { value: 1440, label: '1 day before' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = WEEKDAYS;

const pad = (n) => String(n).padStart(2, '0');
const parseIso = (iso) => iso.split('-').map(Number);

// ---------- Dates ----------

export function dayNumber(iso) {
  const [y, m, d] = parseIso(iso);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(n) {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const isoDate = (year, month0, day) => fromDayNumber(Math.round(Date.UTC(year, month0, day) / DAY_MS));
export const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);
/** 0 = Sunday. 1970-01-01 was a Thursday. */
export const weekdayOf = (iso) => (((dayNumber(iso) + 4) % 7) + 7) % 7;
const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = parseIso(value);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m - 1);
}

export function isTime(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(value || '');
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** Local calendar date of an instant. */
export function localIso(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Instant of a local date and 'HH:MM'. */
export function localMs(iso, time = '00:00') {
  const [y, m, d] = parseIso(iso);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime();
}

// ---------- Recurrence ----------

/** Dates (ascending) on which `event` occurs within [from, to], both 'YYYY-MM-DD' inclusive. */
export function occurrenceDates(event, from, to) {
  const start = event.date;
  if (!isIsoDate(start) || from > to) return [];
  const excluded = new Set(event.exdates || []);
  const out = [];
  const rule = event.rrule;
  if (!rule) {
    if (start >= from && start <= to && !excluded.has(start)) out.push(start);
    return out;
  }
  const last = rule.until && rule.until < to ? rule.until : to;
  const count = rule.count > 0 ? rule.count : Infinity;
  let made = 0;
  for (const date of candidates(event, from)) {
    if (date > last || made >= count) break;
    made++;
    if (date >= from && !excluded.has(date)) out.push(date);
  }
  return out;
}

// Dates a rule produces, in order, starting from the series start (or, when
// nothing has to be counted, from close to `from`).
function* candidates(event, from) {
  const rule = event.rrule;
  const interval = Math.max(1, Math.floor(rule.interval) || 1);
  const startN = dayNumber(event.date);
  const fromN = dayNumber(from);
  const canSkip = !(rule.count > 0);
  const [sy, sm, sd] = parseIso(event.date);
  let steps = 0;

  if (rule.freq === 'DAILY') {
    let k = canSkip ? Math.max(0, Math.floor((fromN - startN) / interval)) : 0;
    while (steps++ < MAX_STEPS) yield fromDayNumber(startN + (k++) * interval);
    return;
  }
  if (rule.freq === 'WEEKLY') {
    const wkst = Number.isInteger(rule.wkst) ? rule.wkst : 1;
    const startDay = weekdayOf(event.date);
    const days = (Array.isArray(rule.byday) && rule.byday.length ? rule.byday : [startDay])
      .map(d => (d - wkst + 7) % 7)
      .sort((a, b) => a - b);
    const week0 = startN - ((startDay - wkst + 7) % 7);
    let w = canSkip ? Math.max(0, Math.floor((fromN - week0) / (7 * interval))) : 0;
    while (steps++ < MAX_STEPS) {
      const base = week0 + (w++) * 7 * interval;
      for (const offset of days) {
        const n = base + offset;
        if (n >= startN) yield fromDayNumber(n);
      }
    }
    return;
  }
  if (rule.freq === 'MONTHLY') {
    // Months without that day (31st, 30 Feb) are skipped, as RFC 5545 says.
    for (let k = 0; steps++ < MAX_STEPS; k++) {
      const months = (sm - 1) + k * interval;
      const y = sy + Math.floor(months / 12);
      const m = months % 12;
      if (sd <= daysInMonth(y, m)) yield isoDate(y, m, sd);
    }
    return;
  }
  if (rule.freq === 'YEARLY') {
    for (let k = 0; steps++ < MAX_STEPS; k++) {
      const y = sy + k * interval;
      if (sd <= daysInMonth(y, sm - 1)) yield isoDate(y, sm - 1, sd);
    }
    return;
  }
  yield event.date;
}

const startKey = (event) => (event.start ? `1${event.start}` : '0');

/** Every occurrence of `events` within [from, to]: [{ event, date }], by date, all-day first, then by time. */
export function occurrencesBetween(events, from, to) {
  const out = [];
  for (const event of events || []) {
    for (const date of occurrenceDates(event, from, to)) out.push({ event, date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)
    || startKey(a.event).localeCompare(startKey(b.event))
    || String(a.event.title).localeCompare(String(b.event.title)));
}

// ---------- Labels ----------

/** 'Wed 11 Nov'. */
export function shortDate(date) {
  const [, m, d] = parseIso(date);
  return `${WEEKDAYS[weekdayOf(date)]} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

/** 'Today', 'Tomorrow' or 'Wed 11 Nov'. */
export function dayLabel(date, today) {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return shortDate(date);
}

/** Days from `today` on (`days` of them) that have events: [{ date, label, items }]. */
export function agenda(events, today, days = 7) {
  const groups = new Map();
  for (const occ of occurrencesBetween(events, today, addDays(today, days - 1))) {
    if (!groups.has(occ.date)) groups.set(occ.date, []);
    groups.get(occ.date).push(occ);
  }
  return [...groups].map(([date, items]) => ({ date, label: dayLabel(date, today), items }));
}

export function formatWhen(event) {
  if (!event.start) return 'All day';
  return event.end ? `${event.start}–${event.end}` : event.start;
}

export const monthLabel = (year, month0) => `${MONTHS[month0]} ${year}`;

export function shiftMonth({ year, month }, delta) {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** Weeks (Monday first) covering the month: [[{ date, inMonth }, ×7], …]. */
export function monthGrid(year, month0) {
  const first = isoDate(year, month0, 1);
  const lead = (weekdayOf(first) + 6) % 7;
  const total = Math.ceil((lead + daysInMonth(year, month0)) / 7) * 7;
  const startN = dayNumber(first) - lead;
  const weeks = [];
  for (let i = 0; i < total; i++) {
    if (i % 7 === 0) weeks.push([]);
    const date = fromDayNumber(startN + i);
    weeks[weeks.length - 1].push({ date, inMonth: date.slice(0, 7) === first.slice(0, 7) });
  }
  return weeks;
}

const listDays = (days) => days
  .map(d => (d + 6) % 7).sort((a, b) => a - b).map(d => WEEKDAYS[(d + 1) % 7]).join(', ');

/** 'Repeats every 2 weeks on Mon, Wed · 5 times'. */
export function describeRule(rule) {
  if (!rule) return '';
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[rule.freq];
  const every = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[rule.freq];
  const interval = rule.interval > 1 ? rule.interval : 1;
  let text = interval > 1 ? `Repeats every ${interval} ${unit}s` : `Repeats ${every}`;
  if (rule.freq === 'WEEKLY' && Array.isArray(rule.byday) && rule.byday.length) text += ` on ${listDays(rule.byday)}`;
  if (rule.count > 0) text += ` · ${rule.count} times`;
  else if (rule.until) text += ` · until ${rule.until}`;
  return text;
}

// ---------- Reminders ----------

/** When the reminder for the occurrence on `date` goes off (ms), or null without a reminder. */
export function reminderAt(event, date) {
  if (event.reminder === null || event.reminder === undefined) return null;
  return localMs(date, event.start || ALL_DAY_REMINDER_TIME) - event.reminder * 60000;
}

export const occurrenceKey = (event, date) => `${event.id}@${date}`;

/**
 * Reminders that should go off at `now`: due, at most `grace` late, and not in `fired`
 * (the shared { key: { at, … } } map). [{ key, event, date, at }], earliest first.
 */
export function dueReminders(events, now, fired = {}, grace = REMINDER_GRACE_MS) {
  const today = localIso(now);
  // A reminder is at most a day early, so only occurrences around today can be due.
  const out = [];
  for (const { event, date } of occurrencesBetween(events, addDays(today, -1), addDays(today, 2))) {
    const at = reminderAt(event, date);
    const key = occurrenceKey(event, date);
    if (at !== null && now >= at && now < at + grace && !(fired && fired[key])) out.push({ key, event, date, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Drop fired entries older than two days. */
export function pruneFired(fired, now, maxAge = FIRED_MAX_AGE_MS) {
  const out = {};
  for (const [key, entry] of Object.entries(fired || {})) {
    if (entry && now - entry.at < maxAge) out[key] = entry;
  }
  return out;
}

/** Occurrences from now to `days` ahead that aren't over yet (timed events without an end are over once they start). */
export function upcomingOccurrences(events, now, days = 30) {
  const today = localIso(now);
  return occurrencesBetween(events, today, addDays(today, days)).filter(({ event, date }) => {
    if (!event.start) return true;
    const until = localMs(date, event.end || event.start);
    return event.end ? until > now : until >= now;
  });
}

// ---------- Editing ----------

const REMINDER_VALUES = new Set(REMINDER_OPTIONS.map(o => o.value).filter(v => v !== null));

/** Validate form input into an event: { ok: true, event } | { ok: false, error }. */
export function normalizeEvent(input) {
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: 'Add a title.' };
  if (!isIsoDate(input.date)) return { ok: false, error: 'Pick a date.' };
  const allDay = !!input.allDay || input.start === null;
  const start = allDay ? null : String(input.start || '');
  if (!allDay && !isTime(start)) return { ok: false, error: 'Set a start time, or make it all day.' };
  const end = allDay || !isTime(input.end) ? null : input.end;
  if (end && end <= start) return { ok: false, error: 'End must be after start.' };
  const minutes = input.reminder === null || input.reminder === '' || input.reminder === undefined ? null : Number(input.reminder);
  const event = {
    ...(input.id ? { id: input.id } : {}),
    title,
    date: input.date,
    start,
    end,
    reminder: REMINDER_VALUES.has(minutes) ? minutes : null,
    source: input.source || 'local',
  };
  if (input.uid) event.uid = input.uid;
  if (input.rrule) event.rrule = input.rrule;
  if (Array.isArray(input.exdates) && input.exdates.length) event.exdates = input.exdates;
  const notes = String(input.notes || '').trim();
  if (notes) event.notes = notes;
  return { ok: true, event };
}

// ---------- Import ----------

/**
 * Merge parsed .ics events into `events`. An imported event already here (same UID)
 * is updated in place, keeping its id and any reminder set here; new ones are added.
 */
export function mergeImported(events, imported, source, newId) {
  const byUid = new Map();
  events.forEach((e, i) => { if (e.uid && e.source !== 'local') byUid.set(e.uid, i); });
  const list = [...events];
  let added = 0;
  let updated = 0;
  for (const item of imported) {
    const fields = { uid: item.uid, title: item.title, date: item.date, start: item.start, end: item.end };
    if (item.notes) fields.notes = item.notes;
    if (item.rrule) fields.rrule = item.rrule;
    if (item.exdates && item.exdates.length) fields.exdates = item.exdates;
    if (byUid.has(item.uid)) {
      const i = byUid.get(item.uid);
      const { notes: _n, rrule: _r, exdates: _x, ...old } = list[i];
      list[i] = { ...old, ...fields, source };
      updated++;
    } else {
      byUid.set(item.uid, list.length);
      list.push({ id: newId(), ...fields, reminder: null, source });
      added++;
    }
  }
  return { list, added, updated };
}

/** Import sources and how many events each holds, by name. */
export function importedSources(events) {
  const counts = new Map();
  for (const e of events || []) {
    if (e.source && e.source !== 'local') counts.set(e.source, (counts.get(e.source) || 0) + 1);
  }
  return [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => a.source.localeCompare(b.source));
}

export const removeSource = (events, source) => (events || []).filter(e => e.source !== source);
