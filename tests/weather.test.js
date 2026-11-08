import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';
import { ConfigManager } from '../core/config.js';

installBrowserGlobals();

// Real storage + real ConfigManager; `weather` secrets seeded into the stored config.
function makeWidget(WeatherWidget, weatherSecrets, cache = null) {
  const widget = new WeatherWidget();
  widget.storage = makeStorage(cache ? { 'weather:cache': cache } : {});
  widget.configManager = new ConfigManager({ storage: widget.storage });
  widget.configManager.setSecret('weather', weatherSecrets);
  return { widget, readCache: () => widget.storage.get('weather:cache') };
}

test('WeatherWidget manifests setup dialog and handles secret configuration', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  assert.ok(WeatherWidget.manifest);
  assert.strictEqual(WeatherWidget.manifest.id, 'weather');

  const { widget } = makeWidget(
    WeatherWidget,
    { provider: 'openmeteo', apiKey: '', city: 'London', units: 'metric' },
    { query: { provider: 'openmeteo', city: 'London', units: 'metric' }, reading: { temp: 15, condition: 'Sunny', city: 'London', provider: 'openmeteo', fetchedAt: Date.now() } }
  );
  const listeners = new Map();
  widget.querySelector = (selector) => {
    if (selector === '.setup-button') return { addEventListener: (ev, fn) => listeners.set('setup-click', fn) };
    if (selector === '#save-secrets') return { addEventListener: (ev, fn) => listeners.set('save-click', fn) };
    return null;
  };

  // No network in tests: the refresh started by connectedCallback fails fast.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    widget.connectedCallback();
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(widget.innerHTML.includes('Setup') || widget.innerHTML.includes('Weather'));

  // Test setup dialog toggle
  widget.openSetup();
  assert.ok(widget.innerHTML.includes('setup-dialog'));
  assert.ok(widget.innerHTML.includes('Open-Meteo'));
  assert.ok(widget.innerHTML.includes('OpenWeatherMap'));
  widget.disconnectedCallback();
});

test('WeatherWidget fetches full current conditions and forecast from Open-Meteo API', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');

  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'London', units: 'metric' });

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
    const entry = readCache();
    assert.deepStrictEqual(entry.query, { provider: 'openmeteo', city: 'London', units: 'metric' });
    const storedCache = entry.reading;
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

  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openweathermap', apiKey: 'valid_key', city: 'Paris', units: 'metric' });

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
    const entry = readCache();
    assert.deepStrictEqual(entry.query, { provider: 'openweathermap', city: 'Paris', units: 'metric' });
    const storedCache = entry.reading;
    assert.ok(storedCache);
    assert.strictEqual(storedCache.temp, 22);
    assert.strictEqual(storedCache.condition, 'Clouds');
    assert.strictEqual(storedCache.city, 'Paris');
    assert.strictEqual(storedCache.provider, 'openweathermap');
    assert.strictEqual(storedCache.feelsLike, 22);
    assert.strictEqual(storedCache.humidity, 58);
    assert.strictEqual(storedCache.pressure, 1012);
    assert.strictEqual(storedCache.windSpeed, 15, 'metric OWM wind is m/s; shown in km/h (4.2 * 3.6)');
    assert.strictEqual(storedCache.windGust, 26, '7.1 m/s gust in km/h');
    assert.strictEqual(storedCache.forecast[0].windSpeedMax, 18, 'daily max 5 m/s in km/h');
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


// Records requested URLs; geocoding answers with the asked-for city, forecast with a minimal reading.
function stubWeatherFetch() {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('geocoding-api.open-meteo.com')) {
      const name = decodeURIComponent(url.match(/name=([^&]+)/)[1]);
      return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 2, name }] }) };
    }
    return { ok: true, json: async () => ({ current: { time: '2026-08-04T12:00', temperature_2m: 10, weather_code: 0 } }) };
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('WeatherWidget refetches when its settings change in another tab', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { writeFromOtherTab } = await import('./helpers/fake-browser.js');
  const { widget } = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'London', units: 'metric' });
  const net = stubWeatherFetch();
  try {
    widget.connectedCallback();
    await settle();
    const config = widget.configManager.get();
    writeFromOtherTab('config', { ...config, secrets: { weather: { ...config.secrets.weather, city: 'Oslo' } } });
    await settle();
    assert.ok(net.urls.some(u => u.includes('name=Oslo')), 'fetched the new city');
    assert.ok(widget.innerHTML.includes('Oslo'));
  } finally {
    net.restore();
    widget.disconnectedCallback();
  }
});

test('WeatherWidget fetches once per setup save', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { widget } = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'London', units: 'metric' });
  const net = stubWeatherFetch();
  try {
    widget.connectedCallback();
    await settle();
    const inputs = { '#weather-provider': { value: 'openmeteo' }, '#weather-city': { value: 'Oslo' }, '#weather-apikey': { value: '' } };
    widget.querySelector = (sel) => inputs[sel] || null;
    net.urls.length = 0;
    widget.saveSetup();
    await settle();
    assert.strictEqual(net.urls.filter(u => u.includes('geocoding')).length, 1, 'one fetch for the new settings');
  } finally {
    net.restore();
    widget.disconnectedCallback();
  }
});

test('resolveWeatherQuery fills defaults from the config in one place', async () => {
  const { resolveWeatherQuery } = await import('../widgets/weather/weather-widget.js');
  const { DEFAULT_CONFIG } = await import('../core/config.js');
  assert.deepStrictEqual(resolveWeatherQuery({}), {
    provider: 'openmeteo', city: DEFAULT_CONFIG.secrets.weather.city, units: 'metric', apiKey: '', needsKey: false
  });
  assert.strictEqual(resolveWeatherQuery({ city: '   ' }).city, DEFAULT_CONFIG.secrets.weather.city, 'blank city falls back');
  assert.strictEqual(resolveWeatherQuery({ provider: 'openweathermap' }).needsKey, true);
  assert.strictEqual(resolveWeatherQuery({ provider: 'openweathermap', apiKey: 'k' }).needsKey, false);
});

test('WeatherWidget does not show a cached reading for other settings', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const reading = { temp: 15, condition: 'Clear', city: 'Porto', provider: 'openmeteo', fetchedAt: Date.now() };
  const other = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'Oslo', units: 'metric' },
    { query: { provider: 'openmeteo', city: 'Porto', units: 'metric' }, reading });
  other.widget.render();
  assert.ok(!other.widget.innerHTML.includes('Porto'), 'a reading for another city is not shown');
  assert.ok(other.widget.innerHTML.includes('Loading'));

  const legacy = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'Porto', units: 'metric' }, reading);
  legacy.widget.render();
  assert.ok(!legacy.widget.innerHTML.includes('15°'), 'a pre-envelope cache is ignored');

  const same = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'porto', units: 'metric' },
    { query: { provider: 'openmeteo', city: 'Porto', units: 'metric' }, reading });
  same.widget.render();
  assert.ok(same.widget.innerHTML.includes('15°'), 'city match ignores case');
});

test('WeatherWidget setup dialog prefills the configured default city', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { DEFAULT_CONFIG } = await import('../core/config.js');
  const { widget } = makeWidget(WeatherWidget, { provider: 'openmeteo', units: 'metric' });
  widget.configManager.update({ secrets: { weather: { provider: 'openmeteo', units: 'metric' } } });
  widget.openSetup();
  assert.ok(widget.innerHTML.includes(`value="${DEFAULT_CONFIG.secrets.weather.city}"`));
  assert.ok(!widget.innerHTML.includes('London'));
});

test('OpenWeatherMap imperial wind stays in mph', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openweathermap', apiKey: 'k', city: 'Paris', units: 'imperial' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (url.includes('/forecast')
    ? { ok: true, json: async () => ({ list: [] }) }
    : { ok: true, json: async () => ({ main: { temp: 70 }, weather: [{ main: 'Clear' }], wind: { speed: 10 }, name: 'Paris' }) });
  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.strictEqual(readCache().reading.windSpeed, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenWeatherMap times are converted to the city local clock', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openweathermap', apiKey: 'k', city: 'New York', units: 'metric' });
  const utc = (iso) => Date.parse(iso) / 1000;
  const tz = -4 * 3600; // New York in August
  const entry = (iso, temp) => ({ dt: utc(iso), dt_txt: iso.replace('T', ' ').slice(0, 19), main: { temp, temp_min: temp, temp_max: temp }, weather: [{ main: 'Clear' }], pop: 0, wind: { speed: 1 } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (url.includes('/forecast')
    ? { ok: true, json: async () => ({ city: { timezone: tz }, list: [entry('2026-08-05T00:00:00Z', 20), entry('2026-08-05T03:00:00Z', 18), entry('2026-08-05T15:00:00Z', 25)] }) }
    : { ok: true, json: async () => ({ timezone: tz, main: { temp: 20 }, weather: [{ main: 'Clear' }], sys: { sunrise: utc('2026-08-04T10:10:00Z'), sunset: utc('2026-08-05T00:05:00Z') }, name: 'New York' }) });
  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    const r = readCache().reading;
    assert.strictEqual(r.hourly[0].time, '2026-08-04T20:00', '00:00 UTC is 20:00 the evening before in New York');
    assert.strictEqual(r.sunrise, '2026-08-04T06:10');
    assert.strictEqual(r.sunset, '2026-08-04T20:05');
    assert.deepStrictEqual(r.forecast.map(d => d.date), ['2026-08-04', '2026-08-05'], 'days follow the local date');
    assert.strictEqual(r.forecast[1].tempMax, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isDaytime compares the time of day, so tomorrow morning is day', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const w = new WeatherWidget();
  const sunrise = '2026-08-04T06:10';
  const sunset = '2026-08-04T20:41';
  assert.strictEqual(w.isDaytime('2026-08-04T12:00', sunrise, sunset), true);
  assert.strictEqual(w.isDaytime('2026-08-04T22:00', sunrise, sunset), false);
  assert.strictEqual(w.isDaytime('2026-08-05T08:00', sunrise, sunset), true, 'next morning');
  assert.strictEqual(w.isDaytime('2026-08-05T03:00', sunrise, sunset), false, 'next night');
});

test('WeatherWidget says why a fetch failed', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const cases = [
    [{ provider: 'openmeteo', city: 'Nowhere' }, async () => ({ ok: true, json: async () => ({ results: [] }) }), 'City not found'],
    [{ provider: 'openweathermap', apiKey: 'bad', city: 'Paris' }, async () => ({ ok: false, status: 401 }), 'API key rejected'],
    [{ provider: 'openweathermap', apiKey: 'k', city: 'Atlantis' }, async () => ({ ok: false, status: 404 }), 'City not found'],
    [{ provider: 'openmeteo', city: 'Porto' }, async () => ({ ok: false, status: 500 }), 'Weather unavailable'],
    [{ provider: 'openmeteo', city: 'Porto' }, async () => { throw new TypeError('Failed to fetch'); }, 'Weather unavailable'],
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const [secrets, fake, message] of cases) {
      const { widget } = makeWidget(WeatherWidget, { units: 'metric', ...secrets });
      globalThis.fetch = fake;
      await widget.fetchWeatherStaleWhileRevalidate();
      assert.ok(widget.innerHTML.includes(message), `${secrets.city}: ${message}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeatherWidget drops a fetch that finishes after a newer one', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'London', units: 'metric' });
  const releases = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const respond = url.includes('geocoding')
      ? { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 2, name: decodeURIComponent(url.match(/name=([^&]+)/)[1]) }] }) }
      : { ok: true, json: async () => ({ current: { time: '2026-08-04T12:00', temperature_2m: 10, weather_code: 0 } }) };
    // Only London's geocoding call is held back.
    if (url.includes('name=London')) return new Promise(resolve => releases.push(() => resolve(respond)));
    return Promise.resolve(respond);
  };
  try {
    const older = widget.fetchWeatherStaleWhileRevalidate();
    widget.configManager.setSecret('weather', { city: 'Oslo' });
    const newer = widget.fetchWeatherStaleWhileRevalidate();
    await newer;
    releases.forEach(release => release());
    await older;
    assert.strictEqual(readCache().query.city, 'Oslo', 'the older London response did not overwrite Oslo');
    assert.ok(widget.innerHTML.includes('Oslo'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Each weather request gets its own timeout', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const { widget, readCache } = makeWidget(WeatherWidget, { provider: 'openmeteo', city: 'Porto', units: 'metric' });
  widget.requestTimeoutMs = 60;
  const later = (ms, value, signal) => new Promise((resolve, reject) => {
    const id = setTimeout(() => resolve(value), ms);
    signal.addEventListener('abort', () => { clearTimeout(id); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  const originalFetch = globalThis.fetch;
  // Each call takes 40ms: fine per request, but 80ms in total.
  globalThis.fetch = (url, { signal }) => later(40, url.includes('geocoding')
    ? { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 2, name: 'Porto' }] }) }
    : { ok: true, json: async () => ({ current: { time: '2026-08-04T12:00', temperature_2m: 10, weather_code: 0 } }) }, signal);
  try {
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.ok(readCache(), 'both requests finished within their own timeouts');

    globalThis.fetch = (url, { signal }) => later(200, { ok: true, json: async () => ({}) }, signal);
    await widget.fetchWeatherStaleWhileRevalidate();
    assert.strictEqual(widget.status.reason, 'timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeatherWidget skips the fetch on mount while the cached reading is fresh', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const query = { provider: 'openmeteo', city: 'Porto', units: 'metric' };
  const reading = (age) => ({ temp: 15, condition: 'Clear', city: 'Porto', provider: 'openmeteo', fetchedAt: Date.now() - age });
  const net = stubWeatherFetch();
  try {
    const fresh = makeWidget(WeatherWidget, query, { query, reading: reading(60 * 1000) });
    fresh.widget.connectedCallback();
    await settle();
    assert.strictEqual(net.urls.length, 0, 'fresh cache: no request');
    fresh.widget.disconnectedCallback();

    const stale = makeWidget(WeatherWidget, query, { query, reading: reading(60 * 60 * 1000) });
    stale.widget.connectedCallback();
    await settle();
    assert.ok(net.urls.length > 0, 'stale cache: revalidates');
    stale.widget.disconnectedCallback();
  } finally {
    net.restore();
  }
});

test('WeatherWidget refreshes a reading that went stale while open, without hammering on failure', async () => {
  const { WeatherWidget } = await import('../widgets/weather/weather-widget.js');
  const query = { provider: 'openmeteo', city: 'Porto', units: 'metric' };
  const { widget } = makeWidget(WeatherWidget, query, { query, reading: { temp: 15, condition: 'Clear', fetchedAt: Date.now() } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500 }; };
  try {
    const now = Date.now();
    widget.refreshIfStale(now + 60 * 1000);
    assert.strictEqual(calls, 0, 'still fresh');
    await widget.refreshIfStale(now + 20 * 60 * 1000);
    assert.strictEqual(calls, 1, 'stale: refetched');
    await widget.refreshIfStale(now + 21 * 60 * 1000);
    assert.strictEqual(calls, 1, 'just failed: waits before trying again');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
