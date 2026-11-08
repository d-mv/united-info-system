import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseAmount, parseRates, parseNames, crossRate, convert, fractionDigits,
  formatMoney, formatRate, formatAmount, formatRateDate, parseQuery,
  normalizePrefs, DEFAULT_PREFS, needsRefresh, retryDelay, REFRESH_MS,
} from '../apps/currency/currency-logic.js';

// The ECB rates as the Frankfurter v2 provider route returns them (base EUR).
const RATES_JSON = [
  { date: '2026-11-06', base: 'EUR', quote: 'USD', rate: 1.1555 },
  { date: '2026-11-06', base: 'EUR', quote: 'EUR', rate: 1.0 },
  { date: '2026-11-06', base: 'EUR', quote: 'GBP', rate: 0.83415 },
  { date: '2026-11-06', base: 'EUR', quote: 'JPY', rate: 176.77 },
  { date: '2026-11-06', base: 'EUR', quote: 'CHF', rate: 0.9143 },
  { date: '2026-11-06', base: 'EUR', quote: 'IDR', rate: 20208.93 },
];
const RATES = { base: 'EUR', date: '2026-11-06', rates: { USD: 1.1555, EUR: 1, GBP: 0.83415, JPY: 176.77, CHF: 0.9143, IDR: 20208.93 } };
const CODES = Object.keys(RATES.rates);

test('parseAmount accepts plain, grouped and decimal-comma amounts', () => {
  assert.strictEqual(parseAmount('100'), 100);
  assert.strictEqual(parseAmount('1234.5'), 1234.5);
  assert.strictEqual(parseAmount('1234,5'), 1234.5);
  assert.strictEqual(parseAmount('1 234,5'), 1234.5);
  assert.strictEqual(parseAmount('1,234.5'), 1234.5);
  assert.strictEqual(parseAmount('1.234,5'), 1234.5);
  assert.strictEqual(parseAmount('1,234,567'), 1234567);
  assert.strictEqual(parseAmount('1.234.567'), 1234567);
  assert.strictEqual(parseAmount('1,234'), 1234, 'one comma before exactly three digits groups');
  assert.strictEqual(parseAmount('1,25'), 1.25);
  assert.strictEqual(parseAmount('1.5'), 1.5);
  assert.strictEqual(parseAmount('1 234 567,89'), 1234567.89, 'no-break spaces group');
  assert.strictEqual(parseAmount("1'234.5"), 1234.5);
  assert.strictEqual(parseAmount('  42  '), 42);
  assert.strictEqual(parseAmount('.5'), 0.5);
  assert.strictEqual(parseAmount('0'), 0);
});

test('parseAmount rejects empty, negative and malformed input', () => {
  for (const bad of ['', '   ', null, undefined, '-5', '−5', 'abc', '1e5', '1.2.3,4,5', '12abc', 'NaN', 'Infinity', '1,2,3', '1 2 3.4.5', ',', '.']) {
    assert.strictEqual(parseAmount(bad), null, `"${bad}"`);
  }
});

test('parseRates turns the provider response into a base-keyed map and keeps the base at 1', () => {
  const r = parseRates(RATES_JSON);
  assert.strictEqual(r._tag, 'Ok');
  assert.deepStrictEqual(r.value, RATES);

  const noBase = parseRates(RATES_JSON.filter(x => x.quote !== 'EUR'));
  assert.strictEqual(noBase.value.rates.EUR, 1, 'base added when the response omits it');
});

test('parseRates rejects responses it cannot use', () => {
  for (const bad of [null, {}, [], 'x', [{ quote: 'USD', rate: 'a', base: 'EUR', date: '2026-11-06' }], [{ quote: 'USD', rate: -1, base: 'EUR', date: '2026-11-06' }], [{ quote: '<b>', rate: 1, base: 'EUR', date: '2026-11-06' }]]) {
    const r = parseRates(bad);
    assert.strictEqual(r._tag, 'Err', JSON.stringify(bad));
    assert.strictEqual(r.error.reason, 'bad-response');
  }
});

test('parseNames maps ISO codes of currencies to names', () => {
  const names = parseNames([
    { iso_code: 'USD', name: 'United States Dollar', type: 'currency' },
    { iso_code: 'BTC', name: 'Bitcoin', type: 'crypto' },
    { iso_code: 'XAU', name: 'Gold', type: 'metal' },
    { iso_code: 'EUR', name: 'Euro', type: 'currency' },
    { iso_code: 'bad code', name: 'x', type: 'currency' },
  ]);
  assert.deepStrictEqual(names, { USD: 'United States Dollar', EUR: 'Euro' });
  assert.deepStrictEqual(parseNames(null), {});
});

test('crossRate goes through the base; convert multiplies; unknown codes give null', () => {
  assert.strictEqual(crossRate(RATES, 'EUR', 'USD'), 1.1555);
  assert.ok(Math.abs(crossRate(RATES, 'USD', 'EUR') - 1 / 1.1555) < 1e-12);
  assert.ok(Math.abs(crossRate(RATES, 'USD', 'GBP') - 0.83415 / 1.1555) < 1e-12);
  assert.strictEqual(crossRate(RATES, 'USD', 'USD'), 1);
  assert.strictEqual(crossRate(RATES, 'USD', 'XYZ'), null);
  assert.strictEqual(crossRate(null, 'USD', 'EUR'), null);
  assert.ok(Math.abs(convert(100, RATES, 'USD', 'EUR') - 86.5426) < 1e-3);
  assert.strictEqual(convert(null, RATES, 'USD', 'EUR'), null);
  assert.strictEqual(convert(1, RATES, 'USD', 'XYZ'), null);
});

test('fractionDigits follows the currency (JPY has none)', () => {
  assert.strictEqual(fractionDigits('USD'), 2);
  assert.strictEqual(fractionDigits('JPY'), 0);
  assert.strictEqual(fractionDigits('NOT A CODE'), 2);
});

test('formatMoney rounds per currency and never prints NaN', () => {
  assert.strictEqual(formatMoney(86.54259, 'EUR', 'en-US'), '86.54');
  assert.strictEqual(formatMoney(1234567.891, 'USD', 'en-US'), '1,234,567.89');
  assert.strictEqual(formatMoney(17677.4, 'JPY', 'en-US'), '17,677');
  assert.strictEqual(formatMoney(1234.5, 'EUR', 'de-DE'), '1.234,50');
  assert.strictEqual(formatMoney(0.0000495, 'EUR', 'en-US'), '0.000050', 'tiny amounts keep two significant digits');
  assert.strictEqual(formatMoney(0, 'EUR', 'en-US'), '0.00');
  assert.strictEqual(formatMoney(null, 'EUR', 'en-US'), '');
  assert.strictEqual(formatMoney(NaN, 'EUR', 'en-US'), '');
});

test('formatRate shows four decimals, or four significant digits below 1', () => {
  assert.strictEqual(formatRate(1.1555, 'en-US'), '1.1555');
  assert.strictEqual(formatRate(0.865426, 'en-US'), '0.8654');
  assert.strictEqual(formatRate(176.77, 'en-US'), '176.77');
  assert.strictEqual(formatRate(0.0000494831, 'en-US'), '0.00004948');
  assert.strictEqual(formatRate(null, 'en-US'), '');
});

test('formatAmount prints a typed amount without padding zeros', () => {
  assert.strictEqual(formatAmount(100, 'en-US'), '100');
  assert.strictEqual(formatAmount(1234.5, 'en-US'), '1,234.5');
});

test('formatRateDate prints the ECB date as a short day', () => {
  assert.strictEqual(formatRateDate('2026-11-06', 'en-GB'), '6 Nov 2026');
  assert.strictEqual(formatRateDate('nonsense', 'en-GB'), 'nonsense');
});

test('parseQuery reads "amount from to/in to" queries with ISO codes or symbols', () => {
  assert.deepStrictEqual(parseQuery('100 usd to eur', CODES), { amount: 100, from: 'USD', to: 'EUR' });
  assert.deepStrictEqual(parseQuery('100 USD in EUR', CODES), { amount: 100, from: 'USD', to: 'EUR' });
  assert.deepStrictEqual(parseQuery('usd eur', CODES), { amount: null, from: 'USD', to: 'EUR' });
  assert.deepStrictEqual(parseQuery('usd to jpy', CODES), { amount: null, from: 'USD', to: 'JPY' });
  assert.deepStrictEqual(parseQuery('100usd eur', CODES), { amount: 100, from: 'USD', to: 'EUR' });
  assert.deepStrictEqual(parseQuery('50 €→$', CODES), { amount: 50, from: 'EUR', to: 'USD' });
  assert.deepStrictEqual(parseQuery('50 € -> $', CODES), { amount: 50, from: 'EUR', to: 'USD' });
  assert.deepStrictEqual(parseQuery('$20 to £', CODES), { amount: 20, from: 'USD', to: 'GBP' });
  assert.deepStrictEqual(parseQuery('1 234,5 chf to jpy', CODES), { amount: 1234.5, from: 'CHF', to: 'JPY' });
  assert.deepStrictEqual(parseQuery('  gbp = usd ', CODES), { amount: null, from: 'GBP', to: 'USD' });
});

test('parseQuery ignores other text, unknown codes, same currency and bad amounts', () => {
  for (const q of ['', 'usd', '100 usd', 'pick up parcel', 'add task: usd eur', 'usd xyz', 'abc def', 'usd usd', '-5 usd eur', '1,2,3 usd eur', 'usd eur please']) {
    assert.strictEqual(parseQuery(q, CODES), null, `"${q}"`);
  }
  assert.strictEqual(parseQuery('usd eur', []), null, 'no rates yet: nothing is known');
});

test('normalizePrefs fills defaults and drops junk', () => {
  assert.deepStrictEqual(normalizePrefs(null), DEFAULT_PREFS);
  assert.deepStrictEqual(DEFAULT_PREFS, { amount: '1', from: 'EUR', to: 'USD', favorites: ['USD', 'EUR', 'GBP', 'CHF', 'JPY'] });
  assert.deepStrictEqual(
    normalizePrefs({ amount: 5, from: 'gbp', to: '<x>', favorites: ['usd', 'USD', 7, 'jpy'] }),
    { amount: '5', from: 'GBP', to: 'USD', favorites: ['USD', 'JPY'] },
  );
  assert.deepStrictEqual(normalizePrefs({ favorites: [] }).favorites, [], 'an emptied list stays empty');
  assert.strictEqual(normalizePrefs({ amount: '' }).amount, '', 'a cleared amount stays cleared');
});

test('needsRefresh: no cache, or fetched ~6 h ago', () => {
  const now = Date.UTC(2026, 10, 8, 12);
  assert.strictEqual(REFRESH_MS, 6 * 3600 * 1000);
  assert.strictEqual(needsRefresh(null, now), true);
  assert.strictEqual(needsRefresh({ ...RATES, fetchedAt: now - 3600 * 1000 }, now), false);
  assert.strictEqual(needsRefresh({ ...RATES, fetchedAt: now - REFRESH_MS }, now), true);
  assert.strictEqual(needsRefresh({ ...RATES, fetchedAt: now + 3600 * 1000 }, now), false, 'clock skew does not loop');
});

test('retryDelay backs off from 1 minute and caps at an hour', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 7, 20].map(n => retryDelay(n) / 60000), [1, 2, 4, 8, 60, 60]);
});
