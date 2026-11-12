'use strict';

/**
 * Dhan options auto-trader (live) — NIFTY + CRUDEOIL + NG (1-lot MCX test).
 * BANKNIFTY / SENSEX share the same Super Order ladder but stay desk-only until verified.
 * Ladder: Super Order (structural SL + per-instrument tpMult) → at 1:1 bank ~50% (2+ lots)
 * → runner SL to BE. Single lot = BE-only move (no exchange split).
 * Specs: NIFTY ~3R · Crude 2.4R (36 pt) · NG 2.5R.
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

const DHAN_INSTRUMENT_SPECS = {
  NIFTY: {
    id: 'NIFTY',
    underlyingScrip: 13,
    underlyingSeg: 'IDX_I',
    optSeg: 'NSE_FNO',
    lotSize: 65,
    strikeStep: 50,
    tickSize: 0.05,
    minSlPts: 14,
    tpMult: 3.0,
  },
  BANKNIFTY: {
    id: 'BANKNIFTY',
    underlyingScrip: 25,
    underlyingSeg: 'IDX_I',
    optSeg: 'NSE_FNO',
    lotSize: 30,
    strikeStep: 100,
    tickSize: 0.05,
    minSlPts: 30,
    tpMult: 3.0,
  },
  SENSEX: {
    id: 'SENSEX',
    underlyingScrip: 51,
    underlyingSeg: 'IDX_I',
    optSeg: 'BSE_FNO',
    lotSize: 20,
    strikeStep: 100,
    tickSize: 0.05,
    minSlPts: 35,
    tpMult: 3.0,
  },
  CRUDEOIL: {
    id: 'CRUDEOIL',
    underlyingScrip: envNum('DHAN_CRUDEOIL_SCRIP', 573422),
    underlyingExpiry: '2026-11-17',
    underlyingSeg: 'MCX_COMM',
    optSeg: 'MCX_COMM',
    lotSize: 1,
    contractMultiplier: 100,
    strikeStep: 50,
    tickSize: 0.10,
    minSlPts: 15,
    tpMult: 2.4, // Dr. Dev Dhan option modal verified: 15 pt SL * 2.4 = 36 pt TP
  },
  NG: {
    id: 'NG',
    underlyingScrip: envNum('DHAN_NG_SCRIP', 574319),
    underlyingExpiry: '2026-11-20',
    underlyingSeg: 'MCX_COMM',
    optSeg: 'MCX_COMM',
    lotSize: 1,
    contractMultiplier: 1250,
    strikeStep: 5,
    tickSize: 0.05,
    minSlPts: 2.5,
    tpMult: 2.5, // 2.5 pt SL * 2.5 = 6.25 pt TP
  },
};

function checkContractFreshness(spec) {
  if (!spec || !spec.underlyingExpiry) return { ok: true };
  const expiryTs = new Date(`${spec.underlyingExpiry}T23:59:59+05:30`).getTime();
  const now = Date.now();
  const daysRemaining = (expiryTs - now) / (24 * 3600 * 1000);
  if (daysRemaining < 0) {
    const msg = `Underlying contract ${spec.id} (${spec.underlyingScrip}) EXPIRED on ${spec.underlyingExpiry}. Update securityId/contractExpiry in config/env.`;
    console.error(`[DhanTrade] 🛑 ${msg}`);
    return { ok: false, expired: true, message: msg };
  }
  if (daysRemaining <= 3) {
    console.warn(`[DhanTrade] ⚠️ ROLLOVER WARNING: ${spec.id} contract (${spec.underlyingScrip}) expires in ${Math.ceil(daysRemaining)} day(s) on ${spec.underlyingExpiry}. Plan rollover.`);
  }
  return { ok: true, expired: false, daysRemaining };
}

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
  const instKey = String(opts.instrumentId || 'NIFTY').toUpperCase();
  const spec = { ...(DHAN_INSTRUMENT_SPECS[instKey] || DHAN_INSTRUMENT_SPECS.NIFTY), ...(opts.spec || {}) };
  const underlyingScrip = Number(opts.underlyingScrip || spec.underlyingScrip || NIFTY_UNDERLYING);
  const underlyingSeg = String(opts.underlyingSeg || spec.underlyingSeg || NIFTY_SEG);
  const optSeg = String(opts.optSeg || spec.optSeg || OPT_SEG);
  const strikeStep = Number(opts.strikeStep || spec.strikeStep || 50);
  const tickSize = Number(opts.tickSize || spec.tickSize || 0.05);
  const minSlPts = Number(opts.minSlPts || spec.minSlPts || 14);
  const lotSize = instKey === 'NIFTY'
    ? envNum('NIFTY_LOT_SIZE', spec.lotSize)
    : envNum(`${instKey}_LOT_SIZE`, spec.lotSize);
  const lots = Math.max(1, Math.min(5, envNum(`DHAN_${instKey}_LOTS`, envNum('DHAN_NIFTY_LOTS', 1))));
  const qty = lotSize * lots;
  const deltaGuess = envNum('NIFTY_OPT_DELTA', 0.55);
  const productType = process.env.DHAN_PRODUCT_TYPE || 'INTRADAY';
  const freshness = checkContractFreshness(spec);

  async function nearestWeeklyExpiry() {
    const res = await dhan.getOptionExpiryList({
      underlyingScrip,
      underlyingSeg,
    });
    const dates = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    if (!dates.length) throw new Error(`No ${instKey} option expiries from Dhan`);
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
      underlyingScrip,
      underlyingSeg,
      expiry,
    });
    const data = chain?.data || chain;
    const spotPx = Number(spot) || Number(data?.last_price);
    if (!(spotPx > 0)) throw new Error('pickOptionContract: no spot');
    const oc = data?.oc || {};
    const strikes = Object.keys(oc).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!strikes.length) throw new Error('Empty option chain');

    const mode = String(process.env.DHAN_STRIKE_MODE || 'atm').toLowerCase();
    // Never pick an OTM strike when buying options:
    // LONG (CE) → at or below spot (slight ITM / ATM); SHORT (PE) → at or above spot (slight ITM / ATM)
    let want = side === 'LONG'
      ? Math.floor(Number(spotPx) / strikeStep) * strikeStep
      : Math.ceil(Number(spotPx) / strikeStep) * strikeStep;
    if (mode === 'itm') {
      // Deeper 1-step ITM override if explicitly requested
      want = side === 'LONG' ? want - strikeStep : want + strikeStep;
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
      symbolHint: `${instKey} ${best} ${side === 'LONG' ? 'CE' : 'PE'} ${expiry}`,
    };
  }

  /**
   * Map index risk/target → option premium SL/TP using delta (or env override pts).
   * Levels are always relative to the Super Order entry `price` (LIMIT), so Dhan's
   * rule targetPrice > price > stopLossPrice holds for BUY options.
   */
  function tickPrem(n) {
    return +(Math.round(Number(n) / tickSize) * tickSize).toFixed(2);
  }

  function mapPremiumLevels({ entryPremium, indexEntry, indexStop, indexTp1, delta }) {
    const d = Math.max(0.25, Math.min(0.9, Number(delta) || deltaGuess));
    const indexRisk = Math.abs(Number(indexEntry) - Number(indexStop));
    const indexReward = Math.abs(Number(indexTp1) - Number(indexEntry));
    const fixedSl = envNum('DHAN_OPT_SL_PTS', 0);
    const fixedTp = envNum('DHAN_OPT_TP_PTS', 0);
    // Dr Dev: structural SL (minimum minSlPts option pts); runner target (spec.tpMult or DHAN_TP_R_MULT).
    const defaultTpMult = spec.tpMult != null ? spec.tpMult : 3;
    const tpMult = Math.max(1, envNum('DHAN_TP_R_MULT', defaultTpMult));
    const slPts = fixedSl > 0 ? fixedSl : Math.max(minSlPts, Math.round(indexRisk * d));
    const oneRFromIndex = fixedTp > 0 ? fixedTp : Math.max(minSlPts, Math.round(indexReward * d));
    // Prefer premium 1R from SL width; fall back to mapped index 1R.
    const ep = Number(entryPremium);
    const price = tickPrem(ep);
    let stopLossPrice = tickPrem(Math.max(tickSize, price - slPts));
    if (!(stopLossPrice < price)) stopLossPrice = tickPrem(Math.max(tickSize, price - Math.max(slPts, 5)));
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
   * Dr Dev 1:1: bank ~50% (if 2+ lots), move runner SL → BE, keep/raise TP toward spec.tpMult.
   * Single lot: cannot exchange-split — SL → BE only, stretch TP via tpMult (NIFTY ~3 · Crude 2.4 · NG 2.5).
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
    const defaultTpMult = spec.tpMult != null ? spec.tpMult : 3;
    const tpMult = Math.max(1, envNum('DHAN_TP_R_MULT', defaultTpMult));
    const tp3 = tickPrem(Math.max(Number(targetPrice) || 0, entry + oneR * tpMult));
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

    /**
     * Partial bank — KEEP Super Order legs (OCO).
     * Dhan RMS: a pending LIMIT TP covering the position makes any extra SELL STOP look like a
     * fresh short → "insufficient funds ~1.5L". Never cancel Super SL/TP and replace with two
     * independent exits. Bank with a market SELL of half; move Super STOP → BE / TARGET → 3R.
     */
    try {
      out.bankOrder = await dhan.placeOrder({
        correlationId: `bank1r-${Date.now()}`.slice(0, 30),
        transactionType: 'SELL',
        exchangeSegment: optSeg,
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
    }

    const runnerQty = out.bankError ? quantity : split.runnerQty;
    out.runnerQty = runnerQty;
    out.superCancelled = false;

    try {
      await moveStopToBreakeven(orderId, entry, envNum('DHAN_BE_PAD', 0.5));
      out.beMoved = true;
      out.runnerSlOrderId = orderId; // still protected by Super STOP_LOSS_LEG
    } catch (e) {
      out.runnerSlError = e.message;
    }
    try {
      await modifyTarget(orderId, tp3);
      out.targetMoved = true;
      out.runnerTpOrderId = orderId; // Super TARGET_LEG
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
    directOptionLevels,
    contractOverride,
  }) {
    if (!freshness.ok) throw new Error(freshness.message);
    const contract = contractOverride || await pickOptionContract({ side, spot: indexEntry });
    // Prefer ask for BUY so LIMIT is marketable; fall back to LTP.
    const rawPremium = Number(contract.ask) > 0 ? Number(contract.ask) : Number(contract.ltp);
    if (!(rawPremium > 0)) throw new Error(`No LTP/ask for ${contract.symbolHint}`);
    // Marketable limit pad prevents partial fills during fast momentum moves (e.g. Nov 11 14:45)
    const defaultLimitPad = instKey === 'NIFTY' ? 1.0 : (instKey === 'CRUDEOIL' ? 2.0 : 0.5);
    const limitPad = Math.max(0, envNum('DHAN_ENTRY_LIMIT_PAD', defaultLimitPad));
    const premium = tickPrem(rawPremium + limitPad);
    const levels = directOptionLevels ? {
      entryPrice: tickPrem(directOptionLevels.entryPrice || premium),
      stopLossPrice: tickPrem(directOptionLevels.stopLossPrice),
      targetPrice: tickPrem(directOptionLevels.tpTarget || directOptionLevels.targetPrice),
      slPts: tickPrem(directOptionLevels.riskPts || (premium - directOptionLevels.stopLossPrice)),
      tpPts: tickPrem((directOptionLevels.tpTarget || directOptionLevels.targetPrice) - premium),
      oneRPts: tickPrem(directOptionLevels.tp1Banker ? (directOptionLevels.tp1Banker - premium) : (directOptionLevels.riskPts || 8)),
      tpMult: directOptionLevels.rrRatio || 2.2,
      delta: 1.0,
      isDirectOptionLevel: true,
    } : mapPremiumLevels({
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
      exchangeSegment: optSeg,
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

    // BUY premium ≈ price * qty * contractMultiplier; reject early if wallet can't cover (Dhan RMS adds buffer).
    const contractMultiplier = Number(spec.contractMultiplier) || 1;
    const notional = levels.entryPrice * qty * contractMultiplier;
    const bufferPct = Math.max(1.05, envNum('DHAN_FUND_BUFFER', 1.15));
    const need = Math.ceil(notional * bufferPct);
    try {
      const funds = await dhan.getFundLimits();
      const avail = Number(funds?.availabelBalance ?? funds?.availableBalance ?? funds?.withdrawableBalance ?? 0);
      if (avail > 0 && avail < need) {
        // If 2 lots requested but funds only cover 1 lot, scale down to 1 lot instead of throwing error!
        const oneLotQty = Number(spec.lotSize) || 65;
        const oneLotNeed = Math.ceil(levels.entryPrice * oneLotQty * contractMultiplier * bufferPct);
        if (qty > oneLotQty && avail >= oneLotNeed) {
          console.warn(`[DhanNifty] Wallet (Rs ${avail.toFixed(0)}) cannot cover ${qty} units (needs Rs ${need}) — auto-downscaling to 1 lot (${oneLotQty} units) to avoid missing trade!`);
          qty = oneLotQty;
          body.quantity = qty;
        } else {
          throw new Error(
            `Insufficient funds: need ~Rs ${need} for ${qty}×${levels.entryPrice} (have Rs ${avail.toFixed(0)}). Add ~Rs ${(need - avail).toFixed(0)} or lower DHAN_${instKey}_LOTS / pick cheaper strike.`
          );
        }
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
    const be = Math.max(tickSize, +(Number(entryPremium) + Number(padPts)).toFixed(2));
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
          exchangeSegment: optSeg,
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

  /** True if an option position for THIS specific instrument is currently open. */
  async function hasOpenNiftyOptionPosition() {
    const pos = await dhan.getPositions();
    const rows = Array.isArray(pos) ? pos : (pos?.data || []);
    const pat = instKey === 'NIFTY' ? /^NIFTY/i
      : instKey === 'BANKNIFTY' ? /^BANKNIFTY/i
      : instKey === 'SENSEX' ? /^SENSEX/i
      : instKey === 'CRUDEOIL' ? /^CRUDEOIL/i
      : instKey === 'NG' ? /^NATURALGAS|^NG/i
      : new RegExp(instKey, 'i');
    return rows.some((p) => {
      const net = Number(p.netQty ?? p.quantity ?? p.netQuantity ?? 0);
      const sym = String(p.tradingSymbol || p.symbol || '');
      return net !== 0 && pat.test(sym);
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

  async function fetchOptionIntradayBars(securityId, interval = '1') {
    const today = new Date();
    const ist = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayStr = `${ist.getFullYear()}-${pad2(ist.getMonth() + 1)}-${pad2(ist.getDate())}`;
    const payload = await dhan.getIntradayOhlc({
      securityId: String(securityId),
      exchangeSegment: optSeg,
      instrument: 'OPTIDX',
      interval: String(interval),
      fromDate: `${todayStr} 09:15:00`,
      toDate: `${todayStr} 15:30:00`,
    });
    const { parseDhanOhlc } = require('./nifty_option_engine');
    return parseDhanOhlc(payload?.data || payload);
  }

  return {
    dhan,
    spec,
    instKey,
    underlyingScrip,
    underlyingSeg,
    optSeg,
    lotSize,
    lots,
    qty,
    nearestWeeklyExpiry,
    pickOptionContract,
    fetchOptionIntradayBars,
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
  DHAN_INSTRUMENT_SPECS,
  NIFTY_UNDERLYING,
  NIFTY_SEG,
};
