// Optional demo data so a new user can explore a living app.
import { db, uid } from './db.js';
import { getCountry } from './tax/countries.js';
import { gstinChecksum } from './lib/validators.js';
import { addDays, todayISO } from './lib/dates.js';
import { saveDocument, blankDoc, blankItem, state } from './store.js';

export async function seedSample(business) {
  const c = getCountry(business.country);
  const m = business.currency === 'INR' ? 80 : ['JPY', 'IDR', 'VND', 'KRW'].includes(business.currency) ? 150 : 1;
  const tax = business.defaultTaxId || business.taxes[0]?.id || '';
  const rateOf = (t) => Number(t.rate ?? t.components?.[0]?.rate ?? 0);
  const lowTax = (business.taxes.find((t) => rateOf(t) === 5 && t.id !== tax) || business.taxes.filter((t) => rateOf(t) > 0 && t.id !== tax).sort((a, b) => rateOf(b) - rateOf(a))[0])?.id || tax;
  const other = c.regions ? c.regions.find((r) => r.code !== business.region && !r.ut && r.code !== '96')?.code : '';
  const sid = (n) => (c.code === 'IN' ? `${n}AABCU9603R1Z` + gstinChecksum(`${n}AABCU9603R1Z`) : '');
  const ph = (n) => (c.code === 'IN' ? `+91 98${n}0 0${n}${n}45` : `+1 555 01${n}${n}`);

  const customers = [
    { name: 'Riverside Cafe', phone: ph(3), email: 'hello@riverside.example', address: '12 Market Road', region: business.region, taxId: '' },
    { name: 'Northwind Traders', phone: ph(7), email: 'ap@northwind.example', address: '88 Harbour Street\nUnit 5', region: other || business.region, taxId: sid(other || '27') },
    { name: 'Blue Lotus Boutique', phone: ph(9), email: 'owner@bluelotus.example', address: '4 Garden Lane', region: business.region, taxId: '' },
  ];
  for (const cu of customers) { cu.businessId = business.id; cu.openingBalance = 0; await db.put('customers', cu); }

  const products = [
    ['Wireless Mouse', '8471', 'pcs', 12, tax, 40], ['USB-C Charger 30W', '8504', 'pcs', 18, tax, 25], ['Laptop Stand (Aluminium)', '7616', 'pcs', 24, tax, 12],
    ['Notebook A5 (pack of 3)', '4820', 'pack', 4, lowTax, 80], ['Installation & setup', '998713', 'hrs', 20, tax, 0], ['Annual support plan', '998716', 'service', 120, tax, 0],
  ].map(([name, hsn, unit, price, taxId, stock]) => ({
    businessId: business.id, name, hsn, unit, price: price * m, taxId, stock, trackStock: stock > 0, lowStock: 5, kind: stock > 0 ? 'goods' : 'service', sku: '',
  }));
  for (const p of products) await db.put('products', p);

  const prevBiz = state.business;
  state.business = business;
  const line = (p, qty, disc = 0) => ({ ...blankItem(business), productId: p.id, name: p.name, hsn: p.hsn, unit: p.unit, rate: p.price, qty, disc, taxId: p.taxId });
  const t = todayISO();
  const mk = async (type, cust, days, items, extra = {}, paid = 0) => {
    const d = blankDoc(business, type);
    d.date = addDays(t, -days);
    if (d.dueDate) d.dueDate = addDays(d.date, business.paymentTermsDays || 15);
    if (d.validUntil) d.validUntil = addDays(d.date, 15);
    d.customerId = cust.id;
    d.customer = { name: cust.name, address: cust.address, taxId: cust.taxId, phone: cust.phone, email: cust.email, region: cust.region };
    d.placeOfSupply = cust.region || business.region;
    d.items = items;
    Object.assign(d, extra);
    const saved = await saveDocument(d);
    if (paid) {
      const { calculate } = await import('./tax/engine.js');
      const total = calculate(saved, business).total;
      await db.put('payments', { id: uid(), businessId: business.id, documentId: saved.id, customerId: cust.id, amount: Math.round(total * paid * 100) / 100, mode: business.country === 'IN' ? 'upi' : 'bank transfer', date: addDays(saved.date, 2), reference: '', note: '' });
    }
    return saved;
  };
  await mk('invoice', customers[0], 40, [line(products[0], 4), line(products[1], 2)], {}, 1);
  await mk('invoice', customers[1], 32, [line(products[2], 10, 5), line(products[4], 6)], {}, 0);
  await mk('invoice', customers[2], 9, [line(products[3], 12), line(products[0], 2)], {}, 0.5);
  await mk('invoice', customers[1], 2, [line(products[5], 1), line(products[1], 5)]);
  await mk('quotation', customers[0], 1, [line(products[2], 3), line(products[4], 2)]);
  state.business = prevBiz || business;
}
