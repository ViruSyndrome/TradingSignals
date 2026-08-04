const fs = require('fs');
const configStr = fs.readFileSync('js/config.js', 'utf8').replace('const CONFIG =', 'global.CONFIG =');
eval(configStr);
const indStr = fs.readFileSync('js/indicators.js', 'utf8').replace('const Indicators =', 'global.Indicators =');
eval(indStr);
const sigStr = fs.readFileSync('js/signals.js', 'utf8').replace('const Signals =', 'global.Signals =');
eval(sigStr);

async function test() {
  let count = 0;
  for(const asset of CONFIG.assets.crypto) {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${asset.id}&interval=1d&limit=90`);
    const data = await res.json();
    const closes = data.map(r => parseFloat(r[4]));
    const result = Signals.generate(closes);
    if (result.indicators?.rsi?.value < 35) {
       console.log(asset.id, 'RSI:', result.indicators.rsi.value);
       count++;
    }
  }
  console.log(`Found ${count} coins with RSI < 35`);
}
test();
