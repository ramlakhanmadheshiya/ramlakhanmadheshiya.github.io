// Free reminders & sharing via WhatsApp / SMS / email links (no server needed).
import { fmtMoney } from './money.js';
import { fmtDate } from './dates.js';

export function intlPhone(phone, country) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  const cc = { IN: '91', US: '1', CA: '1', GB: '44', AE: '971', SA: '966', AU: '61', SG: '65', NZ: '64', PK: '92', BD: '880', NP: '977', LK: '94', MY: '60', PH: '63', ID: '62', ZA: '27', NG: '234', KE: '254', DE: '49', FR: '33' }[country];
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (cc && d.length <= 10) return cc + d;
  return d;
}

export function whatsappLink(phone, text, country) {
  const p = intlPhone(phone, country);
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
export function smsLink(phone, text) { return `sms:${String(phone || '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`; }
export function mailLink(email, subject, body) { return `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }

export function reminderText({ business, customerName, due, docs = [] }) {
  const m = (v) => fmtMoney(v, business.currency, business.locale);
  const list = docs.slice(0, 5).map((d) => `• ${d.number} (${fmtDate(d.date, business.locale)}) — ${m(d.due)}`).join('\n');
  const pay = [business.upi ? `UPI: ${business.upi}` : '', business.bank?.account ? `A/c ${business.bank.account}${business.bank.code ? ` · ${business.bank.code}` : ''}` : '', business.payLink || ''].filter(Boolean).join('\n');
  return `Hello ${customerName || ''},\n\nThis is a gentle reminder from ${business.name} that ${m(due)} is outstanding on your account.${list ? `\n\n${list}` : ''}${pay ? `\n\nYou can pay via:\n${pay}` : ''}\n\nThank you!\n${business.name}${business.phone ? `\n${business.phone}` : ''}`;
}

export function billShareText({ business, doc, total, title }) {
  return `Hello ${doc.customer?.name || ''},\n\nPlease find your ${title.toLowerCase()} ${doc.number} dated ${fmtDate(doc.date, business.locale)} for ${fmtMoney(total, business.currency, business.locale)}.${business.upi ? `\n\nPay by UPI: ${business.upi}` : ''}\n\nThank you,\n${business.name}`;
}
