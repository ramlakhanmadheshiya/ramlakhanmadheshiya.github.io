import { icon } from '../lib/icons.js';
import { esc, modal, toast, emptyState, confirmDialog, segmented, toCSV, downloadText } from '../ui.js';
import { db } from '../db.js';
import { state, list, DOC_TYPES, payStatus, docTotals } from '../store.js';
import { fmtMoney, num } from '../lib/money.js';
import { fmtDate, periodRange, todayISO } from '../lib/dates.js';
import { paymentDialog, payModes } from '../payui.js';
import { getCountry } from '../tax/countries.js';
import { validateTaxId } from '../lib/validators.js';

const CATS = ['Rent', 'Salaries', 'Purchases / stock', 'Utilities', 'Transport', 'Marketing', 'Repairs', 'Office supplies', 'Bank charges', 'Taxes & fees', 'Other'];
const ui = { tab: 'in', period: 'month' };

function expenseDialog(e = null) {
  const b = state.business;
  const c = getCountry(b.country);
  const x = e || { date: todayISO(), category: 'Purchases / stock', vendor: '', supplierTaxId: '', amount: '', tax: '', mode: 'cash', note: '', reference: '' };
  const m = modal({
    title: e ? 'Edit expense' : 'New expense',
    body: `<div class="form-grid">
      <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(x.date)}"></div>
      <div class="field"><label>Category</label><select class="input" name="category">${CATS.map((c) => `<option ${c === x.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Paid to</label><input class="input" name="vendor" value="${esc(x.vendor)}" placeholder="Vendor / supplier"></div>
      ${c.noTax ? '<input type="hidden" name="supplierTaxId" value="">' : `<div class="field"><label>Supplier’s ${esc(c.taxIdLabel)}</label><input class="input" name="supplierTaxId" value="${esc(x.supplierTaxId || '')}" autocapitalize="characters" placeholder="Needed to claim input ${esc(c.taxName)}"></div>`}
      <div class="field"><label>Total amount (${esc(b.currency)})</label><input class="input" type="number" step="any" name="amount" value="${esc(x.amount)}"></div>
      <div class="field"><label>Tax included (input tax)</label><input class="input" type="number" step="any" name="tax" value="${esc(x.tax)}" placeholder="0"></div>
      <div class="field"><label>Mode</label><select class="input" name="mode">${payModes(x.mode).map((p) => `<option ${p === x.mode ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>Supplier invoice no.</label><input class="input" name="reference" value="${esc(x.reference)}"></div>
      <div class="field span2"><label>Note</label><input class="input" name="note" value="${esc(x.note)}"></div></div>`,
    foot: `${e ? `<button class="btn danger" data-del style="margin-right:auto">Delete</button>` : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const g = (n) => m.el.querySelector(`[name=${n}]`).value;
    const rec = { ...x, businessId: b.id, date: g('date'), category: g('category'), vendor: g('vendor').trim(), supplierTaxId: g('supplierTaxId').trim().toUpperCase(), amount: num(g('amount')), tax: num(g('tax')), mode: g('mode'), reference: g('reference').trim(), note: g('note').trim() };
    if (!(rec.amount > 0)) { toast('Enter an amount', 'err'); return; }
    if (!rec.date) { toast('Enter the expense date', 'err'); return; }
    if (rec.tax < 0 || rec.tax > rec.amount) { toast('Tax included must be between 0 and the total amount', 'err'); return; }
    if (rec.supplierTaxId && c.gst && !validateTaxId(c.code, rec.supplierTaxId).ok) { toast(`Supplier GSTIN: ${validateTaxId(c.code, rec.supplierTaxId).msg}`, 'err'); return; }
    if (rec.tax > 0 && c.gst && (!rec.supplierTaxId || !rec.reference)) toast('Tip: add the supplier’s GSTIN and invoice number — you need them to claim input tax credit.', 'info');
    await db.put('expenses', rec); toast('Expense saved'); m.close(rec);
  });
  m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete expense?', 'This cannot be undone.', { ok: 'Delete', danger: true }))) return;
    await db.del('expenses', x.id); m.close('deleted');
  });
  return m.done;
}

export async function render(root, { query = {} } = {}) {
  const b = state.business;
  const [payments, expenses, customers, docs] = await Promise.all([list('payments'), list('expenses'), list('customers'), list('documents')]);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const cname = (id) => customers.find((c) => c.id === id)?.name || '—';
  const dnum = (id) => docs.find((d) => d.id === id)?.number || '';
  const openDocs = docs.filter((d) => DOC_TYPES[d.type].payable && d.status === 'final').map((d) => ({ doc: d, due: payStatus(d, payments, docTotals(d, b)).due || 0 })).filter((x) => x.due > 0);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Payments</h1><p>Money in from customers and money out on expenses.</p></div>
      <div class="actions"><button class="btn" data-export>${icon('download', 16)} Export</button><button class="btn" data-exp>${icon('minus', 16)} Add expense</button><button class="btn primary" data-pay>${icon('plus', 16)} Record payment</button></div></div>
    <div class="toolbar"><span data-seg></span>
      <select class="input" data-period style="width:auto;height:36px">${[['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['fy', 'This financial year'], ['lastfy', 'Last financial year'], ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${ui.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="grid c3 mb" data-stats></div>
    <div data-list></div></div>`;

  root.querySelector('[data-seg]').append(segmented([['in', 'Received'], ['out', 'Expenses']], ui.tab, (v) => { ui.tab = v; draw(); }));

  const draw = () => {
    const r = periodRange(ui.period, b.fyStartMonth);
    const inR = (d) => d >= r.from && d <= r.to;
    const pin = payments.filter((p) => inR(p.date)).sort((a, x) => x.date.localeCompare(a.date));
    const pout = expenses.filter((p) => inR(p.date)).sort((a, x) => x.date.localeCompare(a.date));
    const tin = pin.reduce((s, p) => s + num(p.amount), 0), tout = pout.reduce((s, p) => s + num(p.amount), 0);
    root.querySelector('[data-stats]').innerHTML = `
      <div class="stat"><div class="label"><span class="dot" style="background:var(--green)"></span>Received</div><div class="value">${m(tin)}</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--red)"></span>Spent</div><div class="value">${m(tout)}</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--accent)"></span>Net cash flow</div><div class="value ${tin - tout < 0 ? 'neg' : ''}">${m(tin - tout)}</div></div>`;
    const host = root.querySelector('[data-list]');
    if (ui.tab === 'in') {
      host.innerHTML = pin.length ? `<div class="group">${pin.map((p) => `<div class="row click" data-pid="${p.id}"><span class="biz-avatar" style="border-radius:50%;background:var(--green-soft);color:var(--green)">${icon('arrow-down', 16)}</span>
        <div class="grow"><div class="title">${esc(cname(p.customerId))}</div><div class="sub">${fmtDate(p.date, b.locale)} · ${esc(p.mode)}${p.documentId ? ' · ' + esc(dnum(p.documentId)) : ' · on account'}${p.reference ? ' · ' + esc(p.reference) : ''}</div></div>
        <div class="end tnum pos" style="font-weight:600">+ ${m(p.amount)}</div></div>`).join('')}</div>`
        : emptyState('wallet', 'No payments in this period', 'Payments you record against bills or customer accounts show up here.');
      host.querySelectorAll('[data-pid]').forEach((x) => x.addEventListener('click', async () => {
        const p = payments.find((y) => y.id === x.dataset.pid);
        const linked = p.documentId ? docs.find((d) => d.id === p.documentId) : null;
        if (await paymentDialog({ customers, payment: p, openDocs, doc: linked })) render(root, {});
      }));
    } else {
      const byCat = {};
      pout.forEach((e) => (byCat[e.category] = (byCat[e.category] || 0) + num(e.amount)));
      host.innerHTML = pout.length ? `<div class="card mb"><div class="card-head"><h3>By category</h3></div>${Object.entries(byCat).sort((a, x) => x[1] - a[1]).map(([k, v]) => `<div style="margin:8px 0"><div class="flex between small"><span>${esc(k)}</span><b class="tnum">${m(v)}</b></div><div class="meter mt-s"><div style="width:${(v / tout) * 100}%;background:var(--red)"></div></div></div>`).join('')}</div>
        <div class="group">${pout.map((e) => `<div class="row click" data-eid="${e.id}"><span class="biz-avatar" style="border-radius:50%;background:var(--red-soft);color:var(--red)">${icon('arrow-up', 16)}</span>
        <div class="grow"><div class="title">${esc(e.vendor || e.category)}</div><div class="sub">${fmtDate(e.date, b.locale)} · ${esc(e.category)} · ${esc(e.mode)}</div></div>
        <div class="end tnum" style="font-weight:600">− ${m(e.amount)}</div></div>`).join('')}</div>`
        : emptyState('banknote', 'No expenses in this period', 'Track rent, purchases and other costs to see your real profit in Reports.');
      host.querySelectorAll('[data-eid]').forEach((x) => x.addEventListener('click', async () => { if (await expenseDialog(expenses.find((y) => y.id === x.dataset.eid))) render(root, {}); }));
    }
  };
  draw();
  root.querySelector('[data-period]').addEventListener('change', (e) => { ui.period = e.target.value; draw(); });
  root.querySelector('[data-pay]').addEventListener('click', async () => { if (await paymentDialog({ customers, openDocs })) render(root, {}); });
  root.querySelector('[data-exp]').addEventListener('click', async () => { if (await expenseDialog()) { ui.tab = 'out'; render(root, {}); } });
  root.querySelector('[data-export]').addEventListener('click', () => {
    const rows = ui.tab === 'in'
      ? [['Date', 'Customer', 'Bill', 'Mode', 'Reference', 'Amount'], ...payments.map((p) => [p.date, cname(p.customerId), dnum(p.documentId), p.mode, p.reference, p.amount])]
      : [['Date', 'Category', 'Vendor', 'Mode', 'Reference', 'Tax', 'Amount'], ...expenses.map((e) => [e.date, e.category, e.vendor, e.mode, e.reference, e.tax, e.amount])];
    downloadText(toCSV(rows), ui.tab === 'in' ? 'payments.csv' : 'expenses.csv', 'text/csv');
  });
  if (query.new) { history.replaceState(null, '', '#/money'); paymentDialog({ customers, openDocs }).then((r) => { if (r && root.isConnected) render(root, {}); }); }
}
