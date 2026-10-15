// Amount in words — international (million/billion) and Indian (lakh/crore) systems.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}
function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

export function numberToWords(n, system = 'intl') {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts = [];
  if (system === 'indian') {
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thousand = Math.floor(n / 1e3); n %= 1e3;
    if (crore) parts.push(numberToWords(crore, 'indian') + ' Crore');
    if (lakh) parts.push(below100(lakh) + ' Lakh');
    if (thousand) parts.push(below100(thousand) + ' Thousand');
    if (n) parts.push(below1000(n));
  } else {
    const scales = [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
    for (const [v, name] of scales) {
      if (n >= v) { parts.push(below1000(Math.floor(n / v)) + ' ' + name); n %= v; }
    }
    if (n) parts.push(below1000(n));
  }
  return parts.join(' ');
}

const UNITS = {
  INR: ['Rupees', 'Paise'], USD: ['Dollars', 'Cents'], CAD: ['Canadian Dollars', 'Cents'], AUD: ['Australian Dollars', 'Cents'],
  NZD: ['New Zealand Dollars', 'Cents'], SGD: ['Singapore Dollars', 'Cents'], HKD: ['Hong Kong Dollars', 'Cents'],
  EUR: ['Euros', 'Cents'], GBP: ['Pounds', 'Pence'], AED: ['Dirhams', 'Fils'], SAR: ['Riyals', 'Halalas'],
  QAR: ['Riyals', 'Dirhams'], OMR: ['Rials', 'Baisa'], BHD: ['Dinars', 'Fils'], KWD: ['Dinars', 'Fils'],
  JPY: ['Yen', ''], CNY: ['Yuan', 'Fen'], CHF: ['Francs', 'Rappen'], ZAR: ['Rand', 'Cents'], NGN: ['Naira', 'Kobo'],
  KES: ['Shillings', 'Cents'], PKR: ['Rupees', 'Paisa'], NPR: ['Rupees', 'Paisa'], LKR: ['Rupees', 'Cents'],
  BDT: ['Taka', 'Poisha'], MYR: ['Ringgit', 'Sen'], PHP: ['Pesos', 'Centavos'], MXN: ['Pesos', 'Centavos'],
  BRL: ['Reais', 'Centavos'], IDR: ['Rupiah', ''], THB: ['Baht', 'Satang'], SEK: ['Kronor', 'Öre'],
  NOK: ['Kroner', 'Øre'], DKK: ['Kroner', 'Øre'], PLN: ['Zloty', 'Groszy'],
};

export function amountInWords(amount, currency = 'USD', system = 'intl') {
  const [major, minor] = UNITS[currency] || [currency, ''];
  const abs = Math.abs(Number(amount) || 0);
  const whole = Math.floor(abs + 1e-9);
  const dp = currency === 'OMR' || currency === 'BHD' || currency === 'KWD' ? 1000 : 100;
  const frac = Math.round((abs - whole) * dp);
  let s = `${numberToWords(whole, system)} ${major}`;
  if (frac && minor) s += ` and ${numberToWords(frac, system)} ${minor}`;
  return (amount < 0 ? 'Minus ' : '') + s + ' Only';
}
