import { configManager } from '../../core/config.js';
import { storage } from '../../core/storage.js';

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
    const provider = secrets.provider || 'openmeteo';
    const cache = this.storage.get('weather:cache') || null;

    const temp = cache ? `${cache.temp}°` : '--°';
    const condition = cache
      ? cache.condition
      : (provider === 'openmeteo' || secrets.apiKey ? 'Loading...' : 'Setup API key');
    const timeStr = cache && cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

    this.innerHTML = `
      <div class="block-header"> 
        <p class="block-header__label">Weather</p>
        <div class="block-header__actions">
          <button id="setup-button" class="button action-button" type="button" aria-label="Setup Secrets">Setup</button>
          <button class="button zoom-button" type="button" aria-label="Expand Weather"><img src="assets/zoom_icon.svg" alt="Zoom" /></button>
        </div>
      </div>
      <div class="weather-container">
      <div class="numeral">${temp}</div>
      <div class="condition">${condition}</div>
      <div class="freshness">
        As of ${timeStr}
        <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
      </div></div>
    `;

    const setupBtn = this.querySelector('#setup-button');
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
    const currentProvider = secrets.provider || 'openmeteo';

    this.innerHTML = `
      <div class="setup-dialog">
        <p class="label">Weather Setup</p>
        <select id="weather-provider" style="margin-bottom: 4px; padding: 4px; border-radius: 4px; background: var(--color-hairline, #222); color: var(--color-text, #fff); border: 1px solid var(--color-hairline, #444);">
          <option value="openmeteo" ${currentProvider === 'openmeteo' ? 'selected' : ''}>Open-Meteo (Free, No Key)</option>
          <option value="openweathermap" ${currentProvider === 'openweathermap' ? 'selected' : ''}>OpenWeatherMap</option>
        </select>
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
        const providerInput = this.querySelector('#weather-provider');
        const cityInput = this.querySelector('#weather-city');
        const keyInput = this.querySelector('#weather-apikey');

        const provider = providerInput ? providerInput.value : 'openmeteo';
        const city = cityInput ? cityInput.value.trim() : 'London';
        const apiKey = keyInput ? keyInput.value.trim() : '';

        this.configManager.setSecret('weather', { provider, city, apiKey });
        this.closeSetup();
        this.fetchWeatherStaleWhileRevalidate(true);
      });
    }

    const cancelBtn = this.querySelector('#cancel-secrets');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.closeSetup());
    }
  }

  async fetchOpenMeteo(city, units = 'metric', signal) {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl, { signal });
    if (!geoRes.ok) return null;
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) return null;

    const { latitude, longitude, name } = geoData.results[0];

    const tempUnitParam = units === 'imperial' ? '&temperature_unit=fahrenheit' : '';
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true${tempUnitParam}`;
    const weatherRes = await fetch(weatherUrl, { signal });
    if (!weatherRes.ok) return null;

    const weatherData = await weatherRes.json();
    if (!weatherData.current_weather) return null;

    const code = weatherData.current_weather.weathercode;
    const condition = mapWmoCodeToCondition(code);

    return {
      temp: Math.round(weatherData.current_weather.temperature),
      condition,
      city: name || city,
      provider: 'openmeteo',
      fetchedAt: Date.now()
    };
  }

  async fetchOpenWeatherMap(city, apiKey, units = 'metric', signal) {
    const encCity = encodeURIComponent(city);
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encCity}&units=${units}&appid=${apiKey}`;
    const response = await fetch(url, { signal });
    if (!response.ok) return null;

    const data = await response.json();
    return {
      temp: Math.round(data.main.temp),
      condition: data.weather && data.weather[0] ? data.weather[0].main : 'Clear',
      city: data.name,
      provider: 'openweathermap',
      fetchedAt: Date.now()
    };
  }

  async fetchWeatherStaleWhileRevalidate(force = false) {
    const secrets = this.getSecrets();
    const provider = secrets.provider || 'openmeteo';
    const city = secrets.city || 'London';
    const units = secrets.units || 'metric';

    if (provider === 'openweathermap' && !secrets.apiKey) return;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 3000) : null;

    try {
      let weatherRecord = null;
      if (provider === 'openmeteo') {
        weatherRecord = await this.fetchOpenMeteo(city, units, controller ? controller.signal : undefined);
      } else {
        weatherRecord = await this.fetchOpenWeatherMap(city, secrets.apiKey, units, controller ? controller.signal : undefined);
      }

      if (timeoutId) clearTimeout(timeoutId);

      if (weatherRecord) {
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
