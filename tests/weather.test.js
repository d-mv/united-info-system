import { test } from 'node:test';
import assert from 'node:assert';

// Mock DOM for Web Component testing
class MockHTMLElement {
  constructor() {
    this.innerHTML = '';
    this._listeners = new Map();
  }

  connectedCallback() {}
  disconnectedCallback() {}

  querySelector(selector) {
    if (selector === '.setup-button') return { addEventListener: (ev, fn) => this._listeners.set('setup-click', fn) };
    if (selector === '#save-secrets') return { addEventListener: (ev, fn) => this._listeners.set('save-click', fn) };
    return null;
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.customElements = {
  define: () => {}
};

test('WeatherWidget manifests setup dialog and handles secret configuration', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  assert.ok(WeatherWidget.manifest);
  assert.strictEqual(WeatherWidget.manifest.id, 'weather');

  const widget = new WeatherWidget();
  widget.configManager = {
    getSecret: () => ({ provider: 'openmeteo', apiKey: '', city: 'London', units: 'metric' }),
    setSecret: (id, secrets) => { widget.savedSecrets = secrets; }
  };
  widget.storage = {
    get: () => ({ temp: 15, condition: 'Sunny', city: 'London', provider: 'openmeteo', fetchedAt: Date.now() }),
    set: () => {}
  };

  widget.connectedCallback();
  assert.ok(widget.innerHTML.includes('Setup') || widget.innerHTML.includes('Weather'));

  // Test setup dialog toggle
  widget.openSetup();
  assert.ok(widget.innerHTML.includes('setup-dialog'));
  assert.ok(widget.innerHTML.includes('Open-Meteo'));
  assert.ok(widget.innerHTML.includes('OpenWeatherMap'));
});

test('WeatherWidget fetches full current conditions and forecast from Open-Meteo API', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  const widget = new WeatherWidget();
  let storedCache = null;
  widget.configManager = {
    getSecret: () => ({ provider: 'openmeteo', city: 'London', units: 'metric' })
  };
  widget.storage = {
    get: () => storedCache,
    set: (key, val) => { storedCache = val; }
  };

  // Mock global fetch for Open-Meteo geocoding and weather
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('geocoding-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [{ latitude: 51.5074, longitude: -0.1278, name: 'London' }]
        })
      };
    }
    if (url.includes('api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          current: {
            time: '2026-08-04T12:00',
            temperature_2m: 18.4,
            relative_humidity_2m: 62,
            apparent_temperature: 17.9,
            weather_code: 0,
            cloud_cover: 10,
            pressure_msl: 1015.2,
            wind_speed_10m: 12.3,
            wind_direction_10m: 200,
            wind_gusts_10m: 20.1,
            precipitation: 0
          },
          hourly: {
            time: ['2026-08-04T11:00', '2026-08-04T12:00', '2026-08-04T13:00', '2026-08-04T14:00'],
            temperature_2m: [17.8, 18.4, 19.1, 19.6],
            weather_code: [0, 0, 1, 2],
            precipitation_probability: [0, 5, 10, 15]
          },
          daily: {
            time: ['2026-08-04', '2026-08-05', '2026-08-06'],
            weather_code: [0, 1, 61],
            temperature_2m_max: [22.1, 21.4, 19.8],
            temperature_2m_min: [14.2, 13.9, 12.5],
            precipitation_sum: [0, 0.2, 4.1],
            precipitation_probability_max: [5, 15, 80],
            wind_speed_10m_max: [18.2, 20.4, 25.1],
            uv_index_max: [5.2, 4.8, 2.1],
            sunrise: ['2026-08-04T05:32', '2026-08-05T05:34', '2026-08-06T05:35'],
            sunset: ['2026-08-04T20:41', '2026-08-05T20:39', '2026-08-06T20:37']
          }
        })
      };
    }
    return { ok: false };
  };

  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.ok(storedCache);
    assert.strictEqual(storedCache.temp, 18);
    assert.strictEqual(storedCache.condition, 'Clear');
    assert.strictEqual(storedCache.city, 'London');
    assert.strictEqual(storedCache.provider, 'openmeteo');
    assert.strictEqual(storedCache.humidity, 62);
    assert.strictEqual(storedCache.feelsLike, 18);
    assert.strictEqual(storedCache.windSpeed, 12);
    assert.strictEqual(storedCache.pressure, 1015);
    assert.strictEqual(storedCache.sunrise, '2026-08-04T05:32');
    assert.strictEqual(storedCache.sunset, '2026-08-04T20:41');
    assert.ok(Array.isArray(storedCache.forecast));
    assert.strictEqual(storedCache.forecast.length, 3);
    assert.strictEqual(storedCache.forecast[1].tempMax, 21);
    assert.strictEqual(storedCache.forecast[1].tempMin, 14);
    assert.strictEqual(storedCache.forecast[1].condition, 'Partly Cloudy');
    assert.strictEqual(storedCache.forecast[1].precipitationProbability, 15);
    assert.ok(Array.isArray(storedCache.hourly));
    assert.strictEqual(storedCache.hourly.length, 3);
    assert.strictEqual(storedCache.hourly[0].time, '2026-08-04T12:00');
    assert.strictEqual(storedCache.hourly[0].temp, 18);
    assert.strictEqual(storedCache.hourly[1].temp, 19);
    assert.strictEqual(storedCache.hourly[1].condition, 'Partly Cloudy');
    assert.strictEqual(storedCache.hourly[2].precipitationProbability, 15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeatherWidget fetches full current conditions and forecast from OpenWeatherMap API', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  const widget = new WeatherWidget();
  let storedCache = null;
  widget.configManager = {
    getSecret: () => ({ provider: 'openweathermap', apiKey: 'valid_key', city: 'Paris', units: 'metric' })
  };
  widget.storage = {
    get: () => storedCache,
    set: (key, val) => { storedCache = val; }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/forecast')) {
      const day = (n) => `2026-08-0${4 + n}`;
      return {
        ok: true,
        json: async () => ({
          list: [
            { dt_txt: `${day(0)} 12:00:00`, main: { temp: 24, temp_min: 20, temp_max: 24 }, weather: [{ main: 'Clouds' }], pop: 0.1, wind: { speed: 4 } },
            { dt_txt: `${day(0)} 15:00:00`, main: { temp: 23, temp_min: 19, temp_max: 23 }, weather: [{ main: 'Clouds' }], pop: 0.2, wind: { speed: 5 } },
            { dt_txt: `${day(1)} 12:00:00`, main: { temp: 26, temp_min: 21, temp_max: 26 }, weather: [{ main: 'Clear' }], pop: 0, wind: { speed: 3 } },
          ]
        })
      };
    }
    if (url.includes('api.openweathermap.org')) {
      return {
        ok: true,
        json: async () => ({
          main: { temp: 22.1, feels_like: 21.5, humidity: 58, pressure: 1012 },
          weather: [{ main: 'Clouds' }],
          wind: { speed: 4.2, deg: 180, gust: 7.1 },
          clouds: { all: 40 },
          visibility: 10000,
          sys: { sunrise: 1722747600, sunset: 1722798000 },
          name: 'Paris'
        })
      };
    }
    return { ok: false };
  };

  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.ok(storedCache);
    assert.strictEqual(storedCache.temp, 22);
    assert.strictEqual(storedCache.condition, 'Clouds');
    assert.strictEqual(storedCache.city, 'Paris');
    assert.strictEqual(storedCache.provider, 'openweathermap');
    assert.strictEqual(storedCache.feelsLike, 22);
    assert.strictEqual(storedCache.humidity, 58);
    assert.strictEqual(storedCache.pressure, 1012);
    assert.strictEqual(storedCache.windSpeed, 4);
    assert.strictEqual(storedCache.visibility, 10000);
    assert.ok(Array.isArray(storedCache.forecast));
    assert.strictEqual(storedCache.forecast.length, 2);
    assert.strictEqual(storedCache.forecast[0].tempMax, 24);
    assert.strictEqual(storedCache.forecast[0].tempMin, 19);
    assert.strictEqual(storedCache.forecast[1].condition, 'Clear');
    assert.ok(Array.isArray(storedCache.hourly));
    assert.strictEqual(storedCache.hourly.length, 3);
    assert.strictEqual(storedCache.hourly[0].temp, 24);
    assert.strictEqual(storedCache.hourly[0].condition, 'Clouds');
    assert.strictEqual(storedCache.hourly[2].temp, 26);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

