import { icon } from '../lib/icons.js';
import { esc, toast, menu, debounce, imageToDataURL, pickFile, confirmDialog } from '../ui.js';
import { db, uid } from '../db.js';
import { state, DOC_TYPE_LIST } from '../store.js';
import { BLOCK_TYPES, FONTS, PAGE, newBlock, builtinById } from '../templates.js';
import { renderPage, sampleContext, flowLayout } from '../render.js';

const SNAP = 4, GUIDE_T = 5;
const COLS = [['idx', '#'], ['desc', 'Item description'], ['hsn', 'HSN / code'], ['qty', 'Quantity'], ['rate', 'Rate'], ['disc', 'Discount'], ['tax', 'Tax %'], ['taxamt', 'Tax amount']];

export async function render(root, { id }) {
  const b = state.business;
  let tpl = await db.get('templates', id);
  if (!tpl) { root.innerHTML = `<div class="page"><div class="empty"><h3>Design not found</h3><a class="btn" href="#/templates">Back to templates</a></div></div>`; return; }
  let sel = null, zoom = 1, showGrid = false, snapOn = true, preview = false, docType = 'invoice';
  const undo = [], redo = [];
  const snapshot = () => JSON.stringify({ blocks: tpl.blocks, accent: tpl.accent, font: tpl.font, page: tpl.page });
  let last = snapshot();
  let saveState = 'saved';

  root.innerHTML = `<div class="designer">
    <div class="designer-bar">
      <a class="btn icon sm ghost" href="#/templates" aria-label="Back">${icon('chevron-left', 18)}</a>
      <input class="title-input" data-name value="${esc(tpl.name)}" aria-label="Design name">
      <span class="tiny muted desktop-only" data-save-state>All changes saved</span>
      <div style="flex:1"></div>
      <button class="btn icon sm ghost mobile-only" data-add-mobile aria-label="Add block">${icon('plus', 18)}</button>
      <button class="btn icon sm ghost" data-undo title="Undo (⌘Z)" aria-label="Undo">${icon('undo-2', 17)}</button>
      <button class="btn icon sm ghost" data-redo title="Redo (⇧⌘Z)" aria-label="Redo">${icon('redo-2', 17)}</button>
      <span class="sep desktop-only"></span>
      <button class="btn icon sm ghost desktop-only" data-zoom-out aria-label="Zoom out">${icon('zoom-out', 17)}</button>
      <span class="small tnum desktop-only" data-zoom-label style="min-width:42px;text-align:center"></span>
      <button class="btn icon sm ghost desktop-only" data-zoom-in aria-label="Zoom in">${icon('zoom-in', 17)}</button>
      <button class="btn icon sm ghost desktop-only" data-grid title="Grid" aria-label="Toggle grid">${icon('grid-3x3', 17)}</button>
      <span class="sep desktop-only"></span>
      <button class="btn sm" data-preview>${icon('eye', 15)} <span class="desktop-only">Preview</span></button>
      <button class="btn sm primary" data-done>${icon('check', 15)} Done</button>
    </div>
    <div class="designer-body">
      <div class="d-panel d-left">
        <h4>Add to page</h4>
        <div class="palette">${Object.entries(BLOCK_TYPES).map(([k, v]) => `<button data-add="${k}" title="Add ${esc(v.label)}">${icon(v.icon, 18)}<span>${esc(v.label)}</span></button>`).join('')}</div>
        <h4>Layers</h4>
        <div class="layers" data-layers></div>
      </div>
      <div class="canvas-wrap" data-wrap><div data-canvas-holder style="position:relative;flex:none"></div></div>
      <div class="d-panel d-right insp" data-insp></div>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const wrap = $('[data-wrap]');
  const holder = $('[data-canvas-holder]');

  const fitZoom = () => { zoom = Math.max(0.3, Math.min(1.25, (wrap.clientWidth - 60) / PAGE.w)); };
  fitZoom();

  const persist = debounce(async () => {
    await db.put('templates', tpl);
    saveState = 'saved'; $('[data-save-state]').textContent = 'All changes saved';
  }, 600);

  function commit() {
    const now = snapshot();
    if (now === last) return;
    undo.push(last); if (undo.length > 100) undo.shift();
    redo.length = 0; last = now;
    saveState = 'saving'; $('[data-save-state]').textContent = 'Saving…';
    persist();
  }
  function restore(s) { const o = JSON.parse(s); Object.assign(tpl, o); last = s; if (sel && !tpl.blocks.find((x) => x.id === sel)) sel = null; persist(); draw(); }

  const blk = (bid) => tpl.blocks.find((x) => x.id === bid);

  // ---------- Canvas ----------
  function drawCanvas() {
    const ctx = sampleContext(b, docType);
    holder.innerHTML = renderPage(ctx, tpl, { editing: !preview });
    const page = holder.querySelector('.bill-page');
    let H = PAGE.h;
    if (preview) H = flowLayout(page, tpl);
    page.classList.toggle('grid-on', showGrid && !preview);
    if (showGrid && !preview) page.style.backgroundImage = 'linear-gradient(rgba(0,113,227,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(0,113,227,.07) 1px,transparent 1px)', page.style.backgroundSize = '8px 8px';
    page.style.transform = `scale(${zoom})`; page.style.transformOrigin = 'top left';
    page.style.boxShadow = '0 10px 40px rgba(0,0,0,.14)';
    holder.style.width = PAGE.w * zoom + 'px'; holder.style.height = H * zoom + 'px';
    $('[data-zoom-label]').textContent = Math.round(zoom * 100) + '%';
    if (preview) return;
    page.querySelectorAll('.blk').forEach((el) => {
      const x = blk(el.dataset.id); if (!x) return;
      el.classList.add('blk-frame');
      el.style.height = x.h + 'px'; el.style.minHeight = '';
      if (x.locked) el.classList.add('locked');
      if (x.id === sel) el.classList.add('sel');
      if (x.type === 'line' && x.h < 6) { el.style.outlineOffset = '3px'; }
      el.insertAdjacentHTML('beforeend', `<span class="blk-tag">${esc(BLOCK_TYPES[x.type]?.label || x.type)}${x.locked ? ' · locked' : ''}</span>` +
        (x.locked ? '' : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="handle ${h}" data-h="${h}"></span>`).join('')));
    });
  }

  // ---------- Pointer interactions ----------
  let drag = null;
  holder.addEventListener('pointerdown', (e) => {
    if (preview) return;
    const el = e.target.closest('.blk-frame');
    if (!el) { if (e.target.closest('.bill-page')) { sel = null; draw(); } return; }
    const x = blk(el.dataset.id);
    if (sel !== x.id) { sel = x.id; draw(); }
    if (x.locked) return;
    e.preventDefault();
    const handle = e.target.closest('[data-h]')?.dataset.h || null;
    const frame = holder.querySelector(`[data-id="${x.id}"]`);
    drag = { id: x.id, handle, sx: e.clientX, sy: e.clientY, ox: x.x, oy: x.y, ow: x.w, oh: x.h, el: frame, moved: false };
    try { frame.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  function guidesFor(x, rect) {
    // Snap candidate lines: page edges/centre, margins, and other blocks' edges/centres.
    const vs = [0, 48, PAGE.w / 2, PAGE.w - 48, PAGE.w], hs = [0, 48, PAGE.h / 2, PAGE.h - 48, PAGE.h];
    for (const o of tpl.blocks) {
      if (o.id === x.id || o.hidden) continue;
      vs.push(o.x, o.x + o.w / 2, o.x + o.w); hs.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    const out = { dx: 0, dy: 0, gv: null, gh: null };
    const myV = drag.handle ? [drag.handle.includes('w') ? rect.x : null, drag.handle.includes('e') ? rect.x + rect.w : null].filter((v) => v != null) : [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
    const myH = drag.handle ? [drag.handle.includes('n') ? rect.y : null, drag.handle.includes('s') ? rect.y + rect.h : null].filter((v) => v != null) : [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
    let best = GUIDE_T + 1;
    for (const m of myV) for (const v of vs) { const d = v - m; if (Math.abs(d) < best) { best = Math.abs(d); out.dx = d; out.gv = v; } }
    best = GUIDE_T + 1;
    for (const m of myH) for (const h of hs) { const d = h - m; if (Math.abs(d) < best) { best = Math.abs(d); out.dy = d; out.gh = h; } }
    return out;
  }

  function onMove(e) {
    if (!drag) return;
    const x = blk(drag.id); if (!x) return;
    const dx = (e.clientX - drag.sx) / zoom, dy = (e.clientY - drag.sy) / zoom;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    const r = { x: drag.ox, y: drag.oy, w: drag.ow, h: drag.oh };
    const h = drag.handle;
    if (!h) { r.x += dx; r.y += dy; }
    else {
      if (h.includes('e')) r.w = Math.max(8, drag.ow + dx);
      if (h.includes('s')) r.h = Math.max(1, drag.oh + dy);
      if (h.includes('w')) { r.w = Math.max(8, drag.ow - dx); r.x = drag.ox + drag.ow - r.w; }
      if (h.includes('n')) { r.h = Math.max(1, drag.oh - dy); r.y = drag.oy + drag.oh - r.h; }
    }
    if (snapOn && !e.altKey) {
      r.x = Math.round(r.x / SNAP) * SNAP; r.y = Math.round(r.y / SNAP) * SNAP;
      if (h) { r.w = Math.round(r.w / SNAP) * SNAP || r.w; r.h = Math.max(1, Math.round(r.h / SNAP) * SNAP || r.h); }
      const g = guidesFor(x, r);
      if (!h) { r.x += g.dx; r.y += g.dy; }
      else {
        if (h.includes('e')) r.w += g.dx; if (h.includes('w')) { r.x += g.dx; r.w -= g.dx; }
        if (h.includes('s')) r.h += g.dy; if (h.includes('n')) { r.y += g.dy; r.h -= g.dy; }
      }
      showGuides(g.gv, g.gh);
    }
    Object.assign(x, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    Object.assign(drag.el.style, { left: x.x + 'px', top: x.y + 'px', width: x.w + 'px', height: x.h + 'px' });
    drawInspectorGeometry();
  }
  function onUp() {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    showGuides(null, null);
    if (moved) { commit(); draw(); }
  }
  function showGuides(v, h) {
    holder.querySelectorAll('.guide').forEach((g) => g.remove());
    const page = holder.querySelector('.bill-page'); if (!page) return;
    if (v != null) page.insertAdjacentHTML('beforeend', `<div class="guide v" style="left:${v}px"></div>`);
    if (h != null) page.insertAdjacentHTML('beforeend', `<div class="guide h" style="top:${h}px"></div>`);
  }
  holder.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.blk-frame'); if (!el) return;
    const x = blk(el.dataset.id);
    if (x.type === 'text') setTimeout(() => $('[data-prop="text"]')?.focus(), 30);
    if (x.type === 'image') chooseImage(x);
    if (x.type === 'logo') location.hash = '#/business';
  });

  // ---------- Layers ----------
  function drawLayers() {
    const ordered = tpl.blocks.slice().sort((a, x) => (x.z || 0) - (a.z || 0));
    $('[data-layers]').innerHTML = ordered.map((x) => `<div class="layer ${x.id === sel ? 'on' : ''}" data-l="${x.id}">
      ${icon(BLOCK_TYPES[x.type]?.icon || 'square', 14)}<span class="nm" style="${x.hidden ? 'opacity:.45;text-decoration:line-through' : ''}">${esc(x.name || BLOCK_TYPES[x.type]?.label || x.type)}</span>
      <button data-vis="${x.id}" title="${x.hidden ? 'Show' : 'Hide'}" aria-label="Toggle visibility">${icon(x.hidden ? 'eye-off' : 'eye', 13)}</button>
      <button data-lock="${x.id}" title="${x.locked ? 'Unlock' : 'Lock'}" aria-label="Toggle lock" style="${x.locked ? 'opacity:1' : ''}">${icon('lock', 13)}</button></div>`).join('') || '<div class="tiny muted">Empty page — add blocks above.</div>';
  }
  $('[data-layers]').addEventListener('click', (e) => {
    const vis = e.target.closest('[data-vis]'), lock = e.target.closest('[data-lock]'), l = e.target.closest('[data-l]');
    if (vis) { const x = blk(vis.dataset.vis); x.hidden = !x.hidden; commit(); draw(); return; }
    if (lock) { const x = blk(lock.dataset.lock); x.locked = !x.locked; commit(); draw(); return; }
    if (l) { sel = l.dataset.l; draw(); }
  });

  // ---------- Inspector ----------
  const num = (v, d = 0) => (v === '' || v == null || isNaN(v) ? d : Number(v));
  const colorVal = (c) => (c === 'accent' ? tpl.accent : c && c !== 'transparent' ? c : '#ffffff');

  function drawInspector() {
    const insp = $('[data-insp]');
    const x = sel && blk(sel);
    if (!x) {
      insp.innerHTML = `<h4>Design</h4>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label>Brand colour</label><input type="color" class="color-input" data-page="accent" value="${esc(tpl.accent)}"></div>
          <div class="field"><label>Paper</label><input type="color" class="color-input" data-page="bg" value="${esc(tpl.page?.bg || '#ffffff')}"></div>
          <div class="field span2"><label>Font</label><select class="input" data-page="font">${Object.entries(FONTS).map(([k, v]) => `<option value="${k}" ${k === tpl.font ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
          <div class="field span2"><label>Description</label><input class="input" data-page="description" value="${esc(tpl.description || '')}"></div>
          <div class="field span2"><label>Preview as</label><select class="input" data-doctype>${DOC_TYPE_LIST.map((t) => `<option value="${t.key}" ${t.key === docType ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
        </div>
        <div class="flex wrap mt" style="gap:6px">${['#0071e3', '#1d1d1f', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#5e2ca5', '#1d3a8a', '#a67c37', '#008080'].map((c) => `<button data-swatch="${c}" title="${c}" style="width:24px;height:24px;border-radius:50%;border:2px solid ${c === tpl.accent ? 'var(--text)' : 'transparent'};background:${c};cursor:pointer;box-shadow:inset 0 0 0 2px #fff"></button>`).join('')}</div>
        <h4 class="mt">Tips</h4>
        <div class="small muted" style="line-height:1.7">Drag blocks to move them. Pull the handles to resize.<br>
          <span class="kbd">←↑→↓</span> nudge · <span class="kbd">⇧</span> ×10<br><span class="kbd">⌘D</span> duplicate · <span class="kbd">⌫</span> delete<br><span class="kbd">⌘Z</span> undo · hold <span class="kbd">⌥</span> to move freely<br>
          Blocks below the items table move down automatically when a bill has many items.</div>
        <div class="btn-row mt"><button class="btn sm danger" data-reset>${icon('rotate-ccw', 14)} Reset to original</button></div>`;
      insp.querySelectorAll('[data-page]').forEach((el) => el.addEventListener('input', () => {
        const k = el.dataset.page;
        if (k === 'bg') tpl.page = { ...(tpl.page || PAGE), bg: el.value };
        else tpl[k] = el.value;
        drawCanvas();
      }));
      insp.querySelectorAll('[data-page]').forEach((el) => el.addEventListener('change', () => { commit(); if (el.dataset.page === 'accent') drawInspector(); }));
      insp.querySelectorAll('[data-swatch]').forEach((el) => el.addEventListener('click', () => { tpl.accent = el.dataset.swatch; commit(); draw(); }));
      insp.querySelector('[data-doctype]').addEventListener('change', (e) => { docType = e.target.value; drawCanvas(); });
      insp.querySelector('[data-reset]').addEventListener('click', async () => {
        const base = builtinById(tpl.basedOn);
        if (!base) { toast('This design has no original to reset to', 'err'); return; }
        if (!(await confirmDialog('Reset design?', `All your changes will be replaced by the original “${base.name}” layout.`, { ok: 'Reset', danger: true }))) return;
        const c = JSON.parse(JSON.stringify(base));
        tpl.blocks = c.blocks.map((bb) => ({ ...bb, id: uid('b_') })); tpl.accent = c.accent; tpl.font = c.font; tpl.page = c.page;
        commit(); draw();
      });
      return;
    }
    const s = x.style || (x.style = {});
    const p = x.props || (x.props = {});
    const label = BLOCK_TYPES[x.type]?.label || x.type;
    const textual = !['shape', 'line', 'image', 'logo', 'qr'].includes(x.type);
    const al = (v, ic) => `<button data-align="${v}" class="${(s.align || 'left') === v ? 'on' : ''}" aria-label="Align ${v}">${icon(ic, 15)}</button>`;
    insp.innerHTML = `<div class="flex between"><h4 style="margin:0">${esc(label)}</h4>
        <div class="flex" style="gap:2px"><button class="btn icon sm ghost" data-act="dup" title="Duplicate (⌘D)">${icon('copy', 15)}</button><button class="btn icon sm ghost" data-act="order" title="Arrange">${icon('layers', 15)}</button><button class="btn icon sm ghost danger" data-act="del" title="Delete (⌫)">${icon('trash-2', 15)}</button></div></div>
      <div class="form-grid mt" style="grid-template-columns:1fr 1fr 1fr 1fr" data-geo>
        ${['x', 'y', 'w', 'h'].map((k) => `<div class="field"><label>${k.toUpperCase()}</label><input class="input" type="number" data-geo-k="${k}" value="${x[k]}"></div>`).join('')}
      </div>
      ${textual ? `<h4 class="mt">Text</h4>
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Size</label><input class="input" type="number" step="0.5" min="6" data-style="fontSize" value="${esc(s.fontSize ?? 12)}"></div>
        <div class="field"><label>Weight</label><select class="input" data-style="weight">${[['', 'Regular'], [300, 'Light'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']].map(([v, l]) => `<option value="${v}" ${String(s.weight ?? '') === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Colour</label><div class="flex" style="gap:4px"><input type="color" class="color-input" data-style="color" value="${esc(colorVal(s.color || '#1d1d1f'))}"><button class="btn sm ${s.color === 'accent' ? 'primary' : ''}" data-accent="color" title="Use brand colour" style="height:32px;padding:0 8px">${icon('sparkles', 13)}</button></div></div>
        <div class="field"><label>Font</label><select class="input" data-style="font"><option value="">Design font</option>${Object.entries(FONTS).map(([k, v]) => `<option value="${k}" ${k === s.font ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
        <div class="field span2"><label>Alignment</label><div class="align-group">${al('left', 'align-left')}${al('center', 'align-center')}${al('right', 'align-right')}</div></div>
        <label class="check"><input type="checkbox" data-style-b="italic" ${s.italic ? 'checked' : ''}> Italic</label>
        <label class="check"><input type="checkbox" data-style-b="uppercase" ${s.uppercase ? 'checked' : ''}> Uppercase</label>
        <div class="field"><label>Letter spacing</label><input class="input" type="number" step="0.5" data-style="letterSpacing" value="${esc(s.letterSpacing ?? '')}"></div>
        <div class="field"><label>Line height</label><input class="input" type="number" step="0.05" data-style="lineHeight" value="${esc(s.lineHeight ?? '')}" placeholder="1.4"></div>
      </div>` : ''}
      ${propsHtml(x)}
      <h4 class="mt">Box</h4>
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>${x.type === 'line' ? 'Line colour' : 'Fill'}</label><div class="flex" style="gap:4px"><input type="color" class="color-input" data-style="bg" value="${esc(colorVal(s.bg))}"><button class="btn sm ${s.bg === 'accent' ? 'primary' : ''}" data-accent="bg" title="Use brand colour" style="height:32px;padding:0 8px">${icon('sparkles', 13)}</button>${x.type !== 'line' ? `<button class="btn sm" data-nobg title="No fill" style="height:32px;padding:0 8px">${icon('x', 13)}</button>` : ''}</div></div>
        <div class="field"><label>Opacity</label><input class="input" type="number" min="0" max="1" step="0.05" data-style="opacity" value="${esc(s.opacity ?? 1)}"></div>
        ${x.type !== 'line' ? `<div class="field"><label>Border</label><input class="input" type="number" min="0" step="0.5" data-style="borderWidth" value="${esc(s.borderWidth ?? 0)}"></div>
        <div class="field"><label>Border colour</label><input type="color" class="color-input" data-style="borderColor" value="${esc(colorVal(s.borderColor || '#1d1d1f'))}"></div>
        <div class="field"><label>Corner radius</label><input class="input" type="number" min="0" data-style="radius" value="${esc(s.radius ?? 0)}"></div>
        <div class="field"><label>Padding</label><input class="input" type="number" min="0" data-style="padding" value="${esc(s.padding ?? 0)}"></div>` : ''}
        <label class="check span2"><input type="checkbox" data-prop-b="anchor" ${p.anchor === 'bottom' ? 'checked' : ''}> Stick to bottom of last page</label>
      </div>`;
    bindInspector(x);
  }

  function propsHtml(x) {
    const p = x.props;
    const t = (k, l, ph = '') => `<div class="field span2"><label>${l}</label><input class="input" data-prop="${k}" value="${esc(p[k] ?? '')}" placeholder="${esc(ph)}"></div>`;
    const ck = (k, l, def = false) => `<label class="check span2"><input type="checkbox" data-prop-b="${k}" ${(p[k] ?? def) ? 'checked' : ''}> ${l}</label>`;
    const sel2 = (k, l, opts) => `<div class="field span2"><label>${l}</label><select class="input" data-prop="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(p[k] ?? opts[0][0]) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    let h = '';
    switch (x.type) {
      case 'business': h = `<div class="field span2"><label>Business name size</label><input class="input" type="number" data-prop="nameSize" value="${esc(p.nameSize ?? 18)}"></div>`; break;
      case 'title': h = t('text', 'Custom title', 'Automatic (e.g. Tax Invoice)') + ck('showCopy', 'Show copy label inside title (e.g. Original for Recipient)'); break;
      case 'meta': h = sel2('layout', 'Layout', [['rows', 'Label and value apart'], ['stack', 'Label then value']]); break;
      case 'billto': case 'shipto': case 'notes': case 'terms': case 'bank': h = t('label', 'Heading'); break;
      case 'signature': h = t('label', 'Caption', 'Authorised signatory'); break;
      case 'items':
        h = sel2('header', 'Header style', [['line', 'Underline'], ['filled', 'Filled with brand colour'], ['soft', 'Soft tint'], ['minimal', 'Minimal'], ['accentline', 'Brand lines']])
          + t('itemLabel', 'Item column title', 'Item') + ck('grid', 'Grid lines') + ck('striped', 'Striped rows') + ck('rounded', 'Rounded header') + ck('amountInclTax', 'Amount column includes tax')
          + `<div class="field span2"><label>Columns</label>${COLS.map(([k, l]) => `<label class="check"><input type="checkbox" data-col="${k}" ${(p.hide || []).includes(k) ? '' : 'checked'}> ${l}</label>`).join('')}<div class="help">Empty columns (no HSN, no discount, no tax) hide automatically.</div></div>`;
        break;
      case 'totals': h = sel2('totalStyle', 'Total style', [['line', 'Lines'], ['filled', 'Filled with brand colour'], ['accent', 'Large brand colour']]) + t('totalLabel', 'Total label', 'Total') + ck('showPaid', 'Show paid & balance due', true); break;
      case 'taxsummary': h = sel2('mode', 'Summary by', [['rate', 'Tax rate'], ['hsn', 'HSN / SAC code']]); break;
      case 'qr': h = t('text', 'Custom QR content', 'Automatic payment QR (UPI / SEPA / link)') + t('caption', 'Caption'); break;
      case 'text': h = `<div class="field span2"><label>Text</label><textarea class="input" data-prop="text" rows="4">${esc(p.text ?? '')}</textarea>
        <div class="help">Placeholders: ${['business.name', 'business.phone', 'business.email', 'business.website', 'business.footer', 'doc.number', 'doc.date', 'customer.name', 'total'].map((k) => `<button type="button" class="kbd" data-ph="{{${k}}}" style="cursor:pointer;margin:2px">{{${k}}}</button>`).join('')}</div></div>`; break;
      case 'image': h = `<div class="field span2"><button class="btn sm" data-img>${icon('upload', 14)} ${p.src ? 'Replace image' : 'Upload image'}</button></div>` + sel2('fit', 'Fit', [['contain', 'Fit inside'], ['cover', 'Fill (crop)']]); break;
      case 'logo': h = `<div class="field span2"><div class="help">The logo comes from your <a href="#/business">Business profile</a>.</div></div>`; break;
      default: h = '';
    }
    return h ? `<h4 class="mt">Content</h4><div class="form-grid" style="grid-template-columns:1fr 1fr">${h}</div>` : '';
  }

  function bindInspector(x) {
    const insp = $('[data-insp]');
    const live = () => drawCanvas();
    insp.querySelectorAll('[data-geo-k]').forEach((el) => {
      el.addEventListener('input', () => { x[el.dataset.geoK] = Math.max(el.dataset.geoK === 'w' || el.dataset.geoK === 'h' ? 1 : -2000, num(el.value, x[el.dataset.geoK])); live(); });
      el.addEventListener('change', () => { commit(); drawLayers(); });
    });
    insp.querySelectorAll('[data-style]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.dataset.style;
        x.style[k] = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value || undefined;
        live();
      });
      el.addEventListener('change', commit);
    });
    insp.querySelectorAll('[data-style-b]').forEach((el) => el.addEventListener('change', () => { x.style[el.dataset.styleB] = el.checked; commit(); live(); }));
    insp.querySelectorAll('[data-align]').forEach((el) => el.addEventListener('click', () => { x.style.align = el.dataset.align; commit(); draw(); }));
    insp.querySelectorAll('[data-accent]').forEach((el) => el.addEventListener('click', () => { x.style[el.dataset.accent] = 'accent'; commit(); draw(); }));
    insp.querySelector('[data-nobg]')?.addEventListener('click', () => { x.style.bg = 'transparent'; commit(); draw(); });
    insp.querySelectorAll('[data-prop]').forEach((el) => {
      el.addEventListener('input', () => { const k = el.dataset.prop; x.props[k] = el.type === 'number' ? num(el.value) : el.value; live(); });
      el.addEventListener('change', commit);
    });
    insp.querySelectorAll('[data-prop-b]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.propB;
      if (k === 'anchor') x.props.anchor = el.checked ? 'bottom' : undefined; else x.props[k] = el.checked;
      commit(); live();
    }));
    insp.querySelectorAll('[data-col]').forEach((el) => el.addEventListener('change', () => {
      const hide = new Set(x.props.hide || []);
      el.checked ? hide.delete(el.dataset.col) : hide.add(el.dataset.col);
      x.props.hide = [...hide]; commit(); live();
    }));
    insp.querySelectorAll('[data-ph]').forEach((el) => el.addEventListener('click', () => {
      const ta = insp.querySelector('[data-prop=text]');
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + el.dataset.ph + ta.value.slice(pos);
      x.props.text = ta.value; commit(); live();
    }));
    insp.querySelector('[data-img]')?.addEventListener('click', () => chooseImage(x));
    insp.querySelector('[data-act=del]').addEventListener('click', () => removeSel());
    insp.querySelector('[data-act=dup]').addEventListener('click', () => duplicateSel());
    insp.querySelector('[data-act=order]').addEventListener('click', (e) => menu(e.currentTarget, [
      { label: 'Bring to front', icon: 'bring-to-front', onClick: () => order('front') },
      { label: 'Bring forward', icon: 'arrow-up', onClick: () => order('up') },
      { label: 'Send backward', icon: 'arrow-down', onClick: () => order('down') },
      { label: 'Send to back', icon: 'send-to-back', onClick: () => order('back') },
      '-',
      { label: 'Centre horizontally on page', icon: 'align-center', onClick: () => { x.x = Math.round((PAGE.w - x.w) / 2); commit(); draw(); } },
      { label: 'Full width (margins)', icon: 'separator-horizontal', onClick: () => { x.x = 48; x.w = PAGE.w - 96; commit(); draw(); } },
      { label: x.locked ? 'Unlock' : 'Lock position', icon: 'lock', onClick: () => { x.locked = !x.locked; commit(); draw(); } },
    ]));
  }

  function drawInspectorGeometry() {
    const x = sel && blk(sel); if (!x) return;
    root.querySelectorAll('[data-geo-k]').forEach((el) => (el.value = x[el.dataset.geoK]));
  }

  async function chooseImage(x) {
    const f = await pickFile('image/*'); if (!f) return;
    try { x.props.src = await imageToDataURL(f, 900); commit(); draw(); } catch (e) { toast(e.message, 'err'); }
  }

  function order(dir) {
    const x = blk(sel); if (!x) return;
    const zs = tpl.blocks.map((y) => y.z || 0);
    if (dir === 'front') x.z = Math.max(...zs) + 1;
    else if (dir === 'back') { tpl.blocks.forEach((y) => (y.z = (y.z || 0) + 1)); x.z = Math.min(...tpl.blocks.map((y) => y.z)) - 1; }
    else {
      const sorted = tpl.blocks.slice().sort((a, y) => (a.z || 0) - (y.z || 0));
      const i = sorted.indexOf(x), j = dir === 'up' ? i + 1 : i - 1;
      if (sorted[j]) { const t = sorted[j].z; sorted[j].z = x.z; x.z = t === x.z ? t + (dir === 'up' ? 1 : -1) : t; }
    }
    commit(); draw();
  }
  function removeSel() {
    if (!sel) return;
    tpl.blocks = tpl.blocks.filter((x) => x.id !== sel); sel = null; commit(); draw();
  }
  function duplicateSel() {
    const x = blk(sel); if (!x) return;
    const c = JSON.parse(JSON.stringify(x));
    c.id = uid('b_'); c.x += 16; c.y += 16; c.z = Math.max(...tpl.blocks.map((y) => y.z || 0)) + 1; c.locked = false;
    tpl.blocks.push(c); sel = c.id; commit(); draw();
  }
  function addBlock(type) {
    const wrapRect = wrap.getBoundingClientRect();
    const holderRect = holder.getBoundingClientRect();
    const cy = Math.max(40, Math.min(PAGE.h - 120, (wrapRect.top + wrapRect.height / 2 - holderRect.top) / zoom - 40));
    const x = newBlock(type, 80, Math.round(cy / SNAP) * SNAP);
    x.z = Math.max(0, ...tpl.blocks.map((y) => y.z || 0)) + 1;
    if (type === 'items') { x.x = 48; }
    tpl.blocks.push(x); sel = x.id; commit(); draw();
    if (type === 'image') chooseImage(x);
  }

  root.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => addBlock(el.dataset.add)));
  $('[data-add-mobile]').addEventListener('click', (e) => menu(e.currentTarget, Object.entries(BLOCK_TYPES).map(([k, v]) => ({ label: v.label, icon: v.icon, onClick: () => addBlock(k) }))));

  // ---------- Toolbar ----------
  $('[data-name]').addEventListener('change', (e) => { tpl.name = e.target.value.trim() || 'My design'; persist(); });
  $('[data-undo]').addEventListener('click', () => { if (undo.length) { redo.push(snapshot()); restore(undo.pop()); } });
  $('[data-redo]').addEventListener('click', () => { if (redo.length) { undo.push(snapshot()); restore(redo.pop()); } });
  $('[data-zoom-in]').addEventListener('click', () => { zoom = Math.min(2, zoom + 0.1); drawCanvas(); });
  $('[data-zoom-out]').addEventListener('click', () => { zoom = Math.max(0.3, zoom - 0.1); drawCanvas(); });
  $('[data-grid]').addEventListener('click', (e) => { showGrid = !showGrid; e.currentTarget.classList.toggle('primary', showGrid); drawCanvas(); });
  $('[data-preview]').addEventListener('click', (e) => {
    preview = !preview; if (preview) sel = null;
    e.currentTarget.innerHTML = preview ? `${icon('pencil', 15)} <span class="desktop-only">Edit</span>` : `${icon('eye', 15)} <span class="desktop-only">Preview</span>`;
    draw();
  });
  $('[data-done]').addEventListener('click', async () => { await db.put('templates', tpl); toast('Design saved'); location.hash = '#/templates'; });

  const onKey = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); $(e.shiftKey ? '[data-redo]' : '[data-undo]').click(); return; }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); $('[data-redo]').click(); return; }
    if (typing) return;
    const x = sel && blk(sel);
    if (!x) return;
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); return; }
    if (e.key === 'Escape') { sel = null; draw(); return; }
    const step = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !x.locked) { e.preventDefault(); x.x += mv[0]; x.y += mv[1]; drawCanvas(); drawInspectorGeometry(); commitKey(); }
  };
  const commitKey = debounce(() => commit(), 400);
  document.addEventListener('keydown', onKey);
  const onResize = debounce(() => { fitZoom(); drawCanvas(); }, 150);
  window.addEventListener('resize', onResize);

  function draw() { drawCanvas(); drawLayers(); drawInspector(); }
  draw();
  document.body.style.overflow = 'hidden';

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.overflow = '';
    db.put('templates', tpl);
  };
}
