// Tax-ID validators. They only warn — the user can always save.

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinChecksum(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}

export function validateGSTIN(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { ok: true, empty: true };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { ok: false, msg: 'GSTIN should look like 22AAAAA0000A1Z5 (15 characters).' };
  if (gstinChecksum(g.slice(0, 14)) !== g[14]) return { ok: false, msg: 'GSTIN check digit does not match — please re-check.' };
  return { ok: true, state: g.slice(0, 2), pan: g.slice(2, 12) };
}

export function validatePAN(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (!v) return { ok: true, empty: true };
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v) ? { ok: true } : { ok: false, msg: 'PAN should look like ABCDE1234F.' };
}

export function validateABN(raw) {
  const d = String(raw || '').replace(/\s/g, '');
  if (!d) return { ok: true, empty: true };
  if (!/^\d{11}$/.test(d)) return { ok: false, msg: 'ABN has 11 digits.' };
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = d.split('').reduce((s, c, i) => s + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0);
  return sum % 89 === 0 ? { ok: true } : { ok: false, msg: 'ABN checksum does not match.' };
}

// Format checks per country. EU VAT numbers carry their country prefix (e.g. DE123456789).
const EU_VAT = {
  AT: /^ATU\d{8}$/, BE: /^BE[01]\d{9}$/, BG: /^BG\d{9,10}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/, DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/, EE: /^EE\d{9}$/, GR: /^EL\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^HR\d{11}$/, HU: /^HU\d{8}$/, IE: /^IE\d{7}[A-W][A-I]?$|^IE\d[A-Z+*]\d{5}[A-W]$/, IT: /^IT\d{11}$/, LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/, LV: /^LV\d{11}$/, MT: /^MT\d{8}$/, NL: /^NL\d{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/, SI: /^SI\d{8}$/, SK: /^SK\d{10}$/,
};
const FORMATS = {
  GB: [/^(GB)?(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/, 'UK VAT numbers are GB followed by 9 digits (e.g. GB123456789).'],
  AE: [/^100\d{12}$/, 'A UAE TRN is 15 digits starting with 100.'],
  SA: [/^3\d{13}3$/, 'A Saudi VAT number is 15 digits that start and end with 3.'],
  BH: [/^\d{15}$/, 'A Bahrain VAT account number is 15 digits.'],
  OM: [/^OM\d{10}$/, 'An Oman VATIN looks like OM1100000000.'],
  JP: [/^T\d{13}$/, 'A qualified-invoice registration number is T followed by 13 digits.'],
  NZ: [/^\d{8,9}$/, 'An NZ GST number has 8 or 9 digits.'],
  SG: [/^([STFGM]\d{7}[A-Z]|\d{8,9}[A-Z]|[A-Z]\d{2}[A-Z]{2}\d{4}[A-Z]|M[0-9A-Z]\d{7}[A-Z])$/, 'Use your GST registration number (usually your UEN, e.g. 201912345K).'],
  CA: [/^\d{9}(RT\d{4})?$/, 'A GST/HST number is your 9-digit business number + RT0001 (e.g. 123456789RT0001).'],
  US: [/^\d{2}-?\d{7}$/, 'An EIN looks like 12-3456789.'],
  CH: [/^CHE-?\d{3}\.?\d{3}\.?\d{3}( ?(MWST|TVA|IVA))?$/, 'A Swiss UID looks like CHE-123.456.789 MWST.'],
  NO: [/^(NO)?\d{9}(MVA)?$/, 'A Norwegian VAT number is 9 digits followed by MVA.'],
  ZA: [/^4\d{9}$/, 'A South African VAT number is 10 digits starting with 4.'],
  MY: [/^[A-Z]\d{2}-\d{4}-\d{8}$/, 'An SST registration number looks like W10-1808-31000001.'],
};

export function validateTaxId(country, raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (!v) return { ok: true, empty: true };
  if (country === 'IN') return validateGSTIN(v);
  if (country === 'AU') return validateABN(v);
  const compact = v.replace(/[\s.]/g, '');
  // A customer in another EU country: validate against the prefix they carry.
  const pre = compact.slice(0, 2) === 'EL' ? 'GR' : compact.slice(0, 2);
  if (EU_VAT[country] && EU_VAT[pre] && pre !== country) return EU_VAT[pre].test(compact) ? { ok: true } : { ok: false, msg: `That doesn’t look like a valid ${compact.slice(0, 2)} VAT number.` };
  if (EU_VAT[country]) {
    const prefixed = /^[A-Z]{2}/.test(compact) ? compact : (country === 'GR' ? 'EL' : country) + compact;
    return EU_VAT[country].test(prefixed) ? { ok: true } : { ok: false, msg: `That doesn’t look like a ${country === 'GR' ? 'EL' : country} VAT number (it should start with ${country === 'GR' ? 'EL' : country}).` };
  }
  const f = FORMATS[country];
  if (f) return f[0].test(country === 'CH' || country === 'MY' ? v : compact) ? { ok: true } : { ok: false, msg: f[1] };
  return { ok: true };
}

export function validateEmail(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
