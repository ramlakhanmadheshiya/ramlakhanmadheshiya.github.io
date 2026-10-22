// Paper sizes, multi-up sheets, copies — shared by Print and PDF so both always match.
import { renderPage, flowLayout } from './render.js';
import { PAGE } from './templates.js';
import { esc, modal, toast, downloadBlob } from './ui.js';
import { icon } from './lib/icons.js';
import { getCountry } from './tax/countries.js';
import { state, saveBusiness } from './store.js';

export const MM = 96 / 25.4; // CSS px per millimetre

export const PAPERS = [
  { id: 'a4', label: 'A4 — full page', w: 210, h: 297, group: 'Standard' },
  { id: 'letter', label: 'US Letter (8.5 × 11 in)', w: 215.9, h: 279.4, group: 'Standard' },
  { id: 'legal', label: 'US Legal (8.5 × 14 in)', w: 215.9, h: 355.6, group: 'Standard' },
  { id: 'a5', label: 'A5 — half page, portrait (148 × 210 mm)', w: 148, h: 210, group: 'Half & small', sheet: 2 },
  { id: 'a5l', label: 'A5 — half page, landscape (210 × 148 mm)', w: 210, h: 148, group: 'Half & small', sheet: 2 },
  { id: 'a6', label: 'A6 — quarter page (105 × 148 mm)', w: 105, h: 148, group: 'Half & small', sheet: 4 },
  { id: 'a7', label: 'A7 — one-eighth page (74 × 105 mm)', w: 74, h: 105, group: 'Half & small', sheet: 8 },
  { id: 'halfletter', label: 'Half Letter / Statement (5.5 × 8.5 in)', w: 139.7, h: 215.9, group: 'Half & small', sheet: 2, sheetPaper: 'letter' },
  { id: 'b5', label: 'B5 (176 × 250 mm)', w: 176, h: 250, group: 'Other' },
  { id: 'executive', label: 'Executive (7.25 × 10.5 in)', w: 184.2, h: 266.7, group: 'Other' },
  { id: 'dl', label: 'DL slip (99 × 210 mm)', w: 99, h: 210, group: 'Other', sheet: 3 },
  { id: 't80', label: 'Thermal roll 80 mm', w: 80, h: 0, group: 'Receipt printers', roll: true },
  { id: 't58', label: 'Thermal roll 58 mm', w: 58, h: 0, group: 'Receipt printers', roll: true },
  { id: 't76', label: 'Dot-matrix / POS roll 76 mm', w: 76, h: 0, group: 'Receipt printers', roll: true },
  { id: 'custom', label: 'Custom size…', w: 0, h: 0, group: 'Other' },
];
export const paperById = (id) => PAPERS.find((p) => p.id === id) || PAPERS[0];

// Letter-size countries (North & Central America, Philippines, Chile…).
const LETTER = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV']);
export function defaultPaper(business, tpl) {
  if (business?.printDefaults?.paper) return business.printDefaults.paper;
  if (tpl?.page?.paper) return tpl.page.paper;
  return LETTER.has(business?.country) ? 'letter' : 'a4';
}

export function copyLabelsFor(doc, business, n) {
  const c = getCountry(business.country);
  if (c.gst && business.taxScheme !== 'unregistered') {
    const set = doc.type === 'challan' ? ['Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consignor']
      : ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
    return Array.from({ length: n }, (_, i) => set[i] || `Copy ${i + 1}`);
  }
  return Array.from({ length: n }, (_, i) => (n === 1 ? doc.copyLabel || '' : i === 0 ? 'Original' : `Copy ${i}`));
}

const waitImages = async (el) => {
  await Promise.all([...el.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  if (document.fonts?.ready) await document.fonts.ready;
};

// Render one copy of the bill into slots of the bill size; returns DOM nodes (one per page of that bill).
function renderBillPages(ctx, tpl, billW, billH, mount) {
  const pages = [];
  if (tpl.kind === 'flow') {
    // Receipts are laid out natively at the paper width (crisp text), and run as long as needed.
    const host = document.createElement('div');
    host.innerHTML = renderPage(ctx, tpl, { width: Math.round(billW * MM) });
    mount.append(host);
    const el = host.firstElementChild;
    const contentH = el.scrollHeight;
    host.remove();
    if (!billH) return [{ el, heightPx: contentH }];
    const ph = billH * MM;
    const n = Math.max(1, Math.ceil(contentH / ph));
    for (let i = 0; i < n; i++) pages.push({ el: el.cloneNode(true), offset: i * ph, heightPx: ph, scale: 1 });
    return pages;
  }
  const designW = (tpl.page || PAGE).w;
  const s = (billW * MM) / designW;
  const host = document.createElement('div');
  host.style.width = designW + 'px';
  host.innerHTML = renderPage(ctx, tpl);
  mount.append(host);
  const pageEl = host.firstElementChild;
  // Paginate at the target paper's height (in design px).
  const targetPageH = billH ? (billH * MM) / s : (tpl.page || PAGE).h;
  const H = flowLayout(pageEl, tpl, targetPageH);
  host.remove();
  const n = billH ? Math.max(1, Math.round(H / targetPageH)) : 1;
  const heightPx = billH ? billH * MM : H * s;
  for (let i = 0; i < n; i++) pages.push({ el: pageEl.cloneNode(true), offset: i * targetPageH, scale: s, heightPx });
  return pages;
}

// Build physical sheets: [{ wMm, hMm, slots: [{ x, y, w, h (px), page }] }]
export function buildSheets(ctxFor, tpl, opts, mount) {
  const paper = opts.paper === 'custom' ? { id: 'custom', w: opts.customW, h: opts.customH } : paperById(opts.paper);
  const copies = Math.max(1, Math.min(10, opts.copies || 1));
  const labels = opts.labels || [];
  // Every copy is a list of pages of the bill size.
  const all = [];
  for (let i = 0; i < copies; i++) all.push(...renderBillPages(ctxFor(labels[i] ?? ''), tpl, paper.w, paper.roll ? 0 : paper.h, mount));
  const sheets = [];
  if (opts.multiUp && paper.sheet && !paper.roll) {
    const sheetPaper = paperById(paper.sheetPaper || 'a4');
    const portrait = sheetPaper.w <= sheetPaper.h;
    // Arrange as many bill pages as fit on the sheet in a grid.
    const fit = (W, H) => ({ cols: Math.floor((W + 0.01) / paper.w), rows: Math.floor((H + 0.01) / paper.h) });
    let g = fit(sheetPaper.w, sheetPaper.h), sw = sheetPaper.w, sh = sheetPaper.h;
    const g2 = fit(sheetPaper.h, sheetPaper.w);
    if (g2.cols * g2.rows > g.cols * g.rows) { g = g2; sw = sheetPaper.h; sh = sheetPaper.w; }
    const per = Math.max(1, g.cols * g.rows);
    for (let i = 0; i < all.length; i += per) {
      const slots = all.slice(i, i + per).map((pg, j) => ({ x: (j % g.cols) * paper.w * MM, y: Math.floor(j / g.cols) * paper.h * MM, w: paper.w * MM, h: paper.h * MM, page: pg }));
      sheets.push({ wMm: sw, hMm: sh, slots, cut: true, cols: g.cols, rows: g.rows, portrait });
    }
  } else {
    for (const pg of all) {
      const hMm = paper.roll ? pg.heightPx / MM + 2 : paper.h;
      sheets.push({ wMm: paper.w, hMm, slots: [{ x: 0, y: 0, w: paper.w * MM, h: hMm * MM, page: pg }] });
    }
  }
  return sheets;
}

export function sheetsHtml(sheets) {
  return sheets.map((sh) => `<div class="print-sheet" style="position:relative;width:${sh.wMm}mm;height:${sh.hMm}mm;overflow:hidden;background:#fff;break-after:page;page-break-after:always">
    ${sh.slots.map((sl, i) => `<div class="print-slot" data-slot="${i}" style="position:absolute;left:${sl.x}px;top:${sl.y}px;width:${sl.w}px;height:${sl.h}px;overflow:hidden"></div>`).join('')}
    ${sh.cut ? cutLines(sh) : ''}</div>`).join('');
}
function cutLines(sh) {
  let h = '';
  const sw = sh.slots[0].w, shh = sh.slots[0].h;
  for (let c = 1; c < sh.cols; c++) h += `<div style="position:absolute;left:${c * sw}px;top:0;bottom:0;border-left:1px dashed #b0b0b0"></div>`;
  for (let r = 1; r < sh.rows; r++) h += `<div style="position:absolute;top:${r * shh}px;left:0;right:0;border-top:1px dashed #b0b0b0"></div>`;
  return h;
}
export function fillSlots(container, sheets) {
  container.querySelectorAll('.print-sheet').forEach((sheetEl, si) => {
    sheetEl.querySelectorAll('.print-slot').forEach((slotEl, i) => {
      const pg = sheets[si].slots[i].page;
      const el = pg.el;
      el.style.position = 'absolute'; el.style.left = '0';
      el.style.top = `${-(pg.offset || 0) * (pg.scale || 1)}px`;
      if (pg.scale && pg.scale !== 1) { el.style.transformOrigin = 'top left'; el.style.transform = `scale(${pg.scale})`; }
      el.style.boxShadow = 'none';
      slotEl.append(el);
    });
  });
}

function pageCss(sheets) {
  const f = sheets[0];
  return `@page { size: ${f.wMm}mm ${f.hMm}mm; margin: 0 }`;
}

export function fileName(ctx) {
  const n = (ctx.doc.number || 'bill').replace(/[\\/:*?"<>|]+/g, '-');
  const who = (ctx.doc.customer?.name || '').replace(/[^\w\- ]+/g, '').trim().slice(0, 30);
  return `${n}${who ? ' - ' + who : ''}.pdf`;
}

export async function printSheets(sheets, title) {
  const root = document.getElementById('print-root');
  root.innerHTML = sheetsHtml(sheets);
  fillSlots(root, sheets);
  let st = document.getElementById('print-page-css');
  if (!st) { st = document.createElement('style'); st.id = 'print-page-css'; document.head.append(st); }
  st.textContent = pageCss(sheets);
  await waitImages(root);
  const prev = document.title;
  document.title = title;
  await new Promise((r) => setTimeout(r, 80));
  window.print();
  document.title = prev;
}

export async function pdfFromSheets(sheets, meta = {}) {
  if (!window.html2canvas || !window.jspdf) throw new Error('PDF engine is still loading — try again in a moment.');
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none';
  stage.innerHTML = sheetsHtml(sheets);
  document.body.append(stage);
  try {
    fillSlots(stage, sheets);
    await waitImages(stage);
    const { jsPDF } = window.jspdf;
    let pdf;
    const els = [...stage.querySelectorAll('.print-sheet')];
    for (let i = 0; i < els.length; i++) {
      const sh = sheets[i];
      const canvas = await window.html2canvas(els[i], { scale: sh.wMm < 100 ? 3 : 2, backgroundColor: '#ffffff', logging: false });
      const orientation = sh.wMm > sh.hMm ? 'landscape' : 'portrait';
      if (!pdf) pdf = new jsPDF({ unit: 'mm', format: [sh.wMm, sh.hMm], orientation, compress: true });
      else pdf.addPage([sh.wMm, sh.hMm], orientation);
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, sh.wMm, sh.hMm, undefined, 'FAST');
    }
    pdf.setProperties({ title: meta.title || 'Bill', creator: 'Bill Studio', author: meta.author || '' });
    return pdf.output('blob');
  } finally { stage.remove(); }
}

// ---------- Print / PDF dialog ----------
// ctxFor(copyLabel) -> render context; templates: list; tpl: current template
export function printDialog({ ctxFor, doc, business, templates, tpl, mode = 'print', shareText, onTemplate }) {
  const pd = business.printDefaults || {};
  const opts = {
    paper: defaultPaper(business, tpl), multiUp: !!pd.multiUp, copies: pd.copies || 1, customW: pd.customW || 100, customH: pd.customH || 150,
    tplId: tpl.id,
  };
  const groups = [...new Set(PAPERS.map((p) => p.group))];
  const m = modal({
    title: mode === 'pdf' ? 'Download PDF' : mode === 'share' ? 'Share PDF' : 'Print',
    wide: true,
    body: `<div class="print-dlg">
      <div class="form-grid">
        <div class="field span2"><label>Bill size</label><select class="input" data-o="paper">${groups.map((g) => `<optgroup label="${esc(g)}">${PAPERS.filter((p) => p.group === g).map((p) => `<option value="${p.id}" ${p.id === opts.paper ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}</select></div>
        <div class="field" data-custom hidden><label>Width (mm)</label><input class="input" type="number" min="40" max="500" data-o="customW" value="${opts.customW}"></div>
        <div class="field" data-custom hidden><label>Height (mm)</label><input class="input" type="number" min="40" max="1000" data-o="customH" value="${opts.customH}"></div>
        <div class="field span2" data-multi hidden><label class="check" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-o="multiUp" ${opts.multiUp ? 'checked' : ''}> <span data-multi-text></span></label></div>
        <div class="field"><label>Copies</label><select class="input" data-o="copies">${[1, 2, 3, 4, 6, 8].map((n) => `<option ${n === opts.copies ? 'selected' : ''}>${n}</option>`).join('')}</select><div class="help" data-copy-help></div></div>
        <div class="field"><label>Design</label><select class="input" data-o="tplId">${templates.map((t) => `<option value="${t.id}" ${t.id === opts.tplId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><div class="help" data-tpl-help></div></div>
        <label class="field span2" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" data-remember> <span class="small">Remember these settings for next time</span></label>
      </div>
      <div class="section-title" style="margin:16px 0 8px">Preview</div>
      <div class="paper-stage" style="max-height:52vh;overflow:auto"><div data-prev style="display:flex;flex-direction:column;gap:14px;align-items:center"></div></div>
    </div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${icon(mode === 'print' ? 'printer' : mode === 'share' ? 'share-2' : 'download', 16)} ${mode === 'print' ? 'Print' : mode === 'share' ? 'Share' : 'Download PDF'}</button>`,
  });
  const el = m.el;
  let current = tpl;
  let sheets = [];
  const tplFor = () => templates.find((t) => t.id === opts.tplId) || tpl;
  let userPicked = false;
  // Best design for the paper's shape, unless the user chose one in this dialog.
  const autoPick = () => {
    if (userPicked) return;
    const p = opts.paper === 'custom' ? { w: opts.customW, h: opts.customH } : paperById(opts.paper);
    const want = p.roll || (p.w && p.w < 120) ? (templates.find((t) => t.kind === 'flow' && !t.builtin) || templates.find((t) => t.id === 'tpl-receipt'))
      : p.w > p.h ? (templates.find((t) => !t.builtin && t.basedOn === 'tpl-half') || templates.find((t) => t.id === 'tpl-half'))
      : (tpl.kind === 'flow' || tpl.id === 'tpl-half' ? templates.find((t) => t.id === defaultFullId) : tpl);
    if (want && want.id !== opts.tplId) { opts.tplId = want.id; el.querySelector('[data-o=tplId]').value = want.id; }
  };
  const defaultFullId = (tpl.kind !== 'flow' && tpl.id !== 'tpl-half') ? tpl.id : (business.country === 'IN' ? 'tpl-classic' : 'tpl-cupertino');
  const read = () => {
    el.querySelectorAll('[data-o]').forEach((i) => { const k = i.dataset.o; opts[k] = i.type === 'checkbox' ? i.checked : ['copies', 'customW', 'customH'].includes(k) ? Number(i.value) : i.value; });
  };
  const draw = () => {
    read();
    current = tplFor();
    const p = opts.paper === 'custom' ? { w: opts.customW, h: opts.customH } : paperById(opts.paper);
    el.querySelectorAll('[data-custom]').forEach((x) => (x.hidden = opts.paper !== 'custom'));
    const mu = el.querySelector('[data-multi]');
    mu.hidden = !p.sheet;
    if (p.sheet) el.querySelector('[data-multi-text]').textContent = `Print ${p.sheet} per ${(paperById(p.sheetPaper || 'a4').label.split(' ')[0])} sheet (with cut lines) — fill the sheet with copies`;
    const labels = copyLabelsFor(doc, business, opts.copies);
    el.querySelector('[data-copy-help]').textContent = opts.copies > 1 ? labels.join(' · ') : '';
    const small = (p.w || 0) < 120;
    el.querySelector('[data-tpl-help]').textContent = small && current.kind !== 'flow' ? 'Tip: “Compact receipt” reads best on small paper.' : current.kind === 'flow' && !small ? 'Tip: full-page designs suit large paper better.' : '';
    if (opts.multiUp && p.sheet && opts.copies < p.sheet && !el.dataset.autofill) { opts.copies = p.sheet; el.querySelector('[data-o=copies]').value = String([1, 2, 3, 4, 6, 8].find((n) => n >= p.sheet) || 8); opts.copies = Number(el.querySelector('[data-o=copies]').value); el.dataset.autofill = '1'; }
    const ctxFor2 = (label) => ctxFor(label);
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-20000px;top:0';
    document.body.append(mount);
    try { sheets = buildSheets(ctxFor2, current, { ...opts, labels: copyLabelsFor(doc, business, opts.copies) }, mount); } finally { mount.remove(); }
    // Preview: scaled sheets
    const prev = el.querySelector('[data-prev]');
    const maxW = Math.min(520, prev.parentElement.clientWidth - 40);
    prev.innerHTML = '';
    sheets.slice(0, 6).forEach((sh, i) => {
      const wPx = sh.wMm * MM, hPx = sh.hMm * MM, k = Math.min(1, maxW / wPx);
      const wrap = document.createElement('div');
      wrap.style.cssText = `width:${wPx * k}px;height:${hPx * k}px;flex:none;box-shadow:0 4px 18px rgba(0,0,0,.14);background:#fff;overflow:hidden`;
      const inner = document.createElement('div');
      inner.style.cssText = `transform:scale(${k});transform-origin:top left;width:${wPx}px`;
      inner.innerHTML = sheetsHtml([sh]);
      // Clone pages for preview so the real ones stay intact for printing.
      const clone = { ...sh, slots: sh.slots.map((sl) => ({ ...sl, page: { ...sl.page, el: sl.page.el.cloneNode(true) } })) };
      fillSlots(inner, [clone]);
      wrap.append(inner);
      prev.append(wrap);
      if (i === 5 && sheets.length > 6) prev.insertAdjacentHTML('beforeend', `<div class="small muted">+ ${sheets.length - 6} more pages</div>`);
    });
    prev.insertAdjacentHTML('afterbegin', `<div class="small muted">${sheets.length} page${sheets.length === 1 ? '' : 's'} · ${sheets[0] ? `${round1(sheets[0].wMm)} × ${round1(sheets[0].hMm)} mm` : ''}</div>`);
  };
  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-o]')) return;
    if (e.target.dataset.o === 'tplId') userPicked = true;
    if (e.target.dataset.o === 'paper' || e.target.dataset.o.startsWith('custom')) { delete el.dataset.autofill; read(); autoPick(); }
    draw();
  });
  setTimeout(() => { read(); autoPick(); draw(); }, 30);
  el.querySelector('[data-go]').addEventListener('click', async () => {
    const btn = el.querySelector('[data-go]');
    btn.disabled = true;
    try {
      read();
      if (opts.paper === 'custom' && (!(opts.customW >= 40) || !(opts.customH >= 40))) { toast('Enter a custom size of at least 40 × 40 mm', 'err'); return; }
      if (el.querySelector('[data-remember]').checked) {
        await saveBusiness({ ...state.business, printDefaults: { paper: opts.paper, multiUp: opts.multiUp, copies: opts.copies, customW: opts.customW, customH: opts.customH } }, { quiet: true });
      }
      if (opts.tplId !== tpl.id) onTemplate?.(opts.tplId);
      const name = fileName(ctxFor(''));
      if (mode === 'print') { m.close('printed'); await printSheets(sheets, name.replace(/\.pdf$/, '')); return; }
      const blob = await pdfFromSheets(sheets, { title: name.replace(/\.pdf$/, ''), author: business.name });
      if (mode === 'share') {
        const file = new File([blob], name, { type: 'application/pdf' });
        if (navigator.canShare?.({ files: [file] })) {
          try { await navigator.share({ files: [file], title: name, text: shareText }); m.close('shared'); return; } catch (e2) { if (e2.name === 'AbortError') return; }
        }
      }
      downloadBlob(blob, name);
      toast(mode === 'share' ? 'PDF downloaded — attach it to your message' : 'PDF downloaded');
      m.close('pdf');
    } catch (err) { toast(err.message || 'Could not create the file', 'err'); console.error(err); } finally { btn.disabled = false; }
  });
  return m.done;
}
const round1 = (v) => Math.round(v * 10) / 10;
