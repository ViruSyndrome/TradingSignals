const assert = require('assert');
const RedBarTrend = require('../js/redbar_trend');
const { DHAN_INSTRUMENT_SPECS } = require('../js/dhan_nifty_trade');

console.log('=== RUNNING MCX FIXES & VERIFICATION TESTS ===\n');

// Test 1: Instrument Classification
assert.strictEqual(RedBarTrend.isMcxCommodity('CRUDEOIL'), true, 'CRUDEOIL is MCX');
assert.strictEqual(RedBarTrend.isMcxCommodity('NG'), true, 'NG is MCX');
assert.strictEqual(RedBarTrend.isMcxCommodity('NATURALGAS'), true, 'NATURALGAS is MCX');
assert.strictEqual(RedBarTrend.isMcxCommodity('NIFTY'), false, 'NIFTY is not MCX');
assert.strictEqual(RedBarTrend.isIndianIndex('NIFTY'), true, 'NIFTY is Indian Index');
assert.strictEqual(RedBarTrend.isIndianIndex('CRUDEOIL'), false, 'CRUDEOIL is not Indian Index');
console.log('Test 1 PASSED: Instrument classification decoupled cleanly.');

// Test 2: Actionable Setups
assert(RedBarTrend.ACTIONABLE_SETUPS.includes('mcx_530_breakout'), 'mcx_530_breakout is actionable');
assert(RedBarTrend.ACTIONABLE_SETUPS.includes('mcx_530_retest'), 'mcx_530_retest is actionable');
assert(RedBarTrend.ACTIONABLE_SETUPS.includes('mcx_530_reversal'), 'mcx_530_reversal is actionable');
console.log('Test 2 PASSED: 5:30 Formula setups in ACTIONABLE_SETUPS.');

// Test 3: TP Multipliers & Crude Target Alignment
assert.strictEqual(DHAN_INSTRUMENT_SPECS.CRUDEOIL.tpMult, 2.4, 'Crude tpMult is 2.4');
assert.strictEqual(DHAN_INSTRUMENT_SPECS.CRUDEOIL.minSlPts, 15, 'Crude minSlPts is 15');
assert.strictEqual(DHAN_INSTRUMENT_SPECS.NG.tpMult, 2.5, 'NG tpMult is 2.5');
assert.strictEqual(DHAN_INSTRUMENT_SPECS.NG.minSlPts, 2.5, 'NG minSlPts is 2.5');
assert.strictEqual(DHAN_INSTRUMENT_SPECS.NIFTY.tpMult, 3.0, 'NIFTY tpMult is 3.0');

// Verify Crude 15 pt SL -> 36 pt TP math (15 * 2.4 = 36)
const crudeOneR = 15;
const crudeTargetPts = crudeOneR * DHAN_INSTRUMENT_SPECS.CRUDEOIL.tpMult;
assert.strictEqual(crudeTargetPts, 36.0, '15 pt SL * 2.4 = 36 pt TP (matches Dr Dev order ticket)');
console.log('Test 3 PASSED: Crude TP reconciled to 36 pts (~2.4R) at 15 pt SL floor.');

// Test 4: Contract Freshness & Rollover Guard
assert.strictEqual(DHAN_INSTRUMENT_SPECS.CRUDEOIL.underlyingExpiry, '2026-11-17');
assert.strictEqual(DHAN_INSTRUMENT_SPECS.NG.underlyingExpiry, '2026-11-20');
console.log('Test 4 PASSED: Contract expiry tracking active (Crude: 2026-11-17, NG: 2026-11-20).');

// Test 5: isBtcGate Leak Fix in entryGate
// If instrumentId is CRUDEOIL or NG, pre_asia clock must NOT block ENTER
const gateTestPreAsia = RedBarTrend.entryGate({
  trend: 'bullish',
  setupKind: 'trade1_departure',
  rr: 2.4,
  stopStructural: true,
  invalidationReason: '15m swing (session box low)',
  stopPct: 1.2, // > 1% stopPct must NOT block MCX (only blocks BTC)
  renko: null,
  clock: { id: 'pre_asia' }, // pre_asia must NOT block MCX
  asOfTs: Date.now(),
  instrumentId: 'CRUDEOIL',
  season: 'SEP–DEC',
  setupTriggerTs: Date.now() - 5 * 60000,
  entryPrice: 8200,
  stopPrice: 8100,
  livePrice: 8205,
});
assert.strictEqual(gateTestPreAsia.state, 'enter', `CRUDEOIL must ENTER even during pre_asia clock and stopPct > 1%: got ${gateTestPreAsia.state} (${gateTestPreAsia.reason})`);
console.log('Test 5 PASSED: MCX completely decoupled from BTC gates (pre_asia and 1% stop cap bypassed).');

// Test 6: 5:30 Formula Detection (17:30 IST candle breakout)
const baseDay = '2026-11-10';
// Build 5m bars starting at 17:30 IST (12:00 UTC)
const t1730 = new Date('2026-11-10T17:30:00+05:30').getTime();
const bars5m = [
  { t: t1730, o: 8200, h: 8220, l: 8190, c: 8210, v: 100 },
  { t: t1730 + 5 * 60000, o: 8210, h: 8230, l: 8205, c: 8225, v: 100 },
  { t: t1730 + 10 * 60000, o: 8225, h: 8240, l: 8220, c: 8235, v: 100 },
  { t: t1730 + 15 * 60000, o: 8235, h: 8245, l: 8225, c: 8240, v: 100 },
  { t: t1730 + 20 * 60000, o: 8240, h: 8250, l: 8230, c: 8245, v: 100 },
  { t: t1730 + 25 * 60000, o: 8245, h: 8250, l: 8235, c: 8248, v: 100 }, // 17:55 bar closes at 18:00 (High: 8250, Low: 8190)
  // 18:00 bar: Breakout candle closing above 8250 at 8265
  { t: t1730 + 30 * 60000, o: 8248, h: 8270, l: 8245, c: 8265, v: 150 },
];
const evalTs1806 = t1730 + 36 * 60000; // 18:06 IST
const formulaRes = RedBarTrend.detectMcx530FormulaTrikal(bars5m, evalTs1806);
assert(formulaRes, '5:30 Formula must detect 17:30 candle and breakout');
assert.strictEqual(formulaRes.setupKind, 'mcx_530_breakout', `setupKind should be mcx_530_breakout, got ${formulaRes.setupKind}`);
assert.strictEqual(formulaRes.side, 'bullish', 'side should be bullish');
assert.strictEqual(formulaRes.triggered, true, 'triggered should be true');
assert.strictEqual(formulaRes.xCandle.high, 8250, 'xCandle high is 8250');
assert.strictEqual(formulaRes.xCandle.low, 8190, 'xCandle low is 8190');
console.log('Test 6 PASSED: detectMcx530FormulaTrikal correctly detected 17:30 30m candle and 18:00 breakout.');

// Test 7: Entry gate accepts mcx_530_breakout
const gateTest530 = RedBarTrend.entryGate({
  trend: formulaRes.side,
  setupKind: formulaRes.setupKind,
  rr: 2.4,
  stopStructural: true,
  invalidationReason: '5:30 Formula 30m Europe X stop',
  stopPct: 0.8,
  renko: null,
  clock: { id: 'mcx_eve' },
  asOfTs: evalTs1806,
  instrumentId: 'CRUDEOIL',
  season: 'SEP–DEC',
  setupTriggerTs: formulaRes.triggerTs,
  entryPrice: formulaRes.triggerPrice,
  stopPrice: formulaRes.stopLoss,
  livePrice: 8266,
});
assert.strictEqual(gateTest530.state, 'enter', `5:30 Formula must ENTER: got ${gateTest530.state} (${gateTest530.reason})`);
console.log('Test 7 PASSED: entryGate allows mcx_530_breakout to ENTER.');

// Test 8: True shelf retest requires touch + later bounce close (not proximity alone)
const barsRetest = [
  { t: t1730, o: 8200, h: 8220, l: 8190, c: 8210, v: 100 },
  { t: t1730 + 5 * 60000, o: 8210, h: 8230, l: 8205, c: 8225, v: 100 },
  { t: t1730 + 10 * 60000, o: 8225, h: 8240, l: 8220, c: 8235, v: 100 },
  { t: t1730 + 15 * 60000, o: 8235, h: 8245, l: 8225, c: 8240, v: 100 },
  { t: t1730 + 20 * 60000, o: 8240, h: 8250, l: 8230, c: 8245, v: 100 },
  { t: t1730 + 25 * 60000, o: 8245, h: 8250, l: 8235, c: 8248, v: 100 }, // X high 8250 / low 8190
  { t: t1730 + 30 * 60000, o: 8248, h: 8270, l: 8245, c: 8265, v: 150 }, // breakout
  { t: t1730 + 35 * 60000, o: 8265, h: 8268, l: 8248, c: 8252, v: 120 }, // touch shelf ~8250
  { t: t1730 + 40 * 60000, o: 8252, h: 8275, l: 8250, c: 8272, v: 140 }, // bounce close above shelf
];
const evalRetest = t1730 + 46 * 60000; // 18:16 IST
const retestRes = RedBarTrend.detectMcx530FormulaTrikal(barsRetest, evalRetest);
assert(retestRes, 'retest path must return a setup');
assert.strictEqual(retestRes.setupKind, 'mcx_530_retest', `expected mcx_530_retest, got ${retestRes.setupKind}`);
assert.strictEqual(retestRes.side, 'bullish', 'retest side bullish');
assert.strictEqual(retestRes.triggered, true, 'retest triggered');
console.log('Test 8 PASSED: mcx_530_retest requires shelf touch + 5m bounce confirm.');

// Test 9: proximity-only after breakout is breakout, not fake retest
const barsProx = bars5m.concat([
  { t: t1730 + 35 * 60000, o: 8265, h: 8280, l: 8260, c: 8275, v: 100 }, // continues higher — no shelf touch
]);
const proxRes = RedBarTrend.detectMcx530FormulaTrikal(barsProx, t1730 + 40 * 60000);
assert.strictEqual(proxRes.setupKind, 'mcx_530_breakout', `proximity chase must stay breakout, got ${proxRes && proxRes.setupKind}`);
console.log('Test 9 PASSED: near-high continuation without shelf touch stays breakout.');

console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
