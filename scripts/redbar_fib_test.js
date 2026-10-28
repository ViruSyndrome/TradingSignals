/**
 * Red Bar Fib Integrity & Cross-Timeframe Parity Test
 *
 * Canonical BTC Mark-Window Fib Rule:
 *  - Feed: Binance USD-M Futures (BTCUSDT) — never Spot
 *  - Window: 02:30–03:30 IST (the 1H 02:30 IST candle = 21:00–22:00 UTC)
 *  - Anchors: Highest point of upper wick (f1 = max(high)) and lowest point of lower wick (f0 = min(low)) — NEVER candle body (open/close)
 *  - Levels: 0, 0.44, 0.50, 0.56, 1.0
 *
 * Verifies:
 *  1. BTC config & source contracts (binanceFutures, 02:30–03:30 IST, localStorage spot cache scrub).
 *  2. zonedClockToUtc & sessionDayKey hit exact millisecond boundaries (0ms drift).
 *  3. Wick H/L vs candle body O/C & strict boundary exclusion (excludes 02:15 and >= 03:30 IST).
 *  4. Cross-timeframe parity: 1h (1 bar), 30m (2 bars), 15m (4 bars), and 5m (12 bars) produce identical f0/f44/f50/f56/f1.
 *  5. Forming-window lock (unlocked before 03:30 IST, locked at/after 03:30 IST) + 5m backfill from bars1h with zero future lookahead.
 *  6. Full 24-month (730 days) Binance USD-M Futures cache parity across 1h, 15m, and 5m (0 mismatches).
 *
 * Usage:
 *   node scripts/redbar_fib_test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache_binance_um');

let failed = 0;
function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. Config & source contracts
console.log('[1] BTC Fib Config & Source Contracts');
const btc = (CONFIG.rangeEma?.instruments || []).find((x) => x.id === 'BTC');
ok('BTC feed is binanceFutures', btc && btc.feed === 'binanceFutures', btc?.feed);
ok('BTC markWindow is 02:30–03:30 IST (1H candle)',
  btc && btc.markWindow
  && btc.markWindow.timeZone === 'Asia/Kolkata'
  && btc.markWindow.startHour === 2 && btc.markWindow.startMinute === 30
  && btc.markWindow.endHour === 3 && btc.markWindow.endMinute === 30,
  JSON.stringify(btc?.markWindow));
ok('BTC markLabel is 02:30–03:30 IST', btc?.markLabel === '02:30–03:30 IST', btc?.markLabel);

const apiSrc = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('api.js forces binanceFutures for BTC/XAU if ever marked spot',
  /forcing binanceFutures \(spot Fibs are wrong/.test(apiSrc));
ok('index.html scrubs legacy spot OHLC localStorage cache on boot',
  /trading_cache_crypto_hist_\(BTC\|XAU\|PAXG\)/.test(idxSrc));

// 2. Exact millisecond UTC clock
console.log('\n[2] Exact Millisecond Clock Alignment');
const tStart = RedBarTrend.zonedClockToUtc('2026-10-10', 'Asia/Kolkata', 2, 30);
const tEnd = RedBarTrend.zonedClockToUtc('2026-10-10', 'Asia/Kolkata', 3, 30);
ok('02:30 IST === previous day 21:00:00.000Z (0ms skew)',
  tStart === Date.parse('2026-10-09T21:00:00.000Z'),
  new Date(tStart).toISOString());
ok('03:30 IST === previous day 22:00:00.000Z (0ms skew)',
  tEnd === Date.parse('2026-10-09T22:00:00.000Z'),
  new Date(tEnd).toISOString());
ok('sessionDayKey before 02:30 IST belongs to prior session day',
  RedBarTrend.sessionDayKey(tStart - 1000, btc.markWindow) === '2026-10-09');
ok('sessionDayKey at 02:30 IST flips to new session day',
  RedBarTrend.sessionDayKey(tStart, btc.markWindow) === '2026-10-10');

// 3. Wick H/L vs Candle Body O/C & Cross-TF Parity (1h / 30m / 15m / 5m)
console.log('\n[3] 1H Wick H/L (Not Body) & Cross-TF Parity (1h / 30m / 15m / 5m)');
const WICK_LOW = 82380.25;
const WICK_HIGH = 82780.50;
const BODY_OPEN = 82480.00;
const BODY_CLOSE = 82510.00;

const bars1h = [
  // 01:30–02:30 IST (before window — huge fake wicks must be excluded)
  { t: tStart - 3600000, o: 82400, h: 99999, l: 70000, c: BODY_OPEN },
  // 02:30–03:30 IST (canonical 1H Fib candle: small body, long upper/lower wicks)
  { t: tStart, o: BODY_OPEN, h: WICK_HIGH, l: WICK_LOW, c: BODY_CLOSE },
  // 03:30–04:30 IST (after window — huge fake wicks must be excluded)
  { t: tEnd, o: BODY_CLOSE, h: 98888, l: 71111, c: 82550 },
];

const bars30 = [
  { t: tStart - 30 * 60000, o: 82400, h: 99999, l: 70000, c: BODY_OPEN },
  // 02:30–03:00 IST (carries lowest wick)
  { t: tStart, o: BODY_OPEN, h: 82560, l: WICK_LOW, c: 82520 },
  // 03:00–03:30 IST (carries highest wick)
  { t: tStart + 30 * 60000, o: 82520, h: WICK_HIGH, l: 82460, c: BODY_CLOSE },
  { t: tEnd, o: BODY_CLOSE, h: 98888, l: 71111, c: 82550 },
];

const bars15 = [
  // 02:15 IST (before window — must be excluded)
  { t: tStart - 15 * 60000, o: 82400, h: 99999, l: 70000, c: BODY_OPEN },
  // 02:30, 02:45, 03:00, 03:15 IST (4 candles inside 02:30–03:30 IST)
  { t: tStart, o: BODY_OPEN, h: 82530, l: 82442.44, c: 82506 },
  { t: tStart + 15 * 60000, o: 82506, h: 82560, l: WICK_LOW, c: 82520 },
  { t: tStart + 30 * 60000, o: 82520, h: WICK_HIGH, l: 82490, c: 82505 },
  { t: tStart + 45 * 60000, o: 82505, h: 82610, l: 82460, c: BODY_CLOSE },
  // 03:30 IST (after window — must be excluded)
  { t: tEnd, o: BODY_CLOSE, h: 98888, l: 71111, c: 82550 },
];

const bars5 = [
  { t: tStart - 5 * 60000, o: 82400, h: 99999, l: 70000, c: BODY_OPEN },
];
for (let k = 0; k < 12; k++) {
  bars5.push({
    t: tStart + k * 5 * 60000,
    o: BODY_OPEN,
    h: k === 7 ? WICK_HIGH : 82550,
    l: k === 3 ? WICK_LOW : 82460,
    c: BODY_CLOSE,
  });
}
bars5.push({ t: tEnd, o: BODY_CLOSE, h: 98888, l: 71111, c: 82550 });

const b1h = RedBarTrend.buildSessionFibBands(bars1h, 90, btc).find((b) => b.day === '2026-10-10');
const b30 = RedBarTrend.buildSessionFibBands(bars30, 90, btc).find((b) => b.day === '2026-10-10');
const b15 = RedBarTrend.buildSessionFibBands(bars15, 90, btc).find((b) => b.day === '2026-10-10');
const b5 = RedBarTrend.buildSessionFibBands(bars5, 90, btc).find((b) => b.day === '2026-10-10');

const exp44 = WICK_LOW + 0.44 * (WICK_HIGH - WICK_LOW);
const exp50 = WICK_LOW + 0.50 * (WICK_HIGH - WICK_LOW);
const exp56 = WICK_LOW + 0.56 * (WICK_HIGH - WICK_LOW);

ok('1h lowest line (f0) === lowest wick (not body open/close)',
  b1h && b1h.f0 === WICK_LOW && b1h.f0 !== BODY_OPEN && b1h.f0 !== BODY_CLOSE,
  `f0=${b1h?.f0} vs body=${BODY_OPEN}/${BODY_CLOSE}`);
ok('1h highest line (f1) === highest wick (not body open/close)',
  b1h && b1h.f1 === WICK_HIGH && b1h.f1 !== BODY_OPEN && b1h.f1 !== BODY_CLOSE,
  `f1=${b1h?.f1} vs body=${BODY_OPEN}/${BODY_CLOSE}`);
ok('1h f44 / f50 / f56 match exact wick range math',
  b1h && Math.abs(b1h.f44 - exp44) < 1e-9 && Math.abs(b1h.f50 - exp50) < 1e-9 && Math.abs(b1h.f56 - exp56) < 1e-9);
ok('1h spans exact 1 bar (02:30 IST 1H candle)', b1h && (b1h.i1Mark - b1h.index + 1) === 1);
ok('30m spans exact 2 bars (02:30, 03:00 IST) & matches 1h wick H/L',
  b30 && (b30.i1Mark - b30.index + 1) === 2 && b30.f0 === WICK_LOW && b30.f1 === WICK_HIGH);
ok('15m spans exact 4 bars (02:30..03:15 IST) & matches 1h wick H/L',
  b15 && (b15.i1Mark - b15.index + 1) === 4 && b15.f0 === WICK_LOW && b15.f1 === WICK_HIGH);
ok('5m spans exact 12 bars (02:30..03:25 IST) & matches 1h wick H/L',
  b5 && (b5.i1Mark - b5.index + 1) === 12 && b5.f0 === WICK_LOW && b5.f1 === WICK_HIGH);

const frFib = RedBarTrend.firstRedFibs({ high: 83100, low: 82900 });
ok('firstRedFibs uses consistent f0=low (wick), f1=high (wick)',
  frFib && frFib.f0 === 82900 && frFib.f1 === 83100);

// 4. Forming-window lock & 5m HTF backfill without future lookahead
console.log('\n[4] Forming Lock (02:30–03:30 IST) & 5m HTF Backfill / Lookahead Guard');
const forming15 = bars15.slice(0, 4); // up to 03:00 bar open (closes 03:15 < 03:30 IST)
const readForming = RedBarTrend.readAt(forming15, forming15.length - 1, {
  ...btc,
  asOfTs: tStart + 40 * 60000, // 03:10 IST
});
ok('At 03:10 IST (mid-window): openingRange.locked === false & phase === first_candle',
  readForming && readForming.openingRange?.locked === false
  && readForming.currentBand?.locked === false
  && readForming.phase === 'first_candle',
  `locked=${readForming?.openingRange?.locked} phase=${readForming?.phase}`);

const readLocked = RedBarTrend.readAt(bars15, bars15.length - 1, {
  ...btc,
  asOfTs: tEnd + 5 * 60000, // 03:35 IST
});
ok('At 03:35 IST (after 03:30 close): openingRange.locked === true & currentBand.locked === true',
  readLocked && readLocked.openingRange?.locked === true && readLocked.currentBand?.locked === true);

// Short 5m slice missing prior day + starting mid-window (02:50 IST), with bars1h including a FUTURE day
const tPrevDayStart = RedBarTrend.zonedClockToUtc('2026-10-09', 'Asia/Kolkata', 2, 30);
const tNextDayStart = RedBarTrend.zonedClockToUtc('2026-10-11', 'Asia/Kolkata', 2, 30);
const htfWithFuture = [
  { t: tPrevDayStart, o: 81900, h: 82200, l: 81700, c: 82050 }, // prior day (should backfill)
  { t: tStart, o: BODY_OPEN, h: WICK_HIGH, l: WICK_LOW, c: BODY_CLOSE }, // current day (completes partial 5m)
  { t: tNextDayStart, o: 84000, h: 85000, l: 83900, c: 84500 }, // future day (must NOT leak)
];
const partial5m = bars5.filter((b) => b.t >= tStart + 20 * 60000); // starts at 02:50 IST (missed 02:30..02:45 wicks)
const backfilledBands = RedBarTrend.buildSessionFibBands(partial5m, 90, { ...btc, bars1h: htfWithFuture });
const bfPrev = backfilledBands.find((b) => b.day === '2026-10-09');
const bfCur = backfilledBands.find((b) => b.day === '2026-10-10');
const bfFut = backfilledBands.find((b) => b.day === '2026-10-11');
ok('5m backfills missing prior-day 1H Fib from bars1h',
  bfPrev && bfPrev.f0 === 81700 && bfPrev.f1 === 82200);
ok('5m starting mid-window (02:50 IST) recovers full 02:30–03:30 1H wick H/L from bars1h',
  bfCur && bfCur.f0 === WICK_LOW && bfCur.f1 === WICK_HIGH);
ok('bars1h future days beyond working bars are excluded (zero lookahead)',
  !bfFut);

// 5. Full 24-month historical cache check (1h vs 15m vs 5m)
if (fs.existsSync(CACHE)) {
  console.log('\n[5] 24-Month Binance USD-M Futures Cache Fib Integrity (1h vs 15m vs 5m)');
  const loadTf = (tf) => {
    const files = fs.readdirSync(CACHE)
      .filter((f) => new RegExp(`^BTCUSDT_${tf}_\\d{4}-\\d{2}\\.json$`).test(f))
      .sort();
    const out = [];
    const seen = new Set();
    for (const f of files) {
      for (const r of JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'))) {
        const b = r.t != null ? r : { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] };
        if (!seen.has(b.t)) { seen.add(b.t); out.push(b); }
      }
    }
    return out.sort((a, b) => a.t - b.t);
  };
  const all1h = loadTf('1h');
  const all15m = loadTf('15m');
  const all5m = loadTf('5m');
  if (all1h.length && all15m.length && all5m.length) {
    const bands1h = RedBarTrend.buildSessionFibBands(all1h, 9999, btc);
    const bands15m = RedBarTrend.buildSessionFibBands(all15m, 9999, btc);
    const bands5m = RedBarTrend.buildSessionFibBands(all5m, 9999, btc);
    const map1h = new Map(bands1h.map((b) => [b.day, b]));

    let badOrder = 0;
    let wrong1hCount = 0;
    let wrong15mCount = 0;
    let wrong5mCount = 0;
    let diff15m = 0;
    let diff5m = 0;

    for (const b of bands1h) {
      if (!(b.f0 === b.low && b.f1 === b.high && b.f0 < b.f44 && b.f44 < b.f50 && b.f50 < b.f56 && b.f56 < b.f1)) {
        badOrder += 1;
      }
      if ((b.i1Mark - b.index + 1) !== 1) wrong1hCount += 1;
    }
    for (const b of bands15m) {
      if ((b.i1Mark - b.index + 1) !== 4) wrong15mCount += 1;
      const ref = map1h.get(b.day);
      if (!ref || Math.abs(ref.f0 - b.f0) > 1e-6 || Math.abs(ref.f1 - b.f1) > 1e-6) diff15m += 1;
    }
    for (const b of bands5m) {
      if ((b.i1Mark - b.index + 1) !== 12) wrong5mCount += 1;
      const ref = map1h.get(b.day);
      if (!ref || Math.abs(ref.f0 - b.f0) > 1e-6 || Math.abs(ref.f1 - b.f1) > 1e-6) diff5m += 1;
    }

    ok(`all ${bands1h.length} historical 1H Fib days have strict f0 < f44 < f50 < f56 < f1`, badOrder === 0, `bad=${badOrder}`);
    ok(`all ${bands1h.length} 1h Fib windows span exact 1x 1H candle (02:30–03:30 IST)`, wrong1hCount === 0, `wrong=${wrong1hCount}`);
    ok(`all ${bands15m.length} 15m Fib windows span exact 4x 15m candles & match 1H wick H/L`, wrong15mCount === 0 && diff15m === 0, `wrongBars=${wrong15mCount}, diff1h=${diff15m}`);
    ok(`all ${bands5m.length} 5m Fib windows span exact 12x 5m candles & match 1H wick H/L`, wrong5mCount === 0 && diff5m === 0, `wrongBars=${wrong5mCount}, diff1h=${diff5m}`);
  }
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nALL PASS');
process.exit(failed ? 1 : 0);
