import { esc, modal, toast, confirmDialog } from './ui.js';
import { db } from './db.js';
import { state } from './store.js';
import { todayISO } from './lib/dates.js';
import { num, fmtMoney } from './lib/money.js';

export const PAY_MODES = ['cash', 'upi', 'card', 'bank transfer', 'cheque', 'wallet', 'other'];

// Record (or edit) a payment. opts: { customers, customerId, doc, due, openDocs, payment }
export function paymentDialog({ customers = [], customerId = '', doc = null, due = 0, openDocs = [], payment = null } = {}) {
  const b = state.business;
  const p = payment || { amount: due > 0 ? due : '', date: todayISO(), mode: 'cash', reference: '', note: '', customerId: customerId || doc?.customerId || '', documentId: doc?.id || '' };
  const custOpts = customers.map((c) => `<option value="${c.id}" ${c.id === p.customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const m = modal({
    title: payment ? 'Edit payment' : 'Record payment',
    body: `<div class="form-grid">
      ${doc ? `<div class="field span2"><label>Against</label><input class="input" readonly value="${esc(doc.number)} · ${esc(doc.customer?.name || '')}"></div>`
        : `<div class="field span2"><label>Customer</label><select class="input" name="customerId"><option value="">— Select customer —</option>${custOpts}</select></div>
           <div class="field span2"><label>Apply to bill</label><select class="input" name="documentId"><option value="">On account (no specific bill)</option></select></div>`}
      <div class="field"><label>Amount (${esc(b.currency)})</label><input class="input" name="amount" type="number" step="any" min="0" value="${esc(p.amount)}" required></div>
      <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${esc(p.date)}"></div>
      <div class="field"><label>Mode</label><select class="input" name="mode">${PAY_MODES.map((x) => `<option ${x === p.mode ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Reference</label><input class="input" name="reference" value="${esc(p.reference)}" placeholder="UTR / cheque no."></div>
      <div class="field span2"><label>Note</label><input class="input" name="note" value="${esc(p.note)}"></div>
    </div>`,
    foot: `${payment ? '<button class="btn danger" data-del style="margin-right:auto">Delete</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save payment</button>`,
  });
  const el = m.el;
  const docSel = el.querySelector('[name=documentId]');
  const custSel = el.querySelector('[name=customerId]');
  const fillDocs = () => {
    if (!docSel) return;
    const list = openDocs.filter((d) => d.doc.customerId === custSel.value);
    docSel.innerHTML = `<option value="">On account (no specific bill)</option>` + list.map((d) => `<option value="${d.doc.id}" data-due="${d.due}" ${d.doc.id === p.documentId ? 'selected' : ''}>${esc(d.doc.number)} · due ${esc(fmtMoney(d.due, b.currency, b.locale))}</option>`).join('');
  };
  fillDocs();
  custSel?.addEventListener('change', fillDocs);
  docSel?.addEventListener('change', () => { const o = docSel.selectedOptions[0]; if (o?.dataset.due) el.querySelector('[name=amount]').value = o.dataset.due; });
  el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete payment?', 'The bill and customer balance will be updated.', { ok: 'Delete', danger: true }))) return;
    await db.del('payments', payment.id); toast('Payment deleted'); m.close('deleted');
  });
  el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => el.querySelector(`[name=${n}]`)?.value ?? '';
    const amount = num(v('amount'));
    if (!(amount > 0)) { toast('Enter an amount', 'err'); return; }
    const cust = doc ? (doc.customerId || '') : v('customerId');
    if (!cust && !doc) { toast('Choose a customer', 'err'); return; }
    const docDue = doc ? due : Number(el.querySelector('[name=documentId]')?.selectedOptions[0]?.dataset.due || 0);
    const linked = doc || v('documentId');
    if (linked && !payment && docDue > 0 && amount > docDue + 0.005) {
      const extra = fmtMoney(amount - docDue, b.currency, b.locale);
      if (!(await confirmDialog('More than the amount due', `This bill only has ${fmtMoney(docDue, b.currency, b.locale)} due. The extra ${extra} will be kept as an advance in the customer’s account.`, { ok: 'Record anyway' }))) return;
    }
    if (doc && !payment && docDue <= 0.005 && !(await confirmDialog('Bill already settled', 'Nothing is due on this bill. Record this payment as an advance?', { ok: 'Record advance' }))) return;
    const rec = { ...(payment || {}), businessId: b.id, customerId: cust, documentId: doc ? doc.id : v('documentId'), amount, date: v('date') || todayISO(), mode: v('mode'), reference: v('reference'), note: v('note') };
    await db.put('payments', rec);
    toast(payment ? 'Payment updated' : 'Payment recorded');
    m.close(rec);
  });
  return m.done;
}
