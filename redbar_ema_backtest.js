/**
 * Backtest / live peek for RangeEmaEngine (all prior-day bands + EMA cross).
 *
 *   node redbar_ema_backtest.js
 *   node redbar_ema_backtest.js --live
 *   node redbar_ema_backtest.js --no-htf
 *   node redbar_ema_backtest.js --no-band
 */
'use strict';

const https = require('https');
const RangeEmaEngine = require('./js/range_ema_engine.js');

const SYMBOL = 'BTCUSDT';
const args = new Set(process.argv.slice(2));

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.code) reject(new Error(JSON.stringify(j)));
            else resolve(j);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function fetchKlines(interval, targetBars) {
  const out = [];
  let endTime;
  while (out.length < targetBars) {
    const limit = Math.min(1000, targetBars - out.length + 5);
    let url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const batch = await get(url);
    if (!batch.length) break;
    out.unshift(...batch);
    endTime = batch[0][0] - 1;
    if (batch.length < limit) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const map = new Map();
  for (const k of out) map.set(k[0], k);
  return [...map.values()].sort((a, b) => a[0] - b[0]).slice(-targetBars);
}

function parseBars(raw) {
  return raw.map((k) => ({
    t: k[0],
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4],
  }));
}

function printSummary(label, summary) {
  console.log(`\n${label}`);
  console.log(
    `  n=${summary.n}  WR=${summary.winRate.toFixed(1)}%  avg=${summary.avgPct.toFixed(3)}%  sum=${summary.sumPct.toFixed(2)}%`
  );
  console.log(
    `  long=${summary.longs} short=${summary.shorts}  tp=${summary.tp} sl=${summary.sl}`
  );
}

(async () => {
  console.log('Fetching BTCUSDT 30m + 4h…');
  const bars30 = parseBars(await fetchKlines('30m', 3000));
  const bars4h = parseBars(await fetchKlines('4h', 800));
  const from = new Date(bars30[0].t).toISOString().slice(0, 10);
  const to = new Date(bars30[bars30.length - 1].t).toISOString().slice(0, 10);
  const bands = RangeEmaEngine.buildDailyBands(bars30, 90);
  console.log(`Bars 30m=${bars30.length}  4h=${bars4h.length}  ${from} → ${to}`);
  console.log(`Daily bands (all days in window, capped 90): ${bands.length}`);

  const base = {
    emaFast: 10,
    emaSlow: 30,
    swingLookback: 10,
    touchPct: 0.15,
    maxRiskPct: 5,
    rFallback: 1.5,
    lookbackDays: 90,
    feePerSide: 0.0004,
  };

  if (args.has('--live')) {
    const sig = RangeEmaEngine.evaluate(bars30, bars4h, {
      ...base,
      requireBand: !args.has('--no-band'),
      useHtfFilter: !args.has('--no-htf'),
    });
    console.log('\nLatest bar evaluation:');
    console.log(JSON.stringify(sig, null, 2));
    return;
  }

  const variants = [
    { label: 'FULL: band required + 4h filter (product default)', requireBand: true, useHtfFilter: true },
    { label: 'Bands only (no 4h filter)', requireBand: true, useHtfFilter: false },
    { label: 'EMA cross only (no band, no 4h)', requireBand: false, useHtfFilter: false },
    { label: '4h filter only (no band)', requireBand: false, useHtfFilter: true },
  ];

  for (const v of variants) {
    if (args.has('--no-htf') && v.useHtfFilter) continue;
    if (args.has('--no-band') && v.requireBand) continue;
    const { summary } = RangeEmaEngine.backtest(bars30, bars4h, { ...base, ...v });
    printSummary(v.label, summary);
  }

  const bh = ((bars30[bars30.length - 1].c - bars30[40].c) / bars30[40].c) * 100;
  console.log(`\nBuy-hold same window: ${bh.toFixed(2)}%`);
  console.log('\nTP = next prior-day band level in trade direction (else R×1.5 fallback).');
  console.log('All completed UTC days in lookback become bands — no cherry-pick.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
