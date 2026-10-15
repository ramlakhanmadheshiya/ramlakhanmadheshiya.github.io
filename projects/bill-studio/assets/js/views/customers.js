import { icon } from '../lib/icons.js';
import { esc, modal, toast, emptyState, pickFile, parseCSV, toCSV, downloadText } from '../ui.js';
import { db } from '../db.js';
import { state, list, customerLedger } from '../store.js';
import { getCountry } from '../tax/countries.js';
import { fmtMoney, num } from '../lib/money.js';
import { validateTaxId, validateEmail } from '../lib/validators.js';

export function customerDialog(cust = null) {
  const b = state.business;
  const c = getCountry(b.country);
  const x = cust || { name: '', phone: '', email: '', address: '', shipTo: '', taxId: '', region: b.region || '', openingBalance: 0, notes: '', taxExempt: false };
  const m = modal({
    title: cust ? 'Edit customer' : 'New customer',
    body: `<div class="form-grid">
      <div class="field span2"><label>Name *</label><input class="input" name="name" value="${esc(x.name)}" placeholder="Person or company"></div>
      <div class="field"><label>Phone</label><input class="input" type="tel" name="phone" value="${esc(x.phone)}" placeholder="With country code for WhatsApp"></div>
      <div class="field"><label>Email</label><input class="input" type="email" name="email" value="${esc(x.email)}"></div>
      <div class="field span2"><label>Billing address</label><textarea class="input" rows="2" name="address">${esc(x.address)}</textarea></div>
      <div class="field span2"><label>Shipping address</label><textarea class="input" rows="2" name="shipTo" placeholder="Leave empty if same">${esc(x.shipTo)}</textarea></div>
      <div class="field"><label>${esc(c.taxIdLabel)}</label><input class="input" name="taxId" value="${esc(x.taxId)}" autocapitalize="characters"><div class="help" data-th></div></div>
      ${c.regions ? `<div class="field"><label>${esc(c.regionLabel || 'Region')}</label><select class="input" name="region">${c.regions.map((r) => `<option value="${r.code}" ${r.code === x.region ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>` : '<div></div>'}
      <div class="field"><label>Opening balance (they owe you)</label><input class="input" type="number" step="any" name="openingBalance" value="${esc(x.openingBalance || '')}" placeholder="0"></div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;padding-top:22px;cursor:pointer"><input type="checkbox" name="taxExempt" ${x.taxExempt ? 'checked' : ''}> <span class="small">Tax-exempt customer</span></label>
      <div class="field span2"><label>Private notes</label><input class="input" name="notes" value="${esc(x.notes)}"></div>
    </div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>`,
  });
  const tax = m.el.querySelector('[name=taxId]');
  tax.addEventListener('input', () => {
    const v = validateTaxId(c.code, tax.value);
    m.el.querySelector('[data-th]').textContent = v.ok ? (v.state ? 'Valid ✓' : '') : v.msg;
    m.el.querySelector('[data-th]').className = 'help ' + (v.ok ? '' : 'warn');
    if (v.state) { const r = m.el.querySelector('[name=region]'); if (r) r.value = v.state; }
  });
  m.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const g = (n) => m.el.querySelector(`[name=${n}]`);
    const rec = { ...x, businessId: b.id };
    for (const k of ['name', 'phone', 'email', 'address', 'shipTo', 'taxId', 'notes']) rec[k] = g(k).value.trim();
    rec.taxId = rec.taxId.toUpperCase();
    if (g('region')) rec.region = g('region').value;
    rec.openingBalance = num(g('openingBalance').value);
    rec.taxExempt = g('taxExempt').checked;
    if (!rec.name) { toast('Name is required', 'err'); return; }
    if (!validateEmail(rec.email)) { toast('Email looks wrong', 'err'); return; }
    await db.put('customers', rec);
    toast('Customer saved');
    m.close(rec);
  });
  return m.done;
}

export async function render(root, { query = {} } = {}) {
  const b = state.business;
  const [customers, docs, payments] = await Promise.all([list('customers'), list('documents'), list('payments')]);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const rows = customers.map((c) => ({ c, bal: customerLedger(c, docs, payments, b).balance, bills: docs.filter((d) => d.customerId === c.id).length }))
    .sort((a, x) => x.bal - a.bal || a.c.name.localeCompare(x.c.name));
  let q = '';
  const totalDue = rows.reduce((s, r) => s + Math.max(0, r.bal), 0);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Customers</h1><p>${customers.length} customers · ${m(totalDue)} to collect</p></div>
      <div class="actions"><button class="btn" data-import>${icon('upload', 16)} Import CSV</button><button class="btn" data-export>${icon('download', 16)} Export</button><button class="btn primary" data-new>${icon('plus', 16)} New customer</button></div></div>
    <div class="toolbar"><div class="searchbar">${icon('search', 16)}<input class="input" data-q placeholder="Search name, phone, tax ID" aria-label="Search customers"></div></div>
    <div data-list></div></div>`;

  const draw = () => {
    const host = root.querySelector('[data-list]');
    if (!customers.length) { host.innerHTML = emptyState('users', 'No customers yet', 'Save customers to bill them faster and keep track of what they owe you.', `<button class="btn primary" data-new2>${icon('plus', 16)} Add customer</button>`); host.querySelector('[data-new2]').onclick = add; return; }
    const f = rows.filter(({ c }) => !q || [c.name, c.phone, c.email, c.taxId].join(' ').toLowerCase().includes(q));
    host.innerHTML = `<div class="group">${f.map(({ c, bal, bills }) => `
      <a class="row" href="#/customers/${c.id}"><span class="biz-avatar" style="border-radius:50%;background:var(--accent-soft);color:var(--accent)">${esc(c.name.slice(0, 1).toUpperCase())}</span>
        <div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${esc([c.phone, c.taxId].filter(Boolean).join(' · ') || `${bills} bills`)}</div></div>
        <div class="end"><div class="tnum ${bal > 0 ? '' : 'muted'}" style="font-weight:600">${m(bal)}</div><div class="tiny muted">${bal > 0.004 ? 'to collect' : bal < -0.004 ? 'advance' : 'settled'}</div></div>${icon('chevron-right', 16, 'chev')}</a>`).join('') || '<div class="row muted">No match</div>'}</div>`;
  };
  const add = async () => { if (await customerDialog()) render(root, {}); };
  draw();
  root.querySelector('[data-q]').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
  root.querySelector('[data-new]').addEventListener('click', add);
  root.querySelector('[data-export]').addEventListener('click', () => {
    downloadText(toCSV([['name', 'phone', 'email', 'address', 'taxId', 'region', 'openingBalance', 'balance'], ...rows.map(({ c, bal }) => [c.name, c.phone, c.email, c.address, c.taxId, c.region, c.openingBalance || 0, bal])]), 'customers.csv', 'text/csv');
  });
  root.querySelector('[data-import]').addEventListener('click', async () => {
    const f = await pickFile('.csv,text/csv');
    if (!f) return;
    const data = parseCSV(await f.text());
    const head = data.shift()?.map((h) => h.trim().toLowerCase()) || [];
    const col = (r, ...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return (r[i] || '').trim(); } return ''; };
    let n = 0;
    for (const r of data) {
      const name = col(r, 'name', 'customer', 'customer name');
      if (!name) continue;
      await db.put('customers', { businessId: b.id, name, phone: col(r, 'phone', 'mobile'), email: col(r, 'email'), address: col(r, 'address'), taxId: col(r, 'taxid', 'gstin', 'vat', 'tax id').toUpperCase(), region: col(r, 'region', 'state'), openingBalance: num(col(r, 'openingbalance', 'opening balance', 'balance')) });
      n++;
    }
    toast(`Imported ${n} customers`);
    render(root, {});
  });
  if (query.new) { history.replaceState(null, '', '#/customers'); add(); }
}
