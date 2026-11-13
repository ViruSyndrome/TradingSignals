'use strict';
/**
 * Advanced NIFTY Red Bar (Strat 1) — unit checks
 *   node scripts/test_advanced_nifty_fibs.js
 */
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

let failed = 0;
function ok(label, cond, detail = '') {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const nifty = (CONFIG.rangeEma?.instruments || []).find((x) => x.id === 'NIFTY');
console.log('[1] Config');
ok('NIFTY advancedFibs true', nifty && nifty.advancedFibs === true);
ok('NIFTY firstRedTf is 5m (all NIFTY Fibs on 5m)', nifty && nifty.firstRedTf === '5m' && !nifty.dayFibTf);
ok('NIFTY advancedFibGapPts 40', nifty && nifty.advancedFibGapPts === 40);
ok('fib_bounce in ACTIONABLE_SETUPS', RedBarTrend.ACTIONABLE_SETUPS.includes('fib_bounce'));

// Synthetic IST day 2026-11-11: prev close 25200, open 25280 (gap 80), first bar H/L, then red, bounce
const day = '2026-11-11';
const prior = '2026-11-10';
function ist(y, m, d, hh, mm) {
  // Build UTC ms for Asia/Kolkata wall clock via RedBarTrend helper
  return RedBarTrend.zonedClockToUtc(
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    'Asia/Kolkata',
    hh,
    mm,
  );
}

const bars5m = [];
// Prior day last bar ~15:25
bars5m.push({
  t: ist(2026, 11, 10, 15, 25),
  o: 25190, h: 25210, l: 25180, c: 25200, v: 1,
});
// Today open 09:15 — gap up 80 pts from 25200 → 25280
bars5m.push({
  t: ist(2026, 11, 11, 9, 15),
  o: 25280, h: 25320, l: 25270, c: 25310, v: 1,
});
// 09:20 green
bars5m.push({
  t: ist(2026, 11, 11, 9, 20),
  o: 25310, h: 25340, l: 25300, c: 25330, v: 1,
});
// 09:25 first red
const redT = ist(2026, 11, 11, 9, 25);
bars5m.push({
  t: redT,
  o: 25330, h: 25335, l: 25290, c: 25295, v: 1,
});
// Later bars — fill toward bounce
for (let i = 0; i < 8; i++) {
  const t = redT + (i + 1) * 5 * 60000;
  bars5m.push({
    t,
    o: 25295 - i * 2,
    h: 25300 - i * 2,
    l: 25280 - i * 2,
    c: 25290 - i * 2,
    v: 1,
  });
}

console.log('\n[2] firstBar / firstRed / gap');
const firstBar = RedBarTrend.firstBarOfSession(bars5m, day, {
  dayMode: 'ist',
  asOfTs: ist(2026, 11, 11, 10, 0),
  barMs: 5 * 60000,
});
ok('firstBar is 09:15', firstBar && firstBar.t === ist(2026, 11, 11, 9, 15), String(firstBar?.t));
ok('firstBar open 25280', firstBar && firstBar.open === 25280);

const firstRed = RedBarTrend.firstRedBarOfSession(bars5m, day, {
  dayMode: 'ist',
  asOfTs: ist(2026, 11, 11, 10, 0),
  barMs: 5 * 60000,
  id: 'NIFTY',
});
ok('firstRed found after open', !!firstRed && firstRed.t === redT, String(firstRed?.t));

const adv = RedBarTrend.buildAdvancedNiftyFibs({
  bars5m,
  asOfDay: day,
  evalTs: ist(2026, 11, 11, 10, 0),
  firstRed1h: firstRed,
  priorSessionBand: { f50: 25150, mid: 25150, high: 25200, low: 25100, day: prior },
  gapMinPts: 40,
  dayMode: 'ist',
});
ok('advanced built', !!adv);
ok('gap present (≥40)', !!adv.gap && adv.gap.gapPts >= 40, JSON.stringify(adv.gap && { gapPts: adv.gap.gapPts }));
ok('firstBar fibs median', adv.firstBar?.fibs?.median != null);
ok('firstRed fibs median', adv.firstRed?.fibs?.median != null);
ok('medians include gap + prior', adv.medians.some((m) => m.id === 'gap') && adv.medians.some((m) => m.id === 'prior_session'));
ok('normal highway has no halfway median', !adv.medians.some((m) => m.id === 'highway_halfway'));
ok('median bands store the near and far edge', adv.medians.filter((m) => m.fibs).every((m) => m.lo === Math.min(m.fibs.f44, m.fibs.f56) && m.hi === Math.max(m.fibs.f44, m.fibs.f56)));

// Wide highway check (>= 120 pts span)
const advWide = RedBarTrend.buildAdvancedNiftyFibs({
  bars5m,
  asOfDay: day,
  evalTs: ist(2026, 11, 11, 10, 0),
  firstRed1h: { high: 25480, low: 25440, open: 25470, close: 25450, t: redT },
  priorSessionBand: null,
  gapMinPts: 40,
  wideHighwayPts: 120,
  dayMode: 'ist',
});
ok('wide highway (>=120 pts) generates halfway median', advWide.medians.some((m) => m.id === 'highway_halfway'));
const hwMed = advWide.medians.find((m) => m.id === 'highway_halfway');
ok('halfway median has 44-56 POB band', hwMed && hwMed.fibs?.pob?.mid === hwMed.price);
ok('halfway near edge is the 0.44 line and far edge is 0.56', hwMed && hwMed.lo === hwMed.fibs.f44 && hwMed.hi === hwMed.fibs.f56);

console.log('\n[3] Sandwich');
const midPrice = (adv.sandwich.lo + adv.sandwich.hi) / 2;
adv.inSandwich = RedBarTrend.isAdvancedFibSandwich(adv, midPrice);
ok('in sandwich at midpoint', adv.inSandwich === true, `lo=${adv.sandwich.lo} hi=${adv.sandwich.hi} mid=${midPrice}`);
adv.inSandwich = RedBarTrend.isAdvancedFibSandwich(adv, adv.sandwich.hi + 50);
ok('outside sandwich above', adv.inSandwich === false);

console.log('\n[4] Bounce detect + levels');
// Append a clear LONG reclaim of first-bar median
const med = adv.firstBar.fibs.median;
const bounceT = ist(2026, 11, 11, 10, 5);
bars5m.push({
  t: bounceT,
  o: med - 5,
  h: med + 30,
  l: med - 15,
  c: med + 25,
  v: 1,
});
adv.inSandwich = false; // force outside for bounce test (price above sandwich)
const bounce = RedBarTrend.detectFibBounceSetup({
  bars5m,
  advanced: { ...adv, inSandwich: false, sandwich: null },
  evalTs: bounceT + 5 * 60000 + 1000,
  price: med + 25,
});
ok('fib bounce triggered', bounce.triggered === true, JSON.stringify({ side: bounce.side, medianId: bounce.medianId }));
ok('stop uses previous test wick or structural extreme',
  bounce.stopHint <= med - 15,
  `side=${bounce.side} stop=${bounce.stopHint}`);
ok('stop below entry for long', bounce.side !== 'bullish' || bounce.stopHint < bounce.triggerPrice);

const levels = RedBarTrend._resolveStopAndBook({
  trend: bounce.side,
  price: bounce.triggerPrice,
  setupKind: 'fib_bounce',
  fibBounce: bounce,
});
ok('stop structural', levels.stopStructural === true);
ok('no median above means hold, not a fake 1:1', levels.tp1 == null && levels.medianHold === true, `tp1=${levels.tp1} hold=${levels.medianHold}`);
ok('no 1:1 ladder on a median wick', levels.rrLadder === false);
ok('stop reason is the signal wick', /wick/i.test(levels.invalidationReason || ''));

const closeTarget = RedBarTrend._resolveStopAndBook({
  trend: 'bullish',
  price: 100,
  setupKind: 'fib_bounce',
  fibBounce: {
    triggered: true,
    triggerPrice: 100,
    stopHint: 90,
    tpHint: 105,
    tpLabel: 'Red-bar median',
    stopReason: 'signal wick',
    medianHold: false,
  },
});
ok('closer median is kept', closeTarget.tp1 === 105, `tp1=${closeTarget.tp1}`);
ok('closer median is not replaced by 1:1', closeTarget.rr < 1 && closeTarget.rrLadder === false, `rr=${closeTarget.rr}`);
const closeGate = RedBarTrend.entryGate({
  trend: 'bullish',
  setupKind: 'fib_bounce',
  rr: closeTarget.rr,
  stopStructural: true,
  invalidationReason: 'signal wick',
  stopPct: 0.04,
  asOfTs: ist(2026, 11, 4, 12, 20),
  instrumentId: 'NIFTY',
  setupTriggerTs: ist(2026, 11, 4, 12, 15),
  entryPrice: 100,
  stopPrice: 90,
  livePrice: 100,
  medianHold: false,
});
ok('12:15 median turn is allowed through lunch', closeGate.state === 'enter', closeGate.reason);

const gate = RedBarTrend.entryGate({
  trend: bounce.side,
  setupKind: 'fib_bounce',
  rr: levels.rr,
  stopStructural: levels.stopStructural,
  invalidationReason: levels.invalidationReason,
  stopPct: levels.stopPct,
  asOfTs: bounceT + 5 * 60000 - 1000,
  instrumentId: 'NIFTY',
  setupTriggerTs: bounce.triggerTs,
  entryPrice: bounce.triggerPrice,
  stopPrice: levels.invalidation,
  livePrice: bounce.triggerPrice,
  medianHold: levels.medianHold,
});
ok('entryGate allows a median hold when no target is left', gate.state === 'enter', gate.reason);

console.log('\n[5] Sandwich stand-aside rule on narrow (< 120 pt) vs wide (>= 120 pt) highways');
// (a) Narrow sandwich (< 120 pts): adv.sandwich has ~17.5 pt span -> signal bar closing strictly inside [lo, hi] MUST be blocked
const swMid = (adv.sandwich.lo + adv.sandwich.hi) / 2;
const narrowSigT = ist(2026, 11, 11, 10, 30);
const narrowBars = [
  ...bars5m.slice(0, bars5m.length - 1),
  { t: narrowSigT, o: adv.sandwich.lo - 2, h: swMid + 4, l: adv.sandwich.lo - 5, c: swMid, v: 1 },
];
const swBlocked = RedBarTrend.detectFibBounceSetup({
  bars5m: narrowBars,
  advanced: adv,
  evalTs: narrowSigT + 5 * 60000,
});
ok('narrow sandwich (< 120 pts) blocks detectFibBounceSetup inside [lo, hi]', swBlocked.triggered === false, JSON.stringify(swBlocked));

// (b) Wide sandwich (>= 120 pts): advWide has span >= 120 pts -> bounce off halfway median strictly inside [lo, hi] IS allowed
const hwBounceT = ist(2026, 11, 11, 10, 10);
const hwBounceBars = [
  ...bars5m.slice(0, bars5m.length - 1),
  { t: hwBounceT, o: hwMed.hi + 2, h: hwMed.hi + 25, l: hwMed.lo - 8, c: hwMed.hi + 15, v: 1 },
];
const wideAllowed = RedBarTrend.detectFibBounceSetup({
  bars5m: hwBounceBars,
  advanced: advWide,
  evalTs: hwBounceT + 5 * 60000,
});
ok('wide sandwich (>= 120 pts) allows detectFibBounceSetup inside [lo, hi]', wideAllowed.triggered === true && wideAllowed.side === 'bullish', JSON.stringify(wideAllowed));

console.log('\n[6] 15m Anchor + No 5m trigger inside forming 15m First Red');
const day13 = '2026-11-13';
const bars15_test = [];
for (let d = -2; d <= 0; d++) {
  const baseDay = RedBarTrend.shiftDay(day13, d);
  const parts = baseDay.split('-').map(Number);
  for (let m = 0; m < 25; m++) {
    const t = ist(parts[0], parts[1], parts[2], 9, 15) + m * 15 * 60000;
    bars15_test.push({ t, o: 25200, h: 25210, l: 25190, c: 25205, v: 1 });
  }
}
// Override today's 09:15 (15m green) and 09:30 (15m red: 25120 -> 25080)
const t0915 = ist(2026, 11, 13, 9, 15);
const t0930 = ist(2026, 11, 13, 9, 30);
const t0945 = ist(2026, 11, 13, 9, 45);
const idx0915 = bars15_test.findIndex((b) => b.t === t0915);
bars15_test[idx0915] = { t: t0915, o: 25150, h: 25210, l: 25140, c: 25180, v: 1 };
bars15_test[idx0915 + 1] = { t: t0930, o: 25180, h: 25185, l: 25115, c: 25120, v: 1 };
const slice15 = bars15_test.slice(0, idx0915 + 2);
const bars5_test = [
  { t: ist(2026, 11, 12, 15, 25), o: 25190, h: 25200, l: 25180, c: 25195, v: 1 },
  { t: t0915, o: 25150, h: 25180, l: 25140, c: 25175, v: 1 },
  { t: t0915 + 5 * 60000, o: 25175, h: 25210, l: 25170, c: 25190, v: 1 },
  { t: t0915 + 10 * 60000, o: 25190, h: 25195, l: 25165, c: 25180, v: 1 },
  // 5m candles INSIDE forming 09:30-09:45 15m First Red (at 09:35, tags 09:15 median 25175 -> must NOT fire!)
  { t: t0930, o: 25180, h: 25185, l: 25150, c: 25155, v: 1 },
  { t: t0930 + 5 * 60000, o: 25155, h: 25185, l: 25145, c: 25180, v: 1 },
  { t: t0930 + 10 * 60000, o: 25180, h: 25182, l: 25115, c: 25120, v: 1 },
];
const fr15 = RedBarTrend.firstRedBarOfSession(slice15, day13, { id: 'NIFTY', dayMode: 'ist', asOfTs: t0945 + 1000, barMs: 15 * 60000 });
const adv15 = RedBarTrend.buildAdvancedNiftyFibs({
  bars5m: bars5_test,
  bars15m: slice15,
  asOfDay: day13,
  evalTs: t0945 + 1000,
  firstRed1h: fr15,
  dayMode: 'ist',
});
ok('15m anchor uses 09:15-09:30 15m box (high=25210, barMs=900000)', adv15?.firstBar?.barMs === 900000 && adv15?.firstBar?.high === 25210);
const insideFrCheck = RedBarTrend.detectFibBounceSetup({
  bars5m: bars5_test,
  advanced: { ...adv15, sandwich: null },
  evalTs: t0945 + 1000,
});
ok('5m bar inside forming 15m First Red does not fire fib_bounce', insideFrCheck.triggered === false, JSON.stringify(insideFrCheck));
// Narrow sandwich check inside readAt: price strictly inside (25150, 25160) -> fib_sandwich_wait (no trade1_departure bypass)
const swCheckBars15 = [...slice15, { t: t0945, o: 25152, h: 25157, l: 25151, c: 25155, v: 1 }];
const swRead = RedBarTrend.readAt(swCheckBars15, swCheckBars15.length - 1, {
  ...nifty,
  asOfTs: t0945 + 6 * 60000,
  firstRed1h: fr15,
  bars1h: swCheckBars15,
  bars15m: swCheckBars15,
  bars5m: [...bars5_test, { t: t0945, o: 25152, h: 25157, l: 25151, c: 25155, v: 1 }],
});
ok('narrow (<120) sandwich sets setupKind=fib_sandwich_wait and blocks trade1_departure', swRead?.setupKind === 'fib_sandwich_wait', JSON.stringify({ setupKind: swRead?.setupKind, trend: swRead?.trend }));

console.log('\n[7] Pure 5m NIFTY readAt anchors Day Fib + First Red on 5m');
const bars5_chron = [
  ...bars5_test,
  { t: ist(2026, 11, 13, 9, 20), o: 25175, h: 25180, l: 25140, c: 25145, v: 1 },
].sort((a, b) => a.t - b.t);
const fr5Live = RedBarTrend.firstRedBarOfSession(bars5_chron, day13, { ...nifty, asOfTs: t0945 + 1000, barMs: 5 * 60000 });
ok('5m First Red picks first 5m red bar after 09:15 (09:20)',
  fr5Live && fr5Live.t === ist(2026, 11, 13, 9, 20) && fr5Live.barMs === 300000, JSON.stringify(fr5Live && { t: fr5Live.t, barMs: fr5Live.barMs }));
const pure5Read = RedBarTrend.readAt(swCheckBars15, swCheckBars15.length - 1, {
  ...nifty,
  asOfTs: t0945 + 6 * 60000,
  firstRed1h: fr5Live,
  bars15m: swCheckBars15,
  bars5m: [...bars5_chron, { t: t0945, o: 25152, h: 25157, l: 25151, c: 25155, v: 1 }],
});
ok('NIFTY readAt keeps both Day Fib and First Red on 5m (barMs=300000)',
  pure5Read?.advancedFibs?.firstBar?.barMs === 300000 && pure5Read?.advancedFibs?.firstRed?.barMs === 300000,
  JSON.stringify({ fbMs: pure5Read?.advancedFibs?.firstBar?.barMs, frMs: pure5Read?.advancedFibs?.firstRed?.barMs }));

console.log(failed ? `\nFAILED ${failed}` : '\nALL PASS');
process.exit(failed ? 1 : 0);
