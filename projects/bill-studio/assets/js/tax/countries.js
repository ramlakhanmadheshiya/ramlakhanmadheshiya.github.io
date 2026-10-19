// Country profiles. Rates are sensible defaults (October 2026) and are always
// editable per business in Settings → Taxes. Never hard-code tax logic elsewhere.

export const IN_STATES = [
  ['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh', 'UT'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra & Nagar Haveli and Daman & Diu', 'UT'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep', 'UT'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman & Nicobar Islands', 'UT'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh', 'UT'],
  ['97', 'Other Territory', 'UT'], ['96', 'Other Country (Export)'],
].map(([code, name, ut]) => ({ code, name, ut: !!ut }));

const p = (id, label, components) => ({ id, label, components });
const single = (name, rate) => p(`${name}-${rate}`.toLowerCase().replace(/[^a-z0-9.-]/g, ''), `${name} ${rate}%`, [{ name, rate }]);
const zero = (name) => p('exempt', `Exempt / ${name} 0%`, []);

function vat(code, name, flag, currency, locale, rates, extra = {}) {
  return {
    code, name, flag, currency, locale,
    fyStartMonth: 1, taxName: 'VAT', taxIdLabel: 'VAT No.',
    presets: [...rates.map((r) => single('VAT', r)), zero('VAT')],
    docTitle: { registered: 'VAT Invoice', unregistered: 'Invoice' },
    numberSystem: 'intl', qr: currency === 'EUR' ? 'epc' : null,
    showHsn: false, eu: true, ...extra,
  };
}

function gstLike(code, name, flag, currency, locale, rates, extra = {}) {
  return {
    code, name, flag, currency, locale, fyStartMonth: 1, taxName: 'GST', taxIdLabel: 'GST Reg. No.',
    presets: [...rates.map((r) => single('GST', r)), zero('GST')],
    docTitle: { registered: 'Tax Invoice', unregistered: 'Invoice' },
    numberSystem: 'intl', qr: null, showHsn: false, ...extra,
  };
}

export const COUNTRIES = {
  IN: {
    code: 'IN', name: 'India', flag: '🇮🇳', currency: 'INR', locale: 'en-IN',
    fyStartMonth: 4, taxName: 'GST', taxIdLabel: 'GSTIN', secondaryIdLabel: 'PAN',
    regionLabel: 'State', regions: IN_STATES,
    presets: [0, 0.25, 3, 5, 18, 40].map((r) => ({ id: `gst${r}`, label: `GST ${r}%`, rate: r, gst: true })),
    docTitle: { registered: 'Tax Invoice', composition: 'Bill of Supply', unregistered: 'Invoice' },
    numberSystem: 'indian', qr: 'upi', showHsn: true, hsnLabel: 'HSN/SAC', gst: true,
    maxNumberLength: 16,
    notes: 'CGST + SGST/UTGST for intra-state supply, IGST for inter-state. Composition dealers issue a Bill of Supply.',
  },
  US: {
    code: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD', locale: 'en-US',
    fyStartMonth: 1, taxName: 'Sales tax', taxIdLabel: 'EIN / Tax ID',
    presets: [p('sales', 'Sales tax 0%', [{ name: 'Sales tax', rate: 0 }]), p('exempt', 'Tax exempt', [])],
    docTitle: { registered: 'Invoice', unregistered: 'Invoice' }, numberSystem: 'intl', qr: null, showHsn: false,
    notes: 'No federal sales tax. Set your combined state + local rate in Settings → Taxes.',
  },
  GB: vat('GB', 'United Kingdom', '🇬🇧', 'GBP', 'en-GB', [20, 5], { eu: false, fyStartMonth: 4 }),
  CA: {
    code: 'CA', name: 'Canada', flag: '🇨🇦', currency: 'CAD', locale: 'en-CA', fyStartMonth: 1,
    taxName: 'Sales tax', taxIdLabel: 'GST/HST No.',
    presets: [
      p('gst5', 'GST 5% (AB, territories)', [{ name: 'GST', rate: 5 }]),
      p('hst13', 'HST 13% (ON)', [{ name: 'HST', rate: 13 }]),
      p('hst14', 'HST 14% (NS)', [{ name: 'HST', rate: 14 }]),
      p('hst15', 'HST 15% (NB, NL, PE)', [{ name: 'HST', rate: 15 }]),
      p('bc', 'GST 5% + PST 7% (BC)', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 7 }]),
      p('mb', 'GST 5% + RST 7% (MB)', [{ name: 'GST', rate: 5 }, { name: 'RST', rate: 7 }]),
      p('sk', 'GST 5% + PST 6% (SK)', [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 6 }]),
      p('qc', 'GST 5% + QST 9.975% (QC)', [{ name: 'GST', rate: 5 }, { name: 'QST', rate: 9.975 }]),
      zero('GST'),
    ],
    docTitle: { registered: 'Invoice', unregistered: 'Invoice' }, numberSystem: 'intl', qr: null, showHsn: false,
  },
  AU: gstLike('AU', 'Australia', '🇦🇺', 'AUD', 'en-AU', [10], { fyStartMonth: 7, taxIdLabel: 'ABN',
    notes: 'A tax invoice over A$1,000 must show the buyer’s identity or ABN.' }),
  NZ: gstLike('NZ', 'New Zealand', '🇳🇿', 'NZD', 'en-NZ', [15], { fyStartMonth: 4, taxIdLabel: 'GST No.', docTitle: { registered: 'Tax Invoice', unregistered: 'Invoice' } }),
  SG: gstLike('SG', 'Singapore', '🇸🇬', 'SGD', 'en-SG', [9], { taxIdLabel: 'GST Reg. No.' }),
  MY: { ...gstLike('MY', 'Malaysia', '🇲🇾', 'MYR', 'en-MY', [], { taxName: 'SST', taxIdLabel: 'SST No.' }),
    presets: [single('Sales tax', 10), single('Sales tax', 5), single('Service tax', 8), single('Service tax', 6), zero('SST')] },
  AE: vat('AE', 'United Arab Emirates', '🇦🇪', 'AED', 'en-AE', [5], { eu: false, taxIdLabel: 'TRN', docTitle: { registered: 'Tax Invoice', unregistered: 'Invoice' } }),
  SA: vat('SA', 'Saudi Arabia', '🇸🇦', 'SAR', 'en-SA', [15], { eu: false, qr: 'zatca', taxIdLabel: 'VAT No.', docTitle: { registered: 'Tax Invoice', unregistered: 'Invoice' } }),
  BH: vat('BH', 'Bahrain', '🇧🇭', 'BHD', 'en-BH', [10], { eu: false }),
  OM: vat('OM', 'Oman', '🇴🇲', 'OMR', 'en-OM', [5], { eu: false }),
  JP: {
    code: 'JP', name: 'Japan', flag: '🇯🇵', currency: 'JPY', locale: 'ja-JP', fyStartMonth: 4,
    taxName: 'Consumption tax', taxIdLabel: 'Registration No. (T + 13 digits)',
    presets: [single('Consumption tax', 10), p('ct8', 'Consumption tax 8% (reduced)', [{ name: 'Consumption tax (reduced)', rate: 8 }]), zero('tax')],
    docTitle: { registered: 'Qualified Invoice', unregistered: 'Invoice' }, numberSystem: 'intl', qr: null, showHsn: false,
  },
  CH: vat('CH', 'Switzerland', '🇨🇭', 'CHF', 'de-CH', [8.1, 3.8, 2.6], { eu: false, taxIdLabel: 'UID / MWST No.' }),
  NO: vat('NO', 'Norway', '🇳🇴', 'NOK', 'nb-NO', [25, 15, 12], { eu: false, taxIdLabel: 'Org. No. MVA' }),
  DE: vat('DE', 'Germany', '🇩🇪', 'EUR', 'de-DE', [19, 7], { taxIdLabel: 'USt-IdNr.' }),
  FR: vat('FR', 'France', '🇫🇷', 'EUR', 'fr-FR', [20, 10, 5.5, 2.1], { taxIdLabel: 'N° TVA' }),
  IT: vat('IT', 'Italy', '🇮🇹', 'EUR', 'it-IT', [22, 10, 5, 4], { taxIdLabel: 'Partita IVA' }),
  ES: vat('ES', 'Spain', '🇪🇸', 'EUR', 'es-ES', [21, 10, 4], { taxIdLabel: 'NIF / IVA' }),
  NL: vat('NL', 'Netherlands', '🇳🇱', 'EUR', 'nl-NL', [21, 9], { taxIdLabel: 'Btw-id' }),
  BE: vat('BE', 'Belgium', '🇧🇪', 'EUR', 'nl-BE', [21, 12, 6]),
  AT: vat('AT', 'Austria', '🇦🇹', 'EUR', 'de-AT', [20, 13, 10], { taxIdLabel: 'UID-Nr.' }),
  IE: vat('IE', 'Ireland', '🇮🇪', 'EUR', 'en-IE', [23, 13.5, 9]),
  PT: vat('PT', 'Portugal', '🇵🇹', 'EUR', 'pt-PT', [23, 13, 6], { taxIdLabel: 'NIF' }),
  GR: vat('GR', 'Greece', '🇬🇷', 'EUR', 'el-GR', [24, 13, 6]),
  FI: vat('FI', 'Finland', '🇫🇮', 'EUR', 'fi-FI', [25.5, 13.5, 10]),
  SE: vat('SE', 'Sweden', '🇸🇪', 'SEK', 'sv-SE', [25, 12, 6], { taxIdLabel: 'Momsreg.nr' }),
  DK: vat('DK', 'Denmark', '🇩🇰', 'DKK', 'da-DK', [25], { taxIdLabel: 'CVR / SE No.' }),
  PL: vat('PL', 'Poland', '🇵🇱', 'PLN', 'pl-PL', [23, 8, 5], { taxIdLabel: 'NIP' }),
  CZ: vat('CZ', 'Czechia', '🇨🇿', 'CZK', 'cs-CZ', [21, 12], { taxIdLabel: 'DIČ' }),
  HU: vat('HU', 'Hungary', '🇭🇺', 'HUF', 'hu-HU', [27, 18, 5]),
  RO: vat('RO', 'Romania', '🇷🇴', 'RON', 'ro-RO', [21, 11], { taxIdLabel: 'CIF / CUI' }),
  SK: vat('SK', 'Slovakia', '🇸🇰', 'EUR', 'sk-SK', [23, 19, 5]),
  SI: vat('SI', 'Slovenia', '🇸🇮', 'EUR', 'sl-SI', [22, 9.5, 5]),
  HR: vat('HR', 'Croatia', '🇭🇷', 'EUR', 'hr-HR', [25, 13, 5], { taxIdLabel: 'OIB' }),
  LU: vat('LU', 'Luxembourg', '🇱🇺', 'EUR', 'fr-LU', [17, 14, 8, 3]),
  EE: vat('EE', 'Estonia', '🇪🇪', 'EUR', 'et-EE', [24, 13, 9]),
  LV: vat('LV', 'Latvia', '🇱🇻', 'EUR', 'lv-LV', [21, 12, 5]),
  LT: vat('LT', 'Lithuania', '🇱🇹', 'EUR', 'lt-LT', [21, 12, 5]),
  BG: vat('BG', 'Bulgaria', '🇧🇬', 'EUR', 'bg-BG', [20, 9]),
  CY: vat('CY', 'Cyprus', '🇨🇾', 'EUR', 'el-CY', [19, 9, 5]),
  MT: vat('MT', 'Malta', '🇲🇹', 'EUR', 'en-MT', [18, 7, 5]),
  ZA: vat('ZA', 'South Africa', '🇿🇦', 'ZAR', 'en-ZA', [15], { eu: false, fyStartMonth: 3, docTitle: { registered: 'Tax Invoice', unregistered: 'Invoice' } }),
  NG: vat('NG', 'Nigeria', '🇳🇬', 'NGN', 'en-NG', [7.5], { eu: false, taxIdLabel: 'TIN' }),
  KE: vat('KE', 'Kenya', '🇰🇪', 'KES', 'en-KE', [16, 8], { eu: false, taxIdLabel: 'KRA PIN', fyStartMonth: 7 }),
  EG: vat('EG', 'Egypt', '🇪🇬', 'EGP', 'en-EG', [14], { eu: false, taxIdLabel: 'Tax Reg. No.', fyStartMonth: 7 }),
  BD: vat('BD', 'Bangladesh', '🇧🇩', 'BDT', 'en-BD', [15, 10, 7.5, 5], { eu: false, taxIdLabel: 'BIN', fyStartMonth: 7, numberSystem: 'indian' }),
  PK: { ...vat('PK', 'Pakistan', '🇵🇰', 'PKR', 'en-PK', [18], { eu: false, taxIdLabel: 'NTN / STRN', fyStartMonth: 7, numberSystem: 'indian' }),
    taxName: 'Sales tax', presets: [single('Sales tax', 18), zero('Sales tax')] },
  NP: vat('NP', 'Nepal', '🇳🇵', 'NPR', 'en-NP', [13], { eu: false, taxIdLabel: 'PAN / VAT No.', fyStartMonth: 7, numberSystem: 'indian' }),
  LK: vat('LK', 'Sri Lanka', '🇱🇰', 'LKR', 'en-LK', [18], { eu: false, taxIdLabel: 'VAT / TIN', fyStartMonth: 4 }),
  PH: vat('PH', 'Philippines', '🇵🇭', 'PHP', 'en-PH', [12], { eu: false, taxIdLabel: 'TIN' }),
  ID: { ...vat('ID', 'Indonesia', '🇮🇩', 'IDR', 'id-ID', [12, 11], { eu: false, taxIdLabel: 'NPWP' }), taxName: 'PPN',
    presets: [single('PPN', 12), p('ppn11', 'PPN 12% on DPP 11/12 (non-luxury)', [{ name: 'PPN', rate: 11 }]), zero('PPN')] },
  TH: vat('TH', 'Thailand', '🇹🇭', 'THB', 'th-TH', [7], { eu: false, taxIdLabel: 'Tax ID' }),
  VN: vat('VN', 'Vietnam', '🇻🇳', 'VND', 'vi-VN', [10, 8, 5], { eu: false, taxIdLabel: 'MST' }),
  MX: { ...vat('MX', 'Mexico', '🇲🇽', 'MXN', 'es-MX', [16, 8], { eu: false, taxIdLabel: 'RFC' }), taxName: 'IVA',
    presets: [single('IVA', 16), single('IVA', 8), zero('IVA')] },
  BR: { ...vat('BR', 'Brazil', '🇧🇷', 'BRL', 'pt-BR', [], { eu: false, taxIdLabel: 'CNPJ / CPF' }), taxName: 'Tax',
    presets: [single('ICMS', 18), single('ISS', 5), zero('tax')],
    notes: 'Brazilian taxes vary by state and municipality; set your own rates in Settings → Taxes.' },
  OTHER: {
    code: 'OTHER', name: 'Other country', flag: '🌍', currency: 'USD', locale: 'en-US', fyStartMonth: 1,
    taxName: 'Tax', taxIdLabel: 'Tax ID', presets: [single('Tax', 10), zero('tax')],
    docTitle: { registered: 'Invoice', unregistered: 'Invoice' }, numberSystem: 'intl', qr: null, showHsn: false,
    notes: 'Pick your currency and add your own tax names and rates in Settings → Taxes.',
  },
};

export const COUNTRY_LIST = Object.values(COUNTRIES).sort((a, b) =>
  a.code === 'OTHER' ? 1 : b.code === 'OTHER' ? -1 : a.name.localeCompare(b.name));

export function getCountry(code) { return COUNTRIES[code] || COUNTRIES.OTHER; }

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'AUD', 'CAD', 'NZD', 'SGD', 'JPY', 'CNY', 'CHF', 'SEK',
  'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'ZAR', 'NGN', 'KES', 'EGP', 'BDT', 'PKR', 'NPR', 'LKR', 'MYR', 'PHP', 'IDR',
  'THB', 'VND', 'MXN', 'BRL', 'HKD', 'KRW', 'TRY', 'BHD', 'OMR', 'QAR', 'KWD', 'ILS', 'ARS', 'CLP', 'COP', 'PEN', 'GHS',
  'MAD', 'TWD'];

export const UNITS = ['pcs', 'nos', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'ft', 'sq ft', 'box', 'pack', 'dozen', 'set', 'pair',
  'hrs', 'days', 'months', 'service', 'job'];

// ---- Legal extras (2026) -------------------------------------------------
// exemptNote: wording a NOT-registered (small) business must print instead of charging tax.
const EXEMPT_NOTES = {
  FR: 'TVA non applicable, art. 293 B du CGI',
  DE: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
  AT: 'Umsatzsteuerfrei – Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG',
  IT: 'Operazione in franchigia da IVA ai sensi dell’art. 1, commi 54-89, L. 190/2014',
  BE: 'Bijzondere vrijstellingsregeling kleine ondernemingen / Régime particulier de franchise des petites entreprises',
  NL: 'Vrijgesteld van btw (kleineondernemersregeling, KOR)',
  ES: 'Operación exenta de IVA (régimen de franquicia)',
  PT: 'IVA – regime de isenção (art. 53.º do CIVA)',
  IE: 'Not registered for VAT',
  LU: 'Franchise de TVA (régime des petites entreprises)',
};
// eInvoice: countries where a PDF/paper invoice from this app is not (fully) a legal invoice.
const E_INVOICE = {
  IT: 'Italy requires e-invoices through the SdI for B2B and B2C sales. Use this bill as a proforma or customer copy; issue the legal e-invoice via SdI.',
  PL: 'Poland requires e-invoices through KSeF (from 2026; micro-businesses from 2027).',
  BE: 'Belgium requires structured Peppol e-invoices for B2B sales from 1 Jan 2026.',
  HR: 'Croatia requires fiscalised e-invoices for B2B sales from 1 Jan 2026.',
  HU: 'Hungary requires real-time invoice reporting (RTIR) to NAV.',
  PT: 'Portugal requires invoices from certified software (ATCUD and QR code).',
  FR: 'France is phasing in mandatory e-invoicing (large and mid-size firms from 1 Sep 2026; SMEs from 1 Sep 2027).',
  SA: 'Saudi Arabia requires ZATCA (Fatoora) e-invoicing. This app is not a ZATCA Phase-2 solution — use it for quotations or as a copy.',
  MX: 'Mexico requires CFDI e-invoices stamped by a PAC.',
  BR: 'Brazil requires NF-e / NFS-e electronic invoices.',
  VN: 'Vietnam requires e-invoices (Decree 123/2020).',
  EG: 'Egypt requires e-invoices through the ETA system.',
  KE: 'Kenya requires eTIMS invoices.',
  ID: 'Indonesia requires e-Faktur (Coretax) tax invoices from PKP sellers.',
  MY: 'Malaysia requires MyInvois e-invoices for businesses above RM1 million turnover.',
  IN: 'Businesses with turnover above ₹5 crore must generate an e-invoice (IRN) on the government IRP for B2B sales. Enter the IRN on the bill after generating it.',
};
for (const [k, v] of Object.entries(EXEMPT_NOTES)) if (COUNTRIES[k]) COUNTRIES[k].exemptNote = v;
for (const [k, v] of Object.entries(E_INVOICE)) if (COUNTRIES[k]) COUNTRIES[k].eInvoice = v;
COUNTRIES.DE.secondaryIdLabel = 'Steuernummer';
COUNTRIES.JP.taxRoundPerInvoice = true;
COUNTRIES.JP.reducedMark = 8;
// Bilingual titles (Arabic required on Saudi invoices; customary in the UAE)
COUNTRIES.SA.titleLocal = { 'Tax Invoice': 'فاتورة ضريبية', 'Simplified Tax Invoice': 'فاتورة ضريبية مبسطة', 'Credit Note': 'إشعار دائن', 'Debit Note': 'إشعار مدين', Invoice: 'فاتورة' };
COUNTRIES.AE.titleLocal = { 'Tax Invoice': 'فاتورة ضريبية', 'Tax Credit Note': 'إشعار دائن ضريبي', Invoice: 'فاتورة' };
COUNTRIES.VN.notes = 'The 8% reduced VAT rate applies until 31 Dec 2026.';
