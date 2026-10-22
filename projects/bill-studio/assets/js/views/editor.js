import { icon } from '../lib/icons.js';
import { esc, toast, debounce, confirmDialog } from '../ui.js';
import { db, uid } from '../db.js';
import { state, list, DOC_TYPES, DOC_TYPE_LIST, blankDoc, blankItem, saveDocument, docTitle, nextNumber, ownRecord } from '../store.js';
import { calculate, presetRate } from '../tax/engine.js';
import { getCountry, UNITS } from '../tax/countries.js';
import { fmtMoney, num, currencySymbol } from '../lib/money.js';
import { addDays, fyLabel } from '../lib/dates.js';
import { validateTaxId, validateGSTIN, validateEmail } from '../lib/validators.js';
import { businessTaxError } from '../tax/rules.js';
import { buildContext, mountPage } from '../render.js';
import { allTemplates, templateFor } from '../tplstore.js';
import { setTitle } from '../app.js';

const COPY_LABELS = ['', 'Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
const CHALLAN_LABELS = ['', 'Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consignor'];
const SUPPLY_TYPES = [['', 'Regular (domestic)'], ['export_igst', 'Export — with IGST'], ['export_lut', 'Export — under LUT / bond (no IGST)'],
  ['sez_igst', 'Supply to SEZ — with IGST'], ['sez_lut', 'Supply to SEZ — under LUT (no IGST)'], ['deemed', 'Deemed export']];

export async function render(root, params) {
  const b = state.business;
  const c = getCountry(b.country);
  const [customers, products, docs, templates] = await Promise.all([list('customers'), list('products'), list('documents'), allTemplates()]);
  const q = params.query || {};
  let doc, isNew = true, dirty = false;

  if (params.id) {
    doc = await db.get('documents', params.id);
    if (!ownRecord(doc)) { root.innerHTML = '<div class="page"><div class="empty"><h3>Bill not found</h3><a class="btn" href="#/bills">Back to bills</a></div></div>'; return; }
    if (doc.status === 'cancelled') { root.innerHTML = `<div class="page"><div class="empty"><h3>This bill is cancelled</h3><p>Cancelled bills can’t be edited. Duplicate it to issue a new bill.</p><a class="btn primary" href="#/bills/new/${doc.type}?dup=${doc.id}">Duplicate</a> <a class="btn" href="#/bills/${doc.id}">Back</a></div></div>`; return; }
    doc = JSON.parse(JSON.stringify(doc));
    delete doc.snap; // re-issued with the current business details when saved
    isNew = false;
  } else {
    const type = DOC_TYPES[params.type] ? params.type : 'invoice';
    doc = blankDoc(b, type);
    const src = q.from || q.dup || q.ref ? await db.get('documents', q.from || q.dup || q.ref) : null;
    if (src) {
      for (const k of ['customerId', 'customer', 'shipTo', 'placeOfSupply', 'items', 'charges', 'discount', 'discountType', 'inclusive', 'reverseCharge', 'taxExempt', 'notes', 'reference']) doc[k] = JSON.parse(JSON.stringify(src[k] ?? doc[k]));
      doc.items.forEach((i) => (i.id = uid('li_')));
      if (q.ref) { doc.refDocId = src.id; doc.refNumber = src.number; }
      if (q.from) doc.convertedFrom = src.id;
    }
    if (q.customer) {
      const cu = customers.find((x) => x.id === q.customer);
      if (cu) applyCustomer(cu);
    }
    if (!doc.items.length) doc.items.push(blankItem(b));
    const gstReg = c.code === 'IN' && b.taxScheme !== 'unregistered';
    if (gstReg && (type === 'invoice' || type === 'receipt')) doc.copyLabel = 'Original for Recipient';
    if (gstReg && type === 'challan') doc.copyLabel = 'Original for Consignee';
    const n = await nextNumber(b, doc.type, doc.date);
    doc.number = n.number;
  }
  let saveCustomer = isNew && !doc.customerId;
  let paidNow = DOC_TYPES[doc.type].paidNow ? { on: true, amount: 0, mode: 'cash', auto: true } : { on: false, amount: 0, mode: 'cash', auto: true };
  let tpl = await templateFor(doc);

  function applyCustomer(cu) {
    doc.customerId = cu.id;
    doc.customer = { name: cu.name, address: cu.address || '', taxId: cu.taxId || '', phone: cu.phone || '', email: cu.email || '', region: cu.region || '' };
    if (c.gst) doc.placeOfSupply = cu.region || b.region;
    if (cu.shipTo) doc.shipTo = cu.shipTo;
    if (cu.taxExempt) doc.taxExempt = true;
  }

  const t = () => DOC_TYPES[doc.type];
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const sym = currencySymbol(b.currency, b.locale);
  const taxOptions = (sel) => b.taxes.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  const registered = b.taxScheme !== 'unregistered' && b.taxScheme !== 'composition';
  // Reverse charge exists in India and VAT systems (EU, UK, Gulf, etc.) — not in US sales tax and similar.
  const RC_COUNTRY = !!(c.gst || c.taxName === 'VAT');

  setTitle(isNew ? `New ${t().label.toLowerCase()}` : `Edit ${doc.number}`);

  root.innerHTML = `<div class="page wide" style="max-width:1480px">
    <div class="large-title"><div><h1 data-h1>${isNew ? 'New' : 'Edit'} ${esc(docTitle(doc.type, b))}</h1><p class="mono small" data-num-sub>${esc(doc.number)}</p></div>
      <div class="actions">
        ${isNew ? `<select class="input" data-type style="width:auto;height:36px">${DOC_TYPE_LIST.map((x) => `<option value="${x.key}" ${x.key === doc.type ? 'selected' : ''}>${x.label}</option>`).join('')}</select>` : ''}
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn" data-draft>Save draft</button>
        <button class="btn primary" data-save>${icon('check', 16)} Save</button>
      </div></div>
    <div class="editor">
      <div class="form-pane">
        <div class="card" data-sec="customer"></div>
        <div class="card" data-sec="details"></div>
        <div class="card" data-sec="items"></div>
        <div class="card" data-sec="extras"></div>
        <div class="card" data-sec="payment"></div>
      </div>
      <div class="preview-pane">
        <div class="flex between mb wrap">
          <div class="flex gap-s"><span class="small muted">Design</span>
            <select class="input" data-tpl style="width:auto;height:32px;font-size:13px">${templates.map((x) => `<option value="${x.id}" ${x.id === tpl.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
          <a class="small" href="#/templates">${icon('layout-template', 14)} Customize designs</a>
        </div>
        <div class="paper-stage"><div data-paper class="paper-shadow" style="background:#fff"></div></div>
        <div class="card mt" data-totals></div>
      </div>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);

  // ---------- Sections ----------
  function drawCustomer() {
    const cu = doc.customer || {};
    const label = doc.type === 'purchase' ? 'Vendor' : 'Customer';
    $('[data-sec=customer]').innerHTML = `<div class="card-head"><h3>${label}</h3>${doc.customerId ? `<button class="btn plain sm" data-clear-cust>Change</button>` : ''}</div>
      <div class="form-grid">
        <div class="field span2" style="position:relative"><label>Name ${doc.type === 'receipt' ? '(optional for walk-in)' : '*'}</label>
          <div class="input-affix">${icon('search', 16)}<input class="input" data-k="customer.name" value="${esc(cu.name)}" placeholder="Search saved ${label.toLowerCase()}s or type a new name" autocomplete="off" data-cust-input></div>
          <div class="suggest" data-cust-suggest hidden style="left:0;right:0;top:100%"></div></div>
        <div class="field"><label>Phone</label><input class="input" type="tel" data-k="customer.phone" value="${esc(cu.phone)}"></div>
        <div class="field"><label>Email</label><input class="input" type="email" data-k="customer.email" value="${esc(cu.email)}"></div>
        <div class="field span2"><label>Billing address</label><textarea class="input" rows="2" data-k="customer.address">${esc(cu.address)}</textarea></div>
        <div class="field"><label>${esc(c.taxIdLabel)}</label><input class="input" data-k="customer.taxId" value="${esc(cu.taxId)}" placeholder="${c.code === 'IN' ? 'For B2B invoices' : 'Optional'}" autocapitalize="characters"><div class="help" data-cust-taxhelp></div></div>
        ${c.gst ? `<div class="field"><label>Place of supply</label><select class="input" data-k="placeOfSupply">${c.regions.map((r) => `<option value="${r.code}" ${r.code === doc.placeOfSupply ? 'selected' : ''}>${esc(r.name)} (${r.code})</option>`).join('')}</select>
          <div class="help" data-pos-help></div></div>` : '<div></div>'}
      </div>
      ${!doc.customerId ? `<label class="flex mt-s small" style="cursor:pointer"><input type="checkbox" data-save-cust ${saveCustomer ? 'checked' : ''}> Save to my customers</label>` : `<div class="help mt-s">${icon('check', 13)} Saved customer — edits here only change this bill.</div>`}`;
    posHelp();
    const inp = $('[data-cust-input]');
    const sug = $('[data-cust-suggest]');
    let hl = 0, matches = [];
    const show = () => {
      const v = inp.value.trim().toLowerCase();
      matches = customers.filter((x) => !v || x.name.toLowerCase().includes(v) || (x.phone || '').includes(v)).slice(0, 8);
      if (!matches.length || doc.customerId) { sug.hidden = true; return; }
      sug.innerHTML = matches.map((x, i) => `<button type="button" class="${i === hl ? 'hl' : ''}" data-i="${i}"><span><b>${esc(x.name)}</b><div class="tiny muted">${esc([x.phone, x.taxId].filter(Boolean).join(' · '))}</div></span></button>`).join('');
      sug.hidden = false;
    };
    const pick = (cu2) => { applyCustomer(cu2); saveCustomer = false; sug.hidden = true; drawCustomer(); changed(); };
    inp.addEventListener('focus', () => { hl = 0; show(); });
    inp.addEventListener('input', () => { hl = 0; show(); });
    inp.addEventListener('blur', () => setTimeout(() => (sug.hidden = true), 150));
    inp.addEventListener('keydown', (e) => {
      if (sug.hidden) return;
      if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, matches.length - 1); show(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); show(); e.preventDefault(); }
      if (e.key === 'Enter') { e.preventDefault(); pick(matches[hl]); }
    });
    sug.addEventListener('mousedown', (e) => { const x = e.target.closest('[data-i]'); if (x) pick(matches[Number(x.dataset.i)]); });
    $('[data-clear-cust]')?.addEventListener('click', () => { doc.customerId = ''; doc.customer = { name: '', address: '', taxId: '', phone: '', email: '', region: '' }; saveCustomer = true; drawCustomer(); changed(); });
    $('[data-save-cust]')?.addEventListener('change', (e) => (saveCustomer = e.target.checked));
    const tx = root.querySelector('[data-k="customer.taxId"]');
    tx.addEventListener('input', () => {
      const v = validateTaxId(c.code, tx.value);
      const h = $('[data-cust-taxhelp]');
      h.className = 'help ' + (v.ok ? '' : 'warn');
      h.textContent = v.ok ? (v.state ? 'Valid GSTIN ✓' : '') : v.msg;
      if (v.ok && v.state && c.gst) { doc.placeOfSupply = v.state; doc.customer.region = v.state; const s = root.querySelector('[data-k=placeOfSupply]'); if (s) s.value = v.state; posHelp(); }
    });
  }

  function posHelp() {
    const h = $('[data-pos-help]');
    if (!h) return;
    if (!registered) { h.textContent = 'Not charging GST (composition / unregistered).'; return; }
    h.textContent = doc.placeOfSupply === b.region ? 'Same state — CGST + SGST will apply.' : doc.placeOfSupply === '96' ? 'Export — IGST (or 0% under LUT).' : 'Different state — IGST will apply.';
  }

  function drawDetails() {
    const ty = t();
    $('[data-sec=details]').innerHTML = `<div class="card-head"><h3>Details</h3></div>
      <div class="form-grid c3">
        <div class="field"><label>${esc(ty.label)} number</label><input class="input mono" data-k="number" value="${esc(doc.number)}" ${c.maxNumberLength ? `maxlength="${c.maxNumberLength}"` : ''}></div>
        <div class="field"><label>Date</label><input class="input" type="date" data-k="date" value="${esc(doc.date)}"></div>
        ${ty.payable && !ty.paidNow ? `<div class="field"><label>Due date</label><input class="input" type="date" data-k="dueDate" value="${esc(doc.dueDate)}"><div class="chips mt-s">${[0, 7, 15, 30, 45].map((d) => `<button type="button" class="chip" style="height:24px;padding:0 9px;font-size:11px" data-due="${d}">${d ? d + 'd' : 'On receipt'}</button>`).join('')}</div></div>` : ''}
        ${ty.validity ? `<div class="field"><label>Valid until</label><input class="input" type="date" data-k="validUntil" value="${esc(doc.validUntil)}"></div>` : ''}
        <div class="field"><label>Reference / PO no.</label><input class="input" data-k="reference" value="${esc(doc.reference)}" placeholder="Optional"></div>
        ${ty.refInvoice ? `<div class="field"><label>Against invoice</label><select class="input" data-refdoc><option value="">— None —</option>${docs.filter((d) => d.type === 'invoice' && d.status === 'final').sort((a, x) => x.date.localeCompare(a.date)).map((d) => `<option value="${d.id}" ${d.id === doc.refDocId ? 'selected' : ''}>${esc(d.number)} · ${esc(d.customer?.name || '')}</option>`).join('')}</select></div>
          <div class="field" data-refnum-field ${doc.refDocId ? 'hidden' : ''}><label>…or original invoice no. *</label><input class="input mono" data-k="refNumber" value="${esc(doc.refDocId ? '' : doc.refNumber || '')}" placeholder="If not in Bill Studio"></div>
          <div class="field" data-refdate-field ${doc.refDocId ? 'hidden' : ''}><label>Original invoice date *</label><input class="input" type="date" data-k="refDate" value="${esc(doc.refDocId ? '' : doc.refDate || '')}"></div>` : ''}
        ${c.code === 'IN' && b.taxScheme !== 'unregistered' ? `<div class="field"><label>Copy label</label><select class="input" data-k="copyLabel">${(doc.type === 'challan' ? CHALLAN_LABELS : COPY_LABELS).map((x) => `<option value="${x}" ${x === (doc.copyLabel || '') ? 'selected' : ''}>${x || 'None'}</option>`).join('')}</select></div>` : ''}
        ${ty.ledger || doc.type === 'proforma' ? `<div class="field"><label>Date of supply</label><input class="input" type="date" data-k="supplyDate" value="${esc(doc.supplyDate || '')}"><div class="help">Only if different from the bill date.</div></div>` : ''}
        ${c.gst && b.taxScheme === 'regular' && ty.ledger ? `<div class="field"><label>Type of supply</label><select class="input" data-k="supplyType">${SUPPLY_TYPES.map(([v, l]) => `<option value="${v}" ${v === (doc.supplyType || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      </div>
      ${c.gst && b.taxScheme === 'regular' && TAX_DOCS.includes(doc.type) ? `<details class="mt" ${doc.irn ? 'open' : ''}><summary class="small muted" style="cursor:pointer">E-invoice (IRN) — needed if your turnover is above ₹5 crore</summary>
        <div class="form-grid c3 mt-s"><div class="field" style="grid-column:span 2"><label>IRN</label><input class="input mono" data-k="irn" value="${esc(doc.irn || '')}" placeholder="64-character IRN from the IRP"></div>
        <div class="field"><label>Ack. no.</label><input class="input mono" data-k="ackNo" value="${esc(doc.ackNo || '')}"></div>
        <div class="field"><label>Ack. date</label><input class="input" type="date" data-k="ackDate" value="${esc(doc.ackDate || '')}"></div></div></details>` : ''}`;
    root.querySelectorAll('[data-due]').forEach((x) => x.addEventListener('click', () => {
      doc.dueDate = addDays(doc.date, Number(x.dataset.due)); root.querySelector('[data-k=dueDate]').value = doc.dueDate; changed();
    }));
    $('[data-refdoc]')?.addEventListener('change', async (e) => {
      const src = docs.find((d) => d.id === e.target.value);
      doc.refDocId = src?.id || ''; doc.refNumber = src?.number || ''; doc.refDate = src?.date || '';
      for (const sel of ['[data-refnum-field]', '[data-refdate-field]']) { const rf = root.querySelector(sel); if (rf) { rf.hidden = !!src; rf.querySelector('input').value = ''; } }
      if (src && (await confirmDialog('Copy items?', `Copy the customer and items from ${src.number}? You can then adjust quantities for the return.`, { ok: 'Copy' }))) {
        for (const k of ['customerId', 'customer', 'placeOfSupply', 'items', 'inclusive']) doc[k] = JSON.parse(JSON.stringify(src[k]));
        doc.items.forEach((i) => (i.id = uid('li_')));
        drawCustomer(); drawItems();
      }
      changed();
    });
  }

  function drawItems() {
    $('[data-sec=items]').innerHTML = `<div class="card-head"><h3>Items</h3>
        <label class="flex small" style="cursor:pointer;gap:8px">Prices include tax <span class="switch" style="transform:scale(.8);margin:-4px -4px"><input type="checkbox" data-incl ${doc.inclusive ? 'checked' : ''}><span></span></span></label></div>
      <div data-items>${doc.items.map(itemHtml).join('')}</div>
      <div class="flex mt wrap"><button class="btn" data-add>${icon('plus', 16)} Add item</button>
        ${products.length ? `<span class="small muted">Tip: type to search your ${products.length} saved items</span>` : `<a class="small" href="#/items">Save items for one-tap billing →</a>`}</div>`;
    $('[data-add]').addEventListener('click', () => { doc.items.push(blankItem(b)); drawItems(); changed(); setTimeout(() => root.querySelector(`[data-items] .item-card:last-child [data-name]`)?.focus(), 30); });
    $('[data-incl]').addEventListener('change', (e) => { doc.inclusive = e.target.checked; changed(); });
    root.querySelectorAll('[data-remove]').forEach((x) => x.addEventListener('click', () => {
      doc.items = doc.items.filter((i) => i.id !== x.dataset.remove);
      if (!doc.items.length) doc.items.push(blankItem(b));
      drawItems(); changed();
    }));
    root.querySelectorAll('[data-disc-type]').forEach((x) => x.addEventListener('click', () => {
      const it = doc.items.find((i) => i.id === x.dataset.discType);
      it.discType = it.discType === 'amt' ? 'pct' : 'amt';
      x.textContent = it.discType === 'amt' ? sym : '%';
      changed();
    }));
    root.querySelectorAll('[data-name]').forEach(bindProductSearch);
    updateLineTotals();
  }

  function itemHtml(it, i) {
    const k = (f) => `data-k="items.${i}.${f}"`;
    return `<div class="item-card" data-row="${it.id}">
      <button class="remove" type="button" data-remove="${it.id}" aria-label="Remove item">${icon('x', 14)}</button>
      <div style="position:relative"><input class="input" ${k('name')} data-name="${i}" value="${esc(it.name)}" placeholder="Item or service — type to search" autocomplete="off" aria-label="Item name" style="font-weight:500"><div class="suggest" hidden style="left:0;right:0;top:100%"></div></div>
      <div class="item-grid">
        <div class="field"><label>Qty</label><input class="input" ${k('qty')} type="number" step="any" min="0" value="${esc(it.qty)}" aria-label="Quantity"></div>
        <div class="field"><label>Unit</label><select class="input" ${k('unit')} aria-label="Unit">${[...new Set([it.unit, ...UNITS])].filter(Boolean).map((u) => `<option ${u === it.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
        <div class="field"><label>Rate (${esc(sym)})</label><input class="input" ${k('rate')} type="number" step="any" min="0" value="${esc(it.rate)}" aria-label="Rate"></div>
        <div class="field"><label>Discount</label><div style="display:flex;gap:4px"><input class="input" ${k('disc')} type="number" step="any" min="0" value="${esc(it.disc || '')}" placeholder="0" aria-label="Discount"><button type="button" class="btn sm" style="height:36px;border-radius:10px;min-width:36px;padding:0 8px" data-disc-type="${it.id}" title="Switch % / amount">${it.discType === 'amt' ? esc(sym) : '%'}</button></div></div>
      </div>
      <div class="item-grid2">
        <input class="input" ${k('description')} value="${esc(it.description)}" placeholder="Description (optional)" aria-label="Description">
        ${c.showHsn ? `<input class="input" ${k('hsn')} value="${esc(it.hsn)}" placeholder="${esc(c.hsnLabel)}" aria-label="${esc(c.hsnLabel)}">` : ''}
        ${registered ? `<select class="input" ${k('taxId')} aria-label="Tax">${taxOptions(it.taxId)}</select>` : `<input class="input" readonly value="No tax" aria-label="Tax">`}
      </div>
      ${c.gst && registered ? `<details style="margin-top:6px"><summary class="tiny muted" style="cursor:pointer">Cess</summary><input class="input mt-s" style="height:32px;max-width:160px" ${k('cess')} type="number" step="any" value="${esc(it.cess || '')}" placeholder="Cess %"></details>` : ''}
      <div class="item-total"><span data-line-tax="${it.id}"></span><b data-line-total="${it.id}"></b></div>
    </div>`;
  }

  function bindProductSearch(inp) {
    const sug = inp.parentElement.querySelector('.suggest');
    const i = Number(inp.dataset.name);
    let matches = [], hl = 0;
    const show = () => {
      const v = inp.value.trim().toLowerCase();
      matches = v ? products.filter((p) => p.name.toLowerCase().includes(v) || (p.sku || '').toLowerCase() === v || (p.hsn || '') === v).slice(0, 8) : [];
      if (!matches.length) { sug.hidden = true; return; }
      sug.innerHTML = matches.map((p, j) => `<button type="button" class="${j === hl ? 'hl' : ''}" data-j="${j}"><span>${esc(p.name)}${p.trackStock ? `<div class="tiny muted">${Number(p.stock)} ${esc(p.unit)} in stock</div>` : ''}</span><span class="tnum muted">${m(p.price)}</span></button>`).join('');
      sug.hidden = false;
    };
    const pick = (p) => {
      Object.assign(doc.items[i], { productId: p.id, name: p.name, description: p.description || '', hsn: p.hsn || '', unit: p.unit || 'pcs', rate: Number(p.price) || 0, taxId: p.taxId || b.defaultTaxId, cess: p.cess || 0 });
      doc.items[i].inclusive = !!p.priceIncludesTax; // MRP items are tax-inclusive per line
      sug.hidden = true; drawItems(); changed();
      root.querySelector(`[data-k="items.${i}.qty"]`)?.select();
    };
    inp.addEventListener('input', () => { hl = 0; doc.items[i].productId = ''; show(); });
    inp.addEventListener('blur', () => setTimeout(() => (sug.hidden = true), 150));
    inp.addEventListener('keydown', (e) => {
      if (sug.hidden) return;
      if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, matches.length - 1); show(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); show(); e.preventDefault(); }
      if (e.key === 'Enter') { e.preventDefault(); pick(matches[hl]); }
    });
    sug.addEventListener('mousedown', (e) => { const x = e.target.closest('[data-j]'); if (x) pick(matches[Number(x.dataset.j)]); });
  }

  function drawExtras() {
    $('[data-sec=extras]').innerHTML = `<div class="card-head"><h3>Discounts, charges & notes</h3></div>
      <div class="form-grid">
        <div class="field"><label>Bill discount</label><div style="display:flex;gap:6px"><input class="input" type="number" step="any" min="0" data-k="discount" value="${esc(doc.discount || '')}" placeholder="0">
          <select class="input" data-k="discountType" style="width:90px"><option value="pct" ${doc.discountType !== 'amt' ? 'selected' : ''}>%</option><option value="amt" ${doc.discountType === 'amt' ? 'selected' : ''}>${esc(sym)}</option></select></div></div>
        <div class="field"><label>Ship to (if different)</label><textarea class="input" rows="1" data-k="shipTo" style="min-height:40px">${esc(doc.shipTo)}</textarea></div>
      </div>
      <div class="mt" data-charges>${(doc.charges || []).map((ch, i) => `
        <div class="flex mt-s" data-charge="${i}"><input class="input" data-k="charges.${i}.label" value="${esc(ch.label)}" placeholder="e.g. Shipping" style="flex:2">
        <input class="input" type="number" step="any" data-k="charges.${i}.amount" value="${esc(ch.amount)}" placeholder="Amount" style="flex:1">
        ${registered ? `<select class="input" data-k="charges.${i}.taxId" style="flex:1.4">${taxOptions(ch.taxId)}</select>` : ''}
        <button class="btn icon sm danger" type="button" data-del-charge="${i}" aria-label="Remove charge">${icon('trash-2', 15)}</button></div>`).join('')}
        <button class="btn sm mt-s" type="button" data-add-charge>${icon('plus', 14)} Add charge (shipping, packing…)</button></div>
      <div class="group mt" style="box-shadow:none;border:1px solid var(--sep)">
        <label class="row" style="cursor:pointer"><span class="grow">Round off total</span><span class="switch"><input type="checkbox" data-flag="roundOff" ${doc.roundOff ? 'checked' : ''}><span></span></span></label>
        ${registered && RC_COUNTRY ? `<label class="row" style="cursor:pointer"><span class="grow">Reverse charge<div class="sub">${c.gst ? 'Tax payable by the recipient' : 'Customer accounts for tax (B2B cross-border)'}</div></span><span class="switch"><input type="checkbox" data-flag="reverseCharge" ${doc.reverseCharge ? 'checked' : ''}><span></span></span></label>` : ''}
        ${registered ? `        <label class="row" style="cursor:pointer"><span class="grow">Tax exempt sale<div class="sub">e.g. resale certificate, exempt customer</div></span><span class="switch"><input type="checkbox" data-flag="taxExempt" ${doc.taxExempt ? 'checked' : ''}><span></span></span></label>
        ${doc.taxExempt ? `<div class="row"><input class="input" data-k="exemptReason" value="${esc(doc.exemptReason || '')}" placeholder="Legal reason, e.g. “Exempt intra-Community supply, Art. 138 Directive 2006/112/EC” or certificate no."></div>` : ''}` : ''}
      </div>
      <div class="form-grid mt">
        <div class="field span2"><label>Notes (shown on the bill)</label><textarea class="input" rows="2" data-k="notes" placeholder="Thank you for your business!">${esc(doc.notes)}</textarea></div>
        <div class="field span2"><label>Terms & conditions</label><textarea class="input" rows="3" data-k="terms">${esc(doc.terms)}</textarea></div>
      </div>`;
    $('[data-add-charge]').addEventListener('click', () => { doc.charges = doc.charges || []; doc.charges.push({ label: 'Shipping', amount: 0, taxId: b.defaultTaxId }); drawExtras(); changed(); });
    root.querySelectorAll('[data-del-charge]').forEach((x) => x.addEventListener('click', () => { doc.charges.splice(Number(x.dataset.delCharge), 1); drawExtras(); changed(); }));
    root.querySelectorAll('[data-flag]').forEach((x) => x.addEventListener('change', () => { doc[x.dataset.flag] = x.checked; if (x.dataset.flag === 'taxExempt') drawExtras(); changed(); }));
  }

  function drawPayment() {
    const sec = $('[data-sec=payment]');
    if (!t().payable || !isNew) { sec.hidden = true; return; }
    sec.hidden = false;
    sec.innerHTML = `<div class="card-head"><h3>Payment</h3><span class="switch"><input type="checkbox" data-paid-on ${paidNow.on ? 'checked' : ''} aria-label="Payment received"><span></span></span></div>
      <p class="small muted" style="margin:-6px 0 10px">${paidNow.on ? 'Record the money you received with this bill.' : 'Turn on if the customer paid now (fully or partly).'}</p>
      ${paidNow.on ? `<div class="form-grid"><div class="field"><label>Amount received</label><input class="input" type="number" step="any" data-paid-amt value="${paidNow.auto ? '' : esc(paidNow.amount)}" placeholder="Full amount"></div>
        <div class="field"><label>Mode</label><select class="input" data-paid-mode>${['cash', 'upi', 'card', 'bank transfer', 'cheque', 'wallet', 'other'].map((x) => `<option ${x === paidNow.mode ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>` : ''}`;
    $('[data-paid-on]').addEventListener('change', (e) => { paidNow.on = e.target.checked; drawPayment(); });
    $('[data-paid-amt]')?.addEventListener('input', (e) => { paidNow.auto = e.target.value === ''; paidNow.amount = num(e.target.value); });
    $('[data-paid-mode]')?.addEventListener('change', (e) => (paidNow.mode = e.target.value));
  }

  // ---------- Binding ----------
  const ac = new AbortController();
  root.addEventListener('input', (e) => {
    const k = e.target.dataset?.k;
    if (!k) return;
    setPath(doc, k, e.target);
    if (k === 'date' && isNew) renumber();
    if (k === 'placeOfSupply') posHelp();
    changed();
  }, { signal: ac.signal });
  root.addEventListener('change', (e) => {
    const k = e.target.dataset?.k;
    if (!k || e.target.tagName !== 'SELECT') return;
    setPath(doc, k, e.target);
    if (k === 'supplyType' && /^export/.test(doc.supplyType)) { doc.placeOfSupply = '96'; const ps = root.querySelector('[data-k=placeOfSupply]'); if (ps) ps.value = '96'; }
    if (k === 'supplyType' || k === 'placeOfSupply') posHelp();
    changed();
  }, { signal: ac.signal });

  function setPath(obj, path, el) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[isNaN(parts[i]) ? parts[i] : Number(parts[i])];
    const key = parts.at(-1);
    let v = el.value;
    if (el.type === 'number' || ['qty', 'rate', 'disc', 'cess', 'amount', 'discount'].includes(key)) v = num(v);
    o[key] = v;
  }

  async function renumber() {
    if (!isNew) return;
    const n = await nextNumber(b, doc.type, doc.date);
    const fyChanged = n.fy !== lastFy; lastFy = n.fy;
    if (fyChanged || !doc.numberEdited) { doc.number = n.number; const el = root.querySelector('[data-k=number]'); if (el) el.value = n.number; root.querySelector('[data-num-sub]').textContent = n.number; }
  }
  root.querySelector('[data-sec=details]').addEventListener('input', (e) => { if (e.target.dataset.k === 'number') doc.numberEdited = true; });
  let lastFy = fyLabel(doc.date, b.fyStartMonth);

  function updateLineTotals() {
    const calc = calculate(doc, b);
    const byId = new Map(calc.lines.map((l) => [l.id, l]));
    doc.items.forEach((it) => {
      const l = byId.get(it.id);
      const tEl = root.querySelector(`[data-line-total="${it.id}"]`);
      const xEl = root.querySelector(`[data-line-tax="${it.id}"]`);
      if (tEl) tEl.textContent = l ? m(l.total) : m(0);
      if (xEl) xEl.textContent = l && l.tax ? `${l.taxes.map((x) => `${x.name} ${x.rate}%`).join(' + ')} = ${m(l.tax)}` : l && l.taxable ? 'No tax' : '';
    });
    return calc;
  }

  const drawPreview = debounce(() => {
    const host = $('[data-paper]');
    const stage = host.parentElement;
    const w = stage.clientWidth - 36;
    mountPage(host, buildContext(doc, b), tpl, { width: Math.max(260, w) });
  }, 120);

  function drawTotals(calc) {
    $('[data-totals]').innerHTML = `<div class="totals-box">
      <div class="line"><span>Subtotal</span><b>${m(calc.subtotal)}</b></div>
      ${calc.extraDiscount ? `<div class="line"><span>Discount</span><b>− ${m(calc.extraDiscount)}</b></div>` : ''}
      ${calc.charges.map((x) => `<div class="line"><span>${esc(x.label || 'Charge')}</span><b>${m(x.taxable)}</b></div>`).join('')}
      ${calc.taxSummary.map((x) => `<div class="line"><span>${esc(x.name)} ${x.rate}%</span><b>${m(x.amount)}</b></div>`).join('')}
      ${calc.roundOff ? `<div class="line"><span>Round off</span><b>${m(calc.roundOff)}</b></div>` : ''}
      <div class="line grand"><span>Total</span><b>${m(calc.total)}</b></div></div>`;
  }

  function changed() {
    dirty = true;
    const calc = updateLineTotals();
    drawTotals(calc);
    drawPreview();
  }

  // Type switch (new docs only)
  $('[data-type]')?.addEventListener('change', async (e) => {
    const nt = e.target.value;
    const keep = { customer: doc.customer, customerId: doc.customerId, items: doc.items, charges: doc.charges, placeOfSupply: doc.placeOfSupply, notes: doc.notes, inclusive: doc.inclusive, discount: doc.discount, discountType: doc.discountType };
    doc = Object.assign(blankDoc(b, nt), keep);
    doc.number = (await nextNumber(b, nt, doc.date)).number;
    if (c.code === 'IN' && b.taxScheme !== 'unregistered') doc.copyLabel = nt === 'challan' ? 'Original for Consignee' : ['invoice', 'receipt'].includes(nt) ? 'Original for Recipient' : '';
    paidNow = { on: !!DOC_TYPES[nt].paidNow, amount: 0, mode: 'cash', auto: true };
    tpl = await templateFor(doc);
    $('[data-tpl]').value = tpl.id;
    $('[data-h1]').textContent = `New ${docTitle(nt, b)}`;
    $('[data-num-sub]').textContent = doc.number;
    setTitle(`New ${DOC_TYPES[nt].label.toLowerCase()}`);
    history.replaceState(null, '', `#/bills/new/${nt}`);
    drawAll();
  });
  $('[data-tpl]').addEventListener('change', async (e) => { tpl = await templateFor({ ...doc, templateId: e.target.value }); doc.templateId = e.target.value; drawPreview(); });

  const TAX_DOCS = ['invoice', 'receipt', 'credit', 'debit'];
  // Hard rules: the bill would be wrong or non-compliant. Returns an error message or ''.
  function validateDoc(status) {
    const ty = t();
    const final = status === 'final';
    if (final && TAX_DOCS.includes(doc.type)) {
      const err = businessTaxError(b);
      if (err) return `Complete your tax registration in Business profile first: ${err}`;
    }
    if (!doc.date) return 'Please enter the bill date.';
    if (doc.dueDate && doc.dueDate < doc.date) return 'The due date can’t be before the bill date.';
    if (doc.validUntil && doc.validUntil < doc.date) return '“Valid until” can’t be before the quotation date.';
    if (c.gst && !/^[A-Za-z0-9/-]+$/.test(doc.number)) return 'GST bill numbers may only use letters, digits, “/” and “-” (no spaces or other symbols).';
    if (doc.number.length > 40) return 'Bill number is too long.';
    for (const [i, it] of doc.items.entries()) {
      const n = `Item ${i + 1}${it.name ? ` (${it.name})` : ''}`;
      if (!String(it.name || '').trim()) return `${n}: please enter a name.`;
      if (!(num(it.qty) > 0)) return `${n}: quantity must be more than 0.`;
      if (num(it.rate) < 0) return `${n}: rate can’t be negative.`;
      if (num(it.disc) < 0) return `${n}: discount can’t be negative.`;
      if (it.discType !== 'amt' && num(it.disc) > 100) return `${n}: discount can’t be more than 100%.`;
      if (it.discType === 'amt' && num(it.disc) > num(it.qty) * num(it.rate)) return `${n}: discount is larger than the line amount.`;
      if (num(it.cess) < 0) return `${n}: cess can’t be negative.`;
      if (c.gst && it.hsn && !/^\d{4}(\d{2})?(\d{2})?$/.test(String(it.hsn).trim())) return `${n}: HSN/SAC must be 4, 6 or 8 digits.`;
    }
    if (num(doc.discount) < 0) return 'Bill discount can’t be negative.';
    if (doc.discountType !== 'amt' && num(doc.discount) > 100) return 'Bill discount can’t be more than 100%.';
    for (const ch of doc.charges || []) if (num(ch.amount) < 0) return `${ch.label || 'Charge'} can’t be negative.`;
    const cu = doc.customer || {};
    if (!validateEmail(cu.email)) return 'The customer email address doesn’t look right.';
    if (!final) return '';
    const registered = b.taxScheme !== 'unregistered';
    if (c.gst) {
      if (cu.taxId && !validateGSTIN(cu.taxId).ok) return `Customer GSTIN: ${validateGSTIN(cu.taxId).msg}`;
      if (b.taxScheme === 'composition' && TAX_DOCS.includes(doc.type) && doc.placeOfSupply !== b.region) return 'A composition dealer can’t make inter-state supplies (GST Act s.10). Change the place of supply or your GST status.';
      if (registered && b.taxScheme === 'regular' && cu.taxId && TAX_DOCS.includes(doc.type)) {
        const bad = doc.items.find((it) => !/^\d{4,8}$/.test(String(it.hsn || '').trim()));
        if (bad) return `“${bad.name}”: HSN/SAC code is required on B2B tax invoices (at least 4 digits).`;
      }
    }
    const total = calculate(doc, b).total;
    if (c.gst && b.taxScheme === 'regular' && !cu.taxId && ['invoice', 'receipt'].includes(doc.type) && total >= 50000 && !String(cu.address || '').trim())
      return 'For sales of ₹50,000 or more to an unregistered buyer, GST rules require the buyer’s name, address and state — please add the address.';
    if (doc.taxExempt && !String(doc.exemptReason || '').trim() && b.taxScheme !== 'unregistered') return 'Give the legal reason for the tax exemption (it must be printed on the bill).';
    if ((c.eu || c.code === 'GB') && b.taxScheme !== 'unregistered' && doc.type === 'invoice' && total > (c.code === 'GB' ? 250 : 100) && !String(cu.address || '').trim())
      return 'A full VAT invoice must show the customer’s address. Please add it.';
    if (ty.refInvoice && !doc.refDocId && String(doc.refNumber || '').trim() && !doc.refDate) return 'Please enter the date of the original invoice.';
    if (doc.irn && !/^[0-9a-f]{64}$/i.test(doc.irn.trim())) return 'The IRN should be the 64-character code from the e-invoice portal.';
    if (ty.refInvoice && !doc.refDocId && !String(doc.refNumber || '').trim()) return `A ${ty.label.toLowerCase()} must refer to the original invoice — choose it or type its number.`;
    if (doc.reverseCharge && !cu.taxId) return `Reverse charge applies only to business customers — enter the customer’s ${c.taxIdLabel}.`;
    return '';
  }
  // Soft checks: probably a mistake, but the user may continue.
  function warnDoc() {
    const cu = doc.customer || {};
    const calc = calculate(doc, b);
    if (c.gst && cu.taxId && validateGSTIN(cu.taxId).ok && cu.taxId.slice(0, 2) !== doc.placeOfSupply && doc.placeOfSupply !== '96')
      return `The customer’s GSTIN is registered in state ${cu.taxId.slice(0, 2)}, but the place of supply is ${doc.placeOfSupply}. That is fine when goods are delivered to another state — otherwise correct the place of supply.`;
    const ownPrefix = /^[A-Z]{2}/.test(String(cu.taxId || '').toUpperCase()) ? String(cu.taxId).toUpperCase().slice(0, 2) === (c.code === 'GR' ? 'EL' : c.code) : true;
    if (!c.gst && cu.taxId && ownPrefix && (c.eu || c.code === 'GB') && !validateTaxId(c.code, cu.taxId).ok) return `The customer’s ${c.taxIdLabel} looks wrong: ${validateTaxId(c.code, cu.taxId).msg}`;
    if (calc.total === 0 && TAX_DOCS.includes(doc.type)) return 'This bill’s total is 0. Save it anyway?';
    if (c.code === 'AU' && b.taxScheme !== 'unregistered' && calc.total >= 1000 && !cu.taxId && !cu.address) return 'Australian tax invoices of A$1,000 or more must show the buyer’s identity or ABN. Add the customer’s ABN or address.';
    return '';
  }

  let saving = false;
  async function save(status) {
    if (saving) return;
    saving = true;
    root.querySelectorAll('[data-save],[data-draft]').forEach((x) => (x.disabled = true));
    try { await doSave(status); } finally { saving = false; if (root.isConnected) root.querySelectorAll('[data-save],[data-draft]').forEach((x) => (x.disabled = false)); }
  }
  async function doSave(status) {
    const ty = t();
    const before = doc.items.length;
    doc.items = doc.items.filter((i) => i.name || num(i.rate));
    if (doc.items.length && doc.items.length !== before) drawItems(); // keep field indexes in sync
    if (!doc.items.length) { toast('Add at least one item', 'err'); doc.items.push(blankItem(b)); drawItems(); return; }
    if (!doc.customer?.name && doc.type !== 'receipt' && status === 'final') { toast(`Please enter the ${doc.type === 'purchase' ? 'vendor' : 'customer'} name`, 'err'); root.querySelector('[data-cust-input]').focus(); return; }
    if (!doc.customer.name && doc.type === 'receipt') doc.customer.name = 'Walk-in customer';
    doc.number = String(doc.number || '').trim();
    if (!doc.number) { toast('Bill number is required', 'err'); return; }
    const clash = docs.find((d) => d.id !== doc.id && d.type === doc.type && d.number === doc.number);
    if (clash) { toast(`${doc.number} already exists — use a different number`, 'err'); return; }
    if (c.maxNumberLength && doc.number.length > c.maxNumberLength) { toast(`Bill number must be ${c.maxNumberLength} characters or fewer`, 'err'); return; }
    const problem = validateDoc(status);
    if (problem) { toast(problem, 'err'); return; }
    const warning = status === 'final' && warnDoc();
    if (warning && !(await confirmDialog('Please check', warning, { ok: 'Save anyway' }))) return;
    doc.status = status;
    doc.fy = fyLabel(doc.date, b.fyStartMonth);
    const m2 = String(doc.number).match(/(\d+)$/);
    if (isNew && m2) doc.seq = Number(m2[1]);
    if (saveCustomer && doc.customer.name && !doc.customerId && doc.customer.name !== 'Walk-in customer') {
      const cu = await db.put('customers', { businessId: b.id, ...doc.customer, openingBalance: 0, shipTo: doc.shipTo || '' });
      doc.customerId = cu.id;
    }
    let pay = null;
    if (isNew && ty.payable && paidNow.on && status === 'final') {
      const total = calculate(doc, b).total;
      pay = { amount: paidNow.auto ? total : Math.min(paidNow.amount, total), mode: paidNow.mode };
    }
    const saved = await saveDocument(doc, { paidNow: pay });
    if (doc.convertedFrom) {
      const q2 = await db.get('documents', doc.convertedFrom);
      if (q2) { q2.convertedTo = saved.id; await db.put('documents', q2); }
    }
    dirty = false;
    toast(status === 'draft' ? 'Draft saved' : `${docTitle(saved.type, b, saved)} ${saved.number} saved`);
    location.hash = `#/bills/${saved.id}`;
  }
  $('[data-save]').addEventListener('click', () => save('final'));
  $('[data-draft]').addEventListener('click', () => save('draft'));
  $('[data-cancel]').addEventListener('click', async () => {
    if (dirty && !(await confirmDialog('Discard changes?', 'Your unsaved changes to this bill will be lost.', { ok: 'Discard', danger: true }))) return;
    dirty = false;
    location.hash = doc.id ? `#/bills/${doc.id}` : '#/bills';
  });

  const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save('final'); } };
  document.addEventListener('keydown', onKey);
  const onResize = debounce(() => drawPreview(), 150);
  window.addEventListener('resize', onResize);
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  function drawAll() { drawCustomer(); drawDetails(); drawItems(); drawExtras(); drawPayment(); changed(); dirty = false; }
  drawAll();

  return () => {
    ac.abort();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', beforeUnload);
  };
}
