// Renders a document onto a template page, plus "flow" so growing blocks
// (long item lists, addresses) push the blocks below them down.
import { esc, nl2br, safeImg } from './ui.js';
import { fmtMoney, fmtPlain, fmtNumber, round } from './lib/money.js';
import { fmtDate } from './lib/dates.js';
import { amountInWords } from './lib/words.js';
import { qrSvg, paymentQR } from './lib/qr.js';
import { getCountry, IN_STATES } from './tax/countries.js';
import { calculate } from './tax/engine.js';
import { docTitle, DOC_TYPES, blankItem, bizFor } from './store.js';
import { BLOCK_TYPES, FONTS, PAGE } from './templates.js';

const PAPER_CSS = `
.bill-page{position:relative;background:#fff;color:#1d1d1f;overflow:hidden;font-size:12px;line-height:1.42;-webkit-font-smoothing:antialiased;letter-spacing:-.003em;text-align:left}
.bill-page *{box-sizing:border-box}
.bill-page .blk{position:absolute;overflow:visible}
.bill-page .blk.fixed{overflow:hidden}
.bill-page .lbl{font-size:.82em;text-transform:uppercase;letter-spacing:.06em;color:#86868b;font-weight:600;margin-bottom:3px}
.bill-page .nm{font-weight:600;color:inherit}
.bill-page .pmuted{opacity:.72}
.bill-page table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.bill-page th{font-weight:600;text-align:left;padding:7px 8px;font-size:.88em;white-space:nowrap}
.bill-page td{padding:7px 8px;vertical-align:top}
.bill-page .r{text-align:right}.bill-page .c{text-align:center}
.bill-page .desc{font-size:.85em;color:#6e6e73;margin-top:1px;white-space:pre-line}
.bill-page .itbl.h-line thead th{border-bottom:1.5px solid #1d1d1f;color:#1d1d1f}
.bill-page .itbl.h-line td{border-bottom:1px solid #e8e8ed}
.bill-page .itbl.h-minimal thead th{border-bottom:1px solid #d2d2d7;color:#86868b;text-transform:uppercase;letter-spacing:.06em;font-size:.78em;font-weight:500}
.bill-page .itbl.h-minimal td{border-bottom:1px solid #f0f0f2;padding:9px 8px}
.bill-page .itbl.h-filled thead th{background:var(--acc);color:#fff}
.bill-page .itbl.h-filled td{border-bottom:1px solid #e5e5ea}
.bill-page .itbl.h-soft thead th{background:var(--acc-soft);color:var(--acc)}
.bill-page .itbl.h-soft td{border-bottom:1px solid #f0f0f2}
.bill-page .itbl.rounded thead th:first-child{border-radius:8px 0 0 8px}.bill-page .itbl.rounded thead th:last-child{border-radius:0 8px 8px 0}
.bill-page .itbl.h-accentline thead th{border-top:1px solid var(--acc);border-bottom:1px solid var(--acc);color:var(--acc);text-transform:uppercase;letter-spacing:.08em;font-size:.78em}
.bill-page .itbl.h-accentline td{border-bottom:1px solid #eee7da}
.bill-page .itbl.gridlines th,.bill-page .itbl.gridlines td{border:1px solid #c7c7cc}
.bill-page .itbl.striped tbody tr:nth-child(even) td{background:#f7f7f9}
.bill-page .tot{display:flex;flex-direction:column;gap:3px;font-variant-numeric:tabular-nums}
.bill-page .tot .ln{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
.bill-page .tot .ln span:first-child{color:#6e6e73}
.bill-page .tot .grand{font-weight:700;font-size:1.25em;margin-top:4px;padding:8px 0;border-top:1.5px solid #1d1d1f}
.bill-page .tot .grand span:first-child{color:inherit}
.bill-page .tot.t-filled .grand{background:var(--acc);color:#fff;border:0;padding:9px 10px;border-radius:6px}
.bill-page .tot.t-accent .grand{border-top:0;color:var(--acc);font-size:1.45em}
.bill-page .tot.t-line .grand{border-top:1px solid #1d1d1f;border-bottom:1px solid #1d1d1f}
.bill-page .tot .bal{font-weight:600}
.bill-page .tsum th,.bill-page .tsum td{padding:4px 6px;border:1px solid #d2d2d7;font-size:.95em}
.bill-page .tsum th{background:#f5f5f7}
.bill-page .meta-row{display:flex;gap:10px;justify-content:space-between;padding:1px 0}
.bill-page .meta-row span:first-child{opacity:.7}
.bill-page .al-right .meta-row{justify-content:flex-end}
.bill-page .al-right .meta-row span:first-child::after{content:''}
.bill-page .meta-stack .meta-row{justify-content:flex-start}
.bill-page .meta-stack .meta-row span:first-child{min-width:90px}
.bill-page .qrbox svg{width:100%;height:auto;display:block}
.bill-page .sig img{max-height:56px;max-width:100%;object-fit:contain;display:block;margin:0 auto 2px}
.bill-page .sig .sl{border-top:1px solid #1d1d1f;padding-top:4px;margin-top:4px}
.bill-page .ph{border:1px dashed #c7c7cc;border-radius:8px;color:#aeaeb2;display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:11px;text-align:center}
.bill-page .logo img{width:100%;height:100%;object-fit:contain}
.bill-page .rcm{margin-top:4px;font-size:.85em;color:#c93400}
`;

export function ensurePaperCss() {
  if (document.getElementById('paper-css')) return;
  const s = document.createElement('style');
  s.id = 'paper-css'; s.textContent = PAPER_CSS;
  document.head.append(s);
}

const hexToRgba = (hex, a) => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(0,113,227,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
};
const cssSafe = (v) => (/^[#\w(),.%\s-]*$/.test(String(v ?? '')) ? v : '');
const col = (c) => (c === 'accent' ? 'var(--acc)' : cssSafe(c));

export function buildContext(doc, business, extra = {}) {
  business = bizFor(doc, business);
  const country = getCountry(business.country);
  const totals = calculate(doc, business);
  if (extra.paid != null) { totals.paid = extra.paid; totals.credited = extra.credited || 0; totals.balance = round(totals.total - totals.credited - extra.paid, totals.dp); }
  return { doc, business, country, totals, title: docTitle(doc.type, business, doc), sample: !!extra.sample, editing: !!extra.editing };
}

export function sampleContext(business, type = 'invoice') {
  const c = getCountry(business.country);
  const tax = business.defaultTaxId || business.taxes?.[0]?.id || '';
  const mk = (name, description, hsn, qty, unit, rate, disc = 0) => ({ ...blankItem(business), name, description, hsn, qty, unit, rate, disc, taxId: tax });
  const big = ['JPY', 'IDR', 'VND', 'KRW'].includes(business.currency) ? 100 : 1;
  const inr = business.currency === 'INR' ? 80 : 1;
  const m = big * inr;
  const otherRegion = c.regions ? (c.regions.find((r) => r.code !== business.region && r.code === '27') || c.regions[0]).code : '';
  const doc = {
    id: 'sample', type, number: type === 'invoice' ? 'INV/26-27/0042' : 'SAMPLE-0042', date: '2026-10-15', dueDate: '2026-10-30', validUntil: '2026-10-30',
    customer: { name: 'Acme Studio Pvt. Ltd.', address: '221B Baker Street\nSuite 4, Riverside Park', taxId: c.code === 'IN' ? '27AAPFU0939F1ZV' : 'GB123456789', phone: '+1 555 0100', email: 'accounts@acme.example', region: otherRegion },
    shipTo: 'Acme Warehouse\nDock 7, Industrial Estate', placeOfSupply: business.region || otherRegion, reference: 'PO-7781',
    items: [
      mk('Brand identity design', 'Logo, colour palette and typography guide', '998391', 1, 'job', 450 * m),
      mk('Website development', 'Responsive 6-page website', '998314', 1, 'job', 1200 * m, 5),
      mk('Premium paper business cards', '', '4911', 500, 'pcs', 0.4 * m),
      mk('Monthly maintenance', 'Hosting, backups and updates', '998316', 3, 'months', 60 * m),
    ],
    charges: [], discount: 0, inclusive: false, roundOff: !!business.roundOff, notes: 'Thank you for choosing us. Please quote the bill number with your payment.',
    terms: business.terms || 'Payment due within 15 days.', currency: business.currency, copyLabel: c.code === 'IN' ? 'Original for Recipient' : '', status: 'final',
  };
  return buildContext(doc, business, { sample: true });
}

// --- Placeholders for free text blocks ---
function fillText(text, ctx) {
  const { doc, business, totals } = ctx;
  const map = {
    'business.name': business.name, 'business.footer': business.footer, 'business.phone': business.phone, 'business.email': business.email,
    'business.website': business.website, 'business.taxId': business.taxId, 'doc.number': doc.number, 'doc.date': fmtDate(doc.date, business.locale),
    'doc.title': ctx.title, 'customer.name': doc.customer?.name, 'total': fmtMoney(totals.total, totals.currency, business.locale),
  };
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => map[k] ?? '');
}

// --- Block renderers ---
const R = {
  logo(b, ctx) {
    if (ctx.business.logo) return `<div class="logo" style="width:100%;height:100%"><img src="${safeImg(ctx.business.logo)}" alt=""></div>`;
    return ctx.editing ? `<div class="ph">Your logo</div>` : '';
  },
  business(b, ctx) {
    const x = ctx.business, c = ctx.country;
    const name = x.name || (ctx.editing || ctx.sample ? 'Your Business Name' : '');
    const lines = [x.address, [x.city, x.postal].filter(Boolean).join(' '), c.regions && x.region ? (c.regions.find((r) => r.code === x.region)?.name || '') : '']
      .filter(Boolean).join(', ');
    const contact = [x.phone, x.email, x.website].filter(Boolean).join(' · ');
    const showTaxId = x.taxScheme !== 'unregistered' || c.code === 'AU';
    const ids = [x.taxId && showTaxId ? `${c.taxIdLabel}: ${x.taxId}` : '', x.secondaryId ? `${c.secondaryIdLabel || 'Reg. No.'}: ${x.secondaryId}` : ''].filter(Boolean).join(' · ');
    return `<div class="nm" style="font-size:${b.props.nameSize || 18}px;color:${b.style.color === '#ffffff' ? '#fff' : '#1d1d1f'};${b.style.color === '#ffffff' ? '' : ''};line-height:1.15;margin-bottom:4px;letter-spacing:-.02em">${esc(name)}</div>
      ${x.legalName && x.legalName !== x.name ? `<div>${esc(x.legalName)}</div>` : ''}
      ${lines ? `<div>${nl2br(lines)}</div>` : ctx.sample ? '<div>Your address, City 000000</div>' : ''}
      ${contact ? `<div>${esc(contact)}</div>` : ''}${ids ? `<div style="font-weight:600">${esc(ids)}</div>` : ''}`;
  },
  title(b, ctx) {
    const local = !b.props.text && ctx.country.titleLocal?.[ctx.title];
    const t = b.props.text || ctx.title;
    const copy = b.props.showCopy !== false && ctx.doc.copyLabel && ctx.business.taxScheme !== 'unregistered' ? ctx.doc.copyLabel : '';
    if (b.props.showCopy && copy) return `<div>${esc(t)}${local ? ` · <span dir="rtl" lang="ar">${esc(local)}</span>` : ''}</div><span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:9px;letter-spacing:.3px;font-weight:500;text-transform:none;opacity:.9">${esc(copy)}</span>`;
    return `<div>${esc(t)}</div>${local ? `<div dir="rtl" lang="ar" style="font-size:.6em;font-weight:600;margin-top:2px">${esc(local)}</div>` : ''}${copy && !b.props.showCopy ? `<div style="font-size:10px;letter-spacing:.3px;font-weight:500;text-transform:none;opacity:.7;margin-top:2px">${esc(copy)}</div>` : ''}`;
  },
  meta(b, ctx) {
    const { doc, business, country } = ctx;
    const t = DOC_TYPES[doc.type] || DOC_TYPES.invoice;
    const loc = business.locale;
    const rows = [[`${t.label.replace('Sales ', '')} No.`, doc.number || 'Draft'], ['Date', fmtDate(doc.date, loc)]];
    if (doc.dueDate && t.payable && !t.paidNow) rows.push(['Due date', fmtDate(doc.dueDate, loc)]);
    if (doc.validUntil && t.validity) rows.push(['Valid until', fmtDate(doc.validUntil, loc)]);
    if (country.gst && doc.placeOfSupply) {
      const st = IN_STATES.find((s) => s.code === doc.placeOfSupply);
      rows.push(['Place of supply', st ? `${st.name} (${st.code})` : doc.placeOfSupply]);
    }
    if (doc.supplyDate && doc.supplyDate !== doc.date) rows.push(['Date of supply', fmtDate(doc.supplyDate, loc)]);
    if (doc.reference) rows.push(['Reference', doc.reference]);
    if (doc.refNumber) rows.push([doc.type === 'credit' || doc.type === 'debit' ? 'Against invoice' : 'Ref.', doc.refNumber + (doc.refDate ? ` dated ${fmtDate(doc.refDate, loc)}` : '')]);
    if (country.gst && doc.irn) { rows.push(['IRN', doc.irn]); if (doc.ackNo) rows.push(['Ack. no. / date', `${doc.ackNo}${doc.ackDate ? ' · ' + fmtDate(doc.ackDate, loc) : ''}`]); }
    if (country.gst && doc.reverseCharge) rows.push(['Reverse charge', 'Yes']);
    const cls = b.props.layout === 'stack' ? 'meta-stack' : '';
    return `<div class="${cls}">${rows.map(([k, v]) => `<div class="meta-row"><span>${esc(k)}</span><span style="font-weight:600">${esc(v)}</span></div>`).join('')}</div>`;
  },
  billto(b, ctx) { return party(b.props.label || (ctx.doc.type === 'purchase' ? 'Vendor' : 'Bill to'), ctx.doc.customer, ctx, true); },
  shipto(b, ctx) {
    const s = ctx.doc.shipTo;
    if (!s) return ctx.editing ? `<div class="lbl">${esc(b.props.label || 'Ship to')}</div><div style="opacity:.45">Shipping address appears here when set</div>` : '';
    return `<div class="lbl">${esc(b.props.label || 'Ship to')}</div><div>${nl2br(s)}</div>`;
  },
  items(b, ctx) { return itemsTable(b, ctx); },
  totals(b, ctx) { return totalsBox(b, ctx); },
  taxsummary(b, ctx) { return taxSummary(b, ctx); },
  words(b, ctx) {
    const { totals, country } = ctx;
    return `<span class="lbl" style="display:block">Amount in words</span><span style="font-weight:500">${esc(amountInWords(totals.total, totals.currency, country.numberSystem))}</span>`;
  },
  bank(b, ctx) {
    const x = ctx.business, k = x.bank || {};
    const rows = [['Bank', k.name], ['Account name', k.holder], ['Account no.', k.account], [ctx.country.code === 'IN' ? 'IFSC' : ctx.country.code === 'US' ? 'Routing no.' : ctx.country.code === 'GB' ? 'Sort code' : 'Bank code', k.code],
      ['IBAN', k.iban], ['SWIFT/BIC', k.swift], ['Branch', k.branch], ['UPI', x.upi]].filter((r) => r[1]);
    if (!rows.length) return ctx.editing || ctx.sample ? `<div class="lbl">Payment details</div><div style="opacity:.5">Add bank / UPI details in Business profile</div>` : '';
    return `<div class="lbl">${esc(b.props.label || 'Payment details')}</div>${rows.map(([k2, v]) => `<div><span style="opacity:.65">${esc(k2)}:</span> <span style="font-weight:500">${esc(v)}</span></div>`).join('')}`;
  },
  qr(b, ctx) {
    const q = b.props.text ? { payload: fillText(b.props.text, ctx), caption: b.props.caption || '' } : paymentQR(ctx.business, ctx.country, ctx.doc, ctx.totals);
    if (!q) return ctx.editing ? `<div class="ph">QR appears when UPI / IBAN / pay link is set</div>` : '';
    return `<div class="qrbox">${qrSvg(q.payload)}</div><div style="margin-top:4px;line-height:1.2">${esc(b.props.caption || q.caption)}</div>`;
  },
  notes(b, ctx) {
    if (!ctx.doc.notes) return ctx.editing ? `<div class="lbl">Notes</div><div style="opacity:.45">Notes for the customer</div>` : '';
    return `<div class="lbl">${esc(b.props.label || 'Notes')}</div><div>${nl2br(ctx.doc.notes)}</div>`;
  },
  terms(b, ctx) {
    if (!ctx.doc.terms) return ctx.editing ? `<div class="lbl">Terms & conditions</div><div style="opacity:.45">Your terms</div>` : '';
    return `<div class="lbl">${esc(b.props.label || 'Terms & conditions')}</div><div>${nl2br(ctx.doc.terms)}</div>`;
  },
  signature(b, ctx) {
    const x = ctx.business;
    return `<div class="sig" style="display:flex;flex-direction:column;justify-content:flex-end;height:100%">
      <div style="font-size:.9em;margin-bottom:auto">For <b>${esc(x.name || 'Your Business')}</b></div>
      ${x.signature ? `<img src="${safeImg(x.signature)}" alt="">` : '<div style="height:40px"></div>'}
      <div class="sl">${esc(b.props.label || 'Authorised signatory')}</div></div>`;
  },
  text(b, ctx) { return nl2br(fillText(b.props.text, ctx)); },
  image(b, ctx) {
    if (b.props.src) return `<img src="${safeImg(b.props.src)}" alt="" style="width:100%;height:100%;object-fit:${b.props.fit === 'cover' ? 'cover' : 'contain'}">`;
    return ctx.editing ? `<div class="ph">Image</div>` : '';
  },
  shape() { return ''; },
  line() { return ''; },
};

function party(label, p, ctx, showRegion) {
  if (!p?.name && !ctx.editing) return '';
  const c = ctx.country;
  const region = showRegion && c.regions && p?.region ? c.regions.find((r) => r.code === p.region) : null;
  return `<div class="lbl">${esc(label)}</div>
    <div class="nm" style="font-size:1.12em">${esc(p?.name || 'Customer name')}</div>
    ${p?.address ? `<div>${nl2br(p.address)}</div>` : ''}
    ${region ? `<div>State: ${esc(region.name)} (${region.code})</div>` : ''}
    ${p?.taxId ? `<div style="font-weight:600">${esc(c.taxIdLabel)}: ${esc(p.taxId)}</div>` : ''}
    ${[p?.phone, p?.email].filter(Boolean).length ? `<div class="pmuted">${esc([p.phone, p.email].filter(Boolean).join(' · '))}</div>` : ''}`;
}

function itemsTable(b, ctx) {
  const { totals, business, country } = ctx;
  const cur = totals.currency, loc = business.locale;
  const lines = totals.lines;
  const hasHsn = business.showHsn !== false && country.showHsn && lines.some((l) => l.hsn);
  const hasDisc = lines.some((l) => l.discountAmt > 0);
  const hasTax = lines.some((l) => l.taxes.length);
  const showCol = (k) => !(b.props.hide || []).includes(k);
  const cols = [
    showCol('idx') && { k: 'idx', h: '#', cls: 'c', w: '28px', v: (l, i) => i + 1 },
    { k: 'item', h: b.props.itemLabel || 'Item', v: (l) => `<div style="font-weight:500">${esc(l.name)}</div>${l.description && showCol('desc') ? `<div class="desc">${esc(l.description)}</div>` : ''}` },
    hasHsn && showCol('hsn') && { k: 'hsn', h: country.hsnLabel || 'Code', cls: 'c', v: (l) => esc(l.hsn) },
    showCol('qty') && { k: 'qty', h: 'Qty', cls: 'r', v: (l) => `${fmtNumber(l.qty, loc, 3)}${l.unit ? ` <span style="opacity:.6;font-size:.88em">${esc(l.unit)}</span>` : ''}` },
    showCol('rate') && { k: 'rate', h: 'Rate', cls: 'r', v: (l) => fmtPlain(l.rate, cur, loc) },
    hasDisc && showCol('disc') && { k: 'disc', h: 'Disc.', cls: 'r', v: (l) => l.discountAmt ? (l.discType === 'amt' ? fmtPlain(l.discountAmt, cur, loc) : `${fmtNumber(l.disc, loc)}%`) : '—' },
    hasTax && showCol('tax') && { k: 'tax', h: country.gst ? 'GST' : (country.taxName === 'VAT' ? 'VAT' : 'Tax'), cls: 'r', v: (l) => l.taxes.length ? `${country.reducedMark === l.taxRate ? '※ ' : ''}${fmtNumber(l.taxRate + (l.cessRate || 0), loc)}%${showCol('taxamt') ? `<div class="desc">${fmtPlain(l.tax, cur, loc)}</div>` : ''}` : '—' },
    { k: 'amount', h: 'Amount', cls: 'r', v: (l) => `<span style="font-weight:500">${fmtPlain(b.props.amountInclTax ? l.total : l.taxable, cur, loc)}</span>` },
  ].filter(Boolean);
  const head = cols.map((c) => `<th class="${c.cls || ''}" ${c.w ? `style="width:${c.w}"` : ''}>${esc(c.h)}</th>`).join('');
  const body = lines.length ? lines.map((l, i) => `<tr>${cols.map((c) => `<td class="${c.cls || ''}">${c.v(l, i)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="c" style="padding:18px;opacity:.5">No items yet</td></tr>`;
  const cls = ['itbl', `h-${b.props.header || 'line'}`, b.props.grid ? 'gridlines' : '', b.props.striped ? 'striped' : '', b.props.rounded ? 'rounded' : ''].join(' ');
  return `<table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// India Rule 46 endorsements for exports and SEZ supplies.
export const SUPPLY_NOTES = {
  export_igst: 'SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX',
  export_lut: 'SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX',
  sez_igst: 'SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX',
  sez_lut: 'SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX',
  deemed: 'DEEMED EXPORT',
};

function totalsBox(b, ctx) {
  const { totals: t, business, country, doc } = ctx;
  const cur = t.currency, loc = business.locale;
  const m = (v) => fmtMoney(v, cur, loc);
  const rows = [];
  rows.push(['Subtotal', m(t.subtotal)]);
  if (t.extraDiscount) rows.push([`Discount${doc.discountType === 'pct' ? ` (${fmtNumber(doc.discount, loc)}%)` : ''}`, '− ' + m(t.extraDiscount)]);
  for (const c of t.charges) rows.push([esc(c.label || 'Charges'), m(c.taxable)]);
  if ((t.extraDiscount || t.charges.length) && t.tax) rows.push(['Taxable amount', m(t.taxable)]);
  for (const x of t.taxSummary) rows.push([`${esc(x.name)} @ ${fmtNumber(x.rate, loc, 3)}%`, m(x.amount)]);
  if (t.roundOff) rows.push(['Round off', (t.roundOff > 0 ? '+ ' : '− ') + m(Math.abs(t.roundOff))]);
  const paidRows = [];
  if (b.props.showPaid !== false && (t.paid > 0 || t.credited > 0) && !ctx.sample) {
    if (t.credited > 0) paidRows.push(['Less: credit notes', '− ' + m(t.credited)]);
    if (t.paid > 0) paidRows.push(['Paid', m(t.paid)]);
    paidRows.push(['Balance due', m(t.balance), 'bal']);
  }
  return `<div class="tot t-${b.props.totalStyle || 'line'}">
    ${rows.map(([k, v]) => `<div class="ln"><span>${k}</span><span>${v}</span></div>`).join('')}
    <div class="ln grand"><span>${esc(b.props.totalLabel || 'Total')}</span><span>${m(t.total)}</span></div>
    ${paidRows.map(([k, v, c]) => `<div class="ln ${c || ''}"><span>${k}</span><span>${v}</span></div>`).join('')}
    ${t.rcmIndia ? `<div class="rcm">Tax of ${m(t.tax)} is payable by the recipient under reverse charge.</div>` : ''}
    ${!country.gst && doc.reverseCharge ? `<div class="rcm">Reverse charge: the customer accounts for ${country.taxName}.</div>` : ''}
    ${doc.taxExempt ? `<div class="rcm" style="color:#6e6e73">Tax exempt${doc.exemptReason ? ': ' + esc(doc.exemptReason) : ' sale.'}</div>` : ''}
    ${business.taxScheme === 'unregistered' && country.exemptNote ? `<div class="rcm" style="color:#6e6e73">${esc(country.exemptNote)}</div>` : ''}
    ${country.gst && SUPPLY_NOTES[doc.supplyType] ? `<div class="rcm" style="color:#1d1d1f;font-weight:600">${SUPPLY_NOTES[doc.supplyType]}</div>` : ''}
    ${country.reducedMark && t.lines.some((l) => l.taxRate === country.reducedMark) ? `<div class="rcm" style="color:#6e6e73">※ Reduced tax rate (${country.reducedMark}%) item</div>` : ''}
    ${country.gst && business.taxScheme === 'composition' ? `<div class="rcm" style="color:#6e6e73">Composition taxable person, not eligible to collect tax on supplies.</div>` : ''}
  </div>`;
}

function taxSummary(b, ctx) {
  const { totals: t, business, country } = ctx;
  if (!t.tax) return '';
  const cur = t.currency, loc = business.locale;
  const p = (v) => fmtPlain(v, cur, loc);
  if (country.gst) {
    const igst = t.lines.some((l) => l.taxes.some((x) => x.name === 'IGST'));
    const cess = t.hsnSummary.some((h) => h.cess);
    const rows = b.props.mode === 'hsn' ? t.hsnSummary : t.rateSummary;
    const first = b.props.mode === 'hsn' ? 'HSN/SAC' : 'Rate';
    const sName = t.lines.some((l) => l.taxes.some((x) => x.name === 'UTGST')) ? 'UTGST' : 'SGST';
    return `<table class="tsum"><thead><tr><th>${first}</th><th class="r">Taxable</th>${igst ? '<th class="r">IGST</th>' : `<th class="r">CGST</th><th class="r">${sName}</th>`}${cess ? '<th class="r">Cess</th>' : ''}<th class="r">Total tax</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${b.props.mode === 'hsn' ? `${esc(r.hsn || '—')} <span style="opacity:.6">@${fmtNumber(r.rate, loc)}%</span>` : `${fmtNumber(r.rate, loc)}%`}</td><td class="r">${p(r.taxable)}</td>${igst ? `<td class="r">${p(r.igst)}</td>` : `<td class="r">${p(r.cgst)}</td><td class="r">${p(r.sgst)}</td>`}${cess ? `<td class="r">${p(r.cess)}</td>` : ''}<td class="r">${p(r.tax)}</td></tr>`).join('')}
      <tr style="font-weight:600"><td>Total</td><td class="r">${p(t.taxable)}</td>${igst ? `<td class="r">${p(sum(rows, 'igst'))}</td>` : `<td class="r">${p(sum(rows, 'cgst'))}</td><td class="r">${p(sum(rows, 'sgst'))}</td>`}${cess ? `<td class="r">${p(sum(rows, 'cess'))}</td>` : ''}<td class="r">${p(t.tax)}</td></tr></tbody></table>`;
  }
  return `<table class="tsum"><thead><tr><th>${esc(country.taxName)}</th><th class="r">Net</th><th class="r">Tax</th></tr></thead><tbody>
    ${t.taxSummary.map((x) => `<tr><td>${esc(x.name)} ${fmtNumber(x.rate, loc, 3)}%</td><td class="r">${p(x.taxable)}</td><td class="r">${p(x.amount)}</td></tr>`).join('')}</tbody></table>`;
}
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);

function blockStyle(b, tpl) {
  const s = b.style || {};
  const css = [
    `left:${+b.x || 0}px`, `top:${+b.y || 0}px`, `width:${+b.w || 0}px`,
    BLOCK_TYPES[b.type]?.grow ? `min-height:${+b.h || 0}px` : `height:${+b.h || 0}px`,
    `z-index:${+b.z || 1}`,
  ];
  if (s.fontSize) css.push(`font-size:${+s.fontSize || 0}px`);
  if (s.color) css.push(`color:${col(s.color)}`);
  if (s.weight) css.push(`font-weight:${+s.weight || 400}`);
  if (s.align) css.push(`text-align:${['left', 'center', 'right'].includes(s.align) ? s.align : 'left'}`);
  if (s.italic) css.push('font-style:italic');
  if (s.uppercase) css.push('text-transform:uppercase');
  if (s.letterSpacing) css.push(`letter-spacing:${+s.letterSpacing || 0}px`);
  if (s.lineHeight) css.push(`line-height:${+s.lineHeight || 0}`);
  if (s.font && FONTS[s.font]) css.push(`font-family:${FONTS[s.font].css}`);
  const bg = s.bg && s.bg !== 'transparent' ? col(s.bg) : '';
  if (b.type === 'shape' || b.type === 'line') {
    if (bg) css.push(`background:${bg}`);
  } else if (bg) css.push(`background:${bg}`);
  if (s.borderWidth) css.push(`border:${+s.borderWidth || 0}px solid ${col(s.borderColor || '#1d1d1f')}`);
  if (s.radius) css.push(`border-radius:${+s.radius || 0}px`);
  if (s.padding) css.push(`padding:${+s.padding || 0}px`);
  if (s.opacity != null && s.opacity !== '' && s.opacity < 1) css.push(`opacity:${+s.opacity}`);
  if (['title'].includes(b.type) && s.align === 'center') css.push('display:flex;align-items:center;justify-content:center');
  if (b.type === 'title' && b.h <= 40 && s.align !== 'center') css.push('display:flex;flex-direction:column;justify-content:center');
  if (b.type === 'logo' && s.align) css.push(`display:flex;justify-content:${s.align === 'right' ? 'flex-end' : s.align === 'center' ? 'center' : 'flex-start'}`);
  if (b.type === 'meta' && s.align === 'right') css.push('');
  return css.join(';');
}

export function renderPage(ctx, tpl, { editing = false } = {}) {
  ensurePaperCss();
  ctx.editing = editing;
  const font = FONTS[tpl.font] || FONTS.system;
  const accent = cssSafe(tpl.accent || ctx.business.accent) || '#0071e3';
  const page = tpl.page || PAGE;
  const blocks = tpl.blocks.filter((b) => !b.hidden || editing);
  const html = blocks.map((b) => {
    const r = R[b.type];
    if (!r) return '';
    const inner = r(b, ctx);
    const alignCls = b.style?.align === 'right' ? 'al-right' : '';
    return `<div class="blk ${editing ? 'fixed' : ''} b-${b.type} ${alignCls}" data-id="${esc(b.id)}" style="${blockStyle(b, tpl)}${b.hidden ? ';opacity:.25' : ''}">${inner}</div>`;
  }).join('');
  return `<div class="bill-page" style="width:${page.w}px;height:${page.h}px;background:${cssSafe(page.bg) || '#fff'};font-family:${font.css};--acc:${accent};--acc-soft:${hexToRgba(accent, 0.1)}">${html}</div>`;
}

// After mounting a rendered page: push blocks down when growing blocks overflow.
export function flowLayout(pageEl, tpl) {
  const page = tpl.page || PAGE;
  const blocks = tpl.blocks.filter((b) => !b.hidden).slice().sort((a, b) => a.y - b.y);
  const el = (b) => pageEl.querySelector(`[data-id="${esc(b.id)}"]`);
  const shift = new Map(blocks.map((b) => [b.id, 0]));
  for (const a of blocks) {
    if (a.props?.anchor === 'bottom' || a.props?.fullHeight) continue;
    const e = el(a); if (!e) continue;
    const grow = Math.max(0, e.offsetHeight - a.h);
    const bottom = a.y + a.h - 1;
    for (const b of blocks) {
      if (b === a || b.y < bottom || b.props?.anchor === 'bottom' || b.props?.fullHeight) continue;
      shift.set(b.id, Math.max(shift.get(b.id), shift.get(a.id) + grow));
    }
  }
  let maxBottom = 0;
  for (const b of blocks) {
    const e = el(b); if (!e) continue;
    if (b.props?.anchor === 'bottom' || b.props?.fullHeight) continue;
    const top = b.y + shift.get(b.id);
    e.style.top = top + 'px';
    maxBottom = Math.max(maxBottom, top + e.offsetHeight);
  }
  const anchored = blocks.filter((b) => b.props?.anchor === 'bottom');
  const reserve = anchored.length ? page.h - Math.min(...anchored.map((b) => b.y)) : 40;
  // Round up to whole pages so printing/PDF splits cleanly.
  const needed = maxBottom + reserve;
  const H = needed <= page.h ? page.h : Math.ceil(needed / page.h) * page.h;
  pageEl.style.height = H + 'px';
  for (const b of anchored) { const e = el(b); if (e) e.style.top = (H - (page.h - b.y)) + 'px'; }
  for (const b of blocks.filter((x) => x.props?.fullHeight)) { const e = el(b); if (e) e.style.height = (H - b.y * 2) + 'px'; }
  return H;
}

// Mount a rendered page into a host element, scaled to fit `width`.
export function mountPage(host, ctx, tpl, { width, flow = true } = {}) {
  host.innerHTML = renderPage(ctx, tpl);
  const pageEl = host.querySelector('.bill-page');
  let H = (tpl.page || PAGE).h;
  if (flow) H = flowLayout(pageEl, tpl);
  if (width) {
    const s = width / (tpl.page || PAGE).w;
    host.style.width = width + 'px';
    host.style.height = H * s + 'px';
    pageEl.style.transform = `scale(${s})`;
    pageEl.style.transformOrigin = 'top left';
  }
  return pageEl;
}
