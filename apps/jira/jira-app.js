import { configManager } from '../../core/config.js';
import { storage } from '../../core/storage.js';
import { escapeHtml, safeHref, expandButton } from '../../core/html.js';
import { registerCommands } from '../../core/commands.js';
import {
  DEFAULT_JQL, DEFAULT_LABEL, MAX_RESULTS, normalizeSite, isValidCloudId, issueUrl, clampMax,
  resolveJiraSettings, searchUrl, tenantInfoUrl, cloudIdFromTenantInfo, authHeader,
  parseSearchResponse, classifyHttpFailure, failureInfo, needsSetup, cacheMatches,
  relativeTime, refreshDue,
} from './jira-logic.js';

const CACHE_KEY = 'app:jira:cache';
const REFRESH_CHECK_MS = 30 * 1000;

// Results as plain tagged data (see jira-logic.js for the failure reasons).
const Ok = (value) => ({ _tag: 'Ok', value });
const Err = (error) => ({ _tag: 'Err', error });

const FIELD_IDS = { site: 'jira-site', email: 'jira-email', token: 'jira-token', cloudId: 'jira-cloudid', jql: 'jira-jql', label: 'jira-label', max: 'jira-max' };

export class JiraApp extends HTMLElement {
  constructor() {
    super();
    this.configManager = configManager;
    this.storage = storage;
    // { kind: 'idle' } | { kind: 'ok' } | { kind: 'error', error: { reason, message? } }
    this.status = { kind: 'idle' };
    this.requestSeq = 0;
    this.requestTimeoutMs = 10000;
    this.lastAttemptAt = 0;
    this.failures = 0;
    this.retryAfterMs = 0;
    this.isSetupOpen = false;
    this.isSaving = false;
    this.refreshTimer = null;
    this.unsubscribe = null;
    this.offCommands = null;
    this.settingsKey = null;
  }

  connectedCallback() {
    this.settingsKey = JSON.stringify(this.getSecrets());
    if (this.configManager.subscribe) {
      this.unsubscribe = this.configManager.subscribe(() => this.onSettingsChange());
    }
    this.offCommands = registerCommands('jira', () => this.commands());
    this.render();
    this.refreshIfDue();
    this.refreshTimer = setInterval(() => this.refreshIfDue(), REFRESH_CHECK_MS);
  }

  disconnectedCallback() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.offCommands) this.offCommands();
    this.offCommands = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  getSecrets() {
    return this.configManager.getSecret('jira') || {};
  }

  getSettings() {
    return resolveJiraSettings(this.getSecrets());
  }

  queryOf(settings) {
    return { site: settings.site, cloudId: settings.cloudId, jql: settings.jql, max: settings.max };
  }

  /** The cache entry, only if it answers the current settings. */
  getCache(settings = this.getSettings()) {
    const entry = this.storage.get(CACHE_KEY, null);
    return settings.configured && cacheMatches(entry, this.queryOf(settings)) ? entry : null;
  }

  onSettingsChange() {
    const next = JSON.stringify(this.getSecrets());
    if (next === this.settingsKey) return;
    this.settingsKey = next;
    this.status = { kind: 'idle' };
    this.failures = 0;
    this.retryAfterMs = 0;
    if (!this.isSetupOpen) this.render();
    this.refresh();
  }

  commands() {
    const settings = this.getSettings();
    const cache = this.getCache(settings);
    const issues = cache ? cache.issues : [];
    return [
      { title: 'Refresh Jira', hint: 'Jira', keywords: 'jira reload update issues', run: () => this.manualRefresh() },
      { title: 'Jira setup', hint: 'Jira', keywords: 'jira settings token jql', run: () => this.openSetup() },
      ...issues
        .map(issue => ({ issue, url: issueUrl(settings.site, issue.key) }))
        .filter(({ url }) => url)
        .map(({ issue, url }) => ({
          title: `Open ${issue.key}: ${issue.summary}`,
          hint: 'Jira',
          keywords: `${issue.key} ${issue.summary}`,
          run: () => window.open(url, '_blank', 'noopener'),
        })),
    ];
  }

  // ---------- Network ----------

  /** fetch() with its own timeout. */
  async fetchWithTimeout(url, init = {}) {
    if (typeof AbortController === 'undefined') return fetch(url, init);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async search(settings) {
    let res;
    try {
      res = await this.fetchWithTimeout(searchUrl(settings), {
        headers: { Authorization: authHeader(settings.email, settings.token), Accept: 'application/json' },
        credentials: 'omit',
      });
    } catch {
      return Err({ reason: 'network' }); // offline, CORS refusal or timeout
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const error = classifyHttpFailure(res.status, body);
      if (error.reason === 'rate-limited') {
        const seconds = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
        error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : 0;
      }
      return Err(error);
    }
    const issues = parseSearchResponse(body);
    return issues ? Ok(issues) : Err({ reason: 'http' });
  }

  /** Fetch now. Only the latest request may write the cache and status. */
  async refresh(now = Date.now()) {
    const settings = this.getSettings();
    if (!settings.configured) {
      if (!this.isSetupOpen) this.render();
      return;
    }
    const seq = ++this.requestSeq;
    this.lastAttemptAt = now;
    const result = await this.search(settings);
    if (seq !== this.requestSeq) return;

    if (result._tag === 'Ok') {
      this.storage.set(CACHE_KEY, { query: this.queryOf(settings), issues: result.value, fetchedAt: Date.now() });
      this.status = { kind: 'ok' };
      this.failures = 0;
      this.retryAfterMs = 0;
    } else {
      const { retryAfterMs = 0, ...error } = result.error;
      this.status = { kind: 'error', error };
      this.failures += 1;
      this.retryAfterMs = retryAfterMs;
    }
    if (!this.isSetupOpen) this.render();
  }

  /** Periodic check: refresh when due, never while set-up is open or the page is hidden. */
  refreshIfDue(now = Date.now()) {
    if (this.isSetupOpen) return undefined;
    if (typeof document !== 'undefined' && document.hidden) return undefined;
    const settings = this.getSettings();
    if (!settings.configured) return undefined;
    const cache = this.getCache(settings);
    const due = refreshDue({
      fetchedAt: cache ? cache.fetchedAt || 0 : 0,
      lastAttemptAt: this.lastAttemptAt,
      failures: this.failures,
      blocked: this.status.kind === 'error' && needsSetup(this.status.error.reason),
      retryAfterMs: this.retryAfterMs,
    }, now);
    return due ? this.refresh(now) : undefined;
  }

  manualRefresh() {
    if (!this.getSettings().configured) {
      this.openSetup();
      return undefined;
    }
    this.status = { kind: 'idle' };
    this.render();
    return this.refresh();
  }

  /** Look up the site's cloudId (works only if tenant_info allows this origin). */
  async lookupCloudId(site) {
    try {
      const res = await this.fetchWithTimeout(tenantInfoUrl(site), { credentials: 'omit' });
      if (!res.ok) return null;
      return cloudIdFromTenantInfo(await res.json());
    } catch {
      return null;
    }
  }

  /**
   * Validate and store settings. A blank token keeps the stored one; a blank
   * cloudId (or the old one after the site changed) is looked up.
   * Returns Ok() or Err({ field, message }).
   */
  async saveSettings(values) {
    const stored = this.getSecrets();
    const site = normalizeSite(values.site);
    if (!site) return Err({ field: 'site', message: 'Enter your Jira Cloud site, e.g. acme or acme.atlassian.net.' });
    const email = String(values.email || '').trim();
    if (!email) return Err({ field: 'email', message: 'Enter the email of your Atlassian account.' });
    const token = String(values.token || '').trim() || stored.token || '';
    if (!token) return Err({ field: 'token', message: 'Paste a scoped API token (read:jira-work).' });

    let cloudId = String(values.cloudId || '').trim().toLowerCase();
    if (cloudId && site !== normalizeSite(stored.site) && cloudId === String(stored.cloudId || '').toLowerCase()) cloudId = '';
    if (cloudId && !isValidCloudId(cloudId)) {
      return Err({ field: 'cloudId', message: 'A Cloud ID looks like 1324a887-45db-1bf4-1e99-ef0ff456d421.' });
    }
    if (!cloudId) {
      cloudId = await this.lookupCloudId(site);
      if (!cloudId) {
        return Err({ field: 'cloudId', message: `Couldn’t look up the Cloud ID. Open ${tenantInfoUrl(site)} and paste the cloudId value here.` });
      }
    }

    const next = {
      site,
      email,
      token,
      cloudId,
      jql: String(values.jql || '').trim() || DEFAULT_JQL,
      label: String(values.label || '').trim(),
      max: clampMax(values.max),
    };
    const before = this.settingsKey;
    this.configManager.setSecret('jira', next);
    // A real change is picked up by onSettingsChange (when mounted), which refetches.
    if (this.settingsKey === before && this.unsubscribe) this.manualRefresh();
    return Ok(next);
  }

  // ---------- Rendering ----------

  render() {
    const settings = this.getSettings();
    const cache = this.getCache(settings);
    const expanded = !!(this.classList && this.classList.contains && this.classList.contains('expanded'));

    this.innerHTML = `
      <style>
        .app-jira .jira-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: 0.8rem;
        }
        .app-jira .jira-detail { margin: 0; max-width: 44rem; font-size: var(--text-sm); color: var(--color-ink-muted); }
        .app-jira .jira-scroll { flex: 1; min-height: 0; overflow-y: auto; }
        .app-jira .jira-list {
          display: grid;
          grid-template-columns: max-content max-content minmax(0, 1fr) max-content;
          column-gap: 1.2rem;
          list-style: none;
          margin: 0;
          padding: 0;
          border-top: 1px solid var(--color-line);
        }
        .app-jira .jira-row {
          display: grid;
          grid-column: 1 / -1;
          grid-template-columns: subgrid;
          align-items: baseline;
          row-gap: 0.4rem;
          padding: 0.8rem 0;
          border-bottom: 1px solid var(--color-line);
        }
        .app-jira .jira-summary {
          grid-row: 1;
          grid-column: 1 / -1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-base);
        }
        .app-jira .jira-key { grid-row: 2; grid-column: 1; }
        .app-jira .jira-status { grid-row: 2; grid-column: 2; }
        .app-jira .jira-assignee { grid-row: 2; grid-column: 3; }
        .app-jira .jira-updated { grid-row: 2; grid-column: 4; text-align: right; }
        .app-jira .jira-type,
        .app-jira .jira-priority,
        .app-jira .jira-head { display: none; }
        .app-jira .jira-key {
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          letter-spacing: var(--track-meta);
          color: var(--color-ink);
          text-decoration: none;
        }
        .app-jira .jira-key:hover { color: var(--color-accent); text-decoration: underline; }
        .app-jira .jira-key:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
        .app-jira .jira-assignee,
        .app-jira .jira-type,
        .app-jira .jira-priority {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-xs);
          color: var(--color-ink-muted);
        }
        .app-jira .jira-updated { font-size: var(--text-xs); color: var(--color-ink-muted); }
        .app-jira .jira-status {
          justify-self: start;
          max-width: 16rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 0.1rem 0.5rem;
          border: 1px solid var(--color-line-strong);
          border-radius: var(--radius);
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-label);
          text-transform: uppercase;
          color: var(--color-ink-muted);
        }
        .app-jira .jira-status--indeterminate {
          color: var(--color-accent);
          border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
          background: var(--color-accent-wash);
        }
        .app-jira .jira-status--done { color: var(--color-ink-faint); border-color: var(--color-line); }
        .app-jira .jira-empty { display: flex; flex-direction: column; gap: 0.6rem; padding: 2rem 0; }
        .app-jira .jira-empty .jira-detail { font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
        .app-jira .jira-foot {
          flex: none;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.4rem 0.8rem;
          padding-top: 1rem;
        }
        .app-jira .jira-foot .warn { color: var(--color-accent); }
        .app-jira .jira-foot__reason { font-size: var(--text-xs); color: var(--color-ink-muted); }
        .app-jira .jira-foot__count { margin-left: auto; }

        .app-jira.expanded .jira-list {
          grid-template-columns: max-content minmax(0, 1fr) max-content max-content max-content minmax(0, 18rem) max-content;
        }
        .app-jira.expanded .jira-row { padding: 1rem 0; }
        .app-jira.expanded .jira-head { display: grid; padding: 0 0 0.8rem; }
        .app-jira.expanded .jira-head > * { grid-row: 1; }
        .app-jira.expanded .jira-row > * { grid-row: 1; }
        .app-jira.expanded .jira-key { grid-column: 1; }
        .app-jira.expanded .jira-summary { grid-column: 2; }
        .app-jira.expanded .jira-type { display: block; grid-column: 3; }
        .app-jira.expanded .jira-priority { display: block; grid-column: 4; }
        .app-jira.expanded .jira-status { grid-column: 5; }
        .app-jira.expanded .jira-assignee { grid-column: 6; }
        .app-jira.expanded .jira-updated { grid-column: 7; }
        .app-jira.expanded .jira-head .label:last-child { text-align: right; }
        .app-jira.expanded .jira-head > .label {
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--track-label);
          color: var(--color-ink-muted);
          padding: 0;
          border: 0;
          background: none;
        }

        .dialog.jira-dialog { width: min(56rem, calc(100vw - 3.2rem)); }
        .jira-dialog .hint { margin: 0; font-size: var(--text-xs); color: var(--color-ink-muted); }
        .jira-dialog .hint a { color: inherit; }
        .jira-dialog .error { margin: 0; font-size: var(--text-xs); color: var(--color-accent); overflow-wrap: anywhere; }
        .jira-dialog textarea.input { height: auto; min-height: 7.2rem; padding-block: 0.8rem; font-family: var(--font-mono); font-size: var(--text-sm); resize: vertical; }
        .jira-dialog .field-row { display: grid; grid-template-columns: minmax(0, 1fr) 12rem; gap: 1.2rem; }
      </style>
      <div class="block-header">
        <p class="block-header__label">${escapeHtml(settings.label)}</p>
        <div class="block-header__actions">
          <button id="jira-setup-button" class="action-button" type="button" aria-label="Jira setup">Setup</button>
          ${settings.configured ? '<button id="jira-refresh-button" class="action-button" type="button" aria-label="Refresh Jira">Refresh</button>' : ''}
          ${expandButton(settings.label, expanded)}
        </div>
      </div>
      ${this.renderBody(settings, cache)}
      ${this.isSetupOpen ? this.renderSetupDialog(settings) : ''}
    `;
    this.bindEvents();
  }

  renderBody(settings, cache) {
    if (!settings.configured) return this.renderState(failureInfo({ reason: 'unconfigured' }), false);
    if (cache) return this.renderList(settings, cache);
    if (this.status.kind === 'error') return this.renderState(failureInfo(this.status.error), true);
    return '<div class="jira-state" role="status"><p class="label">Loading</p></div>';
  }

  actionButton(info) {
    return info.action === 'setup'
      ? '<button type="button" class="action-button state-setup-button">Open setup</button>'
      : '<button type="button" class="action-button retry-button">Retry</button>';
  }

  renderState(info, isError) {
    return `
      <div class="jira-state"${isError ? ' role="status"' : ''}>
        <p class="label">${escapeHtml(info.label)}</p>
        <p class="jira-detail">${escapeHtml(info.detail)}</p>
        ${this.actionButton(info)}
      </div>`;
  }

  renderList(settings, cache) {
    const now = Date.now();
    const rows = cache.issues.map((issue) => {
      const url = issueUrl(settings.site, issue.key);
      const updated = relativeTime(issue.updated, now);
      const updatedAt = Date.parse(String(issue.updated).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
      const full = Number.isNaN(updatedAt) ? '' : new Date(updatedAt).toLocaleString();
      return `
        <li class="jira-row">
          <a class="jira-key" href="${url ? safeHref(url) : '#'}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>
          <span class="jira-summary" title="${escapeHtml(issue.summary)}">${escapeHtml(issue.summary)}</span>
          <span class="jira-type">${escapeHtml(issue.type)}</span>
          <span class="jira-priority">${escapeHtml(issue.priority)}</span>
          <span class="jira-status jira-status--${escapeHtml(issue.category)}">${escapeHtml(issue.status || 'No status')}</span>
          <span class="jira-assignee">${escapeHtml(issue.assignee || 'Unassigned')}</span>
          <time class="jira-updated num" datetime="${escapeHtml(issue.updated)}" title="${escapeHtml(full)}">${escapeHtml(updated)}</time>
        </li>`;
    }).join('');

    const list = cache.issues.length
      ? `<ul class="jira-list" aria-label="Issues">
          <li class="jira-row jira-head" aria-hidden="true">
            <span class="label jira-key">Key</span><span class="label jira-summary">Summary</span><span class="label jira-type">Type</span>
            <span class="label jira-priority">Priority</span><span class="label jira-status">Status</span><span class="label jira-assignee">Assignee</span>
            <span class="label jira-updated">Updated</span>
          </li>${rows}
        </ul>`
      : `<div class="jira-empty"><p class="label">No issues match</p><p class="jira-detail">${escapeHtml(settings.jql)}</p></div>`;

    const time = cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const failed = this.status.kind === 'error';
    const info = failed ? failureInfo(this.status.error) : null;
    const count = cache.issues.length;
    return `
      <div class="jira-scroll">${list}</div>
      <div class="jira-foot" role="status">
        <span class="label">As of <span class="num">${escapeHtml(time)}</span>${failed ? ' · <span class="warn">Update failed</span>' : ''}</span>
        ${failed ? `<span class="jira-foot__reason" title="${escapeHtml(info.detail)}">${escapeHtml(info.label)}</span>${this.actionButton(info)}` : ''}
        ${failed ? '' : `<span class="label jira-foot__count"><span class="num">${count}</span> ${count === 1 ? 'issue' : 'issues'}</span>`}
      </div>`;
  }

  renderSetupDialog(settings) {
    const s = this.getSecrets();
    const field = (name, label, input, hint = '') => `
      <label class="field">
        <span class="label">${label}</span>
        ${input}
        ${hint ? `<p class="hint" id="${FIELD_IDS[name]}-hint">${hint}</p>` : ''}
        <p class="error" id="${FIELD_IDS[name]}-error" role="alert" hidden></p>
      </label>`;
    const describe = (name, hint) => `aria-describedby="${hint ? `${FIELD_IDS[name]}-hint ` : ''}${FIELD_IDS[name]}-error"`;
    return `
      <dialog class="dialog jira-dialog" aria-labelledby="jira-setup-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="jira-setup-title">Jira setup</h2>
          <button type="button" class="zoom-button" id="jira-close" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" id="jira-setup-form" novalidate>
          ${field('site', 'Site', `<input type="text" id="jira-site" class="input" autofocus spellcheck="false" placeholder="acme.atlassian.net" value="${escapeHtml(settings.site || s.site || '')}" ${describe('site', true)}>`, 'Your Jira Cloud site: acme, acme.atlassian.net or any URL on it.')}
          ${field('email', 'Email', `<input type="email" id="jira-email" class="input" autocomplete="email" spellcheck="false" value="${escapeHtml(settings.email)}" ${describe('email', false)}>`)}
          ${field('token', 'API token', `<input type="password" id="jira-token" class="input" autocomplete="off" spellcheck="false" placeholder="${settings.token ? 'Saved · leave blank to keep' : ''}" ${describe('token', true)}>`,
            'Use a scoped token: id.atlassian.com → Security → API tokens → <b>Create API token with scopes</b> → Jira → <code>read:jira-work</code>. Scoped tokens expire (1 day to 1 year). The token is stored in this browser (localStorage) and included in backups.')}
          ${field('cloudId', 'Cloud ID', `<input type="text" id="jira-cloudid" class="input" spellcheck="false" placeholder="Looked up on save" value="${escapeHtml(settings.cloudId)}" ${describe('cloudId', true)}>`, 'Leave blank to look it up. If that fails, open https://&lt;site&gt;/_edge/tenant_info and copy <code>cloudId</code>.')}
          ${field('jql', 'JQL', `<textarea id="jira-jql" class="input" rows="3" spellcheck="false" ${describe('jql', false)}>${escapeHtml(settings.jql)}</textarea>`)}
          <div class="field-row">
            ${field('label', 'Header label', `<input type="text" id="jira-label" class="input" placeholder="${escapeHtml(DEFAULT_LABEL)}" value="${escapeHtml(s.label || '')}" ${describe('label', false)}>`)}
            ${field('max', 'Max results', `<input type="number" id="jira-max" class="input num" min="1" max="${MAX_RESULTS}" step="1" value="${escapeHtml(settings.max)}" ${describe('max', false)}>`)}
          </div>
          <div class="form-actions">
            <button type="button" id="jira-cancel" class="button-secondary">Cancel</button>
            <button type="submit" id="jira-save" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>`;
  }

  // ---------- Events ----------

  bindEvents() {
    if (typeof this.querySelector !== 'function') return;
    const on = (sel, fn) => {
      const el = this.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    };
    on('#jira-setup-button', (e) => { e.stopPropagation(); this.openSetup(); });
    on('.state-setup-button', (e) => { e.stopPropagation(); this.openSetup(); });
    on('#jira-refresh-button', () => this.manualRefresh());
    on('.retry-button', () => this.manualRefresh());
    if (this.isSetupOpen) this.bindSetupDialog();
  }

  openSetup() {
    this.isSetupOpen = true;
    this.isSaving = false;
    this.render();
  }

  closeSetup() {
    this.isSetupOpen = false;
    this.isSaving = false;
    this.render();
    const btn = typeof this.querySelector === 'function' ? this.querySelector('#jira-setup-button') : null;
    if (btn && btn.focus) btn.focus();
  }

  readSetupForm() {
    const value = (name) => {
      const el = this.querySelector(`#${FIELD_IDS[name]}`);
      return el ? el.value : '';
    };
    return Object.fromEntries(Object.keys(FIELD_IDS).map(name => [name, value(name)]));
  }

  showFieldError(field, message) {
    for (const name of Object.keys(FIELD_IDS)) {
      const error = this.querySelector(`#${FIELD_IDS[name]}-error`);
      const input = this.querySelector(`#${FIELD_IDS[name]}`);
      const isIt = name === field;
      if (error) {
        error.textContent = isIt ? message : '';
        error.hidden = !isIt;
      }
      if (input) {
        if (isIt) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
    }
    const input = this.querySelector(`#${FIELD_IDS[field]}`);
    if (input && input.focus) input.focus();
  }

  async submitSetup() {
    if (this.isSaving) return;
    this.isSaving = true;
    const save = this.querySelector('#jira-save');
    if (save) {
      save.disabled = true;
      save.textContent = 'Saving…';
    }
    const result = await this.saveSettings(this.readSetupForm());
    if (!this.isSetupOpen) return;
    if (result._tag === 'Ok') {
      this.closeSetup();
      return;
    }
    this.isSaving = false;
    if (save) {
      save.disabled = false;
      save.textContent = 'Save';
    }
    this.showFieldError(result.error.field, result.error.message);
  }

  bindSetupDialog() {
    const dialog = this.querySelector('.jira-dialog');
    if (dialog) {
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        this.closeSetup();
      });
      // Escape closes the dialog only, not an expanded module behind it.
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') e.stopPropagation();
      });
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) this.closeSetup();
      });
    }
    const form = this.querySelector('#jira-setup-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitSetup();
      });
    }
    for (const sel of ['#jira-cancel', '#jira-close']) {
      const btn = this.querySelector(sel);
      if (btn) btn.addEventListener('click', () => this.closeSetup());
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('app-jira', JiraApp);
  } catch (e) { }
}
