import { icon } from '../lib/icons.js';
import { esc, toCSV, downloadText } from '../ui.js';
import { state, list, DOC_TYPES, payStatus, docTotals, customerLedger } from '../store.js';
import { getCountry, IN_STATES } from '../tax/countries.js';
import { fmtMoney, fmtNumber, num, round } from '../lib/money.js';
import { fmtDate, periodRange, todayISO, daysBetween, MONTHS } from '../lib/dates.js';
import { reportPdf } from '../reports-pdf.js';

const ui = { report: '', period: 'month', from: '', to: '' };

function reportsFor(country) {
  return [
    { key: 'sales', icon: 'chart-column', name: 'Sales summary', desc: 'Billed, tax and collected — month by month.' },
    { key: 'register', icon: 'list', name: 'Sales register', desc: 'Every bill with taxable value and tax breakup.' },
    country.gst
      ? { key: 'gstr1', icon: 'layers', name: 'GSTR-1 summary', desc: 'B2B, B2C, credit notes and HSN summary for filing.' }
      : { key: 'tax', icon: 'layers', name: `${country.taxName} report`, desc: `Output ${country.taxName} by rate, input ${country.taxName} and net payable.` },
    { key: 'pl', icon: 'sparkles', name: 'Profit & loss', desc: 'Sales minus expenses — see what you really earn.' },
    { key: 'aging', icon: 'clock', name: 'Receivables ageing', desc: 'Who owes what, and for how long.' },
    { key: 'balances', icon: 'users', name: 'Customer balances', desc: 'Outstanding and advance balance per customer.' },
    { key: 'items', icon: 'package', name: 'Item-wise sales', desc: 'Best sellers by quantity and revenue.' },
    { key: 'collections', icon: 'wallet', name: 'Collections', desc: 'Payments received by mode and day.' },
    { key: 'expenses', icon: 'banknote', name: 'Expense report', desc: 'Spending by category and vendor.' },
    { key: 'daybook', icon: 'calendar', name: 'Day book', desc: 'All bills, payments and expenses, day by day.' },
  ];
}

export async function render(root) {
  const b = state.business;
  const country = getCountry(b.country);
  const [docs, payments, expenses, customers] = await Promise.all([list('documents'), list('payments'), list('expenses'), list('customers')]);
  const REPORTS = reportsFor(country);
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const p2 = (v) => fmtNumber(round(v, 2), 'en-US', 2);

  const range = () => ui.period === 'custom' ? { from: ui.from || '2000-01-01', to: ui.to || todayISO() } : periodRange(ui.period, b.fyStartMonth);
  const finals = () => { const r = range(); return docs.filter((d) => d.status === 'final' && d.date >= r.from && d.date <= r.to); };

  const builders = {
    sales() {
      const f = finals().filter((d) => DOC_TYPES[d.type].ledger);
      const byMonth = new Map();
      for (const d of f) {
        const k = d.date.slice(0, 7); const t = docTotals(d, b); const s = DOC_TYPES[d.type].ledger;
        const e = byMonth.get(k) || { n: 0, taxable: 0, tax: 0, total: 0 };
        e.n++; e.taxable += s * t.taxable; e.tax += s * t.tax; e.total += s * t.total; byMonth.set(k, e);
      }
      const r = range();
      const recv = payments.filter((p) => p.date >= r.from && p.date <= r.to);
      const rows = [...byMonth.entries()].sort().map(([k, e]) => {
        const rc = recv.filter((p) => p.date.startsWith(k)).reduce((s, p) => s + num(p.amount), 0);
        return [`${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`, e.n, m(e.taxable), m(e.tax), m(e.total), m(rc)];
      });
      const tot = [...byMonth.values()].reduce((a, e) => ({ n: a.n + e.n, taxable: a.taxable + e.taxable, tax: a.tax + e.tax, total: a.total + e.total }), { n: 0, taxable: 0, tax: 0, total: 0 });
      const rcv = recv.reduce((s, p) => s + num(p.amount), 0);
      return { summary: [['Net sales', m(tot.taxable)], [`${country.taxName} collected`, m(tot.tax)], ['Total billed', m(tot.total)], ['Received', m(rcv)]],
        sections: [{ columns: ['Month', 'Bills', 'Taxable', 'Tax', 'Total', 'Received'], align: ['left', 'right', 'right', 'right', 'right', 'right'], rows, foot: ['Total', tot.n, m(tot.taxable), m(tot.tax), m(tot.total), m(rcv)] }] };
    },
    register() {
      const f = finals().filter((d) => DOC_TYPES[d.type].ledger).sort((a, x) => a.date.localeCompare(x.date));
      const comps = [...new Set(f.flatMap((d) => docTotals(d, b).taxSummary.map((x) => x.name)))];
      let T = { taxable: 0, total: 0 }; const CT = {};
      const rows = f.map((d) => {
        const t = docTotals(d, b); const s = DOC_TYPES[d.type].ledger;
        T.taxable += s * t.taxable; T.total += s * t.total;
        const cv = comps.map((cn) => { const v = s * t.taxSummary.filter((x) => x.name === cn).reduce((a, x) => a + x.amount, 0); CT[cn] = (CT[cn] || 0) + v; return p2(v); });
        return [fmtDate(d.date, b.locale), d.number, DOC_TYPES[d.type].label, d.customer?.name || '', d.customer?.taxId || '', p2(s * t.taxable), ...cv, p2(s * t.total)];
      });
      return { summary: [['Bills', String(f.length)], ['Taxable', m(T.taxable)], ['Total', m(T.total)]],
        sections: [{ columns: ['Date', 'Number', 'Type', 'Customer', country.taxIdLabel, 'Taxable', ...comps, 'Total'], align: ['left', 'left', 'left', 'left', 'left', 'right', ...comps.map(() => 'right'), 'right'], rows,
          foot: ['Total', '', '', '', '', p2(T.taxable), ...comps.map((cn) => p2(CT[cn] || 0)), p2(T.total)] }] };
    },
    gstr1() {
      const f = finals().filter((d) => ['invoice', 'receipt', 'debit', 'credit'].includes(d.type));
      const st = (code) => { const s = IN_STATES.find((x) => x.code === code); return s ? `${s.code}-${s.name}` : code; };
      const b2b = [], b2cl = [], b2cs = new Map(), cdn = [], cdnur = [], exp = [];
      const INV_TYPE = { sez_igst: 'SEZ supplies with payment', sez_lut: 'SEZ supplies without payment', deemed: 'Deemed Exp' };
      const addB2cs = (pos, r, sign) => {
        const k = `${pos}|${r.rate}`;
        const e = b2cs.get(k) || { pos, rate: r.rate, taxable: 0, cess: 0 };
        e.taxable += sign * r.taxable; e.cess += sign * r.cess; b2cs.set(k, e);
      };
      for (const d of f) {
        const t = docTotals(d, b);
        const reg = !!d.customer?.taxId;
        const inter = d.placeOfSupply !== b.region;
        if (d.type === 'credit' || d.type === 'debit') {
          const nt = d.type === 'credit' ? 'C' : 'D';
          for (const r of t.rateSummary) {
            if (reg) cdn.push([d.customer.taxId, d.customer?.name || '', d.number, fmtDate(d.date, b.locale), nt, st(d.placeOfSupply), p2(t.total), r.rate, p2(r.taxable), p2(r.cess)]);
            else if (inter && t.total > 100000) cdnur.push(['B2CL', d.number, fmtDate(d.date, b.locale), nt, st(d.placeOfSupply), p2(t.total), r.rate, p2(r.taxable), p2(r.cess)]);
            else addB2cs(d.placeOfSupply, r, d.type === 'credit' ? -1 : 1); // small B2C notes are netted into B2CS
          }
          continue;
        }
        for (const r of t.rateSummary) {
          if (/^export/.test(d.supplyType || '')) exp.push([d.supplyType === 'export_igst' ? 'WPAY' : 'WOPAY', d.number, fmtDate(d.date, b.locale), p2(t.total), '', '', '', r.rate, p2(r.taxable), p2(r.cess)]);
          else if (reg) b2b.push([d.customer.taxId, d.customer.name, d.number, fmtDate(d.date, b.locale), p2(t.total), st(d.placeOfSupply), d.reverseCharge ? 'Y' : 'N', INV_TYPE[d.supplyType] || 'Regular B2B', r.rate, p2(r.taxable), p2(r.cess)]);
          else if (inter && t.total > 100000) b2cl.push([d.number, fmtDate(d.date, b.locale), p2(t.total), st(d.placeOfSupply), r.rate, p2(r.taxable), p2(r.cess)]);
          else addB2cs(d.placeOfSupply, r, 1);
        }
      }
      const hsn = new Map();
      for (const d of f) {
        const t = docTotals(d, b); const s = d.type === 'credit' ? -1 : 1;
        for (const h of t.hsnSummary) {
          const k = `${h.hsn}|${h.rate}`;
          const e = hsn.get(k) || { hsn: h.hsn, rate: h.rate, unit: h.unit, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
          for (const x of ['qty', 'taxable', 'igst', 'cgst', 'sgst', 'cess']) e[x] += s * h[x];
          hsn.set(k, e);
        }
      }
      const all = f.map((d) => docTotals(d, b));
      const sumK = (k) => f.reduce((s, d, i) => s + (d.type === 'credit' ? -1 : 1) * all[i].lines.concat(all[i].charges).flatMap((l) => l.taxes).filter((x) => k.includes(x.name)).reduce((a, x) => a + x.amount, 0), 0);
      const sorted = f.slice().sort((a, x) => (a.seq || 0) - (x.seq || 0));
      const R = ['right'];
      return {
        summary: [['Taxable value', m(f.reduce((s, d, i) => s + (d.type === 'credit' ? -1 : 1) * all[i].taxable, 0))], ['IGST', m(sumK(['IGST']))], ['CGST', m(sumK(['CGST']))], ['SGST / UTGST', m(sumK(['SGST', 'UTGST']))]],
        sections: [
          { heading: '4A — B2B invoices', csv: 'b2b', columns: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Invoice Type', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'left', 'left', 'right', 'left', 'left', 'left', 'right', 'right', 'right'], rows: b2b },
          { heading: '5 — B2C Large (inter-state, invoice value above ₹1,00,000)', csv: 'b2cl', columns: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'right', 'left', 'right', 'right', 'right'], rows: b2cl },
          { heading: '7 — B2C Small (summary)', csv: 'b2cs', columns: ['Type', 'Place Of Supply', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'right', 'right', 'right'], rows: [...b2cs.values()].map((e) => ['OE', st(e.pos), e.rate, p2(e.taxable), p2(e.cess)]) },
          { heading: '6A — Exports', csv: 'exp', columns: ['Export Type', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'left', 'right', 'left', 'left', 'left', 'right', 'right', 'right'], rows: exp },
          { heading: '9B — Credit / debit notes (unregistered, large)', csv: 'cdnur', columns: ['UR Type', 'Note Number', 'Note date', 'Note Type', 'Place Of Supply', 'Note Value', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'], rows: cdnur },
          { heading: '9B — Credit / debit notes (registered)', csv: 'cdnr', columns: ['GSTIN/UIN', 'Name', 'Note Number', 'Note date', 'Note Type', 'Place Of Supply', 'Note Value', 'Rate', 'Taxable Value', 'Cess Amount'], align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'], rows: cdn },
          { heading: '12 — HSN-wise summary', csv: 'hsn', columns: ['HSN', 'UQC', 'Total Quantity', 'Rate', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'], align: ['left', 'left', ...Array(7).fill('right')], rows: [...hsn.values()].map((e) => [e.hsn || '—', (e.unit || 'OTH').toUpperCase(), fmtNumber(e.qty, 'en-US', 3), e.rate, p2(e.taxable), p2(e.igst), p2(e.cgst), p2(e.sgst), p2(e.cess)]) },
          { heading: '13 — Documents issued', columns: ['Nature of document', 'From', 'To', 'Total', 'Cancelled'], align: ['left', 'left', 'left', ...R, ...R],
            rows: ['invoice', 'credit', 'debit', 'challan'].map((ty) => { const ds = docs.filter((d) => d.type === ty && d.status !== 'draft' && d.date >= range().from && d.date <= range().to).sort((a, x) => (a.seq || 0) - (x.seq || 0)); return ds.length ? [DOC_TYPES[ty].plural, ds[0].number, ds.at(-1).number, ds.length, ds.filter((d) => d.status === 'cancelled').length] : null; }).filter(Boolean) },
        ],
        note: sorted.length ? '' : '',
      };
    },
    tax() {
      const f = finals().filter((d) => DOC_TYPES[d.type].ledger);
      const by = new Map();
      for (const d of f) { const s = DOC_TYPES[d.type].ledger; for (const x of docTotals(d, b).taxSummary) { const k = `${x.name}|${x.rate}`; const e = by.get(k) || { name: x.name, rate: x.rate, taxable: 0, tax: 0 }; e.taxable += s * x.taxable; e.tax += s * x.amount; by.set(k, e); } }
      const r = range();
      const exp = expenses.filter((e) => e.date >= r.from && e.date <= r.to);
      const out = [...by.values()].reduce((s, e) => s + e.tax, 0), inp = exp.reduce((s, e) => s + num(e.tax), 0);
      return { summary: [[`Output ${country.taxName}`, m(out)], [`Input ${country.taxName}`, m(inp)], ['Net payable', m(out - inp)]],
        sections: [{ heading: `Output ${country.taxName} on sales`, columns: ['Tax', 'Rate', 'Net sales', 'Tax'], align: ['left', 'right', 'right', 'right'], rows: [...by.values()].map((e) => [e.name, `${e.rate}%`, m(e.taxable), m(e.tax)]), foot: ['Total', '', m([...by.values()].reduce((s, e) => s + e.taxable, 0)), m(out)] },
          { heading: `Input ${country.taxName} on expenses`, columns: ['Date', 'Vendor', 'Category', 'Amount', 'Tax'], align: ['left', 'left', 'left', 'right', 'right'], rows: exp.filter((e) => num(e.tax)).map((e) => [fmtDate(e.date, b.locale), e.vendor, e.category, m(e.amount), m(e.tax)]), foot: ['Total', '', '', '', m(inp)] }] };
    },
    pl() {
      const f = finals().filter((d) => DOC_TYPES[d.type].ledger);
      const sales = f.reduce((s, d) => s + DOC_TYPES[d.type].ledger * docTotals(d, b).taxable, 0);
      const r = range();
      const exp = expenses.filter((e) => e.date >= r.from && e.date <= r.to);
      const byCat = {};
      exp.forEach((e) => (byCat[e.category] = (byCat[e.category] || 0) + num(e.amount) - num(e.tax)));
      const expTotal = Object.values(byCat).reduce((s, v) => s + v, 0);
      const profit = sales - expTotal;
      return { summary: [['Net sales', m(sales)], ['Expenses', m(expTotal)], [profit >= 0 ? 'Profit' : 'Loss', m(Math.abs(profit))], ['Margin', sales ? `${fmtNumber((profit / sales) * 100, 'en-US', 1)}%` : '—']],
        sections: [{ columns: ['', 'Amount'], align: ['left', 'right'], rows: [['Sales (excluding tax)', m(sales)], ...Object.entries(byCat).sort((a, x) => x[1] - a[1]).map(([k, v]) => [`Less: ${k}`, `(${m(v)})`])], foot: [profit >= 0 ? 'Net profit' : 'Net loss', m(profit)] }] };
    },
    aging() {
      const rows = new Map();
      for (const d of docs) {
        if (!DOC_TYPES[d.type].payable || d.status !== 'final') continue;
        const s = payStatus(d, payments, docTotals(d, b)); if (!(s.due > 0)) continue;
        const age = daysBetween(d.dueDate || d.date, todayISO());
        const k = d.customerId || d.customer?.name || '—';
        const e = rows.get(k) || { name: d.customer?.name || '—', cur: 0, a: 0, b: 0, c: 0, d: 0, t: 0 };
        const bucket = age <= 0 ? 'cur' : age <= 30 ? 'a' : age <= 60 ? 'b' : age <= 90 ? 'c' : 'd';
        e[bucket] += s.due; e.t += s.due; rows.set(k, e);
      }
      const list2 = [...rows.values()].sort((a, x) => x.t - a.t);
      const T = list2.reduce((a, e) => { for (const k of ['cur', 'a', 'b', 'c', 'd', 't']) a[k] += e[k]; return a; }, { cur: 0, a: 0, b: 0, c: 0, d: 0, t: 0 });
      return { summary: [['Total receivable', m(T.t)], ['Not yet due', m(T.cur)], ['Over 60 days', m(T.c + T.d)]],
        sections: [{ columns: ['Customer', 'Not due', '1–30', '31–60', '61–90', '90+', 'Total'], align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'], rows: list2.map((e) => [e.name, m(e.cur), m(e.a), m(e.b), m(e.c), m(e.d), m(e.t)]), foot: ['Total', m(T.cur), m(T.a), m(T.b), m(T.c), m(T.d), m(T.t)] }], asOf: true };
    },
    balances() {
      const rows = customers.map((c) => { const l = customerLedger(c, docs, payments, b); return { c, bal: l.balance, billed: l.rows.reduce((s, r) => s + r.debit, 0), paid: l.rows.reduce((s, r) => s + r.credit, 0) }; }).filter((x) => x.billed || x.paid).sort((a, x) => x.bal - a.bal);
      return { summary: [['Receivable', m(rows.filter((x) => x.bal > 0).reduce((s, x) => s + x.bal, 0))], ['Advances held', m(-rows.filter((x) => x.bal < 0).reduce((s, x) => s + x.bal, 0))]],
        sections: [{ columns: ['Customer', 'Phone', 'Billed', 'Received', 'Balance'], align: ['left', 'left', 'right', 'right', 'right'], rows: rows.map((x) => [x.c.name, x.c.phone || '', m(x.billed), m(x.paid), m(x.bal)]) }], asOf: true };
    },
    items() {
      const f = finals().filter((d) => ['invoice', 'receipt', 'credit'].includes(d.type));
      const by = new Map();
      for (const d of f) { const s = DOC_TYPES[d.type].ledger; for (const l of docTotals(d, b).lines) { const k = (l.productId || l.name).toLowerCase(); const e = by.get(k) || { name: l.name, unit: l.unit, qty: 0, amt: 0, bills: 0 }; e.qty += s * num(l.qty); e.amt += s * l.taxable; e.bills++; by.set(k, e); } }
      const rows = [...by.values()].sort((a, x) => x.amt - a.amt);
      const tot = rows.reduce((s, e) => s + e.amt, 0);
      return { summary: [['Items sold', String(rows.length)], ['Net revenue', m(tot)]],
        sections: [{ columns: ['Item', 'Qty', 'Bills', 'Net revenue', 'Share'], align: ['left', 'right', 'right', 'right', 'right'], rows: rows.map((e) => [e.name, `${fmtNumber(e.qty, b.locale, 3)} ${e.unit || ''}`, e.bills, m(e.amt), tot ? `${fmtNumber((e.amt / tot) * 100, 'en-US', 1)}%` : '']), foot: ['Total', '', '', m(tot), '100%'] }] };
    },
    collections() {
      const r = range();
      const ps = payments.filter((p) => p.date >= r.from && p.date <= r.to).sort((a, x) => a.date.localeCompare(x.date));
      const byMode = {};
      ps.forEach((p) => (byMode[p.mode] = (byMode[p.mode] || 0) + num(p.amount)));
      const tot = ps.reduce((s, p) => s + num(p.amount), 0);
      const cn = (id) => customers.find((c) => c.id === id)?.name || '';
      const dn = (id) => docs.find((d) => d.id === id)?.number || 'On account';
      return { summary: [['Collected', m(tot)], ...Object.entries(byMode).slice(0, 3).map(([k, v]) => [k, m(v)])],
        sections: [{ heading: 'By mode', columns: ['Mode', 'Payments', 'Amount'], align: ['left', 'right', 'right'], rows: Object.entries(byMode).map(([k, v]) => [k, ps.filter((p) => p.mode === k).length, m(v)]), foot: ['Total', ps.length, m(tot)] },
          { heading: 'All payments', columns: ['Date', 'Customer', 'Against', 'Mode', 'Reference', 'Amount'], align: ['left', 'left', 'left', 'left', 'left', 'right'], rows: ps.map((p) => [fmtDate(p.date, b.locale), cn(p.customerId), dn(p.documentId), p.mode, p.reference || '', m(p.amount)]) }] };
    },
    expenses() {
      const r = range();
      const ex = expenses.filter((e) => e.date >= r.from && e.date <= r.to).sort((a, x) => a.date.localeCompare(x.date));
      const by = {};
      ex.forEach((e) => (by[e.category] = (by[e.category] || 0) + num(e.amount)));
      const tot = ex.reduce((s, e) => s + num(e.amount), 0);
      return { summary: [['Total spent', m(tot)], ['Input tax', m(ex.reduce((s, e) => s + num(e.tax), 0))]],
        sections: [{ heading: 'By category', columns: ['Category', 'Amount', 'Share'], align: ['left', 'right', 'right'], rows: Object.entries(by).sort((a, x) => x[1] - a[1]).map(([k, v]) => [k, m(v), `${fmtNumber((v / tot) * 100, 'en-US', 1)}%`]), foot: ['Total', m(tot), ''] },
          { heading: 'All expenses', columns: ['Date', 'Vendor', 'Category', 'Mode', 'Amount'], align: ['left', 'left', 'left', 'left', 'right'], rows: ex.map((e) => [fmtDate(e.date, b.locale), e.vendor, e.category, e.mode, m(e.amount)]) }] };
    },
    daybook() {
      const r = range();
      const ev = [
        ...finals().map((d) => ({ date: d.date, kind: DOC_TYPES[d.type].label, ref: d.number, party: d.customer?.name || '', inA: 0, outA: 0, amt: docTotals(d, b).total })),
        ...payments.filter((p) => p.date >= r.from && p.date <= r.to).map((p) => ({ date: p.date, kind: `Payment in · ${p.mode}`, ref: p.reference || '', party: customers.find((c) => c.id === p.customerId)?.name || '', inA: num(p.amount), outA: 0 })),
        ...expenses.filter((e) => e.date >= r.from && e.date <= r.to).map((e) => ({ date: e.date, kind: `Expense · ${e.category}`, ref: e.reference || '', party: e.vendor || '', inA: 0, outA: num(e.amount) })),
      ].sort((a, x) => a.date.localeCompare(x.date));
      const ti = ev.reduce((s, e) => s + e.inA, 0), to = ev.reduce((s, e) => s + e.outA, 0);
      return { summary: [['Cash in', m(ti)], ['Cash out', m(to)], ['Net', m(ti - to)]],
        sections: [{ columns: ['Date', 'Entry', 'Ref.', 'Party', 'Bill amount', 'In', 'Out'], align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'], rows: ev.map((e) => [fmtDate(e.date, b.locale), e.kind, e.ref, e.party, e.amt ? m(e.amt) : '', e.inA ? m(e.inA) : '', e.outA ? m(e.outA) : '']), foot: ['Total', '', '', '', '', m(ti), m(to)] }] };
    },
  };

  const drawGallery = () => {
    root.innerHTML = `<div class="page">
      <div class="large-title"><div><h1>Reports</h1><p>Choose a report. Every report can be exported to PDF or CSV for your accountant.</p></div></div>
      <div class="grid c3">${REPORTS.map((r) => `<a class="card" href="#" role="button" data-r="${r.key}" style="text-decoration:none;color:inherit;display:block;transition:transform .3s var(--spring),box-shadow .3s">
        <div class="ic-wrap" style="width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);margin-bottom:12px">${icon(r.icon, 22)}</div>
        <div style="font-weight:600;font-size:16px;letter-spacing:-.01em">${esc(r.name)}</div><div class="small muted" style="margin-top:2px">${esc(r.desc)}</div></a>`).join('')}</div></div>`;
    root.querySelectorAll('[data-r]').forEach((a) => {
      a.addEventListener('mouseenter', () => (a.style.transform = 'translateY(-2px)'));
      a.addEventListener('mouseleave', () => (a.style.transform = ''));
      a.addEventListener('click', (e) => { e.preventDefault(); ui.report = a.dataset.r; drawReport(); });
    });
  };

  const drawReport = () => {
    const def = REPORTS.find((r) => r.key === ui.report);
    const rep = builders[ui.report]();
    const r = range();
    const subtitle = rep.asOf ? `As of ${fmtDate(todayISO(), b.locale)}` : ui.period === 'all' ? 'All time' : `${fmtDate(r.from, b.locale)} – ${fmtDate(r.to, b.locale)}`;
    root.innerHTML = `<div class="page">
      <div class="large-title"><div><p style="margin:0 0 4px"><a href="#" role="button" data-back>${icon('chevron-left', 14)} Reports</a></p><h1>${esc(def.name)}</h1><p>${esc(subtitle)}</p></div>
        <div class="actions"><button class="btn" data-csv>${icon('file-spreadsheet', 16)} CSV</button><button class="btn primary" data-pdf>${icon('download', 16)} PDF</button></div></div>
      ${rep.asOf ? '' : `<div class="toolbar"><select class="input" data-period style="width:auto;height:36px">${[['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['fy', 'This financial year'], ['lastfy', 'Last financial year'], ['year', 'This calendar year'], ['all', 'All time'], ['custom', 'Custom range']].map(([v, l]) => `<option value="${v}" ${ui.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${ui.period === 'custom' ? `<input class="input" type="date" data-from value="${ui.from}" style="width:auto;height:36px"><span class="muted">to</span><input class="input" type="date" data-to value="${ui.to}" style="width:auto;height:36px">` : ''}</div>`}
      <div class="grid c4 mb">${rep.summary.map(([k, v]) => `<div class="stat"><div class="label">${esc(k)}</div><div class="value" style="font-size:22px">${esc(v)}</div></div>`).join('')}</div>
      ${rep.sections.map((s, i) => `<div class="card mb" style="padding:14px 10px 6px">${s.heading || s.csv ? `<div class="card-head" style="padding:0 6px"><h3 style="font-size:15px">${esc(s.heading || '')}</h3>${s.csv ? `<button class="btn sm" data-sec-csv="${i}">${icon('download', 14)} CSV</button>` : ''}</div>` : ''}
        <div class="table-wrap"><table class="table"><thead><tr>${s.columns.map((c, j) => `<th class="${s.align?.[j] === 'right' ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.length ? s.rows.map((row) => `<tr>${row.map((v, j) => `<td class="${s.align?.[j] === 'right' ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${s.columns.length}" class="muted" style="text-align:center;padding:22px">No data for this period</td></tr>`}</tbody>
        ${s.foot ? `<tfoot><tr>${s.foot.map((v, j) => `<td class="${s.align?.[j] === 'right' ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr></tfoot>` : ''}</table></div></div>`).join('')}
      ${ui.report === 'gstr1' ? `<div class="notice">${icon('sparkles', 18)}<div>Section CSVs use the GSTR-1 offline-tool column names. Customers with a GSTIN are treated as B2B. Please review with your tax advisor before filing.</div></div>` : ''}
    </div>`;
    root.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); ui.report = ''; drawGallery(); });
    root.querySelector('[data-period]')?.addEventListener('change', (e) => { ui.period = e.target.value; if (ui.period === 'custom' && !ui.from) { ui.from = periodRange('month').from; ui.to = todayISO(); } drawReport(); });
    root.querySelector('[data-from]')?.addEventListener('change', (e) => { ui.from = e.target.value; drawReport(); });
    root.querySelector('[data-to]')?.addEventListener('change', (e) => { ui.to = e.target.value; drawReport(); });
    const base = (ui.period === 'all' ? `${def.name} all time` : `${def.name} ${r.from} to ${r.to}`).replace(/[^\w\- ]+/g, '');
    root.querySelector('[data-pdf]').addEventListener('click', () => reportPdf({ title: def.name, subtitle, summary: rep.summary, sections: rep.sections }, b, `${base}.pdf`));
    root.querySelector('[data-csv]').addEventListener('click', () => {
      const rows = rep.sections.flatMap((s) => [[s.heading || def.name], s.columns, ...s.rows, ...(s.foot ? [s.foot] : []), []]);
      downloadText(toCSV(rows), `${base}.csv`, 'text/csv');
    });
    root.querySelectorAll('[data-sec-csv]').forEach((x) => x.addEventListener('click', () => {
      const s = rep.sections[Number(x.dataset.secCsv)];
      downloadText(toCSV([s.columns, ...s.rows]), `${s.csv || 'section'}-${r.from}-${r.to}.csv`, 'text/csv');
    }));
  };

  if (ui.report && builders[ui.report] && REPORTS.some((r) => r.key === ui.report)) drawReport(); else drawGallery();
}
