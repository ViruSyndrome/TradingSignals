'use strict';

class BacktestUI {
  constructor() {
    this.assetSelect = document.getElementById('btAsset');
    this.intervalSelect = document.getElementById('btInterval');
    this.daysInput = document.getElementById('btDays');
    this.runBtn = document.getElementById('runBacktestBtn');
    this.resultsPanel = document.getElementById('btResults');
    this.chartCanvas = document.getElementById('btEquityChart');
    this.winRateEl = document.getElementById('btWinRate');
    this.totalTradesEl = document.getElementById('btTotalTrades');
    this.netReturnEl = document.getElementById('btNetReturn');
    this.resultTitleEl = document.getElementById('btResultTitle');
    this.chart = null;

    if (!this.runBtn) return;

    this._populateAssets();
    this.runBtn.addEventListener('click', () => this.runBacktest());
  }

  _populateAssets() {
    if (!this.assetSelect || typeof CONFIG === 'undefined') return;
    this.assetSelect.innerHTML = '';
    
    const assets = CONFIG.assets.crypto;
    assets.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.symbol})`;
      this.assetSelect.appendChild(opt);
    });
  }

  async runBacktest() {
    this.runBtn.textContent = 'Fetching market data...';
    this.runBtn.disabled = true;
    this.resultsPanel.style.display = 'none';

    try {
      const symbolId = this.assetSelect.value;
      const interval = this.intervalSelect.value;
      const days = parseInt(this.daysInput.value, 10) || 250;
      
      const asset = CONFIG.assets.crypto.find(a => a.id === symbolId);
      if (!asset) throw new Error('Asset not found');

      // Fetch klines
      const klines = await this._fetchKlines(asset.id, interval, days);
      if (klines.length < 50) throw new Error('Not enough historical data.');

      const closes = klines.map(k => k.close);
      const highs = klines.map(k => k.high);
      const lows = klines.map(k => k.low);
      const volumes = klines.map(k => k.volume);
      
      // Simulate fetch of BTC for market regime
      const btcKlines = await this._fetchKlines('BTCUSDT', interval, days);
      const btcCloses = btcKlines.map(k => k.close);

      const results = this._simulate(asset.symbol, closes, highs, lows, volumes, btcCloses);
      
      this._renderResults(results);

    } catch (err) {
      console.error(err);
      alert('Backtest failed: ' + err.message);
    } finally {
      this.runBtn.textContent = 'Run Analysis';
      this.runBtn.disabled = false;
    }
  }

  async _fetchKlines(symbolId, interval, days) {
    const binanceSymbol = symbolId.replace('_4H', '').replace('_5M', '');
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${days + 1}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch data');
    const data = await res.json();
    
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  }

  _simulate(symbol, closes, highs, lows, volumes, btcCloses) {
    let balance = 10000;
    const initialBalance = balance;
    let position = null;
    const trades = [];
    const equityCurve = [];
    
    const feeRate = 0.001; // 0.1%
    const slippage = 0.001; // 0.1%

    for (let i = 50; i < closes.length - 1; i++) {
      const slicedCloses = closes.slice(0, i + 1);
      const slicedHighs = highs.slice(0, i + 1);
      const slicedLows = lows.slice(0, i + 1);
      const slicedVols = volumes.slice(0, i + 1);
      
      // Calculate Market Regime
      let marketRegime = 'flat';
      if (btcCloses.length > i) {
        const btcSliced = btcCloses.slice(0, i + 1);
        const btcSma50Arr = Indicators.sma(btcSliced, 50);
        const btcSma50 = Indicators.last(btcSma50Arr);
        const btcPrice = btcSliced[btcSliced.length - 1];
        if (btcSma50) marketRegime = btcPrice > btcSma50 ? 'bull' : 'bear';
      }

      const result = Signals.generate(slicedCloses, {
        highs: slicedHighs,
        lows: slicedLows,
        volumes: slicedVols,
        symbol: symbol,
        marketRegime
      });

      const todayClose = closes[i];
      const tomorrowOpen = closes[i]; 
      const nextPrice = closes[i+1];
      const costPerSide = feeRate + slippage;

      // Check exits if in position
      if (position) {
        position.holdDays++;
        let exitReason = null;
        let exitPrice = nextPrice;

        const atrArr = Indicators.atr(slicedHighs, slicedLows, slicedCloses, 14);
        const atr = Indicators.last(atrArr) || (todayClose * 0.05);
        const stopPrice = position.entryPrice - (atr * 2.0);
        const tpPrice = position.entryPrice + (atr * 2.0 * 2.0); // 1:2 RRR

        if (lows[i+1] <= stopPrice) {
          exitReason = 'STOP_LOSS';
          exitPrice = stopPrice;
        } else if (highs[i+1] >= tpPrice) {
          exitReason = 'TAKE_PROFIT';
          exitPrice = tpPrice;
        } else if (result.signal === 'SELL' || result.signal === 'STRONG_SELL') {
          exitReason = result.signal;
        } else if (position.holdDays >= 14) {
          exitReason = 'HOLD_LIMIT';
        }

        if (exitReason) {
          const exitValue = position.qty * exitPrice;
          const exitFee = exitValue * costPerSide;
          const net = exitValue - exitFee;
          balance += net;
          
          trades.push({
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            returnPct: (exitPrice - position.entryPrice) / position.entryPrice * 100,
            netReturnPct: (net - position.cost) / position.cost * 100,
            reason: exitReason
          });
          
          position = null;
        }
      }

      // Check entries
      if (!position && (result.signal === 'BUY' || result.signal === 'STRONG_BUY')) {
        const entryFee = balance * costPerSide;
        const investable = balance - entryFee;
        const qty = investable / nextPrice;
        
        position = {
          entryPrice: nextPrice,
          qty: qty,
          cost: balance,
          holdDays: 0
        };
        balance = 0;
      }

      // Record equity
      let currentEquity = balance;
      if (position) {
        currentEquity += (position.qty * nextPrice);
      }
      equityCurve.push({ index: i, equity: currentEquity });
    }

    // Force close open position at the end
    if (position) {
      const finalPrice = closes[closes.length - 1];
      const exitValue = position.qty * finalPrice;
      const net = exitValue - (exitValue * (feeRate + slippage));
      balance += net;
      trades.push({
        entryPrice: position.entryPrice,
        exitPrice: finalPrice,
        returnPct: (finalPrice - position.entryPrice) / position.entryPrice * 100,
        netReturnPct: (net - position.cost) / position.cost * 100,
        reason: 'STILL_OPEN'
      });
    }

    const wins = trades.filter(t => t.netReturnPct > 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const totalReturn = ((balance - initialBalance) / initialBalance) * 100;

    return {
      winRate,
      totalTrades: trades.length,
      netReturn: totalReturn,
      equityCurve
    };
  }

  _renderResults(results) {
    this.resultsPanel.style.display = 'block';
    const assetName = this.assetSelect.options[this.assetSelect.selectedIndex]?.text || 'Selected Asset';
    const interval = this.intervalSelect.options[this.intervalSelect.selectedIndex]?.text || '';
    if (this.resultTitleEl) this.resultTitleEl.textContent = `${assetName} · ${interval}`;
    
    this.winRateEl.textContent = `${results.winRate.toFixed(1)}%`;
    this.totalTradesEl.textContent = results.totalTrades;
    this.netReturnEl.textContent = `${results.netReturn.toFixed(2)}%`;
    this.netReturnEl.style.color = results.netReturn >= 0 ? 'var(--pos)' : 'var(--neg)';

    if (this.chart) this.chart.destroy();

    const labels = results.equityCurve.map(pt => `Day ${pt.index}`);
    const data = results.equityCurve.map(pt => pt.equity);

    this.chart = new Chart(this.chartCanvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Portfolio Equity ($)',
          data: data,
          borderColor: 'rgba(124, 106, 245, 1)',
          backgroundColor: 'rgba(124, 106, 245, 0.1)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: { 
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.5)' }
          },
          x: { 
            grid: { display: false },
            ticks: { display: false }
          }
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.btUI = new BacktestUI();
});
