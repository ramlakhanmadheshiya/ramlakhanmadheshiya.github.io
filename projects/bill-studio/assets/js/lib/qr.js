// Payment / compliance QR payloads + SVG rendering (qrcode-generator, MIT, loaded globally).

export function qrSvg(text, { margin = 0, swissCross = false } = {}) {
  if (!text || typeof window.qrcode !== 'function') return '';
  try {
    const q = window.qrcode(0, 'M');
    q.addData(unescape(encodeURIComponent(text)));
    q.make();
    let svg = q.createSvgTag({ cellSize: 4, margin, scalable: true });
    if (swissCross) {
      // Swiss QR-bill: a 7 × 7 mm Swiss cross in the centre of the 46 × 46 mm code (ECC level M absorbs it).
      const n = q.getModuleCount() * 4 + margin * 2, s = n * 7 / 46, x = (n - s) / 2, w = s * 0.19, l = s * 0.6;
      svg = svg.replace('</svg>', `<rect x="${x}" y="${x}" width="${s}" height="${s}" fill="#fff"/><rect x="${x + s * 0.06}" y="${x + s * 0.06}" width="${s * 0.88}" height="${s * 0.88}" fill="#000"/>`
        + `<rect x="${n / 2 - w / 2}" y="${n / 2 - l / 2}" width="${w}" height="${l}" fill="#fff"/><rect x="${n / 2 - l / 2}" y="${n / 2 - w / 2}" width="${l}" height="${w}" fill="#fff"/></svg>`);
    }
    return svg;
  } catch { return ''; }
}

// Swiss QR-bill payment code (Swiss Payment Standards, SPC 0200, structured addresses).
export function swissPayload({ iban, name, street, postal, town, country = 'CH', amount, currency = 'CHF', message }) {
  const L = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
  return ['SPC', '0200', '1', iban.replace(/\s/g, ''),
    'S', L(name, 70), L(street, 70), '', L(postal, 16), L(town, 35), country,
    '', '', '', '', '', '', '',
    amount > 0 ? amount.toFixed(2) : '', currency,
    '', '', '', '', '', '', '',
    'NON', '', L(message, 140), 'EPD'].join('\n');
}

export function upiPayload({ upi, name, amount, note }) {
  const p = new URLSearchParams({ pa: upi, pn: name || '', cu: 'INR' });
  if (amount > 0) p.set('am', amount.toFixed(2));
  if (note) p.set('tn', note.slice(0, 50));
  return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
}

// European Payments Council QR ("GiroCode"), SEPA credit transfer.
export function epcPayload({ name, iban, bic = '', amount, text }) {
  return ['BCD', '002', '1', 'SCT', bic, (name || '').slice(0, 70), iban.replace(/\s/g, ''),
    amount > 0 ? 'EUR' + amount.toFixed(2) : '', '', '', (text || '').slice(0, 140)].join('\n');
}

// Saudi ZATCA Phase-1 simplified invoice QR: base64 of TLV(seller, vat no, timestamp, total, vat).
export function zatcaPayload({ seller, vatNo, timestamp, total, vat }) {
  const enc = new TextEncoder();
  const parts = [seller, vatNo, timestamp, total.toFixed(2), vat.toFixed(2)].map((v, i) => {
    const b = enc.encode(String(v ?? ''));
    return [i + 1, b.length, ...b];
  }).flat();
  let bin = '';
  new Uint8Array(parts).forEach((c) => (bin += String.fromCharCode(c)));
  return btoa(bin);
}

export function paymentQR(business, country, doc, totals) {
  const amount = Math.max(0, totals?.balance ?? totals?.total ?? 0);
  const note = doc?.number ? `Bill ${doc.number}` : '';
  if (country.qr === 'zatca' && business.taxId && business.taxScheme !== 'unregistered') {
    return { payload: zatcaPayload({ seller: business.name, vatNo: business.taxId, timestamp: doc?.createdAt || new Date().toISOString(), total: totals?.total || 0, vat: totals?.tax || 0 }), caption: 'ZATCA e-invoice QR' };
  }
  if (business.upi && (country.qr === 'upi' || business.currency === 'INR')) {
    return { payload: upiPayload({ upi: business.upi, name: business.name, amount, note }), caption: `Scan to pay with any UPI app` };
  }
  const iban = String(business.bank?.iban || '').replace(/\s/g, '').toUpperCase();
  if (/^(CH|LI)\d{7}/.test(iban) && ['CHF', 'EUR'].includes(business.currency) && business.address && business.postal && business.city) {
    return { payload: swissPayload({ iban, name: business.bank.holder || business.name, street: business.address, postal: business.postal, town: business.city,
      country: iban.slice(0, 2), amount, currency: business.currency, message: note }), caption: 'Swiss QR code — scan to pay', swiss: true };
  }
  if (business.bank?.iban && (business.currency === 'EUR')) {
    return { payload: epcPayload({ name: business.bank.holder || business.name, iban: business.bank.iban, bic: business.bank.swift, amount, text: note }), caption: 'Scan with your banking app' };
  }
  if (business.payLink) return { payload: business.payLink, caption: 'Scan to pay online' };
  return null;
}
