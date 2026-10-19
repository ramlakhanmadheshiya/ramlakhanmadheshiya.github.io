// Renders tabular reports (statements, GST/VAT summaries, sales registers) to a clean A4 PDF.
import { esc, downloadBlob, toast, safeImg } from './ui.js';
import { fmtMoney } from './lib/money.js';
import { fmtDate, todayISO } from './lib/dates.js';
import { getCountry } from './tax/countries.js';

const W = 794, H = 1123;

function reportHtml({ title, subtitle, summary = [], sections = [] }, b) {
  const c = getCountry(b.country);
  return `<div style="width:${W}px;padding:48px;background:#fff;color:#1d1d1f;font:12px/1.45 -apple-system,BlinkMacSystemFont,'InterVar','Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:1.5px solid #1d1d1f;padding-bottom:16px">
      <div style="display:flex;gap:14px;align-items:center">${b.logo ? `<img src="${safeImg(b.logo)}" style="width:54px;height:54px;object-fit:contain">` : ''}
        <div><div style="font-size:18px;font-weight:700;letter-spacing:-.02em">${esc(b.name)}</div><div style="color:#6e6e73">${esc([b.address, b.city].filter(Boolean).join(', '))}</div>${b.taxId ? `<div style="font-weight:600">${esc(c.taxIdLabel)}: ${esc(b.taxId)}</div>` : ''}</div></div>
      <div style="text-align:right"><div style="font-size:22px;font-weight:600;letter-spacing:-.02em">${esc(title)}</div><div style="color:#6e6e73">${esc(subtitle || '')}</div><div style="color:#86868b;font-size:10px;margin-top:4px">Generated ${esc(fmtDate(todayISO(), b.locale))}</div></div>
    </div>
    ${summary.length ? `<div style="display:flex;gap:10px;margin:18px 0 6px;flex-wrap:wrap">${summary.map(([k, v]) => `<div style="flex:1;min-width:140px;background:#f5f5f7;border-radius:10px;padding:10px 12px"><div style="color:#6e6e73;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${esc(k)}</div><div style="font-size:16px;font-weight:700;margin-top:2px">${esc(v)}</div></div>`).join('')}</div>` : ''}
    ${sections.map((s) => `<div style="margin-top:22px">${s.heading ? `<div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(s.heading)}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">
        <thead><tr>${s.columns.map((h, i) => `<th style="text-align:${s.align?.[i] || 'left'};padding:6px 6px;border-bottom:1.5px solid #1d1d1f;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#6e6e73">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.map((r) => `<tr>${r.map((v, i) => `<td style="text-align:${s.align?.[i] || 'left'};padding:6px;border-bottom:1px solid #e8e8ed">${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${s.columns.length}" style="padding:14px;text-align:center;color:#86868b">No data</td></tr>`}</tbody>
        ${s.foot ? `<tfoot><tr>${s.foot.map((v, i) => `<td style="text-align:${s.align?.[i] || 'left'};padding:7px 6px;font-weight:700;border-top:1.5px solid #1d1d1f">${esc(v)}</td>`).join('')}</tr></tfoot>` : ''}
      </table></div>`).join('')}
    <div style="margin-top:28px;color:#86868b;font-size:10px;text-align:center">Prepared with Bill Studio · figures are computed from the records stored on this device</div>
  </div>`;
}

export async function reportPdf(report, b, filename) {
  if (!window.html2canvas || !window.jspdf) { toast('PDF engine is still loading — try again', 'err'); return; }
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px`;
  host.innerHTML = reportHtml(report, b);
  document.body.append(host);
  try {
    const el = host.firstElementChild;
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', logging: false, windowWidth: W });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const pagePx = Math.round(canvas.width * (H / W));
    const pages = Math.max(1, Math.ceil(canvas.height / pagePx));
    for (let i = 0; i < pages; i++) {
      const cv = document.createElement('canvas');
      cv.width = canvas.width; cv.height = pagePx;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(canvas, 0, -i * pagePx);
      if (i) pdf.addPage();
      pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    }
    downloadBlob(pdf.output('blob'), filename);
    toast('PDF downloaded');
  } finally { host.remove(); }
}

export function downloadStatementPdf(customer, ledger, b) {
  const m = (v) => fmtMoney(v, b.currency, b.locale);
  const debit = ledger.rows.reduce((s, r) => s + r.debit, 0), credit = ledger.rows.reduce((s, r) => s + r.credit, 0);
  return reportPdf({
    title: 'Statement of Account', subtitle: customer.name,
    summary: [['Total billed', m(debit)], ['Total received', m(credit)], [ledger.balance >= 0 ? 'Balance due' : 'Credit balance', m(Math.abs(ledger.balance))]],
    sections: [{ columns: ['Date', 'Particulars', 'Ref.', 'Debit', 'Credit', 'Balance'], align: ['left', 'left', 'left', 'right', 'right', 'right'],
      rows: ledger.rows.map((r) => [fmtDate(r.date, b.locale), r.kind, r.ref, r.debit ? m(r.debit) : '', r.credit ? m(r.credit) : '', m(r.balance)]),
      foot: ['', 'Closing balance', '', m(debit), m(credit), m(ledger.balance)] }],
  }, b, `Statement - ${customer.name.replace(/[^\w\- ]+/g, '')}.pdf`);
}
