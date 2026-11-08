import { storage } from '../../core/storage.js';
import { escapeHtml, expandButton } from '../../core/html.js';
import { registerCommands } from '../../core/commands.js';
import {
  alarmDue,
  armAlarm,
  startTimer,
  pauseTimer,
  resetTimer,
  timerRemaining,
  timerFinished,
  formatCountdown,
  localDateKey,
  formatTimeLeft,
  nextAlarm,
  formatDays,
  WEEK_ORDER,
  dayName,
  POMODORO,
  nextPomodoro,
  pomodoroLabel,
  isValidZone,
  zoneTime,
  zoneName,
  zoneOffsetLabel,
} from './clock-logic.js';
import {
  requestNotifyPermission,
  showRingNotification,
  closeRingNotification,
  notificationsBlocked,
} from './clock-notify.js';

const STORAGE_KEY = 'clock';
const DEFAULT_TIMER_MS = 5 * 60 * 1000;
const TIMER_PRESETS_MIN = [1, 5, 10, 25];
// Beep for at most this long; the banner stays until dismissed.
const RING_SOUND_MS = 60 * 1000;

function defaultState() {
  return {
    alarms: [], // see clock-logic.js; kept sorted by time
    timer: resetTimer(DEFAULT_TIMER_MS),
    ringing: null, // { kind: 'alarm' | 'timer', label: string, since: ms }
    zone: null, // IANA time zone shown in the header, e.g. 'America/New_York'
    pomodoro: null, // { phase, round } while a Pomodoro cycle drives the timer
  };
}

const newAlarmId = () => 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const byTime = (a, b) => a.time.localeCompare(b.time);

// Before multiple alarms there was one `alarm`; carry it over only if it was on.
function storedAlarms(stored) {
  if (Array.isArray(stored.alarms)) return stored.alarms;
  const old = stored.alarm;
  return old && old.enabled ? [{ id: 'al_1', days: [], ...old }] : [];
}

// One AudioContext for the page. Browsers only allow sound after a user
// gesture, so it's created/resumed from clicks inside the widget.
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
  for (const offset of [0, 0.18]) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.08, t + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + offset);
    osc.stop(t + offset + 0.13);
  }
}

export class ClockApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.openDialog = null; // 'alarm' | 'timer' | 'zone' | null
    this.dialogError = '';
    this.timerDraft = null; // { minutes, seconds } kept when the form is re-rendered with an error
    this._onClick = (e) => this.handleClick(e);
    this._onSubmit = (e) => this.handleSubmit(e);
    this._onCancel = (e) => {
      if (e.target && e.target.tagName === 'DIALOG') {
        e.preventDefault();
        this.closeDialog();
      }
    };
  }

  connectedCallback() {
    if (typeof this.addEventListener === 'function') {
      this.addEventListener('click', this._onClick);
      this.addEventListener('submit', this._onSubmit);
      // 'cancel' (Escape on a dialog) doesn't bubble; catch it on the way down.
      this.addEventListener('cancel', this._onCancel, true);
    }
    if (this.storage && this.storage.subscribe) {
      this.unsubscribe = this.storage.subscribe(STORAGE_KEY, (value) => {
        // Dismissed here or in another tab: take the system notification down too.
        if (!value || !value.ringing) closeRingNotification();
        // Don't wipe what the user is typing in an open dialog.
        if (!this.openDialog) this.render();
      });
    }
    this.offCommands = registerCommands('clock', (query) => this.commands(query));
    this.render();
    this._tick();
    this._interval = setInterval(() => this._tick(), 1000);
  }

  commands(query) {
    const state = this.getState();
    const list = [];
    if (state.ringing) list.push({ title: `Dismiss: ${state.ringing.label}`, keywords: 'stop alarm', run: () => this.setState({ ringing: null }) });
    if (state.timer.state !== 'idle') list.push({ title: state.pomodoro ? 'Stop Pomodoro' : 'Reset timer', keywords: 'timer stop', run: () => this.resetTimerAndPomodoro() });
    list.push({ title: 'Start Pomodoro', keywords: 'focus timer', run: () => this.startPomodoro() });
    list.push({ title: 'Alarms', keywords: 'alarm wake', run: () => this.openDialogFor('alarm') });
    // "10", "10m", "timer 10", "10 min" -> a timer of that many minutes.
    const m = /^\s*(?:timer\s*)?(\d{1,3})\s*(?:m|min|mins|minutes)?\s*$/i.exec(query);
    const minutes = m ? Number(m[1]) : 0;
    if (minutes > 0) {
      list.push({
        title: `Start timer: ${minutes} min`,
        dynamic: true,
        run: () => {
          requestNotifyPermission();
          this.setState({ pomodoro: null, timer: startTimer(resetTimer(minutes * 60000), Date.now()) });
        },
      });
    }
    return list;
  }

  disconnectedCallback() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (typeof this.removeEventListener === 'function') {
      this.removeEventListener('click', this._onClick);
      this.removeEventListener('submit', this._onSubmit);
      this.removeEventListener('cancel', this._onCancel, true);
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.offCommands) this.offCommands();
  }

  getState() {
    const stored = this.storage ? this.storage.get(STORAGE_KEY, null) : null;
    if (!stored || typeof stored !== 'object') return defaultState();
    const defaults = defaultState();
    return {
      alarms: storedAlarms(stored),
      timer: { ...defaults.timer, ...(stored.timer || {}) },
      ringing: stored.ringing || null,
      zone: isValidZone(stored.zone) ? stored.zone : null,
      pomodoro: stored.pomodoro || null,
    };
  }

  setState(patch) {
    const { alarm: _legacy, ...current } = this.getState();
    const next = { ...current, ...patch };
    if (this.storage) this.storage.set(STORAGE_KEY, next);
    return next;
  }

  // ---------- Actions ----------

  addAlarm(time, days = []) {
    const alarm = { id: newAlarmId(), ...armAlarm(time, Date.now(), days) };
    this.setState({ alarms: [...this.getState().alarms, alarm].sort(byTime) });
    return alarm;
  }

  // Switching an alarm back on re-arms it, so a time already passed today waits for its next day.
  toggleAlarm(id) {
    const now = Date.now();
    this.setState({
      alarms: this.getState().alarms.map(a => {
        if (a.id !== id) return a;
        return a.enabled ? { ...a, enabled: false } : { ...a, ...armAlarm(a.time, now, a.days || []) };
      }),
    });
  }

  deleteAlarm(id) {
    this.setState({ alarms: this.getState().alarms.filter(a => a.id !== id) });
  }

  startPomodoro(pomodoro = { phase: 'focus', round: 1 }) {
    requestNotifyPermission();
    this.setState({ pomodoro, timer: startTimer(resetTimer(POMODORO[pomodoro.phase]), Date.now()) });
  }

  resetTimerAndPomodoro() {
    const { timer, pomodoro } = this.getState();
    this.setState({ pomodoro: null, timer: resetTimer(pomodoro ? DEFAULT_TIMER_MS : timer.durationMs) });
  }

  /** Show `zone` in the header; '' or null removes it. Returns false for an unknown zone. */
  setZone(zone) {
    const value = String(zone || '').trim();
    if (!value) { this.setState({ zone: null }); return true; }
    if (!isValidZone(value)) return false;
    this.setState({ zone: value });
    return true;
  }

  // ---------- Rendering ----------

  render() {
    const state = this.getState();
    const now = Date.now();
    this.classList?.toggle('is-ringing', !!state.ringing);

    this.innerHTML = `
      <style>
        .app-clock.is-ringing { border-color: var(--color-accent); }
        .app-clock .clock-status {
          flex: none;
          border-top: 1px solid var(--color-line);
        }
        .app-clock .clock-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          width: 100%;
          height: 2.8rem;
          border-bottom: 1px solid var(--color-line);
          text-align: left;
        }
        .app-clock .clock-row:last-child { border-bottom: none; }
        .app-clock .clock-row:hover .clock-row__value { color: var(--color-ink); }
        .app-clock .clock-row__value {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: var(--text-xs);
          color: var(--color-ink-muted);
        }
        .app-clock .clock-row__value.is-active { color: var(--color-ink); }
        .app-clock .clock-ring {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          padding-top: 1rem;
          border-top: 1px solid var(--color-accent);
        }
        .app-clock .clock-ring .label { color: var(--color-accent); }
        .app-clock .clock-ring .button-primary { height: 2.8rem; padding: 0 1.2rem; }
        .app-clock.expanded .clock-status,
        .app-clock.expanded .clock-ring { max-width: 48rem; width: 100%; margin: 0 auto; }

        .clock-dialog .presets { display: flex; gap: 0.8rem; flex-wrap: wrap; }
        .clock-dialog .presets .button-secondary { height: 2.8rem; padding: 0 1rem; }
        .clock-dialog .duration { display: flex; gap: 1.2rem; }
        .clock-dialog .duration .field { flex: 1; }
        .clock-dialog .input[type="time"],
        .clock-dialog .input[type="number"] { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .clock-dialog .big-readout {
          margin: 0;
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: var(--text-2xl);
          letter-spacing: var(--track-tight);
          line-height: 1;
        }
        .clock-dialog .hint { margin: 0; font-size: var(--text-xs); color: var(--color-ink-muted); }
        .clock-dialog .error { margin: 0; font-size: var(--text-xs); color: var(--color-accent); }
        .clock-dialog .form-actions__spacer { flex: 1; }
        .app-clock .clock-zone {
          display: flex;
          align-items: baseline;
          gap: 0.6rem;
          font-size: var(--text-2xs);
          letter-spacing: var(--track-label);
          text-transform: uppercase;
          color: var(--color-ink-muted);
          min-width: 0;
          margin-left: auto;
        }
        .app-clock .clock-zone__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .app-clock .clock-zone:hover { color: var(--color-ink); }
        .app-clock .clock-zone .numeral { font-size: var(--text-xs); letter-spacing: 0; color: var(--color-ink); }
        .clock-dialog .alarm-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--color-line); }
        .clock-dialog .alarm-item {
          display: flex;
          align-items: center;
          gap: 1.2rem;
          min-height: 4rem;
          border-bottom: 1px solid var(--color-line);
        }
        .clock-dialog .alarm-item label { flex: 1; display: flex; align-items: center; gap: 1.2rem; cursor: pointer; }
        .clock-dialog .alarm-item .numeral { font-family: var(--font-mono); font-size: var(--text-md); }
        .clock-dialog .alarm-item.is-off .numeral { color: var(--color-ink-faint); }
        .clock-dialog .days { display: flex; gap: 0.4rem; flex-wrap: wrap; border: 0; margin: 0; padding: 0; }
        .clock-dialog .days legend { padding: 0; margin-bottom: 0.6rem; }
        .clock-dialog .day input { position: absolute; opacity: 0; pointer-events: none; }
        .clock-dialog .day span {
          display: grid;
          place-content: center;
          width: 3.6rem;
          height: 2.8rem;
          border: 1px solid var(--color-line-strong);
          border-radius: var(--radius);
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          text-transform: uppercase;
          cursor: pointer;
        }
        .clock-dialog .day input:checked + span { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-ink-inverse); }
        .clock-dialog .day input:focus-visible + span { outline: 2px solid var(--color-focus); outline-offset: 2px; }
      </style>
      <div class="block-header">
        <p class="block-header__label">Clock</p>
        ${state.zone ? this.renderZone(state.zone, now) : ''}
        <div class="block-header__actions">
          ${state.zone ? '' : this.renderZone(null, now)}
          ${expandButton('Clock', !!this.classList?.contains('expanded'))}
        </div>
      </div>
      <div class="clock-container" id="clock-time">
        <span class="clock-text numeral">
          <time id="clock-text">--:--:--</time>
          <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
        </span>
      </div>
      ${state.ringing ? this.renderRinging(state.ringing) : this.renderStatus(state, now)}
      ${this.openDialog === 'alarm' ? this.renderAlarmDialog(state.alarms) : ''}
      ${this.openDialog === 'timer' ? this.renderTimerDialog(state.timer, state.pomodoro, now) : ''}
      ${this.openDialog === 'zone' ? this.renderZoneDialog(state.zone) : ''}
    `;

    const dialog = typeof this.querySelector === 'function' ? this.querySelector('dialog') : null;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }

  renderZone(zone, now) {
    if (!zone) return '<button type="button" class="action-button" data-action="open-zone" aria-label="Add a second time zone">+ Zone</button>';
    const name = escapeHtml(zoneName(zone));
    return `<button type="button" class="clock-zone" data-action="open-zone" aria-label="Second time zone: ${name}" title="${escapeHtml(`${zone} · ${zoneOffsetLabel(now, zone)}`)}"><span class="clock-zone__name">${name}</span> <span class="numeral zone-time">${zoneTime(now, zone)}</span></button>`;
  }

  renderStatus(state, now) {
    const { alarms, timer, pomodoro } = state;
    const next = nextAlarm(alarms, now);
    const others = alarms.filter(a => a.enabled).length - 1;
    const alarmValue = next ? `${escapeHtml(next.alarm.time)}${others > 0 ? ` +${others}` : ''}` : 'Off';
    const timerActive = timer.state !== 'idle';
    const timerValue = timer.state === 'paused'
      ? `${formatCountdown(timerRemaining(timer, now))} ‖`
      : formatCountdown(timerRemaining(timer, now));
    return `
      <div class="clock-status">
        <button type="button" class="clock-row" data-action="open-alarm" aria-label="Alarms: ${next ? `next ${escapeHtml(next.alarm.time)}` : 'off'}">
          <span class="label">Alarm<span class="alarm-left">${this.alarmLeftText(alarms, now)}</span></span>
          <span class="clock-row__value${next ? ' is-active' : ''}">${alarmValue}</span>
        </button>
        <button type="button" class="clock-row" data-action="open-timer" aria-label="${pomodoro ? escapeHtml(pomodoroLabel(pomodoro)) : 'Timer'}">
          <span class="label">${pomodoro ? escapeHtml(pomodoroLabel(pomodoro)) : 'Timer'}</span>
          <span class="clock-row__value timer-readout${timerActive ? ' is-active' : ''}">${timerActive ? timerValue : 'Set'}</span>
        </button>
      </div>
    `;
  }

  blockedHint() {
    return notificationsBlocked()
      ? '<p class="hint">Notifications are blocked for this site in browser settings, so it will only ring on this page.</p>'
      : '';
  }

  alarmLeftText(alarms, now) {
    const next = nextAlarm(alarms, now);
    return next ? ` · ${formatTimeLeft(next.ms)}` : '';
  }

  renderRinging(ringing) {
    return `
      <div class="clock-ring" role="alert">
        <span class="label">${escapeHtml(ringing.label)}</span>
        <button type="button" class="button-primary" data-action="dismiss">Dismiss</button>
      </div>
    `;
  }

  renderAlarmDialog(alarms) {
    const items = alarms.map(a => {
      const id = escapeHtml(a.id);
      const days = formatDays(a.days);
      return `
        <li class="alarm-item${a.enabled ? '' : ' is-off'}">
          <label>
            <input type="checkbox" class="todo-check" data-action="toggle-alarm" data-id="${id}" ${a.enabled ? 'checked' : ''} aria-label="${escapeHtml(a.time)} ${days} ${a.enabled ? 'on' : 'off'}">
            <span class="numeral">${escapeHtml(a.time)}</span>
            <span class="label">${escapeHtml(days)}</span>
          </label>
          <button type="button" class="action-button action-button--danger" data-action="delete-alarm" data-id="${id}" aria-label="Delete alarm ${escapeHtml(a.time)}">Delete</button>
        </li>`;
    }).join('');
    const dayBoxes = WEEK_ORDER.map(d => `
      <label class="day"><input type="checkbox" name="day" value="${d}"><span>${dayName(d).slice(0, 2)}</span></label>`).join('');
    return `
      <dialog class="dialog clock-dialog" aria-labelledby="clock-alarm-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="clock-alarm-title">Alarms</h2>
          <button type="button" class="zoom-button" data-action="close-dialog" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" data-form="alarm">
          ${alarms.length ? `<ul class="alarm-list">${items}</ul>` : '<p class="hint">No alarms yet.</p>'}
          <label class="field">
            <span class="label">New alarm</span>
            <input type="time" name="time" class="input" value="07:00" required autofocus>
          </label>
          <fieldset class="days">
            <legend class="label">Days · none = every day</legend>
            ${dayBoxes}
          </fieldset>
          ${this.blockedHint()}
          <div class="form-actions">
            <button type="button" class="button-secondary" data-action="close-dialog">Done</button>
            <button type="submit" class="button-primary">Add alarm</button>
          </div>
        </form>
      </dialog>
    `;
  }

  renderZoneDialog(zone) {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return `
      <dialog class="dialog clock-dialog" aria-labelledby="clock-zone-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="clock-zone-title">Second time zone</h2>
          <button type="button" class="zoom-button" data-action="close-dialog" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" data-form="zone">
          <label class="field">
            <span class="label">Zone · e.g. America/New_York</span>
            <input type="text" name="zone" class="input" list="clock-zones" value="${escapeHtml(zone || '')}" autocomplete="off" required autofocus>
          </label>
          <datalist id="clock-zones">${zones.map(z => `<option value="${escapeHtml(z)}"></option>`).join('')}</datalist>
          ${this.dialogError ? `<p class="error" role="alert">${escapeHtml(this.dialogError)}</p>` : ''}
          <div class="form-actions">
            ${zone ? '<button type="button" class="action-button action-button--danger" data-action="zone-remove">Remove</button><span class="form-actions__spacer"></span>' : ''}
            <button type="button" class="button-secondary" data-action="close-dialog">Cancel</button>
            <button type="submit" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>
    `;
  }

  renderTimerDialog(timer, pomodoro, now) {
    const idle = timer.state === 'idle';
    const totalSec = Math.round((timer.durationMs || DEFAULT_TIMER_MS) / 1000);
    const draft = this.timerDraft || { minutes: Math.floor(totalSec / 60), seconds: totalSec % 60 };
    const body = idle
      ? `
        <div class="presets" role="group" aria-label="Presets">
          ${TIMER_PRESETS_MIN.map(m => `<button type="button" class="button-secondary" data-action="preset" data-minutes="${m}">${m} min</button>`).join('')}
          <button type="button" class="button-secondary" data-action="pomodoro-start" title="${POMODORO.rounds} × ${POMODORO.focus / 60000} min focus, ${POMODORO.break / 60000} min breaks, then ${POMODORO.long / 60000} min">Pomodoro</button>
        </div>
        <div class="duration">
          <label class="field">
            <span class="label">Minutes</span>
            <input type="number" name="minutes" class="input" min="0" max="599" value="${escapeHtml(draft.minutes)}" autofocus>
          </label>
          <label class="field">
            <span class="label">Seconds</span>
            <input type="number" name="seconds" class="input" min="0" max="59" value="${escapeHtml(draft.seconds)}">
          </label>
        </div>
        ${this.blockedHint()}
        ${this.dialogError ? `<p class="error" role="alert">${escapeHtml(this.dialogError)}</p>` : ''}
        <div class="form-actions">
          <button type="button" class="button-secondary" data-action="close-dialog">Cancel</button>
          <button type="submit" class="button-primary">Start</button>
        </div>`
      : `
        <p class="big-readout timer-readout" aria-live="off">${formatCountdown(timerRemaining(timer, now))}</p>
        <p class="label">${pomodoro ? `${escapeHtml(pomodoroLabel(pomodoro))} · ` : ''}${timer.state === 'paused' ? 'Paused' : 'Running'} · of ${formatCountdown(timer.durationMs)}</p>
        <div class="form-actions">
          <button type="button" class="action-button action-button--danger" data-action="timer-reset">${pomodoro ? 'Stop' : 'Reset'}</button>
          <span class="form-actions__spacer"></span>
          ${pomodoro ? '<button type="button" class="button-secondary" data-action="pomodoro-skip">Skip</button>' : ''}
          ${timer.state === 'running'
            ? '<button type="button" class="button-secondary" data-action="timer-pause" autofocus>Pause</button>'
            : '<button type="button" class="button-primary" data-action="timer-resume" autofocus>Resume</button>'}
        </div>`;

    return `
      <dialog class="dialog clock-dialog" aria-labelledby="clock-timer-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="clock-timer-title">Timer</h2>
          <button type="button" class="zoom-button" data-action="close-dialog" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" data-form="timer">${body}</form>
      </dialog>
    `;
  }

  // ---------- Events ----------

  openDialogFor(kind) {
    this.openDialog = kind;
    this.dialogError = '';
    this.timerDraft = null;
    this.render();
  }

  closeDialog() {
    const kind = this.openDialog;
    this.openDialog = null;
    this.dialogError = '';
    this.timerDraft = null;
    this.render();
    const opener = this.querySelector?.(`[data-action="open-${kind}"]`);
    if (opener && opener.focus) opener.focus();
  }

  handleClick(e) {
    unlockAudio();
    const target = e.target;
    if (target && target.tagName === 'DIALOG') {
      // Click on the backdrop, outside the dialog box.
      this.closeDialog();
      return;
    }
    const btn = target && target.closest ? target.closest('[data-action]') : null;
    if (!btn) return;
    const now = Date.now();
    const state = this.getState();

    switch (btn.dataset.action) {
      case 'open-alarm': return this.openDialogFor('alarm');
      case 'open-timer': return this.openDialogFor('timer');
      case 'close-dialog': return this.closeDialog();
      case 'dismiss':
        closeRingNotification();
        this.setState({ ringing: null });
        return;
      case 'open-zone': return this.openDialogFor('zone');
      case 'toggle-alarm':
        this.toggleAlarm(btn.dataset.id);
        return this.rerenderDialog(`[data-action="toggle-alarm"][data-id="${CSS.escape(btn.dataset.id)}"]`);
      case 'delete-alarm':
        this.deleteAlarm(btn.dataset.id);
        return this.rerenderDialog('input[name="time"]');
      case 'zone-remove':
        this.setZone('');
        return this.closeDialog();
      case 'pomodoro-start':
        this.startPomodoro();
        return this.closeDialog();
      case 'pomodoro-skip':
        if (state.pomodoro) this.startPomodoro(nextPomodoro(state.pomodoro));
        return this.render();
      case 'preset': {
        requestNotifyPermission();
        const minutes = Number(btn.dataset.minutes);
        this.setState({ pomodoro: null, timer: startTimer(resetTimer(minutes * 60 * 1000), now) });
        return this.closeDialog();
      }
      case 'timer-pause':
        this.setState({ timer: pauseTimer(state.timer, now) });
        return this.render();
      case 'timer-resume':
        requestNotifyPermission();
        this.setState({ timer: startTimer(state.timer, now) });
        return this.render();
      case 'timer-reset':
        this.resetTimerAndPomodoro();
        return this.render();
    }
  }

  // Redraw the open dialog after a change inside it and put focus back on `selector`.
  rerenderDialog(selector) {
    this.render();
    const el = this.querySelector?.(`dialog ${selector}`);
    if (el && el.focus) el.focus();
  }

  handleSubmit(e) {
    const form = e.target;
    if (!form || !form.dataset || !form.dataset.form) return;
    e.preventDefault();
    unlockAudio();
    requestNotifyPermission();
    const now = Date.now();
    const data = new FormData(form);

    if (form.dataset.form === 'alarm') {
      const time = String(data.get('time') || '');
      if (!time) return;
      const days = data.getAll('day').map(Number).filter(d => d >= 0 && d <= 6);
      this.addAlarm(time, days);
      this.rerenderDialog('input[name="time"]');
      return;
    }

    if (form.dataset.form === 'zone') {
      if (this.setZone(data.get('zone'))) {
        this.closeDialog();
      } else {
        this.dialogError = 'Unknown time zone. Pick one from the list, like Europe/London.';
        this.rerenderDialog('input[name="zone"]');
      }
      return;
    }

    if (form.dataset.form === 'timer') {
      const minutes = Math.max(0, Math.floor(Number(data.get('minutes')) || 0));
      const seconds = Math.min(59, Math.max(0, Math.floor(Number(data.get('seconds')) || 0)));
      const durationMs = (minutes * 60 + seconds) * 1000;
      if (durationMs <= 0) {
        this.dialogError = 'Set a duration longer than zero.';
        this.timerDraft = { minutes, seconds };
        this.render();
        return;
      }
      this.setState({ pomodoro: null, timer: startTimer(resetTimer(durationMs), now) });
      this.closeDialog();
    }
  }

  // ---------- Tick ----------

  _tick() {
    const now = Date.now();
    const timeEl = typeof this.querySelector === 'function' ? this.querySelector('#clock-text') : null;
    if (timeEl) {
      timeEl.textContent = new Date(now).toLocaleTimeString([], { hour12: false });
    }

    const state = this.getState();

    const zoneEl = state.zone && typeof this.querySelector === 'function' ? this.querySelector('.zone-time') : null;
    if (zoneEl) zoneEl.textContent = zoneTime(now, state.zone);

    const due = state.ringing ? null : state.alarms.find(a => alarmDue(a, now));
    if (due) {
      const ringing = { kind: 'alarm', label: `Alarm · ${due.time}`, since: now };
      const today = localDateKey(now);
      this.setState({ alarms: state.alarms.map(a => (a.id === due.id ? { ...a, lastFiredDate: today } : a)), ringing });
      showRingNotification(ringing);
      if (this.openDialog) this.render();
      return;
    }

    // One thing rings at a time; a finished timer waits until the alarm is dismissed.
    if (!state.ringing && timerFinished(state.timer, now)) {
      if (state.pomodoro) {
        // A Pomodoro phase ended: ring, and the next phase starts right away.
        const next = nextPomodoro(state.pomodoro);
        const ringing = { kind: 'timer', label: `${pomodoroLabel(state.pomodoro)} done · ${pomodoroLabel(next)}`, since: now };
        this.setState({ pomodoro: next, timer: startTimer(resetTimer(POMODORO[next.phase]), now), ringing });
        showRingNotification(ringing);
      } else {
        const ringing = { kind: 'timer', label: 'Timer done', since: now };
        this.setState({ timer: resetTimer(state.timer.durationMs), ringing });
        showRingNotification(ringing);
      }
      if (this.openDialog) this.render();
      return;
    }

    const alarmLeftEl = typeof this.querySelector === 'function' ? this.querySelector('.alarm-left') : null;
    if (alarmLeftEl) alarmLeftEl.textContent = this.alarmLeftText(state.alarms, now);

    if (state.timer.state === 'running' && typeof this.querySelectorAll === 'function') {
      const text = formatCountdown(timerRemaining(state.timer, now));
      this.querySelectorAll('.timer-readout').forEach(el => { el.textContent = text; });
    }

    if (state.ringing && now - state.ringing.since < RING_SOUND_MS) beep();
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-clock', ClockApp);
  } catch (e) {
    // ignore re-registration error
  }
}
