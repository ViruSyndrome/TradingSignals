const fs = require('fs');

const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');

global.CONFIG = CONFIG;
global.Indicators = Indicators;
global.Signals = Signals;

async function checkScores() {
  const symbols = CONFIG.assets.crypto.map(c => c.id);
  console.log('Fetching live data for ' + symbols.length + ' symbols...');
  
  let bestScore = -10;
  let bestAsset = null;
  let bestDetails = null;

  for(const asset of CONFIG.assets.crypto) {
    try {
      const days = CONFIG.refresh.historyDays;
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${asset.id}&interval=1d&limit=${days}`);
      const data = await res.json();
      if(Array.isArray(data) && data.length > 0) {
        const closes  = data.map(r => parseFloat(r[4]));
        const highs   = data.map(r => parseFloat(r[2]));
        const lows    = data.map(r => parseFloat(r[3]));
        const volumes = data.map(r => parseFloat(r[5]));
        const result = Signals.generate(closes, { highs, lows, volumes });
        
        console.log(asset.symbol.padEnd(6) + ' | Score: ' + result.score.toFixed(1).padStart(4) + ' | Conf: ' + result.confidence.toString().padStart(3) + '% | Signal: ' + result.signal);
        
        if (result.score > bestScore) {
          bestScore = result.score;
          bestAsset = asset.symbol;
          bestDetails = result;
        }
      }
    } catch(e) {
      console.log('Error fetching ' + asset.symbol);
    }
  }
  
  console.log('\n--- BEST ASSET CURRENTLY ---');
  console.log(bestAsset + ' | Score: ' + bestScore + ' | Conf: ' + bestDetails.confidence + '%');
  console.log('Indicators:', JSON.stringify(bestDetails.indicators, null, 2));
}

checkScores();
