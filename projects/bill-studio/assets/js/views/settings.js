import { icon } from '../lib/icons.js';
import { esc, toast, modal, confirmDialog, segmented, downloadBlob, pickFile, safeImg } from '../ui.js';
import { db, uid, STORES } from '../db.js';
import { state, saveBusiness, DOC_TYPE_LIST, formatNumber, nextNumber, defaultPreset, switchBusiness } from '../store.js';
import { getCountry } from '../tax/countries.js';
import { presetRate } from '../tax/engine.js';
import { todayISO, addDays, periodRange, fmtDate } from '../lib/dates.js';
import { makeBackup, readBackup, exportData, importData } from '../backup.js';
import { getOrg, saveOrg, changeOwnPassword, lockNow, signOut, newRecoveryKey, passwordError } from '../auth.js';
import { session, can, isOwner, audit } from '../session.js';
import { PAPERS } from '../print.js';
import { BUILD, BUILT_ON } from '../version.js';
import { applyTheme, rerenderShell } from '../app.js';

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });

export async function render(root) {
  const b = state.business;
  const c = getCountry(b.country);
  const nexts = {};
  for (const t of DOC_TYPE_LIST) nexts[t.key] = (await nextNumber(b, t.key)).number;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const lastBackup = await db.setting('lastBackup');
  const org = (await getOrg()) || {};
  const u = session.user;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  root.innerHTML = `<div class="page" style="max-width:860px">
    <div class="large-title"><div><h1>Settings</h1><p>Make Bill Studio work the way you do.</p></div></div>

    <div class="section-title">Appearance</div>
    <div class="group"><div class="row"><span class="grow">Theme</span><span data-theme-seg></span></div></div>

    <div class="section-title">Your account</div>
    <div class="card">
      <dl class="kv"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>User ID</dt><dd class="mono">${esc(u.username)}</dd><dt>Role</dt><dd>${esc(session.role?.name || '')}</dd>
        <dt>Password last changed</dt><dd>${u.passwordChangedAt ? new Date(u.passwordChangedAt).toLocaleDateString(b.locale) : '—'}</dd></dl>
      <div class="btn-row mt"><button class="btn primary" data-cred>${icon('key-round', 16)} Change name or password</button><button class="btn" data-lock-now>${icon('lock', 16)} Lock</button><button class="btn" data-sign-out>${icon('log-out', 16)} Sign out</button>
        ${can('users.view|audit.view') ? `<a class="btn" href="#/team">${icon('shield', 16)} Team & roles</a>` : ''}</div>
    </div>

    ${can('users.manage') ? `<div class="section-title">Security</div>
    <div class="card">
      <div class="form-grid"><div class="field"><label>Lock automatically after (everyone on this device)</label><select class="input" data-autolock>${[[0, 'Never'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours']].map(([v, l]) => `<option value="${v}" ${Number(org.autoLockMin ?? 15) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Organisation name</label><input class="input" data-org-name value="${esc(org.name || '')}" placeholder="Shown on the sign-in page"></div></div>
      ${isOwner() ? `<div class="btn-row mt"><button class="btn" data-recovery>${icon('key-round', 16)} Create a new recovery key</button></div>
        <p class="help mt-s">${org.recovery ? 'A recovery key is set. Making a new one cancels the old key.' : '<b>No recovery key yet.</b> Create one so you can get back in if you forget your password.'}</p>` : ''}
      <p class="help mt-s">Sign-in keeps people out of each other’s work on this device and records who did what. Data is stored unencrypted in this browser, so also protect the computer with its own login, and keep backups encrypted with a passphrase.</p>
    </div>` : ''}

    <div class="section-title" data-perm="business.manage">Printing</div>
    <div class="group" data-perm="business.manage"><div class="row"><span class="grow">Default bill size<div class="sub">Used by Print and PDF; you can still choose another size each time.</div></span>
      <select class="input" data-paper-default style="width:auto;max-width:260px">${PAPERS.filter((x) => x.id !== 'custom').map((x) => `<option value="${x.id}" ${(b.printDefaults?.paper || (['US', 'CA', 'MX', 'PH'].includes(b.country) ? 'letter' : 'a4')) === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div></div>

    <div class="section-title">Install as an app</div>
    <div class="card">
      ${standalone ? `<div class="flex">${icon('circle-check', 20)}<span>Bill Studio is installed on this device.</span></div>` : `
      <p class="small muted" style="margin-top:0">Install Bill Studio on your phone or computer. It opens like a normal app and <b>works fully offline</b>.</p>
      <div class="btn-row"><button class="btn primary" data-install ${installEvt ? '' : 'hidden'}>${icon('download', 16)} Install app</button></div>
      <div class="small" style="line-height:1.7">${isIOS ? `<b>iPhone / iPad:</b> tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.` : `<b>Chrome / Edge (Windows, Mac, Android):</b> use the install icon in the address bar, or the browser menu → <b>Install Bill Studio</b>.<br><b>iPhone / iPad:</b> Safari → Share → <b>Add to Home Screen</b>.`}</div>`}
    </div>

    <div class="section-title" data-perm="business.manage">Taxes</div>
    <div class="card" data-perm="business.manage">
      <p class="small muted" style="margin-top:0">${esc(c.flag)} ${esc(c.name)} defaults are pre-filled. Edit the names and rates to match your business.${c.gst ? ' GST rates are split into CGST + SGST or IGST automatically.' : ''}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Name on bill</th><th>Components</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${b.taxes.map((t, i) => `<tr><td>${esc(t.label)} ${t.id === b.defaultTaxId ? '<span class="badge partial">Default</span>' : ''}</td><td class="small muted">${t.gst ? 'CGST + SGST / IGST' : (t.components || []).map((x) => `${esc(x.name)} ${x.rate}%`).join(' + ') || 'No tax'}</td><td class="num">${presetRate(t)}%</td>
        <td class="num"><button class="btn sm" data-edit-tax="${i}">Edit</button></td></tr>`).join('')}</tbody></table></div>
      <div class="btn-row mt"><button class="btn sm" data-add-tax>${icon('plus', 14)} Add tax rate</button><button class="btn sm ghost" data-reset-tax>${icon('rotate-ccw', 14)} Restore ${esc(c.name)} defaults</button></div>
    </div>

    <div class="section-title" data-perm="business.manage">Bill numbering</div>
    <div class="card" data-perm="business.manage">
      <p class="small muted" style="margin-top:0">Numbers are sequential${b.fyStartMonth !== 1 ? ' and restart every financial year' : ''}. ${c.maxNumberLength ? `GST rules allow up to ${c.maxNumberLength} characters.` : ''}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Document</th><th>Prefix</th><th>Digits</th><th>Year in number</th><th>Next number</th></tr></thead><tbody>
      ${DOC_TYPE_LIST.map((t) => { const s = b.series?.[t.key] || {}; return `<tr data-series="${t.key}"><td>${esc(t.label)}</td>
        <td><input class="input" style="height:32px;width:90px" data-s="prefix" value="${esc(s.prefix ?? t.prefix)}"></td>
        <td><input class="input" style="height:32px;width:64px" type="number" min="1" max="8" data-s="digits" value="${esc(s.digits ?? 4)}"></td>
        <td><label class="switch" style="transform:scale(.85)"><input type="checkbox" data-s="useFY" ${s.useFY !== false ? 'checked' : ''}><span></span></label></td>
        <td class="mono small" data-next="${t.key}">${esc(nexts[t.key])}</td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="btn-row mt"><button class="btn sm primary" data-save-series>Save numbering</button></div>
    </div>

    <div class="section-title" data-perm="data.backup|data.import">Your data</div>
    <div class="card" data-perm="data.backup|data.import">
      <div class="notice mb">${icon('lock', 18)}<div>Your data is stored <b>only on this device</b>, inside this browser. Nobody else can see it — not even us. Back it up regularly and keep the file safe; if you clear browser data or lose the device, the backup is the only copy.</div></div>
      <dl class="kv"><dt>Last backup</dt><dd>${lastBackup ? new Date(lastBackup).toLocaleString(b.locale) : '<span class="warn-text">Never</span>'}</dd>
        <dt>Storage used</dt><dd>${est ? (est.usage / 1048576).toFixed(1) + ' MB' : '—'}</dd>
        <dt>Protected from automatic clean-up</dt><dd>${persisted ? 'Yes' : 'Not yet'}</dd></dl>
      <div class="btn-row mt">
        <button class="btn primary" data-backup data-perm="data.backup">${icon('download', 16)} Full backup</button>
        <button class="btn" data-export data-perm="data.backup">${icon('file-down', 16)} Export a period / business</button>
        <button class="btn" data-import data-perm="data.import">${icon('upload', 16)} Import data</button>
      </div>
      <p class="help mt-s"><b>Moving to another computer or browser?</b> Make a full backup here, open Bill Studio on the other device, sign in, then use Import → Replace everything. To send only some days (e.g. from a branch), use Export a period, then Import → Merge on the other device.</p>
      <div class="btn-row" hidden>
      </div>
    </div>

    <div class="section-title" data-perm="business.add">Businesses on this device</div>
    <div class="group" data-perm="business.add">${state.businesses.map((x) => `<div class="row"><span class="biz-avatar">${x.logo ? `<img src="${safeImg(x.logo)}" alt="">` : esc((x.name || '?')[0])}</span><div class="grow"><div class="title">${esc(x.name || 'Untitled')}</div><div class="sub">${esc(getCountry(x.country).name)} · ${esc(x.currency)}</div></div>
      ${x.id === b.id ? '<span class="badge partial">Active</span>' : `<button class="btn sm" data-switch-biz="${x.id}">Switch</button><button class="btn sm danger" data-del-biz="${x.id}">Delete</button>`}</div>`).join('')}
      <a class="row" href="#/welcome">${icon('plus', 18)}<span class="grow">Add another business</span>${icon('chevron-right', 16, 'chev')}</a></div>

    ${location.protocol === 'file:' ? '' : `<div class="section-title">Run without internet / on your own server</div>
    <div class="card">
      <p class="small muted" style="margin-top:0">Bill Studio already works offline once opened. You can also keep a copy that runs straight from a file — no internet, no server, no installation.</p>
      <div class="btn-row"><a class="btn primary" href="downloads/Bill-Studio-offline.html" download>${icon('download', 16)} Offline app (single file)</a><a class="btn" href="downloads/bill-studio-offline.zip" download>${icon('download', 16)} Full package (.zip) for your server</a></div>
      <p class="help mt-s">Each copy keeps its own data in the browser it runs in. Move data between copies with Full backup → Import.</p>
    </div>`}

    <div class="section-title">About</div>
    <div class="card small">
      <dl class="kv"><dt>Version</dt><dd class="mono">${esc(BUILD)} · ${esc(BUILT_ON)}</dd><dt>Running as</dt><dd>${location.protocol === 'file:' ? 'Offline file' : standalone ? 'Installed app' : 'Web app'}</dd></dl>
      <p><b>Privacy.</b> Everything you enter stays in this browser on this device. Bill Studio has no account server, no analytics, no ads and no cookies; it never uploads your data. Sharing (WhatsApp, email, PDF) only happens when you tap it.</p>
      <p><b>Tax content.</b> Tax rates, titles and rules are researched defaults for each country (as of October 2026). You are responsible for your invoices — confirm with your tax advisor, and use your government’s e-invoicing system where it is mandatory.</p>
      <p><b>Open-source components.</b> qrcode-generator (MIT, Kazuhiko Arase) · html2canvas (MIT, Niklas von Hertzen) · jsPDF (MIT, yWorks / James Hall) · Inter typeface (SIL Open Font License, Rasmus Andersson) · Lucide icons (ISC).</p>
    </div>

    <div class="section-title" ${isOwner() ? '' : 'hidden style="display:none"'}>Danger zone</div>
    <div class="group" ${isOwner() ? '' : 'hidden style="display:none"'}><div class="row"><div class="grow"><div class="title">Erase everything</div><div class="sub">Deletes all businesses, bills, customers and designs from this device.</div></div><button class="btn sm danger filled" data-wipe>Erase</button></div></div>

    <p class="small muted mt-l" style="text-align:center">Bill Studio · free and private, made for every business.<br>Tax rates are defaults — please confirm them with your tax advisor.</p>
  </div>`;

  root.querySelector('[data-theme-seg]').append(segmented([['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']], state.theme, (v) => applyTheme(v)));

  root.querySelector('[data-install]')?.addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(root); });

  // Taxes
  const editTax = (i) => {
    const t = i == null ? { id: uid('tax_'), label: '', components: [{ name: c.taxName, rate: 0 }] } : JSON.parse(JSON.stringify(b.taxes[i]));
    const comps = t.gst ? null : (t.components?.length ? t.components : [{ name: c.taxName, rate: 0 }]);
    const m = modal({
      title: i == null ? 'New tax rate' : 'Edit tax rate',
      body: `<div class="form-grid">
        <div class="field span2"><label>Name shown on bills</label><input class="input" data-label value="${esc(t.label)}" placeholder="e.g. ${esc(c.taxName)} 18%"></div>
        ${t.gst ? `<div class="field span2"><label>GST rate %</label><input class="input" type="number" step="any" data-gst value="${esc(t.rate)}"><div class="help">Split automatically: half CGST + half SGST/UTGST within your state, full IGST across states.</div></div>`
          : `<div class="field span2"><label>Components</label><div data-comps>${comps.map((x, j) => `<div class="flex mt-s" data-comp="${j}"><input class="input" data-cn value="${esc(x.name)}" placeholder="Tax name"><input class="input" data-cr type="number" step="any" value="${esc(x.rate)}" placeholder="%" style="width:110px"></div>`).join('')}</div>
            <button class="btn sm mt-s" data-add-comp>${icon('plus', 14)} Add component</button><div class="help">${c.code === 'CA' ? 'E.g. British Columbia: GST 5% + PST 7%.' : c.code === 'US' ? 'E.g. State 6% + County 1.5% + City 1%.' : `E.g. ${esc(c.taxName)} plus a local levy.`} Leave a single 0% component for exempt.</div></div>`}
        <label class="check span2 flex"><input type="checkbox" data-def ${t.id === b.defaultTaxId ? 'checked' : ''}> Use as default for new items</label>
      </div>`,
      foot: `${i != null ? '<button class="btn danger" data-del style="margin-right:auto">Delete</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    });
    m.el.querySelector('[data-add-comp]')?.addEventListener('click', () => m.el.querySelector('[data-comps]').insertAdjacentHTML('beforeend', `<div class="flex mt-s"><input class="input" data-cn placeholder="Tax name"><input class="input" data-cr type="number" step="any" placeholder="%" style="width:110px"></div>`));
    m.el.querySelector('[data-ok]').addEventListener('click', async () => {
      if (t.gst) { t.rate = Number(m.el.querySelector('[data-gst]').value) || 0; }
      else t.components = [...m.el.querySelectorAll('[data-cn]')].map((el, j) => ({ name: el.value.trim() || c.taxName, rate: Number(m.el.querySelectorAll('[data-cr]')[j].value) || 0 })).filter((x, j, arr) => x.rate || arr.length === 1);
      t.label = m.el.querySelector('[data-label]').value.trim() || (t.gst ? `GST ${t.rate}%` : t.components.map((x) => `${x.name} ${x.rate}%`).join(' + '));
      const taxes = b.taxes.slice();
      if (i == null) taxes.push(t); else taxes[i] = t;
      const out = { ...b, taxes };
      if (m.el.querySelector('[data-def]').checked) out.defaultTaxId = t.id;
      await saveBusiness(out); m.close(true); toast('Tax saved');
    });
    m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (b.taxes.length <= 1) { toast('Keep at least one tax rate', 'err'); return; }
      const taxes = b.taxes.filter((_, j) => j !== i);
      await saveBusiness({ ...b, taxes, defaultTaxId: b.defaultTaxId === t.id ? taxes[0].id : b.defaultTaxId }); m.close(true); toast('Tax deleted');
    });
  };
  root.querySelectorAll('[data-edit-tax]').forEach((x) => x.addEventListener('click', () => editTax(Number(x.dataset.editTax))));
  root.querySelector('[data-add-tax]').addEventListener('click', () => editTax(null));
  root.querySelector('[data-reset-tax]').addEventListener('click', async () => {
    if (!(await confirmDialog('Restore default taxes?', `Your tax list will be replaced with ${c.name}'s defaults. Items using a removed rate fall back to the default.`, { ok: 'Restore' }))) return;
    await saveBusiness({ ...b, taxes: JSON.parse(JSON.stringify(c.presets)), defaultTaxId: defaultPreset(c.presets).id });
  });

  // Numbering
  const readSeries = () => {
    const series = JSON.parse(JSON.stringify(b.series || {}));
    root.querySelectorAll('[data-series]').forEach((row) => {
      const k = row.dataset.series;
      series[k] = { ...(series[k] || {}), prefix: row.querySelector('[data-s=prefix]').value.trim(), digits: Number(row.querySelector('[data-s=digits]').value) || 1, useFY: row.querySelector('[data-s=useFY]').checked };
    });
    return series;
  };
  root.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('input', () => {
    const series = readSeries();
    const k = el.closest('[data-series]').dataset.series;
    const seq = Number(String(nexts[k]).match(/(\d+)$/)?.[1] || 1);
    root.querySelector(`[data-next="${k}"]`).textContent = formatNumber({ ...b, series }, k, seq, todayISO());
  }));
  root.querySelector('[data-save-series]').addEventListener('click', async () => {
    const series = readSeries();
    for (const [k, v] of Object.entries(series)) {
      if (!v.prefix) { toast('Every document needs a prefix', 'err'); return; }
      if (c.gst && !/^[A-Za-z0-9/-]+$/.test(v.prefix)) { toast(`GST bill numbers may only use letters, digits, “/” and “-” (check ${k}).`, 'err'); return; }
      const sample = formatNumber({ ...b, series }, k, 10 ** (Number(v.digits) || 1) - 1, todayISO());
      if (c.maxNumberLength && sample.length > c.maxNumberLength) { toast(`${sample} is longer than ${c.maxNumberLength} characters — shorten the prefix or digits.`, 'err'); return; }
    }
    await saveBusiness({ ...b, series }); toast('Numbering saved');
  });

  // Backup / restore
  root.querySelector('[data-backup]').addEventListener('click', () => {
    const m = modal({
      title: 'Back up your data',
      body: `<p class="small muted" style="margin-top:0">Downloads one file with all businesses, bills, customers, items, payments and designs.</p>
        <div class="field"><label>Passphrase (optional, recommended)</label><input class="input" type="password" data-pass autocomplete="new-password" placeholder="Leave empty for an unencrypted file"><div class="help">If you set one, you’ll need it to restore. We can’t recover it for you.</div></div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${icon('download', 16)} Download backup</button>`,
    });
    m.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const pass = m.el.querySelector('[data-pass]').value;
      const blob = await makeBackup(pass);
      downloadBlob(blob, `bill-studio-backup-${todayISO()}${pass ? '-encrypted' : ''}.json`);
      audit('Full backup downloaded', pass ? 'encrypted' : 'not encrypted');
      await db.setting('lastBackup', new Date().toISOString());
      m.close(); toast('Backup downloaded'); render(root);
    });
  });
  const askPass = (text) => new Promise((res) => {
    const m = modal({ title: 'Encrypted file', body: `<div class="field"><label>Passphrase</label><input class="input" type="password" data-pass></div>`, foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Unlock</button>` });
    m.el.querySelector('[data-ok]').addEventListener('click', async () => { try { const d = await readBackup(text, m.el.querySelector('[data-pass]').value); m.close(); res(d); } catch (er) { toast(er.message, 'err'); } });
    m.done.then(() => res(null));
  });
  root.querySelector('[data-export]').addEventListener('click', () => {
    const m = modal({
      title: 'Export data',
      body: `<div class="form-grid">
        <div class="field span2"><label>Which business</label><select class="input" data-biz><option value="${b.id}">${esc(b.name)} (this business)</option>${state.businesses.length > 1 ? '<option value="">All businesses on this device</option>' : ''}</select></div>
        <div class="field span2"><label>Period</label><select class="input" data-per>${[['all', 'Everything (all dates)'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['fy', 'This financial year'], ['lastfy', 'Last financial year'], ['custom', 'Custom dates…']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field" data-cd hidden><label>From</label><input class="input" type="date" data-from value="${addDays(todayISO(), -30)}"></div>
        <div class="field" data-cd hidden><label>To</label><input class="input" type="date" data-to value="${todayISO()}"></div>
        <div class="field span2"><label>Passphrase (optional, recommended)</label><input class="input" type="password" data-pass autocomplete="new-password" placeholder="Encrypts the file"></div>
      </div><p class="help">Bills, payments and expenses are filtered by date. Your business profile, customers, items and designs are always included so the other device can keep working.</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${icon('download', 16)} Export</button>`,
    });
    const per = m.el.querySelector('[data-per]');
    per.addEventListener('change', () => m.el.querySelectorAll('[data-cd]').forEach((x) => (x.hidden = per.value !== 'custom')));
    m.el.querySelector('[data-ok]').addEventListener('click', async () => {
      let from = '', to = '';
      const v = per.value;
      if (/^\d+$/.test(v)) { from = addDays(todayISO(), -(Number(v) - 1)); to = todayISO(); }
      else if (v === 'custom') { from = m.el.querySelector('[data-from]').value; to = m.el.querySelector('[data-to]').value; if (!from || !to || from > to) { toast('Choose a valid date range', 'err'); return; } }
      else if (v !== 'all') { const r = periodRange(v, b.fyStartMonth); from = r.from; to = r.to; }
      const businessId = m.el.querySelector('[data-biz]').value || null;
      const pass = m.el.querySelector('[data-pass]').value;
      const blob = await exportData({ businessId, from, to, passphrase: pass });
      const tag = businessId ? (state.businesses.find((x) => x.id === businessId)?.name || 'business').replace(/[^\w-]+/g, '-').slice(0, 30) : 'all';
      downloadBlob(blob, `bill-studio-${tag}-${from || 'start'}-to-${to || todayISO()}${pass ? '-encrypted' : ''}.json`);
      audit('Data exported', `${tag} ${from || 'start'} to ${to || todayISO()}`);
      if (!from && !to && !businessId) await db.setting('lastBackup', new Date().toISOString());
      m.close(); toast('Export downloaded');
    });
  });
  root.querySelector('[data-import]').addEventListener('click', async () => {
    const f = await pickFile('.json,application/json'); if (!f) return;
    const text = await f.text();
    let data;
    try { data = await readBackup(text); } catch (e) { if (e.code !== 'PASS') { toast(e.message || 'Not a Bill Studio file', 'err'); return; } data = await askPass(text); if (!data) return; }
    if (!data || data.app !== 'bill-studio' || !data.stores) { toast('This file is not a Bill Studio export', 'err'); return; }
    const n = (k) => (data.stores[k] || []).length;
    const partial = data.kind === 'range' || data.kind === 'business';
    const m = modal({
      title: 'Import data',
      body: `<dl class="kv"><dt>Exported</dt><dd>${data.exportedAt ? new Date(data.exportedAt).toLocaleString(b.locale) : '—'}</dd>
        <dt>Businesses</dt><dd>${esc((data.businessNames || (data.stores.businesses || []).map((x) => x.name)).join(', ') || '—')}</dd>
        <dt>Period</dt><dd>${data.from || data.to ? `${data.from ? fmtDate(data.from, b.locale) : 'start'} – ${data.to ? fmtDate(data.to, b.locale) : 'today'}` : 'All dates'}</dd>
        <dt>Bills / payments / expenses</dt><dd>${n('documents')} / ${n('payments')} / ${n('expenses')}</dd>
        <dt>Customers / items / designs</dt><dd>${n('customers')} / ${n('products')} / ${n('templates')}</dd></dl>
        <div class="group mt" style="box-shadow:none;border:1px solid var(--sep)">
          <label class="row" style="cursor:pointer"><input type="radio" name="mode" value="merge" checked><span class="grow"><b>Merge into this device</b><div class="sub">Adds new records and updates ones that changed. Nothing here is deleted.</div></span></label>
          ${partial ? '' : `<label class="row" style="cursor:pointer"><input type="radio" name="mode" value="replace"><span class="grow"><b>Replace everything</b><div class="sub">Erases this device’s data first, then loads the file — including its sign-in ID and password.</div></span></label>`}
        </div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${icon('upload', 16)} Import</button>`,
    });
    m.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const mode = m.el.querySelector('[name=mode]:checked').value;
      if (mode === 'replace' && !(await confirmDialog('Replace everything?', 'All Bill Studio data on this device will be replaced by the file. Make a backup first if you might need it.', { ok: 'Replace', danger: true }))) return;
      try {
        const res = await importData(data, mode);
        audit(mode === 'replace' ? 'Data restored (replace everything)' : 'Data imported (merge)', `${res.added} added, ${res.updated} updated`);
        m.close();
        const { loadState } = await import('../store.js');
        await loadState();
        if (!state.business && state.businesses[0]) state.business = state.businesses[0];
        const msg = mode === 'replace' ? 'Data replaced from file' : `Imported: ${res.added} new, ${res.updated} updated${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`;
        if (res.skipped.length) await confirmDialog('Some bills were skipped', res.skipped.slice(0, 12).join('\n') + (res.skipped.length > 12 ? `\n…and ${res.skipped.length - 12} more` : ''), { ok: 'OK' });
        toast(msg);
        location.hash = '#/'; rerenderShell();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  // Account & security
  root.querySelector('[data-lock-now]').addEventListener('click', () => lockNow());
  root.querySelector('[data-sign-out]').addEventListener('click', () => signOut());
  root.querySelector('[data-paper-default]').addEventListener('change', async (e) => { await saveBusiness({ ...b, printDefaults: { ...(b.printDefaults || {}), paper: e.target.value } }, { quiet: true, log: 'Default bill size changed' }); toast('Default bill size saved'); });
  root.querySelector('[data-autolock]')?.addEventListener('change', async (e) => { await saveOrg({ ...(await getOrg()), autoLockMin: Number(e.target.value) }); audit('Auto-lock changed', `${e.target.value} min`); toast('Auto-lock updated — takes effect at next sign-in'); });
  root.querySelector('[data-org-name]')?.addEventListener('change', async (e) => { await saveOrg({ ...(await getOrg()), name: e.target.value.trim() }); audit('Organisation renamed', e.target.value.trim()); toast('Saved'); });
  root.querySelector('[data-recovery]')?.addEventListener('click', async () => {
    if (org.recovery && !(await confirmDialog('Create a new recovery key?', 'Your old recovery key will stop working.', { ok: 'Create new key' }))) return;
    const key = await newRecoveryKey();
    const m = modal({ title: 'Your new recovery key', body: `<p class="small" style="margin-top:0">Keep it somewhere safe, away from this computer. It is shown only now.</p><div class="mono" style="font-size:20px;text-align:center;padding:16px;border-radius:12px;background:var(--fill)">${esc(key)}</div>`,
      foot: `<button class="btn primary" data-close>I saved it</button>` });
    await m.done; render(root);
  });
  root.querySelector('[data-cred]').addEventListener('click', () => {
    const m = modal({
      title: 'Your account',
      body: `<form data-f autocomplete="on"><div class="form-grid">
        <div class="field span2"><label>Your name</label><input class="input" name="name" value="${esc(u.name)}"></div>
        <div class="field span2"><label>Email</label><input class="input" name="email" type="email" value="${esc(u.email || '')}"></div>
        <input type="text" name="username" autocomplete="username" value="${esc(u.username)}" hidden>
        <div class="field span2"><label>Current password (needed to change it)</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input class="input" type="password" name="pw1" autocomplete="new-password" placeholder="Leave empty to keep"></div>
        <div class="field"><label>Repeat new password</label><input class="input" type="password" name="pw2" autocomplete="new-password"></div>
      </div></form><p class="help">Your User ID can be changed only by deleting and re-adding the account, so your history stays linked to you.</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    });
    m.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const g = (n) => m.el.querySelector(`[name=${n}]`).value;
      if (!g('name').trim()) { toast('Enter your name', 'err'); return; }
      try {
        if (g('pw1')) {
          if (g('pw1') !== g('pw2')) { toast('New passwords don’t match', 'err'); return; }
          const pe = passwordError(g('pw1'), u.username); if (pe) { toast(pe, 'err'); return; }
          await changeOwnPassword(g('current'), g('pw1'));
        }
        const rec = await db.get('users', u.id);
        Object.assign(rec, { name: g('name').trim().slice(0, 60), email: g('email').trim() });
        await db.put('users', rec); Object.assign(session.user, rec);
        m.close(); toast('Account updated'); rerenderShell();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  root.querySelectorAll('[data-switch-biz]').forEach((x) => x.addEventListener('click', () => switchBusiness(x.dataset.switchBiz)));
  root.querySelectorAll('[data-del-biz]').forEach((x) => x.addEventListener('click', async () => {
    const biz = state.businesses.find((y) => y.id === x.dataset.delBiz);
    if (!(await confirmDialog(`Delete ${biz.name}?`, 'All its bills, customers, items, payments and designs will be removed from this device.', { ok: 'Delete business', danger: true }))) return;
    for (const s of STORES.filter((s) => s !== 'businesses')) for (const r of await db.all(s, biz.id)) await db.del(s, r.id);
    await db.del('businesses', biz.id);
    audit('Business deleted', biz.name || '');
    state.businesses = await db.all('businesses');
    toast('Business deleted'); render(root);
  }));
  root.querySelector('[data-wipe]').addEventListener('click', async () => {
    if (!isOwner()) return;
    if (!(await confirmDialog('Erase everything?', 'All data in Bill Studio on this device will be permanently deleted. Download a backup first if you might need it.', { ok: 'Erase everything', danger: true }))) return;
    await db.wipe(); state.business = null; state.businesses = [];
    toast('All data erased'); location.hash = '#/'; rerenderShell();
  });
}
