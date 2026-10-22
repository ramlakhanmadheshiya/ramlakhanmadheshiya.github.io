// Backups: plain JSON or passphrase-encrypted (PBKDF2 + AES-GCM via WebCrypto).
import { db, STORES } from './db.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(json, passphrase) {
  if (!passphrase) return new Blob([json], { type: 'application/json' });
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(passphrase, salt), enc.encode(json));
  // Chunked base64 so large backups don't overflow the call stack
  const bytes = new Uint8Array(ct); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return new Blob([JSON.stringify({ app: 'bill-studio', encrypted: true, salt: b64(salt), iv: b64(iv), data: btoa(bin) })], { type: 'application/json' });
}

// Full backup of the whole device (all businesses, settings and the sign-in).
export async function makeBackup(passphrase = '') {
  const data = await db.exportAll();
  data.kind = 'full';
  data.counts = Object.fromEntries(Object.entries(data.stores).map(([k, v]) => [k, v.length]));
  return seal(JSON.stringify(data), passphrase);
}

const DATED = { documents: 'date', payments: 'date', expenses: 'date' };

// Selective export: one or all businesses, optionally only transactions in a date range.
// Master data (business profile, customers, items, designs) is always included so the receiving device can work.
export async function exportData({ businessId = null, from = '', to = '', passphrase = '' } = {}) {
  const data = { app: 'bill-studio', version: 1, kind: from || to ? 'range' : businessId ? 'business' : 'full', exportedAt: new Date().toISOString(), from, to, stores: {}, settings: {} };
  for (const st of STORES) {
    let rows = await db.all(st);
    if (businessId) rows = rows.filter((r) => (st === 'businesses' ? r.id === businessId : r.businessId === businessId));
    const f = DATED[st];
    if (f && (from || to)) rows = rows.filter((r) => (!from || (r[f] || '') >= from) && (!to || (r[f] || '') <= to));
    data.stores[st] = rows;
  }
  // Credit/debit notes in range may reference invoices outside it — include those invoices so links stay valid.
  if (from || to) {
    const ids = new Set(data.stores.documents.map((d) => d.id));
    const extra = (await db.all('documents')).filter((d) => !ids.has(d.id) && data.stores.documents.some((x) => x.refDocId === d.id || x.convertedFrom === d.id));
    data.stores.documents.push(...extra);
    const payDocs = new Set(data.stores.payments.map((p) => p.documentId).filter(Boolean));
    data.stores.documents.push(...(await db.all('documents')).filter((d) => payDocs.has(d.id) && !data.stores.documents.some((x) => x.id === d.id)));
  }
  data.counts = Object.fromEntries(Object.entries(data.stores).map(([k, v]) => [k, v.length]));
  data.businessNames = data.stores.businesses.map((b) => b.name);
  if (data.kind === 'full') { data.settings = (await db.exportAll()).settings; }
  return seal(JSON.stringify(data), passphrase);
}

// Import: 'merge' adds new records and updates ones that are newer in the file; 'replace' wipes this device first.
export async function importData(data, mode = 'merge') {
  if (!data || data.app !== 'bill-studio' || !data.stores) throw new Error('This file is not a Bill Studio export.');
  if (mode === 'replace') { await db.importAll(data, { replace: true }); return { mode, added: Object.values(data.stores).reduce((s, r) => s + r.length, 0), updated: 0, skipped: [] }; }
  const res = { mode, added: 0, updated: 0, skipped: [] };
  const existingDocs = await db.all('documents');
  for (const st of STORES) {
    for (const row of data.stores[st] || []) {
      if (!row?.id) continue;
      const cur = await db.get(st, row.id);
      if (st === 'documents' && !cur) {
        const clash = existingDocs.find((d) => d.businessId === row.businessId && d.type === row.type && d.number === row.number && d.id !== row.id);
        if (clash) { res.skipped.push(`${row.number} (a different bill with this number already exists)`); continue; }
      }
      if (!cur) { await rawPut(st, row); res.added++; }
      else if ((row.updatedAt || '') > (cur.updatedAt || '')) { await rawPut(st, row); res.updated++; }
    }
  }
  // Only copy settings that don't take over this device (keep its sign-in and active business).
  for (const [k, v] of Object.entries(data.settings || {})) if (!['auth', 'activeBusiness'].includes(k) && (await db.setting(k)) === undefined) await db.setting(k, v);
  return res;
}

// Put a record exactly as exported (keep its timestamps).
const rawPut = (store, row) => db.putRaw(store, row);

export async function readBackup(text, passphrase = '') {
  const obj = JSON.parse(text);
  if (!obj.encrypted) return obj;
  if (!passphrase) { const e = new Error('This backup is encrypted. Enter its passphrase.'); e.code = 'PASS'; throw e; }
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, await key(passphrase, unb64(obj.salt)), unb64(obj.data));
    return JSON.parse(dec.decode(pt));
  } catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}
