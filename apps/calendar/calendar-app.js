import { storage } from '../../core/storage.js';
import { escapeHtml, expandButton } from '../../core/html.js';
import { registerCommands } from '../../core/commands.js';
import { requestNotifyPermission, notificationsBlocked } from '../clock/clock-notify.js';
import {
  REMINDER_OPTIONS,
  WEEKDAY_NAMES,
  addDays,
  agenda,
  dayLabel,
  describeRule,
  dueReminders,
  formatWhen,
  importedSources,
  localIso,
  mergeImported,
  monthGrid,
  monthLabel,
  normalizeEvent,
  occurrencesBetween,
  pruneFired,
  removeSource,
  shiftMonth,
  shortDate,
  upcomingOccurrences,
} from './calendar-logic.js';
import { parseIcs } from './ics.js';

const EVENTS_KEY = 'app:calendar';
// { 'eventId@YYYY-MM-DD': { at, title, when, dismissed } }, shared by every tab so a reminder rings once.
const FIRED_KEY = 'app:calendar:fired';
const TICK_MS = 15 * 1000;
const RING_SOUND_MS = 30 * 1000;
const AGENDA_DAYS = 7;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PALETTE_DAYS = 30;
const PALETTE_LIMIT = 20;

const newId = () => 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cssValue = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));

// One AudioContext for the page. Browsers only allow sound after a user
// gesture, so it's created/resumed from clicks inside the module.
let audioCtx = null;
function unlockAudio() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  for (const offset of [0, 0.2, 0.4]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.1, t + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.15);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + offset);
    osc.stop(t + offset + 0.16);
  }
}

// System notification for one reminder; the tag is the same in every tab, so it shows once.
function showNotification(key, entry) {
  const N = typeof globalThis.Notification === 'function' ? globalThis.Notification : null;
  if (!N || N.permission !== 'granted') return null;
  try {
    const n = new N(entry.title, { body: entry.when, tag: `uis-calendar-${key}` });
    n.onclick = () => {
      if (typeof window !== 'undefined' && window.focus) window.focus();
      n.close();
    };
    return n;
  } catch (err) {
    console.warn('[calendar] Notification failed:', err);
    return null;
  }
}

export class CalendarApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.unsubscribes = [];
    // { id: string | null, date, values?, error? } while the event dialog is open.
    this.editor = null;
    this.returnFocus = null; // selector of what gets focus back when the dialog closes
    this.notice = null; // { text, error } result of the last import / remove
    this.selected = null; // 'YYYY-MM-DD' picked in the month grid (expanded)
    this.view = null; // { year, month } shown in the month grid
    this.renderedDay = null;
    this.ringUntil = 0;
    this.notifications = new Map();
    this._onClick = (e) => this.handleClick(e);
    this._onSubmit = (e) => this.handleSubmit(e);
    this._onChange = (e) => this.handleChange(e);
    this._onKeydown = (e) => this.handleKeydown(e);
    this._onCancel = (e) => {
      if (e.target && e.target.tagName === 'DIALOG') {
        e.preventDefault();
        this.closeEditor();
      }
    };
  }

  now() {
    return Date.now();
  }

  connectedCallback() {
    if (typeof this.addEventListener === 'function') {
      this.addEventListener('click', this._onClick);
      this.addEventListener('submit', this._onSubmit);
      this.addEventListener('change', this._onChange);
      this.addEventListener('keydown', this._onKeydown);
      // 'cancel' (Escape on a dialog) doesn't bubble; catch it on the way down.
      this.addEventListener('cancel', this._onCancel, true);
    }
    if (this.storage && this.storage.subscribe) {
      this.unsubscribes = [
        this.storage.subscribe(EVENTS_KEY, () => this.onStoredChange()),
        this.storage.subscribe(FIRED_KEY, () => this.onStoredChange()),
      ];
    }
    this.offCommands = registerCommands('calendar', () => this.commands());
    this.render();
    this._tick();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    this._interval = null;
    this.stopBeeping();
    if (typeof this.removeEventListener === 'function') {
      this.removeEventListener('click', this._onClick);
      this.removeEventListener('submit', this._onSubmit);
      this.removeEventListener('change', this._onChange);
      this.removeEventListener('keydown', this._onKeydown);
      this.removeEventListener('cancel', this._onCancel, true);
    }
    this.unsubscribes.forEach(off => off && off());
    this.unsubscribes = [];
    if (this.offCommands) this.offCommands();
  }

  // Events or reminders changed (here or in another tab). Never redraw over the
  // open dialog and lose what is typed in it; closing it re-renders.
  onStoredChange() {
    if (this.editor && this.editor.id && !this.getEvents().some(e => e.id === this.editor.id)) this.editor = null;
    if (this.editor) return;
    this.render();
  }

  commands() {
    const now = this.now();
    const today = localIso(now);
    return [
      { title: 'New event', keywords: 'calendar add event appointment', run: () => this.openEditor(null) },
      { title: 'Import calendar', keywords: 'calendar ics ical import file', run: () => this.pickFile() },
      ...upcomingOccurrences(this.getEvents(), now, PALETTE_DAYS).slice(0, PALETTE_LIMIT).map(({ event, date }) => ({
        title: `Event: ${event.title} · ${dayLabel(date, today)} ${formatWhen(event)}`,
        hint: 'Calendar',
        keywords: `${event.title} calendar`,
        run: () => this.openEditor(event.id, date),
      })),
    ];
  }

  // ---------- Data ----------

  getEvents() {
    const stored = this.storage ? this.storage.get(EVENTS_KEY, null) : null;
    return Array.isArray(stored) ? stored : [];
  }

  setEvents(list) {
    this.storage.set(EVENTS_KEY, list);
  }

  getFired() {
    const stored = this.storage ? this.storage.get(FIRED_KEY, null) : null;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  /** Create (no id) or update an event from form values. Returns { ok, error? }. */
  saveEvent(input) {
    const events = this.getEvents();
    const existing = input.id ? events.find(e => e.id === input.id) : null;
    const merged = existing
      ? { ...input, date: input.date || existing.date, source: existing.source, uid: existing.uid, rrule: existing.rrule, exdates: existing.exdates }
      : { ...input, id: null, source: 'local' };
    const result = normalizeEvent(merged);
    if (!result.ok) return result;
    const event = { ...result.event, id: existing ? existing.id : newId() };
    if (event.reminder !== null) requestNotifyPermission(); // user gesture: the Save click
    if (existing && (existing.date !== event.date || existing.start !== event.start || existing.reminder !== event.reminder)) {
      this.forgetFired(event.id); // moved or re-timed: its reminder may ring again
    }
    this.setEvents(existing ? events.map(e => (e.id === event.id ? event : e)) : [...events, event]);
    return { ok: true, event };
  }

  deleteEvent(id) {
    this.setEvents(this.getEvents().filter(e => e.id !== id));
  }

  forgetFired(id) {
    const fired = this.getFired();
    const kept = Object.fromEntries(Object.entries(fired).filter(([key]) => !key.startsWith(`${id}@`)));
    if (Object.keys(kept).length !== Object.keys(fired).length) this.storage.set(FIRED_KEY, kept);
  }

  /** Read an .ics file's text into the calendar under `name`. */
  importText(text, name, options = {}) {
    const source = String(name || 'Imported').trim() || 'Imported';
    let parsed;
    try {
      parsed = parseIcs(text, options);
    } catch (err) {
      console.warn('[calendar] import failed:', err);
      parsed = { events: [], simplified: 0 };
    }
    if (!parsed.events.length) {
      this.notice = { text: 'No events found in that file', error: true };
      this.render();
      return { ok: false, added: 0, updated: 0, simplified: 0 };
    }
    const { list, added, updated } = mergeImported(this.getEvents(), parsed.events, source, newId);
    const simplified = parsed.simplified;
    this.notice = {
      text: `Imported ${plural(added + updated, 'event')}${updated ? ` · ${updated} updated` : ''}`
        + `${simplified ? ` · ${plural(simplified, 'recurring rule')} simplified` : ''}`,
      error: false,
    };
    this.setEvents(list);
    this.render();
    this._tick();
    return { ok: true, added, updated, simplified };
  }

  async importFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      this.notice = { text: 'That file is too large (5 MB at most)', error: true };
      this.render();
      return;
    }
    try {
      this.importText(await file.text(), file.name);
    } catch (err) {
      this.notice = { text: 'Could not read that file', error: true };
      this.render();
    }
  }

  removeSource(source) {
    const before = this.getEvents();
    const list = removeSource(before, source);
    this.notice = { text: `Removed ${source} · ${plural(before.length - list.length, 'event')}`, error: false };
    this.setEvents(list);
    this.render();
  }

  pickFile() {
    const input = typeof this.querySelector === 'function' ? this.querySelector('.cal-import-input') : null;
    if (input && input.click) input.click();
  }

  // ---------- Reminders ----------

  _tick() {
    const now = this.now();
    if (localIso(now) !== this.renderedDay && !this.editor) this.render(); // past midnight
    const events = this.getEvents();
    if (!dueReminders(events, now, this.getFired()).length) return;
    // Read the shared set again right before writing, so two tabs don't both ring.
    const fired = pruneFired(this.getFired(), now);
    const due = dueReminders(events, now, fired);
    const today = localIso(now);
    for (const r of due) {
      fired[r.key] = { at: now, title: r.event.title, when: `${dayLabel(r.date, today)} · ${formatWhen(r.event)}`, dismissed: false };
    }
    this.storage.set(FIRED_KEY, fired);
    for (const r of due) {
      const n = showNotification(r.key, fired[r.key]);
      if (n) this.notifications.set(r.key, n);
    }
    this.startBeeping(now + RING_SOUND_MS);
  }

  ringing() {
    return Object.entries(this.getFired())
      .filter(([, entry]) => entry && !entry.dismissed)
      .sort((a, b) => a[1].at - b[1].at)
      .map(([key, entry]) => ({ key, ...entry }));
  }

  startBeeping(until) {
    this.ringUntil = until;
    if (this._beepTimer || typeof setInterval !== 'function') return;
    beep();
    this._beepTimer = setInterval(() => {
      if (this.now() >= this.ringUntil || !this.ringing().length) return this.stopBeeping();
      beep();
    }, 1500);
  }

  stopBeeping() {
    clearInterval(this._beepTimer);
    this._beepTimer = null;
  }

  dismiss(key) {
    const fired = this.getFired();
    if (fired[key]) this.storage.set(FIRED_KEY, { ...fired, [key]: { ...fired[key], dismissed: true } });
    const n = this.notifications.get(key);
    if (n) n.close();
    this.notifications.delete(key);
    if (!this.ringing().length) this.stopBeeping();
    this.render();
  }

  // ---------- Month view ----------

  today() {
    return localIso(this.now());
  }

  viewMonth() {
    if (!this.view) {
      const [y, m] = (this.selected || this.today()).split('-').map(Number);
      this.view = { year: y, month: m - 1 };
    }
    return this.view;
  }

  shiftView(delta) {
    this.view = shiftMonth(this.viewMonth(), delta);
    this.render();
  }

  goToday() {
    this.selected = this.today();
    this.view = null;
    this.render();
  }

  selectDay(date, { focus = false } = {}) {
    this.selected = date;
    const [y, m] = date.split('-').map(Number);
    const view = this.viewMonth();
    if (view.year !== y || view.month !== m - 1) this.view = { year: y, month: m - 1 };
    this.render();
    if (focus) this.focus(`.cal-cell[data-date="${cssValue(date)}"]`);
  }

  // ---------- Dialog ----------

  openEditor(id, date) {
    const event = id ? this.getEvents().find(e => e.id === id) : null;
    if (id && !event) return;
    const expanded = !!this.classList?.contains('expanded');
    this.editor = { id: event ? event.id : null, date: date || (expanded && this.selected) || this.today() };
    if (!this.returnFocus) this.returnFocus = '[data-action="new-event"]';
    this.render();
  }

  closeEditor() {
    if (!this.editor) return;
    this.editor = null;
    this.render();
    this.focus(this.returnFocus || '[data-action="new-event"]', '[data-action="new-event"]');
    this.returnFocus = null;
  }

  /** Submit the dialog's values. On an error the dialog stays open with what was typed. */
  submitEditor(values) {
    if (!this.editor) return { ok: false };
    const result = this.saveEvent({ ...values, id: this.editor.id });
    if (!result.ok) {
      this.editor = { ...this.editor, values, error: result.error };
      this.render();
      this.focus('dialog .cal-error');
      return result;
    }
    this.closeEditor();
    this._tick(); // a reminder that is already due rings now, not on the next tick
    return result;
  }

  focus(selector, fallback) {
    if (typeof this.querySelector !== 'function') return;
    const el = this.querySelector(selector) || (fallback && this.querySelector(fallback));
    if (el && el.focus) el.focus();
  }

  // ---------- Events ----------

  handleClick(e) {
    unlockAudio();
    const target = e.target;
    if (target && target.tagName === 'DIALOG') return this.closeEditor(); // backdrop
    const btn = target && target.closest ? target.closest('[data-action]') : null;
    if (!btn) return;
    const { action } = btn.dataset;
    if (action !== 'import') this.notice = null;
    switch (action) {
      case 'new-event':
        this.returnFocus = btn.dataset.focus ? `[data-focus="${cssValue(btn.dataset.focus)}"]` : '[data-action="new-event"]';
        return this.openEditor(null, btn.dataset.date);
      case 'open-event':
        this.returnFocus = `[data-focus="${cssValue(btn.dataset.focus)}"]`;
        return this.openEditor(btn.dataset.id, btn.dataset.date);
      case 'close-dialog': return this.closeEditor();
      case 'delete-event':
        if (this.editor && this.editor.id) {
          const id = this.editor.id;
          this.returnFocus = null;
          this.editor = null;
          this.deleteEvent(id);
          this.render();
          this.focus('[data-action="new-event"]');
        }
        return;
      case 'import': return this.pickFile();
      case 'dismiss': return this.dismiss(btn.dataset.key);
      case 'prev-month': this.shiftView(-1); return this.focus('[data-action="prev-month"]');
      case 'next-month': this.shiftView(1); return this.focus('[data-action="next-month"]');
      case 'today': this.goToday(); return this.focus('[data-action="today"]');
      case 'select-day': return this.selectDay(btn.dataset.date, { focus: true });
      case 'remove-source': {
        this.removeSource(btn.dataset.source);
        return this.focus('[data-action="remove-source"]', '[data-action="import"]');
      }
    }
  }

  handleChange(e) {
    const target = e.target;
    if (!target) return;
    if (target.classList && target.classList.contains('cal-import-input')) {
      const file = target.files && target.files[0];
      target.value = ''; // the same file can be picked again
      this.importFile(file).then(() => this.focus('[data-action="import"]'));
      return;
    }
    if (target.name === 'allDay') {
      const times = target.form && target.form.querySelector('.cal-times');
      if (times) {
        times.hidden = target.checked;
        times.querySelectorAll('input').forEach(i => { i.disabled = target.checked; });
      }
    }
  }

  // Arrow keys move the selected day in the month grid; PageUp/PageDown change month.
  handleKeydown(e) {
    const cell = e.target && e.target.closest ? e.target.closest('.cal-cell') : null;
    if (!cell) return;
    const date = cell.dataset.date;
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = null;
    if (e.key in steps) next = addDays(date, steps[e.key]);
    else if (e.key === 'Home') next = addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    else if (e.key === 'End') next = addDays(date, 6 - ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const [y, m, d] = date.split('-').map(Number);
      const { year, month } = shiftMonth({ year: y, month: m - 1 }, e.key === 'PageUp' ? -1 : 1);
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      next = `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    }
    if (!next) return;
    e.preventDefault();
    this.selectDay(next, { focus: true });
  }

  handleSubmit(e) {
    const form = e.target;
    if (!form || !form.dataset || form.dataset.form !== 'event') return;
    e.preventDefault();
    unlockAudio();
    const data = new FormData(form);
    const allDay = data.get('allDay') === 'on';
    this.submitEditor({
      title: String(data.get('title') || ''),
      date: data.get('date') === null ? undefined : String(data.get('date')),
      allDay,
      start: allDay ? null : String(data.get('start') || ''),
      end: String(data.get('end') || ''),
      reminder: String(data.get('reminder') || ''),
      notes: String(data.get('notes') || ''),
    });
  }

  // ---------- Rendering ----------

  // A selector that finds the same control again after innerHTML is rebuilt.
  focusedSelector() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (!el || el === this || typeof this.contains !== 'function' || !this.contains(el) || !el.dataset) return null;
    if (el.dataset.focus) return `[data-focus="${cssValue(el.dataset.focus)}"]`;
    if (!el.dataset.action) return null;
    return ['action', 'date', 'id', 'key', 'source']
      .filter(k => el.dataset[k] !== undefined)
      .map(k => `[data-${k}="${cssValue(el.dataset[k])}"]`).join('');
  }

  render() {
    const keepFocus = this.focusedSelector();
    const now = this.now();
    const today = localIso(now);
    this.renderedDay = today;
    if (!this.selected) this.selected = today;
    const events = this.getEvents();
    const expanded = !!this.classList?.contains('expanded');
    const ringing = this.ringing();
    this.classList?.toggle('is-ringing', ringing.length > 0);
    const notice = this.notice;

    this.innerHTML = `
      <style>${STYLE}</style>
      <div class="block-header">
        <p class="block-header__label">Calendar</p>
        <div class="block-header__actions">
          <button type="button" class="action-button" data-action="new-event" aria-label="New event">+ Event</button>
          <button type="button" class="action-button" data-action="import" aria-label="Import calendar from an .ics file">Import</button>
          <input type="file" class="cal-import-input" accept=".ics,text/calendar" tabindex="-1" aria-hidden="true">
          ${expandButton('Calendar', expanded)}
        </div>
      </div>
      ${ringing.length ? this.renderRinging(ringing) : ''}
      <p class="cal-notice label${notice && notice.error ? ' is-error' : ''}" role="${notice && notice.error ? 'alert' : 'status'}">${notice ? escapeHtml(notice.text) : ''}</p>
      ${this.renderAgenda(events, today)}
      ${this.renderExpanded(events, today)}
      ${this.editor ? this.renderDialog(events) : ''}
    `;

    const dialog = typeof this.querySelector === 'function' ? this.querySelector('dialog') : null;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else if (keepFocus) this.focus(keepFocus);
  }

  renderRinging(items) {
    const rows = items.map(r => `
      <li class="cal-ring__item">
        <span class="cal-ring__text"><span class="cal-ring__title">${escapeHtml(r.title)}</span> <span class="label num">${escapeHtml(r.when)}</span></span>
        <button type="button" class="button-primary" data-action="dismiss" data-key="${escapeHtml(r.key)}" aria-label="Dismiss reminder: ${escapeHtml(r.title)}">Dismiss</button>
      </li>`).join('');
    return `<div class="cal-ring" role="alert"><p class="label cal-ring__label">Reminder</p><ul class="cal-ring__list">${rows}</ul></div>`;
  }

  eventButton({ event, date }, view) {
    const key = `${event.id}@${date}`;
    return `
      <li>
        <button type="button" class="cal-event" data-action="open-event" data-id="${escapeHtml(event.id)}" data-date="${escapeHtml(date)}" data-focus="${escapeHtml(`${view}:${key}`)}"
          aria-label="${escapeHtml(`${event.title}, ${formatWhen(event)}${event.reminder !== null && event.reminder !== undefined ? ', reminder set' : ''}`)}">
          <span class="cal-event__time num">${escapeHtml(formatWhen(event))}</span>
          <span class="cal-event__title">${escapeHtml(event.title)}</span>
          ${event.reminder !== null && event.reminder !== undefined ? '<span class="cal-event__bell" aria-hidden="true" title="Reminder"></span>' : ''}
        </button>
      </li>`;
  }

  renderAgenda(events, today) {
    const days = agenda(events, today, AGENDA_DAYS);
    if (!days.length) return '<div class="cal-agenda"><p class="label empty-state">No events in the next 7 days</p></div>';
    return `<div class="cal-agenda">${days.map(day => `
      <section class="cal-day" aria-label="${escapeHtml(day.label)}">
        <h3 class="label cal-day__label">${escapeHtml(day.label)}</h3>
        <ul class="cal-list">${day.items.map(o => this.eventButton(o, 'agenda')).join('')}</ul>
      </section>`).join('')}</div>`;
  }

  renderExpanded(events, today) {
    const { year, month } = this.viewMonth();
    const weeks = monthGrid(year, month);
    const counts = new Map();
    for (const o of occurrencesBetween(events, weeks[0][0].date, weeks.at(-1).at(-1).date)) {
      counts.set(o.date, (counts.get(o.date) || 0) + 1);
    }
    const selected = this.selected;
    const focusable = weeks.flat().some(c => c.date === selected) ? selected : weeks[0].find(c => c.inMonth)?.date || weeks[1][0].date;
    const head = [1, 2, 3, 4, 5, 6, 0].map(d => `<th scope="col" class="label"><abbr title="${WEEKDAY_NAMES[d]}">${WEEKDAY_NAMES[d]}</abbr></th>`).join('');
    const body = weeks.map(week => `<tr>${week.map(({ date, inMonth }) => {
      const n = counts.get(date) || 0;
      const classes = ['cal-cell', inMonth ? '' : 'is-outside', date === today ? 'is-today' : '', date === selected ? 'is-selected' : '', n ? 'has-events' : ''].filter(Boolean).join(' ');
      const label = `${shortDate(date)}${date === today ? ', today' : ''}${n ? `, ${plural(n, 'event')}` : ''}`;
      return `<td><button type="button" class="${classes}" data-action="select-day" data-date="${date}" tabindex="${date === focusable ? '0' : '-1'}" aria-pressed="${date === selected}" aria-label="${escapeHtml(label)}"${date === today ? ' aria-current="date"' : ''}><span class="num">${Number(date.slice(8))}</span><span class="cal-cell__dot" aria-hidden="true"></span></button></td>`;
    }).join('')}</tr>`).join('');

    const dayItems = occurrencesBetween(events, selected, selected);
    const sources = importedSources(events);
    const sourcesHtml = sources.length ? `
      <section class="cal-sources" aria-label="Imported calendars">
        <h3 class="label">Imported calendars</h3>
        <ul class="cal-sources__list">${sources.map(s => `
          <li class="cal-sources__item">
            <span class="cal-sources__name">${escapeHtml(s.source)}</span>
            <span class="label num">${plural(s.count, 'event')}</span>
            <button type="button" class="action-button action-button--danger" data-action="remove-source" data-source="${escapeHtml(s.source)}" aria-label="Remove ${escapeHtml(s.source)} and its events">Remove</button>
          </li>`).join('')}</ul>
      </section>` : '';

    return `
      <div class="cal-expanded">
        <div class="cal-month">
          <div class="cal-month__head">
            <h3 class="cal-month__title" id="cal-month-title">${monthLabel(year, month)}</h3>
            <span class="cal-month__nav">
              <button type="button" class="action-button cal-nav" data-action="prev-month" aria-label="Previous month">‹</button>
              <button type="button" class="action-button" data-action="today">Today</button>
              <button type="button" class="action-button cal-nav" data-action="next-month" aria-label="Next month">›</button>
            </span>
          </div>
          <table class="cal-grid" aria-labelledby="cal-month-title">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
          <p class="label cal-grid__hint">Arrow keys move the day · Page Up / Down change month</p>
        </div>
        <div class="cal-side">
          <div class="cal-side__head">
            <h3 class="label">${escapeHtml(shortDate(selected))}${selected === today ? ' · Today' : ''}</h3>
            <button type="button" class="action-button" data-action="new-event" data-date="${selected}" data-focus="side:new" aria-label="New event on ${escapeHtml(shortDate(selected))}">+ Event</button>
          </div>
          ${dayItems.length
            ? `<ul class="cal-list">${dayItems.map(o => this.eventButton(o, 'side')).join('')}</ul>`
            : '<p class="label cal-side__empty">No events</p>'}
          ${sourcesHtml}
        </div>
      </div>`;
  }

  renderDialog(events) {
    const { id, date, values, error } = this.editor;
    const event = id ? events.find(e => e.id === id) : null;
    const v = values || (event
      ? { title: event.title, date: event.date, allDay: !event.start, start: event.start || '', end: event.end || '', reminder: event.reminder === null || event.reminder === undefined ? '' : String(event.reminder), notes: event.notes || '' }
      : { title: '', date, allDay: false, start: '09:00', end: '10:00', reminder: '', notes: '' });
    const recurring = !!(event && event.rrule);
    const imported = event && event.source && event.source !== 'local';
    const options = REMINDER_OPTIONS.map(o => {
      const value = o.value === null ? '' : String(o.value);
      return `<option value="${value}"${value === String(v.reminder ?? '') ? ' selected' : ''}>${escapeHtml(o.label)}</option>`;
    }).join('');
    const hints = [
      recurring ? `${describeRule(event.rrule)} · changes apply to every occurrence` : '',
      imported ? `From ${event.source} · importing it again overwrites changes, except the reminder` : '',
      v.allDay ? 'All-day reminders count back from 09:00.' : '',
      notificationsBlocked() ? 'Notifications are blocked for this site, so reminders only show on this page.' : '',
    ].filter(Boolean).map(h => `<p class="cal-hint">${escapeHtml(h)}</p>`).join('');
    const title = event ? 'Edit event' : 'New event';
    return `
      <dialog class="dialog cal-dialog" aria-labelledby="cal-dialog-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="cal-dialog-title">${title}</h2>
          <button type="button" class="zoom-button" data-action="close-dialog" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" data-form="event" novalidate>
          <label class="field">
            <span class="label">Title</span>
            <input type="text" name="title" class="input" value="${escapeHtml(v.title)}" required autofocus autocomplete="off">
          </label>
          <div class="cal-row">
            <label class="field">
              <span class="label">Date</span>
              <input type="date" name="date" class="input num" value="${escapeHtml(v.date || (event && event.date) || date)}" required${recurring ? ' disabled' : ''}>
            </label>
            <label class="cal-check">
              <input type="checkbox" name="allDay" class="todo-check"${v.allDay ? ' checked' : ''}>
              <span class="label">All day</span>
            </label>
          </div>
          <div class="cal-row cal-times"${v.allDay ? ' hidden' : ''}>
            <label class="field">
              <span class="label">Start</span>
              <input type="time" name="start" class="input num" value="${escapeHtml(v.start || '')}"${v.allDay ? ' disabled' : ''}>
            </label>
            <label class="field">
              <span class="label">End · optional</span>
              <input type="time" name="end" class="input num" value="${escapeHtml(v.end || '')}"${v.allDay ? ' disabled' : ''}>
            </label>
          </div>
          <label class="field">
            <span class="label">Reminder</span>
            <select name="reminder" class="select">${options}</select>
          </label>
          <label class="field">
            <span class="label">Notes</span>
            <textarea name="notes" class="input cal-notes" rows="3">${escapeHtml(v.notes || '')}</textarea>
          </label>
          ${hints}
          ${error ? `<p class="cal-error" role="alert" tabindex="-1">${escapeHtml(error)}</p>` : ''}
          <div class="form-actions">
            ${event ? `<button type="button" class="action-button action-button--danger" data-action="delete-event">${recurring ? 'Delete series' : 'Delete'}</button><span class="cal-spacer"></span>` : ''}
            <button type="button" class="button-secondary" data-action="close-dialog">Cancel</button>
            <button type="submit" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>`;
  }
}

const STYLE = `
  .app-calendar.is-ringing { border-color: var(--color-accent); }
  .app-calendar .cal-notice { margin: 0 0 0.8rem; color: var(--color-ink); flex: none; }
  .app-calendar .cal-notice:empty { display: none; }
  .app-calendar .cal-notice.is-error { color: var(--color-accent); }
  .app-calendar .cal-import-input { display: none; }

  .app-calendar .cal-ring { flex: none; margin-bottom: 1.2rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--color-accent); }
  .app-calendar .cal-ring__label { color: var(--color-accent); }
  .app-calendar .cal-ring__list { list-style: none; margin: 0; padding: 0; }
  .app-calendar .cal-ring__item { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; min-height: 4rem; }
  .app-calendar .cal-ring__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-calendar .cal-ring__title { font-weight: 500; }
  .app-calendar .cal-ring .button-primary { flex: none; height: 2.8rem; padding: 0 1.2rem; }

  .app-calendar .cal-agenda { flex: 1; min-height: 0; overflow-y: auto; }
  .app-calendar.expanded .cal-agenda { display: none; }
  .app-calendar .cal-day + .cal-day { margin-top: 1.2rem; }
  .app-calendar .cal-day__label { margin: 0 0 0.4rem; }
  .app-calendar .cal-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--color-line); }
  .app-calendar .cal-event {
    display: flex; align-items: center; gap: 1.2rem; width: 100%; min-height: 3.6rem;
    border-bottom: 1px solid var(--color-line); text-align: left;
  }
  .app-calendar .cal-event:hover .cal-event__title { text-decoration: underline; text-underline-offset: 0.3rem; }
  .app-calendar .cal-event__time {
    flex: none; width: 8.4rem; font-size: var(--text-xs); color: var(--color-ink-muted); white-space: nowrap;
  }
  .app-calendar .cal-event__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink); }
  .app-calendar .cal-event__bell { flex: none; width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--color-ink-faint); }

  .app-calendar .cal-expanded { display: none; }
  .app-calendar.expanded .cal-ring,
  .app-calendar.expanded .cal-notice { width: 100%; max-width: 104rem; margin-left: auto; margin-right: auto; }
  .app-calendar.expanded .cal-ring { margin-bottom: 2.4rem; }
  .app-calendar.expanded .cal-expanded {
    display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(24rem, 1fr); gap: 3.2rem;
    width: 100%; max-width: 104rem; margin: 0 auto;
  }
  @media (max-width: 760px) {
    .app-calendar.expanded .cal-expanded { grid-template-columns: minmax(0, 1fr); gap: 2.4rem; }
    .app-calendar .cal-month__head { flex-wrap: wrap; gap: 0.8rem 1.2rem; }
  }
  .app-calendar .cal-month__head { display: flex; align-items: center; gap: 1.2rem; margin-bottom: 1.2rem; }
  .app-calendar .cal-month__title { margin: 0 auto 0 0; font-size: var(--text-lg); font-weight: 500; white-space: nowrap; letter-spacing: var(--track-tight); }
  .app-calendar .cal-month__nav { display: flex; align-items: center; gap: 1.2rem; }
  .app-calendar .cal-nav { font-size: var(--text-md); line-height: 1; padding: 0 0.4rem; }
  .app-calendar .cal-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .app-calendar .cal-grid th { padding: 0 0 0.8rem; text-align: center; font-weight: 400; }
  .app-calendar .cal-grid abbr { text-decoration: none; }
  .app-calendar .cal-grid td { padding: 0; border-top: 1px solid var(--color-line); }
  .app-calendar .cal-cell {
    position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem;
    width: 100%; height: 5.2rem; color: var(--color-ink); border-radius: var(--radius);
  }
  .app-calendar .cal-cell .num { font-size: var(--text-sm); }
  .app-calendar .cal-cell:hover { background: var(--color-recessed); }
  .app-calendar .cal-cell.is-outside { color: var(--color-ink-faint); }
  .app-calendar .cal-cell.is-today .num { color: var(--color-accent); font-weight: 600; }
  .app-calendar .cal-cell.is-selected { background: var(--color-ink); color: var(--color-ink-inverse); }
  .app-calendar .cal-cell.is-selected.is-today .num { color: var(--color-ink-inverse); }
  .app-calendar .cal-cell__dot { width: 4px; height: 4px; border-radius: 50%; background: transparent; }
  .app-calendar .cal-cell.has-events .cal-cell__dot { background: var(--color-ink-muted); }
  .app-calendar .cal-cell.is-selected .cal-cell__dot { background: transparent; }
  .app-calendar .cal-cell.is-selected.has-events .cal-cell__dot { background: var(--color-ink-inverse); }
  .app-calendar .cal-grid__hint { margin-top: 1.2rem; color: var(--color-ink-faint); }

  .app-calendar .cal-side { min-width: 0; }
  .app-calendar .cal-side__head { display: flex; align-items: center; justify-content: space-between; gap: 1.2rem; min-height: 3.2rem; margin-bottom: 0.4rem; }
  .app-calendar .cal-side__head .label { margin: 0; }
  .app-calendar .cal-side__empty { padding: 1.2rem 0; border-top: 1px solid var(--color-line); color: var(--color-ink-faint); }
  .app-calendar .cal-sources { margin-top: 3.2rem; }
  .app-calendar .cal-sources .label { margin: 0 0 0.4rem; }
  .app-calendar .cal-sources__list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--color-line); }
  .app-calendar .cal-sources__item { display: flex; align-items: center; gap: 1.2rem; min-height: 4rem; border-bottom: 1px solid var(--color-line); }
  .app-calendar .cal-sources__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-calendar .cal-sources__item .label { margin: 0; }

  .cal-dialog .cal-row { display: flex; align-items: flex-end; gap: 1.2rem; }
  .cal-dialog .cal-row .field { flex: 1; min-width: 0; }
  .cal-dialog .cal-times[hidden] { display: none; }
  .cal-dialog .cal-check { display: flex; align-items: center; gap: 0.8rem; height: var(--control-height); cursor: pointer; }
  .cal-dialog .cal-check .todo-check {
    appearance: none; display: grid; place-content: center; width: 1.4rem; height: 1.4rem; margin: 0;
    border: 1px solid var(--color-line-strong); border-radius: var(--radius); background: transparent; cursor: pointer;
  }
  .cal-dialog .cal-check .todo-check:checked { background: var(--color-ink); border-color: var(--color-ink); }
  .cal-dialog .cal-check .todo-check:checked::after {
    content: ""; width: 0.7rem; height: 0.4rem; margin-top: -0.2rem;
    border-left: 1.5px solid var(--color-ink-inverse); border-bottom: 1.5px solid var(--color-ink-inverse); transform: rotate(-45deg);
  }
  .cal-dialog .cal-check .todo-check:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .cal-dialog .cal-check .label { color: var(--color-ink); }
  .cal-dialog .cal-notes { height: auto; min-height: 7.2rem; padding: 0.8rem 1rem; resize: vertical; line-height: 1.4; }
  .cal-dialog .cal-hint { margin: 0; font-size: var(--text-xs); color: var(--color-ink-muted); }
  .cal-dialog .cal-error { margin: 0; font-size: var(--text-xs); color: var(--color-accent); }
  .cal-dialog .cal-spacer { flex: 1; }
`;

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-calendar', CalendarApp);
  } catch (e) {
    // ignore re-registration error
  }
}
