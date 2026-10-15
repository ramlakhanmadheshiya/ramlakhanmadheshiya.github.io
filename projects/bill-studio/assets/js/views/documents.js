import { icon } from '../lib/icons.js';
import { esc, menu, emptyState, toCSV, downloadText } from '../ui.js';
import { state, list, DOC_TYPES, DOC_TYPE_LIST, payStatus, docTotals } from '../store.js';
import { fmtMoney } from '../lib/money.js';
import { fmtDate, periodRange } from '../lib/dates.js';

const ui = { type: 'all', status: 'all', q: '', period: 'all' };

export async function render(root) {
  const b = state.business;
  const [docs, payments] = await Promise.all([list('documents'), list('payments')]);
  const rows = docs.map((d) => { const t = docTotals(d, b); return { d, t, st: payStatus(d, payments, t) }; })
    .sort((a, c) => (c.d.date + (c.d.createdAt || '')).localeCompare(a.d.date + (a.d.createdAt || '')));
  const m = (v) => fmtMoney(v, b.currency, b.locale);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Bills</h1><p>Invoices, receipts, quotations and notes — all in one place.</p></div>
      <div class="actions"><button class="btn" data-export>${icon('download', 16)} Export</button><button class="btn primary" data-new>${icon('plus', 16)} New ${icon('chevron-down', 14)}</button></div></div>
    <div class="toolbar">
      <div class="searchbar">${icon('search', 16)}<input class="input" data-q placeholder="Search number, customer, item" value="${esc(ui.q)}" aria-label="Search bills"></div>
      <select class="input" data-period style="width:auto;height:36px">
        ${[['all', 'All time'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['fy', 'This financial year'], ['lastfy', 'Last financial year']].map(([v, l]) => `<option value="${v}" ${ui.period === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="toolbar" data-segs></div>
    <div class="chips mb" data-status></div>
    <div data-list></div>
  </div>`;

  const segHost = root.querySelector('[data-segs]');
  const seg = document.createElement('div');
  seg.className = 'segmented';
  const types = [['all', 'All'], ...DOC_TYPE_LIST.filter((t) => docs.some((d) => d.type === t.key) || ['invoice', 'receipt', 'quotation'].includes(t.key)).map((t) => [t.key, t.plural])];
  const drawSeg = () => { seg.innerHTML = types.map(([v, l]) => `<button class="${ui.type === v ? 'on' : ''}" data-v="${v}">${esc(l)}</button>`).join(''); };
  drawSeg();
  seg.addEventListener('click', (e) => { const x = e.target.closest('button'); if (!x) return; ui.type = x.dataset.v; drawSeg(); draw(); });
  segHost.append(seg);

  const statuses = [['all', 'All'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['partial', 'Partly paid'], ['paid', 'Paid'], ['draft', 'Drafts']];
  const stHost = root.querySelector('[data-status]');
  const drawSt = () => { stHost.innerHTML = statuses.map(([v, l]) => `<button class="chip ${ui.status === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join(''); };
  drawSt();
  stHost.addEventListener('click', (e) => { const x = e.target.closest('button'); if (!x) return; ui.status = x.dataset.v; drawSt(); draw(); });

  const filtered = () => {
    const r = periodRange(ui.period, b.fyStartMonth);
    const q = ui.q.toLowerCase();
    return rows.filter(({ d, st }) => (ui.type === 'all' || d.type === ui.type)
      && (ui.status === 'all' || st.key === ui.status || (ui.status === 'unpaid' && ['unpaid', 'overdue', 'partial'].includes(st.key)))
      && d.date >= r.from && d.date <= r.to
      && (!q || [d.number, d.customer?.name, d.reference, ...(d.items || []).map((i) => i.name)].join(' ').toLowerCase().includes(q)));
  };

  const draw = () => {
    const f = filtered();
    const host = root.querySelector('[data-list]');
    if (!rows.length) { host.innerHTML = emptyState('file-text', 'No bills yet', 'Your invoices, receipts and quotations will appear here.', `<a class="btn primary" href="#/bills/new/invoice">${icon('plus', 16)} Create your first bill</a>`); return; }
    if (!f.length) { host.innerHTML = emptyState('search', 'Nothing found', 'Try a different filter or search term.'); return; }
    const total = f.reduce((s, x) => s + (DOC_TYPES[x.d.type].ledger || 0) * x.t.total, 0);
    const due = f.reduce((s, x) => s + (x.st.due || 0), 0);
    host.innerHTML = `<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>Number</th><th>Customer</th><th class="desktop-only">Date</th><th class="desktop-only">Due</th><th>Status</th><th class="num">Amount</th></tr></thead>
      <tbody>${f.map(({ d, t, st }) => `<tr class="click" data-id="${d.id}">
        <td><div style="font-weight:500" class="mono small">${esc(d.number || 'Draft')}</div><div class="tiny muted">${esc(DOC_TYPES[d.type].label)}</div></td>
        <td><div style="font-weight:500">${esc(d.customer?.name || '—')}</div><div class="tiny muted mobile-only">${fmtDate(d.date, b.locale)}</div></td>
        <td class="desktop-only muted small">${fmtDate(d.date, b.locale)}</td>
        <td class="desktop-only muted small">${d.dueDate && DOC_TYPES[d.type].payable ? fmtDate(d.dueDate, b.locale) : '—'}</td>
        <td><span class="badge ${st.key}">${esc(st.label)}</span></td>
        <td class="num"><div style="font-weight:600">${m(t.total)}</div>${st.due && st.due < t.total ? `<div class="tiny muted">Due ${m(st.due)}</div>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">${f.length} bill${f.length === 1 ? '' : 's'}</td><td class="desktop-only"></td><td class="desktop-only"></td><td class="small muted">Due ${m(due)}</td><td class="num">${m(total)}</td></tr></tfoot>
    </table></div></div>`;
    host.querySelectorAll('[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/bills/${tr.dataset.id}`)));
  };
  draw();

  root.querySelector('[data-q]').addEventListener('input', (e) => { ui.q = e.target.value; draw(); });
  root.querySelector('[data-period]').addEventListener('change', (e) => { ui.period = e.target.value; draw(); });
  root.querySelector('[data-new]').addEventListener('click', (e) => menu(e.currentTarget, DOC_TYPE_LIST.map((t) => ({ label: t.label, icon: t.icon, onClick: () => (location.hash = `#/bills/new/${t.key}`) }))));
  root.querySelector('[data-export]').addEventListener('click', () => {
    const f = filtered();
    const csv = toCSV([['Type', 'Number', 'Date', 'Due date', 'Customer', 'Customer tax ID', 'Taxable', 'Tax', 'Total', 'Paid', 'Balance', 'Status'],
      ...f.map(({ d, t, st }) => [DOC_TYPES[d.type].label, d.number, d.date, d.dueDate || '', d.customer?.name || '', d.customer?.taxId || '', t.taxable, t.tax, t.total, st.paid ?? '', st.due ?? '', st.label])]);
    downloadText(csv, `bills-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  });
}
