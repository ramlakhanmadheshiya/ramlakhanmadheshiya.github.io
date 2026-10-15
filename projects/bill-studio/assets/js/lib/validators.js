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

export function validateTaxId(country, raw) {
  if (country === 'IN') return validateGSTIN(raw);
  if (country === 'AU') return validateABN(raw);
  if (country === 'AE' || country === 'SA') {
    const d = String(raw || '').replace(/\s/g, '');
    if (!d) return { ok: true, empty: true };
    return /^\d{15}$/.test(d) ? { ok: true } : { ok: false, msg: 'Should be 15 digits.' };
  }
  if (country === 'JP') {
    const d = String(raw || '').trim().toUpperCase();
    if (!d) return { ok: true, empty: true };
    return /^T\d{13}$/.test(d) ? { ok: true } : { ok: false, msg: 'Should be T followed by 13 digits.' };
  }
  return { ok: true };
}

export function validateEmail(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
