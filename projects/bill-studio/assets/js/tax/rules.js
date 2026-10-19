// What a business must provide, depending on country and tax status.
import { getCountry } from './countries.js';
import { validateTaxId } from '../lib/validators.js';

// Countries where a registered seller is not legally required to print a tax number on invoices.
const TAX_ID_OPTIONAL = new Set(['US', 'OTHER', 'BR']);

export function taxIdRule(countryCode, scheme = 'regular') {
  const c = getCountry(countryCode);
  if (scheme === 'unregistered') return { show: false, required: false };
  if (TAX_ID_OPTIONAL.has(c.code)) return { show: true, required: false, help: c.code === 'US' ? 'Optional — US invoices don’t require a tax ID.' : 'Optional — shown on your bills.' };
  return {
    show: true, required: true,
    help: c.gst ? 'Required — it must appear on every Tax Invoice / Bill of Supply. Your state is filled from it.' : `Required — a ${c.taxName}-registered business must show it on every invoice.`,
  };
}

// Returns an error message, or '' when the business tax setup is complete and valid.
export function businessTaxError(b) {
  const c = getCountry(b.country);
  if (c.gst && !b.region) return 'Please choose your state.';
  const rule = taxIdRule(b.country, b.taxScheme);
  // Germany: even Kleinunternehmer must print their Steuernummer (§14(4) UStG).
  if (c.code === 'DE' && b.taxScheme === 'unregistered' && !String(b.secondaryId || '').trim()) return 'Please enter your Steuernummer — it must appear on every German invoice.';
  if (!rule.show) return '';
  const id = String(b.taxId || '').trim();
  if (!id) return rule.required ? `Please enter your ${c.taxIdLabel}${c.gst ? '' : ` (or choose “No” if you are not registered for ${c.taxName})`}.` : '';
  const v = validateTaxId(c.code, id);
  if (!v.ok) return v.msg;
  if (c.gst && v.state && b.region && v.state !== b.region) return `Your GSTIN belongs to state code ${v.state}, but the state selected is ${b.region}. Please correct one of them.`;
  return '';
}

// Canada: default sales-tax preset for each province / territory.
export const CA_PROVINCES = [
  ['AB', 'Alberta', 'gst5'], ['BC', 'British Columbia', 'bc'], ['MB', 'Manitoba', 'mb'], ['NB', 'New Brunswick', 'hst15'],
  ['NL', 'Newfoundland and Labrador', 'hst15'], ['NS', 'Nova Scotia', 'hst14'], ['NT', 'Northwest Territories', 'gst5'],
  ['NU', 'Nunavut', 'gst5'], ['ON', 'Ontario', 'hst13'], ['PE', 'Prince Edward Island', 'hst15'], ['QC', 'Quebec', 'qc'],
  ['SK', 'Saskatchewan', 'sk'], ['YT', 'Yukon', 'gst5'],
];
