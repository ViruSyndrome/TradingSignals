/**
 * Audit BTC mark-window Fibs: USD-M futures (source of truth for TrendRunner)
 * vs Binance spot — every overlapping IST day we can load.
 *
 *   node scripts/audit_btc_spot_vs_futures_fibs.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache_binance_um');
const OUT = path.join(CACHE, 'audit_btc_spot_vs_futures_fibs.json');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`${url} → ${e.message}: ${d.slice(0, 120)}`)); }
      });
    }).on('error', reject);
  });
}

function toBars(rows) {
  return rows.map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
}

function loadFutures15m() {
  const files = fs.readdirSync(CACHE)
    .filter((f) => /^BTCUSDT_15m_\d{4}-\d{2}\.json$/.test(f))
    .sort();
  const bars = [];
  const seen = new Set();
  for (const f of files) {
    const rows = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
    for (const b of rows) {
      const bar = b.t != null ? b : { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      if (seen.has(bar.t)) continue;
      seen.add(bar.t);
      bars.push(bar);
    }
  }
  bars.sort((a, b) => a.t - b.t);
  return { bars, files };
}

/** Page spot 15m klines backward from endTs until startTs (inclusive). */
async function fetchSpot15mRange(startTs, endTs) {
  const bars = [];
  const seen = new Set();
  let cursor = endTs;
  let pages = 0;
  while (cursor > startTs && pages < 80) {
    pages += 1;
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000&endTime=${cursor}`;
    let raw;
    try {
      raw = await get(url);
    } catch {
      raw = await get(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000&endTime=${cursor}`);
    }
    if (!Array.isArray(raw) || !raw.length) break;
    const chunk = toBars(raw);
    for (const b of chunk) {
      if (b.t < startTs || b.t > endTs) continue;
      if (seen.has(b.t)) continue;
      seen.add(b.t);
      bars.push(b);
    }
    const oldest = chunk[0].t;
    if (oldest >= cursor) break;
    cursor = oldest - 1;
    if (oldest <= startTs) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function fibLevels(high, low) {
  return {
    high,
    low,
    f0: high,
    f44: low + 0.44 * (high - low),
    f50: (high + low) / 2,
    f56: low + 0.56 * (high - low),
    f1: low,
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}

function max(arr) {
  return arr.length ? Math.max(...arr) : 0;
}

(async () => {
  const inst = CONFIG.rangeEma.instruments.find((x) => x.id === 'BTC');
  const win = RedBarTrend.getMarkWindow(inst);
  const { bars: fut, files } = loadFutures15m();
  if (fut.length < 100) throw new Error('No futures 15m cache');

  const startTs = fut[0].t;
  const endTs = fut[fut.length - 1].t;
  console.log(`Futures cache: ${files.length} months, ${fut.length} bars`);
  console.log(`  ${new Date(startTs).toISOString()} → ${new Date(endTs).toISOString()}`);
  console.log('Fetching spot 15m for same window (paged)…');

  const spot = await fetchSpot15mRange(startTs, endTs);
  console.log(`Spot loaded: ${spot.length} bars`);

  const futDays = new Set(fut.map((b) => RedBarTrend.dayKey(b.t, 'ist')));
  const spotDays = new Set(spot.map((b) => RedBarTrend.dayKey(b.t, 'ist')));
  const common = [...futDays].filter((d) => spotDays.has(d)).sort();

  const rows = [];
  const futOnlyBad = [];
  for (const day of [...futDays].sort()) {
    const fHit = RedBarTrend.findMarkWindowRange(fut, day, win);
    if (!fHit) continue;
    if (!(fHit.high > fHit.low) || !Number.isFinite(fHit.high) || !Number.isFinite(fHit.low)) {
      futOnlyBad.push({ day, reason: 'invalid H/L', hit: fHit });
    }
  }

  for (const day of common) {
    const fHit = RedBarTrend.findMarkWindowRange(fut, day, win);
    const sHit = RedBarTrend.findMarkWindowRange(spot, day, win);
    if (!fHit || !sHit) continue;
    const f = fibLevels(fHit.high, fHit.low);
    const s = fibLevels(sHit.high, sHit.low);
    const dH = s.high - f.high;
    const dL = s.low - f.low;
    const d50 = s.f50 - f.f50;
    const same = Math.abs(dH) < 0.5 && Math.abs(dL) < 0.5;
    rows.push({
      day,
      fut: { h: f.high, l: f.low, f50: +f.f50.toFixed(2), f44: +f.f44.toFixed(2), f56: +f.f56.toFixed(2) },
      spot: { h: s.high, l: s.low, f50: +s.f50.toFixed(2), f44: +s.f44.toFixed(2), f56: +s.f56.toFixed(2) },
      dH: +dH.toFixed(2),
      dL: +dL.toFixed(2),
      d50: +d50.toFixed(2),
      dMidPct: +((d50 / f.f50) * 100).toFixed(4),
      wrong: !same,
    });
  }

  const wrong = rows.filter((r) => r.wrong);
  const futBands = RedBarTrend.buildSessionFibBands(fut, 9999, {
    ...inst,
    lookbackDays: 9999,
    bandStyle: 'sessionFib',
    fibLevels: [0, 0.44, 0.5, 0.56, 1],
  });

  // Forward-path contract checks (source)
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/range_ema_ui.js'), 'utf8');
  const btcFeed = (cfgSrc.match(/id:\s*'BTC'[\s\S]*?feed:\s*'([^']+)'/) || [])[1];
  const contracts = {
    btcFeedIsFutures: btcFeed === 'binanceFutures',
    apiForcesFuturesIfSpot: /forcing binanceFutures \(spot Fibs are wrong/.test(apiSrc),
    uiDefaultFutures: /feed:\s*'binanceFutures'/.test(uiSrc)
      && !/id:\s*'BTC'[\s\S]{0,200}feed:\s*'binanceSpot'/.test(cfgSrc),
  };

  const summary = {
    auditedAt: new Date().toISOString(),
    futuresMonths: files,
    futuresBars: fut.length,
    spotBars: spot.length,
    futuresMarkDays: futBands.length,
    overlapDays: rows.length,
    wrongDays: wrong.length,
    wrongPct: rows.length ? +(100 * wrong.length / rows.length).toFixed(1) : 0,
    identicalDays: rows.length - wrong.length,
    meanAbsHighUsd: +mean(wrong.map((r) => Math.abs(r.dH))).toFixed(2),
    meanAbsLowUsd: +mean(wrong.map((r) => Math.abs(r.dL))).toFixed(2),
    meanAbsFib50Usd: +mean(wrong.map((r) => Math.abs(r.d50))).toFixed(2),
    maxAbsHighUsd: +max(wrong.map((r) => Math.abs(r.dH))).toFixed(2),
    maxAbsLowUsd: +max(wrong.map((r) => Math.abs(r.dL))).toFixed(2),
    maxAbsFib50Usd: +max(wrong.map((r) => Math.abs(r.d50))).toFixed(2),
    futuresInvalidBands: futOnlyBad.length,
    forwardContracts: contracts,
    firstWrong: wrong[0] || null,
    lastWrong: wrong[wrong.length - 1] || null,
    worstByAbs50: [...wrong].sort((a, b) => Math.abs(b.d50) - Math.abs(a.d50)).slice(0, 15),
  };

  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  console.log('\n=== BTC SPOT vs FUTURES MARK FIB AUDIT ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT}`);

  const okForward = Object.values(contracts).every(Boolean);
  if (!okForward || futOnlyBad.length) {
    console.error('\nFAIL: forward contracts or futures band integrity');
    process.exit(1);
  }
  if (rows.length >= 30 && wrong.length === rows.length) {
    console.log('\nRESULT: Every overlapping day had different spot vs futures Fibs (expected).');
    console.log('TrendRunner must use futures only — spot Fibs are not the trade book.');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
