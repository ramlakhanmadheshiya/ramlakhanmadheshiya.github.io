import { icon } from './lib/icons.js';
import { esc, menu, toast, safeImg } from './ui.js';
import { state, loadState, onChange, switchBusiness } from './store.js';
import { getCountry } from './tax/countries.js';
import { isUnlocked, showLogin, startAutoLock, lockNow } from './auth.js';

const ROUTES = [
  { re: /^\/?$/, view: 'dashboard', title: 'Home' },
  { re: /^\/bills\/new\/(\w+)$/, view: 'editor', title: 'New bill', keys: ['type'] },
  { re: /^\/bills\/([\w-]+)\/edit$/, view: 'editor', title: 'Edit bill', keys: ['id'] },
  { re: /^\/bills\/([\w-]+)$/, view: 'docview', title: 'Bill', keys: ['id'] },
  { re: /^\/bills$/, view: 'documents', title: 'Bills' },
  { re: /^\/customers\/([\w-]+)$/, view: 'customer', title: 'Customer', keys: ['id'] },
  { re: /^\/customers$/, view: 'customers', title: 'Customers' },
  { re: /^\/items$/, view: 'products', title: 'Items' },
  { re: /^\/money$/, view: 'money', title: 'Payments' },
  { re: /^\/reports$/, view: 'reports', title: 'Reports' },
  { re: /^\/templates\/([\w-]+)\/design$/, view: 'designer', title: 'Designer', keys: ['id'] },
  { re: /^\/templates$/, view: 'gallery', title: 'Templates' },
  { re: /^\/business$/, view: 'business', title: 'Business' },
  { re: /^\/settings$/, view: 'settings', title: 'Settings' },
];

const NAV = [
  { href: '#/', label: 'Home', icon: 'layout-dashboard', match: 'dashboard' },
  { href: '#/bills', label: 'Bills', icon: 'file-text', match: ['documents', 'docview', 'editor'] },
  { href: '#/customers', label: 'Customers', icon: 'users', match: ['customers', 'customer'] },
  { href: '#/items', label: 'Items', icon: 'package', match: 'products' },
  { href: '#/money', label: 'Payments', icon: 'wallet', match: 'money' },
  { href: '#/reports', label: 'Reports', icon: 'chart-column', match: 'reports' },
  { section: 'Design' },
  { href: '#/templates', label: 'Templates', icon: 'layout-template', match: ['gallery', 'designer'] },
  { href: '#/business', label: 'Business profile', icon: 'building-2', match: 'business' },
  { href: '#/settings', label: 'Settings', icon: 'settings', match: 'settings' },
];

let cleanup = null;
let renderToken = 0;

export function applyTheme(t) {
  state.theme = t;
  try { localStorage.setItem('bs-theme', t); } catch { /* private mode */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-theme-btn]').forEach((b) => (b.innerHTML = themeIcon()));
}
function themeIcon() {
  const t = state.theme;
  return icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'monitor', 18);
}
export function cycleTheme(anchor) {
  menu(anchor, [
    { label: 'Light', icon: 'sun', onClick: () => applyTheme('light') },
    { label: 'Dark', icon: 'moon', onClick: () => applyTheme('dark') },
    { label: 'Automatic', icon: 'monitor', onClick: () => applyTheme('system') },
  ]);
}

function shellHtml() {
  const b = state.business;
  const c = getCountry(b.country);
  return `<div class="shell">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand"><span class="brand-mark">${icon('receipt', 18)}</span>Bill Studio</div>
      <a href="#/bills/new/invoice" class="btn primary" style="margin:0 6px 14px">${icon('plus', 16)} New bill</a>
      <nav class="nav">${NAV.map((n) => n.section ? `<div class="nav-label">${n.section}</div>` : `<a href="${n.href}" data-match="${[].concat(n.match).join(',')}">${icon(n.icon, 18)}<span>${n.label}</span></a>`).join('')}</nav>
      <div class="side-foot">
        <button class="biz-switch" data-biz>
          <span class="biz-avatar">${b.logo ? `<img src="${safeImg(b.logo)}" alt="">` : esc((b.name || '?').slice(0, 1).toUpperCase())}</span>
          <span style="min-width:0;flex:1"><div class="biz-name">${esc(b.name || 'My business')}</div><div class="biz-sub">${c.flag} ${esc(c.name)} · ${esc(b.currency)}</div></span>
          ${icon('chevron-down', 14)}
        </button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar" id="topbar">
        <span class="mobile-only brand-mark" style="width:28px;height:28px">${icon('receipt', 16)}</span>
        <div class="topbar-title" id="topbar-title"></div>
        <div class="spacer"></div>
        <button class="btn icon ghost" data-theme-btn aria-label="Change theme" title="Appearance">${themeIcon()}</button>
        <button class="btn icon ghost" data-lock aria-label="Lock Bill Studio" title="Lock">${icon('lock', 18)}</button>
        <a href="#/bills/new/invoice" class="btn primary sm desktop-only">${icon('plus', 15)} New bill</a>
      </header>
      <main id="view" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Tabs">
      <a href="#/" data-match="dashboard">${icon('layout-dashboard', 22)}<span>Home</span></a>
      <a href="#/bills" data-match="documents,docview,editor">${icon('file-text', 22)}<span>Bills</span></a>
      <a href="#/bills/new/invoice" class="tab-new">${icon('plus', 22)}<span>New</span></a>
      <a href="#/customers" data-match="customers,customer">${icon('users', 22)}<span>Customers</span></a>
      <button data-more>${icon('ellipsis', 22)}<span>More</span></button>
    </nav>
  </div>`;
}

function bindShell(root) {
  root.querySelector('[data-theme-btn]').addEventListener('click', (e) => cycleTheme(e.currentTarget));
  root.querySelector('[data-lock]').addEventListener('click', () => lockNow());
  root.querySelector('[data-biz]').addEventListener('click', (e) => {
    menu(e.currentTarget, [
      ...state.businesses.map((x) => ({ label: (x.id === state.business.id ? '✓ ' : '') + (x.name || 'Untitled business'), icon: 'building-2', onClick: () => switchBusiness(x.id) })),
      '-',
      { label: 'Add another business', icon: 'plus', onClick: () => { location.hash = '#/welcome'; } },
    ]);
  });
  root.querySelector('[data-more]').addEventListener('click', (e) => {
    menu(e.currentTarget, [
      { label: 'Items', icon: 'package', onClick: () => (location.hash = '#/items') },
      { label: 'Payments', icon: 'wallet', onClick: () => (location.hash = '#/money') },
      { label: 'Reports', icon: 'chart-column', onClick: () => (location.hash = '#/reports') },
      { label: 'Templates', icon: 'layout-template', onClick: () => (location.hash = '#/templates') },
      '-',
      { label: 'Business profile', icon: 'building-2', onClick: () => (location.hash = '#/business') },
      { label: 'Settings', icon: 'settings', onClick: () => (location.hash = '#/settings') },
      ...(state.businesses.length > 1 ? ['-', ...state.businesses.filter((x) => x.id !== state.business.id).map((x) => ({ label: `Switch to ${x.name || 'Untitled'}`, icon: 'building-2', onClick: () => switchBusiness(x.id) }))] : []),
      { label: 'Add another business', icon: 'plus', onClick: () => (location.hash = '#/welcome') },
    ]);
  });
}

// One global scroll listener (the shell can be rebuilt many times).
window.addEventListener('scroll', () => document.getElementById('topbar')?.classList.toggle('scrolled', window.scrollY > 24), { passive: true });

// Keyboard access: clickable rows are focusable and open with Enter / Space.
const KEY_ROWS = 'tr.click, .row.click, [data-href], [data-r]';
new MutationObserver(() => document.querySelectorAll(KEY_ROWS).forEach((el) => { if (!el.hasAttribute('tabindex') && el.tagName !== 'A') el.tabIndex = 0; }))
  .observe(document.body, { childList: true, subtree: true });
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.(KEY_ROWS) && e.target.tagName !== 'A') { e.preventDefault(); e.target.click(); }
});

function match(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) { const params = {}; (r.keys || []).forEach((k, i) => (params[k] = m[i + 1])); return { ...r, params }; }
  }
  return null;
}

async function route() {
  const token = ++renderToken;
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const query = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const app = document.getElementById('app');

  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  document.querySelectorAll('.menu, .overlay').forEach((m) => m.remove()); // dialogs never outlive their page

  if (!state.business || path === '/welcome') {
    const { render } = await import('./views/onboarding.js');
    if (token !== renderToken) return;
    app.dataset.mode = 'welcome';
    const done = await render(app, { adding: !!state.business });
    if (token === renderToken) cleanup = done;
    return;
  }

  if (app.dataset.mode !== 'shell') {
    app.innerHTML = shellHtml();
    app.dataset.mode = 'shell';
    bindShell(app);
  }
  const r = match(path) || ROUTES[0];
  document.querySelectorAll('[data-match]').forEach((a) => a.classList.toggle('active', a.dataset.match.split(',').includes(r.view)));
  const view = document.getElementById('view');
  document.getElementById('topbar-title').textContent = r.title;
  document.title = `${r.title} · Bill Studio`;
  try {
    const mod = await import(`./views/${r.view}.js`);
    if (token !== renderToken) return;
    view.innerHTML = '';
    window.scrollTo(0, 0);
    const done = await mod.render(view, { ...r.params, query });
    if (token !== renderToken) { if (typeof done === 'function') done(); return; }
    cleanup = done;
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="page"><div class="empty"><div class="ic-wrap">${icon('triangle-alert', 28)}</div><h3>Something went wrong</h3><p>${esc(err.message)}</p><a class="btn" href="#/">Go home</a></div></div>`;
  }
}

export function setTitle(t) {
  const el = document.getElementById('topbar-title');
  if (el) el.textContent = t;
  document.title = `${t} · Bill Studio`;
}

export function rerenderShell() {
  const app = document.getElementById('app');
  app.dataset.mode = '';
  route();
}

async function boot() {
  try {
    await loadState();
  } catch (e) {
    document.getElementById('app').innerHTML = `<div style="padding:40px;font-family:system-ui;text-align:center"><h2>Storage is unavailable</h2><p>Bill Studio stores your data in this browser. Private browsing mode may block it — please open the app in a normal window.</p></div>`;
    return;
  }
  try { state.theme = localStorage.getItem('bs-theme') || 'light'; } catch { state.theme = 'light'; }
  applyTheme(state.theme);
  if (!window.crypto?.subtle) {
    document.getElementById('app').innerHTML = `<div style="padding:40px;font-family:system-ui;text-align:center"><h2>Secure context required</h2><p>Open Bill Studio over https://, from localhost, or as the offline file — this browser blocks the security features it needs here.</p></div>`;
    return;
  }
  // Owner sign-in before anything is shown.
  if (!isUnlocked()) {
    const app = document.getElementById('app');
    await showLogin(app, { firstRun: !state.business });
    app.dataset.mode = '';
  }
  startAutoLock();
  onChange(() => rerenderShell());
  window.addEventListener('hashchange', route);
  await route();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => {
        if (!w || document.querySelector('.update-bar')) return;
        const bar = document.createElement('div');
        bar.className = 'toast update-bar';
        bar.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:300;pointer-events:auto';
        bar.innerHTML = `<span>A new version of Bill Studio is ready.</span><button class="btn sm primary" style="margin-left:8px">Update</button>`;
        bar.querySelector('button').addEventListener('click', () => w.postMessage('skipWaiting'));
        document.body.append(bar);
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    }).catch(() => {});
  }
}

boot();
