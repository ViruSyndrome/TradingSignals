'use strict';

/**
 * api.js — Data fetching with in-memory caching and rate limiting.
 * Sources:
 *   - CoinGecko (free, CORS-enabled) for crypto OHLC + prices
 *   - Yahoo Finance via allorigins CORS proxy for stocks, commodities, forex
 */
const API = {

  // ─── Cache helpers (localStorage-backed) ───────────────────────────────────
  _get(key) {
    try {
      const stored = localStorage.getItem(`trading_cache_${key}`);
      if (!stored) return null;
      const entry = JSON.parse(stored);
      if (Date.now() - entry.ts < entry.ttl) return entry.data;
      return null;
    } catch(e) { return null; }
  },
  _set(key, data, ttl = CONFIG.refresh.cacheMs) {
    try {
      localStorage.setItem(`trading_cache_${key}`, JSON.stringify({ data, ts: Date.now(), ttl }));
    } catch(e) {}
    return data;
  },

  // ─── Generic fetch with timeout + one retry on transient failures ─────────
  async _fetch(url, timeoutMs = 12000, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < retries) await this._delay(400 * (attempt + 1));
      }
    }
    throw lastErr;
  },

  // ─── Delay helper ────────────────────────────────────────────────────────────
  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  // ══════════════════════════════════════════════════════════════════════════════
  // CRYPTO — Binance
  // ══════════════════════════════════════════════════════════════════════════════

  async getCryptoSymbolRules() {
    const key = 'crypto_symbol_rules';
    const cached = this._get(key);
    if (cached) return cached;
    try {
      const symbols = JSON.stringify(CONFIG.assets.crypto.map(a => a.id));
      const data = await this._fetch(`https://api.binance.com/api/v3/exchangeInfo?symbols=${encodeURIComponent(symbols)}`, 8000);
      const rules = {};
      for (const item of data.symbols || []) {
        const filters = Object.fromEntries((item.filters || []).map(f => [f.filterType, f]));
        rules[item.symbol] = {
          tickSize: parseFloat(filters.PRICE_FILTER?.tickSize || 0),
          stepSize: parseFloat(filters.LOT_SIZE?.stepSize || 0),
          minQty: parseFloat(filters.LOT_SIZE?.minQty || 0),
          minNotional: parseFloat(filters.NOTIONAL?.minNotional || filters.MIN_NOTIONAL?.minNotional || 0),
        };
      }
      return this._set(key, rules, 86400000);
    } catch (e) {
      console.warn('[API] Binance symbol rules failed:', e.message);
      return {};
    }
  },

  /**
   * Fetch current prices for all crypto in one call (Binance).
   */
  async getCryptoPrices() {
    const key = 'crypto_prices';
    const cached = this._get(key);
    if (cached) return cached;

    const rawSymbols = CONFIG.assets.crypto.map(a => a.id.replace('_4H', ''));
    const uniqueSymbols = [...new Set(rawSymbols)];
    const symbols = JSON.stringify(uniqueSymbols);
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;
    try {
      const data = await this._fetch(url, 5000);
      // Map Binance array to object keyed by symbol
      const mapped = {};
      for (const t of data) mapped[t.symbol] = t;
      return this._set(key, mapped);
    } catch (e) {
      console.warn('[API] Binance price fetch failed:', e.message);
      return null;
    }
  },

  /**
   * Fetch historical OHLC for a single crypto asset (Binance).
   * Returns array of [timestamp_ms, open, high, low, close, volume]
   */
  async getCryptoOHLC(coinId, interval = '1d') {
    const key = `crypto_hist_${coinId}_${interval}`;
    const cached = this._get(key);
    if (cached) return cached;

    const binanceSymbol = coinId.replace('_4H', '');
    const days = CONFIG.refresh.historyDays;
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${days}`;
    try {
      const data = await this._fetch(url, 5000); // [[time, o, h, l, c, v, ...], ...]
      if (!Array.isArray(data) || data.length === 0) throw new Error('Empty klines');
      return this._set(key, data, 14400000); // 4 hours TTL
    } catch (e) {
      console.warn(`[API] Binance history failed for ${coinId}:`, e.message);
      return null;
    }
  },

  /**
   * Fetch all crypto data: prices + historical prices.
   * Live-patches the last close with the current ticker price so signals
   * react to intraday moves instead of a stale (still-forming) daily candle.
   */
  async getAllCrypto() {
    const prices = await this.getCryptoPrices();
    const rules = await this.getCryptoSymbolRules();

    const promises = CONFIG.assets.crypto.map(async (asset) => {
      const interval = asset.grafted ? '4h' : '1d';
      const hist = await this.getCryptoOHLC(asset.id, interval);
      const binanceSymbol = asset.id.replace('_4H', '');
      const priceInfo = prices?.[binanceSymbol] ?? {};
      const livePrice = priceInfo.lastPrice ? parseFloat(priceInfo.lastPrice) : null;

      const closes     = hist ? hist.map(r => parseFloat(r[4])) : [];
      const opens      = hist ? hist.map(r => parseFloat(r[1])) : [];
      const highs      = hist ? hist.map(r => parseFloat(r[2])) : [];
      const lows       = hist ? hist.map(r => parseFloat(r[3])) : [];
      const volumes    = hist ? hist.map(r => parseFloat(r[5])) : [];
      const timestamps = hist ? hist.map(r => r[0]) : [];

      // Patch the still-forming daily candle with the live ticker so indicators aren't stale.
      if (livePrice != null && closes.length > 0) {
        const lastIdx = closes.length - 1;
        closes[lastIdx] = livePrice;
        if (highs[lastIdx] != null && livePrice > highs[lastIdx]) highs[lastIdx] = livePrice;
        if (lows[lastIdx]  != null && livePrice < lows[lastIdx])  lows[lastIdx]  = livePrice;
      }

      return {
        asset,
          rules: rules[asset.id] || null,
        price:      livePrice,
        change24h:  priceInfo.priceChangePercent != null ? parseFloat(priceInfo.priceChangePercent) : null,
        volume:     priceInfo.quoteVolume ? parseFloat(priceInfo.quoteVolume) : null,
        marketCap:  null,
        closes,
        opens,
        highs,
        lows,
        volumes,
        timestamps,
        rawOHLC:    hist ?? [],
        source:     'binance',
        fetchedAt:  new Date().toISOString(),
        error:      hist ? null : 'Data unavailable',
      };
    });

    return Promise.all(promises);
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // YAHOO FINANCE — Indian stocks, commodities, forex (via CORS proxy)
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Fetch Yahoo Finance chart data for a single symbol.
   * Returns { meta, timestamps, closes, opens, highs, lows, volumes }
   */
  async getYahooChart(symbol) {
    const key = `yahoo_${symbol}`;
    const cached = this._get(key);
    if (cached) return cached;

    const days   = CONFIG.refresh.historyDays;
    const yahooUrl = `${CONFIG.api.yahooChart}${encodeURIComponent(symbol)}?interval=1d&range=${days}d`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`;

    try {
      const json = await this._fetch(proxyUrl, 15000);
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No result in Yahoo response');

      const meta   = result.meta ?? {};
      const ts     = result.timestamp ?? [];
      const quote  = result.indicators?.quote?.[0] ?? {};

      const parsed = {
        meta,
        price:      meta.regularMarketPrice ?? null,
        prevClose:  meta.previousClose ?? null,
        change24h:  meta.regularMarketPrice && meta.previousClose
                    ? Indicators.pct(meta.previousClose, meta.regularMarketPrice)
                    : null,
        currency:   meta.currency ?? 'USD',
        marketState:meta.marketState ?? 'UNKNOWN',
        timestamps: ts.map(t => t * 1000),          // → ms
        closes:     (quote.close  || []).map(v => v ?? null),
        opens:      (quote.open   || []).map(v => v ?? null),
        highs:      (quote.high   || []).map(v => v ?? null),
        lows:       (quote.low    || []).map(v => v ?? null),
        volumes:    (quote.volume || []).map(v => v ?? null),
        source:     'yahoo',
        fetchedAt:  new Date().toISOString(),
        error:      null,
      };
      return this._set(key, parsed);
    } catch (e) {
      console.warn(`[API] Yahoo Finance proxy failed for ${symbol}:`, e.message);
      return {
        asset: null, price: null, change24h: null, closes: [], timestamps: [],
        source: 'yahoo', fetchedAt: new Date().toISOString(), error: e.message,
      };
    }
  },

  /** Fetch all Indian stocks */
  async getAllStocks() {
    const promises = CONFIG.assets.indianStocks.map(async (asset) => {
      const data = await this.getYahooChart(asset.id);
      return { asset, ...data };
    });
    return Promise.all(promises);
  },

  /** Fetch all commodities */
  async getAllCommodities() {
    const promises = CONFIG.assets.commodities.map(async (asset) => {
      const data = await this.getYahooChart(asset.id);
      return { asset, ...data };
    });
    return Promise.all(promises);
  },

  /** Fetch all forex pairs */
  async getAllForex() {
    const promises = CONFIG.assets.forex.map(async (asset) => {
      const data = await this.getYahooChart(asset.id);
      return { asset, ...data };
    });
    return Promise.all(promises);
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // MARKET STATUS
  // ══════════════════════════════════════════════════════════════════════════════
  getMarketStatus() {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun 6=Sat
    const h   = ist.getHours();
    const m   = ist.getMinutes();
    const hm  = h * 60 + m;

    const nseOpen  = 9 * 60 + 15;
    const nseClose = 15 * 60 + 30;
    const nseOpen_ = day >= 1 && day <= 5 && hm >= nseOpen && hm <= nseClose;

    return {
      nse:    { open: nseOpen_,   label: nseOpen_ ? 'NSE Open' : 'NSE Closed' },
      crypto: { open: true,       label: 'Crypto 24/7' },
    };
  },
};
