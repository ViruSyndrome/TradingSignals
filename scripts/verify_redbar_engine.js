const redbar = require('../js/redbar_trend.js');

console.log('Testing redbar_trend.js with NIFTY simulated bars:');
const baseTs = new Date('2026-11-04T09:15:00+05:30').getTime();
const bars5m = [];
let px = 24300;
// 09:15 to 12:30 (39 bars)
for (let i = 0; i < 39; i++) {
  px -= (150 / 39);
  bars5m.push({ t: baseTs + i * 5 * 60000, o: px + 1, h: px + 3, l: px - 2, c: px });
}
// 12:30 to 12:45 (3 bars)
for (let i = 39; i < 42; i++) {
  bars5m.push({ t: baseTs + i * 5 * 60000, o: px, h: px + 2, l: px - 2, c: px });
}
// 12:45 to 13:15 (6 bars - RED 12:45 bar)
for (let i = 42; i < 48; i++) {
  px = 24150 - (i - 42) * 3;
  bars5m.push({ t: baseTs + i * 5 * 60000, o: px + 2, h: 24155, l: 24120, c: px });
}
// 13:20 (5m break above 12:45 High 24155 -> Bullish Reversal)
bars5m.push({ t: baseTs + 48 * 5 * 60000, o: 24150, h: 24180, l: 24155, c: 24175 });

// 15m aggregated bars for working timeframe
const bars15m = [];
for (let i = 0; i < bars5m.length; i += 3) {
  const chunk = bars5m.slice(i, i + 3);
  bars15m.push({
    t: chunk[0].t,
    o: chunk[0].o,
    h: Math.max(...chunk.map((b) => b.h)),
    l: Math.min(...chunk.map((b) => b.l)),
    c: chunk[chunk.length - 1].c,
  });
}

const cfg = {
  id: 'NIFTY',
  symbol: '^NSEI',
  dayMode: 'ist',
  firstRedTf: '15m',
  bars5m,
  bars1h: bars15m,
};

const readout = redbar.readAt(bars15m, bars15m.length - 1, cfg);
console.log('Readout Results:');
console.log('  Price:', readout.price);
console.log('  Trend:', readout.trend);
console.log('  SetupKind:', readout.setupKind);
console.log('  ActionState:', readout.actionState);
console.log('  ActionReason:', readout.actionReason);
console.log('  Invalidation (SL):', readout.invalidation);
console.log('  TP1:', readout.tp1, 'TP3:', readout.tp3);
console.log('  Equinox Baseline:', readout.equinox?.baseline, 'Territory:', readout.equinox?.territory);
console.log('  Afternoon 12:45 Setup:', readout.afternoon1245?.setupKind, 'Side:', readout.afternoon1245?.side);

if (readout.setupKind === 'afternoon_1245_reversal' && readout.actionState === 'enter') {
  console.log('VERIFICATION: PASS! 12:45 Afternoon Engine successfully triggered LIVE ENTER!');
} else {
  console.log('VERIFICATION: Check details above.');
}

// Test Equinox Gate Blocking Bearish trade in Positive Territory
console.log('\nTesting Equinox Block for BEARISH in Positive Territory:');
const gateRes = redbar.entryGate({
  trend: 'bearish',
  setupKind: 'afternoon_1245_reversal',
  rr: 3.0,
  stopStructural: true,
  invalidationReason: '12:45 reversal 5m swing stop',
  stopPct: 0.5,
  renko: null,
  clock: { id: 'london' },
  asOfTs: baseTs + 48 * 5 * 60000,
  instrumentId: 'NIFTY',
  season: 'SEP–DEC',
  setupTriggerTs: baseTs + 48 * 5 * 60000,
  entryPrice: 24175,
  stopPrice: 24190,
  livePrice: 24175,
  revisitRead: null,
  tpHint: null,
  equinox: { baseline: 22860, territory: 'positive', seasonActive: true },
});

console.log('Equinox Block Result:', gateRes);
if (gateRes.state === 'watch' && gateRes.reason.includes('Blocked by Macro Equinox Rule')) {
  console.log('EQUINOX VERIFICATION: PASS! Bearish entry strictly forbidden in Positive Territory!');
} else {
  console.log('EQUINOX VERIFICATION: FAIL!');
}
