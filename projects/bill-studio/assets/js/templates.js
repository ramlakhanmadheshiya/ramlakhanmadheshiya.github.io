// Built-in bill templates. A template is a page plus absolutely-positioned blocks
// (px on an A4 page at 96 dpi: 794 × 1123). Users duplicate and freely edit them.
import { uid } from './db.js';

export const PAGE = { w: 794, h: 1123 };

export const BLOCK_TYPES = {
  logo: { label: 'Logo', icon: 'image', w: 90, h: 70 },
  business: { label: 'Business details', icon: 'building-2', w: 320, h: 100, grow: true },
  title: { label: 'Document title', icon: 'type', w: 280, h: 44 },
  meta: { label: 'Bill number & dates', icon: 'hash', w: 260, h: 90, grow: true },
  billto: { label: 'Bill to', icon: 'users', w: 320, h: 110, grow: true },
  shipto: { label: 'Ship to', icon: 'package', w: 320, h: 90, grow: true },
  items: { label: 'Items table', icon: 'table', w: 698, h: 160, grow: true },
  totals: { label: 'Totals', icon: 'list', w: 280, h: 150, grow: true },
  taxsummary: { label: 'Tax summary', icon: 'layers', w: 400, h: 80, grow: true },
  words: { label: 'Amount in words', icon: 'type', w: 380, h: 40, grow: true },
  bank: { label: 'Bank & payment', icon: 'banknote', w: 300, h: 100, grow: true },
  qr: { label: 'Payment QR', icon: 'qr-code', w: 100, h: 116 },
  notes: { label: 'Notes', icon: 'pencil', w: 400, h: 60, grow: true },
  terms: { label: 'Terms', icon: 'file-text', w: 400, h: 80, grow: true },
  signature: { label: 'Signature', icon: 'pen-tool', w: 200, h: 100 },
  text: { label: 'Text', icon: 'type', w: 240, h: 30, grow: true },
  image: { label: 'Image', icon: 'image', w: 120, h: 80 },
  shape: { label: 'Shape', icon: 'square', w: 200, h: 80 },
  line: { label: 'Line', icon: 'minus', w: 300, h: 2 },
};

let zc = 1;
export function B(type, x, y, w, h, style = {}, props = {}) {
  return { id: uid('b_'), type, x, y, w, h, z: zc++, hidden: false, locked: false, style: { ...style }, props: { ...props } };
}

const GRAY = '#6e6e73';

function cupertino() {
  return {
    id: 'tpl-cupertino', builtin: true, name: 'Cupertino', description: 'Clean and airy, with generous white space.',
    accent: '#0071e3', font: 'system', page: { ...PAGE, bg: '#ffffff' },
    blocks: [
      B('logo', 48, 48, 72, 72),
      B('business', 136, 50, 320, 104, { fontSize: 11, color: GRAY }, { nameSize: 20 }),
      B('title', 466, 44, 280, 46, { fontSize: 30, weight: 600, align: 'right' }),
      B('meta', 466, 98, 280, 92, { fontSize: 11.5, align: 'right' }),
      B('line', 48, 204, 698, 1, { bg: '#e5e5ea' }),
      B('billto', 48, 222, 330, 110, { fontSize: 12 }),
      B('shipto', 416, 222, 330, 110, { fontSize: 12 }),
      B('items', 48, 344, 698, 150, { fontSize: 11.5 }, { header: 'line' }),
      B('words', 48, 512, 380, 40, { fontSize: 11, color: GRAY }),
      B('totals', 466, 512, 280, 150, { fontSize: 12 }, { totalStyle: 'accent' }),
      B('taxsummary', 48, 562, 380, 80, { fontSize: 10.5 }, { mode: 'rate' }),
      B('bank', 48, 690, 290, 104, { fontSize: 11 }),
      B('qr', 352, 690, 96, 116, { fontSize: 9, align: 'center', color: GRAY }),
      B('notes', 48, 824, 420, 60, { fontSize: 11 }),
      B('terms', 48, 890, 420, 90, { fontSize: 10.5, color: GRAY }),
      B('signature', 546, 870, 200, 100, { fontSize: 11, align: 'center' }),
      B('text', 48, 1066, 698, 24, { fontSize: 11, color: GRAY, align: 'center' }, { text: '{{business.footer}}', anchor: 'bottom' }),
    ],
  };
}

function classic() {
  return {
    id: 'tpl-classic', builtin: true, name: 'Classic GST', description: 'Formal boxed layout with HSN tax summary — ideal for GST.',
    accent: '#1d3a8a', font: 'system', page: { ...PAGE, bg: '#ffffff' },
    blocks: [
      B('shape', 24, 24, 746, 1075, { bg: 'transparent', borderColor: '#1d1d1f', borderWidth: 1 }, { fullHeight: true }),
      B('shape', 24, 24, 746, 36, { bg: 'accent' }),
      B('title', 24, 24, 746, 36, { fontSize: 15, weight: 700, align: 'center', color: '#ffffff', uppercase: true, letterSpacing: 2 }, { showCopy: true }),
      B('logo', 40, 74, 84, 84),
      B('business', 136, 72, 420, 104, { fontSize: 11 }, { nameSize: 22 }),
      B('meta', 566, 74, 188, 104, { fontSize: 11 }),
      B('line', 24, 186, 746, 1, { bg: '#1d1d1f' }),
      B('billto', 40, 196, 350, 112, { fontSize: 11.5 }),
      B('shipto', 404, 196, 350, 112, { fontSize: 11.5 }),
      B('items', 40, 318, 714, 150, { fontSize: 11 }, { header: 'filled', grid: true }),
      B('taxsummary', 40, 480, 440, 90, { fontSize: 10 }, { mode: 'hsn' }),
      B('totals', 494, 480, 260, 150, { fontSize: 11.5 }, { totalStyle: 'filled' }),
      B('words', 40, 580, 440, 44, { fontSize: 11, weight: 500 }),
      B('bank', 40, 640, 300, 104, { fontSize: 11 }),
      B('qr', 352, 640, 104, 120, { fontSize: 9, align: 'center' }),
      B('terms', 40, 776, 440, 100, { fontSize: 10.5 }),
      B('signature', 534, 766, 220, 110, { fontSize: 11, align: 'center' }),
      B('text', 40, 1060, 714, 22, { fontSize: 10, color: GRAY, align: 'center' }, { text: 'This is a computer-generated document.', anchor: 'bottom' }),
    ],
  };
}

function minimal() {
  return {
    id: 'tpl-minimal', builtin: true, name: 'Minimal', description: 'Monochrome and typographic. Lets the numbers speak.',
    accent: '#1d1d1f', font: 'inter', page: { ...PAGE, bg: '#ffffff' },
    blocks: [
      B('title', 64, 64, 320, 44, { fontSize: 28, weight: 300, letterSpacing: -0.5 }),
      B('meta', 64, 114, 320, 80, { fontSize: 11 }, { layout: 'stack' }),
      B('logo', 626, 60, 104, 56, { align: 'right' }),
      B('business', 410, 126, 320, 110, { fontSize: 11, align: 'right', color: GRAY }, { nameSize: 14 }),
      B('billto', 64, 250, 320, 104, { fontSize: 12 }),
      B('shipto', 410, 250, 320, 104, { fontSize: 12, align: 'right' }),
      B('items', 64, 374, 666, 150, { fontSize: 11.5 }, { header: 'minimal' }),
      B('totals', 430, 546, 300, 150, { fontSize: 12 }, { totalStyle: 'line' }),
      B('words', 64, 546, 330, 40, { fontSize: 10.5, color: GRAY }),
      B('taxsummary', 64, 596, 330, 80, { fontSize: 10 }, { mode: 'rate' }),
      B('bank', 64, 724, 330, 100, { fontSize: 10.5 }),
      B('qr', 410, 724, 90, 108, { fontSize: 9, align: 'center', color: GRAY }),
      B('notes', 64, 846, 330, 60, { fontSize: 10.5 }),
      B('terms', 64, 914, 330, 80, { fontSize: 10, color: GRAY }),
      B('signature', 530, 900, 200, 96, { fontSize: 10.5, align: 'center' }),
      B('text', 64, 1062, 666, 22, { fontSize: 10.5, color: GRAY }, { text: '{{business.footer}}', anchor: 'bottom' }),
    ],
  };
}

function bold() {
  return {
    id: 'tpl-bold', builtin: true, name: 'Bold', description: 'Confident colour header that carries your brand.',
    accent: '#5e2ca5', font: 'system', page: { ...PAGE, bg: '#ffffff' },
    blocks: [
      B('shape', 0, 0, 794, 206, { bg: 'accent' }),
      B('logo', 48, 44, 68, 68, { bg: '#ffffff', radius: 14, padding: 6 }),
      B('business', 130, 44, 340, 128, { fontSize: 11, color: '#ffffff' }, { nameSize: 20 }),
      B('title', 476, 38, 270, 52, { fontSize: 34, weight: 800, align: 'right', color: '#ffffff', uppercase: true, letterSpacing: 1 }),
      B('meta', 476, 98, 270, 94, { fontSize: 11.5, align: 'right', color: '#ffffff' }),
      B('billto', 48, 232, 340, 110, { fontSize: 12 }),
      B('shipto', 406, 232, 340, 110, { fontSize: 12 }),
      B('items', 48, 352, 698, 150, { fontSize: 11.5 }, { header: 'soft', rounded: true }),
      B('words', 48, 524, 380, 44, { fontSize: 11, color: GRAY }),
      B('totals', 466, 524, 280, 160, { fontSize: 12 }, { totalStyle: 'filled' }),
      B('taxsummary', 48, 576, 380, 80, { fontSize: 10.5 }, { mode: 'rate' }),
      B('bank', 48, 704, 296, 110, { fontSize: 11 }),
      B('qr', 356, 704, 100, 116, { fontSize: 9, align: 'center', color: GRAY }),
      B('terms', 48, 836, 420, 90, { fontSize: 10.5, color: GRAY }),
      B('signature', 546, 840, 200, 100, { fontSize: 11, align: 'center' }),
      B('shape', 0, 1083, 794, 40, { bg: 'accent' }, { anchor: 'bottom' }),
      B('text', 48, 1092, 698, 22, { fontSize: 11, color: '#ffffff', align: 'center', weight: 500 }, { text: '{{business.footer}}', anchor: 'bottom' }),
    ],
  };
}

function elegant() {
  return {
    id: 'tpl-elegant', builtin: true, name: 'Elegant', description: 'Serif type and gold accents for boutique brands.',
    accent: '#a67c37', font: 'serif', page: { ...PAGE, bg: '#ffffff' },
    blocks: [
      B('logo', 367, 40, 60, 60, { align: 'center' }),
      B('business', 48, 108, 698, 96, { fontSize: 11, align: 'center', color: GRAY }, { nameSize: 22 }),
      B('line', 48, 212, 698, 1, { bg: 'accent' }),
      B('line', 48, 216, 698, 1, { bg: 'accent' }),
      B('title', 48, 232, 698, 40, { fontSize: 20, weight: 500, align: 'center', color: 'accent', uppercase: true, letterSpacing: 6 }),
      B('billto', 48, 290, 340, 110, { fontSize: 12 }),
      B('meta', 406, 290, 340, 110, { fontSize: 11.5, align: 'right' }),
      B('items', 48, 410, 698, 150, { fontSize: 11.5 }, { header: 'accentline' }),
      B('words', 48, 584, 380, 44, { fontSize: 11, color: GRAY }),
      B('totals', 466, 584, 280, 150, { fontSize: 12 }, { totalStyle: 'line' }),
      B('taxsummary', 48, 636, 380, 80, { fontSize: 10.5 }, { mode: 'rate' }),
      B('bank', 48, 752, 296, 104, { fontSize: 11 }),
      B('qr', 356, 752, 96, 112, { fontSize: 9, align: 'center', color: GRAY }),
      B('terms', 48, 882, 400, 90, { fontSize: 10.5, color: GRAY }),
      B('signature', 546, 882, 200, 100, { fontSize: 11, align: 'center' }),
      B('text', 48, 1064, 698, 24, { fontSize: 12, color: 'accent', align: 'center', italic: true }, { text: '{{business.footer}}', anchor: 'bottom' }),
    ],
  };
}

export const BUILTIN_TEMPLATES = [cupertino(), classic(), minimal(), bold(), elegant()];

export function builtinById(id) { return BUILTIN_TEMPLATES.find((t) => t.id === id) || null; }

export function cloneTemplate(t, overrides = {}) {
  const c = JSON.parse(JSON.stringify(t));
  c.id = uid('tpl_'); c.builtin = false; c.basedOn = t.basedOn || t.id;
  c.blocks.forEach((b) => (b.id = uid('b_')));
  return Object.assign(c, overrides);
}

export function newBlock(type, x = 80, y = 80) {
  const d = BLOCK_TYPES[type];
  const style = { fontSize: 12 };
  const props = {};
  if (type === 'text') { props.text = 'Double-click to edit text'; }
  if (type === 'shape') { style.bg = 'accent'; style.radius = 12; style.opacity = 0.12; }
  if (type === 'line') { style.bg = '#d2d2d7'; }
  if (type === 'items') props.header = 'line';
  return B(type, x, y, d.w, d.h, style, props);
}

export const FONTS = {
  system: { label: 'SF / System', css: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'InterVar', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  inter: { label: 'Inter', css: "'InterVar', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  serif: { label: 'Serif', css: "'New York', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif" },
  rounded: { label: 'Rounded', css: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', -apple-system, sans-serif" },
  mono: { label: 'Mono', css: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" },
};
