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
    try {
      const rawSymbols = CONFIG.assets.crypto.map(a => a.id.replace('_4H', '').replace('_5M', ''));
      const uniqueSymbols = [...new Set(rawSymbols)];
      const symbols = JSON.stringify(uniqueSymbols);
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

    const rawSymbols = CONFIG.assets.crypto.map(a => a.id.replace('_4H', '').replace('_5M', ''));
    const uniqueSymbols = [...new Set(rawSymbols)];
    const symbols = JSON.stringify(uniqueSymbols);
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;
    try {
      const data = await this._fetch(url, 15000);
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

    const binanceSymbol = coinId.replace('_4H', '').replace('_5M', '');
    const days = CONFIG.refresh.historyDays;
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${days}`;
    try {
      const data = await this._fetch(url, 15000); // [[time, o, h, l, c, v, ...], ...]
      if (!Array.isArray(data) || data.length === 0) throw new Error('Empty klines');
      return this._set(key, data, CONFIG.refresh.cacheMs); // 55 seconds TTL
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
    const llamaData = await this.getDefiLlamaProtocols();

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
    const chunkSize = 3; // 3 assets = 6 concurrent requests (max for mobile browsers)
    for (let i = 0; i < CONFIG.assets.crypto.length; i += chunkSize) {
      const chunk = CONFIG.assets.crypto.slice(i, i + chunkSize);
      const promises = chunk.map(async (asset) => {
        const [hist1D, hist4H] = await Promise.all([
          this.getCryptoOHLC(asset.id, '1d'),
          this.getCryptoOHLC(asset.id, '4h')
        ]);
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
      if (i + chunkSize < CONFIG.assets.crypto.length) await this._delay(100);
    }

    return results;
  },
};
