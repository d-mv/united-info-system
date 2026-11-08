import { configManager, DEFAULT_CONFIG } from '../../core/config.js';
import { storage } from '../../core/storage.js';
import { escapeHtml } from '../../core/html.js';

const DEFAULT_WEATHER = DEFAULT_CONFIG.secrets.weather;

/** Weather settings with every default applied, in one place. */
export function resolveWeatherQuery(secrets = {}) {
  const provider = secrets.provider === 'openweathermap' ? 'openweathermap' : 'openmeteo';
  const city = String(secrets.city || '').trim() || DEFAULT_WEATHER.city;
  const units = secrets.units === 'imperial' ? 'imperial' : 'metric';
  const apiKey = secrets.apiKey || '';
  return { provider, city, units, apiKey, needsKey: provider === 'openweathermap' && !apiKey };
}

// The cache is stamped with the query it answers: { query: {provider, city, units}, reading }.
function cacheMatches(entry, query) {
  if (!entry || !entry.query || !entry.reading) return false;
  return entry.query.provider === query.provider
    && entry.query.units === query.units
    && String(entry.query.city).toLowerCase() === query.city.toLowerCase();
}

// Refetch once the shown reading (or the last failed attempt) is this old.
const REFRESH_MS = 15 * 60 * 1000;
const REFRESH_CHECK_MS = 60 * 1000;

// Adapter results as plain tagged data. Failure reasons:
// 'not-found' | 'bad-key' | 'timeout' | 'http' | 'network'.
const Ok = (value) => ({ _tag: 'Ok', value });
const Err = (reason) => ({ _tag: 'Err', error: { reason } });

// What the widget shows for each failure, and which action fixes it.
const FAILURES = {
  'not-found': { label: 'City not found', action: 'setup' },
  'bad-key': { label: 'API key rejected', action: 'setup' },
  'timeout': { label: 'Weather unavailable', action: 'retry' },
  'http': { label: 'Weather unavailable', action: 'retry' },
  'network': { label: 'Weather unavailable', action: 'retry' },
};

// OpenWeatherMap reports wind in m/s for metric (mph for imperial); we show km/h.
function owmWind(speed, units) {
  if (speed == null) return null;
  return Math.round(units === 'imperial' ? speed : speed * 3.6);
}

// OWM sends UTC instants plus the city's UTC offset (seconds). Convert to the
// city's wall-clock time 'YYYY-MM-DDTHH:MM', the same form Open-Meteo returns.
function owmLocalTime(unixSeconds, tzSeconds = 0) {
  return new Date((unixSeconds + tzSeconds) * 1000).toISOString().slice(0, 16);
}

// Forecast entries carry `dt`; older fixtures only have the UTC `dt_txt`.
function owmEntrySeconds(entry) {
  return entry.dt != null ? entry.dt : Date.parse(`${entry.dt_txt.replace(' ', 'T')}Z`) / 1000;
}

export function mapWmoCodeToCondition(code) {
  if (code === 0) return 'Clear';
  if (code === 1 || code === 2) return 'Partly Cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing Drizzle';
  if (code >= 61 && code <= 65) return 'Rain';
  if (code === 66 || code === 67) return 'Freezing Rain';
  if ((code >= 71 && code <= 75) || code === 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow Showers';
  if (code === 95 || code === 96 || code === 99) return 'Thunderstorm';
  return 'Clear';
}

// Maps our condition strings to the ~13-class Weather Icons subset vendored
// in widgets/weather/font (see docs/v2/dashboard-architecture.md §10).
const CONDITION_ICON_CLASS = {
  'clear': { day: 'wi-day-sunny', night: 'wi-night-clear' },
  'partly cloudy': { day: 'wi-day-cloudy', night: 'wi-night-alt-cloudy' },
  'clouds': { day: 'wi-day-cloudy', night: 'wi-night-alt-cloudy' },
  'overcast': { day: 'wi-cloudy', night: 'wi-cloudy' },
  'fog': { day: 'wi-fog', night: 'wi-fog' },
  'mist': { day: 'wi-fog', night: 'wi-fog' },
  'haze': { day: 'wi-fog', night: 'wi-fog' },
  'drizzle': { day: 'wi-showers', night: 'wi-showers' },
  'freezing drizzle': { day: 'wi-showers', night: 'wi-showers' },
  'rain': { day: 'wi-rain', night: 'wi-rain' },
  'freezing rain': { day: 'wi-rain', night: 'wi-rain' },
  'showers': { day: 'wi-showers', night: 'wi-showers' },
  'snow': { day: 'wi-snow', night: 'wi-snow' },
  'snow showers': { day: 'wi-snow', night: 'wi-snow' },
  'thunderstorm': { day: 'wi-thunderstorm', night: 'wi-thunderstorm' },
  'windy': { day: 'wi-windy', night: 'wi-windy' },
  'squall': { day: 'wi-windy', night: 'wi-windy' },
};

export function getWeatherIconClass(condition, isDay = true) {
  const entry = CONDITION_ICON_CLASS[(condition || '').toLowerCase()] || CONDITION_ICON_CLASS.clear;
  return isDay ? entry.day : entry.night;
}

export class WeatherWidget extends HTMLElement {
  static manifest = {
    id: 'weather',
    type: 'widget',
    cols: 2,
    rows: 2,
    defaultCol: 1,
    defaultRow: 2,
    expandable: true,
  };

  constructor() {
    super();
    this.configManager = configManager;
    this.storage = storage;
    this.isSetupOpen = false;
    // { kind: 'loading' } | { kind: 'ok' } | { kind: 'error', reason }
    this.status = { kind: 'loading' };
    // Only the latest fetch may write the cache and status.
    this.requestSeq = 0;
    this.requestTimeoutMs = 3000;
    this.lastAttemptAt = 0;
    this.refreshTimer = null;
    this.unsubscribe = null;
    this.settingsKey = null;
  }

  connectedCallback() {
    this.settingsKey = JSON.stringify(this.getSecrets());
    // The grid no longer remounts widgets on config writes, so follow our own
    // settings here (same tab and other tabs).
    if (this.configManager.subscribe) {
      this.unsubscribe = this.configManager.subscribe(() => this.onSettingsChange());
    }
    this.render();
    this.refreshIfStale();
    // A start page stays open for hours; keep the reading current.
    this.refreshTimer = setInterval(() => this.refreshIfStale(), REFRESH_CHECK_MS);
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Stale-while-revalidate: fetch only when the shown reading or the last attempt is old. */
  refreshIfStale(now = Date.now()) {
    if (this.isSetupOpen) return undefined;
    const query = this.getQuery();
    if (query.needsKey) return undefined;
    const reading = this.getCachedReading(query);
    const last = Math.max(reading ? reading.fetchedAt || 0 : 0, this.lastAttemptAt);
    if (now - last < REFRESH_MS) return undefined;
    this.lastAttemptAt = now;
    return this.fetchWeatherStaleWhileRevalidate();
  }

  /** fetch() with its own timeout, so each request gets the full budget. */
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

  onSettingsChange() {
    const next = JSON.stringify(this.getSecrets());
    if (next === this.settingsKey) return;
    this.settingsKey = next;
    this.status = { kind: 'loading' };
    if (!this.isSetupOpen) this.render();
    this.fetchWeatherStaleWhileRevalidate();
  }

  getSecrets() {
    return this.configManager.getSecret('weather') || {};
  }

  getQuery() {
    return resolveWeatherQuery(this.getSecrets());
  }

  /** The cached reading, only if it answers the current settings. */
  getCachedReading(query) {
    const entry = this.storage.get('weather:cache', null);
    return cacheMatches(entry, query) ? entry.reading : null;
  }

  render() {
    const query = this.getQuery();
    const cache = this.getCachedReading(query);

    this.innerHTML = `
      <style>
        @font-face {
          font-family: 'weathericons';
          src: url('widgets/weather/font/weathericons-regular-webfont.woff2') format('woff2'),
               url('widgets/weather/font/weathericons-regular-webfont.woff') format('woff');
          font-weight: normal;
          font-style: normal;
          font-display: swap;
        }
        .widget-weather .wi {
          display: inline-block;
          font-family: 'weathericons';
          font-style: normal;
          font-weight: normal;
          line-height: 1;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .widget-weather .wi-day-sunny:before        { content: "\\f00d"; }
        .widget-weather .wi-night-clear:before      { content: "\\f02e"; }
        .widget-weather .wi-day-cloudy:before       { content: "\\f002"; }
        .widget-weather .wi-night-alt-cloudy:before { content: "\\f086"; }
        .widget-weather .wi-cloudy:before           { content: "\\f013"; }
        .widget-weather .wi-fog:before              { content: "\\f014"; }
        .widget-weather .wi-rain:before             { content: "\\f019"; }
        .widget-weather .wi-showers:before          { content: "\\f01a"; }
        .widget-weather .wi-thunderstorm:before     { content: "\\f01e"; }
        .widget-weather .wi-snow:before             { content: "\\f01b"; }
        .widget-weather .wi-windy:before            { content: "\\f021"; }
        .widget-weather .wi-sunrise:before          { content: "\\f051"; }
        .widget-weather .wi-sunset:before           { content: "\\f052"; }

        .widget-weather .primary { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .widget-weather .primary-row { display: flex; align-items: center; gap: 1.2rem; }
        .widget-weather .primary .wi { font-size: 2.4rem; color: var(--color-ink); }
        .widget-weather .primary .numeral {
          font-size: var(--text-xl);
          letter-spacing: var(--track-tight);
          line-height: 1;
        }
        .widget-weather .condition { margin-top: 0.6rem; color: var(--color-ink-muted); font-size: var(--text-sm); }
        .widget-weather .freshness {
          display: flex;
          align-items: center;
          gap: 0.8rem;
          margin-top: auto;
        }
        .widget-weather .freshness .live-dot--stale { background: var(--color-ink-faint); }
        .widget-weather .freshness .warn { color: var(--color-accent); }
        .widget-weather .state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: 0.8rem;
        }

        .widget-weather .weather-expanded { display: none; }
        .widget-weather.expanded .weather-expanded {
          display: flex;
          flex-direction: column;
          gap: 3.2rem;
          margin-top: 3.2rem;
        }
        .widget-weather.expanded .primary { flex: none; }
        .widget-weather.expanded .primary .numeral { font-size: var(--text-2xl); }
        .widget-weather.expanded .primary .wi { font-size: 3.2rem; }
        .widget-weather.expanded .freshness { margin-top: 1.6rem; }
        .widget-weather .section-label { margin-bottom: 1.2rem; }

        .widget-weather .stat-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
          border-top: 1px solid var(--color-line);
        }
        .widget-weather .stat {
          padding: 1.2rem 0;
          border-bottom: 1px solid var(--color-line);
        }
        .widget-weather .stat .label { margin-bottom: 0.6rem; }
        .widget-weather .stat .value { font-size: var(--text-md); }

        .widget-weather .hourly-strip {
          display: flex;
          overflow-x: auto;
          border-top: 1px solid var(--color-line);
          border-bottom: 1px solid var(--color-line);
        }
        .widget-weather .hour {
          flex: 1 0 7.2rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.8rem;
          padding: 1.2rem 0.8rem;
          border-left: 1px solid var(--color-line);
          text-align: center;
        }
        .widget-weather .hour:first-child { border-left: none; }
        .widget-weather .hour .wi { font-size: 2rem; color: var(--color-ink-muted); }
        .widget-weather .hour .value { font-size: var(--text-base); }
        .widget-weather .hour .rain { font-size: var(--text-xs); color: var(--color-ink-muted); min-height: 1.4em; }

        .widget-weather .daily-list { max-width: 64rem; border-top: 1px solid var(--color-line); }
        .widget-weather .day-row {
          display: flex;
          align-items: center;
          gap: 1.6rem;
          min-height: 4.4rem;
          border-bottom: 1px solid var(--color-line);
        }
        .widget-weather .day-name { flex: 0 0 5rem; }
        .widget-weather .day-icon { flex: 0 0 2.4rem; }
        .widget-weather .day-icon .wi { font-size: 1.8rem; color: var(--color-ink-muted); }
        .widget-weather .day-cond { flex: 1 1 auto; color: var(--color-ink-muted); }
        .widget-weather .day-rain { flex: 0 0 5rem; text-align: right; font-size: var(--text-xs); color: var(--color-ink-muted); }
        .widget-weather .day-temps { flex: 0 0 9rem; text-align: right; }
        .widget-weather .day-temps .low { color: var(--color-ink-muted); margin-left: 0.8rem; }

        .widget-weather .setup-dialog .hint { margin: 0; font-size: var(--text-xs); color: var(--color-ink-muted); }
      </style>
      <div class="block-header">
        <p class="block-header__label">Weather</p>
        <div class="block-header__actions">
          <button id="setup-button" class="action-button" type="button" aria-label="Weather setup">Setup</button>
          <button class="zoom-button" type="button" aria-label="Expand Weather"><span class="icon icon--zoom" aria-hidden="true"></span></button>
        </div>
      </div>
      ${cache ? this.renderReadout(cache, query.units) : this.renderState(query.needsKey)}
      ${this.isSetupOpen ? this.renderSetupDialog(query) : ''}
    `;

    this.bindEvents();
  }

  renderState(needsKey) {
    if (needsKey) {
      return `
        <div class="state">
          <p class="label">No API key</p>
          <button type="button" class="action-button state-setup-button">Open setup</button>
        </div>`;
    }
    if (this.status.kind === 'error') {
      const failure = FAILURES[this.status.reason] || FAILURES.network;
      const button = failure.action === 'setup'
        ? '<button type="button" class="action-button state-setup-button">Open setup</button>'
        : '<button type="button" class="action-button retry-button">Retry</button>';
      return `
        <div class="state" role="status">
          <p class="label">${failure.label}</p>
          ${button}
        </div>`;
    }
    return `
      <div class="state" role="status">
        <p class="label">Loading</p>
      </div>`;
  }

  renderReadout(cache, units) {
    const timeStr = cache.fetchedAt
      ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '--:--';
    const iconClass = this.weatherIconClass(cache.condition, cache.fetchedAt, cache.sunrise, cache.sunset);
    const failed = this.status.kind === 'error';

    return `
      <div class="primary">
        <div class="primary-row">
          <i class="wi ${iconClass}" aria-hidden="true"></i>
          <div class="numeral">${escapeHtml(cache.temp)}°</div>
        </div>
        <div class="condition">${escapeHtml(cache.condition)}${cache.city ? ` · ${escapeHtml(cache.city)}` : ''}</div>
        <div class="freshness">
          <span class="label">As of <span class="num">${timeStr}</span>${failed ? ' · <span class="warn">Update failed</span>' : ''}</span>
          <span class="live-dot ${failed ? 'live-dot--stale' : 'live-dot--pulse'}" aria-hidden="true"></span>
        </div>
      </div>
      <div class="weather-expanded">
        ${this.renderExpandedDetails(cache, units)}
      </div>
    `;
  }

  bindEvents() {
    if (typeof this.querySelector !== 'function') return;

    for (const sel of ['#setup-button', '.state-setup-button']) {
      const btn = this.querySelector(sel);
      if (btn) btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSetup();
      });
    }

    const retryBtn = this.querySelector('.retry-button');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      this.status = { kind: 'loading' };
      this.render();
      this.fetchWeatherStaleWhileRevalidate();
    });

    if (this.isSetupOpen) this.bindSetupDialog();
  }

  renderExpandedDetails(cache, units) {
    if (!cache) return '';

    const speedUnit = units === 'imperial' ? 'mph' : 'km/h';
    const tempUnit = units === 'imperial' ? '°F' : '°C';

    const stats = [
      ['Feels Like', cache.feelsLike != null ? `${cache.feelsLike}${tempUnit}` : null],
      ['Humidity', cache.humidity != null ? `${cache.humidity}%` : null],
      ['Wind', cache.windSpeed != null ? `${cache.windSpeed} ${speedUnit}${cache.windDirection != null ? ` ${this.windDirectionLabel(cache.windDirection)}` : ''}` : null],
      ['Wind Gust', cache.windGust != null ? `${cache.windGust} ${speedUnit}` : null],
      ['Pressure', cache.pressure != null ? `${cache.pressure} hPa` : null],
      ['Cloud Cover', cache.cloudCover != null ? `${cache.cloudCover}%` : null],
      ['Precipitation', cache.precipitation != null ? `${cache.precipitation} mm` : null],
      ['UV Index', cache.uvIndex != null ? `${cache.uvIndex}` : null],
      ['Sunrise', cache.sunrise ? this.formatTime(cache.sunrise) : null],
      ['Sunset', cache.sunset ? this.formatTime(cache.sunset) : null],
    ].filter(([, value]) => value != null);

    const statHtml = stats.map(([label, value]) => `
      <div class="stat"><p class="label">${label}</p><div class="value num">${escapeHtml(value)}</div></div>
    `).join('');

    const hourly = Array.isArray(cache.hourly) ? cache.hourly : [];
    const hourlyHtml = hourly.map((hour) => `
      <div class="hour">
        <p class="label num">${escapeHtml(this.formatHourLabel(hour.time))}:00</p>
        <i class="wi ${getWeatherIconClass(hour.condition, this.isDaytime(hour.time, cache.sunrise, cache.sunset))}" aria-label="${escapeHtml(hour.condition)}"></i>
        <div class="value num">${hour.temp != null ? `${escapeHtml(hour.temp)}°` : '--'}</div>
        <div class="rain num">${hour.precipitationProbability != null ? `${escapeHtml(hour.precipitationProbability)}%` : ''}</div>
      </div>
    `).join('');

    const forecast = Array.isArray(cache.forecast) ? cache.forecast : [];
    const dailyHtml = forecast.map((day) => `
      <div class="day-row">
        <div class="day-name label">${escapeHtml(this.formatDayLabel(day.date))}</div>
        <div class="day-icon"><i class="wi ${getWeatherIconClass(day.condition, true)}" aria-hidden="true"></i></div>
        <div class="day-cond">${escapeHtml(day.condition)}</div>
        <div class="day-rain num">${day.precipitationProbability != null ? `${escapeHtml(day.precipitationProbability)}%` : ''}</div>
        <div class="day-temps num">${day.tempMax != null ? `${escapeHtml(day.tempMax)}°` : '--'}<span class="low">${day.tempMin != null ? `${escapeHtml(day.tempMin)}°` : '--'}</span></div>
      </div>
    `).join('');

    return `
      ${statHtml ? `<section><p class="label section-label">Now</p><div class="stat-grid">${statHtml}</div></section>` : ''}
      ${hourlyHtml ? `<section><p class="label section-label">Next hours</p><div class="hourly-strip">${hourlyHtml}</div></section>` : ''}
      ${dailyHtml ? `<section><p class="label section-label">Forecast</p><div class="daily-list">${dailyHtml}</div></section>` : ''}
    `;
  }

  formatTime(isoOrDateStr) {
    const date = new Date(isoOrDateStr);
    if (Number.isNaN(date.getTime())) return isoOrDateStr;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatHourLabel(isoStr) {
    const date = new Date(isoStr);
    if (Number.isNaN(date.getTime())) return isoStr;
    return String(date.getHours()).padStart(2, '0');
  }

  formatDayLabel(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString([], { weekday: 'short' });
  }

  windDirectionLabel(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(deg / 45) % 8];
  }

  // Compares time of day only: the cache holds today's sunrise/sunset, and
  // hourly entries run into tomorrow.
  isDaytime(time, sunrise, sunset) {
    const minutesOfDay = (value) => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? NaN : d.getHours() * 60 + d.getMinutes();
    };
    const t = minutesOfDay(time);
    if (sunrise && sunset) {
      const sr = minutesOfDay(sunrise);
      const ss = minutesOfDay(sunset);
      if (!Number.isNaN(t) && !Number.isNaN(sr) && !Number.isNaN(ss)) {
        return t >= sr && t < ss;
      }
    }
    return t >= 6 * 60 && t < 19 * 60;
  }

  weatherIconClass(condition, time, sunrise, sunset) {
    return getWeatherIconClass(condition, this.isDaytime(time, sunrise, sunset));
  }

  openSetup() {
    this.isSetupOpen = true;
    this.render();
  }

  closeSetup() {
    this.isSetupOpen = false;
    this.render();
    const setupBtn = typeof this.querySelector === 'function' ? this.querySelector('#setup-button') : null;
    if (setupBtn && setupBtn.focus) setupBtn.focus();
  }

  renderSetupDialog(query) {
    const currentProvider = query.provider;
    return `
      <dialog class="dialog setup-dialog" aria-labelledby="weather-setup-title">
        <div class="dialog__head">
          <h2 class="dialog__title" id="weather-setup-title">Weather setup</h2>
          <button type="button" class="zoom-button" id="close-secrets" aria-label="Close"><span class="icon icon--close" aria-hidden="true"></span></button>
        </div>
        <form class="dialog__body" id="weather-setup-form">
          <label class="field">
            <span class="label">Provider</span>
            <select id="weather-provider" class="select">
              <option value="openmeteo" ${currentProvider === 'openmeteo' ? 'selected' : ''}>Open-Meteo (free, no key)</option>
              <option value="openweathermap" ${currentProvider === 'openweathermap' ? 'selected' : ''}>OpenWeatherMap</option>
            </select>
          </label>
          <label class="field">
            <span class="label">City</span>
            <input type="text" id="weather-city" class="input" autofocus placeholder="${escapeHtml(DEFAULT_WEATHER.city)}" value="${escapeHtml(query.city)}">
          </label>
          <label class="field">
            <span class="label">API key</span>
            <input type="password" id="weather-apikey" class="input" autocomplete="off" value="${escapeHtml(query.apiKey)}">
            <p class="hint">Only needed for OpenWeatherMap. Stored in this browser only.</p>
          </label>
          <div class="form-actions">
            <button type="button" id="cancel-secrets" class="button-secondary">Cancel</button>
            <button type="submit" id="save-secrets" class="button-primary">Save</button>
          </div>
        </form>
      </dialog>
    `;
  }

  saveSetup() {
    const providerInput = this.querySelector('#weather-provider');
    const cityInput = this.querySelector('#weather-city');
    const keyInput = this.querySelector('#weather-apikey');

    const current = this.getQuery();
    const provider = providerInput ? providerInput.value : current.provider;
    const city = cityInput ? cityInput.value.trim() : current.city;
    const apiKey = keyInput ? keyInput.value.trim() : current.apiKey;

    const before = this.settingsKey;
    // A real change is picked up by onSettingsChange, which refetches.
    this.configManager.setSecret('weather', { provider, city, apiKey });
    const unchanged = this.settingsKey === before;
    if (unchanged) this.status = { kind: 'loading' };
    this.closeSetup();
    if (unchanged) this.fetchWeatherStaleWhileRevalidate();
  }

  bindSetupDialog() {
    const dialog = this.querySelector('.setup-dialog');
    if (dialog) {
      // showModal moves focus into the dialog, traps it and handles Escape.
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        this.closeSetup();
      });
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) this.closeSetup();
      });
    }

    const form = this.querySelector('#weather-setup-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveSetup();
      });
    } else {
      const saveBtn = this.querySelector('#save-secrets');
      if (saveBtn) saveBtn.addEventListener('click', () => this.saveSetup());
    }

    for (const sel of ['#cancel-secrets', '#close-secrets']) {
      const btn = this.querySelector(sel);
      if (btn) btn.addEventListener('click', () => this.closeSetup());
    }
  }

  async fetchOpenMeteo(city, units = 'metric') {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const geoRes = await this.fetchWithTimeout(geoUrl);
    if (!geoRes.ok) return Err('http');
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) return Err('not-found');

    const { latitude, longitude, name } = geoData.results[0];

    const tempUnitParam = units === 'imperial' ? '&temperature_unit=fahrenheit' : '';
    const windUnitParam = units === 'imperial' ? '&wind_speed_unit=mph' : '';
    const precipUnitParam = units === 'imperial' ? '&precipitation_unit=inch' : '';
    const current = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
    const hourly = 'temperature_2m,weather_code,precipitation_probability';
    const daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset';
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=${current}&hourly=${hourly}&daily=${daily}&timezone=auto&forecast_days=7${tempUnitParam}${windUnitParam}${precipUnitParam}`;
    const weatherRes = await this.fetchWithTimeout(weatherUrl);
    if (!weatherRes.ok) return Err('http');

    const weatherData = await weatherRes.json();
    if (!weatherData.current) return Err('http');

    const c = weatherData.current;
    const condition = mapWmoCodeToCondition(c.weather_code);

    const hourly_ = weatherData.hourly || {};
    const nowTime = c.time || '';
    const hourlyForecast = (hourly_.time || [])
      .map((time, i) => ({
        time,
        temp: hourly_.temperature_2m ? Math.round(hourly_.temperature_2m[i]) : null,
        condition: mapWmoCodeToCondition(hourly_.weather_code ? hourly_.weather_code[i] : undefined),
        precipitationProbability: hourly_.precipitation_probability ? hourly_.precipitation_probability[i] : null,
      }))
      .filter((h) => h.time >= nowTime)
      .slice(0, 12);

    const daily_ = weatherData.daily || {};
    const forecast = (daily_.time || []).map((date, i) => ({
      date,
      condition: mapWmoCodeToCondition(daily_.weather_code ? daily_.weather_code[i] : undefined),
      tempMax: daily_.temperature_2m_max ? Math.round(daily_.temperature_2m_max[i]) : null,
      tempMin: daily_.temperature_2m_min ? Math.round(daily_.temperature_2m_min[i]) : null,
      precipitationSum: daily_.precipitation_sum ? daily_.precipitation_sum[i] : null,
      precipitationProbability: daily_.precipitation_probability_max ? daily_.precipitation_probability_max[i] : null,
      windSpeedMax: daily_.wind_speed_10m_max ? Math.round(daily_.wind_speed_10m_max[i]) : null,
      uvIndexMax: daily_.uv_index_max ? daily_.uv_index_max[i] : null,
      sunrise: daily_.sunrise ? daily_.sunrise[i] : null,
      sunset: daily_.sunset ? daily_.sunset[i] : null,
    }));

    return Ok({
      temp: Math.round(c.temperature_2m),
      condition,
      city: name || city,
      provider: 'openmeteo',
      fetchedAt: Date.now(),
      feelsLike: c.apparent_temperature != null ? Math.round(c.apparent_temperature) : null,
      humidity: c.relative_humidity_2m != null ? Math.round(c.relative_humidity_2m) : null,
      pressure: c.pressure_msl != null ? Math.round(c.pressure_msl) : null,
      windSpeed: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null,
      windDirection: c.wind_direction_10m != null ? Math.round(c.wind_direction_10m) : null,
      windGust: c.wind_gusts_10m != null ? Math.round(c.wind_gusts_10m) : null,
      cloudCover: c.cloud_cover != null ? Math.round(c.cloud_cover) : null,
      precipitation: c.precipitation != null ? c.precipitation : null,
      visibility: null,
      uvIndex: forecast[0] ? forecast[0].uvIndexMax : null,
      sunrise: forecast[0] ? forecast[0].sunrise : null,
      sunset: forecast[0] ? forecast[0].sunset : null,
      hourly: hourlyForecast,
      forecast,
    });
  }

  async fetchOpenWeatherMap(city, apiKey, units = 'metric') {
    const encCity = encodeURIComponent(city);
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encCity}&units=${units}&appid=${apiKey}`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) {
      if (response.status === 401) return Err('bad-key');
      if (response.status === 404) return Err('not-found');
      return Err('http');
    }

    const data = await response.json();

    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encCity}&units=${units}&appid=${apiKey}`;
    const forecastRes = await this.fetchWithTimeout(forecastUrl);
    const forecastData = forecastRes && forecastRes.ok ? await forecastRes.json() : null;
    const forecast = forecastData ? this.aggregateOwmForecast(forecastData, units) : [];
    const hourly = forecastData ? this.aggregateOwmHourly(forecastData) : [];

    return Ok({
      temp: Math.round(data.main.temp),
      condition: data.weather && data.weather[0] ? data.weather[0].main : 'Clear',
      city: data.name,
      provider: 'openweathermap',
      fetchedAt: Date.now(),
      feelsLike: data.main.feels_like != null ? Math.round(data.main.feels_like) : null,
      humidity: data.main.humidity != null ? data.main.humidity : null,
      pressure: data.main.pressure != null ? data.main.pressure : null,
      windSpeed: data.wind ? owmWind(data.wind.speed, units) : null,
      windDirection: data.wind && data.wind.deg != null ? data.wind.deg : null,
      windGust: data.wind ? owmWind(data.wind.gust, units) : null,
      cloudCover: data.clouds && data.clouds.all != null ? data.clouds.all : null,
      precipitation: null,
      visibility: data.visibility != null ? data.visibility : null,
      uvIndex: null,
      sunrise: data.sys && data.sys.sunrise ? owmLocalTime(data.sys.sunrise, data.timezone || 0) : null,
      sunset: data.sys && data.sys.sunset ? owmLocalTime(data.sys.sunset, data.timezone || 0) : null,
      hourly,
      forecast,
    });
  }

  aggregateOwmHourly(data) {
    if (!data || !Array.isArray(data.list)) return [];

    const tz = (data.city && data.city.timezone) || 0;
    return data.list.slice(0, 8).map((entry) => ({
      time: owmLocalTime(owmEntrySeconds(entry), tz),
      temp: Math.round(entry.main.temp),
      condition: entry.weather && entry.weather[0] ? entry.weather[0].main : 'Clear',
      precipitationProbability: entry.pop != null ? Math.round(entry.pop * 100) : null,
    }));
  }

  aggregateOwmForecast(data, units = 'metric') {
    if (!data || !Array.isArray(data.list)) return [];

    const tz = (data.city && data.city.timezone) || 0;
    const localHour = (e) => Number(owmLocalTime(owmEntrySeconds(e), tz).slice(11, 13));
    const byDate = new Map();
    for (const entry of data.list) {
      const date = owmLocalTime(owmEntrySeconds(entry), tz).slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }

    return Array.from(byDate.entries())
      .slice(0, 6)
      .map(([date, entries]) => {
        const tempMax = Math.max(...entries.map((e) => e.main.temp_max));
        const tempMin = Math.min(...entries.map((e) => e.main.temp_min));
        const precipitationProbability = Math.round(Math.max(...entries.map((e) => e.pop || 0)) * 100);
        const windSpeedMax = owmWind(Math.max(...entries.map((e) => (e.wind ? e.wind.speed : 0))), units);
        // The entry closest to local noon describes the day.
        const midday = entries.reduce((best, e) => (Math.abs(localHour(e) - 12) < Math.abs(localHour(best) - 12) ? e : best));

        return {
          date,
          condition: midday.weather && midday.weather[0] ? midday.weather[0].main : 'Clear',
          tempMax: Math.round(tempMax),
          tempMin: Math.round(tempMin),
          precipitationSum: null,
          precipitationProbability,
          windSpeedMax,
          uvIndexMax: null,
          sunrise: null,
          sunset: null,
        };
      });
  }

  async fetchWeatherStaleWhileRevalidate() {
    const query = this.getQuery();
    const { provider, city, units, apiKey } = query;

    if (query.needsKey) return;

    const seq = ++this.requestSeq;
    this.lastAttemptAt = Math.max(this.lastAttemptAt, Date.now());

    let result;
    try {
      result = provider === 'openmeteo'
        ? await this.fetchOpenMeteo(city, units)
        : await this.fetchOpenWeatherMap(city, apiKey, units);
    } catch (err) {
      result = Err(err && err.name === 'AbortError' ? 'timeout' : 'network');
    }

    // A newer fetch (settings change, Retry) owns the cache and status now.
    if (seq !== this.requestSeq) return;

    if (result._tag === 'Ok') {
      this.storage.set('weather:cache', { query: { provider, city, units }, reading: result.value });
      this.status = { kind: 'ok' };
    } else {
      // Keep showing a matching stale cache; the readout marks the update as failed.
      this.status = { kind: 'error', reason: result.error.reason };
    }
    if (!this.isSetupOpen) this.render();
  }

}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('widget-weather', WeatherWidget);
  } catch (e) { }
}
