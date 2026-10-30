// Tiny promise wrapper over IndexedDB. Everything stays on this device.

const DB_NAME = 'bill-studio';
const VERSION = 2;
export const STORES = ['businesses', 'customers', 'products', 'documents', 'payments', 'expenses', 'templates'];
// Organisation-wide stores (team members, roles, activity log). Included in full backups only.
export const ORG_STORES = ['users', 'roles', 'audit'];

// The signed-in team member, stamped on every record they create or change.
let actor = '';
export function setActor(id) { actor = id || ''; }

let dbPromise;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const os = db.createObjectStore(s, { keyPath: 'id' });
          os.createIndex('businessId', 'businessId', { unique: false });
        }
      }
      for (const s of ORG_STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export function uid(prefix = '') {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Date.now().toString(36) + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

export const db = {
  async get(store, id) {
    const d = await open();
    return reqP(d.transaction(store).objectStore(store).get(id));
  },
  async put(store, obj) {
    const now = new Date().toISOString();
    if (store !== 'settings') {
      if (!obj.id) obj.id = uid();
      if (!obj.createdAt) obj.createdAt = now;
      obj.updatedAt = now;
      if (actor && store !== 'audit') { if (!obj.createdBy) obj.createdBy = actor; obj.updatedBy = actor; }
    }
    await tx(store, 'readwrite', (os) => os.put(obj));
    return obj;
  },
  // Write without touching timestamps (used by imports).
  async putRaw(store, obj) { await tx(store, 'readwrite', (os) => os.put(obj)); return obj; },
  async count(store) { const d = await open(); return reqP(d.transaction(store).objectStore(store).count()); },
  async del(store, id) { await tx(store, 'readwrite', (os) => os.delete(id)); },
  async all(store, businessId) {
    const d = await open();
    const os = d.transaction(store).objectStore(store);
    if (businessId) return reqP(os.index('businessId').getAll(businessId));
    return reqP(os.getAll());
  },
  async setting(key, value) {
    const d = await open();
    if (value === undefined) return reqP(d.transaction('settings').objectStore('settings').get(key));
    await tx('settings', 'readwrite', (os) => os.put(value, key));
    return value;
  },
  async exportAll() {
    const data = { app: 'bill-studio', version: VERSION, exportedAt: new Date().toISOString(), stores: {}, settings: {} };
    for (const s of [...STORES, ...ORG_STORES]) data.stores[s] = await this.all(s);
    const d = await open();
    const os = d.transaction('settings').objectStore('settings');
    const keys = await reqP(os.getAllKeys());
    for (const k of keys) data.settings[k] = await this.setting(k);
    return data;
  },
  async importAll(data, { replace = true } = {}) {
    if (!data || data.app !== 'bill-studio' || !data.stores) throw new Error('This file is not a Bill Studio backup.');
    // An older backup (before team accounts) keeps this device's team so nobody is locked out.
    const withOrg = ORG_STORES.some((s) => data.stores[s]?.length);
    for (const s of [...STORES, ...(withOrg ? ORG_STORES : [])]) {
      if (replace) await tx(s, 'readwrite', (os) => os.clear());
      const rows = data.stores[s] || [];
      if (rows.length) await tx(s, 'readwrite', (os) => { for (const r of rows) os.put(r); });
    }
    for (const [k, v] of Object.entries(data.settings || {})) await this.setting(k, v);
  },
  async wipe() {
    for (const s of [...STORES, ...ORG_STORES, 'settings']) await tx(s, 'readwrite', (os) => os.clear());
  },
};
