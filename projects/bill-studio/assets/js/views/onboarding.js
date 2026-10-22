import { icon } from '../lib/icons.js';
import { esc, toast, imageToDataURL, safeImg } from '../ui.js';
import { COUNTRY_LIST, getCountry, CURRENCIES } from '../tax/countries.js';
import { validateTaxId } from '../lib/validators.js';
import { taxIdRule, businessTaxError, CA_PROVINCES } from '../tax/rules.js';
import { newBusiness, state } from '../store.js';
import { rerenderShell } from '../app.js';
import { db } from '../db.js';
import { seedSample } from '../seed.js';

function guessCountry() {
  const lang = (navigator.languages || [navigator.language || 'en-US']).join(',');
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* noop */ }
  if (/Kolkata|Calcutta/.test(tz) || /-IN\b/.test(lang)) return 'IN';
  const m = lang.match(/-([A-Z]{2})\b/);
  return m && getCountry(m[1]).code === m[1] ? m[1] : 'US';
}

export async function render(root, { adding } = {}) {
  let step = adding ? 1 : 0;
  let country = guessCountry();
  let biz = newBusiness(country);
  let seed = !adding;
  let query = '';

  const draw = () => {
    root.innerHTML = `<div class="welcome"><div class="welcome-inner">${[hero, pickCountry, details][step]()}</div></div>`;
    bind();
  };

  const dots = () => `<div class="steps-dots">${[0, 1, 2].map((i) => `<span class="${i === step ? 'on' : ''}"></span>`).join('')}</div>`;

  const hero = () => `
    <div class="hero-mark">${icon('receipt', 42)}</div>
    <h1>Billing.<br>Beautifully simple.</h1>
    <p class="lead">Create professional bills in seconds, follow up on dues and see your numbers clearly — for any country, in any currency.</p>
    <button class="btn primary lg" data-next>Get started ${icon('chevron-right', 18)}</button>
    <div class="features">
      <div class="feature">${icon('globe', 22)}<b>Made for every country</b><span>GST, VAT, sales tax and more — formatted the way your tax office expects.</span></div>
      <div class="feature">${icon('lock', 22)}<b>Private by design</b><span>Everything stays on this device. Works offline. No account, no fees.</span></div>
      <div class="feature">${icon('layout-template', 22)}<b>Your bill, your style</b><span>Five beautiful templates you can rearrange freely, like slides.</span></div>
    </div>`;

  const pickCountry = () => {
    const q = query.toLowerCase();
    const list = COUNTRY_LIST.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q || c.currency.toLowerCase() === q);
    const c = getCountry(country);
    return `${dots()}
      <h1 style="font-size:40px">Where is your business?</h1>
      <p class="lead">We’ll set up the right tax system, currency and bill format for you.</p>
      <div class="onb-card">
        <div class="searchbar" style="max-width:none;margin-bottom:14px">${icon('search', 16)}<input class="input" data-q placeholder="Search country or currency" value="${esc(query)}" aria-label="Search country"></div>
        <div class="country-grid" role="listbox">${list.map((x) => `<button class="country-btn ${x.code === country ? 'on' : ''}" data-c="${x.code}" role="option" aria-selected="${x.code === country}"><span class="flag">${x.flag}</span><span><div style="font-weight:500">${esc(x.name)}</div><div class="tiny muted">${esc(x.taxName)} · ${x.currency}</div></span></button>`).join('') || '<div class="muted small">No match — choose “Other country”.</div>'}</div>
        <div class="notice mt">${icon('sparkles', 18)}<div><b>${c.flag} ${esc(c.name)}:</b> ${esc(c.taxName)} · ${esc(c.currency)} · financial year starts in ${new Date(2000, c.fyStartMonth - 1, 1).toLocaleString('en', { month: 'long' })}.${c.notes ? ' ' + esc(c.notes) : ''}</div></div>
        ${c.eInvoice ? `<div class="notice warn mt-s">${icon('triangle-alert', 18)}<div><b>E-invoicing:</b> ${esc(c.eInvoice)}</div></div>` : ''}
        <div class="flex between mt"><button class="btn" data-back>${adding ? 'Cancel' : 'Back'}</button><button class="btn primary" data-next>Continue with ${c.flag} ${esc(c.name)}</button></div>
      </div>`;
  };

  const details = () => {
    const c = getCountry(biz.country);
    const v = validateTaxId(c.code, biz.taxId);
    const rule = taxIdRule(c.code, biz.taxScheme);
    return `${dots()}
      <h1 style="font-size:40px">Tell us about your business</h1>
      <p class="lead">This appears on every bill. You can change it any time.</p>
      <div class="onb-card">
        <div class="logo-drop" data-logo tabindex="0" role="button" aria-label="Upload logo">
          <div class="prev">${biz.logo ? `<img src="${safeImg(biz.logo)}" alt="Logo">` : icon('image', 28)}</div>
          <div><b>${biz.logo ? 'Change logo' : 'Add your logo'}</b><div class="small muted">PNG, JPG or SVG. Drop a file here or click.</div></div>
        </div>
        <div class="form-grid mt">
          <div class="field span2"><label>Business name *</label><input class="input" name="name" value="${esc(biz.name)}" placeholder="e.g. Sharma Electronics" autocomplete="organization"></div>
          ${c.code === 'IN' ? `
          <div class="field"><label>GST registration *</label><select class="input" name="taxScheme" data-redraw>
            <option value="regular" ${biz.taxScheme === 'regular' ? 'selected' : ''}>Regular GST (Tax Invoice)</option>
            <option value="composition" ${biz.taxScheme === 'composition' ? 'selected' : ''}>Composition scheme (Bill of Supply)</option>
            <option value="unregistered" ${biz.taxScheme === 'unregistered' ? 'selected' : ''}>Not registered for GST</option></select></div>
          <div class="field"><label>State *</label><select class="input" name="region"><option value="">Select state</option>${c.regions.filter((r) => r.code !== '96').map((r) => `<option value="${r.code}" ${biz.region === r.code ? 'selected' : ''}>${esc(r.name)} (${r.code})</option>`).join('')}</select></div>`
          : `<div class="field"><label>${c.code === 'US' ? 'Do you collect sales tax?' : `Registered for ${esc(c.taxName)}?`} *</label><select class="input" name="taxScheme" data-redraw><option value="regular" ${biz.taxScheme === 'regular' ? 'selected' : ''}>Yes — charge ${esc(c.taxName)}</option><option value="unregistered" ${biz.taxScheme === 'unregistered' ? 'selected' : ''}>No — don’t charge tax</option></select></div>
          <div class="field"><label>Currency</label><select class="input" name="currency">${[...new Set([biz.currency, ...CURRENCIES])].map((x) => `<option ${x === biz.currency ? 'selected' : ''}>${x}</option>`).join('')}</select></div>`}
          ${c.code === 'CA' ? `<div class="field span2"><label>Province / territory *</label><select class="input" name="region"><option value="">Select province</option>${CA_PROVINCES.map(([code, n]) => `<option value="${code}" ${biz.region === code ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><div class="help">Sets your GST/HST/PST rates.</div></div>` : ''}
          ${c.code === 'US' && biz.taxScheme !== 'unregistered' ? `<div class="field span2"><label>Your sales tax rate (state + local) % *</label><input class="input" name="salesTaxRate" type="number" step="any" min="0" max="20" value="${esc(biz.salesTaxRate ?? '')}" placeholder="e.g. 8.875"><div class="help">Rates differ by state, county and city. You can add more rates later in Settings → Taxes.</div></div>` : ''}
          ${rule.show ? `<div class="field span2"><label>${esc(c.taxIdLabel)}${rule.required ? ' *' : ''}</label><input class="input ${v.ok ? '' : 'invalid'}" name="taxId" value="${esc(biz.taxId)}" placeholder="${c.code === 'IN' ? '22AAAAA0000A1Z5' : rule.required ? '' : 'Optional'}" autocapitalize="characters">
            <div class="help ${v.ok ? '' : 'err'}" data-taxhelp>${v.ok ? esc(rule.help) : esc(v.msg)}</div></div>`
          : `<div class="field span2"><div class="notice">${icon('sparkles', 18)}<div>Your bills will be titled <b>${esc(c.docTitle.unregistered)}</b> and won’t charge ${esc(c.taxName)}.${c.exemptNote ? ` They will state: “${esc(c.exemptNote)}”.` : ''} You can register later in Business profile.</div></div></div>`}
          ${c.code === 'DE' && biz.taxScheme === 'unregistered' ? `<div class="field span2"><label>Steuernummer *</label><input class="input" name="secondaryId" value="${esc(biz.secondaryId || '')}" placeholder="e.g. 12/345/67890"></div>` : ''}
          <div class="field span2"><label>Address</label><textarea class="input" name="address" rows="2" placeholder="Street, area">${esc(biz.address)}</textarea></div>
          <div class="field"><label>City</label><input class="input" name="city" value="${esc(biz.city)}"></div>
          <div class="field"><label>Postal code</label><input class="input" name="postal" value="${esc(biz.postal)}"></div>
          <div class="field"><label>Phone</label><input class="input" name="phone" type="tel" value="${esc(biz.phone)}"></div>
          <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${esc(biz.email)}"></div>
        </div>
        ${adding ? '' : `<label class="flex mt" style="cursor:pointer"><input type="checkbox" data-seed ${seed ? 'checked' : ''}> <span class="small">Add a few sample customers, items and bills so I can explore (you can delete them later)</span></label>`}
        <div class="flex between mt"><button class="btn" data-back>Back</button><button class="btn primary" data-finish>${icon('check', 16)} Create my business</button></div>
      </div>`;
  };

  const readForm = () => {
    root.querySelectorAll('[name]').forEach((el) => { biz[el.name] = el.value.trim ? el.value.trim() : el.value; });
  };

  const bind = () => {
    root.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', () => {
      if (step === 1) {
        const prevLogo = biz.logo;
        biz = { ...newBusiness(country), logo: prevLogo, name: biz.name };
      }
      step++; draw();
    }));
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
      if (step === 1 && adding) { location.hash = '#/'; return; }
      if (step === 2) readForm();
      step--; draw();
    }));
    const q = root.querySelector('[data-q]');
    if (q) {
      q.addEventListener('input', () => { query = q.value; const pos = q.selectionStart; draw(); const n = root.querySelector('[data-q]'); n.focus(); n.setSelectionRange(pos, pos); });
      setTimeout(() => q.focus(), 50);
    }
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { country = b.dataset.c; draw(); }));
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('dblclick', () => { country = b.dataset.c; biz = newBusiness(country); step = 2; draw(); }));
    const logo = root.querySelector('[data-logo]');
    if (logo) {
      const take = async (file) => {
        readForm();
        try { biz.logo = await imageToDataURL(file, 600); draw(); } catch (e) { toast(e.message, 'err'); }
      };
      logo.addEventListener('click', () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => i.files[0] && take(i.files[0]); i.click(); });
      logo.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logo.click(); } });
      logo.addEventListener('dragover', (e) => { e.preventDefault(); logo.classList.add('drag'); });
      logo.addEventListener('dragleave', () => logo.classList.remove('drag'));
      logo.addEventListener('drop', (e) => { e.preventDefault(); logo.classList.remove('drag'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]); });
    }
    const tax = root.querySelector('[name=taxId]');
    if (tax) tax.addEventListener('input', () => {
      const c = getCountry(biz.country);
      const v = validateTaxId(c.code, tax.value);
      tax.classList.toggle('invalid', !v.ok);
      const h = root.querySelector('[data-taxhelp]');
      h.className = 'help ' + (v.ok ? '' : 'err');
      h.textContent = v.ok ? (v.empty ? taxIdRule(c.code, root.querySelector('[name=taxScheme]')?.value).help : 'Looks valid ✓') : v.msg;
      if (v.ok && v.state) { const r = root.querySelector('[name=region]'); if (r) r.value = v.state; biz.secondaryId = v.pan; }
    });
    root.querySelectorAll('[data-redraw]').forEach((el) => el.addEventListener('change', () => { readForm(); draw(); }));
    const seedBox = root.querySelector('[data-seed]');
    seedBox?.addEventListener('change', () => (seed = seedBox.checked));
    root.querySelector('[data-finish]')?.addEventListener('click', async () => {
      readForm();
      if (!biz.name) { toast('Please enter your business name', 'err'); root.querySelector('[name=name]').focus(); return; }
      const c = getCountry(biz.country);
      biz.taxId = taxIdRule(c.code, biz.taxScheme).show ? (biz.taxId || '').toUpperCase().replace(/\s/g, '') : '';
      if (c.code === 'CA' && !biz.region) { toast('Please choose your province', 'err'); return; }
      const err = businessTaxError(biz);
      if (err) { toast(err, 'err'); root.querySelector(c.gst && !biz.region ? '[name=region]' : '[name=taxId]')?.focus(); return; }
      if (c.code === 'US' && biz.taxScheme !== 'unregistered') {
        const r = Number(biz.salesTaxRate);
        if (biz.salesTaxRate === '' || biz.salesTaxRate == null || !(r >= 0 && r <= 20)) { toast('Enter your sales tax rate (0–20%)', 'err'); root.querySelector('[name=salesTaxRate]')?.focus(); return; }
        biz.taxes = [{ id: 'sales', label: `Sales tax ${r}%`, components: [{ name: 'Sales tax', rate: r }] }, { id: 'exempt', label: 'Tax exempt', components: [] }];
        biz.defaultTaxId = 'sales';
      }
      if (c.code === 'CA') biz.defaultTaxId = CA_PROVINCES.find((p) => p[0] === biz.region)?.[2] || biz.defaultTaxId;
      delete biz.salesTaxRate;
      if (!biz.locale) biz.locale = c.locale;
      const btn = root.querySelector('[data-finish]');
      btn.disabled = true;
      await db.put('businesses', biz);
      state.businesses = await db.all('businesses');
      state.business = biz;
      await db.setting('activeBusiness', biz.id);
      if (seed) { try { await seedSample(biz); } catch (e) { console.error(e); } }
      toast(adding ? 'Business added' : 'Welcome to Bill Studio');
      if (location.hash === '#/') rerenderShell(); else location.hash = '#/';
    });
  };

  draw();
}
