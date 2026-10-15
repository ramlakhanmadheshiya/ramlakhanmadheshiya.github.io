import { icon } from '../lib/icons.js';
import { esc, toast, confirmDialog, menu } from '../ui.js';
import { db } from '../db.js';
import { state, list, customerLedger, DOC_TYPES, payStatus, docTotals } from '../store.js';
import { getCountry } from '../tax/countries.js';
import { fmtMoney } from '../lib/money.js';
import { fmtDate, todayISO, daysBetween } from '../lib/dates.js';
import { whatsappLink, smsLink, mailLink, reminderText } from '../lib/share.js';
import { paymentDialog } from '../payui.js';
import { customerDialog } from './customers.js';
import { setTitle } from '../app.js';
import { downloadStatementPdf } from '../reports-pdf.js';

export async function render(root, { id }) {
  const b = state.business;
  const c = await db.get('customers', id);
  if (!c) { root.innerHTML = `<div class="page"><div class="empty"><h3>Customer not found</h3><a class="btn" href="#/customers">Back</a></div></div>`; return; }
  const [docs, payments, customers] = await Promise.all([list('documents'), list('payments'), list('customers')]);
  const country = getCountry(b.country);
  const ledger = customerLedger(c, docs, payments, b);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const mine = docs.filter((d) => d.customerId === c.id).sort((a, x) => x.date.localeCompare(a.date));
  const open = mine.filter((d) => DOC_TYPES[d.type].payable && d.status === 'final').map((d) => ({ doc: d, ...payStatus(d, payments, docTotals(d, b)) })).filter((x) => x.due > 0);
  const aging = { '0–30': 0, '31–60': 0, '61–90': 0, '90+': 0 };
  for (const o of open) {
    const age = daysBetween(o.doc.dueDate || o.doc.date, todayISO());
    aging[age <= 30 ? '0–30' : age <= 60 ? '31–60' : age <= 90 ? '61–90' : '90+'] += o.due;
  }
  const text = reminderText({ business: b, customerName: c.name, due: ledger.balance, docs: open.map((o) => ({ number: o.doc.number, date: o.doc.date, due: o.due })) });
  setTitle(c.name);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><p style="margin:0 0 4px"><a href="#/customers">${icon('chevron-left', 14)} Customers</a></p><h1>${esc(c.name)}</h1>
      <p>${esc([c.phone, c.email, c.taxId ? `${country.taxIdLabel} ${c.taxId}` : ''].filter(Boolean).join(' · '))}</p></div>
      <div class="actions"><button class="btn" data-edit>${icon('pencil', 16)} Edit</button><button class="btn" data-pay>${icon('wallet', 16)} Receive payment</button><a class="btn primary" href="#/bills/new/invoice?customer=${c.id}">${icon('plus', 16)} New bill</a><button class="btn icon" data-more aria-label="More">${icon('ellipsis', 18)}</button></div></div>

    <div class="grid c3">
      <div class="stat"><div class="label">Balance</div><div class="value ${ledger.balance > 0 ? 'warn-text' : ledger.balance < 0 ? 'pos' : ''}">${m(Math.abs(ledger.balance))}</div><div class="hint">${ledger.balance > 0.004 ? 'They owe you' : ledger.balance < -0.004 ? 'Advance / credit with you' : 'All settled'}</div></div>
      <div class="stat"><div class="label">Total billed</div><div class="value">${m(ledger.rows.reduce((s, r) => s + r.debit, 0))}</div><div class="hint">${mine.length} documents</div></div>
      <div class="stat"><div class="label">Total received</div><div class="value">${m(payments.filter((p) => p.customerId === c.id).reduce((s, p) => s + Number(p.amount || 0), 0))}</div><div class="hint">${payments.filter((p) => p.customerId === c.id).length} payments</div></div>
    </div>

    ${ledger.balance > 0.004 ? `<div class="card mt"><div class="card-head"><h3>Remind ${esc(c.name.split(' ')[0])}</h3><span class="small muted">Free — opens your own app</span></div>
      <div class="btn-row">
        ${c.phone ? `<a class="btn" style="background:#25d366;color:#fff" target="_blank" rel="noopener" href="${esc(whatsappLink(c.phone, text, b.country))}">${icon('message-circle', 16)} WhatsApp</a><a class="btn" href="${esc(smsLink(c.phone, text))}">${icon('phone', 16)} SMS</a>` : ''}
        <a class="btn" href="${esc(mailLink(c.email, `Payment reminder from ${b.name}`, text))}">${icon('mail', 16)} Email</a>
        <button class="btn" data-copy>${icon('copy', 16)} Copy message</button>
        <button class="btn" data-statement>${icon('file-down', 16)} Statement PDF</button>
      </div>
      <div class="grid c4 mt">${Object.entries(aging).map(([k, v]) => `<div><div class="tiny muted">${k} days</div><div class="tnum" style="font-weight:600">${m(v)}</div></div>`).join('')}</div></div>` : ''}

    <div class="section-title">Account statement</div>
    <div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Particulars</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>${ledger.rows.length ? ledger.rows.map((r) => `<tr ${r.docId ? `class="click" data-href="#/bills/${r.docId}"` : ''}><td class="small muted">${fmtDate(r.date, b.locale)}</td><td>${esc(r.kind)} <span class="mono small muted">${esc(r.ref)}</span></td><td class="num">${r.debit ? m(r.debit) : ''}</td><td class="num pos">${r.credit ? m(r.credit) : ''}</td><td class="num" style="font-weight:600">${m(r.balance)}</td></tr>`).join('') : `<tr><td colspan="5" class="muted c" style="text-align:center;padding:24px">No transactions yet</td></tr>`}</tbody>
    </table></div></div>

    <div class="section-title">All documents</div>
    <div class="group">${mine.length ? mine.map((d) => { const t = docTotals(d, b); const st = payStatus(d, payments, t); return `<a class="row" href="#/bills/${d.id}"><div class="grow"><div class="title mono small">${esc(d.number)}</div><div class="sub">${esc(DOC_TYPES[d.type].label)} · ${fmtDate(d.date, b.locale)}</div></div><span class="badge ${st.key}">${esc(st.label)}</span><div class="end tnum" style="font-weight:600;min-width:90px">${m(t.total)}</div></a>`; }).join('') : '<div class="row muted small">No bills yet</div>'}</div>
    ${c.notes ? `<div class="section-title">Notes</div><div class="card small">${esc(c.notes)}</div>` : ''}
  </div>`;

  root.querySelectorAll('[data-href]').forEach((x) => x.addEventListener('click', () => (location.hash = x.dataset.href)));
  root.querySelector('[data-edit]').addEventListener('click', async () => { if (await customerDialog(c)) render(root, { id }); });
  root.querySelector('[data-pay]').addEventListener('click', async () => {
    if (await paymentDialog({ customers, customerId: c.id, due: Math.max(0, ledger.balance), openDocs: open.map((o) => ({ doc: o.doc, due: o.due })) })) render(root, { id });
  });
  root.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Reminder copied'); } catch { toast('Could not copy', 'err'); } });
  root.querySelector('[data-statement]')?.addEventListener('click', () => downloadStatementPdf(c, ledger, b));
  root.querySelector('[data-more]').addEventListener('click', (e) => menu(e.currentTarget, [
    { label: 'Download statement PDF', icon: 'file-down', onClick: () => downloadStatementPdf(c, ledger, b) },
    { label: 'Delete customer', icon: 'trash-2', danger: true, onClick: async () => {
      if (mine.length) { toast('This customer has bills — delete those first', 'err'); return; }
      if (!(await confirmDialog(`Delete ${c.name}?`, 'The customer will be removed from this device.', { ok: 'Delete', danger: true }))) return;
      await db.del('customers', c.id); toast('Customer deleted'); location.hash = '#/customers';
    } },
  ]));
}
