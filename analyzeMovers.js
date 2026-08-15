const Signals = require('./js/signals.js');
global.Indicators = require('./js/indicators.js');

async function analyzeTopMovers() {
  console.log('Fetching top 24h movers on Binance...');
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  const tickers = await res.json();
  
  // Filter for USDT pairs, decent volume
  const valid = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000000);
  
  // Sort by price change % descending
  valid.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));
  const topMovers = valid.slice(0, 5);
  
  console.log('Top 5 Movers Today:');
  topMovers.forEach(t => console.log(`- ${t.symbol}: +${t.priceChangePercent}%`));
  console.log("\\nRunning Engine on YESTERDAY's data to see if we caught the setup...");
  
  for (const t of topMovers) {
    const kRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${t.symbol}&interval=1d&limit=250`);
    const klines = await kRes.json();
    
    // Remove TODAY'S candle (the massive green one) to see what it looked like yesterday
    klines.pop();
    
    if (klines.length < 200) {
      console.log(`${t.symbol}: Not enough history.`);
      continue;
    }
    
    const closes  = klines.map(k => parseFloat(k[4]));
    const highs   = klines.map(k => parseFloat(k[2]));
    const lows    = klines.map(k => parseFloat(k[3]));
    const volumes = klines.map(k => parseFloat(k[5]));
    
    const asset = { id: t.symbol.replace('USDT','').toLowerCase() };
    const result = Signals.generate(closes, { highs, lows, volumes, asset });
    
    console.log(`\n--- ${t.symbol} (Yesterday's Signal) ---`);
    console.log(`Signal: ${result.signal} | Score: ${result.score}`);
    console.log(JSON.stringify(result.indicators, null, 2));
  }
}
analyzeTopMovers().catch(console.error);
