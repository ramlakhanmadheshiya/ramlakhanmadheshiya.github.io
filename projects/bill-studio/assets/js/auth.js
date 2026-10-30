// Team sign-in. Every person has their own User ID and password, stored only as a salted
// PBKDF2-SHA-256 hash in this browser's database — never in plain text. There are no default credentials:
// the first person to sign up on a device becomes the Owner and creates everyone else.
import { db, uid } from './db.js';
import { session, setSession, audit } from './session.js';

const ITER = 210000;
const SESSION_KEY = 'bs-session';
const MAX_FAILS = 5;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashPw(password, saltHex, iterations = ITER) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
}
async function secret(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iterations: ITER, hash: await hashPw(password, salt) };
}
const matches = async (password, rec) => !!rec?.hash && (await hashPw(password, rec.salt, rec.iterations)) === rec.hash;

// ---- Rules -------------------------------------------------------------------------------------
export const normUser = (v) => String(v || '').trim().toLowerCase();
export function usernameError(v) {
  return /^[a-z0-9._@-]{3,40}$/.test(normUser(v)) ? '' : 'User ID: 3–40 characters — letters, numbers, dot, dash, underscore or @ (no spaces).';
}
export function passwordError(pw, username = '') {
  if (String(pw).length < 8) return 'Password: use at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password: mix letters and numbers.';
  if (username && pw.toLowerCase().includes(normUser(username))) return 'Password must not contain the User ID.';
  return '';
}
// Easy to read out loud, hard to guess: e.g. "Kite-4827-Moss".
export function tempPassword() {
  const w = ['Kite', 'Moss', 'River', 'Cedar', 'Amber', 'Delta', 'Maple', 'Orbit', 'Pearl', 'Tiger', 'Lotus', 'Comet', 'Falcon', 'Harbor', 'Jade', 'Nova'];
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${w[r[0] % w.length]}-${String(1000 + (r[1] % 9000))}-${w[r[2] % w.length]}`;
}
function recoveryKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(r, (x) => A[x % A.length]).join('').match(/.{5}/g).join('-');
}

// ---- Organisation ------------------------------------------------------------------------------
export async function getOrg() { return (await db.setting('org')) || null; }
export async function saveOrg(o) { await db.setting('org', o); return o; }
export async function hasAccounts() { return (await db.count('users')) > 0; }
export async function allUsers() { return (await db.all('users')).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
export async function findUser(username) { return (await db.all('users')).find((u) => u.username === normUser(username)) || null; }

// Devices set up before team accounts had one owner sign-in in settings.auth — turn it into the Owner account.
export async function migrateLegacy() {
  if (await hasAccounts()) return;
  const a = await db.setting('auth');
  if (!a) return;
  const owner = { id: uid('usr_'), username: normUser(a.userId), name: a.ownerName || 'Owner', email: '', roleId: 'owner', status: 'active', businessIds: [],
    salt: a.salt, iterations: a.iterations, hash: a.hash, mustChangePassword: !!a.isDefault, passwordChangedAt: a.updatedAt };
  await db.put('users', owner);
  await saveOrg({ name: '', ownerId: owner.id, autoLockMin: a.autoLockMin ?? 15, createdAt: new Date().toISOString() });
  await db.setting('auth', null);
}

// First person on this device: creates the organisation and becomes its Owner.
export async function signUp({ name, username, password, email = '', orgName = '' }) {
  if (await hasAccounts()) throw new Error('This device already has an organisation. Ask its owner or a manager to add you.');
  if (!String(name).trim()) throw new Error('Please enter your name.');
  const ue = usernameError(username); if (ue) throw new Error(ue);
  const pe = passwordError(password, username); if (pe) throw new Error(pe);
  const key = recoveryKey();
  const user = { id: uid('usr_'), username: normUser(username), name: String(name).trim().slice(0, 60), email: String(email).trim(), roleId: 'owner', status: 'active',
    businessIds: [], mustChangePassword: false, passwordChangedAt: new Date().toISOString(), ...(await secret(password)) };
  await db.put('users', user);
  await saveOrg({ name: String(orgName).trim(), ownerId: user.id, autoLockMin: 15, createdAt: new Date().toISOString(), recovery: await secret(key.replace(/-/g, '')) });
  await startSession(user);
  await audit('Organisation created', `Owner account “${user.username}”`);
  return { user, recoveryKey: key };
}

export async function login(username, password) {
  const u = await findUser(username);
  const fail = 'User ID or password is incorrect.';
  if (!u) { await audit('Sign-in failed', `Unknown User ID “${normUser(username)}”`, { username: normUser(username) }); throw new Error(fail); }
  if (u.status !== 'active') { await audit('Sign-in refused', 'Account is disabled', { username: u.username, userName: u.name }); throw new Error('This account is disabled. Ask your manager or the owner.'); }
  if (u.lockedUntil && Date.now() < new Date(u.lockedUntil).getTime()) {
    throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((new Date(u.lockedUntil).getTime() - Date.now()) / 60000)} min, or ask a manager to reset it.`);
  }
  if (!(await matches(password, u))) {
    u.failedLogins = (u.failedLogins || 0) + 1;
    if (u.failedLogins >= MAX_FAILS) u.lockedUntil = new Date(Date.now() + Math.min(60, 5 * 2 ** (u.failedLogins - MAX_FAILS)) * 60000).toISOString();
    await db.putRaw('users', u);
    await audit('Sign-in failed', `Wrong password (${u.failedLogins})`, { username: u.username, userName: u.name });
    throw new Error(u.lockedUntil && Date.now() < new Date(u.lockedUntil).getTime() ? 'Too many wrong passwords — this account is locked for a few minutes.' : fail);
  }
  u.failedLogins = 0; u.lockedUntil = ''; u.lastLoginAt = new Date().toISOString();
  await db.putRaw('users', u);
  await startSession(u);
  await audit('Signed in');
  return u;
}

// ---- Session (per tab: survives reloads, ends when the tab closes, on sign-out or auto-lock) ----
async function startSession(user) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: user.id, at: Date.now() })); } catch { /* private mode */ }
  await setSession(user);
}
export async function resumeSession() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { s = null; }
  const u = s?.id ? await db.get('users', s.id) : null;
  if (!u || u.status !== 'active') { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } return null; }
  await setSession(u);
  return u;
}
export async function signOut(reason = 'Signed out') {
  if (session.user) await audit(reason);
  try { sessionStorage.removeItem(SESSION_KEY); if (reason !== 'Signed out') sessionStorage.setItem('bs-open-login', '1'); } catch { /* ignore */ }
  // Change the address without firing hashchange (which would re-render the app with no user), then reload.
  history.replaceState(null, '', location.pathname + location.search + '#/');
  location.reload();
}
export const lockNow = () => signOut('Locked');

let idleTimer;
export async function startAutoLock() {
  const min = Number((await getOrg())?.autoLockMin ?? 15) || 0;
  clearTimeout(idleTimer);
  if (!min) return;
  const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => signOut('Locked automatically'), min * 60000); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, arm, { passive: true }));
  arm();
}

// ---- Passwords ----------------------------------------------------------------------------------
export async function changeOwnPassword(current, next) {
  const u = await db.get('users', session.user.id);
  if (!(await matches(current, u))) throw new Error('Current password is wrong.');
  const pe = passwordError(next, u.username); if (pe) throw new Error(pe);
  if (await matches(next, u)) throw new Error('Choose a password different from the current one.');
  Object.assign(u, await secret(next), { mustChangePassword: false, passwordChangedAt: new Date().toISOString() });
  await db.put('users', u); await setSession(u);
  await audit('Changed own password');
}
// A manager resets someone's password: they must choose a new one at next sign-in.
export async function resetPassword(user, temp) {
  Object.assign(user, await secret(temp), { mustChangePassword: true, failedLogins: 0, lockedUntil: '', passwordChangedAt: new Date().toISOString() });
  await db.put('users', user);
}
export async function newUserRecord(data, password) {
  return { id: uid('usr_'), status: 'active', businessIds: [], mustChangePassword: true, passwordChangedAt: new Date().toISOString(), ...data, username: normUser(data.username), ...(await secret(password)) };
}
// Owner forgot the password: the recovery key from sign-up sets a new one.
export async function recoverOwner(key, next) {
  const org = await getOrg();
  const owner = org?.ownerId && (await db.get('users', org.ownerId));
  if (!owner || !org.recovery) throw new Error('No recovery key was set up on this device.');
  if (!(await matches(String(key).toUpperCase().replace(/[^A-Z0-9]/g, ''), org.recovery))) { await audit('Recovery failed', 'Wrong recovery key', { username: owner.username }); throw new Error('That recovery key is not correct.'); }
  const pe = passwordError(next, owner.username); if (pe) throw new Error(pe);
  Object.assign(owner, await secret(next), { mustChangePassword: false, failedLogins: 0, lockedUntil: '', status: 'active', passwordChangedAt: new Date().toISOString() });
  await db.put('users', owner);
  await audit('Owner password reset with recovery key', '', { username: owner.username, userName: owner.name });
  return owner;
}
export async function newRecoveryKey() {
  const key = recoveryKey();
  const org = await getOrg();
  await saveOrg({ ...org, recovery: await secret(key.replace(/-/g, '')) });
  await audit('New recovery key created');
  return key;
}
