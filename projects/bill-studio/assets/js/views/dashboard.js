import { icon } from '../lib/icons.js';
import { esc } from '../ui.js';
import { state, list, DOC_TYPES, payStatus, docTotals, customerLedger } from '../store.js';
import { fmtMoney, fmtCompact } from '../lib/money.js';
import { fmtDate, todayISO, toISO, parseISO, periodRange } from '../lib/dates.js';
import { barChart } from '../lib/chart.js';
import { whatsappLink, reminderText } from '../lib/share.js';
import { businessTaxError } from '../tax/rules.js';
import { session, can, visibleDocs } from '../session.js';
import { getCountry } from '../tax/countries.js';
import { db } from '../db.js';

export async function render(root) {
  const b = state.business;
  const [allDocs, payments, customers, products] = await Promise.all([list('documents'), list('payments'), list('customers'), list('products')]);
  // Business-wide figures need "View reports"; everyone else sees their own work.
  const full = can('reports.view');
  const docs = full ? allDocs : visibleDocs(allDocs);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const mc = (v) => fmtCompact(v, b.currency, b.locale);
  const sales = docs.filter((d) => d.status === 'final' && DOC_TYPES[d.type]?.ledger);
  const signed = (d) => DOC_TYPES[d.type].ledger * docTotals(d, b).total;

  const month = periodRange('month');
  const inMonth = (iso) => iso >= month.from && iso <= month.to;
  const salesMonth = sales.filter((d) => inMonth(d.date)).reduce((s, d) => s + signed(d), 0);
  const recMonth = payments.filter((p) => inMonth(p.date)).reduce((s, p) => s + Number(p.amount || 0), 0);

  let receivable = 0, overdue = 0;
  const dueList = [];
  for (const d of docs) {
    if (!DOC_TYPES[d.type]?.payable || d.status !== 'final') continue;
    const st = payStatus(d, payments, docTotals(d, b));
    if (st.due > 0) { receivable += st.due; if (st.key === 'overdue') overdue += st.due; dueList.push({ d, st }); }
  }
  const custDues = customers.map((c) => ({ c, bal: customerLedger(c, docs, payments, b).balance })).filter((x) => x.bal > 0.004).sort((a, b2) => b2.bal - a.bal).slice(0, 5);

  // last 6 months
  const now = parseISO(todayISO());
  const months = [...Array(6)].map((_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1); return { key: toISO(d).slice(0, 7), label: d.toLocaleString(b.locale, { month: 'short' }) }; });
  const sv = months.map((mo) => sales.filter((d) => d.date.startsWith(mo.key)).reduce((s, d) => s + signed(d), 0));
  const pv = months.map((mo) => payments.filter((p) => p.date?.startsWith(mo.key)).reduce((s, p) => s + Number(p.amount || 0), 0));
  const low = products.filter((p) => p.trackStock && Number(p.stock) <= Number(p.lowStock || 0));
  const recent = docs.slice().sort((a, c) => (c.date + c.createdAt).localeCompare(a.date + a.createdAt)).slice(0, 6);

  const country = getCountry(b.country);
  const taxErr = businessTaxError(b);
  const einv = country.eInvoice;
  let einvSeen = false;
  try { einvSeen = localStorage.getItem('bs-einv-' + b.id) === '1'; } catch { /* private mode */ }
  // Everything lives in this browser only — nudge the owner to keep a backup (weekly, snoozable for 3 days).
  const lastBackup = await db.setting('lastBackup');
  const hasTeam = (await db.count('users')) > 1;
  const backupAge = lastBackup ? (Date.now() - new Date(lastBackup).getTime()) / 86400000 : Infinity;
  let snoozed = false;
  try { snoozed = Date.now() < Number(localStorage.getItem('bs-backup-snooze') || 0); } catch { /* private mode */ }
  const needBackup = can('data.backup') && allDocs.length > 0 && backupAge >= 7 && !snoozed;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><p style="margin:0 0 2px">${esc(fmtDate(todayISO(), b.locale, 'full'))}</p><h1>${greet}, ${esc(session.user.name.split(' ')[0])}.</h1></div>
      <div class="actions"><a class="btn" href="#/bills/new/receipt" data-perm="bills.create">${icon('receipt', 16)} Quick sale</a><a class="btn" href="#/bills/new/quotation" data-perm="bills.create">${icon('file-text', 16)} Quotation</a><a class="btn primary" href="#/bills/new/invoice" data-perm="bills.create">${icon('plus', 16)} New invoice</a></div></div>

    ${session.user.roleId === 'owner' && !hasTeam ? `<div class="notice mb">${icon('users', 18)}<div style="flex:1"><b>Working with a team?</b> Add managers, accountants and staff, each with their own sign-in and access. <a href="#/team">Open Team →</a></div></div>` : ''}
    ${needBackup ? `<div class="notice warn mb" data-bk>${icon('download', 18)}<div style="flex:1"><b>${lastBackup ? `Last backup ${Math.floor(backupAge)} days ago.` : 'You have never backed up.'}</b> Your bills are stored only in this browser — clearing browser data, or Safari after 7 days without a visit, can erase them. <a href="#/settings">Back up now →</a></div><button class="btn sm ghost" data-bk-later>Later</button></div>` : ''}
    ${taxErr && can('business.manage') ? `<div class="notice warn mb">${icon('triangle-alert', 18)}<div><b>Finish your tax setup before issuing bills.</b> ${esc(taxErr)} <a href="#/business">Open Business profile →</a></div></div>` : ''}
    ${einv && !einvSeen ? `<div class="notice mb" data-einv>${icon('sparkles', 18)}<div style="flex:1"><b>E-invoicing in ${esc(country.name)}:</b> ${esc(einv)}</div><button class="btn sm ghost" data-einv-ok>Got it</button></div>` : ''}
    ${full ? '' : `<div class="grid c3">
      <div class="stat"><div class="label"><span class="dot" style="background:var(--accent)"></span>My bills this month</div><div class="value">${docs.filter((d) => inMonth(d.date) && d.status === 'final').length}</div><div class="hint">${esc(session.role?.name || '')}</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--green)"></span>My sales this month</div><div class="value">${m(salesMonth)}</div><div class="hint">bills you created</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--orange)"></span>Still to collect</div><div class="value">${m(receivable)}</div><div class="hint">on your bills</div></div></div>`}
    <div class="grid c4" ${full ? '' : 'hidden style="display:none"'}>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--accent)"></span>Sales this month</div><div class="value">${m(salesMonth)}</div><div class="hint">${sales.filter((d) => inMonth(d.date)).length} bills</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--green)"></span>Received this month</div><div class="value">${m(recMonth)}</div><div class="hint">${payments.filter((p) => inMonth(p.date)).length} payments</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--orange)"></span>To collect</div><div class="value">${m(receivable)}</div><div class="hint">${dueList.length} open bills</div></div>
      <div class="stat"><div class="label"><span class="dot" style="background:var(--red)"></span>Overdue</div><div class="value ${overdue ? 'neg' : ''}">${m(overdue)}</div><div class="hint">${dueList.filter((x) => x.st.key === 'overdue').length} bills past due</div></div>
    </div>

    <div class="grid split mt" ${full ? '' : 'hidden style="display:none"'}>
      <div class="card"><div class="card-head"><h3>Last 6 months</h3><a class="small" href="#/reports">Reports ${icon('chevron-right', 14)}</a></div>
        ${barChart({ labels: months.map((x) => x.label), series: [{ name: 'Billed', values: sv, color: 'var(--accent)' }, { name: 'Received', values: pv, color: '#34c759' }], format: mc })}</div>
      <div class="card"><div class="card-head"><h3>Who owes you</h3><a class="small" href="#/customers">All ${icon('chevron-right', 14)}</a></div>
        ${custDues.length ? `<div class="group" style="box-shadow:none;margin:0 -8px">${custDues.map(({ c, bal }) => `
          <div class="row"><a class="grow" href="#/customers/${c.id}" style="color:inherit;text-decoration:none"><div class="title">${esc(c.name)}</div><div class="sub">${esc(c.phone || c.email || '')}</div></a>
          <div class="end"><div style="font-weight:600" class="tnum">${m(bal)}</div></div>
          ${c.phone ? `<a class="btn icon sm" title="Send WhatsApp reminder" target="_blank" rel="noopener" href="${esc(whatsappLink(c.phone, reminderText({ business: b, customerName: c.name, due: bal }), b.country))}">${icon('message-circle', 15)}</a>` : ''}</div>`).join('')}</div>`
        : `<div class="empty" style="padding:28px 10px"><div class="ic-wrap">${icon('circle-check', 26)}</div><h3>All settled</h3><p>No customer has pending dues.</p></div>`}</div>
    </div>

    <div class="grid split mt">
      <div class="card"><div class="card-head"><h3>Recent bills</h3><a class="small" href="#/bills">See all ${icon('chevron-right', 14)}</a></div>
        ${recent.length ? `<div class="table-wrap"><table class="table"><tbody>${recent.map((d) => { const t = docTotals(d, b); const st = payStatus(d, payments, t); return `<tr class="click" data-href="#/bills/${d.id}"><td><div style="font-weight:500">${esc(d.customer?.name || '—')}</div><div class="tiny muted">${esc(DOC_TYPES[d.type].label)} · ${esc(d.number)}</div></td><td class="muted small desktop-only">${fmtDate(d.date, b.locale)}</td><td><span class="badge ${st.key}">${esc(st.label)}</span></td><td class="num" style="font-weight:600">${m(t.total)}</td></tr>`; }).join('')}</tbody></table></div>`
        : `<div class="empty" style="padding:30px 10px"><div class="ic-wrap">${icon('file-text', 26)}</div><h3>No bills yet</h3><p>Create your first bill — it takes less than a minute.</p><a class="btn primary" href="#/bills/new/invoice">${icon('plus', 16)} New invoice</a></div>`}</div>
      <div>
        <div class="card"><div class="card-head"><h3>Quick actions</h3></div>
          <div class="grid c2" style="gap:10px">
            ${[['#/bills/new/invoice', 'file-text', 'Invoice', 'bills.create'], ['#/bills/new/receipt', 'receipt', 'Sales receipt', 'bills.create'], ['#/bills/new/quotation', 'file-text', 'Quotation', 'bills.create'], ['#/money?new=1', 'wallet', 'Record payment', 'payments.record'], ['#/customers?new=1', 'users', 'Add customer', 'customers.manage'], ['#/templates', 'layout-template', 'Bill designs', 'templates.manage'], ['#/team', 'user-plus', 'Add team member', 'users.manage'], ['#/items', 'package', 'Items & stock', 'items.view']]
              .filter((x) => can(x[3])).slice(0, 6).map(([h, ic, l]) => `<a class="btn" style="justify-content:flex-start;height:44px;border-radius:12px" href="${h}">${icon(ic, 17)} ${l}</a>`).join('')}
          </div></div>
        ${low.length ? `<div class="card"><div class="card-head"><h3>Low stock</h3><a class="small" href="#/items">Items ${icon('chevron-right', 14)}</a></div>
          ${low.slice(0, 5).map((p) => `<div class="flex between small" style="padding:4px 0"><span>${esc(p.name)}</span><span class="badge ${Number(p.stock) <= 0 ? 'overdue' : 'unpaid'}">${Number(p.stock)} ${esc(p.unit || '')}</span></div>`).join('')}</div>` : ''}
      </div>
    </div>
  </div>`;
  root.querySelectorAll('[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
  root.querySelector('[data-bk-later]')?.addEventListener('click', () => { try { localStorage.setItem('bs-backup-snooze', String(Date.now() + 3 * 86400000)); } catch { /* ignore */ } root.querySelector('[data-bk]')?.remove(); });
  root.querySelector('[data-einv-ok]')?.addEventListener('click', () => { try { localStorage.setItem('bs-einv-' + b.id, '1'); } catch { /* ignore */ } root.querySelector('[data-einv]')?.remove(); });
}
