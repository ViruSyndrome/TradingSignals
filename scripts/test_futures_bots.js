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
  ]).then(async ([ce, pe]) => {
    assert.strictEqual(ce.strike, 25150, `LONG @ 25180 must pick 25150 CE (not OTM 25200), got ${ce.strike}`);
    assert.strictEqual(pe.strike, 25200, `SHORT @ 25180 must pick 25200 PE (not OTM 25150), got ${pe.strike}`);
    console.log(`Nov 6 Close Track 1 Readiness: ITM/ATM strikes verified (LONG->${ce.strike}CE, SHORT->${pe.strike}PE), minSl=${lv.slPts}pts, Nov 9 & 12 guards verified`);

    // 4. Verify Swing Options (7-25 DTE Selection + MARGIN + Balance & Position Guards)
    const { createDhanNiftyTrade: createSwingNiftyTrade } = require('../js/dhan_nifty_trade.js');
    const { executeOptionSwingOrder } = require('../js/futures_bot_runtime.js');
    const nowUtc = Date.now();
    const fmtDate = (daysAhead) => new Date(nowUtc + daysAhead * 86400000).toISOString().slice(0, 10);
    const nearExp = fmtDate(2);
    const swingExp = fmtDate(8);
    const farExp = fmtDate(29);

    const mockSwingClient = {
      isConfigured: () => true,
      getOptionExpiryList: async () => ({ data: [nearExp, swingExp, farExp] }),
      getOptionChain: async ({ expiry }) => ({
        data: {
          expiry,
          last_price: 25144,
          oc: {
            '25100.000000': { ce: { security_id: '55100CE', last_price: 270, top_ask_price: 270, greeks: { delta: 0.58 } }, pe: { security_id: '55100PE', last_price: 200, top_ask_price: 200, greeks: { delta: -0.42 } } },
            '25150.000000': { ce: { security_id: '55150CE', last_price: 235, top_ask_price: 235, greeks: { delta: 0.51 } }, pe: { security_id: '55150PE', last_price: 225, top_ask_price: 225, greeks: { delta: -0.46 } } },
          },
        },
      }),
    };
    const swingTrader = createSwingNiftyTrade({ client: mockSwingClient, productType: 'MARGIN' });
    const swingCe = await swingTrader.pickOptionContract({ side: 'LONG', spot: 25144, minDteDays: 7, maxDteDays: 25, strikeMode: 'atm' });
    const swingPe = await swingTrader.pickOptionContract({ side: 'SHORT', spot: 25144, minDteDays: 7, maxDteDays: 25, strikeMode: 'atm' });
    assert.strictEqual(swingCe.expiry, swingExp, `Swing CE must skip ${nearExp} (<7 DTE) and pick ${swingExp}, got ${swingCe.expiry}`);
    assert.strictEqual(swingPe.expiry, swingExp, `Swing PE must skip ${nearExp} (<7 DTE) and pick ${swingExp}, got ${swingPe.expiry}`);
    assert.strictEqual(swingCe.strike, 25100, `LONG @ 25144 must pick 25100 CE, got ${swingCe.strike}`);
    assert.strictEqual(swingPe.strike, 25150, `SHORT @ 25144 must pick 25150 PE, got ${swingPe.strike}`);

    // Mon 2026-11-16 10:00 IST = 04:30 UTC
    const marketOpenMs = Date.parse('2026-11-16T04:30:00Z');
    const marketClosedMs = Date.parse('2026-11-15T04:30:00Z'); // Sunday
    const placedOrders = [];
    const mockExecDhan = {
      isConfigured: () => true,
      getFundLimits: async () => ({ availabelBalance: 15000 }),
      getPositions: async () => [{ securityId: '55100CE', netQty: 65 }],
      placeOrder: async (payload) => { placedOrders.push(payload); return { orderId: 'ORD999' }; },
    };

    const closedRes = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55100CE', txType: 'BUY', lots: 1, qtyPerLot: 65, estPremium: 270, nowMs: marketClosedMs });
    assert.strictEqual(closedRes.reason, 'MARKET_CLOSED');

    const poorRes = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55100CE', txType: 'BUY', lots: 1, qtyPerLot: 65, estPremium: 270, nowMs: marketOpenMs });
    assert.strictEqual(poorRes.reason, 'INSUFFICIENT_FUNDS'); // needs 270*65*1.03 = ₹18,076.50 > ₹15,000

    const noPosRes = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55150PE', txType: 'SELL', lots: 1, qtyPerLot: 65, nowMs: marketOpenMs });
    assert.strictEqual(noPosRes.reason, 'NO_OPEN_POSITION');

    mockExecDhan.getFundLimits = async () => ({ availabelBalance: 25000 });
    const reservedRes = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55100CE', txType: 'BUY', lots: 1, qtyPerLot: 65, estPremium: 270, minRemainingRs: 15000, nowMs: marketOpenMs });
    assert.strictEqual(reservedRes.reason, 'RESERVED_FOR_PRIORITY');

    mockExecDhan.getFundLimits = async () => ({ availabelBalance: 37790.76 });
    const okBuy = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55100CE', txType: 'BUY', lots: 1, qtyPerLot: 65, estPremium: 270, nowMs: marketOpenMs });
    assert.strictEqual(okBuy.placed, true);
    assert.strictEqual(placedOrders[0].productType, 'MARGIN');

    // 7. Verify HA+EMA+CCI BTC entryWindowsUtc gate + Binance openSingleStopTrade guards
    const b1hPath = path.join(__dirname, '..', '.cache_binance_um', 'BTCUSDT_1h_2025-10.json');
    if (fs.existsSync(b1hPath)) {
      const bars1h = [
        ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.cache_binance_um', 'BTCUSDT_1h_2025-09.json'), 'utf8')),
        ...JSON.parse(fs.readFileSync(b1hPath, 'utf8')),
      ].map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) }));
      const indBtc = prepareIndicators(bars1h);
      const stBtc = initHa();
      for (let i = 205; i < bars1h.length; i++) {
        stepHaEmaCciBar(bars1h, i, stBtc, { symbol: 'BTCUSDT', entryWindowsUtc: [[180, 590]], exitMode: 'chandelier', chandMult: 4.5, quietFilter: false, entryGate: 'all', ind: indBtc });
      }
      for (const tr of stBtc.closedTrades) {
        const d = new Date(tr.entryTs);
        const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
        assert(mins >= 180 && mins <= 590, `BTC entry ${d.toISOString()} outside UTC 03:00-09:50 window`);
      }
      console.log(`BTC HA+EMA+CCI UTC window verified (${stBtc.closedTrades.length} trades in 2025-09..10 slice)`);
    }

    const { createBinanceFuturesTrade } = require('../js/binance_futures_trade.js');
    const origFetch = global.fetch;
    let mockPosAmt = '-0.012';
    const mockCalls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      mockCalls.push({ method: init.method || 'GET', url: u });
      const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });
      if (u.includes('/fapi/v1/time')) return okJson({ serverTime: Date.now() });
      if (u.includes('/fapi/v1/exchangeInfo')) {
        return okJson({
          symbols: [{
            symbol: 'BTCUSDT',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.10' },
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '50' },
            ],
          }],
        });
      }
      if (u.includes('/fapi/v2/positionRisk')) return okJson([{ symbol: 'BTCUSDT', positionAmt: mockPosAmt }]);
      if (u.includes('/fapi/v1/marginType') || u.includes('/fapi/v1/leverage')) return okJson({ code: 200, msg: 'success' });
      if (u.includes('/fapi/v1/openAlgoOrders') || u.includes('/fapi/v1/openOrders')) return okJson([]);
      if (u.includes('/fapi/v1/allOpenOrders')) return okJson({ code: 200 });
      if (u.includes('/fapi/v1/order')) return okJson({ orderId: 1001, executedQty: '0.002', avgPrice: '65000.0' });
      if (u.includes('/fapi/v1/algoOrder')) return okJson({ algoId: 2002 });
      return okJson({});
    };
    try {
      const bTrade = createBinanceFuturesTrade({ apiKey: 'test_k', apiSecret: 'test_s' });
      const busyRes = await bTrade.openSingleStopTrade({ symbol: 'BTCUSDT', side: 'LONG', marginUsdt: 75, leverage: 2, stopPrice: 63000, entryHint: 65000 });
      assert.strictEqual(busyRes.reason, 'POSITION_ALREADY_OPEN');

      mockPosAmt = '0';
      const badSlRes = await bTrade.openSingleStopTrade({ symbol: 'BTCUSDT', side: 'LONG', marginUsdt: 75, leverage: 2, stopPrice: 66000, entryHint: 65000 });
      assert.strictEqual(badSlRes.reason, 'INVALID_STOP_VS_MARK');

      const tinyRes = await bTrade.openSingleStopTrade({ symbol: 'BTCUSDT', side: 'LONG', marginUsdt: 20, leverage: 2, stopPrice: 63000, entryHint: 65000 });
      assert.strictEqual(tinyRes.reason, 'BELOW_MIN_NOTIONAL');

      const goodRes = await bTrade.openSingleStopTrade({ symbol: 'BTCUSDT', side: 'LONG', marginUsdt: 75, leverage: 2, stopPrice: 63000, entryHint: 65000 });
      assert.strictEqual(goodRes.ok, true);
      assert.strictEqual(goodRes.qty, 0.002);
      assert.strictEqual(goodRes.stopAlgoId, 2002);
      console.log('Binance Single-Stop Trade Guards OK: POSITION_ALREADY_OPEN, INVALID_STOP_VS_MARK, BELOW_MIN_NOTIONAL, MARKET+STOP_MARKET verified');
    } finally {
      global.fetch = origFetch;
    }

    const okSell = await executeOptionSwingOrder(mockExecDhan, { autoTrade: true, securityId: '55100CE', txType: 'SELL', lots: 1, qtyPerLot: 65, nowMs: marketOpenMs });
    assert.strictEqual(okSell.placed, true);
    assert.strictEqual(placedOrders[1].productType, 'MARGIN');

    const { renderTradeCardPng } = require('../js/tg_card.js');
    const niftySlice = load('NIFTY', '15m').slice(-48);
    const png = renderTradeCardPng({
      kind: 'ENTER_LONG',
      title: 'AI RENKO MODE C • NIFTY 15m',
      subtitle: 'Brick 33.33 • ST 25040.50',
      execBadge: 'LIVE OPTIONS',
      bars: niftySlice,
      levels: [
        { price: niftySlice[niftySlice.length - 1].c, label: 'ENTRY', color: '#38bdf8' },
        { price: niftySlice[niftySlice.length - 1].c - 150, label: 'CAP SL -150p', color: '#ef4444' },
      ],
      metrics: [
        { label: 'Dhan Option', value: '25100 CE (2026-11-23)', sub: '1 lot (65 qty)' },
        { label: 'Option Entry', value: '₹269.95', sub: 'Delta 0.58 (LIVE)' },
      ],
    });
    assert(Buffer.isBuffer(png) && png.length > 5000 && png[0] === 0x89 && png[1] === 0x50, 'tg_card PNG signature failed');

    console.log(`Swing Options Guards OK: DTE skipped ${nearExp} -> ${swingExp}, MARGIN verified, MARKET_CLOSED / INSUFFICIENT_FUNDS / NO_OPEN_POSITION guards verified`);
    console.log('ALL_FUTURES_BOT_ENGINE_TESTS_PASSED');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
