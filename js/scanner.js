'use strict';

const Scanner = {
  async scanMarket(onProgress) {
    try {
      if (onProgress) onProgress('Fetching active trading pairs...');
      const exInfoRes = await fetch('https://api.binance.com/api/v3/exchangeInfo');
      const exInfo = await exInfoRes.json();
      const tradingPairs = new Set();
      exInfo.symbols.forEach(s => {
        if (s.status === 'TRADING') tradingPairs.add(s.symbol);
      });

      if (onProgress) onProgress('Fetching 24hr market data for all coins...');
      
      const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
      const tickers = await res.json();
      
      if (!Array.isArray(tickers)) {
        throw new Error(tickers.msg || 'Binance API rate limit hit or invalid response.');
      }
      
      const safeBCryptos = new Set(['BNBUSDT', 'USDSBUSDT', 'DGBUSDT', 'TRBUSDT', 'CKBUSDT', 'SHIBUSDT', 'MOBUSDT', 'PHBUSDT', 'VIBUSDT', 'AMBUSDT', 'ARBUSDT', 'BBUSDT', 'YBUSDT', 'MUBUSDT', 'FLBUSDT']);
      const stableCoins = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'EULUSDT']);

      // Filter for USDT pairs that are currently TRADING with > $2M volume
      const validPairs = tickers.filter(t => {
        if (!t.symbol.endsWith('USDT') || !tradingPairs.has(t.symbol) || parseFloat(t.quoteVolume) < 2000000) return false;
        if (stableCoins.has(t.symbol)) return false;
        if (t.symbol.endsWith('BUSDT') && !safeBCryptos.has(t.symbol)) return false;
        // Avoid duplicating core coins that are already tracked on the dashboard
        if (typeof CONFIG !== 'undefined' && CONFIG.assets && CONFIG.assets.crypto) {
          const isCore = CONFIG.assets.crypto.some(a => a.symbol === t.symbol.replace('USDT', '') && !a.isMoonshot);
          if (isCore) return false;
        }
        return true;
      });

      // Calculate daily volatility (High - Low) / Low
      const withVol = validPairs.map(t => {
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const vol = low > 0 ? (high - low) / low : 0;
        return { ...t, volatility: vol };
      });

      // Use volatility as a screening input, while keeping liquidity in the ranking.
      withVol.sort((a, b) => {
        const score = t => t.volatility * Math.log10(Math.max(parseFloat(t.quoteVolume), 1));
        return score(b) - score(a);
      });
      const top30 = withVol;

      let marketRegime = 'flat';
      try {
        const btcRes = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=251');
        const btcKlines = await btcRes.json();
        const btcClosed = Array.isArray(btcKlines) ? btcKlines.slice(0, -1) : [];
        const btcCloses = btcClosed.map(k => parseFloat(k[4]));
        if (btcCloses.length >= 50) {
          const btcPrice = btcCloses[btcCloses.length - 1];
          const btcSma50 = Indicators.last(Indicators.sma(btcCloses, 50));
          const btcEma9 = Indicators.last(Indicators.ema(btcCloses, 9));
          const btcEma21 = Indicators.last(Indicators.ema(btcCloses, 21));
          marketRegime = btcPrice > btcSma50 && btcEma9 > btcEma21 ? 'bull' : btcPrice < btcSma50 && btcEma9 < btcEma21 ? 'bear' : 'flat';
        }
      } catch (err) {
        console.warn('[Moonshots] BTC regime unavailable:', err.message);
      }

      const results = [];
      let completed = 0;

      if (onProgress) onProgress(`Deep scanning all ${top30.length} high-volatility pairs...`);

      // Process in batches of 5 to respect Binance rate limits and browser connections
      const chunkSize = 5;
      for (let i = 0; i < top30.length; i += chunkSize) {
        const chunk = top30.slice(i, i + chunkSize);
        
        const promises = chunk.map(async t => {
          try {
            const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${t.symbol}&interval=4h&limit=250`);
            const klines = await klinesRes.json();
            const closedKlines = Array.isArray(klines) ? klines : [];
            
            if (closedKlines.length < 200) return null; // Ignore if not enough closed history
            
            const closes  = closedKlines.map(k => parseFloat(k[4]));
            const highs   = closedKlines.map(k => parseFloat(k[2]));
            const lows    = closedKlines.map(k => parseFloat(k[3]));
            const volumes = closedKlines.map(k => parseFloat(k[5]));
            const timestamps = closedKlines.map(k => k[0]);
            
            // Format to match the dashboard's asset structure, appending _4H to prevent collisions with 1D core coins
            const assetInfo = {
              id: t.symbol + '_4H', // e.g. AVAXUSDT_4H
              symbol: t.symbol.replace('USDT', ''),
              name: t.symbol.replace('USDT', ''),
              currency: 'USD',
              icon: '🚀' // Generic moonshot icon
            };
            
            let fg = 50;
            try { fg = parseInt(document.getElementById('fearGreedValue').textContent, 10) || 50; } catch(e) {}
            
            // Call the new Breakout Engine for the Moonshot scanner
            const result = Signals.generateBreakout(closes, { highs, lows, volumes, fearGreed: fg, marketRegime, symbol: t.symbol.replace('USDT', ''), asset: assetInfo, ignoreWinnersFilter: true });
            if (result.signal !== 'BUY' && result.signal !== 'STRONG_BUY') return null;

            return {
              asset: assetInfo,
              category: 'crypto',
              price: parseFloat(t.lastPrice),
              change24h: parseFloat(t.priceChangePercent),
              closes: closes,
              timestamps: timestamps,
              signalResult: result
            };
          } catch (err) {
            console.error(`Failed scanning ${t.symbol}`, err);
            return null;
          }
        });
        
        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));
        
        completed += chunk.length;
        if (onProgress) onProgress(`Deep scanning... ${Math.min(completed, top30.length)} / ${top30.length}`);
        
        // Small delay between chunks
        if (i + chunkSize < top30.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Filter to only return the ones that triggered our BUY setups
      const setups = results.filter(r => 
        r.signalResult.signal === 'BUY' || 
        r.signalResult.signal === 'STRONG_BUY'
      ).sort((a, b) => {
        const aBreakout = a.signalResult.indicators.breakout;
        const bBreakout = b.signalResult.indicators.breakout;
        return b.signalResult.score - a.signalResult.score || bBreakout.volumeRatio - aBreakout.volumeRatio;
      }).slice(0, 20);

      try {
        const key = 'trading_moonshot_journal_v1';
        const previous = JSON.parse(localStorage.getItem(key) || '[]');
        const now = new Date().toISOString();
        const entries = setups.map(setup => ({
          id: `${setup.asset.symbol}-${Date.now()}`,
          symbol: setup.asset.symbol,
          scannedAt: now,
          entryPrice: setup.price,
          signal: setup.signalResult.signal,
          score: setup.signalResult.score,
          volumeRatio: setup.signalResult.indicators.breakout.volumeRatio,
          stopPrice: setup.signalResult.stopSuggest?.stopPrice || null,
          takeProfitPrice: setup.signalResult.stopSuggest?.takeProfitPrice || null,
          outcomes: { oneHour: null, fourHour: null, oneDay: null, sevenDay: null },
          status: 'OPEN_PAPER_TEST',
        }));
        localStorage.setItem(key, JSON.stringify([...entries, ...previous].slice(0, 500)));
      } catch (err) {
        console.warn('[Moonshots] Journal save failed:', err.message);
      }

      return setups;
    } catch (err) {
      console.error('Scanner failed', err);
      throw err;
    }
  },

  async scanScalps(onProgress) {
    try {
      if (onProgress) onProgress('Fetching active trading pairs for scalper...');
      const exInfoRes = await fetch('https://api.binance.com/api/v3/exchangeInfo');
      const exInfo = await exInfoRes.json();
      const tradingPairs = new Set();
      exInfo.symbols.forEach(s => {
        if (s.status === 'TRADING') tradingPairs.add(s.symbol);
      });

      if (onProgress) onProgress('Fetching 24hr market data for meme coins...');
      
      const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
      const tickers = await res.json();
      
      if (!Array.isArray(tickers)) return [];
      
      const safeBCryptos = new Set(['BNBUSDT', 'USDSBUSDT', 'DGBUSDT', 'TRBUSDT', 'CKBUSDT', 'SHIBUSDT', 'MOBUSDT', 'PHBUSDT', 'VIBUSDT', 'AMBUSDT', 'ARBUSDT', 'BBUSDT', 'YBUSDT', 'MUBUSDT', 'FLBUSDT']);
      const stableCoins = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'EULUSDT']);

      // Filter for USDT pairs with > $1M volume (lower threshold for meme coins)
      const validPairs = tickers.filter(t => {
        if (!t.symbol.endsWith('USDT') || !tradingPairs.has(t.symbol) || parseFloat(t.quoteVolume) < 1000000) return false;
        if (stableCoins.has(t.symbol)) return false;
        if (t.symbol.endsWith('BUSDT') && !safeBCryptos.has(t.symbol)) return false;
        return true;
      });

      // Calculate daily volatility (High - Low) / Low
      const withVol = validPairs.map(t => {
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const vol = low > 0 ? (high - low) / low : 0;
        return { ...t, volatility: vol };
      });

      // Sort strictly by volatility for meme coins
      withVol.sort((a, b) => b.volatility - a.volatility);
      const top30 = withVol.slice(0, 30);

      const results = [];
      let completed = 0;

      if (onProgress) onProgress(`Deep scanning all ${top30.length} meme coins on 5-Minute charts...`);

      const chunkSize = 5;
      for (let i = 0; i < top30.length; i += chunkSize) {
        const chunk = top30.slice(i, i + chunkSize);
        
        const promises = chunk.map(async t => {
          try {
            const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${t.symbol}&interval=5m&limit=200`);
            const klines = await klinesRes.json();
            const closedKlines = Array.isArray(klines) ? klines : [];
            if (closedKlines.length < 50) return null;
            
            const closes  = closedKlines.map(k => parseFloat(k[4]));
            const highs   = closedKlines.map(k => parseFloat(k[2]));
            const lows    = closedKlines.map(k => parseFloat(k[3]));
            const volumes = closedKlines.map(k => parseFloat(k[5]));
            const timestamps = closedKlines.map(k => k[0]);
            
            const assetInfo = {
              id: t.symbol + '_5M',
              symbol: t.symbol.replace('USDT', ''),
              name: t.symbol.replace('USDT', ''),
              currency: 'USD',
              icon: '⚡' // Lightning for quick scalps
            };
            
            // Scalper ignores marketRegime and FearGreed entirely
            const result = Signals.generateScalp(closes, { highs, lows, volumes });
            if (result.signal !== 'BUY' && result.signal !== 'STRONG_BUY') return null;

            return {
              asset: assetInfo,
              category: 'scalper',
              price: parseFloat(t.lastPrice),
              change24h: parseFloat(t.priceChangePercent),
              change5m: ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100,
              closes: closes,
              timestamps: timestamps,
              signalResult: result
            };
          } catch (err) {
            return null;
          }
        });
        
        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));
        
        completed += chunk.length;
        if (onProgress) onProgress(`Deep scanning... ${Math.min(completed, top30.length)} / ${top30.length}`);
        
        if (i + chunkSize < top30.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Sort by score and volume ratio
      const setups = results.sort((a, b) => {
        const aScalp = a.signalResult.indicators.scalp;
        const bScalp = b.signalResult.indicators.scalp;
        return b.signalResult.score - a.signalResult.score || bScalp.volumeRatio - aScalp.volumeRatio;
      }).slice(0, 10);

      return setups;
    } catch (err) {
      console.error('Scalper failed', err);
      return [];
    }
  }
};

window.Scanner = Scanner;
