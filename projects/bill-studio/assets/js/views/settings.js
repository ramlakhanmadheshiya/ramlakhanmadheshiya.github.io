import { icon } from '../lib/icons.js';
import { esc, toast, modal, confirmDialog, segmented, downloadBlob, pickFile, safeImg } from '../ui.js';
import { db, uid, STORES } from '../db.js';
import { state, saveBusiness, DOC_TYPE_LIST, formatNumber, nextNumber, defaultPreset, switchBusiness } from '../store.js';
import { getCountry } from '../tax/countries.js';
import { presetRate } from '../tax/engine.js';
import { todayISO } from '../lib/dates.js';
import { makeBackup, readBackup } from '../backup.js';
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
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  root.innerHTML = `<div class="page" style="max-width:860px">
    <div class="large-title"><div><h1>Settings</h1><p>Make Bill Studio work the way you do.</p></div></div>

    <div class="section-title">Appearance</div>
    <div class="group"><div class="row"><span class="grow">Theme</span><span data-theme-seg></span></div></div>

    <div class="section-title">Install as an app</div>
    <div class="card">
      ${standalone ? `<div class="flex">${icon('circle-check', 20)}<span>Bill Studio is installed on this device.</span></div>` : `
      <p class="small muted" style="margin-top:0">Install Bill Studio on your phone or computer. It opens like a normal app and <b>works fully offline</b>.</p>
      <div class="btn-row"><button class="btn primary" data-install ${installEvt ? '' : 'hidden'}>${icon('download', 16)} Install app</button></div>
      <div class="small" style="line-height:1.7">${isIOS ? `<b>iPhone / iPad:</b> tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.` : `<b>Chrome / Edge (Windows, Mac, Android):</b> use the install icon in the address bar, or the browser menu → <b>Install Bill Studio</b>.<br><b>iPhone / iPad:</b> Safari → Share → <b>Add to Home Screen</b>.`}</div>`}
    </div>

    <div class="section-title">Taxes</div>
    <div class="card">
      <p class="small muted" style="margin-top:0">${esc(c.flag)} ${esc(c.name)} defaults are pre-filled. Edit the names and rates to match your business.${c.gst ? ' GST rates are split into CGST + SGST or IGST automatically.' : ''}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Name on bill</th><th>Components</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${b.taxes.map((t, i) => `<tr><td>${esc(t.label)} ${t.id === b.defaultTaxId ? '<span class="badge partial">Default</span>' : ''}</td><td class="small muted">${t.gst ? 'CGST + SGST / IGST' : (t.components || []).map((x) => `${esc(x.name)} ${x.rate}%`).join(' + ') || 'No tax'}</td><td class="num">${presetRate(t)}%</td>
        <td class="num"><button class="btn sm" data-edit-tax="${i}">Edit</button></td></tr>`).join('')}</tbody></table></div>
      <div class="btn-row mt"><button class="btn sm" data-add-tax>${icon('plus', 14)} Add tax rate</button><button class="btn sm ghost" data-reset-tax>${icon('rotate-ccw', 14)} Restore ${esc(c.name)} defaults</button></div>
    </div>

    <div class="section-title">Bill numbering</div>
    <div class="card">
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

    <div class="section-title">Your data</div>
    <div class="card">
      <div class="notice mb">${icon('lock', 18)}<div>Your data is stored <b>only on this device</b>, inside this browser. Nobody else can see it — not even us. Back it up regularly and keep the file safe; if you clear browser data or lose the device, the backup is the only copy.</div></div>
      <dl class="kv"><dt>Last backup</dt><dd>${lastBackup ? new Date(lastBackup).toLocaleString(b.locale) : '<span class="warn-text">Never</span>'}</dd>
        <dt>Storage used</dt><dd>${est ? (est.usage / 1048576).toFixed(1) + ' MB' : '—'}</dd>
        <dt>Protected from automatic clean-up</dt><dd>${persisted ? 'Yes' : 'Not yet'}</dd></dl>
      <div class="btn-row mt">
        <button class="btn primary" data-backup>${icon('download', 16)} Back up now</button>
        <button class="btn" data-restore>${icon('upload', 16)} Restore from backup</button>
      </div>
    </div>

    <div class="section-title">Businesses on this device</div>
    <div class="group">${state.businesses.map((x) => `<div class="row"><span class="biz-avatar">${x.logo ? `<img src="${safeImg(x.logo)}" alt="">` : esc((x.name || '?')[0])}</span><div class="grow"><div class="title">${esc(x.name || 'Untitled')}</div><div class="sub">${esc(getCountry(x.country).name)} · ${esc(x.currency)}</div></div>
      ${x.id === b.id ? '<span class="badge partial">Active</span>' : `<button class="btn sm" data-switch-biz="${x.id}">Switch</button><button class="btn sm danger" data-del-biz="${x.id}">Delete</button>`}</div>`).join('')}
      <a class="row" href="#/welcome">${icon('plus', 18)}<span class="grow">Add another business</span>${icon('chevron-right', 16, 'chev')}</a></div>

    <div class="section-title">Danger zone</div>
    <div class="group"><div class="row"><div class="grow"><div class="title">Erase everything</div><div class="sub">Deletes all businesses, bills, customers and designs from this device.</div></div><button class="btn sm danger filled" data-wipe>Erase</button></div></div>

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
            <button class="btn sm mt-s" data-add-comp>${icon('plus', 14)} Add component</button><div class="help">E.g. Canada BC: GST 5% + PST 7%. Leave a single 0% component for exempt.</div></div>`}
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
      await db.setting('lastBackup', new Date().toISOString());
      m.close(); toast('Backup downloaded'); render(root);
    });
  });
  root.querySelector('[data-restore]').addEventListener('click', async () => {
    const f = await pickFile('.json,application/json'); if (!f) return;
    const text = await f.text();
    let data;
    try { data = await readBackup(text); }
    catch (e) {
      if (e.code !== 'PASS') { toast(e.message || 'Not a valid backup', 'err'); return; }
      const m = modal({ title: 'Encrypted backup', body: `<div class="field"><label>Passphrase</label><input class="input" type="password" data-pass></div>`, foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Unlock</button>` });
      data = await new Promise((res) => {
        m.el.querySelector('[data-ok]').addEventListener('click', async () => { try { const d = await readBackup(text, m.el.querySelector('[data-pass]').value); m.close(); res(d); } catch (er) { toast(er.message, 'err'); } });
        m.done.then(() => res(null));
      });
      if (!data) return;
    }
    const counts = STORES.map((s) => `${(data.stores?.[s] || []).length} ${s}`).join(', ');
    if (!(await confirmDialog('Restore this backup?', `It contains ${counts}. Everything currently on this device will be replaced.`, { ok: 'Replace & restore', danger: true }))) return;
    try {
      await db.importAll(data);
      const { loadState } = await import('../store.js');
      await loadState();
      toast('Backup restored');
      location.hash = '#/'; rerenderShell();
    } catch (e) { toast(e.message, 'err'); }
  });

  root.querySelectorAll('[data-switch-biz]').forEach((x) => x.addEventListener('click', () => switchBusiness(x.dataset.switchBiz)));
  root.querySelectorAll('[data-del-biz]').forEach((x) => x.addEventListener('click', async () => {
    const biz = state.businesses.find((y) => y.id === x.dataset.delBiz);
    if (!(await confirmDialog(`Delete ${biz.name}?`, 'All its bills, customers, items, payments and designs will be removed from this device.', { ok: 'Delete business', danger: true }))) return;
    for (const s of STORES.filter((s) => s !== 'businesses')) for (const r of await db.all(s, biz.id)) await db.del(s, r.id);
    await db.del('businesses', biz.id);
    state.businesses = await db.all('businesses');
    toast('Business deleted'); render(root);
  }));
  root.querySelector('[data-wipe]').addEventListener('click', async () => {
    if (!(await confirmDialog('Erase everything?', 'All data in Bill Studio on this device will be permanently deleted. Download a backup first if you might need it.', { ok: 'Erase everything', danger: true }))) return;
    await db.wipe(); state.business = null; state.businesses = [];
    toast('All data erased'); location.hash = '#/'; rerenderShell();
  });
}
