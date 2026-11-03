'use strict';

/**
 * Dhan NIFTY options auto-trader (live).
 * ENTER → pick weekly ATM CE/PE → Super Order (entry + SL + TP) → modify SL to BE after 1R.
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
    const ltp = Number(leg.last_price) || Number(leg.top_ask_price) || 0;
    const delta = Math.abs(Number(leg.greeks?.delta) || deltaGuess);
    return {
      expiry,
      strike: best,
      side,
      optSide: side === 'LONG' ? 'CE' : 'PE',
      securityId: String(leg.security_id),
      ltp,
      delta,
      symbolHint: `NIFTY ${best} ${side === 'LONG' ? 'CE' : 'PE'} ${expiry}`,
    };
  }

  /**
   * Map index risk/target → option premium SL/TP using delta (or env override pts).
   */
  function mapPremiumLevels({ entryPremium, indexEntry, indexStop, indexTp1, delta }) {
    const d = Math.max(0.25, Math.min(0.9, Number(delta) || deltaGuess));
    const indexRisk = Math.abs(Number(indexEntry) - Number(indexStop));
    const indexReward = Math.abs(Number(indexTp1) - Number(indexEntry));
    const fixedSl = envNum('DHAN_OPT_SL_PTS', 0);
    const fixedTp = envNum('DHAN_OPT_TP_PTS', 0);
    const slPts = fixedSl > 0 ? fixedSl : Math.max(8, Math.round(indexRisk * d));
    const tpPts = fixedTp > 0 ? fixedTp : Math.max(12, Math.round(indexReward * d));
    const ep = Number(entryPremium);
    const stopLossPrice = Math.max(0.05, +(ep - slPts).toFixed(2));
    const targetPrice = +(ep + tpPts).toFixed(2);
    return { stopLossPrice, targetPrice, slPts, tpPts, delta: d };
  }

  /**
   * Place Super Order: BUY option MARKET (price 0) + SL + TP.
   * trailingJump in pts (0 = no trail until we BE-modify).
   */
  async function openOptionSuperTrade({
    side, // index bias LONG|SHORT → CE|PE
    indexEntry,
    indexStop,
    indexTp1,
    correlationId,
  }) {
    const contract = await pickOptionContract({ side, spot: indexEntry });
    const premium = contract.ltp;
    if (!(premium > 0)) throw new Error(`No LTP for ${contract.symbolHint}`);
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
      orderType: 'MARKET',
      securityId: contract.securityId,
      quantity: qty,
      price: 0,
      targetPrice: levels.targetPrice,
      stopLossPrice: levels.stopLossPrice,
      trailingJump: trail,
    };

    const placed = await dhan.placeSuperOrder(body);
    return {
      ok: Boolean(placed?.orderId),
      orderId: placed?.orderId || null,
      orderStatus: placed?.orderStatus || null,
      contract,
      levels,
      qty,
      lots,
      request: body,
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

  /** Flatten: cancel super legs then market-sell any leftover option qty. */
  async function flattenTrade({ orderId, securityId, quantity }) {
    const out = { cancelled: null, exit: null };
    if (orderId) {
      try {
        out.cancelled = await dhan.cancelSuperOrderLeg(orderId, 'ENTRY_LEG');
      } catch (e) {
        out.cancelError = e.message;
      }
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

  return {
    dhan,
    lotSize,
    lots,
    qty,
    nearestWeeklyExpiry,
    pickOptionContract,
    mapPremiumLevels,
    openOptionSuperTrade,
    moveStopToBreakeven,
    modifyStop,
    modifyTarget,
    flattenTrade,
    hasOpenNiftyOptionPosition,
  };
}

module.exports = {
  createDhanNiftyTrade,
  NIFTY_UNDERLYING,
  NIFTY_SEG,
};
