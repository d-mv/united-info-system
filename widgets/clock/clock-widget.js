import { storage } from '../../core/storage.js';
import { escapeHtml } from '../../core/html.js';
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
} from './clock-logic.js';

const STORAGE_KEY = 'clock';
const DEFAULT_TIMER_MS = 5 * 60 * 1000;
const TIMER_PRESETS_MIN = [1, 5, 10, 25];
// Beep for at most this long; the banner stays until dismissed.
const RING_SOUND_MS = 60 * 1000;

function defaultState() {
  return {
    alarm: { time: '07:00', enabled: false, lastFiredDate: null },
    timer: resetTimer(DEFAULT_TIMER_MS),
    ringing: null, // { kind: 'alarm' | 'timer', label: string, since: ms }
  };
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

export class ClockWidget extends HTMLElement {
  static manifest = {
    id: 'clock',
    type: 'widget',
    cols: 2,
    rows: 1,
    defaultCol: 1,
    defaultRow: 1,
    expandable: true,
  };

  constructor() {
    super();
    this.storage = storage;
    this.openDialog = null; // 'alarm' | 'timer' | null
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
      this.unsubscribe = this.storage.subscribe(STORAGE_KEY, () => {
        // Don't wipe what the user is typing in an open dialog.
        if (!this.openDialog) this.render();
      });
    }
    this.render();
    this._tick();
    this._interval = setInterval(() => this._tick(), 1000);
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
  }

  getState() {
    const stored = this.storage ? this.storage.get(STORAGE_KEY, null) : null;
    if (!stored || typeof stored !== 'object') return defaultState();
    const defaults = defaultState();
    return {
      alarm: { ...defaults.alarm, ...(stored.alarm || {}) },
      timer: { ...defaults.timer, ...(stored.timer || {}) },
      ringing: stored.ringing || null,
    };
  }

  setState(patch) {
    const next = { ...this.getState(), ...patch };
    if (this.storage) this.storage.set(STORAGE_KEY, next);
    return next;
  }

  // ---------- Rendering ----------

  render() {
    const state = this.getState();
    const now = Date.now();
    this.classList?.toggle('is-ringing', !!state.ringing);

    this.innerHTML = `
      <style>
        .widget-clock.is-ringing { border-color: var(--color-accent); }
        .widget-clock .clock-status {
          flex: none;
          border-top: 1px solid var(--color-line);
        }
        .widget-clock .clock-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          width: 100%;
          height: 2.8rem;
          border-bottom: 1px solid var(--color-line);
          text-align: left;
        }
        .widget-clock .clock-row:last-child { border-bottom: none; }
        .widget-clock .clock-row:hover .clock-row__value { color: var(--color-ink); }
        .widget-clock .clock-row__value {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: var(--text-xs);
          color: var(--color-ink-muted);
        }
        .widget-clock .clock-row__value.is-active { color: var(--color-ink); }
        .widget-clock .clock-ring {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          padding-top: 1rem;
          border-top: 1px solid var(--color-accent);
        }
        .widget-clock .clock-ring .label { color: var(--color-accent); }
        .widget-clock .clock-ring .button-primary { height: 2.8rem; padding: 0 1.2rem; }
        .widget-clock.expanded .clock-status,
        .widget-clock.expanded .clock-ring { max-width: 48rem; width: 100%; margin: 0 auto; }

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
        .clock-dialog .error { margin: 0; font-size: var(--text-xs); color: var(--color-accent); }
        .clock-dialog .form-actions__spacer { flex: 1; }
      </style>
      <div class="block-header">
        <p class="block-header__label">Clock</p>
        <div class="block-header__actions">
          <button class="zoom-button" type="button" aria-label="Expand Clock"><span class="icon icon--zoom" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="clock-container" id="clock-time">
        <span class="clock-text numeral">
          <time id="clock-text">--:--:--</time>
          <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
        </span>
      </div>
      ${state.ringing ? this.renderRinging(state.ringing) : this.renderStatus(state, now)}
      ${this.openDialog === 'alarm' ? this.renderAlarmDialog(state.alarm) : ''}
      ${this.openDialog === 'timer' ? this.renderTimerDialog(state.timer, now) : ''}
    `;

    const dialog = typeof this.querySelector === 'function' ? this.querySelector('dialog') : null;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }

  renderStatus(state, now) {
    const { alarm, timer } = state;
    const timerActive = timer.state !== 'idle';
    const timerValue = timer.state === 'paused'
      ? `${formatCountdown(timerRemaining(timer, now))} ‖`
      : formatCountdown(timerRemaining(timer, now));
    return `
      <div class="clock-status">
        <button type="button" class="clock-row" data-action="open-alarm" aria-label="Alarm: ${alarm.enabled ? escapeHtml(alarm.time) : 'off'}">
          <span class="label">Alarm</span>
          <span class="clock-row__value${alarm.enabled ? ' is-active' : ''}">${alarm.enabled ? escapeHtml(alarm.time) : 'Off'}</span>
        </button>
        <button type="button" class="clock-row" data-action="open-timer" aria-label="Timer">
          <span class="label">Timer</span>
          <span class="clock-row__value timer-readout${timerActive ? ' is-active' : ''}">${timerActive ? timerValue : 'Set'}</span>
        </button>
      </div>
    `;
  }

  renderRinging(ringing) {
    return `
      <div class="clock-ring" role="alert">
        <span class="label">${escapeHtml(ringing.label)}</span>
        <button type="button" class="button-primary" data-action="dismiss">Dismiss</button>
      </div>
    `;
  }

  renderAlarmDialog(alarm) {
    return `
      <dialog class="dialog clock-dialog" aria-labelledby="clock-alarm-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="clock-alarm-title">Alarm</h2>
          <button type="button" class="zoom-button" data-action="close-dialog" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" data-form="alarm">
          <label class="field">
            <span class="label">Time · rings daily</span>
            <input type="time" name="time" class="input" value="${escapeHtml(alarm.time)}" required autofocus>
          </label>
          <div class="form-actions">
            ${alarm.enabled ? '<button type="button" class="action-button action-button--danger" data-action="alarm-off">Turn off</button><span class="form-actions__spacer"></span>' : ''}
            <button type="button" class="button-secondary" data-action="close-dialog">Cancel</button>
            <button type="submit" class="button-primary">${alarm.enabled ? 'Update' : 'Set alarm'}</button>
          </div>
        </form>
      </dialog>
    `;
  }

  renderTimerDialog(timer, now) {
    const idle = timer.state === 'idle';
    const totalSec = Math.round((timer.durationMs || DEFAULT_TIMER_MS) / 1000);
    const draft = this.timerDraft || { minutes: Math.floor(totalSec / 60), seconds: totalSec % 60 };
    const body = idle
      ? `
        <div class="presets" role="group" aria-label="Presets">
          ${TIMER_PRESETS_MIN.map(m => `<button type="button" class="button-secondary" data-action="preset" data-minutes="${m}">${m} min</button>`).join('')}
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
        ${this.dialogError ? `<p class="error" role="alert">${escapeHtml(this.dialogError)}</p>` : ''}
        <div class="form-actions">
          <button type="button" class="button-secondary" data-action="close-dialog">Cancel</button>
          <button type="submit" class="button-primary">Start</button>
        </div>`
      : `
        <p class="big-readout timer-readout" aria-live="off">${formatCountdown(timerRemaining(timer, now))}</p>
        <p class="label">${timer.state === 'paused' ? 'Paused' : 'Running'} · of ${formatCountdown(timer.durationMs)}</p>
        <div class="form-actions">
          <button type="button" class="action-button action-button--danger" data-action="timer-reset">Reset</button>
          <span class="form-actions__spacer"></span>
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
        this.setState({ ringing: null });
        return;
      case 'alarm-off':
        this.setState({ alarm: { ...state.alarm, enabled: false } });
        return this.closeDialog();
      case 'preset': {
        const minutes = Number(btn.dataset.minutes);
        this.setState({ timer: startTimer(resetTimer(minutes * 60 * 1000), now) });
        return this.closeDialog();
      }
      case 'timer-pause':
        this.setState({ timer: pauseTimer(state.timer, now) });
        return this.render();
      case 'timer-resume':
        this.setState({ timer: startTimer(state.timer, now) });
        return this.render();
      case 'timer-reset':
        this.setState({ timer: resetTimer(state.timer.durationMs) });
        return this.render();
    }
  }

  handleSubmit(e) {
    const form = e.target;
    if (!form || !form.dataset || !form.dataset.form) return;
    e.preventDefault();
    unlockAudio();
    const now = Date.now();
    const data = new FormData(form);

    if (form.dataset.form === 'alarm') {
      const time = String(data.get('time') || '');
      if (!time) return;
      this.setState({ alarm: armAlarm(time, now) });
      this.closeDialog();
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
      this.setState({ timer: startTimer(resetTimer(durationMs), now) });
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

    if (!state.ringing && alarmDue(state.alarm, now)) {
      this.setState({
        alarm: { ...state.alarm, lastFiredDate: localDateKey(now) },
        ringing: { kind: 'alarm', label: `Alarm · ${state.alarm.time}`, since: now },
      });
      if (this.openDialog) this.render();
      return;
    }

    if (timerFinished(state.timer, now)) {
      this.setState({
        timer: resetTimer(state.timer.durationMs),
        ringing: { kind: 'timer', label: 'Timer done', since: now },
      });
      if (this.openDialog) this.render();
      return;
    }

    if (state.timer.state === 'running' && typeof this.querySelectorAll === 'function') {
      const text = formatCountdown(timerRemaining(state.timer, now));
      this.querySelectorAll('.timer-readout').forEach(el => { el.textContent = text; });
    }

    if (state.ringing && now - state.ringing.since < RING_SOUND_MS) beep();
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('widget-clock', ClockWidget);
  } catch (e) {
    // ignore re-registration error
  }
}
