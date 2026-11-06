'use strict';

/**
 * Dhan NIFTY options auto-trader (live).
 * Dr Dev ladder: Super Order (structural SL + ~3R TP) → at 1:1 bank ~50% → runner SL to BE → trail.
 * Need DHAN_NIFTY_LOTS >= 2 for a true 50% bank (lot size won't split a single lot).
 *
 * Requires:
 *   DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN
 *   Oracle/public IP whitelisted in Dhan Static IP (order APIs)
 *   DHAN_AUTO_TRADE=true
 */
const { createDhanClient, isDhanConfigured } = require('./dhan_client.js');

const NIFTY_UNDERLYING = 13;
const NIFTY_SEG = 'IDX_I';
const OPT_SEG = 'NSE_FNO';

function envNum(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

function roundStrike(spot, step = 50) {
  return Math.round(Number(spot) / step) * step;
}

function createDhanNiftyTrade(opts = {}) {
  if (!isDhanConfigured()) {
    throw Object.assign(new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN missing'), { code: 'NO_DHAN_KEYS' });
  }
  const dhan = opts.client || createDhanClient();
  const lotSize = envNum('NIFTY_LOT_SIZE', 65);
  const lots = Math.max(1, Math.min(5, envNum('DHAN_NIFTY_LOTS', 1)));
  const qty = lotSize * lots;
  const deltaGuess = envNum('NIFTY_OPT_DELTA', 0.55);
  const productType = process.env.DHAN_PRODUCT_TYPE || 'INTRADAY';

  async function nearestWeeklyExpiry() {
    const res = await dhan.getOptionExpiryList({
      underlyingScrip: NIFTY_UNDERLYING,
      underlyingSeg: NIFTY_SEG,
    });
    const dates = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    if (!dates.length) throw new Error('No NIFTY option expiries from Dhan');
    const today = new Date();
    const ist = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, '0');
    const d = String(ist.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;
    const upcoming = dates.filter((x) => String(x) >= todayStr).sort();
    return upcoming[0] || dates[dates.length - 1];
  }

  /**
   * Pick CE for LONG bias, PE for SHORT bias — nearest ATM (or 1 ITM if DHAN_STRIKE_MODE=itm).
   */
  async function pickOptionContract({ side, spot }) {
    const expiry = await nearestWeeklyExpiry();
    const chain = await dhan.getOptionChain({
      underlyingScrip: NIFTY_UNDERLYING,
      underlyingSeg: NIFTY_SEG,
      expiry,
    });
    const data = chain?.data || chain;
    const spotPx = Number(spot) || Number(data?.last_price);
    if (!(spotPx > 0)) throw new Error('pickOptionContract: no spot');
    const oc = data?.oc || {};
    const strikes = Object.keys(oc).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!strikes.length) throw new Error('Empty option chain');

    const mode = String(process.env.DHAN_STRIKE_MODE || 'atm').toLowerCase();
    let want = roundStrike(spotPx, 50);
    if (mode === 'itm') {
      // LONG → ITM call (strike below spot); SHORT → ITM put (strike above spot)
      want = side === 'LONG' ? want - 50 : want + 50;
    }
    let best = strikes[0];
    let bestDist = Math.abs(best - want);
    for (const s of strikes) {
      const dist = Math.abs(s - want);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    const node = oc[String(best)] || oc[best.toFixed(6)] || oc[`${best}.000000`];
    // Dhan keys often "25650.000000"
    const node2 = node || oc[Object.keys(oc).find((k) => Math.abs(Number(k) - best) < 0.01)];
    if (!node2) throw new Error(`No chain node for strike ${best}`);
    const leg = side === 'LONG' ? node2.ce : node2.pe;
    if (!leg?.security_id) throw new Error(`No ${side === 'LONG' ? 'CE' : 'PE'} at strike ${best}`);
    const ltp = Number(leg.last_price) || Number(leg.top_ask_price) || Number(leg.top_bid_price) || 0;
    const ask = Number(leg.top_ask_price) || ltp;
    const delta = Math.abs(Number(leg.greeks?.delta) || deltaGuess);
    return {
      expiry,
      strike: best,
      side,
      optSide: side === 'LONG' ? 'CE' : 'PE',
      securityId: String(leg.security_id),
      ltp,
      ask,
      delta,
      symbolHint: `NIFTY ${best} ${side === 'LONG' ? 'CE' : 'PE'} ${expiry}`,
    };
  }

  /**
   * Map index risk/target → option premium SL/TP using delta (or env override pts).
   * Levels are always relative to the Super Order entry `price` (LIMIT), so Dhan's
   * rule targetPrice > price > stopLossPrice holds for BUY options.
   */
  function tickPrem(n) {
    return +(Math.round(Number(n) / 0.05) * 0.05).toFixed(2);
  }

  function mapPremiumLevels({ entryPremium, indexEntry, indexStop, indexTp1, delta }) {
    const d = Math.max(0.25, Math.min(0.9, Number(delta) || deltaGuess));
    const indexRisk = Math.abs(Number(indexEntry) - Number(indexStop));
    const indexReward = Math.abs(Number(indexTp1) - Number(indexEntry));
    const fixedSl = envNum('DHAN_OPT_SL_PTS', 0);
    const fixedTp = envNum('DHAN_OPT_TP_PTS', 0);
    // Dr Dev: structural SL; runner stretch target ~3R (Leg A booked at 1R by manager).
    const tpMult = Math.max(1, envNum('DHAN_TP_R_MULT', 3));
    const slPts = fixedSl > 0 ? fixedSl : Math.max(8, Math.round(indexRisk * d));
    const oneRFromIndex = fixedTp > 0 ? fixedTp : Math.max(12, Math.round(indexReward * d));
    // Prefer premium 1R from SL width; fall back to mapped index 1R.
    const ep = Number(entryPremium);
    const price = tickPrem(ep);
    let stopLossPrice = tickPrem(Math.max(0.05, price - slPts));
    if (!(stopLossPrice < price)) stopLossPrice = tickPrem(Math.max(0.05, price - Math.max(slPts, 5)));
    const oneR = Math.max(oneRFromIndex, +(price - stopLossPrice).toFixed(2));
    let targetPrice = tickPrem(price + oneR * tpMult);
    if (!(targetPrice > price)) targetPrice = tickPrem(price + Math.max(oneR * tpMult, 5));
    return {
      entryPrice: price,
      stopLossPrice,
      targetPrice,
      slPts,
      tpPts: +(targetPrice - price).toFixed(2),
      oneRPts: oneR,
      tpMult,
      delta: d,
    };
  }

  /** Split total option qty into Leg A (bank) + runner. Single lot → bank 0 (BE-only path). */
  function splitBankRunnerQty(totalQty) {
    const q = Math.max(0, Math.floor(Number(totalQty) || 0));
    const lotsTotal = Math.floor(q / lotSize);
    if (lotsTotal < 2) {
      return { bankQty: 0, runnerQty: q, bankLots: 0, runnerLots: lotsTotal, mode: 'be_only' };
    }
    const bankLots = Math.max(1, Math.floor(lotsTotal / 2));
    const bankQty = bankLots * lotSize;
    const runnerQty = q - bankQty;
    return {
      bankQty,
      runnerQty,
      bankLots,
      runnerLots: Math.floor(runnerQty / lotSize),
      mode: 'partial',
    };
  }

  async function cancelSuperAllLegs(orderId) {
    if (!orderId) return;
    for (const leg of ['ENTRY_LEG', 'TARGET_LEG', 'STOP_LOSS_LEG']) {
      try {
        await dhan.cancelSuperOrderLeg(orderId, leg);
      } catch (_) { /* already gone / not cancellable */ }
    }
  }

  /**
   * Dr Dev 1:1: bank ~50% (if 2+ lots), move runner SL → BE, keep/raise TP toward ~3R.
   * Single lot: cannot exchange-split — SL → BE only, stretch TP to 3R.
   */
  async function bankHalfAtOneR({
    orderId,
    securityId,
    entryPremium,
    stopLossPrice,
    targetPrice,
    quantity,
  }) {
    const entry = Number(entryPremium);
    const sl0 = Number(stopLossPrice);
    const oneR = Math.max(1, entry - sl0);
    const split = splitBankRunnerQty(quantity);
    const be = tickPrem(entry + Math.max(0.5, envNum('DHAN_BE_PAD', 0.5)));
    const tp3 = tickPrem(Math.max(Number(targetPrice) || 0, entry + oneR * envNum('DHAN_TP_R_MULT', 3)));
    const out = {
      ...split,
      oneR,
      be,
      tp3,
      bankOrder: null,
      runnerSlOrderId: null,
      runnerTpOrderId: null,
      superCancelled: false,
    };

    if (split.mode === 'be_only') {
      // Keep Super Order; only de-risk full size to BE and stretch target.
      try {
        await moveStopToBreakeven(orderId, entry, envNum('DHAN_BE_PAD', 0.5));
        out.beMoved = true;
      } catch (e) {
        out.beError = e.message;
      }
      try {
        await modifyTarget(orderId, tp3);
        out.targetMoved = true;
      } catch (e) {
        out.targetError = e.message;
      }
      return out;
    }

    // Partial: tear down Super Order legs so they don't exit full size, bank Leg A, protect runner.
    await cancelSuperAllLegs(orderId);
    out.superCancelled = true;

    try {
      out.bankOrder = await dhan.placeOrder({
        correlationId: `bank1r-${Date.now()}`.slice(0, 30),
        transactionType: 'SELL',
        exchangeSegment: OPT_SEG,
        productType,
        orderType: 'MARKET',
        validity: 'DAY',
        securityId: String(securityId),
        quantity: Number(split.bankQty),
        price: 0,
        triggerPrice: 0,
      });
    } catch (e) {
      out.bankError = e.message;
      // If bank failed, try to re-protect full qty at BE via fresh exits below using original qty.
    }

    const runnerQty = out.bankError ? quantity : split.runnerQty;
    out.runnerQty = runnerQty;
    try {
      // Prefer STOP_LOSS_MARKET — plain STOP_LOSS on option SELLs was getting REJECTED on Dhan.
      const slOrd = await dhan.placeOrder({
        correlationId: `runsl-${Date.now()}`.slice(0, 30),
        transactionType: 'SELL',
        exchangeSegment: OPT_SEG,
        productType,
        orderType: 'STOP_LOSS_MARKET',
        validity: 'DAY',
        securityId: String(securityId),
        quantity: Number(runnerQty),
        price: 0,
        triggerPrice: be,
      });
      out.runnerSlOrderId = slOrd?.orderId || slOrd?.data?.orderId || null;
    } catch (e) {
      out.runnerSlError = e.message;
      try {
        const slLimit = tickPrem(Math.max(0.05, be - 0.5));
        const sl2 = await dhan.placeOrder({
          correlationId: `runslb-${Date.now()}`.slice(0, 30),
          transactionType: 'SELL',
          exchangeSegment: OPT_SEG,
          productType,
          orderType: 'STOP_LOSS',
          validity: 'DAY',
          securityId: String(securityId),
          quantity: Number(runnerQty),
          price: slLimit,
          triggerPrice: be,
        });
        out.runnerSlOrderId = sl2?.orderId || sl2?.data?.orderId || null;
        out.runnerSlError = null;
      } catch (e2) {
        out.runnerSlError = `${e.message} | fallback: ${e2.message}`;
      }
    }
    try {
      const tpOrd = await dhan.placeOrder({
        correlationId: `runtp-${Date.now()}`.slice(0, 30),
        transactionType: 'SELL',
        exchangeSegment: OPT_SEG,
        productType,
        orderType: 'LIMIT',
        validity: 'DAY',
        securityId: String(securityId),
        quantity: Number(runnerQty),
        price: tp3,
        triggerPrice: 0,
      });
      out.runnerTpOrderId = tpOrd?.orderId || tpOrd?.data?.orderId || null;
    } catch (e) {
      out.runnerTpError = e.message;
    }
    return out;
  }

  /** After 1:2 on runner: trail SL up under open premium (never loosen). */
  async function trailRunnerStop({ orderId, runnerSlOrderId, stopLossPrice, mode }) {
    const px = tickPrem(stopLossPrice);
    if (mode === 'be_only' && orderId) {
      return modifyStop(orderId, px, 0);
    }
    if (runnerSlOrderId) {
      return dhan.modifyOrder(runnerSlOrderId, {
        orderType: 'STOP_LOSS',
        price: px,
        triggerPrice: px,
        validity: 'DAY',
      });
    }
    return null;
  }

  /**
   * Place Super Order: BUY option LIMIT at live premium + SL + TP.
   * MARKET + price:0 breaks Dhan validation ("Profit Price should be greater than Order price")
   * because the OMS rewrites entry via MPP and TP no longer sits above the effective order price.
   */
  async function openOptionSuperTrade({
    side, // index bias LONG|SHORT → CE|PE
    indexEntry,
    indexStop,
    indexTp1,
    correlationId,
  }) {
    const contract = await pickOptionContract({ side, spot: indexEntry });
    // Prefer ask for BUY so LIMIT is marketable; fall back to LTP.
    const premium = Number(contract.ask) > 0 ? Number(contract.ask) : Number(contract.ltp);
    if (!(premium > 0)) throw new Error(`No LTP/ask for ${contract.symbolHint}`);
    const levels = mapPremiumLevels({
      entryPremium: premium,
      indexEntry,
      indexStop,
      indexTp1,
      delta: contract.delta,
    });
    const trail = envNum('DHAN_TRAIL_JUMP', 0);

    const body = {
      correlationId: String(correlationId || `rb-${Date.now()}`).slice(0, 30),
      transactionType: 'BUY',
      exchangeSegment: OPT_SEG,
      productType,
      orderType: 'LIMIT',
      securityId: contract.securityId,
      quantity: qty,
      price: levels.entryPrice,
      targetPrice: levels.targetPrice,
      stopLossPrice: levels.stopLossPrice,
      trailingJump: trail,
    };

    if (!(body.targetPrice > body.price && body.stopLossPrice < body.price)) {
      throw new Error(
        `Invalid Super Order levels TP ${body.targetPrice} / px ${body.price} / SL ${body.stopLossPrice}`
      );
    }

    // BUY premium ≈ price * qty; reject early if wallet can't cover (Dhan RMS adds buffer).
    const notional = levels.entryPrice * qty;
    const bufferPct = Math.max(1.05, envNum('DHAN_FUND_BUFFER', 1.15));
    const need = Math.ceil(notional * bufferPct);
    try {
      const funds = await dhan.getFundLimits();
      const avail = Number(funds?.availabelBalance ?? funds?.availableBalance ?? funds?.withdrawableBalance ?? 0);
      if (avail > 0 && avail < need) {
        throw new Error(
          `Insufficient funds: need ~Rs ${need} for ${qty}×${levels.entryPrice} (have Rs ${avail.toFixed(0)}). Add ~Rs ${(need - avail).toFixed(0)} or lower DHAN_NIFTY_LOTS.`
        );
      }
    } catch (e) {
      if (/Insufficient funds/i.test(String(e.message))) throw e;
      // fund-limit read failed — still attempt place; status poll below catches RMS reject
      console.warn('[DhanNifty] fund check skipped:', e.message);
    }

    const placed = await dhan.placeSuperOrder(body);
    const orderId = placed?.orderId || null;

    // placeSuperOrder often ACKs PENDING then RMS rejects — poll before claiming success.
    let orderStatus = placed?.orderStatus || null;
    let omsError = '';
    if (orderId) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 400 + i * 200));
        try {
          const list = await dhan.getSuperOrders();
          const rows = Array.isArray(list) ? list : (list?.data || []);
          const row = rows.find((o) => String(o.orderId) === String(orderId));
          if (row) {
            orderStatus = row.orderStatus || orderStatus;
            omsError = row.omsErrorDescription || omsError;
            if (/REJECTED|CANCELLED|TRADED|CLOSED/i.test(String(orderStatus))) break;
          }
        } catch {
          break;
        }
      }
    }

    const rejected = /REJECTED/i.test(String(orderStatus || ''));
    if (rejected) {
      throw new Error(omsError || `Super Order ${orderId} REJECTED`);
    }

    return {
      ok: Boolean(orderId) && !rejected,
      orderId,
      orderStatus,
      omsError: omsError || null,
      contract: { ...contract, ltp: levels.entryPrice },
      levels,
      qty,
      lots,
      request: body,
      notional,
    };
  }

  /** Move Super Order STOP_LOSS_LEG to breakeven (entry premium). */
  async function moveStopToBreakeven(orderId, entryPremium, padPts = 0.5) {
    const be = Math.max(0.05, +(Number(entryPremium) + Number(padPts)).toFixed(2));
    return dhan.modifySuperOrder(orderId, {
      legName: 'STOP_LOSS_LEG',
      stopLossPrice: be,
      trailingJump: envNum('DHAN_TRAIL_JUMP', 0),
    });
  }

  async function modifyStop(orderId, stopLossPrice, trailingJump = 0) {
    return dhan.modifySuperOrder(orderId, {
      legName: 'STOP_LOSS_LEG',
      stopLossPrice: Number(stopLossPrice),
      trailingJump: Number(trailingJump) || 0,
    });
  }

  async function modifyTarget(orderId, targetPrice) {
    return dhan.modifySuperOrder(orderId, {
      legName: 'TARGET_LEG',
      targetPrice: Number(targetPrice),
    });
  }

  /** Flatten: cancel super + runner legs then market-sell any leftover option qty. */
  async function flattenTrade({ orderId, securityId, quantity, runnerSlOrderId, runnerTpOrderId }) {
    const out = { cancelled: null, exit: null };
    if (orderId) {
      await cancelSuperAllLegs(orderId);
      out.cancelled = true;
    }
    for (const oid of [runnerSlOrderId, runnerTpOrderId]) {
      if (!oid) continue;
      try {
        await dhan.cancelOrder(oid);
      } catch (_) { /* already filled / cancelled */ }
    }
    if (securityId && quantity > 0) {
      try {
        out.exit = await dhan.placeOrder({
          correlationId: `flat-${Date.now()}`.slice(0, 30),
          transactionType: 'SELL',
          exchangeSegment: OPT_SEG,
          productType,
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: String(securityId),
          quantity: Number(quantity),
          price: 0,
          triggerPrice: 0,
        });
      } catch (e) {
        out.exitError = e.message;
      }
    }
    return out;
  }

  /** True if any NIFTY / F&O option is open (entry gate — one auto position at a time). */
  async function hasOpenNiftyOptionPosition() {
    const pos = await dhan.getPositions();
    const rows = Array.isArray(pos) ? pos : (pos?.data || []);
    return rows.some((p) => {
      const net = Number(p.netQty ?? p.quantity ?? p.netQuantity ?? 0);
      const seg = String(p.exchangeSegment || p.segment || '');
      const sym = String(p.tradingSymbol || p.symbol || '');
      return net !== 0 && (/FNO|OPT/i.test(seg) || /NIFTY/i.test(sym));
    });
  }

  /** Net qty for one securityId (EOD / managed-trade checks — not “any F&O”). */
  async function getOpenQtyForSecurity(securityId) {
    const want = String(securityId || '');
    if (!want) return 0;
    const pos = await dhan.getPositions();
    const rows = Array.isArray(pos) ? pos : (pos?.data || []);
    let net = 0;
    for (const p of rows) {
      if (String(p.securityId || p.security_id || '') !== want) continue;
      net += Number(p.netQty ?? p.quantity ?? p.netQuantity ?? 0);
    }
    return net;
  }

  async function hasOpenPositionForSecurity(securityId) {
    return Math.abs(await getOpenQtyForSecurity(securityId)) > 0;
  }

  return {
    dhan,
    lotSize,
    lots,
    qty,
    nearestWeeklyExpiry,
    pickOptionContract,
    mapPremiumLevels,
    splitBankRunnerQty,
    openOptionSuperTrade,
    bankHalfAtOneR,
    trailRunnerStop,
    moveStopToBreakeven,
    modifyStop,
    modifyTarget,
    flattenTrade,
    hasOpenNiftyOptionPosition,
    getOpenQtyForSecurity,
    hasOpenPositionForSecurity,
  };
}

module.exports = {
  createDhanNiftyTrade,
  NIFTY_UNDERLYING,
  NIFTY_SEG,
};
