import { icon } from '../lib/icons.js';
import { esc, toast, imageToDataURL, pickFile, confirmDialog, safeImg } from '../ui.js';
import { state, saveBusiness, defaultPreset } from '../store.js';
import { getCountry, COUNTRY_LIST, CURRENCIES } from '../tax/countries.js';
import { validateTaxId, validatePAN, validateEmail } from '../lib/validators.js';
import { MONTHS } from '../lib/dates.js';
import { taxIdRule, businessTaxError, CA_PROVINCES } from '../tax/rules.js';

const LOCALES = [['en-IN', 'English (India)'], ['hi-IN', 'हिन्दी (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'], ['en-AE', 'English (UAE)'], ['ar-SA', 'العربية'], ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['nl-NL', 'Nederlands'], ['ja-JP', '日本語'], ['zh-CN', '中文'], ['id-ID', 'Bahasa Indonesia'], ['en-SG', 'English (Singapore)']];

export async function render(root) {
  const b = JSON.parse(JSON.stringify(state.business));
  const c = getCountry(b.country);
  const tv = validateTaxId(c.code, b.taxId);
  const f = (name, label, value, attrs = '', help = '', cls = '') => `<div class="field ${cls}"><label>${label}</label><input class="input" name="${name}" value="${esc(value ?? '')}" ${attrs}>${help ? `<div class="help">${help}</div>` : ''}</div>`;
  const bankCodeLabel = c.code === 'IN' ? 'IFSC' : c.code === 'US' ? 'Routing number (ABA)' : c.code === 'GB' ? 'Sort code' : c.code === 'AU' ? 'BSB' : c.code === 'CA' ? 'Transit / institution no.' : 'Bank / branch code';

  root.innerHTML = `<div class="page" style="max-width:860px">
    <div class="large-title"><div><h1>Business profile</h1><p>Everything here appears on your bills automatically.</p></div>
      <div class="actions"><button class="btn primary" data-save>${icon('check', 16)} Save changes</button></div></div>

    <div class="section-title">Brand</div>
    <div class="card">
      <div class="grid c2">
        <div><div class="field"><label>Logo</label></div>
          <div class="logo-drop mt-s" data-logo tabindex="0" role="button"><div class="prev">${b.logo ? `<img src="${safeImg(b.logo)}" alt="Logo">` : icon('image', 26)}</div>
          <div><b>${b.logo ? 'Change logo' : 'Upload logo'}</b><div class="small muted">PNG with transparent background looks best</div>${b.logo ? `<button class="btn plain sm" data-rm="logo" style="padding:0;height:auto;margin-top:4px">Remove</button>` : ''}</div></div></div>
        <div><div class="field"><label>Signature / stamp</label></div>
          <div class="logo-drop mt-s" data-sig tabindex="0" role="button"><div class="prev">${b.signature ? `<img src="${safeImg(b.signature)}" alt="Signature">` : icon('pen-tool', 26)}</div>
          <div><b>${b.signature ? 'Change signature' : 'Upload signature'}</b><div class="small muted">Photo of your signature on white paper</div>${b.signature ? `<button class="btn plain sm" data-rm="signature" style="padding:0;height:auto;margin-top:4px">Remove</button>` : ''}</div></div></div>
      </div>
      <div class="form-grid mt">
        ${f('name', 'Business / trade name *', b.name, 'autocomplete="organization"')}
        ${f('legalName', 'Legal name (if different)', b.legalName)}
        <div class="field"><label>Brand colour</label><div class="flex"><input type="color" class="color-input" name="accent" value="${esc(b.accent || '#0071e3')}" style="width:60px"><span class="small muted">Used by built-in designs</span></div></div>
        ${f('footer', 'Footer message', b.footer, 'placeholder="Thank you for your business!"')}
      </div>
    </div>

    <div class="section-title">Tax registration</div>
    <div class="card"><div class="form-grid">
      <div class="field"><label>Country</label><select class="input" name="country">${COUNTRY_LIST.map((x) => `<option value="${x.code}" ${x.code === b.country ? 'selected' : ''}>${x.flag} ${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Tax status</label><select class="input" name="taxScheme">
        <option value="regular" ${b.taxScheme === 'regular' ? 'selected' : ''}>${c.gst ? 'Regular GST — Tax Invoice' : `Registered — charge ${esc(c.taxName)}`}</option>
        ${c.gst ? `<option value="composition" ${b.taxScheme === 'composition' ? 'selected' : ''}>Composition scheme — Bill of Supply</option>` : ''}
        <option value="unregistered" ${b.taxScheme === 'unregistered' ? 'selected' : ''}>Not registered — no tax</option></select></div>
      <div class="field" data-taxid-field ${taxIdRule(c.code, b.taxScheme).show ? '' : 'hidden'}><label>${esc(c.taxIdLabel)}<span data-req>${taxIdRule(c.code, b.taxScheme).required ? ' *' : ''}</span></label><input class="input ${tv.ok ? '' : 'invalid'}" name="taxId" value="${esc(b.taxId)}" autocapitalize="characters"><div class="help ${tv.ok ? '' : 'err'}" data-taxhelp>${tv.ok ? esc(taxIdRule(c.code, b.taxScheme).help || '') : esc(tv.msg)}</div></div>
      ${c.secondaryIdLabel ? f('secondaryId', esc(c.secondaryIdLabel), b.secondaryId, 'autocapitalize="characters"') : f('secondaryId', 'Company / registration no.', b.secondaryId)}
      ${c.code === 'CA' ? `<div class="field"><label>Province / territory</label><select class="input" name="region"><option value="">Select</option>${CA_PROVINCES.map(([code, n]) => `<option value="${code}" ${code === b.region ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>` : ''}
      ${c.regions ? `<div class="field"><label>${esc(c.regionLabel || 'Region')} *</label><select class="input" name="region"><option value="">Select</option>${c.regions.filter((r) => r.code !== '96').map((r) => `<option value="${r.code}" ${r.code === b.region ? 'selected' : ''}>${esc(r.name)} (${r.code})</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Currency</label><select class="input" name="currency">${[...new Set([b.currency, ...CURRENCIES])].map((x) => `<option ${x === b.currency ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Number & date format</label><select class="input" name="locale">${[...new Map([[b.locale, b.locale], ...LOCALES.map(([k, v]) => [k, v])]).entries()].map(([k, v]) => `<option value="${k}" ${k === b.locale ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="field"><label>Financial year starts</label><select class="input" name="fyStartMonth">${MONTHS.map((mo, i) => `<option value="${i + 1}" ${i + 1 === Number(b.fyStartMonth) ? 'selected' : ''}>${mo}</option>`).join('')}</select></div>
    </div>
    ${c.notes ? `<div class="notice mt">${icon('sparkles', 18)}<div>${esc(c.notes)}</div></div>` : ''}</div>

    <div class="section-title">Address & contact</div>
    <div class="card"><div class="form-grid">
      <div class="field span2"><label>Address</label><textarea class="input" name="address" rows="2">${esc(b.address)}</textarea></div>
      ${f('city', 'City', b.city)}${f('postal', 'Postal / PIN code', b.postal)}
      ${f('phone', 'Phone', b.phone, 'type="tel"')}${f('email', 'Email', b.email, 'type="email"')}
      ${f('website', 'Website', b.website, 'placeholder="www.example.com"', '', 'span2')}
    </div></div>

    <div class="section-title">Getting paid</div>
    <div class="card"><div class="form-grid">
      ${c.code === 'IN' || b.currency === 'INR' ? f('upi', 'UPI ID', b.upi, 'placeholder="yourname@okbank"', 'A scan-to-pay UPI QR is printed on bills with the exact amount.', 'span2') : ''}
      ${f('bank.name', 'Bank name', b.bank?.name)}${f('bank.holder', 'Account holder', b.bank?.holder)}
      ${f('bank.account', 'Account number', b.bank?.account)}${f('bank.code', bankCodeLabel, b.bank?.code)}
      ${f('bank.iban', 'IBAN', b.bank?.iban, '', b.currency === 'EUR' ? 'Adds a SEPA “GiroCode” QR to your bills.' : '')}${f('bank.swift', 'SWIFT / BIC', b.bank?.swift)}
      ${f('bank.branch', 'Branch', b.bank?.branch)}
      ${f('payLink', 'Online payment link', b.payLink, 'placeholder="https://paypal.me/you or Stripe link"', c.code === 'IN' ? 'Shown as a QR when no UPI ID is set.' : b.currency === 'EUR' ? 'Shown as a QR when no IBAN is set.' : 'Printed on bills as a scan-to-pay QR code.')}
    </div></div>

    <div class="section-title">Bill defaults</div>
    <div class="card"><div class="form-grid">
      <div class="field"><label>Payment due after (days)</label><input class="input" type="number" min="0" name="paymentTermsDays" value="${esc(b.paymentTermsDays ?? 15)}"></div>
      <div class="field"><label>Default tax</label><select class="input" name="defaultTaxId">${b.taxes.map((t) => `<option value="${esc(t.id)}" ${t.id === b.defaultTaxId ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="roundOff" ${b.roundOff ? 'checked' : ''}><span class="small">Round off totals by default</span></label>
      ${c.showHsn ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="showHsn" ${b.showHsn !== false ? 'checked' : ''}><span class="small">Show HSN/SAC column</span></label>` : ''}
      <div class="field span2"><label>Default terms & conditions</label><textarea class="input" name="terms" rows="3">${esc(b.terms)}</textarea></div>
    </div></div>
    <div class="flex mt-l" style="justify-content:flex-end"><button class="btn primary lg" data-save>${icon('check', 18)} Save changes</button></div>
  </div>`;

  const upload = async (key, max) => {
    const file = await pickFile('image/*'); if (!file) return;
    try {
      b[key] = await imageToDataURL(file, max);
      await saveBusiness({ ...state.business, [key]: b[key] }, { quiet: true }); // keep unsaved form edits
      const box = root.querySelector(key === 'logo' ? '[data-logo] .prev' : '[data-sig] .prev');
      if (box) box.innerHTML = `<img src="${safeImg(b[key])}" alt="">`;
      const av = document.querySelector('.biz-avatar'); if (key === 'logo' && av) av.innerHTML = `<img src="${safeImg(b[key])}" alt="">`;
      toast('Image updated');
    } catch (e) { toast(e.message, 'err'); }
  };
  root.querySelector('[data-logo]').addEventListener('click', (e) => { if (!e.target.closest('[data-rm]')) upload('logo', 600); });
  root.querySelector('[data-sig]').addEventListener('click', (e) => { if (!e.target.closest('[data-rm]')) upload('signature', 500); });
  root.querySelectorAll('[data-rm]').forEach((x) => x.addEventListener('click', async (e) => { e.stopPropagation(); await saveBusiness({ ...state.business, [x.dataset.rm]: '' }); toast('Removed'); }));
  const tax = root.querySelector('[name=taxId]');
  tax.addEventListener('input', () => {
    const v = validateTaxId(c.code, tax.value);
    tax.classList.toggle('invalid', !v.ok);
    const h = root.querySelector('[data-taxhelp]'); h.className = 'help ' + (v.ok ? '' : 'err'); h.textContent = v.ok ? (v.state ? 'Valid GSTIN ✓' : '') : v.msg;
    if (v.ok && v.state) { const r = root.querySelector('[name=region]'); if (r) r.value = v.state; const p = root.querySelector('[name=secondaryId]'); if (p && !p.value) p.value = v.pan; }
  });

  root.querySelector('[name=taxScheme]').addEventListener('change', (e) => {
    const r = taxIdRule(c.code, e.target.value);
    root.querySelector('[data-taxid-field]').hidden = !r.show;
    root.querySelector('[data-req]').textContent = r.required ? ' *' : '';
    root.querySelector('[data-taxhelp]').textContent = r.help || '';
    if (c.gst && e.target.value !== state.business.taxScheme) toast(e.target.value === 'regular' ? 'New bills will be Tax Invoices with GST' : e.target.value === 'composition' ? 'New bills will be Bills of Supply without GST' : 'New bills will be plain invoices without GST', 'info');
  });

  // Switching country changes the whole tax setup, so it is confirmed and applied immediately,
  // and the form is redrawn with that country's own fields (never another country's labels).
  root.querySelector('[name=country]').addEventListener('change', async (e) => {
    const nc = getCountry(e.target.value);
    if (!(await confirmDialog(`Switch to ${nc.name}?`, `Tax system, rates, currency, financial year and bill titles change to ${nc.name}'s. Your tax number is cleared so you can enter the ${nc.taxIdLabel}. Bills you already issued keep their original details.`, { ok: 'Switch country' }))) { e.target.value = state.business.country; return; }
    const out = JSON.parse(JSON.stringify(state.business));
    for (const k of ['name', 'legalName', 'address', 'city', 'postal', 'phone', 'email', 'website', 'footer']) { const el = root.querySelector(`[name=${k}]`); if (el) out[k] = el.value.trim(); }
    Object.assign(out, {
      country: nc.code, taxes: JSON.parse(JSON.stringify(nc.presets)), defaultTaxId: defaultPreset(nc.presets)?.id || '', taxId: '', secondaryId: '',
      currency: nc.currency, locale: nc.locale, fyStartMonth: nc.fyStartMonth, region: '', taxScheme: 'regular', showHsn: !!nc.showHsn, roundOff: nc.code === 'IN', upi: nc.code === 'IN' ? out.upi : '',
    });
    await saveBusiness(out);
    toast(`Switched to ${nc.name} — please complete your tax details`, 'info');
  });

  const save = async () => {
    const out = JSON.parse(JSON.stringify(state.business));
    root.querySelectorAll('[name]').forEach((el) => {
      const v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.name.startsWith('bank.')) { out.bank = out.bank || {}; out.bank[el.name.slice(5)] = String(v).trim(); } else out[el.name] = typeof v === 'string' ? v.trim() : v;
    });
    out.fyStartMonth = Number(out.fyStartMonth);
    out.paymentTermsDays = Number(out.paymentTermsDays) || 0;
    out.taxId = (out.taxId || '').toUpperCase();
    if (!out.name) { toast('Business name is required', 'err'); return; }
    if (!taxIdRule(out.country, out.taxScheme).show) out.taxId = '';
    out.taxId = String(out.taxId || '').toUpperCase().replace(/\s/g, '');
    { const err = businessTaxError(out); if (err) { toast(err, 'err'); return; } }
    if (!validateEmail(out.email)) { toast('Email looks wrong', 'err'); return; }
    if (c.code === 'IN' && out.secondaryId && !validatePAN(out.secondaryId).ok) toast('PAN format looks unusual — saved anyway', 'info');
    await saveBusiness(out);
    const pending = businessTaxError(out);
    toast(pending ? `Saved. ${pending}` : 'Business profile saved', pending ? 'err' : 'ok');
  };
  root.querySelectorAll('[data-save]').forEach((x) => x.addEventListener('click', save));
}
