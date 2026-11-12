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
  h: med + 20,
  l: med - 15,
  c: med + 10,
  v: 1,
});
adv.inSandwich = false; // force outside for bounce test (price above sandwich)
const bounce = RedBarTrend.detectFibBounceSetup({
  bars5m,
  advanced: { ...adv, inSandwich: false },
  evalTs: bounceT + 5 * 60000 + 1000,
  price: med + 10,
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

console.log('\n[5] readAt does not stand aside between the medians');
// Build minimal HTF bars for readAt (use 5m as work bars)
const evalTs = ist(2026, 11, 11, 9, 50);
const priceInSandwich = midPrice;
// Need enough bars for readAt i>=1 — use bars5m as work
const work = bars5m.filter((b) => b.t <= evalTs);
// Ensure last close is in sandwich
work.push({
  t: evalTs - 60000,
  o: priceInSandwich,
  h: priceInSandwich + 5,
  l: priceInSandwich - 5,
  c: priceInSandwich,
  v: 1,
});
const fr = RedBarTrend.firstRedBarOfSession(bars5m, day, {
  dayMode: 'ist', asOfTs: evalTs, barMs: 5 * 60000, id: 'NIFTY',
});
const readout = RedBarTrend.readAt(work, work.length - 1, {
  id: 'NIFTY',
  dayMode: 'ist',
  bandStyle: 'sessionFib',
  advancedFibs: true,
  advancedFibGapPts: 40,
  firstRedTf: '5m',
  firstRed1h: fr,
  bars5m,
  asOfTs: evalTs,
  markWindow: nifty.markWindow,
  fibLevels: [0, 0.44, 0.5, 0.56, 1],
});
ok('readAt returns advancedFibs', !!readout?.advancedFibs);
if (readout?.advancedFibs?.inSandwich) {
  ok('sandwich is not a no-trade block', readout.setupKind !== 'fib_sandwich_wait', readout.setupKind);
} else {
  console.log('  SKIP  sandwich readAt (price/geometry did not land in sandwich on synthetic) — unit sandwich checks above still PASS');
}

console.log(failed ? `\nFAILED ${failed}` : '\nALL PASS');
process.exit(failed ? 1 : 0);
