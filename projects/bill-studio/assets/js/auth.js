// Owner sign-in. Credentials are stored as a salted PBKDF2-SHA-256 hash in this browser's database —
// never in plain text. The default sign-in is ID 12345 / password 67890 until the owner changes it.
import { db } from './db.js';
import { icon } from './lib/icons.js';
import { esc, toast, confirmDialog } from './ui.js';

export const DEFAULT_ID = '12345';
const DEFAULT_PW = '67890';
const ITER = 210000;
const SESSION_KEY = 'bs-session';
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashPw(password, saltHex, iterations = ITER) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
}

async function makeRecord(userId, password, extra = {}) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { userId, salt, iterations: ITER, hash: await hashPw(password, salt), updatedAt: new Date().toISOString(), ...extra };
}

export async function getAuth() {
  let a = await db.setting('auth');
  if (!a) { a = await makeRecord(DEFAULT_ID, DEFAULT_PW, { ownerName: 'Owner', autoLockMin: 15, isDefault: true }); await db.setting('auth', a); }
  return a;
}

export async function checkLogin(userId, password) {
  const a = await getAuth();
  if (String(userId).trim() !== a.userId) return false;
  return (await hashPw(password, a.salt, a.iterations)) === a.hash;
}

export async function changeCredentials({ currentPassword, ownerName, userId, newPassword }) {
  const a = await getAuth();
  if ((await hashPw(currentPassword, a.salt, a.iterations)) !== a.hash) throw new Error('Current password is wrong.');
  const id = String(userId || a.userId).trim();
  if (!/^\S{3,40}$/.test(id)) throw new Error('User ID must be 3–40 characters with no spaces.');
  let rec = { ...a, ownerName: (ownerName || a.ownerName || 'Owner').trim().slice(0, 60), userId: id };
  if (newPassword) {
    if (newPassword.length < 4) throw new Error('Use a password of at least 4 characters (longer is safer).');
    rec = await makeRecord(id, newPassword, { ownerName: rec.ownerName, autoLockMin: a.autoLockMin, isDefault: false });
  }
  await db.setting('auth', rec);
  return rec;
}

export async function setAutoLock(min) { const a = await getAuth(); a.autoLockMin = Number(min) || 0; await db.setting('auth', a); }

// Session: survives reloads in the same tab, ends when the tab/browser closes or on lock.
export const isUnlocked = () => { try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; } };
const setUnlocked = (v) => { try { v ? sessionStorage.setItem(SESSION_KEY, '1') : sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } };

export function lockNow() { setUnlocked(false); location.hash = '#/'; location.reload(); }

let idleTimer;
export async function startAutoLock() {
  const a = await getAuth();
  const min = Number(a.autoLockMin) || 0;
  clearTimeout(idleTimer);
  if (!min) return;
  const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(lockNow, min * 60000); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, arm, { passive: true }));
  arm();
}

// Full-screen sign-in. Resolves when the owner signs in.
export function showLogin(root, { firstRun = false } = {}) {
  return new Promise(async (resolve) => {
    const a = await getAuth();
    let fails = Number(sessionStorage.getItem('bs-fails') || 0), until = 0;
    root.innerHTML = `<div class="welcome"><div class="welcome-inner" style="max-width:400px">
      <div class="hero-mark" style="width:72px;height:72px;border-radius:18px">${icon('lock', 34)}</div>
      <h1 style="font-size:34px;margin-bottom:6px">Bill Studio</h1>
      <p class="lead" style="margin-bottom:24px">Sign in to open your business data.</p>
      <form class="onb-card" data-login autocomplete="on" novalidate>
        <div class="field"><label for="lg-id">User ID</label><input class="input" id="lg-id" name="username" autocomplete="username" inputmode="text" required></div>
        <div class="field mt"><label for="lg-pw">Password</label><input class="input" id="lg-pw" name="password" type="password" autocomplete="current-password" required></div>
        <div class="help err mt-s" data-err role="alert"></div>
        <button class="btn primary lg mt" style="width:100%" type="submit">Sign in</button>
        ${firstRun && a.isDefault ? `<div class="notice mt">${icon('sparkles', 18)}<div>First time here? Sign in with User ID <b>${esc(DEFAULT_ID)}</b> and password <b>67890</b>, then change them in Settings.</div></div>` : ''}
        <button class="btn plain sm mt" type="button" data-forgot style="width:100%">Forgot password?</button>
      </form>
    </div></div>`;
    const form = root.querySelector('[data-login]');
    const err = root.querySelector('[data-err]');
    setTimeout(() => root.querySelector('#lg-id').focus(), 50);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (Date.now() < until) { err.textContent = `Too many attempts — wait ${Math.ceil((until - Date.now()) / 1000)} s.`; return; }
      const ok = await checkLogin(form.username.value, form.password.value);
      if (!ok) {
        fails++; sessionStorage.setItem('bs-fails', String(fails));
        if (fails >= 5) until = Date.now() + Math.min(300, 15 * 2 ** (fails - 5)) * 1000;
        err.textContent = 'User ID or password is incorrect.';
        form.password.value = ''; form.password.focus();
        form.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 260 });
        return;
      }
      sessionStorage.removeItem('bs-fails');
      setUnlocked(true);
      resolve(true);
    });
    root.querySelector('[data-forgot]').addEventListener('click', async () => {
      const ok = await confirmDialog('Forgot your password?',
        'For privacy, the password can’t be recovered or bypassed. You can erase all Bill Studio data on this device and start fresh — then restore your latest backup file (it brings back your data and the sign-in from when it was made).',
        { ok: 'Erase this device’s data…', danger: true });
      if (!ok) return;
      const typed = prompt('Type ERASE to permanently delete all Bill Studio data on this device.');
      if (typed !== 'ERASE') { toast('Nothing was erased'); return; }
      await db.wipe();
      setUnlocked(false);
      location.hash = '#/'; location.reload();
    });
  });
}
