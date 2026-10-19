import { icon } from '../lib/icons.js';
import { esc, menu, toast, confirmDialog, promptDialog, modal } from '../ui.js';
import { db } from '../db.js';
import { state, DOC_TYPE_LIST, saveBusiness, docTitle } from '../store.js';
import { allTemplates, defaultTemplateId } from '../tplstore.js';
import { cloneTemplate, PAGE } from '../templates.js';
import { sampleContext, mountPage } from '../render.js';

const ui = { type: 'invoice' };

export async function render(root) {
  const b = state.business;
  const templates = await allTemplates();
  const def = defaultTemplateId(ui.type, b);

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Templates</h1><p>Pick a document type, choose a design, then make it yours — move, resize and restyle every block.</p></div>
      <div class="actions"><button class="btn" data-blank>${icon('plus', 16)} Blank design</button></div></div>
    <div class="section-title" style="margin-top:0">What do you want to create?</div>
    <div class="chips mb" data-types>${DOC_TYPE_LIST.map((t) => `<button class="chip ${ui.type === t.key ? 'on' : ''}" data-t="${t.key}">${icon(t.icon, 14)} ${esc(t.label)}</button>`).join('')}</div>
    <div class="notice mb">${icon('sparkles', 18)}<div>The highlighted design is used for new <b>${esc(docTitle(ui.type, b))}</b> bills. Your logo, colours and GST/tax details come from <a href="#/business">Business profile</a>.</div></div>
    <div class="tpl-grid">${templates.map((t) => `
      <div class="tpl-card ${t.id === def ? 'default' : ''}" data-id="${t.id}">
        <div class="tpl-thumb" data-preview="${t.id}" title="Preview"><div class="thumb-inner" data-thumb="${t.id}"></div></div>
        <div class="tpl-meta">
          <div class="name">${esc(t.name)} ${t.id === def ? '<span class="badge partial">Default</span>' : ''}${t.builtin ? '' : '<span class="badge neutral">Custom</span>'}</div>
          <div class="desc">${esc(t.description || 'Your custom design')}</div>
          <div class="btn-row">
            ${t.id === def ? `<a class="btn sm primary" href="#/bills/new/${ui.type}">${icon('plus', 14)} Create</a>` : `<button class="btn sm primary" data-use="${t.id}">Use</button>`}
            <button class="btn sm" data-edit="${t.id}">${icon('pencil', 14)} Customize</button>
            <button class="btn icon sm ghost" data-more="${t.id}" aria-label="More">${icon('ellipsis', 16)}</button>
          </div>
        </div>
      </div>`).join('')}</div>
  </div>`;

  // Thumbnails
  const ctx = sampleContext(b, ui.type);
  requestAnimationFrame(() => {
    root.querySelectorAll('[data-thumb]').forEach((el) => {
      const t = templates.find((x) => x.id === el.dataset.thumb);
      const w = Math.min(230, el.parentElement.clientWidth - 32);
      mountPage(el, ctx, t, { width: w, flow: true });
      el.style.height = Math.min(PAGE.h * (w / PAGE.w), 300) + 'px';
      el.style.overflow = 'hidden';
    });
  });

  root.querySelectorAll('[data-t]').forEach((x) => x.addEventListener('click', () => { ui.type = x.dataset.t; render(root); }));
  root.querySelectorAll('[data-use]').forEach((x) => x.addEventListener('click', async () => {
    b.defaultTemplates = { ...(b.defaultTemplates || {}), [ui.type]: x.dataset.use };
    await saveBusiness(b);
    toast(`Default design for ${docTitle(ui.type, b)} updated`);
  }));
  const openDesigner = async (id) => {
    const t = templates.find((x) => x.id === id);
    if (t.builtin) {
      // Re-open the user's existing version of this design instead of piling up copies.
      const copy = templates.find((x) => !x.builtin && x.basedOn === t.id) || cloneTemplate(t, { name: `${t.name} (my version)`, businessId: b.id });
      if (!copy.createdAt) await db.put('templates', copy);
      // If the built-in was the default, the customised version becomes the default everywhere it was used.
      const dt = { ...(b.defaultTemplates || {}) };
      let changedDefault = false;
      for (const d of DOC_TYPE_LIST) if (defaultTemplateId(d.key, b) === t.id) { dt[d.key] = copy.id; changedDefault = true; }
      if (changedDefault) { b.defaultTemplates = dt; await saveBusiness(b, { quiet: true }); }
      location.hash = `#/templates/${copy.id}/design`;
    } else location.hash = `#/templates/${id}/design`;
  };
  root.querySelectorAll('[data-edit]').forEach((x) => x.addEventListener('click', () => openDesigner(x.dataset.edit)));
  root.querySelectorAll('[data-preview]').forEach((x) => x.addEventListener('click', () => {
    const t = templates.find((y) => y.id === x.dataset.preview);
    const m = modal({ title: t.name, wide: true, body: `<div class="paper-stage"><div data-big class="paper-shadow" style="margin:0 auto;background:#fff"></div></div>`,
      foot: `<button class="btn" data-close>Close</button><button class="btn" data-c>Customize</button><button class="btn primary" data-u>Use for ${esc(docTitle(ui.type, b))}</button>` });
    const host = m.el.querySelector('[data-big]');
    mountPage(host, ctx, t, { width: Math.min(740, m.el.clientWidth - 80) });
    m.el.querySelector('[data-c]').addEventListener('click', () => { m.close(); openDesigner(t.id); });
    m.el.querySelector('[data-u]').addEventListener('click', async () => { m.close(); b.defaultTemplates = { ...(b.defaultTemplates || {}), [ui.type]: t.id }; await saveBusiness(b); toast('Default updated'); });
  }));
  root.querySelectorAll('[data-more]').forEach((x) => x.addEventListener('click', () => {
    const t = templates.find((y) => y.id === x.dataset.more);
    menu(x, [
      { label: 'Use for all document types', icon: 'check', onClick: async () => { b.defaultTemplates = Object.fromEntries(DOC_TYPE_LIST.map((d) => [d.key, t.id])); await saveBusiness(b); toast('Used for all documents'); } },
      { label: 'Duplicate', icon: 'copy', onClick: async () => { await db.put('templates', cloneTemplate(t, { name: `${t.name} copy`, businessId: b.id })); toast('Duplicated'); render(root); } },
      ...(t.builtin ? [] : [
        { label: 'Rename', icon: 'pencil', onClick: async () => { const n = await promptDialog('Rename design', { label: 'Name', value: t.name }); if (n) { t.name = n; await db.put('templates', t); render(root); } } },
        '-',
        { label: 'Delete', icon: 'trash-2', danger: true, onClick: async () => {
          if (!(await confirmDialog(`Delete “${t.name}”?`, 'Bills using it will switch to your default design.', { ok: 'Delete', danger: true }))) return;
          await db.del('templates', t.id);
          const dt = { ...(b.defaultTemplates || {}) };
          for (const k of Object.keys(dt)) if (dt[k] === t.id) delete dt[k];
          b.defaultTemplates = dt; await saveBusiness(b);
          toast('Design deleted');
        } },
      ]),
    ]);
  }));
  root.querySelector('[data-blank]').addEventListener('click', async () => {
    const t = { id: '', name: 'Blank design', description: 'Built from scratch', accent: b.accent || '#0071e3', font: 'system', page: { ...PAGE, bg: '#ffffff' }, blocks: [], businessId: b.id, builtin: false };
    const saved = await db.put('templates', cloneTemplate(t, { businessId: b.id, name: 'My design' }));
    location.hash = `#/templates/${saved.id}/design`;
  });
}
