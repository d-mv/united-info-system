/**
 * iCalendar (.ics, RFC 5545) reader for the calendar app. Pure, no DOM.
 *
 * parseIcs(text, { zone }) -> { events, simplified }
 *   events: [{ uid, title, date, start, end, notes?, rrule?, exdates? }] in the calendar
 *   app's model, with times converted to wall-clock time in `zone` (default: this
 *   browser's zone). UTC (`Z`) and `TZID=` times are converted with Intl; floating
 *   times and unknown TZIDs (e.g. Windows zone names) are taken as already local.
 *   simplified: how many recurring events had rule parts this reader doesn't
 *   support; those keep their first occurrence only.
 */
import { addDays, dayNumber, weekdayOf } from './calendar-logic.js';

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const MAX_NOTES = 2000;
const pad = (n) => String(n).padStart(2, '0');

/** Lines with RFC 5545 folding undone (a line starting with a space or tab continues the previous one). */
export function unfoldLines(text) {
  const out = [];
  for (const line of String(text).split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** TEXT value escapes: \n \N \, \; \\. */
export function unescapeText(value) {
  return String(value).replace(/\\([nN,;\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

// 'NAME;P1=a;P2="b:c":value' -> { name, params, value }. Quoted parameter values may hold ':' and ';'.
function parseLine(line) {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [''];
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

// ---------- Time zones ----------

const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      f = null;
    }
    formatters.set(zone, f);
  }
  return formatters.get(zone);
}

// Wall-clock fields of instant `ms` in `zone`.
function wallIn(ms, zone) {
  const p = Object.fromEntries(formatter(zone).formatToParts(ms).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

const offsetAt = (ms, zone) => {
  const w = wallIn(ms, zone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
};

// Instant of wall time `w` in `zone` (a time skipped by a DST change lands an hour later).
function wallToInstant(w, zone) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const first = guess - offsetAt(guess, zone);
  const second = guess - offsetAt(first, zone);
  return second === first ? first : Math.max(first, second);
}

// Outlook writes '/mozilla.org/…/Europe/Berlin' style ids at times; try the tail too.
function knownZone(tzid) {
  if (!tzid) return null;
  if (formatter(tzid)) return tzid;
  const tail = tzid.split('/').slice(-2).join('/');
  return tail !== tzid && formatter(tail) ? tail : null;
}

/**
 * A DATE or DATE-TIME value as { date, time } in `zone` (time null for a date).
 * Returns null if the value can't be read.
 */
function readDateTime(value, params, zone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === 'DATE') return { date: `${y}-${mo}-${d}`, time: null };
  const wall = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +(s || 0) };
  let instant = null;
  if (z) instant = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  else {
    const from = knownZone(params.TZID);
    if (from) instant = wallToInstant(wall, from);
  }
  const out = instant === null || !formatter(zone) ? wall : wallIn(instant, zone);
  return { date: `${out.y}-${pad(out.mo)}-${pad(out.d)}`, time: `${pad(out.h)}:${pad(out.mi)}` };
}

// 'P1W', 'PT1H30M', 'P1DT2H' -> minutes (negative durations are ignored).
function durationMinutes(value) {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, w, d, h, mi] = m.map(v => Number(v) || 0);
  return ((w * 7 + d) * 24 + h) * 60 + mi;
}

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const fromMinutes = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// ---------- Recurrence ----------

/** RRULE value -> { rule, simplified }. A rule with parts this reader can't expand gives rule null. */
function readRule(value, start, params, zone) {
  const parts = {};
  for (const piece of String(value).split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).toUpperCase();
  }
  const fail = { rule: null, simplified: true };
  let freq = parts.FREQ;
  if (!FREQS.has(freq)) return fail;
  const rule = { freq, interval: Math.max(1, parseInt(parts.INTERVAL, 10) || 1) };
  const [, sm, sd] = start.date.split('-').map(Number);

  for (const [key, raw] of Object.entries(parts)) {
    if (key === 'FREQ' || key === 'INTERVAL') continue;
    if (key === 'COUNT') {
      const n = parseInt(raw, 10);
      if (!(n > 0)) return fail;
      rule.count = n;
    } else if (key === 'UNTIL') {
      // UNTIL is UTC (or a date) per RFC 5545; read it like DTSTART otherwise.
      const until = readDateTime(raw, /Z$/.test(raw) ? {} : params, zone);
      if (!until) return fail;
      // A last instance earlier in the day than the start time means the day before is the last.
      rule.until = until.time && start.time && until.time < start.time ? addDays(until.date, -1) : until.date;
    } else if (key === 'BYDAY') {
      const days = raw.split(',').map(d => DAYS[d]);
      if (days.some(d => d === undefined)) return fail; // '2TU', '-1FR': nth weekday of the month
      if (freq === 'DAILY' && rule.interval === 1) freq = rule.freq = 'WEEKLY'; // FREQ=DAILY;BYDAY=MO..FR
      if (freq !== 'WEEKLY') return fail;
      rule.byday = [...new Set(days)].sort((a, b) => a - b);
    } else if (key === 'WKST') {
      if (DAYS[raw] === undefined) return fail;
      if (raw !== 'MO') rule.wkst = DAYS[raw];
    } else if (key === 'BYMONTHDAY' && (freq === 'MONTHLY' || freq === 'YEARLY') && Number(raw) === sd) {
      // Same as DTSTART's day: nothing to add.
    } else if (key === 'BYMONTH' && freq === 'YEARLY' && Number(raw) === sm) {
      // Same as DTSTART's month.
    } else {
      return fail;
    }
  }
  if (rule.byday && rule.byday.length === 1 && rule.byday[0] === weekdayOf(start.date) && !rule.wkst) delete rule.byday;
  return { rule, simplified: false };
}

// ---------- Events ----------

function readEvent(props, zone) {
  const get = (name) => props.find(p => p.name === name);
  const dtstart = get('DTSTART');
  const start = dtstart && readDateTime(dtstart.value, dtstart.params, zone);
  if (!start) return null;

  const summary = get('SUMMARY');
  const event = {
    uid: '',
    title: (summary && unescapeText(summary.value).trim()) || '(No title)',
    date: start.date,
    start: start.time,
    end: null,
  };
  const uid = get('UID');
  event.uid = (uid && uid.value.trim()) || `${event.title}|${dtstart.value}`;

  const dtend = get('DTEND');
  const duration = get('DURATION');
  let spanDays = 0;
  if (dtend) {
    const end = readDateTime(dtend.value, dtend.params, zone);
    if (end && start.time && end.time && end.date === start.date && end.time > start.time) event.end = end.time;
    if (end && !start.time) spanDays = dayNumber(end.date) - dayNumber(start.date);
  } else if (duration) {
    const minutes = durationMinutes(duration.value);
    if (minutes && start.time && toMinutes(start.time) + minutes < 24 * 60) event.end = fromMinutes(toMinutes(start.time) + minutes);
    if (minutes && !start.time) spanDays = Math.floor(minutes / (24 * 60));
  }

  const description = get('DESCRIPTION');
  const notes = description ? unescapeText(description.value).trim().slice(0, MAX_NOTES) : '';
  if (notes) event.notes = notes;

  let simplified = false;
  const rrule = get('RRULE');
  if (rrule) {
    const read = readRule(rrule.value, start, dtstart.params, zone);
    if (read.rule) event.rrule = read.rule;
    simplified = read.simplified;
  } else if (spanDays > 1) {
    // A multi-day all-day event shows on each of its days.
    event.rrule = { freq: 'DAILY', interval: 1, count: spanDays };
  }

  const exdates = new Set();
  for (const p of props.filter(x => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const d = readDateTime(v, p.params, zone);
      if (d) exdates.add(d.date);
    }
  }
  if (event.rrule && exdates.size) event.exdates = [...exdates].sort();

  const status = get('STATUS');
  const rid = get('RECURRENCE-ID');
  return {
    event,
    simplified,
    cancelled: !!status && status.value.trim().toUpperCase() === 'CANCELLED',
    recurrenceDate: rid ? (readDateTime(rid.value, rid.params, zone) || {}).date || null : null,
  };
}

export function parseIcs(text, options = {}) {
  const zone = options.zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const read = [];
  const stack = [];
  let props = null;
  for (const line of unfoldLines(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      stack.push(p.value.trim().toUpperCase());
      if (stack[stack.length - 1] === 'VEVENT') props = [];
    } else if (p.name === 'END') {
      const closed = stack.pop();
      if (closed === 'VEVENT' && props) {
        const r = readEvent(props, zone);
        if (r) read.push(r);
        props = null;
      }
    } else if (props && stack[stack.length - 1] === 'VEVENT') {
      props.push(p); // properties of a nested VALARM are skipped
    }
  }

  // Moved or cancelled single occurrences (RECURRENCE-ID) come off their series.
  const masters = new Map(read.filter(r => !r.recurrenceDate).map(r => [r.event.uid, r.event]));
  const byUid = new Map();
  let simplified = 0;
  for (const r of read) {
    if (r.recurrenceDate) {
      const master = masters.get(r.event.uid);
      if (master && master.rrule) master.exdates = [...new Set([...(master.exdates || []), r.recurrenceDate])].sort();
      if (r.cancelled) continue;
      r.event.uid = `${r.event.uid}#${r.recurrenceDate}`;
      delete r.event.rrule;
      delete r.event.exdates;
    } else if (r.cancelled) {
      continue;
    }
    if (r.simplified) simplified++;
    byUid.set(r.event.uid, r.event); // a UID repeated in one file: the last one wins
  }
  return { events: [...byUid.values()], simplified };
}
