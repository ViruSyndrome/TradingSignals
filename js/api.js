'use strict';

/**
 * api.js — Data fetching with in-memory caching and rate limiting.
 * Sources:
 *   - Binance (high rate limits, CORS-enabled) for crypto OHLC + prices
 *   - Yahoo Finance via allorigins CORS proxy for stocks, commodities, forex (currently disabled)
 */
const API = {

  // ─── Cache helpers (localStorage-backed) ───────────────────────────────────
  _get(key) {
    try {
      const stored = localStorage.getItem(`trading_cache_${key}`);
      if (!stored) return null;
      const entry = JSON.parse(stored);
      if (Date.now() - entry.ts < Math.min(entry.ttl, 60000)) return entry.data;
      return null;
    } catch(e) { return null; }
  },
  _set(key, data, ttl = CONFIG.refresh.cacheMs) {
    try {
      localStorage.setItem(`trading_cache_${key}`, JSON.stringify({ data, ts: Date.now(), ttl }));
    } catch(e) {}
    return data;
  },

  // Binance blocks some cloud IPs with HTTP 418. Rotate public market-data hosts.
  _binanceHosts: [
    'https://data-api.binance.vision',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://api4.binance.com',
    'https://api.binance.com',
  ],
  _binanceHostIdx: 0,
  _binanceCooloffUntil: 0,
  _binanceHardBanUntil: 0, // after full 418 sweep, skip Binance for a while and use OKX
  _preferOkx: false,
  _okxWarned: false,

  _isNode() {
    return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  },

  _binanceBase() {
    return this._binanceHosts[this._binanceHostIdx % this._binanceHosts.length];
  },

  _rotateBinanceHost(reason) {
    const prev = this._binanceBase();
    this._binanceHostIdx = (this._binanceHostIdx + 1) % this._binanceHosts.length;
    console.warn(`[API] Rotating Binance host (${reason}): ${prev} → ${this._binanceBase()}`);
  },

  _markBinanceHardBan(minutes = 45) {
    this._binanceHardBanUntil = Date.now() + minutes * 60 * 1000;
    console.warn(`[API] Binance IP appears banned (418). Using OKX fallback for ~${minutes}m.`);
  },

  _binanceIsHardBanned() {
    return Date.now() < this._binanceHardBanUntil;
  },

  // ─── Generic fetch with timeout + retry ───────────────────────────────────
  async _fetch(url, timeoutMs = 12000, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const headers = {};
        if (this._isNode()) {
          headers['User-Agent'] = 'Mozilla/5.0 (compatible; TrendRunnerBot/1.0; +https://trendrunner.app)';
          headers['Accept'] = 'application/json';
        }
        const r = await fetch(url, { signal: ctrl.signal, headers });
        clearTimeout(timer);
        if (!r.ok) {
          const err = new Error(`HTTP ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return await r.json();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < retries) await this._delay(400 * (attempt + 1));
      }
    }
    throw lastErr;
  },

  /**
   * Binance market-data fetch with host failover on 418/429/403.
   * pathQuery example: `/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=250`
   */
  async _fetchBinance(pathQuery, timeoutMs = 15000, retries = 4) {
    if (this._binanceIsHardBanned() || this._preferOkx) {
      const err = new Error('HTTP 418');
      err.status = 418;
      throw err;
    }
    if (Date.now() < this._binanceCooloffUntil) {
      await this._delay(this._binanceCooloffUntil - Date.now());
    }

    let lastErr;
    const triedHosts = new Set();
    const maxAttempts = Math.max(retries + 1, this._binanceHosts.length);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const host = this._binanceBase();
      const url = `${host}${pathQuery}`;
      try {
        return await this._fetch(url, timeoutMs, 0);
      } catch (e) {
        lastErr = e;
        const status = e?.status || Number((String(e.message).match(/HTTP (\d+)/) || [])[1]);
        const banned = status === 418 || status === 429 || status === 403;
        if (banned) {
          triedHosts.add(host);
          this._rotateBinanceHost(`HTTP ${status}`);
          // Every public host rejected us — treat IP as banned and stop retrying Binance
          if (triedHosts.size >= this._binanceHosts.length) {
            this._preferOkx = true;
            this._markBinanceHardBan(45);
            break;
          }
          const backoff = Math.min(4000, 800 * (attempt + 1));
          this._binanceCooloffUntil = Date.now() + backoff;
          await this._delay(backoff);
          continue;
        }
        if (attempt < maxAttempts - 1) await this._delay(500 * (attempt + 1));
      }
    }
    throw lastErr;
  },

  // ─── Delay helper ────────────────────────────────────────────────────────────
  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  /** OKX public tickers → Binance-shaped price map { BTCUSDT: { lastPrice, priceChangePercent, quoteVolume } } */
  async _getCryptoPricesOkx(wantedSymbols) {
    const data = await this._fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT', 15000, 2);
    const rows = Array.isArray(data?.data) ? data.data : [];
    const wanted = new Set((wantedSymbols || []).map(s => String(s).toUpperCase()));
    const mapped = {};
    for (const t of rows) {
      const inst = String(t.instId || ''); // BTC-USDT
      if (!inst.endsWith('-USDT')) continue;
      const symbol = inst.replace('-', '');
      if (wanted.size && !wanted.has(symbol)) continue;
      const last = parseFloat(t.last);
      const open = parseFloat(t.open24h || t.sodUtc8 || t.sodUtc0);
      let pct = null;
      if (Number.isFinite(last) && Number.isFinite(open) && open > 0) {
        pct = ((last - open) / open) * 100;
      }
      mapped[symbol] = {
        symbol,
        lastPrice: String(last),
        priceChangePercent: pct != null ? String(pct) : undefined,
        quoteVolume: t.volCcy24h || t.vol24h,
      };
    }
    if (!this._okxWarned) {
      console.warn('[API] Serving prices via OKX fallback (Binance unavailable from this IP).');
      this._okxWarned = true;
    }
    return mapped;
  },

  /** OKX candles → Binance kline rows [ts, o, h, l, c, v] oldest→newest */
  async _getCryptoOHLCOkx(coinId, interval = '1d') {
    const binanceSymbol = coinId.replace('_4H', '').replace('_5M', '');
    const base = binanceSymbol.replace(/USDT$/, '');
    const instId = `${base}-USDT`;
    const bar = interval === '4h' || interval === '4H' ? '4H' : '1D';
    const limit = Math.min(CONFIG.refresh?.historyDays || 250, 300);
    const data = await this._fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`,
      15000,
      2
    );
    const rows = Array.isArray(data?.data) ? data.data.slice() : [];
    if (!rows.length) throw new Error('Empty OKX candles');
    // OKX returns newest first
    rows.reverse();
    return rows.map(r => [
      Number(r[0]),
      r[1],
      r[2],
      r[3],
      r[4],
      r[5],
    ]);
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // CRYPTO — Binance & DefiLlama (Fundamentals)
  // ══════════════════════════════════════════════════════════════════════════════

  async getDefiLlamaProtocols() {
    const key = 'defillama_protocols';
    const cached = this._get(key);
    // Cache for 1 hour to avoid hitting DefiLlama limits
    if (cached) return cached;
    
    try {
      const [protocolsRes, chainsRes] = await Promise.all([
        this._fetch('https://api.llama.fi/protocols', 8000),
        this._fetch('https://api.llama.fi/chains', 8000)
      ]);
      
      const merged = [];
      if (Array.isArray(protocolsRes)) merged.push(...protocolsRes);
      if (Array.isArray(chainsRes)) {
        // Map chain objects to look like protocol objects so the UI parses it correctly
        merged.push(...chainsRes.map(c => ({
          symbol: c.tokenSymbol,
          tvl: c.tvl,
          name: c.name
        })));
      }
      return this._set(key, merged, 3600000); 
    } catch (e) {
      console.warn('[API] DefiLlama fetch failed:', e.message);
      return [];
    }
  },

  async getCryptoSymbolRules() {
    const key = 'crypto_symbol_rules';
    const cached = this._get(key);
    if (cached) return cached;
    // Rules are Binance-specific; skip entirely when IP is banned (bot does not need them)
    if (this._preferOkx || this._binanceIsHardBanned()) return {};
    try {
      const rawSymbols = CONFIG.assets.crypto.map(a => a.id.replace('_4H', '').replace('_5M', ''));
      const uniqueSymbols = [...new Set(rawSymbols)];
      const symbols = JSON.stringify(uniqueSymbols);
      const data = await this._fetchBinance(`/api/v3/exchangeInfo?symbols=${encodeURIComponent(symbols)}`, 8000);
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

    const rawSymbols = CONFIG.assets.crypto.map(a => a.id.replace('_4H', '').replace('_5M', ''));
    const uniqueSymbols = [...new Set(rawSymbols)];
    const symbols = JSON.stringify(uniqueSymbols);
    const urlPath = `/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;
    try {
      if (!this._binanceIsHardBanned()) {
        const data = await this._fetchBinance(urlPath, 15000);
        const mapped = {};
        for (const t of data) mapped[t.symbol] = t;
        return this._set(key, mapped);
      }
    } catch (e) {
      console.warn('[API] Binance price fetch failed:', e.message);
    }
    try {
      this._preferOkx = true;
      if (!this._binanceIsHardBanned()) this._markBinanceHardBan(45);
      const mapped = await this._getCryptoPricesOkx(uniqueSymbols);
      if (mapped && Object.keys(mapped).length) return this._set(key, mapped);
    } catch (e2) {
      console.warn('[API] OKX price fallback failed:', e2.message);
    }
    return null;
  },

  /**
   * Fetch historical OHLC for a single crypto asset (Binance → OKX fallback).
   * Returns array of [timestamp_ms, open, high, low, close, volume]
   */
  async getCryptoOHLC(coinId, interval = '1d') {
    const key = `crypto_hist_${coinId}_${interval}`;
    const cached = this._get(key);
    if (cached) return cached;

    const binanceSymbol = coinId.replace('_4H', '').replace('_5M', '');
    const days = CONFIG.refresh.historyDays;
    const path = `/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${days}`;
    try {
      if (!this._binanceIsHardBanned()) {
        const data = await this._fetchBinance(path, 15000);
        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty klines');
        return this._set(key, data, CONFIG.refresh.cacheMs);
      }
    } catch (e) {
      console.warn(`[API] Binance history failed for ${coinId}:`, e.message);
    }
    try {
      const data = await this._getCryptoOHLCOkx(coinId, interval);
      return this._set(key, data, CONFIG.refresh.cacheMs);
    } catch (e2) {
      console.warn(`[API] OKX history failed for ${coinId}:`, e2.message);
      return null;
    }
  },

  /**
   * Fetch all crypto data: prices + historical prices.
   * Live-patches the last close with the current ticker price so signals
   * react to intraday moves instead of a stale (still-forming) daily candle.
   */
  async getAllCrypto() {
    // --- Dynamic Private Coin Injection ---
    try {
      if (typeof localStorage !== 'undefined') {
        const portStr = localStorage.getItem('trading_invested');
        const port = portStr ? JSON.parse(portStr) : [];
        if (typeof CONFIG !== 'undefined' && CONFIG.assets && CONFIG.assets.crypto) {
          const keys = Array.isArray(port) ? port : Object.keys(port);
          for (const sym of keys) {
            // Locked holdings track the base daily pair only
            const normalized = String(sym).toUpperCase().replace('_4H', '').replace('_5M', '');
            const hasEquivalentAsset = CONFIG.assets.crypto.some(a =>
              a.id.replace('_4H', '').replace('_5M', '') === normalized
            );
            if (!hasEquivalentAsset) {
              CONFIG.assets.crypto.push({
                id: normalized,
                symbol: normalized.replace('USDT', ''),
                name: normalized.replace('USDT', ''),
                currency: 'USD',
                icon: '💎'
              });
            }
          }
        }
      }
    } catch(e) {}
    
      const [prices, rules] = await Promise.all([
        this.getCryptoPrices(),
        this.getCryptoSymbolRules()
      ]);
      const llamaData = await this.getDefiLlamaProtocols();
      
      // Fast-fail: If we couldn't even fetch basic prices, both Binance and OKX are blocked/offline.
      if (!prices || Object.keys(prices).length === 0) {
        throw new Error('All crypto exchange APIs (Binance/OKX) are unreachable. Please check your connection, ad-blocker, or VPN.');
      }

    // Create a fast lookup map for DefiLlama data by symbol (keep the one with highest TVL)
    const llamaMap = new Map();
    if (Array.isArray(llamaData)) {
      for (const p of llamaData) {
        // Ignore dead/fake protocols with < $100k TVL to prevent them from hijacking L1 tickers (e.g. "Solana Farm" hijacking "SOL")
        if (p.symbol && p.tvl > 100000) {
          const sym = p.symbol.toUpperCase();
          const existing = llamaMap.get(sym);
          if (!existing || p.tvl > existing.tvl) {
            llamaMap.set(sym, p);
          }
        }
      }
    }

    const results = [];
    // Browser: small parallel chunks. Node/Render: slower to avoid Binance 418 IP bans.
    const onServer = this._isNode();
    const chunkSize = onServer ? 1 : 3;
    const chunkDelay = onServer ? 700 : 100;

    for (let i = 0; i < CONFIG.assets.crypto.length; i += chunkSize) {
      const chunk = CONFIG.assets.crypto.slice(i, i + chunkSize);
      const promises = chunk.map(async (asset) => {
        // On server, fetch 1d then 4h sequentially to cut burst weight in half
        let hist1D, hist4H;
        if (onServer) {
          hist1D = await this.getCryptoOHLC(asset.id, '1d');
          await this._delay(120);
          hist4H = await this.getCryptoOHLC(asset.id, '4h');
        } else {
          [hist1D, hist4H] = await Promise.all([
            this.getCryptoOHLC(asset.id, '1d'),
            this.getCryptoOHLC(asset.id, '4h')
          ]);
        }
        const binanceSymbol = asset.id.replace('_4H', '').replace('_5M', '');
        const baseSymbol = binanceSymbol.replace('USDT', '');
        
        const priceInfo = prices?.[binanceSymbol] ?? {};
        const livePrice = priceInfo.lastPrice ? parseFloat(priceInfo.lastPrice) : null;
        
        const llamaProtocol = llamaMap.get(baseSymbol);

        const hist = asset.grafted ? hist4H : hist1D; // Default engine history
        
        const closes     = hist ? hist.map(r => parseFloat(r[4])) : [];
        const opens      = hist ? hist.map(r => parseFloat(r[1])) : [];
        const highs      = hist ? hist.map(r => parseFloat(r[2])) : [];
        const lows       = hist ? hist.map(r => parseFloat(r[3])) : [];
        const volumes    = hist ? hist.map(r => parseFloat(r[5])) : [];
        const timestamps = hist ? hist.map(r => r[0]) : [];

        const closes1D   = hist1D ? hist1D.map(r => parseFloat(r[4])) : [];
        const closes4H   = hist4H ? hist4H.map(r => parseFloat(r[4])) : [];

        // Calculate 4H percentage change (Last 4H close vs Previous 4H close)
        let change4h = null;
        if (closes4H.length >= 2 && livePrice != null) {
          const prev4HClose = closes4H[closes4H.length - 2]; // Previous completed 4H candle
          if (prev4HClose > 0) {
            change4h = ((livePrice - prev4HClose) / prev4HClose) * 100;
          }
        }

        // Patch the still-forming daily candle with the live ticker so indicators aren't stale.
        if (livePrice != null && closes.length > 0) {
          const lastIdx = closes.length - 1;
          closes[lastIdx] = livePrice;
          if (highs[lastIdx] != null && livePrice > highs[lastIdx]) highs[lastIdx] = livePrice;
          if (lows[lastIdx]  != null && livePrice < lows[lastIdx])  lows[lastIdx]  = livePrice;
        }

        return {
          asset,
          rules: rules[binanceSymbol] || null,
          price:      livePrice,
          change24h:  priceInfo.priceChangePercent != null ? parseFloat(priceInfo.priceChangePercent) : null,
          change4h,
          volume:     priceInfo.quoteVolume ? parseFloat(priceInfo.quoteVolume) : null,
          marketCap:  llamaProtocol?.mcap || null,
          tvl:        llamaProtocol?.tvl || null,
          closes,
          opens,
          highs,
          lows,
          volumes,
          timestamps,
          closes1D,
          closes4H,
          rawOHLC:    hist ?? [],
          source:     'binance',
          fetchedAt:  new Date().toISOString(),
          error:      hist ? null : 'Data unavailable',
        };
      });
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
      if (i + chunkSize < CONFIG.assets.crypto.length) await this._delay(chunkDelay);
    }

    return results;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { API };
