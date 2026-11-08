import { storage } from '../../core/storage.js';
import { escapeHtml, expandButton } from '../../core/html.js';
import { registerCommands } from '../../core/commands.js';
import {
  Err, parseAmount, parseRates, parseNames, crossRate, convert, formatMoney, formatRate,
  formatAmount, formatRateDate, parseQuery, normalizePrefs, needsRefresh, retryDelay, CHECK_MS,
} from './currency-logic.js';

// ECB reference rates through Frankfurter (free, no key, CORS). One request
// against the ECB's own base (EUR); every other pair is a cross rate.
export const RATES_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates';
export const NAMES_URL = 'https://api.frankfurter.dev/v2/currencies';

const PREFS_KEY = 'app:currency';
const RATES_KEY = 'app:currency:rates';
const NAMES_KEY = 'app:currency:names';
const NAMES_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// What the module says for each failure reason.
const FAILURES = {
  network: 'Can’t reach the rates service',
  timeout: 'Rates service timed out',
  http: 'Rates service unavailable',
  'bad-response': 'Rates service unavailable',
};

export class CurrencyApp extends HTMLElement {
  constructor() {
    super();
    this.storage = storage;
    this.locale = undefined; // the browser's; tests pin one
    // { kind: 'idle' | 'loading' | 'ok' } | { kind: 'error', reason }
    this.status = { kind: 'idle' };
    this.requestSeq = 0;
    this.requestTimeoutMs = 5000;
    this.inFlight = false;
    this.failures = 0;
    this.retryAt = 0;
    this.timer = null;
    this.connected = false;
    this.unsubscribes = [];
    // Prefs as currently shown (own typing updates it; other tabs' changes wait while typing).
    this.shown = normalizePrefs(null);
    this.pendingRender = false;
    this.writing = false;
    this.renderedKey = '';
    this.onEvent = (e) => this.handleEvent(e);
  }

  connectedCallback() {
    this.connected = true;
    if (this.storage.subscribe) {
      this.unsubscribes = [PREFS_KEY, RATES_KEY, NAMES_KEY].map(key => this.storage.subscribe(key, () => this.onStoredChange()));
    }
    if (this.addEventListener) {
      for (const type of ['input', 'change', 'click', 'focusout']) this.addEventListener(type, this.onEvent);
    }
    this.offCommands = registerCommands('currency', (query) => this.commands(query));
    this.render();
    this.refreshIfStale();
    this.fetchNamesIfMissing();
    this.scheduleCheck();
  }

  disconnectedCallback() {
    this.connected = false;
    this.unsubscribes.forEach(off => off && off());
    this.unsubscribes = [];
    if (this.removeEventListener) {
      for (const type of ['input', 'change', 'click', 'focusout']) this.removeEventListener(type, this.onEvent);
    }
    if (this.offCommands) this.offCommands();
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- State ----------

  getPrefs() {
    return normalizePrefs(this.storage.get(PREFS_KEY, null));
  }

  getRates() {
    const cache = this.storage.get(RATES_KEY, null);
    return cache && cache.rates && typeof cache.rates === 'object' ? cache : null;
  }

  getNames() {
    const entry = this.storage.get(NAMES_KEY, null);
    return (entry && entry.names && typeof entry.names === 'object') ? entry.names : {};
  }

  codes() {
    const rates = this.getRates();
    return rates ? Object.keys(rates.rates).filter(c => /^[A-Z]{3}$/.test(c)).sort() : [];
  }

  // Own writes render explicitly, so the subscription skips them.
  writePrefs(changes) {
    const next = normalizePrefs({ ...this.getPrefs(), ...changes });
    this.writing = true;
    try {
      this.storage.set(PREFS_KEY, next);
    } finally {
      this.writing = false;
    }
    return next;
  }

  setAmount(text) {
    const next = this.writePrefs({ amount: String(text ?? '') });
    if (this.isTypingAmount()) {
      this.shown = { ...this.shown, amount: next.amount };
      this.updateOutputs();
    } else {
      this.refresh();
    }
  }

  setFrom(code) {
    const prefs = this.getPrefs();
    if (code === prefs.to) this.writePrefs({ from: prefs.to, to: prefs.from });
    else this.writePrefs({ from: code });
    this.refresh();
  }

  setTo(code) {
    const prefs = this.getPrefs();
    if (code === prefs.from) this.writePrefs({ from: prefs.to, to: prefs.from });
    else this.writePrefs({ to: code });
    this.refresh();
  }

  swap() {
    const prefs = this.getPrefs();
    this.writePrefs({ from: prefs.to, to: prefs.from });
    this.refresh();
  }

  /** From the palette: { amount: number|null, from, to }; a null amount keeps the typed one. */
  setConversion({ amount, from, to }) {
    this.writePrefs({ from, to, ...(amount === null || amount === undefined ? {} : { amount: String(amount) }) });
    this.refresh();
  }

  addFavorite(code) {
    const prefs = this.getPrefs();
    if (!this.codes().includes(code) || prefs.favorites.includes(code)) return;
    this.writePrefs({ favorites: [...prefs.favorites, code] });
    this.refresh();
  }

  removeFavorite(code) {
    const prefs = this.getPrefs();
    this.writePrefs({ favorites: prefs.favorites.filter(c => c !== code) });
    this.refresh();
  }

  // ---------- Cross-tab ----------

  isTypingAmount() {
    if (typeof document === 'undefined' || !document.activeElement) return false;
    const el = document.activeElement;
    return !!(el.classList && el.classList.contains('currency-amount') && this.contains && this.contains(el));
  }

  onStoredChange() {
    if (this.writing) return;
    if (this.isTypingAmount()) {
      this.pendingRender = true;
      return;
    }
    this.refresh();
  }

  onAmountBlur() {
    if (!this.pendingRender) return;
    this.pendingRender = false;
    this.refresh();
  }

  // ---------- Network ----------

  /** fetch() with its own timeout. */
  async fetchWithTimeout(url) {
    if (typeof AbortController === 'undefined') return fetch(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Stale-while-revalidate: fetch when the rates are ~6 h old, unless backing off after a failure. */
  refreshIfStale(now = Date.now()) {
    if (this.inFlight || now < this.retryAt) return undefined;
    if (!needsRefresh(this.getRates(), now)) return undefined;
    return this.fetchRates(now);
  }

  retry() {
    this.retryAt = 0;
    return this.fetchRates();
  }

  async fetchRates(now = Date.now()) {
    const seq = ++this.requestSeq;
    this.inFlight = true;
    if (!this.getRates()) {
      this.status = { kind: 'loading' };
      this.refreshView();
    }
    let result;
    try {
      const res = await this.fetchWithTimeout(RATES_URL);
      result = res.ok ? parseRates(await res.json()) : Err('http');
    } catch (err) {
      const name = err && err.name;
      result = Err(name === 'AbortError' ? 'timeout' : name === 'SyntaxError' ? 'bad-response' : 'network');
    }
    // A newer request (Retry, a later check) owns the cache and status now.
    if (seq !== this.requestSeq) return;
    this.inFlight = false;

    if (result._tag === 'Ok') {
      this.failures = 0;
      this.retryAt = 0;
      this.status = { kind: 'ok' };
      this.storage.set(RATES_KEY, { ...result.value, fetchedAt: Date.now() });
    } else {
      this.failures += 1;
      this.retryAt = now + retryDelay(this.failures);
      this.status = { kind: 'error', reason: result.error.reason };
    }
    this.refreshView();
    this.scheduleCheck();
  }

  // Names are a nicety: a failure just leaves codes without names.
  async fetchNamesIfMissing(now = Date.now()) {
    const entry = this.storage.get(NAMES_KEY, null);
    if (entry && entry.names && now - (entry.fetchedAt || 0) < NAMES_MAX_AGE_MS) return;
    try {
      const res = await this.fetchWithTimeout(NAMES_URL);
      if (!res.ok) return;
      const names = parseNames(await res.json());
      if (Object.keys(names).length) this.storage.set(NAMES_KEY, { names, fetchedAt: Date.now() });
    } catch (err) {
      console.warn('[currency] currency names unavailable:', err && err.message);
    }
  }

  // Check hourly while open; after a failure, at the backoff time instead.
  scheduleCheck() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.connected) return;
    const delay = this.failures ? Math.max(1000, this.retryAt - Date.now()) : CHECK_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshIfStale();
      if (!this.inFlight) this.scheduleCheck();
    }, delay);
  }

  // A status change while typing waits like other changes do.
  refreshView() {
    if (this.isTypingAmount()) this.pendingRender = true;
    else this.refresh();
  }

  // ---------- Palette ----------

  commands(query) {
    const list = [{ title: 'Swap currencies', hint: 'Currency', keywords: 'currency exchange swap', run: () => this.swap() }];
    const parsed = parseQuery(query, this.codes());
    if (parsed) {
      const amount = parsed.amount ?? parseAmount(this.getPrefs().amount) ?? 1;
      const result = convert(amount, this.getRates(), parsed.from, parsed.to);
      list.push({
        title: `${formatAmount(amount, this.locale)} ${parsed.from} = ${formatMoney(result, parsed.to, this.locale)} ${parsed.to}`,
        hint: 'Currency',
        dynamic: true,
        run: () => this.setConversion(parsed),
      });
    }
    return list;
  }

  // ---------- Events ----------

  handleEvent(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (e.type === 'input' && t.classList.contains('currency-amount')) {
      this.setAmount(t.value);
    } else if (e.type === 'focusout' && t.classList.contains('currency-amount')) {
      this.onAmountBlur();
    } else if (e.type === 'change' && t.dataset.field === 'from') {
      this.setFrom(t.value);
    } else if (e.type === 'change' && t.dataset.field === 'to') {
      this.setTo(t.value);
    } else if (e.type === 'click') {
      const btn = t.closest('[data-action]');
      if (!btn || !this.contains(btn)) return;
      const action = btn.dataset.action;
      if (action === 'swap') this.swap();
      else if (action === 'retry') this.retry();
      else if (action === 'add-favorite') {
        const select = this.querySelector('[data-field="add-favorite"]');
        if (select && select.value) this.addFavorite(select.value);
        const again = this.querySelector('[data-field="add-favorite"]');
        if (again) again.focus();
      } else if (action === 'remove-favorite') {
        const buttons = [...this.querySelectorAll('[data-action="remove-favorite"]')];
        const index = buttons.indexOf(btn);
        this.removeFavorite(btn.dataset.code);
        const rest = this.querySelectorAll('[data-action="remove-favorite"]');
        const next = rest[Math.min(index, rest.length - 1)] || this.querySelector('[data-field="add-favorite"]');
        if (next) next.focus();
      }
    }
  }

  // ---------- Rendering ----------

  // Patch the converter in place when its structure is unchanged (keeps focus
  // and lets the live region announce); otherwise render from scratch.
  refresh() {
    const canPatch = typeof this.querySelector === 'function' && this.querySelector('.currency-converter')
      && this.renderedKey === this.structureKey();
    if (!canPatch) {
      this.render();
      return;
    }
    this.shown = this.getPrefs();
    const amountInput = this.querySelector('.currency-amount');
    if (amountInput && !this.isTypingAmount() && amountInput.value !== this.shown.amount) amountInput.value = this.shown.amount;
    for (const field of ['from', 'to']) {
      const select = this.querySelector(`[data-field="${field}"]`);
      if (select) select.value = this.shown[field];
    }
    this.updateOutputs();
  }

  // What the patchable markup depends on: the state shown and the currency list.
  structureKey() {
    const rates = this.getRates();
    if (!rates) return `state:${this.status.kind}:${this.status.reason || ''}`;
    const prefs = this.getPrefs();
    return `converter:${this.selectCodes(prefs).join(',')}`;
  }

  selectCodes(prefs) {
    return [...new Set([...this.codes(), prefs.from, prefs.to])].sort();
  }

  updateOutputs() {
    if (typeof this.querySelector !== 'function') return;
    const rates = this.getRates();
    if (!rates) return;
    const parts = this.outputParts(this.shown, rates);
    const set = (sel, html) => {
      const el = this.querySelector(sel);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    set('.currency-result', parts.result);
    set('.currency-meta', parts.meta);
    set('.currency-favorites-wrap', parts.favorites);
    const amountInput = this.querySelector('.currency-amount');
    if (amountInput) amountInput.setAttribute('aria-invalid', parts.invalid ? 'true' : 'false');
  }

  outputParts(prefs, rates) {
    const { from, to } = prefs;
    const amount = parseAmount(prefs.amount);
    const invalid = amount === null && prefs.amount.trim() !== '';
    const value = convert(amount, rates, from, to);
    const shown = formatMoney(value, to, this.locale);
    const result = `<span class="currency-result__value numeral">${escapeHtml(shown)}</span>${shown
      ? `<span class="currency-result__code">${escapeHtml(to)}</span><span class="currency-sr"> · ${escapeHtml(formatAmount(amount, this.locale))} ${escapeHtml(from)}</span>`
      : ''}`;

    const unit = crossRate(rates, from, to);
    const failed = this.status.kind === 'error';
    const meta = [
      unit === null ? '' : `<span class="num">1 ${escapeHtml(from)} = ${escapeHtml(formatRate(unit, this.locale))} ${escapeHtml(to)}</span>`,
      `ECB · <span class="num">${escapeHtml(formatRateDate(rates.date, this.locale))}</span>`,
      failed ? '<span class="currency-warn">Update failed</span>' : '',
    ].filter(Boolean).join(' · ');

    return { result, meta, favorites: this.favoritesHtml(prefs, rates, amount), invalid };
  }

  favoritesHtml(prefs, rates, amount) {
    const names = this.getNames();
    const rows = prefs.favorites.filter(code => code !== prefs.from).map(code => {
      const value = formatMoney(convert(amount, rates, prefs.from, code), code, this.locale);
      const c = escapeHtml(code);
      return `
        <li class="currency-fav" data-favorite="${c}">
          <span class="currency-fav__code num">${c}</span>
          <span class="currency-fav__name">${escapeHtml(names[code] || '')}</span>
          <span class="currency-fav__value num">${escapeHtml(value)}</span>
          <button type="button" class="action-button action-button--danger currency-fav__remove" data-action="remove-favorite" data-code="${c}" aria-label="Remove ${c} from favourites">Remove</button>
        </li>`;
    }).join('');
    const addable = this.codes().filter(code => !prefs.favorites.includes(code));
    const options = addable.map(code => `<option value="${escapeHtml(code)}">${escapeHtml(code)}${names[code] ? ` · ${escapeHtml(names[code])}` : ''}</option>`).join('');
    return `
      ${rows ? `<ul class="currency-favorites">${rows}</ul>` : '<p class="label empty-state">No favourites</p>'}
      ${addable.length ? `
      <div class="currency-add">
        <label class="field">
          <span class="label">Add favourite</span>
          <select class="select" data-field="add-favorite">${options}</select>
        </label>
        <button type="button" class="button-secondary" data-action="add-favorite">Add</button>
      </div>` : ''}`;
  }

  stateHtml() {
    if (this.status.kind === 'error') {
      return `
        <div class="currency-state" role="status">
          <p class="label">${escapeHtml(FAILURES[this.status.reason] || FAILURES.network)}</p>
          <p class="currency-state__hint">Exchange rates come from the ECB via Frankfurter and need a connection the first time.</p>
          <button type="button" class="action-button retry-button" data-action="retry">Retry</button>
        </div>`;
    }
    return `
      <div class="currency-state" role="status">
        <p class="label">Loading rates</p>
      </div>`;
  }

  converterHtml(prefs, rates) {
    const names = this.getNames();
    const parts = this.outputParts(prefs, rates);
    const options = (selected) => this.selectCodes(prefs)
      .map(code => `<option value="${escapeHtml(code)}"${code === selected ? ' selected' : ''}>${escapeHtml(code)}</option>`).join('');
    const title = (code) => (names[code] ? ` title="${escapeHtml(names[code])}"` : '');
    return `
      <div class="currency-converter">
        <div class="currency-controls">
          <label class="field currency-field-amount">
            <span class="label">Amount</span>
            <input type="text" class="input currency-amount num" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escapeHtml(prefs.amount)}" aria-invalid="${parts.invalid ? 'true' : 'false'}">
          </label>
          <label class="field">
            <span class="label">From</span>
            <select class="select currency-select" data-field="from"${title(prefs.from)}>${options(prefs.from)}</select>
          </label>
          <button type="button" class="currency-swap" data-action="swap" aria-label="Swap currencies" title="Swap currencies"><span aria-hidden="true">⇄</span></button>
          <label class="field">
            <span class="label">To</span>
            <select class="select currency-select" data-field="to"${title(prefs.to)}>${options(prefs.to)}</select>
          </label>
        </div>
        <div class="currency-result" aria-live="polite" aria-atomic="true">${parts.result}</div>
        <p class="currency-meta label">${parts.meta}</p>
        <section class="currency-expanded" aria-label="Favourites">
          <p class="label currency-section-label">Favourites</p>
          <div class="currency-favorites-wrap">${parts.favorites}</div>
        </section>
      </div>`;
  }

  render() {
    const prefs = this.getPrefs();
    const rates = this.getRates();
    this.shown = prefs;
    // Re-rendering replaces the controls; put focus back on the same one.
    const active = typeof document !== 'undefined' && document.activeElement && this.contains && this.contains(document.activeElement)
      ? document.activeElement : null;
    const focusSel = active && (active.dataset.field ? `[data-field="${active.dataset.field}"]`
      : active.dataset.action ? `[data-action="${active.dataset.action}"]`
      : active.classList.contains('currency-amount') ? '.currency-amount' : null);

    this.innerHTML = `
      <style>
        .app-currency .currency-converter { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .app-currency .currency-controls {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 7.6rem) 2.4rem minmax(0, 7.6rem);
          gap: 0.6rem;
          align-items: end;
        }
        .app-currency .currency-amount { text-align: right; font-family: var(--font-mono); }
        .app-currency .currency-amount[aria-invalid="true"] { border-color: var(--color-accent); }
        .app-currency .currency-select { padding-left: 0.8rem; padding-right: 2.4rem; background-position: right 0.4rem center; }
        .app-currency .currency-swap {
          height: var(--control-height);
          color: var(--color-ink-muted);
          font-size: var(--text-md);
          transition: color var(--duration) var(--ease);
        }
        .app-currency .currency-swap:hover { color: var(--color-ink); }
        .app-currency .currency-result {
          display: flex;
          align-items: baseline;
          gap: 0.8rem;
          min-height: var(--text-xl);
          margin-top: auto;
          padding-top: 1rem;
          line-height: 1;
        }
        .app-currency .currency-result__value {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-xl);
          letter-spacing: var(--track-tight);
          color: var(--color-ink);
        }
        .app-currency .currency-result__code {
          font-family: var(--font-mono);
          font-size: var(--text-sm);
          letter-spacing: var(--track-meta);
          color: var(--color-ink-muted);
        }
        .app-currency .currency-sr {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }
        .app-currency .currency-meta { margin-top: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .app-currency .currency-warn { color: var(--color-accent); }
        .app-currency .currency-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: 0.8rem;
        }
        .app-currency .currency-state__hint { margin: 0; font-size: var(--text-xs); color: var(--color-ink-muted); }

        .app-currency .currency-expanded { display: none; }
        .app-currency.expanded .currency-converter { flex: none; max-width: 72rem; }
        .app-currency.expanded .currency-controls { grid-template-columns: minmax(0, 1fr) 12rem 3.2rem 12rem; gap: 1.2rem; }
        .app-currency.expanded .currency-result { margin-top: 2.4rem; }
        .app-currency.expanded .currency-result__value { font-size: var(--text-2xl); }
        .app-currency.expanded .currency-expanded { display: block; margin-top: 3.2rem; }
        .app-currency .currency-section-label { margin-bottom: 1.2rem; }
        .app-currency .currency-favorites { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--color-line); }
        .app-currency .currency-fav {
          display: flex;
          align-items: center;
          gap: 1.6rem;
          min-height: 4.4rem;
          border-bottom: 1px solid var(--color-line);
        }
        .app-currency .currency-fav__code { flex: 0 0 4.8rem; }
        .app-currency .currency-fav__name { flex: 1 1 auto; min-width: 0; color: var(--color-ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .app-currency .currency-fav__value { flex: none; font-size: var(--text-md); }
        .app-currency .currency-fav__remove { flex: none; opacity: 0; transition: opacity var(--duration) var(--ease); }
        .app-currency .currency-fav:hover .currency-fav__remove,
        .app-currency .currency-fav__remove:focus-visible { opacity: 1; }
        @media (hover: none) {
          .app-currency .currency-fav__remove { opacity: 1; }
        }
        .app-currency .currency-add { display: flex; align-items: flex-end; gap: 0.8rem; margin-top: 1.6rem; max-width: 40rem; }
        .app-currency .currency-add .field { flex: 1; min-width: 0; }
      </style>
      <div class="block-header">
        <p class="block-header__label">Currency</p>
        <div class="block-header__actions">
          ${expandButton('Currency', !!this.classList?.contains('expanded'))}
        </div>
      </div>
      ${rates ? this.converterHtml(prefs, rates) : this.stateHtml()}
    `;
    this.renderedKey = this.structureKey();
    this.pendingRender = false;

    if (focusSel && typeof this.querySelector === 'function') {
      const again = this.querySelector(focusSel);
      if (again && again.focus) again.focus();
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-currency', CurrencyApp);
  } catch (e) {}
}
