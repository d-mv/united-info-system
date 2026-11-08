/**
 * Currency converter: pure logic (no DOM, no storage, no network).
 *
 * Rates come from one base (ECB publishes against EUR) as { base, date, rates },
 * where rates[code] = units of `code` per 1 base. Any pair is a cross rate
 * through the base: rates[to] / rates[from].
 */

export const DEFAULT_PREFS = Object.freeze({
  amount: '1',
  from: 'EUR',
  to: 'USD',
  favorites: Object.freeze(['USD', 'EUR', 'GBP', 'CHF', 'JPY']),
});

// Refetch once the cached rates are this old. ECB publishes once per working
// day (~16:00 CET), so a few refreshes a day are plenty.
export const REFRESH_MS = 6 * 3600 * 1000;
export const CHECK_MS = 3600 * 1000;
const RETRY_BASE_MS = 60 * 1000;

export const Ok = (value) => ({ _tag: 'Ok', value });
export const Err = (reason) => ({ _tag: 'Err', error: { reason } });

const CODE = /^[A-Z]{3}$/;
const isCode = (c) => typeof c === 'string' && CODE.test(c);
const upper = (c) => (typeof c === 'string' ? c.trim().toUpperCase() : '');

// ---------- Amount input ----------

// Digit grouping: spaces (incl. no-break / narrow no-break) and apostrophes are always groups.
const GROUP_CHARS = /[\s  ']/g;

/**
 * Parse a typed amount: "100", "1234.5", "1234,5", "1 234,5", "1,234.5", "1.234,5".
 * With both "," and "." the last one is the decimal mark. A lone "," before
 * exactly three digits ("1,234") groups thousands; otherwise it is a decimal comma.
 * Returns a finite number >= 0, or null (empty, negative, malformed).
 */
export function parseAmount(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const s = String(text).trim().replace(GROUP_CHARS, '');
  if (!s || /[^\d.,]/.test(s)) return null;

  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  let group = '';
  let decimal = '';
  if (commas && dots) {
    decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    group = decimal === ',' ? '.' : ',';
  } else if (commas > 1 || dots > 1) {
    group = commas ? ',' : '.';
  } else if (commas === 1) {
    if (/^\d{1,3},\d{3}$/.test(s)) group = ',';
    else decimal = ',';
  } else if (dots === 1) {
    decimal = '.';
  }

  let intPart = s;
  let fracPart = '';
  if (decimal) {
    const at = s.lastIndexOf(decimal);
    intPart = s.slice(0, at);
    fracPart = s.slice(at + 1);
    if (fracPart.includes(decimal) || intPart.includes(decimal) || /[^\d]/.test(fracPart)) return null;
  }
  if (group) {
    if (!new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(intPart)) return null;
    intPart = intPart.split(group).join('');
  }
  if (/[^\d]/.test(intPart) || (!intPart && !fracPart)) return null;
  const value = Number(`${intPart || '0'}.${fracPart || '0'}`);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// ---------- API responses (Frankfurter v2) ----------

/**
 * /v2/providers/ecb/rates -> [{ date, base, quote, rate }, …]
 * into { base, date, rates: { CODE: rate } } (the base itself at 1).
 */
export function parseRates(json) {
  if (!Array.isArray(json) || !json.length) return Err('bad-response');
  const base = json[0] && json[0].base;
  if (!isCode(base)) return Err('bad-response');
  const rates = {};
  let date = '';
  for (const row of json) {
    if (!row || row.base !== base || !isCode(row.quote)) return Err('bad-response');
    if (typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0) return Err('bad-response');
    rates[row.quote] = row.rate;
    if (typeof row.date === 'string' && row.date > date) date = row.date;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Err('bad-response');
  rates[base] = 1;
  return Ok({ base, date, rates });
}

/** /v2/currencies -> { CODE: name } for ISO currencies (crypto and metals left out). */
export function parseNames(json) {
  const names = {};
  if (!Array.isArray(json)) return names;
  for (const row of json) {
    if (row && row.type === 'currency' && isCode(row.iso_code) && typeof row.name === 'string') {
      names[row.iso_code] = row.name;
    }
  }
  return names;
}

// ---------- Conversion ----------

/** Units of `to` per 1 `from`, through the base; null when either is unknown. */
export function crossRate(cache, from, to) {
  const rates = cache && cache.rates;
  if (!rates) return null;
  const a = rates[from];
  const b = rates[to];
  if (!(a > 0) || !(b > 0)) return null;
  return from === to ? 1 : b / a;
}

export function convert(amount, cache, from, to) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const rate = crossRate(cache, from, to);
  return rate === null ? null : amount * rate;
}

// ---------- Formatting ----------

const formatters = new Map();
function numberFormat(locale, options) {
  const key = `${locale || ''}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat(locale, options));
  return formatters.get(key);
}

/** Minor-unit digits of a currency (USD 2, JPY 0); 2 when Intl doesn't know it. */
export function fractionDigits(code) {
  try {
    return numberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A converted amount, rounded to the currency's digits (tiny non-zero amounts keep 2 significant digits). */
export function formatMoney(value, code, locale) {
  if (!finite(value)) return '';
  const digits = fractionDigits(code);
  if (value !== 0 && Math.abs(value) < 10 ** -digits) {
    return numberFormat(locale, { minimumSignificantDigits: 2, maximumSignificantDigits: 2 }).format(value);
  }
  return numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** A unit rate: up to 4 decimals, or 4 significant digits below 1. */
export function formatRate(rate, locale) {
  if (!finite(rate)) return '';
  const options = Math.abs(rate) >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
  return numberFormat(locale, options).format(rate);
}

/** An amount as typed, without padding zeros. */
export function formatAmount(value, locale) {
  if (!finite(value)) return '';
  return numberFormat(locale, { maximumFractionDigits: 6 }).format(value);
}

/** 'YYYY-MM-DD' -> '6 Nov 2026' (locale order). */
export function formatRateDate(iso, locale) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) || Number.isNaN(d.getTime())) return String(iso ?? '');
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// ---------- Palette queries ----------

const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', '₱': 'PHP' };
const CUR = `([a-z]{3}|[${Object.keys(SYMBOLS).join('').replace('$', '\\$')}])`;
const AMT = "(\\d(?:[\\d\\s.,'\\u00a0\\u202f]*\\d)?)";
const SEP = '(?:\\s*(?:to|in|into|->|→|=)\\s*|\\s+)';
const AMOUNT_FIRST = new RegExp(`^(?:${AMT}\\s*)?${CUR}${SEP}${CUR}$`, 'i');
const SYMBOL_FIRST = new RegExp(`^${CUR}\\s*${AMT}${SEP}${CUR}$`, 'i');

const toCode = (token) => SYMBOLS[token] || token.toUpperCase();

/**
 * "100 usd to eur", "100 usd in eur", "usd eur", "50 €→$", "$20 to £"
 * -> { amount: number|null, from, to }, or null. Both currencies must be in `codes`.
 */
export function parseQuery(query, codes) {
  const q = String(query || '').trim();
  if (!q) return null;
  let amountText;
  let fromToken;
  let toToken;
  let m = q.match(AMOUNT_FIRST);
  if (m) [, amountText, fromToken, toToken] = m;
  else if ((m = q.match(SYMBOL_FIRST))) [, fromToken, amountText, toToken] = m;
  else return null;

  const known = new Set(codes || []);
  const from = toCode(fromToken);
  const to = toCode(toToken);
  if (from === to || !known.has(from) || !known.has(to)) return null;
  let amount = null;
  if (amountText !== undefined) {
    amount = parseAmount(amountText.trim());
    if (amount === null) return null;
  }
  return { amount, from, to };
}

// ---------- Preferences & refresh ----------

/** Stored prefs with defaults filled in. `amount` is the text as typed. */
export function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const from = upper(p.from);
  const to = upper(p.to);
  const favorites = Array.isArray(p.favorites)
    ? [...new Set(p.favorites.map(upper).filter(isCode))]
    : [...DEFAULT_PREFS.favorites];
  const amount = typeof p.amount === 'string' ? p.amount
    : finite(p.amount) ? String(p.amount) : DEFAULT_PREFS.amount;
  return {
    amount,
    from: isCode(from) ? from : DEFAULT_PREFS.from,
    to: isCode(to) ? to : DEFAULT_PREFS.to,
    favorites,
  };
}

/** True when there are no rates yet or they were fetched REFRESH_MS ago or more. */
export function needsRefresh(cache, now = Date.now()) {
  if (!cache || !cache.rates || !finite(cache.fetchedAt)) return true;
  return now - cache.fetchedAt >= REFRESH_MS;
}

/** Wait after the n-th failure in a row: 1, 2, 4, 8 … minutes, at most an hour. */
export function retryDelay(failures) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), CHECK_MS);
}
