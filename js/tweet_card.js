/**
 * Tweet image = cropped screenshot of a dashboard coin card (SVG → PNG).
 * Render has no headless browser, so this paints the same asset-card layout,
 * colors, and sparklines the app shows — from the live scan, not a mock graphic.
 */
const fs = require('fs');
const path = require('path');

const FONT = 'DejaVu Sans, Segoe UI, Arial, sans-serif';
const LOGO_DIR = path.join(__dirname, '..', 'assets', 'coin-logos');

const SIGNAL_UI = {
  STRONG_BUY:  { short: 'S.BUY',  cls: 'strong-buy',  border: '#10b981', badgeBg: 'rgba(16,185,129,0.15)', badgeStroke: 'rgba(16,185,129,0.30)', badgeFill: '#10b981', bar: '#10b981' },
  BUY:         { short: 'BUY',    cls: 'buy',         border: '#34d399', badgeBg: 'rgba(52,211,153,0.10)', badgeStroke: 'rgba(52,211,153,0.20)', badgeFill: '#34d399', bar: '#34d399' },
  NEUTRAL:     { short: 'HOLD',   cls: 'neutral',     border: '#94a3b8', badgeBg: 'rgba(148,163,184,0.10)', badgeStroke: 'rgba(148,163,184,0.20)', badgeFill: '#94a3b8', bar: '#94a3b8' },
  SELL:        { short: 'SELL',   cls: 'sell',        border: '#fb7185', badgeBg: 'rgba(251,113,133,0.10)', badgeStroke: 'rgba(251,113,133,0.20)', badgeFill: '#fb7185', bar: '#fb7185' },
  STRONG_SELL: { short: 'S.SELL', cls: 'strong-sell', border: '#e11d48', badgeBg: 'rgba(225,29,72,0.15)',   badgeStroke: 'rgba(225,29,72,0.30)',   badgeFill: '#e11d48', bar: '#e11d48' },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPrice(price) {
  const n = Number(price);
  if (!isFinite(n)) return '–';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtPct(n) {
  if (n == null || !isFinite(Number(n))) return '–';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function logoDataUri(symbol) {
  const base = String(symbol || '').toLowerCase().replace(/usdt$/i, '');
  for (const ext of ['png', 'svg']) {
    const file = path.join(LOGO_DIR, `${base}.${ext}`);
    if (!fs.existsSync(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      const mime = ext === 'svg' ? 'image/svg+xml' : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (_) { /* skip */ }
  }
  return null;
}

function sparkArea(closes, x, y, w, h) {
  const arr = (Array.isArray(closes) ? closes : []).map(Number).filter(Number.isFinite).slice(-30);
  if (arr.length < 2) return { line: '', area: '' };
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const span = max - min || 1;
  const pts = arr.map((v, i) => {
    const px = x + (i / (arr.length - 1)) * w;
    const py = y + h - ((v - min) / span) * h;
    return [px, py];
  });
  const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area = `M ${first[0].toFixed(1)} ${(y + h).toFixed(1)} L ${pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(' L ')} L ${last[0].toFixed(1)} ${(y + h).toFixed(1)} Z`;
  return { line, area };
}

function chip(x, y, w, label, value) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="70" rx="8" fill="rgba(0,0,0,0.30)" stroke="rgba(255,255,255,0.10)"/>
    <text x="${x + w / 2}" y="${y + 24}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" letter-spacing="1" fill="#94a3b8">${esc(label)}</text>
    <text x="${x + w / 2}" y="${y + 52}" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="600" fill="#ffffff">${esc(value)}</text>`;
}

function buildCardSvg(opts = {}) {
  const sym = String(opts.symbol || '').replace(/USDT$/i, '');
  const displayName = opts.name || sym;
  const priceStr = '$' + fmtPrice(opts.price);
  const conf = Math.max(0, Math.min(100, Number(opts.confidence) || 0));
  const score = Number(opts.score) || 0;
  const scoreStr = `${score > 0 ? '+' : ''}${score}`;
  const rsi = opts.rsi == null || !isFinite(Number(opts.rsi)) ? '–' : Number(opts.rsi).toFixed(1);
  const tvl = opts.tvl;
  const tvlStr = !tvl ? 'N/A'
    : tvl > 1e9 ? `$${(tvl / 1e9).toFixed(1)}B`
      : tvl > 1e6 ? `$${(tvl / 1e6).toFixed(1)}M`
        : `$${Number(tvl).toFixed(0)}`;
  const ch1 = fmtPct(opts.change1d);
  const ch4 = fmtPct(opts.change4h);
  const ch1Pos = opts.change1d == null ? null : opts.change1d >= 0;
  const ch4Pos = opts.change4h == null ? null : opts.change4h >= 0;
  const ch1Color = ch1Pos == null ? '#94a3b8' : ch1Pos ? '#22c55e' : '#ef4444';
  const ch4Color = ch4Pos == null ? '#94a3b8' : ch4Pos ? '#22c55e' : '#ef4444';
  const ch1Bg = ch1Pos == null ? 'rgba(255,255,255,0.05)' : ch1Pos ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
  const ch4Bg = ch4Pos == null ? 'rgba(255,255,255,0.05)' : ch4Pos ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
  const spark1Color = ch1Pos === false ? '#ef4444' : '#22c55e';
  const spark4Color = ch4Pos === false ? '#ef4444' : '#22c55e';
  const spark1Fill = ch1Pos === false ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
  const spark4Fill = ch4Pos === false ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
  const signal = String(opts.signal || 'STRONG_BUY');
  const ui = SIGNAL_UI[signal] || SIGNAL_UI.STRONG_BUY;
  const tierLabel = opts.tierLabel || 'Crypto';
  const showCore = /core/i.test(tierLabel);
  const showProb = /probation/i.test(tierLabel);
  const stop = opts.stopPrice != null ? '$' + fmtPrice(opts.stopPrice) : '—';
  const bank = opts.takeProfitPrice != null ? '$' + fmtPrice(opts.takeProfitPrice) : `+${opts.tpPct || 10}%`;
  const dist = opts.distancePct != null ? `(-${Number(opts.distancePct).toFixed(2)}%)` : '';
  const bankPct = opts.bankPct ?? opts.tpPct ?? 10;
  const partial = opts.partialPct ?? 50;
  const trail = opts.trailPct != null ? Number(opts.trailPct).toFixed(2) : '—';
  const confW = Math.round((conf / 100) * 1036);
  const logo = logoDataUri(sym);
  const initials = esc(sym.slice(0, 3).toUpperCase());

  const s1 = sparkArea(opts.closes1D, 142, 292, 470, 62);
  const s4 = sparkArea(opts.closes4H, 658, 292, 470, 62);

  const logoMark = logo
    ? `<image href="${logo}" x="140" y="108" width="44" height="44" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="162" y="138" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800" fill="#e2e8f0">${initials}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="42%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glowL" cx="15%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7c6af5" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#7c6af5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="85%" cy="30%" r="50%">
      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Dashboard background (same as the app) -->
  <rect width="1200" height="675" fill="#080a14"/>
  <rect width="1200" height="675" fill="url(#glowL)"/>
  <rect width="1200" height="675" fill="url(#glowR)"/>

  <!-- Sidebar peek -->
  <rect width="88" height="675" fill="#0c0f1c"/>
  <rect x="0" y="0" width="3" height="675" fill="#00e5ff"/>
  <text x="16" y="42" font-family="${FONT}" font-size="11" font-weight="800" fill="#ffffff">Trend</text>
  <text x="16" y="56" font-family="${FONT}" font-size="11" font-weight="800" fill="#00e5ff">Runner</text>
  <rect x="12" y="88" width="64" height="36" rx="8" fill="rgba(0,229,255,0.12)"/>
  <text x="44" y="111" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="700" fill="#e2e8f0">Dash</text>
  <text x="44" y="154" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#64748b">Moon</text>
  <text x="44" y="186" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#64748b">New</text>
  <text x="44" y="218" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#64748b">Test</text>

  <!-- Section heading — High Confidence tab -->
  <text x="112" y="48" font-family="${FONT}" font-size="22" font-weight="700" fill="#f1f5f9">High Confidence</text>
  <text x="112" y="70" font-family="${FONT}" font-size="13" fill="#94a3b8">trendrunner.app</text>

  <!-- Asset card (dashboard .asset-card) -->
  <rect x="112" y="84" width="1064" height="560" rx="16" fill="#161b30" stroke="rgba(255,255,255,0.10)"/>
  <rect x="112" y="84" width="1064" height="3" rx="2" fill="${ui.border}"/>
  <rect x="112" y="84" width="1064" height="560" rx="16" fill="url(#glass)" opacity="0.7"/>

  <!-- Header: logo + name + badges + signal -->
  <circle cx="162" cy="130" r="26" fill="rgba(255,255,255,0.05)"/>
  ${logoMark}
  <text x="204" y="122" font-family="${FONT}" font-size="22" font-weight="600" fill="#ffffff">${esc(displayName)}</text>
  <text x="204" y="144" font-family="${FONT}" font-size="14" fill="#94a3b8">${esc(sym)}USDT</text>
  <rect x="204" y="156" width="78" height="22" rx="11" fill="rgba(0,0,0,0.40)"/>
  <text x="243" y="171" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#cbd5e1">Crypto</text>
  ${showCore ? `
  <rect x="290" y="156" width="108" height="22" rx="11" fill="rgba(16,185,129,0.18)" stroke="rgba(16,185,129,0.35)"/>
  <text x="344" y="171" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#6ee7b7">Core Winner</text>` : ''}
  ${showProb ? `
  <rect x="290" y="156" width="118" height="22" rx="11" fill="rgba(245,158,11,0.18)" stroke="rgba(245,158,11,0.35)"/>
  <text x="349" y="171" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#fcd34d">Probation</text>` : ''}

  <rect x="1018" y="112" width="132" height="36" rx="18" fill="${ui.badgeBg}" stroke="${ui.badgeStroke}"/>
  <text x="1084" y="135" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="700" letter-spacing="0.5" fill="${ui.badgeFill}">${esc(ui.short)}</text>

  <!-- Price row -->
  <text x="140" y="230" font-family="${FONT}" font-size="40" font-weight="700" letter-spacing="-1" fill="#ffffff">${esc(priceStr)}</text>
  <rect x="1024" y="188" width="128" height="22" rx="4" fill="${ch1Bg}"/>
  <text x="1088" y="204" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="${ch1Color}">1D: ${esc(ch1)}</text>
  <rect x="1024" y="216" width="128" height="22" rx="4" fill="${ch4Bg}"/>
  <text x="1088" y="232" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="${ch4Color}">4H: ${esc(ch4)}</text>

  <!-- Sparklines (same 1D / 4H cards as the dashboard) -->
  <rect x="132" y="256" width="510" height="110" rx="8" fill="rgba(0,0,0,0.20)" stroke="rgba(255,255,255,0.03)"/>
  <text x="387" y="278" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing="1" fill="#94a3b8">1D TREND</text>
  ${s1.area ? `<path d="${s1.area}" fill="${spark1Fill}"/>` : ''}
  ${s1.line ? `<polyline fill="none" stroke="${spark1Color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s1.line}"/>` : ''}
  <rect x="648" y="256" width="510" height="110" rx="8" fill="rgba(0,0,0,0.20)" stroke="rgba(255,255,255,0.03)"/>
  <text x="903" y="278" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing="1" fill="#94a3b8">4H TREND</text>
  ${s4.area ? `<path d="${s4.area}" fill="${spark4Fill}"/>` : ''}
  ${s4.line ? `<polyline fill="none" stroke="${spark4Color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s4.line}"/>` : ''}

  <!-- Indicator chips -->
  ${chip(132, 382, 246, 'RSI', rsi)}
  ${chip(390, 382, 246, 'SCORE', scoreStr)}
  ${chip(648, 382, 246, 'CONFIDENCE', `${conf}%`)}
  ${chip(906, 382, 246, 'TVL', tvlStr)}

  <!-- Confidence bar -->
  <rect x="132" y="468" width="1036" height="4" rx="2" fill="rgba(255,255,255,0.05)"/>
  <rect x="132" y="468" width="${confW}" height="4" rx="2" fill="${ui.bar}"/>

  <!-- Stop / bank / runner — same copy as the dashboard card -->
  <rect x="132" y="488" width="510" height="40" rx="8" fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.35)"/>
  <text x="387" y="514" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="700" fill="#ef4444">Stop (100%): ${esc(stop)} ${esc(dist)}</text>
  <rect x="654" y="488" width="510" height="40" rx="8" fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.35)"/>
  <text x="909" y="514" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="700" fill="#22c55e">Bank ${esc(String(partial))}%: ${esc(bank)} (+${esc(String(bankPct))}%)</text>
  <rect x="132" y="538" width="1036" height="40" rx="8" fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.35)"/>
  <text x="650" y="564" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="700" fill="#22c55e">Runner ${esc(String(100 - partial))}%: trail ~${esc(String(trail))}% ATR · BE after bank</text>

  <text x="650" y="616" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="#7c6af5">Click for full analysis →</text>
</svg>`;
}

function renderTweetCardPng(opts) {
  const svg = buildCardSvg(opts);
  let Resvg;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch (e) {
    console.warn('[tweet_card] @resvg/resvg-js not available:', e.message);
    return null;
  }
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: { loadSystemFonts: true },
    });
    return resvg.render().asPng();
  } catch (e) {
    console.warn('[tweet_card] PNG render failed:', e.message);
    return null;
  }
}

module.exports = {
  buildCardSvg,
  renderTweetCardPng,
  TW_OG_FALLBACK: path.join(__dirname, '..', 'og-preview.png'),
};
