'use strict';

/**
 * Minimal DhanHQ v2 client for TrendRunner (Nifty / BankNifty / Sensex / MCX path).
 * Auth: access-token header + dhanClientId where required.
 * Docs: https://dhanhq.co/docs/v2/
 */
const DEFAULT_BASE = 'https://api.dhan.co/v2';

// Shared in-memory cache + rate-limit queue for /charts/intraday across all client instances
const _klineCache = new Map();
const KLINE_CACHE_TTL_MS = 12 * 1000;
let _lastChartCallTs = 0;
let _chartQueue = Promise.resolve();

function _throttleChartCall(fn) {
  const run = async () => {
    const now = Date.now();
    const wait = Math.max(0, _lastChartCallTs + 260 - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastChartCallTs = Date.now();
    return fn();
  };
  const next = _chartQueue.then(run, run);
  _chartQueue = next.catch(() => {});
  return next;
}

function env(key, fallback = '') {
  const v = process.env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function createDhanClient(opts = {}) {
  const clientId = opts.clientId || env('DHAN_CLIENT_ID');
  const accessToken = opts.accessToken || env('DHAN_ACCESS_TOKEN');
  const baseUrl = (opts.baseUrl || env('DHAN_API_BASE', DEFAULT_BASE)).replace(/\/$/, '');

  if (!clientId || !accessToken) {
    const err = new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not configured');
    err.code = 'NO_DHAN_KEYS';
    throw err;
  }

  async function _request(method, path, { body, query, extraHeaders } = {}) {
    const q = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        q.set(k, String(v));
      }
    }
    const qs = q.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const headers = {
      Accept: 'application/json',
      'access-token': accessToken,
      'Content-Type': 'application/json',
      'client-id': String(clientId),
      ...(extraHeaders || {}),
    };
    const init = { method, headers, cache: 'no-store' };
    if (body != null) init.body = JSON.stringify(body);

    const r = await fetch(url, init);
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error(`Dhan non-JSON (${r.status}): ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok) {
      const msg = data.message || data.errorMessage || data.error || `Dhan HTTP ${r.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = r.status;
      err.dhan = data;
      throw err;
    }
    return data;
  }

  /** Smoke test — validates token + returns dataPlan status. */
  async function getProfile() {
    return _request('GET', '/profile');
  }

  async function getFundLimits() {
    return _request('GET', '/fundlimit');
  }

  async function getPositions() {
    return _request('GET', '/positions');
  }

  /**
   * Intraday OHLC (needs Data APIs subscription).
   * interval: "1"|"5"|"15"|"25"|"60" (minutes)
   * exchangeSegment e.g. IDX_I for index, NSE_FNO for futures, MCX_COMM for commodities
   */
  async function getIntradayOhlc({
    securityId,
    exchangeSegment = 'IDX_I',
    instrument = 'INDEX',
    interval = '5',
    fromDate,
    toDate,
  } = {}) {
    return _throttleChartCall(() => _request('POST', '/charts/intraday', {
      body: {
        securityId: String(securityId),
        exchangeSegment,
        instrument,
        interval: String(interval),
        oi: false,
        fromDate,
        toDate,
      },
    }));
  }

  /** Map Dhan TF label → supported API interval (no native 30m). */
  function mapInterval(tf) {
    const t = String(tf || '5m');
    if (t === '1m' || t === '1') return { api: '1', resampleMs: null };
    if (t === '5m' || t === '5') return { api: '5', resampleMs: null };
    if (t === '15m' || t === '15') return { api: '15', resampleMs: null };
    if (t === '30m' || t === '30') return { api: '15', resampleMs: 30 * 60000 };
    if (t === '1h' || t === '60m' || t === '60') return { api: '60', resampleMs: null };
    return { api: '5', resampleMs: null };
  }

  function _toRows(payload) {
    const opens = payload?.open || [];
    const highs = payload?.high || [];
    const lows = payload?.low || [];
    const closes = payload?.close || [];
    const vols = payload?.volume || [];
    const ts = payload?.timestamp || [];
    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      const tSec = Number(ts[i]);
      const o = Number(opens[i]);
      const h = Number(highs[i]);
      const l = Number(lows[i]);
      const c = Number(closes[i]);
      if (![tSec, o, h, l, c].every(Number.isFinite)) continue;
      // Dhan epoch is seconds
      rows.push([tSec * 1000, o, h, l, c, Number(vols[i]) || 0]);
    }
    return rows;
  }

  function _resample(rows, barMs) {
    if (!barMs || !rows.length) return rows;
    const buckets = new Map();
    for (const r of rows) {
      const key = Math.floor(r[0] / barMs) * barMs;
      const cur = buckets.get(key);
      if (!cur) buckets.set(key, [key, r[1], r[2], r[3], r[4], r[5]]);
      else {
        cur[2] = Math.max(cur[2], r[2]);
        cur[3] = Math.min(cur[3], r[3]);
        cur[4] = r[4];
        cur[5] += r[5] || 0;
      }
    }
    return [...buckets.values()].sort((a, b) => a[0] - b[0]);
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtIstish = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;

  /**
   * Fetch desk-shaped klines [t,o,h,l,c,v] for an instrument config.
   * Days lookback capped (~80) to stay under Dhan's ~90-day intraday window.
   */
  async function getKlines(instrument, interval = '15m', limit = 500) {
    const securityId = instrument.dhanSecurityId || instrument.securityId || '13';
    const exchangeSegment = instrument.dhanExchangeSegment || instrument.exchangeSegment || 'IDX_I';
    const instrumentType = instrument.dhanInstrument || instrument.instrument || 'INDEX';
    const { api, resampleMs } = mapInterval(interval);
    const cacheKey = `${securityId}|${exchangeSegment}|${instrumentType}|${api}|${resampleMs || 0}`;
    const cached = _klineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < KLINE_CACHE_TTL_MS && cached.rows.length >= Math.min(limit, 40)) {
      return cached.rows.length > limit ? cached.rows.slice(-limit) : cached.rows;
    }
    const days = Math.min(80, Math.max(3, Math.ceil((Number(limit) || 500) / 50) + 2));
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    const payload = await getIntradayOhlc({
      securityId,
      exchangeSegment,
      instrument: instrumentType,
      interval: api,
      fromDate: fmtIstish(from),
      toDate: fmtIstish(to),
    });
    let rows = _toRows(payload);
    rows = _resample(rows, resampleMs);
    if (rows.length) {
      _klineCache.set(cacheKey, { ts: Date.now(), rows });
    }
    if (rows.length > limit) rows = rows.slice(-limit);
    return rows;
  }

  /**
   * Paginate intraday history (max ~90 days per call; Data plan allows up to ~5y).
   * Returns Binance-shaped rows [t,o,h,l,c,v], oldest→newest.
   */
  async function getIntradayRange({
    securityId = '13',
    exchangeSegment = 'IDX_I',
    instrument = 'INDEX',
    interval = '5',
    fromMs,
    toMs = Date.now(),
    chunkDays = 85,
    pauseMs = 250,
  } = {}) {
    const { api, resampleMs } = mapInterval(interval);
    const start = Number(fromMs);
    const end = Number(toMs);
    if (!(start > 0 && end > start)) throw new Error('getIntradayRange: bad fromMs/toMs');
    const all = [];
    let cursor = start;
    const step = Math.max(7, Number(chunkDays) || 85) * 86400000;
    while (cursor < end) {
      const chunkEnd = Math.min(cursor + step, end);
      const payload = await getIntradayOhlc({
        securityId,
        exchangeSegment,
        instrument,
        interval: api,
        fromDate: fmtIstish(new Date(cursor)),
        toDate: fmtIstish(new Date(chunkEnd)),
      });
      const rows = _toRows(payload);
      for (const r of rows) all.push(r);
      cursor = chunkEnd;
      if (pauseMs > 0 && cursor < end) await new Promise((r) => setTimeout(r, pauseMs));
    }
    all.sort((a, b) => a[0] - b[0]);
    const dedup = [];
    let lastT = -1;
    for (const r of all) {
      if (r[0] === lastT) continue;
      dedup.push(r);
      lastT = r[0];
    }
    return _resample(dedup, resampleMs);
  }

  /** Renew active web-generated token for another 24h. */
  async function renewToken() {
    return _request('POST', '/RenewToken', {
      extraHeaders: { dhanClientId: String(clientId) },
    });
  }

  async function placeOrder(body) {
    return _request('POST', '/orders', {
      body: { dhanClientId: String(clientId), ...body },
    });
  }

  async function modifyOrder(orderId, body) {
    return _request('PUT', `/orders/${orderId}`, {
      body: { dhanClientId: String(clientId), orderId: String(orderId), ...body },
    });
  }

  async function cancelOrder(orderId) {
    return _request('DELETE', `/orders/${orderId}`);
  }

  async function getOrders() {
    return _request('GET', '/orders');
  }

  async function getOrderById(orderId) {
    return _request('GET', `/orders/${orderId}`);
  }

  /** Super Order = entry + target + SL (+ optional trail) in one request. Needs Static IP. */
  async function placeSuperOrder(body) {
    return _request('POST', '/super/orders', {
      body: { dhanClientId: String(clientId), ...body },
    });
  }

  async function modifySuperOrder(orderId, body) {
    return _request('PUT', `/super/orders/${orderId}`, {
      body: { dhanClientId: String(clientId), orderId: String(orderId), ...body },
    });
  }

  async function cancelSuperOrderLeg(orderId, legName) {
    return _request('DELETE', `/super/orders/${orderId}/${legName}`);
  }

  async function getSuperOrders() {
    return _request('GET', '/super/orders');
  }

  /** Close all open positions + cancel open orders (kill switch). */
  async function exitAll() {
    return _request('DELETE', '/positions/exit-all').catch(async () =>
      _request('POST', '/positions/exit-all', { body: { dhanClientId: String(clientId) } }));
  }

  async function getOptionExpiryList({ underlyingScrip = 13, underlyingSeg = 'IDX_I' } = {}) {
    return _request('POST', '/optionchain/expirylist', {
      body: { UnderlyingScrip: Number(underlyingScrip), UnderlyingSeg: underlyingSeg },
    });
  }

  async function getOptionChain({ underlyingScrip = 13, underlyingSeg = 'IDX_I', expiry } = {}) {
    if (!expiry) throw new Error('getOptionChain: expiry YYYY-MM-DD required');
    return _request('POST', '/optionchain', {
      body: {
        UnderlyingScrip: Number(underlyingScrip),
        UnderlyingSeg: underlyingSeg,
        Expiry: String(expiry),
      },
    });
  }

  /**
   * Live LTP across all segments including MCX_COMM, NSE_FNO, IDX_I.
   */
  async function getMarketLtp(segment, securityId) {
    try {
      const segKey = String(segment || 'NSE_FNO').toUpperCase();
      const secNum = Number(securityId);
      if (!secNum) return null;
      const res = await _request('POST', '/marketfeed/ltp', {
        body: { [segKey]: [secNum] },
      });
      const node = res?.data?.[segKey]?.[String(secNum)] || res?.data?.[segKey]?.[secNum];
      return Number(node?.last_price) || null;
    } catch (_) {
      return null;
    }
  }

  return {
    clientId,
    getProfile,
    getFundLimits,
    getPositions,
    getIntradayOhlc,
    getKlines,
    getIntradayRange,
    mapInterval,
    renewToken,
    placeOrder,
    modifyOrder,
    cancelOrder,
    getOrders,
    getOrderById,
    placeSuperOrder,
    modifySuperOrder,
    cancelSuperOrderLeg,
    getSuperOrders,
    exitAll,
    getOptionExpiryList,
    getOptionChain,
    getMarketLtp,
    _request,
  };
}

/**
 * Generate a fresh 24h access token via TOTP (no web login).
 * Requires TOTP enabled on Dhan account.
 *   POST https://auth.dhan.co/app/generateAccessToken?dhanClientId&pin&totp
 */
async function generateAccessTokenViaTotp({
  dhanClientId = env('DHAN_CLIENT_ID'),
  pin = env('DHAN_PIN'),
  totp = env('DHAN_TOTP_CODE'),
} = {}) {
  if (!dhanClientId || !pin || !totp) {
    throw new Error('generateAccessTokenViaTotp needs dhanClientId, pin, totp');
  }
  const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${encodeURIComponent(dhanClientId)}&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totp)}`;
  const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.accessToken) {
    const msg = data.message || data.errorMessage || `TOTP token HTTP ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function isDhanConfigured() {
  return Boolean(env('DHAN_CLIENT_ID') && env('DHAN_ACCESS_TOKEN'));
}

module.exports = {
  createDhanClient,
  isDhanConfigured,
  generateAccessTokenViaTotp,
  env,
};
