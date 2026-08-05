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
    const units = secrets.units || 'metric';
    const iconClass = cache
      ? this.weatherIconClass(cache.condition, cache.fetchedAt, cache.sunrise, cache.sunset)
      : 'wi-day-sunny';

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
        .widget-weather .wi-night-clear:before       { content: "\\f02e"; }
        .widget-weather .wi-day-cloudy:before        { content: "\\f002"; }
        .widget-weather .wi-night-alt-cloudy:before  { content: "\\f086"; }
        .widget-weather .wi-cloudy:before            { content: "\\f013"; }
        .widget-weather .wi-fog:before               { content: "\\f014"; }
        .widget-weather .wi-rain:before               { content: "\\f019"; }
        .widget-weather .wi-showers:before            { content: "\\f01a"; }
        .widget-weather .wi-thunderstorm:before        { content: "\\f01e"; }
        .widget-weather .wi-snow:before                 { content: "\\f01b"; }
        .widget-weather .wi-windy:before                 { content: "\\f021"; }
        .widget-weather .wi-sunrise:before                { content: "\\f051"; }
        .widget-weather .wi-sunset:before                  { content: "\\f052"; }

        .widget-weather .primary-row { display: flex; align-items: center; gap: 1.2rem; }
        .widget-weather .primary .wi { font-size: 1.75rem; color: var(--color-text); }
        .widget-weather .primary .numeral {
          font-family: var(--font-mono);
          font-size: 2.4rem;
        }
        .widget-weather .condition { margin: 2px 0 auto; color: var(--color-text-muted); }

        .widget-weather .weather-expanded { display: none; }
        .widget-weather.expanded .weather-expanded {
          display: block;
          margin-top: 1.6rem;
          overflow-y: auto;
        }

        .widget-weather .stat-row {
          display: flex;
          flex-wrap: wrap;
          border-top: 1px solid var(--color-hairline);
          
        }
        .widget-weather .stat {
          flex: 1 1 14rem;
          padding: 1.2rem 1.6rem 1.2rem 0;
          margin-right: 1.6rem;
          border-left: 1px solid var(--color-hairline);
          padding-left: 1.6rem;
        }
        .widget-weather .stat:first-child { border-left: none; }
         .widget-weather .stat:nth-child(9) { border-left: none; }
        .widget-weather .stat .label { margin: 0 0 6px; }
        .widget-weather .stat .value {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: 1.3rem;
        }

        .widget-weather .hourly-strip {
          display: flex;
          overflow-x: auto;
          border-top: 1px solid var(--color-hairline);
        }
        .widget-weather .hourly-strip .hour {
          flex: 0 0 7.2rem;
          padding: 1.2rem 1rem;
          border-left: 1px solid var(--color-hairline);
          text-align: center;
          flex: 1;
        }
        .widget-weather .hourly-strip .hour:first-child { border-left: none; }
        .widget-weather .hourly-strip .hour .label { margin-bottom: 8px; }
        .widget-weather .hourly-strip .hour .cond {
          font-size: var(--text-size-label);
          color: var(--color-text-muted);
          margin-bottom: 8px;
          min-height: 2.4em;
        }
        .widget-weather .hourly-strip .hour .value {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          font-size: 1.2rem;
          margin-bottom: 6px;
        }
        .widget-weather .hourly-strip .hour .rain { font-size: var(--text-size-label); color: var(--color-text-muted); }

        .widget-weather .daily-list .day-row {
          display: flex;
          align-items: baseline;
          gap: 1.6rem;
          padding: 1rem 0;
          border-bottom: 1px solid var(--color-hairline);
        }
        .widget-weather .daily-list .day-row:first-child { border-top: 1px solid var(--color-hairline); }
        .widget-weather .daily-list .day-name { flex: 0 0 5rem; }
        .widget-weather .daily-list .day-icon { flex: 0 0 2rem; }
        .widget-weather .daily-list .day-cond { flex: 1 1 auto; color: var(--color-text-muted); }
        .widget-weather .daily-list .day-temps {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          flex: 0 0 8rem;
          text-align: right;
        }
        .widget-weather .daily-list .day-temps .low { color: var(--color-text-muted); margin-left: 6px; }
        .widget-weather .daily-list .day-rain {
          flex: 0 0 5rem;
          text-align: right;
          font-size: var(--text-size-label);
          color: var(--color-text-muted);
        }

        .widget-weather .hourly-strip .wi,
        .widget-weather .daily-list .wi {
          font-size: 2rem;
          color: var(--color-text-muted);
          margin-block-start: 1rem;
        }
      </style>
      <div class="block-header">
        <p class="block-header__label">Weather</p>
        <div class="block-header__actions">
          <button id="setup-button" class="button action-button" type="button" aria-label="Setup Secrets">Setup</button>
          <button class="button zoom-button" type="button" aria-label="Expand Weather"><img src="assets/zoom_icon.svg" alt="Zoom" /></button>
        </div>
      </div>
      <div class="primary">
        <div class="primary-row">
          <i class="wi ${iconClass}" aria-hidden="true"></i>
          <div class="numeral">${temp}</div>
        </div>
        <div class="condition">${condition}</div>
        <div class="freshness">
          As of ${timeStr}
          <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
        </div>
      </div>
      <div class="weather-expanded">
        <div class="content">
          ${this.renderExpandedDetails(cache, units)}
        </div>
      </div>
    `;

    const setupBtn = this.querySelector('#setup-button');
    if (setupBtn) {
      setupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSetup();
      });
    }
  }

  renderExpandedDetails(cache, units) {
    if (!cache) {
      return `<p class="condition">Loading details...</p>`;
    }

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

    const statRowHtml = stats.map(([label, value]) => `
      <div class="stat"><p class="label">${label}</p><div class="value">${value}</div></div>
    `).join('');

    const hourly = Array.isArray(cache.hourly) ? cache.hourly : [];
    const hourlyHtml = hourly.map((hour) => `
      <div class="hour">
        <p class="label">${this.formatHourLabel(hour.time)}:00</p>
        <i class="wi ${getWeatherIconClass(hour.condition, this.isDaytime(hour.time, cache.sunrise, cache.sunset))}" aria-hidden="true"></i>
        <div class="cond">${hour.condition}</div>
        <div class="value">${hour.temp != null ? `${hour.temp}°` : '--'}</div>
        <div class="rain">${hour.precipitationProbability != null ? `${hour.precipitationProbability}%` : ''}</div>
      </div>
    `).join('');

    const forecast = Array.isArray(cache.forecast) ? cache.forecast : [];
    const dailyHtml = forecast.map((day) => `
      <div class="day-row">
        <div class="day-name">${this.formatDayLabel(day.date)}</div>
        <div class="day-icon"><i class="wi ${getWeatherIconClass(day.condition, true)}" aria-hidden="true"></i></div>
        <div class="day-cond">${day.condition}</div>
        <div class="day-temps">${day.tempMax != null ? `${day.tempMax}°` : '--'}<span class="low">${day.tempMin != null ? `${day.tempMin}°` : '--'}</span></div>
        <div class="day-rain">${day.precipitationProbability != null ? `${day.precipitationProbability}%` : ''}</div>
      </div>
    `).join('');

    return `
      ${statRowHtml ? `<div class="stat-row">${statRowHtml}</div>` : ''}
      ${hourlyHtml ? `<div class="hourly-strip">${hourlyHtml}</div>` : ''}
      ${dailyHtml ? `<div class="daily-list">${dailyHtml}</div>` : ''}
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

  isDaytime(time, sunrise, sunset) {
    const t = new Date(time).getTime();
    if (sunrise && sunset) {
      const sr = new Date(sunrise).getTime();
      const ss = new Date(sunset).getTime();
      if (!Number.isNaN(t) && !Number.isNaN(sr) && !Number.isNaN(ss)) {
        return t >= sr && t < ss;
      }
    }
    const hour = new Date(t).getHours();
    return hour >= 6 && hour < 19;
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
    const windUnitParam = units === 'imperial' ? '&wind_speed_unit=mph' : '';
    const precipUnitParam = units === 'imperial' ? '&precipitation_unit=inch' : '';
    const current = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
    const hourly = 'temperature_2m,weather_code,precipitation_probability';
    const daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset';
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=${current}&hourly=${hourly}&daily=${daily}&timezone=auto&forecast_days=7${tempUnitParam}${windUnitParam}${precipUnitParam}`;
    const weatherRes = await fetch(weatherUrl, { signal });
    if (!weatherRes.ok) return null;

    const weatherData = await weatherRes.json();
    if (!weatherData.current) return null;

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

    return {
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
    };
  }

  async fetchOpenWeatherMap(city, apiKey, units = 'metric', signal) {
    const encCity = encodeURIComponent(city);
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encCity}&units=${units}&appid=${apiKey}`;
    const response = await fetch(url, { signal });
    if (!response.ok) return null;

    const data = await response.json();

    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encCity}&units=${units}&appid=${apiKey}`;
    const forecastRes = await fetch(forecastUrl, { signal });
    const forecastData = forecastRes && forecastRes.ok ? await forecastRes.json() : null;
    const forecast = forecastData ? this.aggregateOwmForecast(forecastData) : [];
    const hourly = forecastData ? this.aggregateOwmHourly(forecastData) : [];

    return {
      temp: Math.round(data.main.temp),
      condition: data.weather && data.weather[0] ? data.weather[0].main : 'Clear',
      city: data.name,
      provider: 'openweathermap',
      fetchedAt: Date.now(),
      feelsLike: data.main.feels_like != null ? Math.round(data.main.feels_like) : null,
      humidity: data.main.humidity != null ? data.main.humidity : null,
      pressure: data.main.pressure != null ? data.main.pressure : null,
      windSpeed: data.wind && data.wind.speed != null ? Math.round(data.wind.speed) : null,
      windDirection: data.wind && data.wind.deg != null ? data.wind.deg : null,
      windGust: data.wind && data.wind.gust != null ? Math.round(data.wind.gust) : null,
      cloudCover: data.clouds && data.clouds.all != null ? data.clouds.all : null,
      precipitation: null,
      visibility: data.visibility != null ? data.visibility : null,
      uvIndex: null,
      sunrise: data.sys && data.sys.sunrise ? new Date(data.sys.sunrise * 1000).toISOString() : null,
      sunset: data.sys && data.sys.sunset ? new Date(data.sys.sunset * 1000).toISOString() : null,
      hourly,
      forecast,
    };
  }

  aggregateOwmHourly(data) {
    if (!data || !Array.isArray(data.list)) return [];

    return data.list.slice(0, 8).map((entry) => ({
      time: entry.dt_txt.replace(' ', 'T').slice(0, 16),
      temp: Math.round(entry.main.temp),
      condition: entry.weather && entry.weather[0] ? entry.weather[0].main : 'Clear',
      precipitationProbability: entry.pop != null ? Math.round(entry.pop * 100) : null,
    }));
  }

  aggregateOwmForecast(data) {
    if (!data || !Array.isArray(data.list)) return [];

    const byDate = new Map();
    for (const entry of data.list) {
      const date = entry.dt_txt.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }

    return Array.from(byDate.entries())
      .slice(0, 6)
      .map(([date, entries]) => {
        const tempMax = Math.max(...entries.map((e) => e.main.temp_max));
        const tempMin = Math.min(...entries.map((e) => e.main.temp_min));
        const precipitationProbability = Math.round(Math.max(...entries.map((e) => e.pop || 0)) * 100);
        const windSpeedMax = Math.round(Math.max(...entries.map((e) => (e.wind ? e.wind.speed : 0))));
        const midday = entries.find((e) => e.dt_txt.includes('12:00:00')) || entries[Math.floor(entries.length / 2)];

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
  } catch (e) { }
}
