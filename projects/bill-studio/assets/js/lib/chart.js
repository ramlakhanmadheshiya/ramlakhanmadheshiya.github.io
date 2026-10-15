// Small dependency-free SVG charts that follow the app theme.
import { esc } from '../ui.js';

export function barChart({ labels, series, format = (v) => v, height = 220 }) {
  const W = 640, H = height, padL = 54, padB = 26, padT = 10;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const nice = niceMax(max);
  const plotW = W - padL - 8, plotH = H - padB - padT;
  const groupW = plotW / labels.length;
  const barW = Math.min(26, (groupW * 0.7) / series.length);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    g += `<line class="gridline" x1="${padL}" x2="${W - 8}" y1="${y}" y2="${y}" stroke-dasharray="${i ? '2 3' : ''}"/>`;
    g += `<text class="axis" x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(format((nice * i) / 4))}</text>`;
  }
  labels.forEach((l, i) => {
    const gx = padL + groupW * i + groupW / 2;
    const total = series.length * barW + (series.length - 1) * 4;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      const h = (v / nice) * plotH;
      const x = gx - total / 2 + j * (barW + 4);
      g += `<rect class="bar" x="${x}" y="${padT + plotH - h}" width="${barW}" height="${Math.max(h, v ? 2 : 0)}" rx="${Math.min(5, barW / 2)}" style="fill:${s.color}"><title>${esc(l)} · ${esc(s.name)}: ${esc(format(v))}</title></rect>`;
    });
    g += `<text class="axis" x="${gx}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Bar chart">${g}</svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function donut(parts, size = 120) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = 15.915, c = 2 * Math.PI * r;
  let off = 0;
  const segs = parts.map((p) => {
    const len = (p.value / total) * c;
    const s = `<circle r="${r}" cx="21" cy="21" fill="none" stroke="${p.color}" stroke-width="5" stroke-dasharray="${Math.max(0, len - 0.6)} ${c - len + 0.6}" stroke-dashoffset="${-off}"><title>${esc(p.label)}</title></circle>`;
    off += len; return s;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 42 42" style="transform:rotate(-90deg)"><circle r="${r}" cx="21" cy="21" fill="none" stroke="var(--fill)" stroke-width="5"/>${segs}</svg>`;
}
