'use strict';

/**
 * binance_futures_trade.js — USD-M perpetual helpers for Red Bar set-and-forget.
 * Opens one market position, then attaches:
 *   - STOP_MARKET (closePosition) at desk Stop
 *   - TAKE_PROFIT_MARKET reduce-only 50% at TP A (1:1)
 *   - TAKE_PROFIT_MARKET reduce-only 50% at TP B (1:3)
 * No staring required once orders rest on Binance.
 */
const crypto = require('crypto');

const DEFAULT_BASE = 'https://fapi.binance.com';

function env(key, fallback = '') {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function createBinanceFuturesTrade(opts = {}) {
  const apiKey = opts.apiKey || env('BINANCE_API_KEY');
  const apiSecret = opts.apiSecret || env('BINANCE_API_SECRET');
  const baseUrl = (opts.baseUrl || env('BINANCE_FAPI_BASE', DEFAULT_BASE)).replace(/\/$/, '');

  if (!apiKey || !apiSecret) {
    const err = new Error('BINANCE_API_KEY / BINANCE_API_SECRET not configured');
    err.code = 'NO_KEYS';
    throw err;
  }

  const _filterCache = new Map();
  let _timeOffset = 0;

  async function _syncTime() {
    try {
      const r = await fetch(`${baseUrl}/fapi/v1/time`, { cache: 'no-store' });
      const j = await r.json();
      if (j?.serverTime) _timeOffset = j.serverTime - Date.now();
    } catch (e) {
      console.warn('[FuturesTrade] time sync failed:', e.message);
    }
  }

  function _ts() {
    return Date.now() + _timeOffset;
  }

  function _sign(query) {
    return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  }

  async function _request(method, path, params = {}, { signed = false } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      q.set(k, String(v));
    }
    if (signed) {
      q.set('timestamp', String(_ts()));
      q.set('recvWindow', '10000');
      q.set('signature', _sign(q.toString()));
    }
    const url = `${baseUrl}${path}${q.toString() ? `?${q}` : ''}`;
    const headers = { Accept: 'application/json' };
    if (signed) headers['X-MBX-APIKEY'] = apiKey;

    const r = await fetch(url, { method, headers, cache: 'no-store' });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error(`Binance FAPI non-JSON (${r.status}): ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok || (typeof data.code === 'number' && data.code !== 0)) {
      const err = new Error(data.msg || `Binance FAPI HTTP ${r.status}`);
      err.status = r.status;
      err.binanceCode = data.code;
      err.binanceBody = data;
      throw err;
    }
    return data;
  }

  function _decimals(step) {
    const s = String(step);
    if (!s.includes('.')) return 0;
    return s.replace(/0+$/, '').split('.')[1]?.length || 0;
  }

  function roundStep(value, step, mode = 'down') {
    if (!(step > 0) || !Number.isFinite(value)) return value;
    const n = mode === 'up' ? Math.ceil(value / step) : Math.floor(value / step);
    return Number((n * step).toFixed(_decimals(step)));
  }

  function roundPrice(price, tickSize) {
    return roundStep(price, tickSize, 'down');
  }

  async function getExchangeFilters(symbol) {
    const sym = String(symbol).toUpperCase();
    if (_filterCache.has(sym)) return _filterCache.get(sym);
    const info = await _request('GET', '/fapi/v1/exchangeInfo', { symbol: sym });
    const row = (info.symbols || []).find((s) => s.symbol === sym);
    if (!row) throw new Error(`Unknown futures symbol ${sym}`);
    const filters = Object.fromEntries((row.filters || []).map((f) => [f.filterType, f]));
    const out = {
      symbol: sym,
      tickSize: parseFloat(filters.PRICE_FILTER?.tickSize || '0.1'),
      stepSize: parseFloat(filters.LOT_SIZE?.stepSize || '0.001'),
      minQty: parseFloat(filters.LOT_SIZE?.minQty || '0'),
      minNotional: parseFloat(filters.MIN_NOTIONAL?.notional || '5'),
    };
    _filterCache.set(sym, out);
    return out;
  }

  async function setMarginType(symbol, marginType = 'ISOLATED') {
    const sym = String(symbol).toUpperCase();
    try {
      await _syncTime();
      await _request('POST', '/fapi/v1/marginType', { symbol: sym, marginType }, { signed: true });
    } catch (e) {
      // -4046 already set
      if (e.binanceCode !== -4046) throw e;
    }
  }

  async function setLeverage(symbol, leverage) {
    const sym = String(symbol).toUpperCase();
    const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 2)));
    await _syncTime();
    return _request('POST', '/fapi/v1/leverage', { symbol: sym, leverage: lev }, { signed: true });
  }

  async function getPositionRisk(symbol) {
    await _syncTime();
    const rows = await _request('GET', '/fapi/v2/positionRisk', { symbol: String(symbol).toUpperCase() }, { signed: true });
    return Array.isArray(rows) ? rows : [];
  }

  async function getOpenOrders(symbol) {
    await _syncTime();
    const params = {};
    if (symbol) params.symbol = String(symbol).toUpperCase();
    return _request('GET', '/fapi/v1/openOrders', params, { signed: true });
  }

  async function getOrder(symbol, orderId) {
    await _syncTime();
    return _request('GET', '/fapi/v1/order', {
      symbol: String(symbol).toUpperCase(),
      orderId: String(orderId),
    }, { signed: true });
  }

  async function cancelOrder(symbol, orderId) {
    await _syncTime();
    return _request('DELETE', '/fapi/v1/order', {
      symbol: String(symbol).toUpperCase(),
      orderId: String(orderId),
    }, { signed: true });
  }

  /**
   * After 1:1 (TP A) fills: cancel the open STOP_MARKET and place a new one at entry (BE)
   * with closePosition so the runner is protected at breakeven until TP B or stop.
   */
  async function moveStopToBreakeven({
    symbol,
    side,
    entryPrice,
    stopOrderId,
  } = {}) {
    const sym = String(symbol || '').toUpperCase();
    const tradeSide = String(side || '').toUpperCase();
    const entry = Number(entryPrice);
    if (!sym || !(entry > 0)) throw new Error('symbol and entryPrice required');
    if (tradeSide !== 'LONG' && tradeSide !== 'SHORT') throw new Error('side must be LONG or SHORT');

    await _syncTime();
    const filters = await getExchangeFilters(sym);
    const closeSide = tradeSide === 'LONG' ? 'SELL' : 'BUY';
    const bePx = roundPrice(entry, filters.tickSize);

    if (stopOrderId) {
      try {
        await cancelOrder(sym, stopOrderId);
      } catch (e) {
        // -2011 unknown order / already filled — continue if we can still place BE stop
        if (e.binanceCode !== -2011) {
          console.warn('[FuturesTrade] cancel stop:', e.message);
        }
      }
    }

    const stopOrder = await _request('POST', '/fapi/v1/order', {
      symbol: sym,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: String(bePx),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      newOrderRespType: 'RESULT',
    }, { signed: true });

    return { ok: true, bePrice: bePx, stopOrder };
  }

  async function getMarkPrice(symbol) {
    const j = await _request('GET', '/fapi/v1/premiumIndex', { symbol: String(symbol).toUpperCase() });
    return parseFloat(j.markPrice);
  }

  /**
   * Open market + attach SL (full remainder) + TP A 50% + TP B 50%.
   * @param {{ symbol:string, side:'LONG'|'SHORT', marginUsdt:number, leverage:number,
   *           stopPrice:number, tpA:number, tpB:number, entryHint?:number }} p
   */
  async function openTwoLegDeskTrade(p = {}) {
    const symbol = String(p.symbol || 'BTCUSDT').toUpperCase();
    const side = String(p.side || '').toUpperCase();
    if (side !== 'LONG' && side !== 'SHORT') throw new Error('side must be LONG or SHORT');
    const marginUsdt = Number(p.marginUsdt);
    const leverage = Math.max(1, Math.min(20, Math.floor(Number(p.leverage) || 3)));
    const stopPrice = Number(p.stopPrice);
    const tpA = Number(p.tpA);
    const tpB = Number(p.tpB);
    if (!(marginUsdt > 0)) throw new Error('marginUsdt must be > 0');
    if (!(stopPrice > 0 && tpA > 0 && tpB > 0)) throw new Error('stopPrice, tpA, tpB required');

    await _syncTime();
    const filters = await getExchangeFilters(symbol);
    await setMarginType(symbol, 'ISOLATED');
    await setLeverage(symbol, leverage);

    const mark = Number.isFinite(Number(p.entryHint)) ? Number(p.entryHint) : await getMarkPrice(symbol);
    if (!(mark > 0)) throw new Error('Could not resolve mark price');

    // Sanity: LONG stop below, TPs above; SHORT opposite
    if (side === 'LONG') {
      if (!(stopPrice < mark && tpA > mark && tpB > mark)) {
        throw new Error(`LONG levels invalid vs mark ${mark}: stop ${stopPrice} tpA ${tpA} tpB ${tpB}`);
      }
    } else if (!(stopPrice > mark && tpA < mark && tpB < mark)) {
      throw new Error(`SHORT levels invalid vs mark ${mark}: stop ${stopPrice} tpA ${tpA} tpB ${tpB}`);
    }

    const notional = marginUsdt * leverage;
    let qty = roundStep(notional / mark, filters.stepSize, 'down');
    if (!(qty >= filters.minQty)) throw new Error(`Qty ${qty} below minQty ${filters.minQty}`);
    if (qty * mark < filters.minNotional) {
      throw new Error(`Notional ${qty * mark} below min ${filters.minNotional}`);
    }

    let qtyA = roundStep(qty * 0.5, filters.stepSize, 'down');
    let qtyB = roundStep(qty - qtyA, filters.stepSize, 'down');
    if (qtyA < filters.minQty || qtyB < filters.minQty) {
      // Too small to split — single TP at tpB
      qtyA = 0;
      qtyB = qty;
    }

    const openSide = side === 'LONG' ? 'BUY' : 'SELL';
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const stopPx = roundPrice(stopPrice, filters.tickSize);
    const tpAPx = roundPrice(tpA, filters.tickSize);
    const tpBPx = roundPrice(tpB, filters.tickSize);

    const result = {
      ok: true,
      symbol,
      side,
      mark,
      qty,
      qtyA,
      qtyB,
      leverage,
      marginUsdt,
      notional,
      stopPrice: stopPx,
      tpA: tpAPx,
      tpB: tpBPx,
      entry: null,
      stopOrder: null,
      tpAOrder: null,
      tpBOrder: null,
      warnings: [],
    };

    const entryOrder = await _request('POST', '/fapi/v1/order', {
      symbol,
      side: openSide,
      type: 'MARKET',
      quantity: String(qty),
      newOrderRespType: 'RESULT',
    }, { signed: true });
    result.entry = {
      orderId: entryOrder.orderId,
      avgPrice: parseFloat(entryOrder.avgPrice || mark),
      executedQty: parseFloat(entryOrder.executedQty || qty),
      status: entryOrder.status,
    };

    // SL on whatever remains (closePosition)
    try {
      result.stopOrder = await _request('POST', '/fapi/v1/order', {
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: String(stopPx),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        newOrderRespType: 'RESULT',
      }, { signed: true });
    } catch (e) {
      result.ok = false;
      result.warnings.push(`Stop failed: ${e.message}`);
    }

    if (qtyA >= filters.minQty) {
      try {
        result.tpAOrder = await _request('POST', '/fapi/v1/order', {
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(tpAPx),
          quantity: String(qtyA),
          reduceOnly: 'true',
          workingType: 'MARK_PRICE',
          newOrderRespType: 'RESULT',
        }, { signed: true });
      } catch (e) {
        result.ok = false;
        result.warnings.push(`TP A failed: ${e.message}`);
      }
    }

    if (qtyB >= filters.minQty) {
      try {
        result.tpBOrder = await _request('POST', '/fapi/v1/order', {
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(tpBPx),
          quantity: String(qtyB),
          reduceOnly: 'true',
          workingType: 'MARK_PRICE',
          newOrderRespType: 'RESULT',
        }, { signed: true });
      } catch (e) {
        result.ok = false;
        result.warnings.push(`TP B failed: ${e.message}`);
      }
    }

    if (result.warnings.length && !result.stopOrder) {
      result.error = 'Opened but protective stop missing — set SL on Binance now';
    } else if (result.warnings.length) {
      result.error = result.warnings.join('; ');
    }

    return result;
  }

  return {
    openTwoLegDeskTrade,
    moveStopToBreakeven,
    getOrder,
    cancelOrder,
    getPositionRisk,
    getOpenOrders,
    getMarkPrice,
    setLeverage,
    setMarginType,
    getExchangeFilters,
    roundStep,
    roundPrice,
  };
}

function isFuturesTradeConfigured() {
  return Boolean(
    env('BINANCE_API_KEY')
    && env('BINANCE_API_SECRET')
    && env('TRADE_ENABLED', '').toLowerCase() === 'true'
  );
}

module.exports = {
  createBinanceFuturesTrade,
  isFuturesTradeConfigured,
  env,
};
