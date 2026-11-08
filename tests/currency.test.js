import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage, writeFromOtherTab } from './helpers/fake-browser.js';
import { collectCommands, clearCommands } from '../core/commands.js';

installBrowserGlobals();

const RATES_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates';
const NAMES_URL = 'https://api.frankfurter.dev/v2/currencies';

const RATES_JSON = [
  { date: '2026-11-06', base: 'EUR', quote: 'USD', rate: 1.1555 },
  { date: '2026-11-06', base: 'EUR', quote: 'EUR', rate: 1.0 },
  { date: '2026-11-06', base: 'EUR', quote: 'GBP', rate: 0.83415 },
  { date: '2026-11-06', base: 'EUR', quote: 'JPY', rate: 176.77 },
  { date: '2026-11-06', base: 'EUR', quote: 'CHF', rate: 0.9143 },
  { date: '2026-11-06', base: 'EUR', quote: 'IDR', rate: 20208.93 },
];
const NAMES_JSON = [
  { iso_code: 'USD', name: 'United States Dollar', type: 'currency' },
  { iso_code: 'EUR', name: 'Euro', type: 'currency' },
  { iso_code: 'GBP', name: 'British Pound', type: 'currency' },
  { iso_code: 'BTC', name: 'Bitcoin', type: 'crypto' },
];
const CACHE = (fetchedAt) => ({
  base: 'EUR', date: '2026-11-06', fetchedAt,
  rates: { USD: 1.1555, EUR: 1, GBP: 0.83415, JPY: 176.77, CHF: 0.9143, IDR: 20208.93 },
});
const NAMES = { names: { USD: 'United States Dollar', EUR: 'Euro', GBP: 'British Pound' }, fetchedAt: Date.now() };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// fetch stub: `routes` maps URL -> response factory (or a thrown error); every call is recorded.
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new TypeError('Failed to fetch');
    return route(opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okRoutes = () => ({ [RATES_URL]: () => json(RATES_JSON), [NAMES_URL]: () => json(NAMES_JSON) });

async function makeApp(seed = {}) {
  const { CurrencyApp } = await import('../apps/currency/currency-app.js');
  const app = new CurrencyApp();
  app.storage = makeStorage(seed);
  app.locale = 'en-US';
  return {
    app,
    prefs: () => app.storage.get('app:currency'),
    cache: () => app.storage.get('app:currency:rates'),
    names: () => app.storage.get('app:currency:names'),
  };
}

test('first open without a cache: loading state, then fetches ECB rates and names once and converts 1 EUR to USD', async () => {
  const net = stubFetch(okRoutes());
  const { app, cache, names } = await makeApp();
  try {
    app.connectedCallback();
    assert.match(app.innerHTML, /Loading rates/);
    assert.doesNotMatch(app.innerHTML, /retry-button/);
    await flush();
    await flush();

    assert.deepStrictEqual(net.calls.sort(), [NAMES_URL, RATES_URL].sort());
    const stored = cache();
    assert.strictEqual(stored.base, 'EUR');
    assert.strictEqual(stored.date, '2026-11-06');
    assert.strictEqual(stored.rates.USD, 1.1555);
    assert.ok(Math.abs(stored.fetchedAt - Date.now()) < 5000);
    assert.deepStrictEqual(names().names, { USD: 'United States Dollar', EUR: 'Euro', GBP: 'British Pound' });

    assert.match(app.innerHTML, /class="currency-result__value numeral"[^>]*>1\.16</);
    assert.match(app.innerHTML, /ECB · <span class="num">Nov 6, 2026<\/span>/);
    assert.match(app.innerHTML, /1 EUR = 1\.1555 USD/);
    assert.doesNotMatch(app.innerHTML, /NaN|undefined/);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('fresh cached rates show at once and are not refetched; names are fetched only when missing', async () => {
  const net = stubFetch(okRoutes());
  const { app } = await makeApp({ 'app:currency:rates': CACHE(Date.now() - 3600 * 1000), 'app:currency:names': NAMES });
  try {
    app.connectedCallback();
    assert.match(app.innerHTML, />1\.16</, 'cached result rendered synchronously');
    await flush();
    assert.deepStrictEqual(net.calls, []);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('stale cache + failed refresh keeps the cached rates and says "Update failed"', async () => {
  const net = stubFetch({ [RATES_URL]: () => json({ status: 500 }, 500) });
  const { app, cache } = await makeApp({ 'app:currency:rates': CACHE(Date.now() - 7 * 3600 * 1000), 'app:currency:names': NAMES });
  try {
    app.connectedCallback();
    await flush();
    await flush();
    assert.deepStrictEqual(net.calls, [RATES_URL]);
    assert.match(app.innerHTML, />1\.16</);
    assert.match(app.innerHTML, /Update failed/);
    assert.strictEqual(cache().fetchedAt < Date.now() - 6 * 3600 * 1000, true, 'cache untouched');
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('no cache + failure explains and offers Retry; Retry loads the rates', async () => {
  let fail = true;
  const net = stubFetch({
    [RATES_URL]: () => { if (fail) throw new TypeError('Failed to fetch'); return json(RATES_JSON); },
    [NAMES_URL]: () => json(NAMES_JSON),
  });
  const { app } = await makeApp();
  try {
    app.connectedCallback();
    await flush();
    await flush();
    assert.match(app.innerHTML, /Can.t reach the rates service/);
    assert.match(app.innerHTML, /class="action-button retry-button"/);
    assert.doesNotMatch(app.innerHTML, /class="currency-result__value/);

    fail = false;
    await app.retry();
    assert.match(app.innerHTML, />1\.16</);
    assert.doesNotMatch(app.innerHTML, /retry-button/);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('a garbage response and a timeout are reported as failures, not crashes', async () => {
  const { app } = await makeApp();
  let net = stubFetch({ [RATES_URL]: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  try {
    await app.fetchRates();
    assert.deepStrictEqual(app.status, { kind: 'error', reason: 'bad-response' });
  } finally { net.restore(); }

  net = stubFetch({ [RATES_URL]: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  try {
    await app.fetchRates();
    assert.deepStrictEqual(app.status, { kind: 'error', reason: 'timeout' });
    assert.match(app.innerHTML, /timed out/);
  } finally { net.restore(); }
});

test('only the latest request may write the cache (sequence guard)', async () => {
  const { app, cache } = await makeApp();
  let releaseFirst;
  const first = new Promise(r => { releaseFirst = r; });
  let n = 0;
  const net = stubFetch({
    [RATES_URL]: async () => {
      n += 1;
      if (n === 1) { await first; return json(RATES_JSON.map(r => ({ ...r, date: '2026-11-05' }))); }
      return json(RATES_JSON);
    },
  });
  try {
    const older = app.fetchRates();
    await app.fetchRates();
    releaseFirst();
    await older;
    assert.strictEqual(cache().date, '2026-11-06');
  } finally { net.restore(); }
});

test('after a failure the next attempt waits (backoff); success resets it', async () => {
  const { app } = await makeApp({ 'app:currency:rates': CACHE(Date.now() - 7 * 3600 * 1000) });
  let net = stubFetch({});
  try {
    const t0 = Date.now();
    await app.refreshIfStale(t0);
    assert.strictEqual(app.failures, 1);
    assert.strictEqual(net.calls.length, 1);
    await app.refreshIfStale(t0 + 30 * 1000);
    assert.strictEqual(net.calls.length, 1, 'no retry inside the 1 min backoff');
    await app.refreshIfStale(t0 + 61 * 1000);
    assert.strictEqual(net.calls.length, 2);
    assert.strictEqual(app.failures, 2);
    assert.ok(app.retryAt - (t0 + 61 * 1000) >= 2 * 60 * 1000 - 50, 'backoff doubles');
  } finally { net.restore(); }

  net = stubFetch(okRoutes());
  try {
    await app.refreshIfStale(app.retryAt + 1);
    assert.strictEqual(app.failures, 0);
    assert.strictEqual(app.status.kind, 'ok');
  } finally { net.restore(); }
});

test('typing converts live; grouped and decimal-comma amounts work; invalid or negative shows nothing', async () => {
  const { app, prefs } = await makeApp({ 'app:currency:rates': CACHE(Date.now()), 'app:currency:names': NAMES });
  app.render();
  app.setAmount('1 234,5');
  assert.strictEqual(prefs().amount, '1 234,5');
  assert.match(app.innerHTML, />1,426\.46</);
  assert.match(app.innerHTML, /value="1 234,5"/);

  for (const bad of ['abc', '-5', '']) {
    app.setAmount(bad);
    assert.doesNotMatch(app.innerHTML, /NaN|Infinity|undefined/, bad);
    assert.match(app.innerHTML, /class="currency-result__value numeral"[^>]*><\/span>/, `empty result for "${bad}"`);
  }
  app.setAmount('abc');
  assert.match(app.innerHTML, /<input[^>]*aria-invalid="true"/);
  app.setAmount('');
  assert.doesNotMatch(app.innerHTML, /<input[^>]*aria-invalid="true"/, 'an empty field is not an error');
});

test('From / To selects and the swap button update the prefs; swap is labelled', async () => {
  const { app, prefs } = await makeApp({ 'app:currency:rates': CACHE(Date.now()) });
  app.render();
  assert.match(app.innerHTML, /<button[^>]*class="currency-swap"[^>]*aria-label="Swap currencies"/);
  assert.match(app.innerHTML, /<label class="field[^"]*"[^>]*>\s*<span class="label">Amount<\/span>\s*<input/);
  assert.match(app.innerHTML, /<span class="label">From<\/span>\s*<select/);
  assert.match(app.innerHTML, /<span class="label">To<\/span>\s*<select/);
  assert.match(app.innerHTML, /aria-live="polite"/);

  app.setTo('JPY');
  assert.strictEqual(prefs().to, 'JPY');
  assert.match(app.innerHTML, />177</, '1 EUR = 176.77 JPY rounds to whole yen');
  app.swap();
  assert.deepStrictEqual([prefs().from, prefs().to], ['JPY', 'EUR']);
  app.setFrom('EUR');
  assert.deepStrictEqual([prefs().from, prefs().to], ['EUR', 'JPY']);
  app.setFrom('JPY');
  assert.deepStrictEqual([prefs().from, prefs().to], ['JPY', 'EUR'], 'picking the To currency as From swaps them');
});

test('expanded list converts into favourites minus From; add and remove favourites', async () => {
  const { app, prefs } = await makeApp({ 'app:currency:rates': CACHE(Date.now()), 'app:currency:names': NAMES });
  app.setAmount('100');
  const rows = () => [...app.innerHTML.matchAll(/data-favorite="([A-Z]{3})"/g)].map(m => m[1]);
  assert.deepStrictEqual(rows(), ['USD', 'GBP', 'CHF', 'JPY'], 'EUR is From, so it is left out');
  assert.match(app.innerHTML, /United States Dollar/);
  assert.match(app.innerHTML, />115\.55</);
  assert.match(app.innerHTML, />17,677</);
  assert.match(app.innerHTML, /aria-label="Remove GBP from favourites"/);

  app.removeFavorite('GBP');
  assert.deepStrictEqual(prefs().favorites, ['USD', 'EUR', 'CHF', 'JPY']);
  app.addFavorite('IDR');
  assert.deepStrictEqual(prefs().favorites, ['USD', 'EUR', 'CHF', 'JPY', 'IDR']);
  app.addFavorite('IDR');
  app.addFavorite('XYZ');
  assert.deepStrictEqual(prefs().favorites, ['USD', 'EUR', 'CHF', 'JPY', 'IDR'], 'no duplicates or unknown codes');
  assert.match(app.innerHTML, /<span class="label">Add favourite<\/span>\s*<select/);
});

test('names and stored values are escaped', async () => {
  const { app } = await makeApp({
    'app:currency:rates': CACHE(Date.now()),
    'app:currency:names': { names: { USD: '<img src=x onerror=alert(1)>' }, fetchedAt: Date.now() },
    'app:currency': { amount: '"><script>x</script>', from: 'EUR', to: 'USD', favorites: ['USD'] },
  });
  app.render();
  assert.doesNotMatch(app.innerHTML, /<img src=x|<script>x/);
  assert.match(app.innerHTML, /&lt;img src=x/);
});

test('other tabs: prefs and rates re-render, but not while the amount field is being typed in', async () => {
  const { app } = await makeApp({ 'app:currency:rates': CACHE(Date.now()), 'app:currency:names': NAMES });
  const net = stubFetch({});
  try {
    app.connectedCallback();
    writeFromOtherTab('app:currency', { amount: '10', from: 'GBP', to: 'EUR', favorites: [] });
    assert.match(app.innerHTML, /value="10"/);
    assert.match(app.innerHTML, /<option value="GBP" selected>/);

    let renders = 0;
    const realRender = app.render.bind(app);
    app.render = () => { renders += 1; realRender(); };
    app.isTypingAmount = () => true;
    writeFromOtherTab('app:currency', { amount: '20', from: 'USD', to: 'EUR', favorites: [] });
    writeFromOtherTab('app:currency:rates', { ...CACHE(Date.now()), date: '2026-11-07' });
    assert.strictEqual(renders, 0, 'caret not stolen mid-typing');

    app.isTypingAmount = () => false;
    app.onAmountBlur();
    assert.strictEqual(renders, 1, 'deferred change shows once typing stops');
    assert.match(app.innerHTML, /value="20"/);
    assert.match(app.innerHTML, /Nov 7, 2026/);

    app.onAmountBlur();
    assert.strictEqual(renders, 1, 'nothing pending, no extra render');
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('own typing does not mark a re-render as pending', async () => {
  const { app } = await makeApp({ 'app:currency:rates': CACHE(Date.now()) });
  const net = stubFetch({});
  try {
    app.connectedCallback();
    app.isTypingAmount = () => true;
    app.setAmount('5');
    assert.strictEqual(app.pendingRender, false);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('palette: "100 usd to eur" shows the result and running it sets the converter; Swap currencies', async () => {
  clearCommands();
  const { app, prefs } = await makeApp({ 'app:currency:rates': CACHE(Date.now()), 'app:currency:names': NAMES });
  const net = stubFetch({});
  try {
    app.connectedCallback();
    const titles = (q) => collectCommands(q).map(c => c.title);
    assert.ok(titles('100 usd to eur').includes('100 USD = 86.54 EUR'), titles('100 usd to eur').join(' | '));
    assert.ok(titles('50 €→$').includes('50 EUR = 57.78 USD'));
    assert.ok(titles('gbp usd').includes('1 GBP = 1.39 USD'), 'no amount: the current amount (1)');
    assert.ok(!titles('pick up parcel').some(t => / = /.test(t)));

    collectCommands('100 usd in eur').find(c => c.title === '100 USD = 86.54 EUR').run();
    assert.deepStrictEqual([prefs().amount, prefs().from, prefs().to], ['100', 'USD', 'EUR']);
    assert.match(app.innerHTML, />86\.54</);

    collectCommands('jpy chf').find(c => / = /.test(c.title)).run();
    assert.deepStrictEqual([prefs().amount, prefs().from, prefs().to], ['100', 'JPY', 'CHF'], 'amount kept');

    const swap = collectCommands('swap curr').find(c => c.title === 'Swap currencies');
    assert.ok(swap);
    swap.run();
    assert.deepStrictEqual([prefs().from, prefs().to], ['CHF', 'JPY']);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
  assert.deepStrictEqual(collectCommands('100 usd to eur').filter(c => / = /.test(c.title)), [], 'unregistered on disconnect');
});
