/**
 * Generate a TrendRunner-style coin card PNG for X media uploads.
 * Avoids headless browser screenshots on Render — paints from signal data.
 */
const fs = require('fs');
const path = require('path');

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
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function buildCardSvg({
  symbol,
  name,
  score,
  confidence,
  price,
  tpPct = 10,
  holdDays = 7,
  stopPrice,
  takeProfitPrice,
  tierLabel = 'Core Winner',
  change1d,
  change4h,
}) {
  const sym = esc(String(symbol || '').replace(/USDT$/i, ''));
  const displayName = esc(name || sym);
  const priceStr = esc('$' + fmtPrice(price));
  const conf = Math.max(0, Math.min(100, Number(confidence) || 0));
  const scoreStr = esc('+' + (Number(score) || 0));
  const tp = takeProfitPrice != null ? esc('$' + fmtPrice(takeProfitPrice)) : esc(`+${tpPct}%`);
  const sl = stopPrice != null ? esc('$' + fmtPrice(stopPrice)) : '—';
  const ch1 = change1d == null ? '–' : `${change1d >= 0 ? '+' : ''}${Number(change1d).toFixed(2)}%`;
  const ch4 = change4h == null ? '–' : `${change4h >= 0 ? '+' : ''}${Number(change4h).toFixed(2)}%`;
  const ch1Color = change1d == null ? '#94a3b8' : change1d >= 0 ? '#34d399' : '#fb7185';
  const ch4Color = change4h == null ? '#94a3b8' : change4h >= 0 ? '#34d399' : '#fb7185';
  const initials = esc(sym.slice(0, 3).toUpperCase());
  const confW = Math.round((conf / 100) * 520);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="55%" stop-color="#101828"/>
      <stop offset="100%" stop-color="#0c1f1a"/>
    </linearGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#152033"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="675" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="180" fill="#10b981" fill-opacity="0.08"/>
  <circle cx="120" cy="600" r="160" fill="#00f2fe" fill-opacity="0.06"/>

  <text x="64" y="58" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700" fill="#00f2fe">TrendRunner</text>
  <text x="64" y="92" font-family="Segoe UI, Arial, sans-serif" font-size="18" fill="#94a3b8">Algorithmic crypto intelligence · trendrunner.app</text>

  <!-- Card -->
  <rect x="120" y="130" width="960" height="460" rx="28" fill="url(#card)" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <rect x="120" y="130" width="960" height="8" rx="4" fill="#10b981"/>

  <!-- Logo circle -->
  <circle cx="220" cy="230" r="48" fill="#24324a"/>
  <text x="220" y="240" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="800" fill="#e2e8f0">${initials}</text>

  <text x="300" y="220" font-family="Segoe UI, Arial, sans-serif" font-size="42" font-weight="700" fill="#ffffff">${displayName}</text>
  <text x="300" y="262" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#94a3b8">${sym}USDT</text>

  <!-- S.BUY badge -->
  <rect x="820" y="198" width="200" height="56" rx="28" fill="rgba(16,185,129,0.18)" stroke="#10b981" stroke-width="2"/>
  <text x="920" y="234" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="800" fill="#34d399">S.BUY</text>

  <!-- Badges -->
  <rect x="300" y="290" width="110" height="36" rx="18" fill="rgba(0,0,0,0.35)"/>
  <text x="355" y="314" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="#cbd5e1">Crypto</text>
  <rect x="424" y="290" width="160" height="36" rx="18" fill="rgba(16,185,129,0.18)" stroke="rgba(16,185,129,0.35)"/>
  <text x="504" y="314" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="#6ee7b7">${esc(tierLabel)}</text>

  <!-- Price + changes -->
  <text x="180" y="410" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" fill="#ffffff">${priceStr}</text>
  <text x="820" y="380" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#94a3b8">1D</text>
  <text x="980" y="380" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="${ch1Color}">${esc(ch1)}</text>
  <text x="820" y="420" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#94a3b8">4H</text>
  <text x="980" y="420" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="${ch4Color}">${esc(ch4)}</text>

  <!-- Confidence -->
  <text x="180" y="470" font-family="Segoe UI, Arial, sans-serif" font-size="20" fill="#94a3b8">Confidence ${esc(String(conf))}% · Confluence ${scoreStr}</text>
  <rect x="180" y="490" width="520" height="14" rx="7" fill="rgba(255,255,255,0.08)"/>
  <rect x="180" y="490" width="${confW}" height="14" rx="7" fill="url(#accent)"/>

  <!-- Targets -->
  <text x="180" y="550" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#34d399">TP ${tp}</text>
  <text x="420" y="550" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#fb7185">SL ${sl}</text>
  <text x="680" y="550" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#94a3b8">${esc(String(holdDays))}d hold</text>

  <text x="600" y="640" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="18" fill="#64748b">Not financial advice · Paper-check setups on TrendRunner</text>
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

module.exports = { buildCardSvg, renderTweetCardPng, TW_OG_FALLBACK: path.join(__dirname, '..', 'og-preview.png') };
