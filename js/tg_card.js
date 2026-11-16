'use strict';

/**
 * tg_card.js — Sleek dark-theme SVG -> PNG trade & candlestick card renderer for Telegram alerts.
 * Uses already-installed @resvg/resvg-js cleanly in memory (~25ms), with zero side effects on order execution.
 */

const FONT = 'DejaVu Sans, Segoe UI, Arial, sans-serif';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const THEMES = {
  ENTER_LONG: { accent: '#10b981', pillBg: 'rgba(16,185,129,0.18)', pillStroke: 'rgba(16,185,129,0.5)', badge: 'ENTER LONG' },
  ENTER_SHORT: { accent: '#ef4444', pillBg: 'rgba(239,68,68,0.18)', pillStroke: 'rgba(239,68,68,0.5)', badge: 'ENTER SHORT' },
  LOCK: { accent: '#f59e0b', pillBg: 'rgba(245,158,11,0.18)', pillStroke: 'rgba(245,158,11,0.5)', badge: 'PROFIT LOCK' },
  TRAIL: { accent: '#38bdf8', pillBg: 'rgba(56,189,248,0.18)', pillStroke: 'rgba(56,189,248,0.5)', badge: 'TRAIL STOP' },
  WIN: { accent: '#22c55e', pillBg: 'rgba(34,197,94,0.20)', pillStroke: 'rgba(34,197,94,0.55)', badge: 'WON EXIT' },
  LOSS: { accent: '#f43f5e', pillBg: 'rgba(244,63,94,0.18)', pillStroke: 'rgba(244,63,94,0.5)', badge: 'CLOSED EXIT' },
  INFO: { accent: '#818cf8', pillBg: 'rgba(129,140,248,0.18)', pillStroke: 'rgba(129,140,248,0.5)', badge: 'STATUS' },
};

function fmtNum(v, decimals = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function renderCandlesSvg(bars, levels, chartBox) {
  const slice = Array.isArray(bars) ? bars.slice(-48) : [];
  if (slice.length < 5) {
    return `<text x="${chartBox.x + chartBox.w / 2}" y="${chartBox.y + chartBox.h / 2}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#64748b">Awaiting bars</text>`;
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of slice) {
    if (Number.isFinite(b.l) && b.l < lo) lo = b.l;
    if (Number.isFinite(b.h) && b.h > hi) hi = b.h;
  }
  for (const lv of levels) {
    if (Number.isFinite(lv.price) && lv.price > 0) {
      // Include stop/entry/target if within 8% of visible bar range so scale doesn't crush candles
      const mid = (lo + hi) / 2;
      if (Math.abs(lv.price - mid) / (mid || 1) < 0.08) {
        lo = Math.min(lo, lv.price);
        hi = Math.max(hi, lv.price);
      }
    }
  }
  const pad = Math.max((hi - lo) * 0.12, 1e-6);
  lo -= pad;
  hi += pad;
  const span = hi - lo || 1;
  const toY = (p) => chartBox.y + chartBox.h - ((p - lo) / span) * chartBox.h;

  const out = [];
  // Subtle horizontal grid
  for (let g = 0; g <= 4; g++) {
    const gy = chartBox.y + (chartBox.h / 4) * g;
    const gp = hi - (span / 4) * g;
    out.push(`<line x1="${chartBox.x}" y1="${gy.toFixed(1)}" x2="${chartBox.x + chartBox.w}" y2="${gy.toFixed(1)}" stroke="rgba(148,163,184,0.10)" stroke-width="1"/>`);
    out.push(`<text x="${chartBox.x + chartBox.w - 4}" y="${(gy - 3).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="9.5" fill="#64748b">${esc(fmtNum(gp, gp >= 1000 ? 0 : 1))}</text>`);
  }

  // Candlesticks
  const stepX = chartBox.w / slice.length;
  const bodyW = Math.max(3, Math.min(8, stepX * 0.62));
  slice.forEach((b, idx) => {
    const cx = chartBox.x + stepX * (idx + 0.5);
    const up = b.c >= b.o;
    const col = up ? '#10b981' : '#ef4444';
    const yH = toY(b.h);
    const yL = toY(b.l);
    const yO = toY(b.o);
    const yC = toY(b.c);
    const top = Math.min(yO, yC);
    const h = Math.max(1.8, Math.abs(yO - yC));
    out.push(`<line x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${col}" stroke-width="1.2"/>`);
    out.push(`<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${col}"/>`);
  });

  // Overlay levels (Entry, SL, Lock/Target)
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const ly = toY(lv.price);
    if (ly < chartBox.y - 4 || ly > chartBox.y + chartBox.h + 4) continue;
    const clampedY = Math.max(chartBox.y + 8, Math.min(chartBox.y + chartBox.h - 6, ly));
    out.push(`<line x1="${chartBox.x}" y1="${clampedY.toFixed(1)}" x2="${chartBox.x + chartBox.w}" y2="${clampedY.toFixed(1)}" stroke="${lv.color}" stroke-width="1.4" stroke-dasharray="${lv.dash || '5 3'}"/>`);
    out.push(`<rect x="${chartBox.x + 4}" y="${(clampedY - 12).toFixed(1)}" width="${Math.max(70, lv.label.length * 6.2 + 12).toFixed(0)}" height="16" rx="4" fill="rgba(15,23,42,0.9)" stroke="${lv.color}" stroke-width="0.9"/>`);
    out.push(`<text x="${chartBox.x + 10}" y="${(clampedY - 1).toFixed(1)}" font-family="${FONT}" font-size="9.5" font-weight="700" fill="${lv.color}">${esc(lv.label)}</text>`);
  }

  return out.join('\n');
}

function buildTradeCardSvg(card = {}) {
  const kind = String(card.kind || 'INFO').toUpperCase();
  const theme = THEMES[kind] || THEMES.INFO;
  const title = card.title || 'TRADING SIGNAL';
  const subtitle = card.subtitle || '';
  const execBadge = card.execBadge || 'LIVE';
  const badgeText = card.badge || theme.badge;
  const istTime = new Date(card.ts || Date.now()).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';

  const metrics = Array.isArray(card.metrics) ? card.metrics.slice(0, 4) : [];
  const levels = Array.isArray(card.levels) ? card.levels : [];
  const chartBox = { x: 26, y: 84, w: 500, h: 312 };
  const candleSvg = renderCandlesSvg(card.bars, levels, chartBox);

  const metricBlocks = metrics.map((m, idx) => {
    const y = 84 + idx * 80;
    const valCol = m.color || '#f8fafc';
    return `
      <rect x="546" y="${y}" width="308" height="70" rx="10" fill="rgba(30,41,59,0.72)" stroke="rgba(148,163,184,0.18)" stroke-width="1"/>
      <text x="562" y="${y + 22}" font-family="${FONT}" font-size="11" font-weight="600" fill="#94a3b8">${esc(m.label || '')}</text>
      <text x="562" y="${y + 49}" font-family="${FONT}" font-size="16" font-weight="700" fill="${valCol}">${esc(m.value || '—')}</text>
      ${m.sub ? `<text x="840" y="${y + 22}" text-anchor="end" font-family="${FONT}" font-size="10.5" font-weight="600" fill="${m.subColor || '#cbd5e1'}">${esc(m.sub)}</text>` : ''}
    `;
  }).join('\n');

  const execFill = String(execBadge).includes('LIVE') ? '#10b981' : '#94a3b8';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="432" viewBox="0 0 880 432">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1120"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="880" height="432" rx="16" fill="url(#bg)"/>
  <rect x="1" y="1" width="878" height="430" rx="15" fill="none" stroke="${theme.accent}" stroke-opacity="0.35" stroke-width="2"/>

  <!-- Header -->
  <rect x="0" y="0" width="880" height="66" rx="16" fill="rgba(15,23,42,0.85)"/>
  <line x1="20" y1="66" x2="860" y2="66" stroke="rgba(148,163,184,0.14)" stroke-width="1"/>
  <rect x="26" y="16" width="8" height="34" rx="4" fill="${theme.accent}"/>
  <text x="44" y="34" font-family="${FONT}" font-size="17" font-weight="800" fill="#f8fafc">${esc(title)}</text>
  <text x="44" y="52" font-family="${FONT}" font-size="11.5" font-weight="500" fill="#94a3b8">${esc(subtitle)}  •  ${esc(istTime)}</text>

  <!-- Right Pills -->
  <rect x="574" y="18" width="132" height="30" rx="8" fill="${theme.pillBg}" stroke="${theme.pillStroke}" stroke-width="1.2"/>
  <text x="640" y="38" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="800" fill="${theme.accent}">${esc(badgeText)}</text>

  <rect x="716" y="18" width="138" height="30" rx="8" fill="rgba(15,23,42,0.9)" stroke="${execFill}" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="785" y="38" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="800" fill="${execFill}">${esc(execBadge)}</text>

  <!-- Chart Container -->
  <rect x="${chartBox.x}" y="${chartBox.y}" width="${chartBox.w}" height="${chartBox.h}" rx="12" fill="rgba(15,23,42,0.65)" stroke="rgba(148,163,184,0.16)" stroke-width="1"/>
  ${candleSvg}

  <!-- Right KPI Panel -->
  ${metricBlocks}

  <!-- Footer -->
  <text x="26" y="416" font-family="${FONT}" font-size="10.5" fill="#64748b">${esc(card.footer || 'Automated Risk-Managed Execution')}</text>
  <text x="854" y="416" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#64748b">TradingSignals Engine</text>
</svg>`;
}

function renderTradeCardPng(card) {
  let Resvg;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch (e) {
    return null;
  }
  try {
    const svg = buildTradeCardSvg(card);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1000 },
      font: { loadSystemFonts: true },
    });
    return resvg.render().asPng();
  } catch (e) {
    console.warn('[tg_card] PNG render failed:', e.message);
    return null;
  }
}

module.exports = {
  buildTradeCardSvg,
  renderTradeCardPng,
};
