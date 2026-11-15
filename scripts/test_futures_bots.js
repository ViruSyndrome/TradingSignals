'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { computeATR, createInitialState: initPat, stepPatrickBar } = require('../js/patrick_swing_engine.js');
const { prepareIndicators, createInitialState: initHa, stepHaEmaCciBar } = require('../js/ha_ema_cci_engine.js');

function load(sym, tf) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.cache_desk', `${sym}_${tf}.json`), 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.bars || [];
  return arr
    .map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

// 1. Verify Patrick 3-lot split vs 1-lot singleLotTrail on NIFTY 15m
{
  const nifty = load('NIFTY', '15m');
  const atr = computeATR(nifty, 14);
  for (const singleLot of [false, true]) {
    const st = initPat();
    for (let i = 0; i < nifty.length; i++) {
      stepPatrickBar(nifty, i, st, { tf: '15m', mode: 'ALL', singleLotTrail: singleLot, atrArr: atr });
    }
    const grossPts = st.closedTrades.reduce((s, t) => s + t.grossPts, 0);
    const netPts = st.closedTrades.reduce((s, t) => s + (t.grossPts - 9.3), 0);
    const wins = st.closedTrades.filter((t) => t.grossPts - 9.3 > 0).length;
    console.log(`Patrick Engine NIFTY 15m (singleLotTrail=${singleLot}): tr=${st.closedTrades.length}, wins=${wins}, gross=${grossPts.toFixed(1)}, netPts=${netPts.toFixed(1)} (₹${Math.round(netPts * 65)})`);
    assert(st.closedTrades.length === 31, 'Expected 31 NIFTY Patrick trades');
    if (!singleLot) {
      assert(Math.abs(grossPts - 2551.7) < 2.0, `Expected ~2551.7 gross pts, got ${grossPts}`);
    }
  }
  // Verify Volume Filter (volFilter=true) on Dhan NIFTY 15m: 26 trades, 16W (61.5% WR) on Split, +2521.8 net pts (₹1,63,920) on 1-Lot
  for (const singleLot of [false, true]) {
    const st = initPat();
    for (let i = 0; i < nifty.length; i++) {
      stepPatrickBar(nifty, i, st, { tf: '15m', mode: 'ALL', singleLotTrail: singleLot, atrArr: atr, volFilter: true });
    }
    const netPts = st.closedTrades.reduce((s, t) => s + (t.grossPts - 9.3), 0);
    const wins = st.closedTrades.filter((t) => t.grossPts - 9.3 > 0).length;
    const wr = (wins / st.closedTrades.length * 100).toFixed(1);
    console.log(`Patrick Engine NIFTY 15m [volFilter=true, singleLot=${singleLot}]: tr=${st.closedTrades.length}, wins=${wins} (${wr}%), netPts=${netPts.toFixed(1)} (₹${Math.round(netPts * 65)})`);
    assert.strictEqual(st.closedTrades.length, 26, `Expected 26 vol-filtered NIFTY Patrick trades, got ${st.closedTrades.length}`);
    if (!singleLot) assert.strictEqual(wins, 16, `Expected 16/26 wins (61.5% WR) on Split volFilter, got ${wins}`);
  }
}

// 2. Verify HA+EMA+CCI Engine matches backtests on NIFTY 15m (cci), CRUDEOIL 15m (chand 2.5), XAU 1h (chand 3.5)
{
  const cases = [
    { sym: 'NIFTY', tf: '15m', exitMode: 'cci', chandMult: 4.5, friction: 9.3, expTrades: 54, expGross: 2215.6 },
    { sym: 'CRUDEOIL', tf: '15m', exitMode: 'chandelier', chandMult: 2.5, friction: 7.5, expTrades: 27, expGross: 668.1 },
    { sym: 'XAU', tf: '1h', exitMode: 'chandelier', chandMult: 3.5, friction: 0.80, expTrades: 92, expGross: 730.4 },
  ];
  for (const c of cases) {
    const bars = load(c.sym, c.tf);
    const ind = prepareIndicators(bars);
    const st = initHa();
    for (let i = 0; i < bars.length; i++) {
      stepHaEmaCciBar(bars, i, st, { symbol: c.sym, quietFilter: true, exitMode: c.exitMode, chandMult: c.chandMult, ind });
    }
    const grossPts = st.closedTrades.reduce((s, t) => s + t.grossPts, 0);
    const netPts = st.closedTrades.reduce((s, t) => s + (t.grossPts - c.friction), 0);
    console.log(`HA+EMA+CCI Engine ${c.sym} ${c.tf} (${c.exitMode} ${c.chandMult}x): tr=${st.closedTrades.length}, gross=${grossPts.toFixed(1)}, netPts=${netPts.toFixed(1)}`);
    assert.strictEqual(st.closedTrades.length, c.expTrades, `${c.sym} trade count mismatch`);
    assert(Math.abs(grossPts - c.expGross) < 2.0, `${c.sym} gross pts mismatch: got ${grossPts}`);
  }
}

// 3. Verify Track 1 (archive/nov6-close/) Pre-Live Readiness, Nov 9 Fixes & Absence of Nov 12 Bleed
{
  const nov6Dir = path.join(__dirname, '..', 'archive', 'nov6-close');
  const nov6BotSrc = fs.readFileSync(path.join(nov6Dir, 'bot.js'), 'utf8');
  const nov6CfgSrc = fs.readFileSync(path.join(nov6Dir, 'js', 'config.js'), 'utf8');
  const nov6RbSrc = fs.readFileSync(path.join(nov6Dir, 'js', 'redbar_trend.js'), 'utf8');
  const nov6DhanSrc = fs.readFileSync(path.join(nov6Dir, 'js', 'dhan_nifty_trade.js'), 'utf8');
  const nov6ClientSrc = fs.readFileSync(path.join(nov6Dir, 'js', 'dhan_client.js'), 'utf8');

  // A) Nov 12 bleed paths MUST NOT exist in Track 1
  assert(!nov6CfgSrc.includes('advancedFibs'), 'Track 1 config.js must not have advancedFibs');
  assert(!nov6RbSrc.includes('fib_bounce'), 'Track 1 redbar_trend.js must not have fib_bounce');
  assert(!nov6RbSrc.includes('detectFibBounceSetup'), 'Track 1 redbar_trend.js must not have detectFibBounceSetup');

  // B) Nov 9 + Nov 11-12 fixes MUST exist in Track 1
  assert(nov6RbSrc.includes('minNiftyStop = price * 0.0006'), 'Track 1 redbar_trend.js missing Nov 9 15pt micro-stop floor (90b194f)');
  assert(nov6BotSrc.includes('DHAN_CONSEC_LOSSES_'), 'Track 1 bot.js missing Nov 9 2-consecutive-SL session stop (e58b036/90b194f)');
  assert(nov6BotSrc.includes('DHAN_T1_WON_'), 'Track 1 bot.js missing Nov 9 Trade 1 one-shot lock (07867bc/5c5fc46)');
  assert(nov6BotSrc.includes('DHAN_RULE6_COUNT_'), 'Track 1 bot.js missing Nov 9 Rule 6 1/day cap (07867bc)');
  assert(nov6BotSrc.includes('saveManagedDhanTrades([...closedRows, ...next].slice(-40))'), 'Track 1 bot.js missing Nov 9 closedRows history preservation (07867bc)');
  assert(nov6BotSrc.includes('refuse concurrent order'), 'Track 1 bot.js missing single-position lock (aa1ef13)');
  assert(nov6ClientSrc.includes('_throttleChartCall') && nov6ClientSrc.includes('_klineCache'), 'Track 1 dhan_client.js missing rate-limit queue & kline cache (7241ddc)');
  assert(nov6ClientSrc.includes('r.status === 429'), 'Track 1 dhan_client.js missing HTTP 429 retry (5c3dfd6)');
  assert(nov6DhanSrc.includes('auto-downscaling to 1 lot'), 'Track 1 dhan_nifty_trade.js missing 2-lot-to-1-lot wallet downscale (e606b75)');

  // C) Functional check on Track 1 createDhanNiftyTrade (Nov 9 fix 45271e0: never OTM + >=14pt SL floor)
  const { createDhanNiftyTrade } = require('../archive/nov6-close/js/dhan_nifty_trade.js');
  const mockClient = {
    getOptionExpiryList: async () => ({ data: ['2099-12-31'] }),
    getOptionChain: async () => ({
      data: {
        last_price: 25180,
        oc: {
          '25150.000000': { ce: { security_id: '101', last_price: 150, top_ask_price: 150.5, greeks: { delta: 0.55 } }, pe: { security_id: '102', last_price: 120, top_ask_price: 120.5, greeks: { delta: -0.45 } } },
          '25200.000000': { ce: { security_id: '103', last_price: 125, top_ask_price: 125.5, greeks: { delta: 0.48 } }, pe: { security_id: '104', last_price: 145, top_ask_price: 145.5, greeks: { delta: -0.52 } } },
        },
      },
    }),
  };
  const trader = createDhanNiftyTrade({ client: mockClient });
  // Spot 25180: roundStrike would pick 25200 (OTM for CE!), Nov 9 fix must pick 25150 CE (<= spot) for LONG and 25200 PE (>= spot) for SHORT
  const lv = trader.mapPremiumLevels({ entryPremium: 140, indexEntry: 25180, indexStop: 25170, indexTp1: 25200, delta: 0.52 });
  assert(lv.slPts >= 14, `Expected >=14 option pts SL floor, got ${lv.slPts}`);
  Promise.all([
    trader.pickOptionContract({ side: 'LONG', spot: 25180 }),
    trader.pickOptionContract({ side: 'SHORT', spot: 25180 }),
  ]).then(([ce, pe]) => {
    assert.strictEqual(ce.strike, 25150, `LONG @ 25180 must pick 25150 CE (not OTM 25200), got ${ce.strike}`);
    assert.strictEqual(pe.strike, 25200, `SHORT @ 25180 must pick 25200 PE (not OTM 25150), got ${pe.strike}`);
    console.log(`Nov 6 Close Track 1 Readiness: ITM/ATM strikes verified (LONG->${ce.strike}CE, SHORT->${pe.strike}PE), minSl=${lv.slPts}pts, Nov 9 & 12 guards verified`);
    console.log('ALL_FUTURES_BOT_ENGINE_TESTS_PASSED');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
