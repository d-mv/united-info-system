import { configManager } from '../../core/config.js';
import { storage } from '../../core/storage.js';

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
  }

  connectedCallback() {
    this.render();
    this.fetchWeatherStaleWhileRevalidate();
  }

  getSecrets() {
    return this.configManager.getSecret('weather') || {};
  }

  render() {
    if (this.isSetupOpen) {
      this.renderSetupDialog();
      return;
    }

    const secrets = this.getSecrets();
    const cache = this.storage.get('weather:cache') || null;

    const temp = cache ? `${cache.temp}°` : '--°';
    const condition = cache ? cache.condition : (secrets.apiKey ? 'Loading...' : 'Setup API key');
    const timeStr = cache && cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

    this.innerHTML = `
      <p class="label">Weather</p>
      <button class="setup-button" type="button" aria-label="Setup Secrets">Setup</button>
      <button class="zoom-button" type="button" aria-label="Expand Weather">Expand</button>
      <div class="numeral">${temp}</div>
      <div class="condition">${condition}</div>
      <div class="freshness">
        <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
        As of ${timeStr}
      </div>
    `;

    const setupBtn = this.querySelector('.setup-button');
    if (setupBtn) {
      setupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSetup();
      });
    }
  }

  openSetup() {
    this.isSetupOpen = true;
    this.render();
  }

  closeSetup() {
    this.isSetupOpen = false;
    this.render();
  }

  renderSetupDialog() {
    const secrets = this.getSecrets();
    this.innerHTML = `
      <div class="setup-dialog">
        <p class="label">Weather Setup</p>
        <input type="text" id="weather-city" placeholder="City (e.g. London)" value="${secrets.city || 'London'}">
        <input type="password" id="weather-apikey" placeholder="OpenWeatherMap API Key" value="${secrets.apiKey || ''}">
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <button type="button" id="save-secrets">Save</button>
          <button type="button" id="cancel-secrets" style="background: var(--color-hairline); color: var(--color-text);">Cancel</button>
        </div>
      </div>
    `;

    const saveBtn = this.querySelector('#save-secrets');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const cityInput = this.querySelector('#weather-city');
        const keyInput = this.querySelector('#weather-apikey');

        const city = cityInput ? cityInput.value.trim() : 'London';
        const apiKey = keyInput ? keyInput.value.trim() : '';

        this.configManager.setSecret('weather', { city, apiKey });
        this.closeSetup();
        this.fetchWeatherStaleWhileRevalidate(true);
      });
    }

    const cancelBtn = this.querySelector('#cancel-secrets');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.closeSetup());
    }
  }

  async fetchWeatherStaleWhileRevalidate(force = false) {
    const secrets = this.getSecrets();
    if (!secrets.apiKey) return;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 3000) : null;

    try {
      const city = encodeURIComponent(secrets.city || 'London');
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${secrets.apiKey}`;
      const response = await fetch(url, { signal: controller ? controller.signal : undefined });

      if (timeoutId) clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const weatherRecord = {
          temp: Math.round(data.main.temp),
          condition: data.weather && data.weather[0] ? data.weather[0].main : 'Clear',
          city: data.name,
          fetchedAt: Date.now()
        };
        this.storage.set('weather:cache', weatherRecord);
        if (!this.isSetupOpen) this.render();
      }
    } catch (err) {
      // Quiet fail / fallback to stale cache
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('widget-weather', WeatherWidget);
  } catch (e) {}
}
