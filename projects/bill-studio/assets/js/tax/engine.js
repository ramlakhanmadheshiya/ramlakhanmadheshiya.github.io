// Generic bill calculator. Pure function: (document, business) -> totals.
// Country rules come only from the country profile + the business's tax presets.

import { getCountry, IN_STATES } from './countries.js';
import { round, num, currencyDecimals } from '../lib/money.js';

export function isTaxRegistered(business) {
  return !['unregistered', 'composition'].includes(business?.taxScheme);
}

export function findPreset(business, id) {
  const list = business?.taxes || getCountry(business?.country).presets;
  return list.find((t) => t.id === id) || null;
}

export function presetRate(preset) {
  if (!preset) return 0;
  if (preset.gst) return num(preset.rate);
  return (preset.components || []).reduce((s, c) => s + num(c.rate), 0);
}

export function isUT(code) { return !!IN_STATES.find((s) => s.code === code)?.ut; }

// Split a preset into the components that apply to this supply.
export function componentsFor(preset, ctx) {
  if (!preset) return [];
  if (preset.gst) {
    const r = num(preset.rate);
    if (!r) return [];
    if (ctx.intraState) {
      const second = isUT(ctx.supplierRegion) ? 'UTGST' : 'SGST';
      return [{ name: 'CGST', rate: r / 2 }, { name: second, rate: r / 2 }];
    }
    return [{ name: 'IGST', rate: r }];
  }
  return (preset.components || []).filter((c) => num(c.rate) !== 0 || preset.components.length === 1)
    .map((c) => ({ name: c.name, rate: num(c.rate) }));
}

export function supplyContext(doc, business) {
  const country = getCountry(business?.country);
  const supplierRegion = business?.region || '';
  const pos = doc?.placeOfSupply || supplierRegion;
  return {
    country,
    supplierRegion,
    placeOfSupply: pos,
    // Exports and SEZ supplies are always inter-state (IGST) — IGST Act s.7(5).
    intraState: country.gst ? pos === supplierRegion && pos !== '96' && !/^(export|sez)/.test(doc?.supplyType || '') : true,
    // Zero-rated under bond / LUT: no tax charged.
    chargeTax: isTaxRegistered(business) && !doc?.taxExempt && !(doc?.reverseCharge && !country.gst) && !/_lut$/.test(doc?.supplyType || ''),
  };
}

export function lineGross(item) {
  const gross = num(item.qty) * num(item.rate);
  const d = item.discType === 'amt' ? num(item.disc) : gross * num(item.disc) / 100;
  return { gross, discount: Math.min(d, gross), net: gross - Math.min(d, gross) };
}

export function calculate(doc, business) {
  const ctx = supplyContext(doc, business);
  const currency = doc?.currency || business?.currency || ctx.country.currency;
  const dp = currencyDecimals(currency);
  const r = (v) => round(v, dp);
  const inclusive = !!doc?.inclusive;
  const items = (doc?.items || []).filter((it) => it && (it.name || num(it.qty) || num(it.rate)));

  // Pass 1: taxable value per line (before invoice-level discount)
  const lines = items.map((it) => {
    const preset = ctx.chargeTax ? findPreset(business, it.taxId) : null;
    const comps = componentsFor(preset, ctx);
    const cess = ctx.chargeTax && ctx.country.gst ? num(it.cess) : 0;
    const totalRate = comps.reduce((s, c) => s + c.rate, 0) + cess;
    const { gross, discount, net } = lineGross(it);
    const taxable = inclusive || it.inclusive ? net / (1 + totalRate / 100) : net;
    return { item: it, preset, comps, cess, totalRate, gross, discount, net, taxable };
  });

  // Invoice-level discount, spread proportionally over taxable values
  const preTaxable = lines.reduce((s, l) => s + l.taxable, 0);
  let extraDiscount = 0;
  if (num(doc?.discount)) {
    extraDiscount = doc.discountType === 'amt' ? num(doc.discount) : preTaxable * num(doc.discount) / 100;
    extraDiscount = Math.min(extraDiscount, preTaxable);
  }
  const factor = preTaxable ? (preTaxable - extraDiscount) / preTaxable : 1;

  const out = lines.map((l) => {
    const taxable = r(l.taxable * factor);
    const taxes = l.comps.map((c) => ({ name: c.name, rate: c.rate, amount: r(taxable * c.rate / 100) }));
    if (l.cess) taxes.push({ name: 'Cess', rate: l.cess, amount: r(taxable * l.cess / 100) });
    const tax = taxes.reduce((s, t) => s + t.amount, 0);
    return {
      ...l.item, gross: r(l.gross), discountAmt: r(l.discount), taxable, taxes, tax: r(tax),
      taxRate: l.totalRate - l.cess, cessRate: l.cess, total: r(taxable + tax),
    };
  });

  // Extra charges (shipping, packing...) — always tax-exclusive
  const charges = (doc?.charges || []).filter((c) => num(c.amount)).map((c) => {
    const preset = ctx.chargeTax ? findPreset(business, c.taxId) : null;
    const comps = componentsFor(preset, ctx);
    const taxable = r(num(c.amount));
    const taxes = comps.map((x) => ({ name: x.name, rate: x.rate, amount: r(taxable * x.rate / 100) }));
    const tax = r(taxes.reduce((s, t) => s + t.amount, 0));
    return { ...c, taxable, taxes, tax, taxRate: comps.reduce((s, x) => s + x.rate, 0), total: r(taxable + tax) };
  });

  // Summaries
  const byComponent = new Map(), byRate = new Map(), byHsn = new Map();
  for (const l of [...out, ...charges]) {
    for (const t of l.taxes) {
      const k = `${t.name}|${t.rate}`;
      const e = byComponent.get(k) || { name: t.name, rate: t.rate, taxable: 0, amount: 0 };
      e.taxable += l.taxable; e.amount += t.amount; byComponent.set(k, e);
    }
    const rk = l.taxRate;
    const e = byRate.get(rk) || { rate: rk, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, other: 0, tax: 0 };
    e.taxable += l.taxable;
    for (const t of l.taxes) {
      const key = t.name === 'CGST' ? 'cgst' : (t.name === 'SGST' || t.name === 'UTGST') ? 'sgst' : t.name === 'IGST' ? 'igst' : t.name === 'Cess' ? 'cess' : 'other';
      e[key] += t.amount; e.tax += t.amount;
    }
    byRate.set(rk, e);
  }
  for (const l of [...out, ...charges.map((c) => ({ ...c, hsn: c.hsn || '', qty: 0, unit: 'OTH' }))]) {
    const hk = `${l.hsn || '—'}|${l.taxRate}`;
    const e = byHsn.get(hk) || { hsn: l.hsn || '', rate: l.taxRate, unit: l.unit || '', qty: 0, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    e.qty += num(l.qty); e.taxable += l.taxable; e.tax += l.tax;
    for (const t of l.taxes) {
      if (t.name === 'CGST') e.cgst += t.amount; else if (t.name === 'SGST' || t.name === 'UTGST') e.sgst += t.amount;
      else if (t.name === 'IGST') e.igst += t.amount; else if (t.name === 'Cess') e.cess += t.amount;
    }
    byHsn.set(hk, e);
  }
  const fix = (o) => { for (const k in o) if (typeof o[k] === 'number' && k !== 'rate' && k !== 'qty') o[k] = r(o[k]); return o; };

  const itemsGross = r(out.reduce((s, l) => s + l.gross, 0));
  const lineDiscount = r(out.reduce((s, l) => s + l.discountAmt, 0));
  const taxable = r(out.reduce((s, l) => s + l.taxable, 0) + charges.reduce((s, c) => s + c.taxable, 0));
  let tax = r(out.reduce((s, l) => s + l.tax, 0) + charges.reduce((s, c) => s + c.tax, 0));
  // Japan (qualified invoices): tax is rounded once per rate on the invoice total, not per line.
  if (ctx.country.taxRoundPerInvoice) {
    for (const e of byComponent.values()) e.amount = Math.floor((e.taxable * e.rate / 100) * 10 ** dp + 1e-9) / 10 ** dp;
    for (const e of byRate.values()) { e.tax = Math.floor((e.taxable * e.rate / 100) * 10 ** dp + 1e-9) / 10 ** dp; e.other = e.tax; }
    tax = r([...byComponent.values()].reduce((s, e) => s + e.amount, 0));
  }
  // Indian reverse charge: tax is shown but payable by the recipient, so it's excluded from the bill total.
  const rcmIndia = !!doc?.reverseCharge && ctx.country.gst;
  let beforeRound = r(taxable + (rcmIndia ? 0 : tax));
  let roundOff = 0;
  if (doc?.roundOff) { roundOff = r(Math.round(beforeRound) - beforeRound); }
  const total = r(beforeRound + roundOff);
  const paid = r(num(doc?.paid));

  return {
    currency, dp, inclusive, ctx,
    lines: out, charges,
    itemsGross, lineDiscount, extraDiscount: r(extraDiscount),
    // Items' value before tax and before the invoice-level discount
    subtotal: r(out.reduce((s, l) => s + l.taxable, 0) + extraDiscount),
    taxable, tax, roundOff, total,
    qty: out.reduce((s, l) => s + num(l.qty), 0),
    taxSummary: [...byComponent.values()].map(fix).sort((a, b) => a.name.localeCompare(b.name) || a.rate - b.rate),
    rateSummary: [...byRate.values()].map(fix).sort((a, b) => a.rate - b.rate),
    hsnSummary: [...byHsn.values()].map(fix),
    rcmIndia,
    paid, balance: r(total - paid),
  };
}
