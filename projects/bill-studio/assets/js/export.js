// Print, PDF download and native share for a rendered document.
import { renderPage, flowLayout } from './render.js';
import { PAGE } from './templates.js';
import { downloadBlob, toast } from './ui.js';

function stage(ctx, tpl) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;pointer-events:none;';
  host.innerHTML = renderPage(ctx, tpl);
  document.body.append(host);
  const page = host.querySelector('.bill-page');
  const H = flowLayout(page, tpl);
  return { host, page, H };
}

async function waitImages(el) {
  await Promise.all([...el.querySelectorAll('img')].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  if (document.fonts?.ready) await document.fonts.ready;
}

export async function printDoc(ctx, tpl) {
  const root = document.getElementById('print-root');
  root.innerHTML = renderPage(ctx, tpl);
  const page = root.querySelector('.bill-page');
  root.style.display = 'block';
  flowLayout(page, tpl);
  root.style.display = '';
  await waitImages(root);
  const title = document.title;
  document.title = fileName(ctx).replace(/\.pdf$/, '');
  setTimeout(() => {
    window.print();
    document.title = title;
  }, 60);
}

export function fileName(ctx) {
  const n = (ctx.doc.number || 'bill').replace(/[\\/:*?"<>|]+/g, '-');
  const who = (ctx.doc.customer?.name || '').replace(/[^\w\- ]+/g, '').trim().slice(0, 30);
  return `${n}${who ? ' - ' + who : ''}.pdf`;
}

export async function pdfBlob(ctx, tpl) {
  if (!window.html2canvas || !window.jspdf) throw new Error('PDF engine is still loading — try again in a moment.');
  const { host, page, H } = stage(ctx, tpl);
  try {
    await waitImages(host);
    const canvas = await window.html2canvas(page, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: PAGE.w, height: H, windowWidth: PAGE.w });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const pages = Math.max(1, Math.round(H / PAGE.h));
    const sliceH = canvas.height / pages;
    for (let i = 0; i < pages; i++) {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = Math.round(sliceH);
      c.getContext('2d').drawImage(canvas, 0, -Math.round(i * sliceH));
      if (i) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    }
    pdf.setProperties({ title: ctx.title + ' ' + (ctx.doc.number || ''), creator: 'Bill Studio', author: ctx.business.name });
    return pdf.output('blob');
  } finally { host.remove(); }
}

export async function downloadPdf(ctx, tpl) {
  const blob = await pdfBlob(ctx, tpl);
  downloadBlob(blob, fileName(ctx));
  toast('PDF downloaded');
}

export async function sharePdf(ctx, tpl, text) {
  const blob = await pdfBlob(ctx, tpl);
  const file = new File([blob], fileName(ctx), { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName(ctx), text }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; }
  }
  downloadBlob(blob, fileName(ctx));
  toast('PDF downloaded — attach it to your message');
  return false;
}
