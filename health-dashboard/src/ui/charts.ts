/**
 * Tiny server-side SVG chart helpers. No client-side charting library:
 * marks carry data-tip attributes and /app.js shows a tooltip on tap/hover.
 * Colours come from CSS custom properties defined in layout.ts.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const W = 340;
const PAD = { l: 30, r: 8, t: 10, b: 22 };

export interface Series {
  key: string;
  label: string;
  color: string; // CSS var, e.g. "var(--s1)"
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Gridlines at a whole-number step where possible (100 → 25s, 10 → 2s, 4000 → 1000s). */
function yTicks(max: number): number[] {
  const n = [4, 5, 3, 2].find((k) => Number.isInteger(max / k)) ?? 4;
  return Array.from({ length: n + 1 }, (_, i) => (max / n) * i);
}

const fmtTick = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Rounded-top rect path anchored on the baseline (4px data-end radius). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function legend(series: Series[]): string {
  return `<div class="legend">${series
    .map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
    .join("")}</div>`;
}

export interface StackedBar {
  label: string; // x-axis label
  tip: string; // tooltip title
  values: Record<string, number | null>;
  flag?: string; // optional marker text above bar (e.g. "!")
  colorOverride?: string; // e.g. status colour for heavy days
}

export function stackedBars(opts: {
  bars: StackedBar[];
  series: Series[];
  height?: number;
  unit?: string;
  refLine?: { value: number; label: string };
  max?: number;
  fmt?: (v: number) => string;
}): string {
  const H = opts.height ?? 150;
  const { bars, series } = opts;
  const fmt = opts.fmt ?? ((v: number) => `${Math.round(v * 10) / 10}`);
  const totals = bars.map((b) => series.reduce((t, s) => t + (b.values[s.key] ?? 0), 0));
  const max = opts.max ?? niceMax(Math.max(opts.refLine?.value ?? 0, ...totals) * 1.05);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, bars.length);
  const bw = Math.min(28, slot * 0.62);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (const t of yTicks(max)) {
    out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "axis" : "grid"}"/>`;
    out += `<text x="${PAD.l - 4}" y="${y(t) + 3}" class="tick" text-anchor="end">${fmtTick(t)}</text>`;
  }
  bars.forEach((b, i) => {
    const x = PAD.l + slot * i + (slot - bw) / 2;
    let acc = 0;
    const present = series.filter((s) => (b.values[s.key] ?? 0) > 0);
    const tipLines = [b.tip, ...series.filter((s) => b.values[s.key] != null).map((s) => `${s.label}: ${fmt(b.values[s.key]!)}${opts.unit ?? ""}`)];
    present.forEach((s, j) => {
      const v = b.values[s.key]!;
      const top = y(acc + v);
      const bottom = y(acc);
      const isTop = j === present.length - 1;
      const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(0, bottom - top - gap);
      const fill = b.colorOverride ?? s.color;
      out += isTop
        ? `<path d="${barPath(x, top, bw, h, 4)}" fill="${fill}"/>`
        : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="${fill}"/>`;
      acc += v;
    });
    if (b.flag) out += `<text x="${x + bw / 2}" y="${y(totals[i]) - 4}" class="flag" text-anchor="middle">${esc(b.flag)}</text>`;
    out += `<text x="${x + bw / 2}" y="${H - 6}" class="tick" text-anchor="middle">${esc(b.label)}</text>`;
    // Hit target: full slot height, larger than the mark.
    out += `<rect x="${PAD.l + slot * i}" y="${PAD.t}" width="${slot}" height="${ih}" class="hit" data-tip="${esc(tipLines.join("\n"))}"/>`;
  });
  if (opts.refLine) {
    const ry = y(opts.refLine.value);
    out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${ry}" y2="${ry}" class="ref"/>`;
    out += `<text x="${W - PAD.r}" y="${ry - 3}" class="tick" text-anchor="end">${esc(opts.refLine.label)}</text>`;
  }
  return out + "</svg>";
}

export interface LinePoint {
  label: string;
  value: number | null;
  tip?: string;
}

/**
 * Daily dots + rolling-average line, with an optional dashed baseline.
 * One measure, one axis.
 */
export function trendChart(opts: {
  points: LinePoint[];
  rolling: (number | null)[];
  baseline?: number | null;
  unit: string;
  color: string;
  height?: number;
  everyNthLabel?: number;
}): string {
  const H = opts.height ?? 150;
  const vals = [...opts.points.map((p) => p.value), ...opts.rolling, opts.baseline ?? null].filter((v): v is number => v != null);
  if (!vals.length) return `<p class="empty">No data yet</p>`;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = Math.max(hi - lo, Math.max(1, hi * 0.08));
  lo = Math.floor(lo - span * 0.15);
  hi = Math.ceil(hi + span * 0.15);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const n = opts.points.length;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) / 3) * k;
    out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" class="${k === 0 ? "axis" : "grid"}"/>`;
    out += `<text x="${PAD.l - 4}" y="${y(v) + 3}" class="tick" text-anchor="end">${Math.round(v)}</text>`;
  }
  if (opts.baseline != null) {
    out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(opts.baseline)}" y2="${y(opts.baseline)}" class="ref"/>`;
  }
  // Rolling average line (2px), broken where data is missing.
  let d = "";
  opts.rolling.forEach((v, i) => {
    if (v == null) return;
    d += `${d && opts.rolling[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (d) out += `<path d="${d}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  opts.points.forEach((p, i) => {
    if (p.value != null) out += `<circle cx="${x(i)}" cy="${y(p.value)}" r="3.2" fill="${opts.color}" fill-opacity="0.55" stroke="var(--surface)" stroke-width="1"/>`;
    const every = opts.everyNthLabel ?? 7;
    if ((n - 1 - i) % every === 0) out += `<text x="${x(i)}" y="${H - 6}" class="tick" text-anchor="middle">${esc(p.label)}</text>`;
    const tip = p.tip ?? `${p.label}: ${p.value == null ? "no data" : `${Math.round(p.value * 10) / 10} ${opts.unit}`}`;
    const hw = n <= 1 ? iw : iw / (n - 1);
    out += `<rect x="${x(i) - hw / 2}" y="${PAD.t}" width="${hw}" height="${ih}" class="hit" data-tip="${esc(tip)}"/>`;
  });
  return out + "</svg>";
}

export function sparkline(values: (number | null)[], color: string): string {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return "";
  const w = 96, h = 26;
  const lo = Math.min(...v), hi = Math.max(...v);
  const n = values.length;
  let d = "";
  values.forEach((val, i) => {
    if (val == null) return;
    const px = (w * i) / (n - 1);
    const py = h - 3 - ((val - lo) / (hi - lo || 1)) * (h - 6);
    d += `${d ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** Readiness ring. */
export function ring(score: number | null, toneVar: string): string {
  const r = 52, c = 2 * Math.PI * r;
  const frac = score == null ? 0 : score / 100;
  return `<svg viewBox="0 0 128 128" class="ring" aria-hidden="true">
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--grid)" stroke-width="10"/>
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="${toneVar}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/>
  </svg>`;
}

/**
 * Sleep window per night on a 20:00 → 12:00 axis (bed → wake), to show
 * consistency at a glance.
 */
export function sleepWindows(nights: { label: string; bedMin: number | null; wakeMin: number | null; tip: string }[], color: string): string {
  // Minutes measured from 12:00 (noon); axis spans 20:00 (480) → 12:00 next day (1440).
  const A0 = 480, A1 = 1440;
  const rowH = 14, top = 6;
  const H = top + nights.length * rowH + 20;
  const iw = W - PAD.l - PAD.r;
  const x = (m: number) => PAD.l + ((Math.min(A1, Math.max(A0, m)) - A0) / (A1 - A0)) * iw;
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (const [m, lab] of [[480, "20:00"], [720, "00:00"], [960, "04:00"], [1200, "08:00"], [1440, "12:00"]] as const) {
    out += `<line x1="${x(m)}" x2="${x(m)}" y1="${top}" y2="${H - 18}" class="grid"/>`;
    out += `<text x="${x(m)}" y="${H - 6}" class="tick" text-anchor="middle">${lab}</text>`;
  }
  nights.forEach((n, i) => {
    const cy = top + i * rowH + rowH / 2;
    out += `<text x="${PAD.l - 4}" y="${cy + 3}" class="tick" text-anchor="end">${esc(n.label)}</text>`;
    if (n.bedMin != null && n.wakeMin != null) {
      const x0 = x(n.bedMin), x1 = x(n.wakeMin);
      out += `<rect x="${x0}" y="${cy - 4}" width="${Math.max(2, x1 - x0)}" height="8" rx="4" fill="${color}"/>`;
    }
    out += `<rect x="${PAD.l}" y="${cy - rowH / 2}" width="${iw}" height="${rowH}" class="hit" data-tip="${esc(n.tip)}"/>`;
  });
  return out + "</svg>";
}
