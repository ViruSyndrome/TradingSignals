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
      
      // Filter for USDT pairs that are currently TRADING with > $2M volume
      const validPairs = tickers.filter(t => 
        t.symbol.endsWith('USDT') && 
        tradingPairs.has(t.symbol) &&
        parseFloat(t.quoteVolume) > 2000000 &&
        !['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT'].includes(t.symbol)
      );

      // Calculate daily volatility (High - Low) / Low
      const withVol = validPairs.map(t => {
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const vol = low > 0 ? (high - low) / low : 0;
        return { ...t, volatility: vol };
      });

      // Take the top 60 most volatile coins
      withVol.sort((a, b) => b.volatility - a.volatility);
      const top30 = withVol.slice(0, 60);

      const results = [];
      let completed = 0;

      if (onProgress) onProgress(`Deep scanning top ${top30.length} high-volatility pairs...`);

      // Process in batches of 5 to respect Binance rate limits and browser connections
      const chunkSize = 5;
      for (let i = 0; i < top30.length; i += chunkSize) {
        const chunk = top30.slice(i, i + chunkSize);
        
        const promises = chunk.map(async t => {
          try {
            const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${t.symbol}&interval=4h&limit=250`);
            const klines = await klinesRes.json();
            
            if (!Array.isArray(klines) || klines.length < 200) return null; // Ignore if not enough history
            
            const closes  = klines.map(k => parseFloat(k[4]));
            const highs   = klines.map(k => parseFloat(k[2]));
            const lows    = klines.map(k => parseFloat(k[3]));
            const volumes = klines.map(k => parseFloat(k[5]));
            const timestamps = klines.map(k => k[0]);
            
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
            
            const result = Signals.generate(closes, { highs, lows, volumes, fearGreed: fg, asset: assetInfo });
            if (result.signal !== 'BUY' && result.signal !== 'STRONG_BUY') return null;

            return {
              asset: assetInfo,
              category: 'crypto',
              price: closes[closes.length - 1],
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
      );

      return setups;
    } catch (err) {
      console.error('Scanner failed', err);
      throw err;
    }
  }
};

window.Scanner = Scanner;
