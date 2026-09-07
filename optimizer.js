const https = require('https');
const fs = require('fs');

function fetchCandles(symbol, interval, limit) {
    return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch(e) { resolve([]); }
            });
        }).on('error', reject);
    });
}

function extractCoinsFromConfig() {
    try {
        const configStr = fs.readFileSync('js/config.js', 'utf8');
        const match = configStr.match(/coreWinners:\s*\[(.*?)\]/s);
        const match2 = configStr.match(/probationWinners:\s*\[(.*?)\]/s);
        
        let coins = [];
        if (match) coins = coins.concat(match[1].match(/'([A-Z]+)'/g).map(s => s.replace(/'/g, '')));
        if (match2) coins = coins.concat(match2[1].match(/'([A-Z]+)'/g).map(s => s.replace(/'/g, '')));
        
        return coins.map(c => c + 'USDT');
    } catch(e) {
        console.log("Could not read config.js, falling back to default basket.");
        return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT'];
    }
}

function calculateEMA(closes, period) {
    let ema = [];
    let k = 2 / (period + 1);
    if (closes.length < period) return closes.map(() => null);

    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let sma = sum / period;
    
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) ema.push(null);
        else if (i === period - 1) ema.push(sma);
        else ema.push(closes[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    let rsi = [];
    let gains = 0, losses = 0;
    for (let i = 0; i < closes.length; i++) {
        if (i < period) {
            if (i > 0) {
                let diff = closes[i] - closes[i - 1];
                if (diff >= 0) gains += diff;
                else losses -= diff;
            }
            rsi.push(null);
            continue;
        }
        if (i === period) {
            gains /= period;
            losses /= period;
        } else {
            let diff = closes[i] - closes[i - 1];
            gains = (gains * (period - 1) + (diff >= 0 ? diff : 0)) / period;
            losses = (losses * (period - 1) + (diff < 0 ? -diff : 0)) / period;
        }
        let rs = gains / (losses === 0 ? 1 : losses);
        rsi.push(100 - (100 / (1 + rs)));
    }
    return rsi;
}

function simulate(closes, emaFast, emaSlow, rsiArray, rsiBuyThreshold, takeProfitPct, maxHoldDays) {
    let position = 0; 
    let entryPrice = 0;
    let balance = 1000; 
    let wins = 0;
    let losses = 0;
    let daysHeld = 0;

    for (let i = 1; i < closes.length; i++) {
        let f1 = emaFast[i-1], s1 = emaSlow[i-1];
        let f0 = emaFast[i], s0 = emaSlow[i];
        let rsi = rsiArray[i];

        if (f0 === null || s0 === null || rsi === null) continue;

        let isGoldenCross = (f1 <= s1 && f0 > s0);
        let isDeathCross = (f1 >= s1 && f0 < s0);

        if (position === 0 && isGoldenCross && rsi < rsiBuyThreshold) {
            position = balance / closes[i];
            entryPrice = closes[i];
            balance = 0;
            daysHeld = 0;
        } 
        else if (position > 0) {
            daysHeld++;
            let currentProfitPct = (closes[i] - entryPrice) / entryPrice;

            if (isDeathCross || currentProfitPct >= takeProfitPct || daysHeld >= maxHoldDays) {
                balance = position * closes[i];
                position = 0;
                if (closes[i] > entryPrice) wins++;
                else losses++;
            }
        }
    }

    if (position > 0) {
        balance = position * closes[closes.length - 1];
        if (closes[closes.length - 1] > entryPrice) wins++;
        else losses++;
    }

    let totalTrades = wins + losses;
    let winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    let netProfit = ((balance - 1000) / 1000) * 100;

    return { netProfit, wins, losses, totalTrades };
}

async function runExitStrategyOptimizer() {
    console.log("🚀 Starting Exit-Strategy Optimizer on ALL Core & Probation Coins...");
    
    const coins = extractCoinsFromConfig();
    
    let marketData = {};
    console.log(`Downloading 1,000 days of history for ${coins.length} coins...`);
    for (let coin of coins) {
        const rawData = await fetchCandles(coin, '1d', 1000);
        marketData[coin] = rawData.map(d => parseFloat(d[4]));
    }
    console.log("✅ Download Complete!\n");
    console.log("🧠 Testing Exit Strategies (Take Profits & Hold Times)...\n");

    const rsiBuyThresholds = [60, 70]; 
    const takeProfitTargets = [0.10, 0.20, 0.50]; 
    const maxHoldTimes = [7, 14, 30]; 

    let results = [];

    for (let rsiBuy of rsiBuyThresholds) {
        for (let tp of takeProfitTargets) {
            for (let hold of maxHoldTimes) {
                
                let totalProfit = 0;
                let totalTrades = 0;
                let totalWins = 0;
                
                for (let coin of coins) {
                    let closes = marketData[coin];
                    if (!closes || closes.length < 21) continue;
                    
                    let emaFastArr = calculateEMA(closes, 9);
                    let emaSlowArr = calculateEMA(closes, 21);
                    let rsiArr = calculateRSI(closes, 14);
                    
                    let stats = simulate(closes, emaFastArr, emaSlowArr, rsiArr, rsiBuy, tp, hold);
                    totalProfit += stats.netProfit;
                    totalTrades += stats.totalTrades;
                    totalWins += stats.wins;
                }
                
                let avgProfitPerCoin = totalProfit / coins.length;
                let overallWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
                
                if (totalTrades > 20) {
                    results.push({ rsiBuy, tp, hold, avgProfitPerCoin, overallWinRate, totalTrades });
                }
            }
        }
    }

    results.sort((a, b) => b.avgProfitPerCoin - a.avgProfitPerCoin);

    console.log("🏆 TOP 3 EXIT STRATEGIES FOR YOUR ENTIRE DASHBOARD:");
    for (let i = 0; i < 3; i++) {
        if (!results[i]) break;
        let r = results[i];
        console.log(`\n#${i+1}: RSI < ${r.rsiBuy} | Take-Profit @ ${(r.tp*100).toFixed(0)}% | Max Hold: ${r.hold} Days`);
        console.log(`   💰 Avg Profit Per Coin: +${r.avgProfitPerCoin.toFixed(2)}%`);
        console.log(`   🎯 Global Win Rate:     ${r.overallWinRate.toFixed(1)}% (${r.totalTrades} total trades)`);
    }
}

runExitStrategyOptimizer();
