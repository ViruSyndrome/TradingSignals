'use strict';

/**
 * binance_trade.js — Owner-only signed Binance Spot helpers (Node).
 * Used by bot.js for click-to-trade: market buy + 50/50 bank TP + trailing runner.
 */
const crypto = require('crypto');

const DEFAULT_BASE = 'https://api.binance.com';

function env(key, fallback = '') {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function createBinanceTrade(opts = {}) {
  const apiKey = opts.apiKey || env('BINANCE_API_KEY');
  const apiSecret = opts.apiSecret || env('BINANCE_API_SECRET');
  const baseUrl = (opts.baseUrl || env('BINANCE_API_BASE', DEFAULT_BASE)).replace(/\/$/, '');

  if (!apiKey || !apiSecret) {
    const err = new Error('BINANCE_API_KEY / BINANCE_API_SECRET not configured');
    err.code = 'NO_KEYS';
    throw err;
  }

  const _filterCache = new Map();
  let _timeOffset = 0;

  async function _syncTime() {
    try {
      const r = await fetch(`${baseUrl}/api/v3/time`, { cache: 'no-store' });
      const j = await r.json();
      if (j?.serverTime) _timeOffset = j.serverTime - Date.now();
    } catch (e) {
      console.warn('[BinanceTrade] time sync failed:', e.message);
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
    try { data = text ? JSON.parse(text) : {}; } catch {
      const err = new Error(`Binance non-JSON (${r.status}): ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok || (typeof data.code === 'number' && data.code !== 0)) {
      const err = new Error(data.msg || `Binance HTTP ${r.status}`);
      err.status = r.status;
      err.binanceCode = data.code;
      err.binanceBody = data;
      throw err;
    }
    return data;
  }

  async function getExchangeFilters(symbol) {
    const sym = String(symbol).toUpperCase();
    if (_filterCache.has(sym)) return _filterCache.get(sym);
    const info = await _request('GET', '/api/v3/exchangeInfo', { symbol: sym });
    const row = (info.symbols || []).find(s => s.symbol === sym);
    if (!row) throw new Error(`Unknown symbol ${sym}`);
    const filters = Object.fromEntries((row.filters || []).map(f => [f.filterType, f]));
    const out = {
      symbol: sym,
      baseAsset: row.baseAsset,
      quoteAsset: row.quoteAsset,
      tickSize: parseFloat(filters.PRICE_FILTER?.tickSize || '0.01'),
      stepSize: parseFloat(filters.LOT_SIZE?.stepSize || '0.001'),
      minQty: parseFloat(filters.LOT_SIZE?.minQty || '0'),
      minNotional: parseFloat(
        filters.NOTIONAL?.minNotional || filters.MIN_NOTIONAL?.minNotional || '5'
      ),
    };
    _filterCache.set(sym, out);
    return out;
  }

  function _decimals(step) {
    const s = String(step);
    if (!s.includes('.')) return 0;
    return s.replace(/0+$/, '').split('.')[1]?.length || 0;
  }

  function roundStep(value, step, mode = 'down') {
    if (!(step > 0) || !Number.isFinite(value)) return value;
    const n = mode === 'up' ? Math.ceil(value / step) : Math.floor(value / step);
    const rounded = n * step;
    const d = _decimals(step);
    return Number(rounded.toFixed(d));
  }

  function roundPrice(price, tickSize) {
    return roundStep(price, tickSize, 'down');
  }

  async function marketBuyQuote({ symbol, quoteOrderQty }) {
    const sym = String(symbol).toUpperCase();
    const quote = Number(quoteOrderQty);
    if (!(quote > 0)) throw new Error('quoteOrderQty must be > 0');
    await _syncTime();
    const order = await _request('POST', '/api/v3/order', {
      symbol: sym,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: Number(quote.toFixed(8)),
      newOrderRespType: 'FULL',
    }, { signed: true });

    const executedQty = parseFloat(order.executedQty || '0');
    const cumQuote = parseFloat(order.cummulativeQuoteQty || '0');
    const avgPrice = executedQty > 0 ? cumQuote / executedQty : parseFloat(order.fills?.[0]?.price || '0');
    return {
      order,
      orderId: order.orderId,
      symbol: sym,
      executedQty,
      cumQuote,
      avgPrice,
      fills: order.fills || [],
    };
  }

  async function limitSell({ symbol, quantity, price }) {
    const sym = String(symbol).toUpperCase();
    await _syncTime();
    const filters = await getExchangeFilters(sym);
    const qty = roundStep(quantity, filters.stepSize, 'down');
    const px = roundPrice(price, filters.tickSize);
    if (!(qty >= filters.minQty)) throw new Error(`Sell qty ${qty} below minQty ${filters.minQty}`);
    if (qty * px < filters.minNotional) {
      throw new Error(`Sell notional ${qty * px} below minNotional ${filters.minNotional}`);
    }
    const order = await _request('POST', '/api/v3/order', {
      symbol: sym,
      side: 'SELL',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(qty),
      price: String(px),
      newOrderRespType: 'FULL',
    }, { signed: true });
    return { order, orderId: order.orderId, quantity: qty, price: px };
  }

  async function trailingStopSell({ symbol, quantity, callbackRate }) {
    const sym = String(symbol).toUpperCase();
    const rate = Number(callbackRate);
    if (!(rate >= 0.1 && rate <= 10)) {
      throw new Error('callbackRate must be between 0.1 and 10');
    }
    await _syncTime();
    const filters = await getExchangeFilters(sym);
    const qty = roundStep(quantity, filters.stepSize, 'down');
    if (!(qty >= filters.minQty)) throw new Error(`Trail qty ${qty} below minQty ${filters.minQty}`);
    const order = await _request('POST', '/api/v3/order', {
      symbol: sym,
      side: 'SELL',
      type: 'TRAILING_STOP_MARKET',
      quantity: String(qty),
      callbackRate: String(Number(rate.toFixed(1))),
      newOrderRespType: 'FULL',
    }, { signed: true });
    return { order, orderId: order.orderId, quantity: qty, callbackRate: rate };
  }

  /**
   * Market buy then place 50/50 exits: LIMIT TP on bank leg + trailing stop on runner.
   */
  async function buyWithFiftyFiftyExits({
    symbol,
    quoteUsdt,
    takeProfitPct = 10,
    partialPct = 50,
    callbackRate = 2,
  } = {}) {
    const sym = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym.endsWith('USDT')) {
      // allow NEAR → NEARUSDT
      if (!/USDT$/.test(sym)) {
        // handled below
      }
    }
    const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;
    const quote = Number(quoteUsdt);
    if (!(quote > 0)) throw new Error('quoteUsdt must be > 0');

    const filters = await getExchangeFilters(pair);
    if (filters.quoteAsset !== 'USDT') throw new Error('Only USDT quote pairs supported');

    const buy = await marketBuyQuote({ symbol: pair, quoteOrderQty: quote });
    let qty = roundStep(buy.executedQty, filters.stepSize, 'down');
    if (!(qty >= filters.minQty)) {
      return {
        ok: false,
        stage: 'buy',
        error: `Fill qty ${buy.executedQty} too small after rounding`,
        buy,
      };
    }

    const bankFrac = Math.min(Math.max(Number(partialPct) || 50, 1), 99) / 100;
    let bankQty = roundStep(qty * bankFrac, filters.stepSize, 'down');
    let runnerQty = roundStep(qty - bankQty, filters.stepSize, 'down');

    // If one leg is dust, fold into the other
    if (bankQty < filters.minQty && runnerQty >= filters.minQty) {
      runnerQty = roundStep(qty, filters.stepSize, 'down');
      bankQty = 0;
    } else if (runnerQty < filters.minQty && bankQty >= filters.minQty) {
      bankQty = roundStep(qty, filters.stepSize, 'down');
      runnerQty = 0;
    }

    const tpPrice = roundPrice(
      buy.avgPrice * (1 + (Number(takeProfitPct) || 10) / 100),
      filters.tickSize
    );

    const result = {
      ok: true,
      symbol: pair,
      buy,
      bank: null,
      trail: null,
      warnings: [],
      takeProfitPct: Number(takeProfitPct) || 10,
      partialPct: Number(partialPct) || 50,
      callbackRate: Number(callbackRate) || 2,
      bankQty,
      runnerQty,
      tpPrice,
    };

    if (bankQty >= filters.minQty) {
      try {
        result.bank = await limitSell({ symbol: pair, quantity: bankQty, price: tpPrice });
      } catch (e) {
        result.ok = false;
        result.warnings.push(`Bank TP failed: ${e.message}`);
        result.bankError = e.message;
      }
    } else {
      result.warnings.push('Bank leg skipped (qty below min)');
    }

    if (runnerQty >= filters.minQty) {
      try {
        result.trail = await trailingStopSell({
          symbol: pair,
          quantity: runnerQty,
          callbackRate: Number(callbackRate) || 2,
        });
      } catch (e) {
        result.ok = false;
        result.warnings.push(`Trailing stop failed: ${e.message}`);
        result.trailError = e.message;
      }
    } else {
      result.warnings.push('Runner leg skipped (qty below min)');
    }

    if (!result.bank && !result.trail && buy.executedQty > 0) {
      result.ok = false;
      result.stage = 'exits';
      result.error = 'Bought but both exit legs failed — set stops manually on Binance';
    } else if (result.warnings.length && (result.bankError || result.trailError)) {
      result.stage = 'exits_partial';
      result.error = result.warnings.join('; ');
    }

    return result;
  }

  async function getAccount() {
    await _syncTime();
    return _request('GET', '/api/v3/account', {}, { signed: true });
  }

  async function getBalances({ minUsdt = 1 } = {}) {
    const acct = await getAccount();
    const rows = (acct.balances || [])
      .map(b => ({
        asset: b.asset,
        free: parseFloat(b.free) || 0,
        locked: parseFloat(b.locked) || 0,
      }))
      .filter(b => b.free + b.locked > 0);
    return { balances: rows, canTrade: acct.canTrade, updateTime: acct.updateTime, minUsdt };
  }

  async function getMyTrades(symbol, limit = 50) {
    await _syncTime();
    const sym = String(symbol).toUpperCase();
    return _request('GET', '/api/v3/myTrades', { symbol: sym, limit }, { signed: true });
  }

  async function getOpenOrders(symbol) {
    await _syncTime();
    const params = {};
    if (symbol) params.symbol = String(symbol).toUpperCase();
    return _request('GET', '/api/v3/openOrders', params, { signed: true });
  }

  return {
    marketBuyQuote,
    limitSell,
    trailingStopSell,
    buyWithFiftyFiftyExits,
    getAccount,
    getBalances,
    getMyTrades,
    getOpenOrders,
    getExchangeFilters,
    roundStep,
    roundPrice,
  };
}

function isTradeConfigured() {
  return Boolean(env('BINANCE_API_KEY') && env('BINANCE_API_SECRET') && env('TRADE_ENABLED', '').toLowerCase() === 'true');
}

module.exports = { createBinanceTrade, isTradeConfigured, env };
