import { icon } from '../lib/icons.js';
import { esc, modal, toast, emptyState, confirmDialog, pickFile, parseCSV, toCSV, downloadText } from '../ui.js';
import { db } from '../db.js';
import { state, list } from '../store.js';
import { getCountry, UNITS } from '../tax/countries.js';
import { fmtMoney, num } from '../lib/money.js';

function productDialog(p = null) {
  const b = state.business;
  const c = getCountry(b.country);
  const x = p || { name: '', sku: '', hsn: '', unit: 'pcs', price: '', taxId: b.defaultTaxId, cess: 0, priceIncludesTax: false, kind: 'goods', trackStock: false, stock: 0, lowStock: 5, description: '', cost: '' };
  const m = modal({
    title: p ? 'Edit item' : 'New item',
    body: `<div class="form-grid">
      <div class="field span2"><label>Name *</label><input class="input" name="name" value="${esc(x.name)}"></div>
      <div class="field span2"><label>Description</label><input class="input" name="description" value="${esc(x.description)}" placeholder="Shown under the item name on bills"></div>
      <div class="field"><label>Type</label><select class="input" name="kind"><option value="goods" ${x.kind !== 'service' ? 'selected' : ''}>Product (goods)</option><option value="service" ${x.kind === 'service' ? 'selected' : ''}>Service</option></select></div>
      <div class="field"><label>Unit</label><select class="input" name="unit">${UNITS.map((u) => `<option ${u === x.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      <div class="field"><label>Selling price (${esc(b.currency)})</label><input class="input" type="number" step="any" name="price" value="${esc(x.price)}"></div>
      <div class="field"><label>Purchase cost</label><input class="input" type="number" step="any" name="cost" value="${esc(x.cost)}" placeholder="For profit reports"></div>
      <div class="field"><label>Tax</label><select class="input" name="taxId">${b.taxes.map((t) => `<option value="${esc(t.id)}" ${t.id === x.taxId ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
      ${c.showHsn ? `<div class="field"><label>${esc(c.hsnLabel)} code</label><input class="input" name="hsn" value="${esc(x.hsn)}" inputmode="numeric"></div>` : `<div class="field"><label>SKU / code</label><input class="input" name="sku" value="${esc(x.sku)}"></div>`}
      ${c.showHsn ? `<div class="field"><label>SKU / barcode</label><input class="input" name="sku" value="${esc(x.sku)}"></div>` : ''}
      ${c.gst ? `<div class="field"><label>Cess %</label><input class="input" type="number" step="any" name="cess" value="${esc(x.cess || '')}"></div>` : ''}
      <label class="field span2" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="priceIncludesTax" ${x.priceIncludesTax ? 'checked' : ''}><span class="small">Price already includes tax (MRP)</span></label>
    </div>
    <div class="group mt" style="box-shadow:none;border:1px solid var(--sep)">
      <label class="row" style="cursor:pointer"><span class="grow">Track stock</span><span class="switch"><input type="checkbox" name="trackStock" ${x.trackStock ? 'checked' : ''}><span></span></span></label>
      <div class="row"><span class="grow small">In stock</span><input class="input" type="number" step="any" name="stock" value="${esc(x.stock)}" style="width:120px"></div>
      <div class="row"><span class="grow small">Alert me below</span><input class="input" type="number" step="any" name="lowStock" value="${esc(x.lowStock)}" style="width:120px"></div>
    </div>`,
    foot: `${p ? `<button class="btn danger" data-del style="margin-right:auto">Delete</button>` : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const g = (n) => m.el.querySelector(`[name=${n}]`);
    const rec = { ...x, businessId: b.id };
    for (const k of ['name', 'description', 'kind', 'unit', 'taxId', 'sku']) if (g(k)) rec[k] = g(k).value.trim();
    if (g('hsn')) rec.hsn = g('hsn').value.trim();
    for (const k of ['price', 'cost', 'cess', 'stock', 'lowStock']) if (g(k)) rec[k] = num(g(k).value);
    rec.priceIncludesTax = g('priceIncludesTax').checked;
    rec.trackStock = g('trackStock').checked;
    if (!rec.name) { toast('Name is required', 'err'); return; }
    await db.put('products', rec);
    toast('Item saved');
    m.close(rec);
  });
  m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete item?', `${x.name} will be removed from your catalogue. Existing bills are not affected.`, { ok: 'Delete', danger: true }))) return;
    await db.del('products', x.id); toast('Item deleted'); m.close('deleted');
  });
  return m.done;
}

export async function render(root) {
  const b = state.business;
  const c = getCountry(b.country);
  const products = (await list('products')).sort((a, x) => a.name.localeCompare(x.name));
  const docs = await list('documents');
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const sold = new Map();
  for (const d of docs) if (d.status === 'final' && ['invoice', 'receipt'].includes(d.type)) for (const it of d.items || []) if (it.productId) sold.set(it.productId, (sold.get(it.productId) || 0) + num(it.qty));
  let q = '';
  const taxLabel = (id) => b.taxes.find((t) => t.id === id)?.label || '—';
  const stockValue = products.filter((p) => p.trackStock).reduce((s, p) => s + Math.max(0, num(p.stock)) * num(p.cost || p.price), 0);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Items</h1><p>${products.length} products & services${stockValue ? ` · stock worth ${m(stockValue)}` : ''}</p></div>
      <div class="actions"><button class="btn" data-import>${icon('upload', 16)} Import CSV</button><button class="btn" data-export>${icon('download', 16)} Export</button><button class="btn primary" data-new>${icon('plus', 16)} New item</button></div></div>
    <div class="toolbar"><div class="searchbar">${icon('search', 16)}<input class="input" data-q placeholder="Search name, ${c.showHsn ? 'HSN, ' : ''}SKU" aria-label="Search items"></div></div>
    <div data-list></div></div>`;

  const draw = () => {
    const host = root.querySelector('[data-list]');
    if (!products.length) { host.innerHTML = emptyState('package', 'No items yet', 'Save the products and services you sell — then add them to any bill with a tap.', `<button class="btn primary" data-new2>${icon('plus', 16)} Add item</button>`); host.querySelector('[data-new2]').onclick = add; return; }
    const f = products.filter((p) => !q || [p.name, p.sku, p.hsn].join(' ').toLowerCase().includes(q));
    host.innerHTML = `<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>Item</th>${c.showHsn ? `<th class="desktop-only">${esc(c.hsnLabel)}</th>` : ''}<th class="desktop-only">Tax</th><th class="num">Price</th><th class="num">Stock</th><th class="num desktop-only">Sold</th></tr></thead>
      <tbody>${f.map((p) => { const low = p.trackStock && num(p.stock) <= num(p.lowStock); return `<tr class="click" data-id="${p.id}">
        <td><div style="font-weight:500">${esc(p.name)}</div><div class="tiny muted">${esc(p.kind === 'service' ? 'Service' : 'Product')} · ${esc(p.unit)}${p.sku ? ' · ' + esc(p.sku) : ''}</div></td>
        ${c.showHsn ? `<td class="desktop-only mono small">${esc(p.hsn || '—')}</td>` : ''}
        <td class="desktop-only small muted">${esc(taxLabel(p.taxId))}</td>
        <td class="num" style="font-weight:600">${m(p.price)}</td>
        <td class="num">${p.trackStock ? `<span class="badge ${num(p.stock) <= 0 ? 'overdue' : low ? 'unpaid' : 'paid'}">${num(p.stock)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num desktop-only muted">${sold.get(p.id) || 0}</td></tr>`; }).join('')}</tbody></table></div></div>`;
    host.querySelectorAll('[data-id]').forEach((tr) => tr.addEventListener('click', async () => { if (await productDialog(products.find((p) => p.id === tr.dataset.id))) render(root); }));
  };
  const add = async () => { if (await productDialog()) render(root); };
  draw();
  root.querySelector('[data-q]').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
  root.querySelector('[data-new]').addEventListener('click', add);
  root.querySelector('[data-export]').addEventListener('click', () => downloadText(toCSV([['name', 'sku', 'hsn', 'unit', 'price', 'cost', 'tax', 'stock', 'description'], ...products.map((p) => [p.name, p.sku, p.hsn, p.unit, p.price, p.cost, taxLabel(p.taxId), p.trackStock ? p.stock : '', p.description])]), 'items.csv', 'text/csv'));
  root.querySelector('[data-import]').addEventListener('click', async () => {
    const f = await pickFile('.csv,text/csv');
    if (!f) return;
    const data = parseCSV(await f.text());
    const head = data.shift()?.map((h) => h.trim().toLowerCase()) || [];
    const col = (r, ...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return (r[i] || '').trim(); } return ''; };
    let n = 0;
    for (const r of data) {
      const name = col(r, 'name', 'item', 'product');
      if (!name) continue;
      const taxTxt = col(r, 'tax', 'gst', 'vat', 'tax rate').replace('%', '');
      const tax = b.taxes.find((t) => t.label === taxTxt || String(t.rate ?? t.components?.[0]?.rate) === taxTxt.replace(/[^\d.]/g, ''));
      const stock = col(r, 'stock', 'qty', 'quantity');
      await db.put('products', { businessId: b.id, name, sku: col(r, 'sku', 'barcode', 'code'), hsn: col(r, 'hsn', 'hsn/sac', 'sac'), unit: col(r, 'unit') || 'pcs', price: num(col(r, 'price', 'rate', 'mrp')), cost: num(col(r, 'cost', 'purchase price')), taxId: tax?.id || b.defaultTaxId, trackStock: stock !== '', stock: num(stock), lowStock: 5, description: col(r, 'description'), kind: 'goods' });
      n++;
    }
    toast(`Imported ${n} items`);
    render(root);
  });
}
