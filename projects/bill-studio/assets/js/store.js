// App state + domain helpers (documents, numbering, balances).
import { db, uid } from './db.js';
import { getCountry } from './tax/countries.js';
import { calculate, isTaxRegistered } from './tax/engine.js';
import { fyLabel, todayISO, addDays, daysBetween } from './lib/dates.js';
import { round, currencyDecimals } from './lib/money.js';
import { businessAllowed, audit } from './session.js';

export const state = { business: null, businesses: [], theme: 'light' };
const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = () => listeners.forEach((fn) => fn(state));

// ledger: +1 adds to what the customer owes, -1 reduces it; stock: -1 removes stock, +1 returns it.
export const DOC_TYPES = {
  invoice: { key: 'invoice', label: 'Invoice', plural: 'Invoices', prefix: 'INV', ledger: 1, stock: -1, payable: true, icon: 'file-text' },
  receipt: { key: 'receipt', label: 'Sales Receipt', plural: 'Sales Receipts', prefix: 'RCPT', ledger: 1, stock: -1, payable: true, paidNow: true, icon: 'receipt' },
  quotation: { key: 'quotation', label: 'Quotation', plural: 'Quotations', prefix: 'QUO', ledger: 0, stock: 0, icon: 'file-text', validity: true },
  proforma: { key: 'proforma', label: 'Proforma Invoice', plural: 'Proforma Invoices', prefix: 'PRO', ledger: 0, stock: 0, icon: 'file-text' },
  credit: { key: 'credit', label: 'Credit Note', plural: 'Credit Notes', prefix: 'CN', ledger: -1, stock: 1, refInvoice: true, icon: 'rotate-ccw' },
  debit: { key: 'debit', label: 'Debit Note', plural: 'Debit Notes', prefix: 'DN', ledger: 1, stock: 0, refInvoice: true, payable: true, icon: 'file-text' },
  challan: { key: 'challan', label: 'Delivery Challan', plural: 'Delivery Challans', prefix: 'DC', ledger: 0, stock: 0, icon: 'package' },
  purchase: { key: 'purchase', label: 'Purchase Order', plural: 'Purchase Orders', prefix: 'PO', ledger: 0, stock: 0, icon: 'file-down' },
};
export const DOC_TYPE_LIST = Object.values(DOC_TYPES);

export function docTitle(type, business, doc = null) {
  const t = DOC_TYPES[type] || DOC_TYPES.invoice;
  const c = getCountry(business?.country);
  const scheme = business?.taxScheme || 'regular';
  const registered = scheme !== 'unregistered';
  const b2c = doc ? !doc.customer?.taxId : false;
  if (type === 'invoice' || type === 'receipt') {
    if (scheme === 'composition') return c.docTitle.composition || 'Bill of Supply';
    if (!registered) return type === 'receipt' && c.gst ? 'Cash Memo' : (type === 'receipt' ? 'Receipt' : c.docTitle.unregistered);
    // Saudi Arabia: B2C sales use a Simplified Tax Invoice.
    if (c.code === 'SA') return b2c || type === 'receipt' ? 'Simplified Tax Invoice' : 'Tax Invoice';
    // Where the law calls the document a "Tax Invoice" (India Rule 46, AU, NZ, SG, ZA, AE…),
    // a registered seller's cash sale is a Tax Invoice too.
    if (type === 'receipt') return c.docTitle.registered === 'Tax Invoice' ? 'Tax Invoice' : 'Sales Receipt';
    return c.docTitle.registered;
  }
  if (type === 'credit' && registered && c.code === 'AE') return 'Tax Credit Note';
  if (type === 'debit' && registered && c.code === 'AE') return 'Tax Debit Note';
  return t.label;
}

// Seller details + tax settings frozen into a bill when it is saved, so later changes to
// the business profile or tax rates never alter a bill that was already issued.
const SNAP_KEYS = ['name', 'legalName', 'country', 'region', 'currency', 'locale', 'taxScheme', 'taxId', 'secondaryId', 'address', 'city',
  'postal', 'phone', 'email', 'website', 'bank', 'upi', 'payLink', 'taxes', 'fyStartMonth', 'showHsn'];
export function snapshotOf(business) {
  return JSON.parse(JSON.stringify(Object.fromEntries(SNAP_KEYS.map((k) => [k, business[k]]))));
}
export function bizFor(doc, business = state.business) {
  return doc?.snap ? { ...business, ...doc.snap } : business;
}

// Default tax = the standard rate: 18% GST in India, otherwise the highest everyday rate (ignoring luxury slabs).
export function defaultPreset(presets) {
  const rate = (p) => Number(p.rate ?? (p.components || []).reduce((s, c) => s + Number(c.rate || 0), 0));
  return presets.find((p) => p.gst && rate(p) === 18) || presets.filter((p) => rate(p) <= 28).sort((a, b) => rate(b) - rate(a))[0] || presets[0];
}

export function newBusiness(countryCode) {
  const c = getCountry(countryCode);
  return {
    id: uid('biz_'), name: '', legalName: '', country: c.code, currency: c.currency, locale: c.locale,
    region: '', taxScheme: c.noTax ? 'unregistered' : 'regular', taxId: '', secondaryId: '', address: '', city: '', postal: '', phone: '', email: '', website: '',
    logo: '', signature: '', accent: '#0071e3',
    bank: { name: '', holder: '', account: '', code: '', iban: '', swift: '', branch: '' }, upi: '',
    terms: 'Payment is due within 15 days.',
    footer: 'Thank you for your business!',
    paymentTermsDays: 15, fyStartMonth: c.fyStartMonth,
    taxes: JSON.parse(JSON.stringify(c.presets)),
    defaultTaxId: defaultPreset(c.presets)?.id || '',
    series: Object.fromEntries(DOC_TYPE_LIST.map((t) => [t.key, { prefix: t.prefix, digits: 4, start: 1, useFY: true }])),
    defaultTemplates: {}, roundOff: c.code === 'IN', showHsn: !!c.showHsn,
  };
}

const OLD_DEFAULT_TERMS = 'Payment is due within 15 days.\nGoods once sold will not be taken back.';
export async function loadState() {
  state.businesses = (await db.all('businesses')).filter((b) => businessAllowed(b.id));
  // Older versions pre-filled a no-returns clause that consumer law in many countries forbids — drop it if untouched.
  for (const b of state.businesses) if (b.terms === OLD_DEFAULT_TERMS) { b.terms = 'Payment is due within 15 days.'; await db.put('businesses', b); }
  const activeId = await db.setting('activeBusiness');
  state.business = state.businesses.find((b) => b.id === activeId) || state.businesses[0] || null;
}

export async function saveBusiness(b, { quiet = false, log = 'Business settings changed' } = {}) {
  await db.put('businesses', b);
  if (log) audit(log, b.name || '', { businessId: b.id });
  state.businesses = (await db.all('businesses')).filter((x) => businessAllowed(x.id));
  if (!state.business || state.business.id === b.id) state.business = b;
  await db.setting('activeBusiness', state.business.id);
  if (!quiet) emit();
  return b;
}

export async function switchBusiness(id) {
  state.business = state.businesses.find((b) => b.id === id) || state.business;
  await db.setting('activeBusiness', state.business.id);
  // Never keep another business's record on screen after switching.
  if (location.hash !== '#/' && location.hash !== '') { location.hash = '#/'; setTimeout(emit, 0); } else emit();
}

export const bizId = () => state.business?.id;
let docsCache = [];
let customersCache = [];
export const list = async (store) => {
  const rows = await db.all(store, bizId());
  if (store === 'documents') docsCache = rows;
  if (store === 'customers') customersCache = rows;
  return rows;
};
// A record belongs to the active business (guards deep links and business switches).
export const ownRecord = (r) => !!r && r.businessId === bizId();

// Total of final credit notes issued against an invoice (they reduce what is still due on it).
export function creditsAgainst(docId, docs = docsCache) {
  return docs.filter((d) => d.type === 'credit' && d.status === 'final' && d.refDocId === docId)
    .reduce((s, d) => s + calculate(d, bizFor(d)).total, 0);
}

// ---------- Numbering ----------
export function formatNumber(business, type, seq, date) {
  const s = business.series?.[type] || { prefix: DOC_TYPES[type].prefix, digits: 4, useFY: true };
  const n = String(seq).padStart(Number(s.digits) || 1, '0');
  const parts = [s.prefix, s.useFY ? fyLabel(date, business.fyStartMonth) : '', n].filter(Boolean);
  return parts.join(business.country === 'IN' ? '/' : '-');
}

export async function nextNumber(business, type, date = todayISO()) {
  const fy = fyLabel(date, business.fyStartMonth);
  const s = business.series?.[type] || {};
  const docs = (await db.all('documents', business.id)).filter((d) => d.type === type && (!s.useFY || d.fy === fy));
  const max = docs.reduce((m, d) => Math.max(m, Number(d.seq) || 0), 0);
  const seq = Math.max(max + 1, Number(s.start) || 1);
  return { seq, fy, number: formatNumber(business, type, seq, date) };
}

// ---------- Documents ----------
export function blankDoc(business, type = 'invoice') {
  const t = DOC_TYPES[type];
  const date = todayISO();
  return {
    id: '', businessId: business.id, type, number: '', seq: 0, fy: '', date,
    dueDate: t.payable && !t.paidNow ? addDays(date, business.paymentTermsDays || 0) : '',
    validUntil: t.validity ? addDays(date, 15) : '',
    customerId: '', customer: { name: '', address: '', taxId: '', phone: '', email: '', region: '' },
    shipTo: '', placeOfSupply: business.region || '', reference: '', refDocId: '',
    items: [], charges: [], discount: 0, discountType: 'pct', inclusive: false,
    roundOff: !!business.roundOff, reverseCharge: false, taxExempt: false,
    notes: '', terms: business.terms || '', templateId: business.defaultTemplates?.[type] || '', status: 'final',
    currency: business.currency, copyLabel: '',
  };
}

export function blankItem(business) {
  return { id: uid('li_'), productId: '', name: '', description: '', hsn: '', qty: 1, unit: 'pcs', rate: 0, disc: 0, discType: 'pct', taxId: business.defaultTaxId || '', cess: 0 };
}

export function docTotals(doc, business = state.business) { return calculate(doc, bizFor(doc, business)); }

export function paymentsFor(docId, payments) { return payments.filter((p) => p.documentId === docId); }

// What is still due on a bill from its own total, credit notes and directly linked payments.
function directDue(doc, payments) {
  const totals = docTotals(doc);
  const credited = round(creditsAgainst(doc.id), totals.dp);
  const total = round(totals.total - credited, totals.dp);
  const paid = round(paymentsFor(doc.id, payments).reduce((s, p) => s + Number(p.amount || 0), 0), totals.dp);
  return { totals, credited, total, paid, rem: Math.max(0, round(total - paid, totals.dp)), excess: Math.max(0, round(paid - total, totals.dp)) };
}

// On-account payments and over-payments are applied to the customer's oldest open bills first.
function onAccountApplied(doc, payments) {
  if (!doc.customerId) return 0;
  const mine = docsCache.filter((d) => d.customerId === doc.customerId && d.status === 'final' && DOC_TYPES[d.type]?.payable)
    .sort((a, b) => (a.date + (a.number || '')).localeCompare(b.date + (b.number || '')));
  if (!mine.some((d) => d.id === doc.id)) return 0;
  const dues = mine.map((d) => ({ d, ...directDue(d, payments) }));
  let pool = payments.filter((p) => p.customerId === doc.customerId && !p.documentId).reduce((s, p) => s + Number(p.amount || 0), 0)
    + dues.reduce((s, x) => s + x.excess, 0);
  const cust = customersCache.find((c) => c.id === doc.customerId);
  pool -= Math.max(0, Number(cust?.openingBalance) || 0); // the opening balance is the oldest debt
  for (const x of dues) {
    if (pool <= 0.004) return 0;
    const a = Math.min(pool, x.rem);
    if (x.d.id === doc.id) return a;
    pool -= a;
  }
  return 0;
}

export function payStatus(doc, payments, totals) {
  const t = DOC_TYPES[doc.type];
  if (doc.status === 'draft') return { key: 'draft', label: 'Draft' };
  if (doc.status === 'cancelled') return { key: 'neutral', label: 'Cancelled' };
  if (!t?.payable) {
    if (doc.type === 'quotation' && doc.convertedTo) return { key: 'paid', label: 'Converted' };
    if (doc.type === 'quotation' && doc.validUntil && doc.validUntil < todayISO()) return { key: 'neutral', label: 'Expired' };
    if (doc.type === 'credit') return { key: 'info', label: 'Credit' };
    return { key: 'neutral', label: 'Sent' };
  }
  const dp = totals.dp;
  const credited = round(creditsAgainst(doc.id), dp);
  const total = round(totals.total - credited, dp);
  const direct = round(paymentsFor(doc.id, payments).reduce((s, p) => s + Number(p.amount || 0), 0), dp);
  const applied = direct < total ? round(onAccountApplied(doc, payments), dp) : 0;
  const paid = round(direct + applied, dp);
  if (credited && total <= 0.004) return { key: 'info', label: 'Credited', paid, due: 0, credited };
  if (total <= 0 || paid >= total - 0.004) return { key: 'paid', label: direct > total + 0.004 ? 'Paid · advance' : 'Paid', paid, due: 0, credited, applied };
  const due = round(total - paid, dp);
  if (doc.dueDate && doc.dueDate < todayISO()) return { key: 'overdue', label: `Overdue · ${daysBetween(doc.dueDate, todayISO())}d`, paid, due, credited, applied };
  if (paid > 0 || credited > 0) return { key: 'partial', label: paid > 0 ? 'Partly paid' : 'Partly credited', paid, due, credited, applied };
  return { key: 'unpaid', label: 'Unpaid', paid, due, credited, applied };
}

// Full ledger for one customer: opening balance, ledger documents and payments, running balance.
export function customerLedger(customer, docs, payments, business = state.business) {
  const rows = [];
  if (Number(customer.openingBalance)) rows.push({ date: customer.createdAt?.slice(0, 10) || '', kind: 'Opening balance', ref: '', debit: Number(customer.openingBalance), credit: 0 });
  for (const d of docs) {
    if (d.customerId !== customer.id || d.status !== 'final') continue;
    const t = DOC_TYPES[d.type];
    if (!t?.ledger) continue;
    const tot = calculate(d, bizFor(d, business)).total;
    rows.push({ date: d.date, kind: t.label, ref: d.number, docId: d.id, debit: t.ledger > 0 ? tot : 0, credit: t.ledger < 0 ? tot : 0 });
  }
  for (const p of payments) {
    if (p.customerId !== customer.id) continue;
    rows.push({ date: p.date, kind: `Payment · ${p.mode || 'cash'}`, ref: p.reference || '', debit: 0, credit: Number(p.amount) || 0, paymentId: p.id });
  }
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let bal = 0;
  const dp = currencyDecimals(business?.currency || 'USD');
  for (const r of rows) { bal = round(bal + r.debit - r.credit, dp); r.balance = bal; }
  return { rows, balance: bal };
}

export async function adjustStock(doc, direction = 1) {
  const t = DOC_TYPES[doc.type];
  if (!t?.stock || doc.status !== 'final') return;
  for (const it of doc.items || []) {
    if (!it.productId) continue;
    const p = await db.get('products', it.productId);
    if (!p || !p.trackStock) continue;
    p.stock = round((Number(p.stock) || 0) + t.stock * direction * (Number(it.qty) || 0), 3);
    await db.put('products', p);
  }
}

export async function saveDocument(doc, { paidNow = null } = {}) {
  const business = state.business;
  const isNew = !doc.id;
  if (isNew) {
    if (!doc.number) { const n = await nextNumber(business, doc.type, doc.date); Object.assign(doc, n); }
    else if (!doc.fy) doc.fy = fyLabel(doc.date, business.fyStartMonth);
  } else {
    const prev = await db.get('documents', doc.id);
    if (prev) await adjustStock(prev, -1); // undo the previous stock movement
    // Payments follow the bill if its customer changed.
    if (prev && prev.customerId !== doc.customerId) {
      for (const p of await db.all('payments', business.id)) if (p.documentId === doc.id) { p.customerId = doc.customerId; await db.put('payments', p); }
    }
  }
  doc.businessId = business.id;
  doc.snap = snapshotOf(business);
  doc.totalCache = calculate(doc, business).total;
  await db.put('documents', doc);
  audit(isNew ? `${DOC_TYPES[doc.type]?.label || 'Bill'} created` : `${DOC_TYPES[doc.type]?.label || 'Bill'} edited`, `${doc.number}${doc.customer?.name ? ' · ' + doc.customer.name : ''} · ${doc.totalCache}${doc.status === 'draft' ? ' · draft' : ''}`, { businessId: business.id });
  await adjustStock(doc, 1);
  if (paidNow && paidNow.amount > 0) {
    await db.put('payments', { businessId: business.id, documentId: doc.id, customerId: doc.customerId, amount: paidNow.amount, mode: paidNow.mode || 'cash', date: doc.date, reference: '', note: `Against ${doc.number}` });
    audit('Payment recorded', `${paidNow.amount} · ${paidNow.mode || 'cash'} · ${doc.number}`, { businessId: business.id });
  }
  return doc;
}

export async function deleteDocument(doc) {
  await adjustStock(doc, -1);
  const pays = (await list('payments')).filter((p) => p.documentId === doc.id);
  for (const p of pays) await db.del('payments', p.id);
  await db.del('documents', doc.id);
  audit(`${DOC_TYPES[doc.type]?.label || 'Bill'} deleted`, `${doc.number}${pays.length ? ` (with ${pays.length} payment${pays.length > 1 ? 's' : ''})` : ''}`, { businessId: doc.businessId });
}
