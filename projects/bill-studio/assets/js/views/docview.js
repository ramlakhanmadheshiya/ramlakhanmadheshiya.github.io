import { icon } from '../lib/icons.js';
import { esc, toast, menu, confirmDialog, debounce } from '../ui.js';
import { db } from '../db.js';
import { state, list, DOC_TYPES, payStatus, docTotals, deleteDocument, docTitle, adjustStock, bizFor, ownRecord } from '../store.js';
import { fmtMoney } from '../lib/money.js';
import { fmtDate } from '../lib/dates.js';
import { buildContext, mountPage } from '../render.js';
import { templateFor, allTemplates } from '../tplstore.js';
import { printDoc, downloadPdf, sharePdf } from '../export.js';
import { whatsappLink, mailLink, billShareText } from '../lib/share.js';
import { paymentDialog } from '../payui.js';
import { setTitle } from '../app.js';

export async function render(root, { id }) {
  const b = state.business;
  const doc = await db.get('documents', id);
  if (!ownRecord(doc)) { root.innerHTML = `<div class="page"><div class="empty"><h3>Bill not found</h3><a class="btn" href="#/bills">Back to bills</a></div></div>`; return; }
  const [all] = await Promise.all([list('payments'), list('documents'), list('customers')]);
  const pays = all.filter((p) => p.documentId === doc.id).sort((a, c) => a.date.localeCompare(c.date));
  const totals = docTotals(doc, b);
  const st = payStatus(doc, all, totals);
  const paid = st.paid ?? pays.reduce((s, p) => s + Number(p.amount || 0), 0);
  let tpl = await templateFor(doc);
  const templates = await allTemplates();
  const ty = DOC_TYPES[doc.type];
  const title = docTitle(doc.type, bizFor(doc, b), doc);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const ctx = () => buildContext(doc, b, { paid, credited: st.credited || 0 });
  setTitle(`${ty.label} ${doc.number}`);

  root.innerHTML = `<div class="page wide" style="max-width:1300px">
    <div class="large-title"><div><p style="margin:0 0 4px"><a href="#/bills">${icon('chevron-left', 14)} Bills</a></p>
      <h1 class="mono" style="font-size:30px">${esc(doc.number)}</h1><p>${esc(title)} · ${esc(doc.customer?.name || '')} · ${fmtDate(doc.date, b.locale, 'long')}</p></div>
      <div class="actions">
        <button class="btn" data-act="print">${icon('printer', 16)} Print</button>
        <button class="btn" data-act="pdf">${icon('download', 16)} PDF</button>
        <button class="btn primary" data-act="share">${icon('share-2', 16)} Share</button>
        <button class="btn icon" data-more aria-label="More actions">${icon('ellipsis', 18)}</button>
      </div></div>
    <div class="doc-view">
      <div class="paper-stage"><div data-paper class="paper-shadow" style="background:#fff;margin:0 auto"></div></div>
      <div>
        <div class="card">
          <div class="flex between"><span class="badge ${st.key}" style="height:26px;font-size:13px">${esc(st.label)}</span>${doc.status === 'draft' ? `<a class="btn sm primary" href="#/bills/${doc.id}/edit">${icon('check', 14)} Review & issue</a>` : doc.status === 'cancelled' ? '' : `<a class="btn sm" href="#/bills/${doc.id}/edit">${icon('pencil', 14)} Edit</a>`}</div>
          <div class="value tnum" style="font-size:34px;font-weight:700;letter-spacing:-.03em;margin:14px 0 4px">${m(totals.total)}</div>
          <div class="small muted">${ty.payable ? (st.due ? `${m(st.due)} due${doc.dueDate ? ' by ' + fmtDate(doc.dueDate, b.locale) : ''}` : 'Fully paid') : esc(ty.label)}</div>
          ${ty.payable && totals.total > 0 ? `<div class="meter mt"><div style="width:${Math.min(100, (paid / totals.total) * 100)}%;background:var(--green)"></div></div>` : ''}
          <dl class="kv mt">
            <dt>Taxable value</dt><dd>${m(totals.taxable)}</dd>
            ${totals.taxSummary.map((x) => `<dt>${esc(x.name)} ${x.rate}%</dt><dd>${m(x.amount)}</dd>`).join('')}
            ${totals.roundOff ? `<dt>Round off</dt><dd>${m(totals.roundOff)}</dd>` : ''}
            ${st.credited ? `<dt>Credit notes</dt><dd>− ${m(st.credited)}</dd>` : ''}
            ${ty.payable ? `<dt>Paid${st.applied ? ' (incl. on-account)' : ''}</dt><dd class="pos">${m(paid)}</dd>` : ''}
          </dl>
          ${ty.payable && doc.status === 'final' && st.due > 0 ? `<button class="btn primary mt" style="width:100%" data-act="pay">${icon('wallet', 16)} Record payment</button>` : ''}
          ${doc.type === 'quotation' || doc.type === 'proforma' ? `<button class="btn primary mt" style="width:100%" data-act="convert">${icon('file-text', 16)} ${doc.convertedTo ? 'Converted — open invoice' : 'Convert to invoice'}</button>` : ''}
        </div>
        ${ty.payable ? `<div class="section-title">Payments</div><div class="group">${pays.length ? pays.map((p) => `<div class="row"><div class="grow"><div class="title">${m(p.amount)}</div><div class="sub">${fmtDate(p.date, b.locale)} · ${esc(p.mode)}${p.reference ? ' · ' + esc(p.reference) : ''}</div></div><button class="btn icon sm ghost" data-delpay="${p.id}" aria-label="Delete payment">${icon('trash-2', 15)}</button></div>`).join('') : `<div class="row"><span class="muted small">No payments yet</span></div>`}</div>` : ''}
        <div class="section-title">Send to customer</div>
        <div class="group">
          ${doc.customer?.phone ? `<a class="row" target="_blank" rel="noopener" href="${esc(whatsappLink(doc.customer.phone, billShareText({ business: b, doc, total: totals.total, title }), b.country))}">${icon('message-circle', 18)}<span class="grow">WhatsApp message</span>${icon('chevron-right', 16, 'chev')}</a>` : ''}
          <a class="row" href="${esc(mailLink(doc.customer?.email, `${title} ${doc.number} from ${b.name}`, billShareText({ business: b, doc, total: totals.total, title })))}">${icon('mail', 18)}<span class="grow">Email</span>${icon('chevron-right', 16, 'chev')}</a>
          <a class="row" data-act="share" href="javascript:void 0">${icon('share-2', 18)}<span class="grow">Share PDF…</span>${icon('chevron-right', 16, 'chev')}</a>
        </div>
        <div class="section-title">Design</div>
        <div class="group"><div class="row"><select class="input" data-tpl>${templates.map((x) => `<option value="${x.id}" ${x.id === tpl.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
        ${doc.customerId ? `<p class="small mt"><a href="#/customers/${doc.customerId}">View ${esc(doc.customer?.name || 'customer')}’s account →</a></p>` : ''}
      </div>
    </div></div>`;

  const paper = root.querySelector('[data-paper]');
  const draw = () => { const w = Math.min(794, paper.parentElement.clientWidth - 36); mountPage(paper, ctx(), tpl, { width: w }); };
  draw();
  const onResize = debounce(draw, 150);
  window.addEventListener('resize', onResize);
  // Re-render in place only if the user is still on this bill (a dialog may outlive navigation).
  const again = () => { window.removeEventListener('resize', onResize); if (root.isConnected && location.hash === `#/bills/${id}`) render(root, { id }); };

  const busy = async (btn, fn) => {
    const prev = btn?.innerHTML; if (btn) { btn.disabled = true; }
    try { await fn(); } catch (e) { toast(e.message || 'Something went wrong', 'err'); console.error(e); } finally { if (btn) { btn.disabled = false; btn.innerHTML = prev; } }
  };
  const actions = {
    print: () => printDoc(ctx(), tpl),
    pdf: (btn) => busy(btn, () => downloadPdf(ctx(), tpl)),
    share: (btn) => busy(btn, () => sharePdf(ctx(), tpl, billShareText({ business: b, doc, total: totals.total, title }))),
    pay: async () => { if (await paymentDialog({ doc, due: st.due })) again(); },
    convert: () => { location.hash = doc.convertedTo ? `#/bills/${doc.convertedTo}` : `#/bills/new/invoice?from=${doc.id}`; },
  };
  root.querySelectorAll('[data-act]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); actions[x.dataset.act](x); }));
  root.querySelector('[data-tpl]').addEventListener('change', async (e) => { doc.templateId = e.target.value; tpl = await templateFor(doc); await db.put('documents', doc); draw(); });
  root.querySelectorAll('[data-delpay]').forEach((x) => x.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete payment?', 'This payment will be removed and the bill balance updated.', { ok: 'Delete', danger: true }))) return;
    await db.del('payments', x.dataset.delpay); toast('Payment deleted'); again();
  }));
  root.querySelector('[data-more]').addEventListener('click', (e) => menu(e.currentTarget, [
    { label: 'Edit', icon: 'pencil', onClick: () => (location.hash = `#/bills/${doc.id}/edit`) },
    { label: 'Duplicate', icon: 'copy', onClick: () => (location.hash = `#/bills/new/${doc.type}?dup=${doc.id}`) },
    ...(doc.type === 'invoice' ? [{ label: 'Create credit note (return)', icon: 'rotate-ccw', onClick: () => (location.hash = `#/bills/new/credit?ref=${doc.id}`) },
      { label: 'Create delivery challan', icon: 'package', onClick: () => (location.hash = `#/bills/new/challan?dup=${doc.id}`) }] : []),
    ...(doc.type === 'quotation' ? [{ label: 'Convert to proforma', icon: 'file-text', onClick: () => (location.hash = `#/bills/new/proforma?from=${doc.id}`) }] : []),
    '-',
    ...(doc.status !== 'cancelled' && doc.status !== 'draft' ? [{ label: 'Cancel bill', icon: 'x', onClick: async () => {
      if (!(await confirmDialog('Cancel this bill?', `It stays in your records marked as cancelled and no longer counts towards sales or dues. Stock is returned.${pays.length ? ' Payments already recorded on it stay in the customer’s account as an advance.' : ''}`, { ok: 'Cancel bill', danger: true }))) return;
      await adjustStock(doc, -1); doc.status = 'cancelled'; await db.put('documents', doc); toast('Bill cancelled'); again();
    } }] : []),
    { label: 'Delete', icon: 'trash-2', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete ${doc.number}?`, doc.status === 'final' && DOC_TYPES[doc.type].ledger ? 'Tax law expects issued bills to be kept — use “Cancel bill” instead so your numbering has no gaps. Deleting permanently removes the bill and its payments from this device.' : 'This permanently removes the bill and its payments from this device. This cannot be undone.', { ok: 'Delete', danger: true }))) return;
      await deleteDocument(doc); toast('Bill deleted'); location.hash = '#/bills';
    } },
  ]));
  return () => window.removeEventListener('resize', onResize);
}
