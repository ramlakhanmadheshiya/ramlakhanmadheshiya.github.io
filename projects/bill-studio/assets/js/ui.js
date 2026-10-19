import { icon } from './lib/icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const nl2br = (v) => esc(v).replace(/\n/g, '<br>');
// Only embedded images we created ourselves (data URLs) may be used as <img src> — blocks injected markup from tampered backups.
export const safeImg = (src) => (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(String(src || '')) ? src : '');

export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, kind = 'ok') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.append(host); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = (kind === 'ok' ? icon('circle-check', 18) : kind === 'err' ? icon('triangle-alert', 18) : '') + `<span>${esc(msg)}</span>`;
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

// Modal: returns { el, close, done } where done is a promise resolving with the close value.
export function modal({ title = '', body = '', foot = '', wide = false, onMount } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon sm ghost" data-close aria-label="Close">${icon('x', 18)}</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  document.body.append(ov);
  const prevFocus = document.activeElement;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const close = (val) => {
    ov.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(val);
  };
  // Esc closes only the top-most dialog.
  const onKey = (e) => { if (e.key === 'Escape' && [...document.querySelectorAll('.overlay')].at(-1) === ov) { e.stopImmediatePropagation(); close(undefined); } };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(undefined); });
  ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(undefined)));
  const m = ov.querySelector('.modal');
  onMount?.(m, close);
  setTimeout(() => (m.querySelector('input:not([type=hidden]):not([type=file]), select, textarea') || m).focus?.(), 30);
  return { el: m, close, done };
}

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  const m = modal({
    title, body: `<p class="muted" style="margin:0">${esc(message)}</p>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger filled' : 'primary'}" data-ok>${esc(ok)}</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', () => m.close(true));
  return m.done.then((v) => !!v);
}

export function promptDialog(title, { label = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  const m = modal({
    title,
    body: `<div class="field"><label>${esc(label)}</label><input class="input" data-val value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button>`,
  });
  const inp = m.el.querySelector('[data-val]');
  const submit = () => m.close(inp.value.trim());
  m.el.querySelector('[data-ok]').addEventListener('click', submit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return m.done;
}

// Popover menu anchored to an element. items: [{label, icon, onClick, danger} | '-']
export function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  items.forEach((it) => {
    if (it === '-') { el.append(document.createElement('hr')); return; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    b.innerHTML = (it.icon ? icon(it.icon, 16) : '') + `<span>${esc(it.label)}</span>`;
    b.addEventListener('click', () => { el.remove(); it.onClick?.(); });
    el.append(b);
  });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(r.right - w, window.innerWidth - w - 8); left = Math.max(8, left);
  let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = left + 'px'; el.style.top = top + 'px';
  const off = (e) => { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', off, true); } };
  el.addEventListener('keydown', (e) => {
    const items = [...el.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { el.remove(); anchor.focus?.(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  setTimeout(() => el.querySelector('button')?.focus(), 0);
  setTimeout(() => document.addEventListener('mousedown', off, true));
  return el;
}

export function segmented(options, value, onChange) {
  const el = document.createElement('div');
  el.className = 'segmented';
  el.setAttribute('role', 'tablist');
  const draw = () => {
    el.innerHTML = options.map(([v, l]) => `<button role="tab" aria-selected="${v === value}" class="${v === value ? 'on' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('');
  };
  draw();
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    value = b.dataset.v; draw(); onChange(value);
  });
  return el;
}

// Read an image file, downscale it and return a data URL (keeps the database small).
export function imageToDataURL(file, maxSize = 640) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) { reject(new Error('Please choose an image file.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (file.type === 'image/svg+xml') { resolve(reader.result); return; }
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, maxSize / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function pickFile(accept = '*/*') {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function downloadText(text, filename, type = 'text/plain') {
  downloadBlob(new Blob([text], { type }), filename);
}

export function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

export function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function emptyState(ic, title, text, actionHtml = '') {
  return `<div class="empty"><div class="ic-wrap">${icon(ic, 28)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${actionHtml}</div>`;
}

export function field(label, inputHtml, help = '', cls = '') {
  return `<div class="field ${cls}"><label>${esc(label)}</label>${inputHtml}${help ? `<div class="help">${help}</div>` : ''}</div>`;
}

export function switchHtml(name, checked, extra = '') {
  return `<label class="switch"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''} ${extra}><span></span></label>`;
}

// Serialise a form's named fields into an object (supports dotted names: bank.ifsc).
export function formData(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' && v !== '') v = Number(v);
    const path = el.name.split('.');
    let o = out;
    path.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; });
    o[path.at(-1)] = v;
  });
  return out;
}
