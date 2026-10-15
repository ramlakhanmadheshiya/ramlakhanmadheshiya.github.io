// Date + financial-year helpers. Dates are stored as 'YYYY-MM-DD' strings.

export function todayISO() { return toISO(new Date()); }
export function toISO(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function parseISO(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
export function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + Number(n || 0)); return toISO(d); }
export function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

export function fmtDate(iso, locale = 'en-US', style = 'medium') {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(parseISO(iso)); } catch { return iso; }
}

// Financial year containing `iso`, given the month (1-12) the FY starts.
export function fyRange(iso, startMonth = 1) {
  const d = parseISO(iso || todayISO());
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  const start = new Date(y, startMonth - 1, 1);
  const end = new Date(y + 1, startMonth - 1, 0);
  return { start: toISO(start), end: toISO(end), startYear: y };
}

export function fyLabel(iso, startMonth = 1) {
  const { startYear } = fyRange(iso, startMonth);
  if (startMonth === 1) return String(startYear);
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

export function periodRange(key, startMonth = 1) {
  const t = todayISO(), d = parseISO(t);
  const first = (y, m) => toISO(new Date(y, m, 1));
  const last = (y, m) => toISO(new Date(y, m + 1, 0));
  switch (key) {
    case 'today': return { from: t, to: t };
    case 'week': return { from: addDays(t, -6), to: t };
    case 'month': return { from: first(d.getFullYear(), d.getMonth()), to: last(d.getFullYear(), d.getMonth()) };
    case 'lastmonth': return { from: first(d.getFullYear(), d.getMonth() - 1), to: last(d.getFullYear(), d.getMonth() - 1) };
    case 'quarter': { const q = Math.floor(d.getMonth() / 3) * 3; return { from: first(d.getFullYear(), q), to: last(d.getFullYear(), q + 2) }; }
    case 'fy': { const r = fyRange(t, startMonth); return { from: r.start, to: r.end }; }
    case 'lastfy': { const r = fyRange(addDays(fyRange(t, startMonth).start, -1), startMonth); return { from: r.start, to: r.end }; }
    case 'year': return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
    default: return { from: '2000-01-01', to: '2999-12-31' };
  }
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
