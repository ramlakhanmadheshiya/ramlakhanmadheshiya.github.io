// Backups: plain JSON or passphrase-encrypted (PBKDF2 + AES-GCM via WebCrypto).
import { db } from './db.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function makeBackup(passphrase = '') {
  const data = await db.exportAll();
  const json = JSON.stringify(data);
  if (!passphrase) return new Blob([json], { type: 'application/json' });
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(passphrase, salt), enc.encode(json));
  // Chunked base64 so large backups don't overflow the call stack
  const bytes = new Uint8Array(ct); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return new Blob([JSON.stringify({ app: 'bill-studio', encrypted: true, salt: b64(salt), iv: b64(iv), data: btoa(bin) })], { type: 'application/json' });
}

export async function readBackup(text, passphrase = '') {
  const obj = JSON.parse(text);
  if (!obj.encrypted) return obj;
  if (!passphrase) { const e = new Error('This backup is encrypted. Enter its passphrase.'); e.code = 'PASS'; throw e; }
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, await key(passphrase, unb64(obj.salt)), unb64(obj.data));
    return JSON.parse(dec.decode(pt));
  } catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}
