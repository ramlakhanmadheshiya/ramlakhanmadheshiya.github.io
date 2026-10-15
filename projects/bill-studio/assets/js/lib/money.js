// Money helpers. Values are kept as decimal numbers but always rounded to the
// currency's minor unit with an epsilon-safe round, so totals never drift.

const decimalsCache = {};
export function currencyDecimals(currency) {
  if (decimalsCache[currency] != null) return decimalsCache[currency];
  let d = 2;
  try { d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { /* keep 2 */ }
  return (decimalsCache[currency] = d);
}

export function round(value, dp = 2) {
  const f = 10 ** dp;
  const n = Number(value) || 0;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
}

const fmtCache = new Map();
function formatter(currency, locale, opts = {}) {
  const key = `${currency}|${locale}|${JSON.stringify(opts)}`;
  if (!fmtCache.has(key)) {
    let f;
    try { f = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency, ...opts }); }
    catch { f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...opts }); }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}

export function fmtMoney(value, currency = 'USD', locale = 'en-US') {
  return formatter(currency, locale).format(round(value, currencyDecimals(currency)));
}

export function fmtCompact(value, currency = 'USD', locale = 'en-US') {
  return formatter(currency, locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

export function fmtNumber(value, locale = 'en-US', dp = 2) {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: dp }).format(Number(value) || 0);
}

export function fmtPlain(value, currency = 'USD', locale = 'en-US') {
  const d = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(round(value, d));
}

export function currencySymbol(currency, locale = 'en-US') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((x) => x.type === 'currency')?.value || currency;
  } catch { return currency; }
}

export function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
