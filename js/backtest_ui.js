'use strict';

/**
 * Visual Backtester — aligned with CLI backtest.js:
 * next-bar open fills, frozen ATR stop at entry, fixed % TP, calendar hold limit
 * scaled by candles-per-day, CONFIG.exits fees/slippage.
 */
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
    this.contextEl = document.querySelector('.backtest-context');
    this.chart = null;
    this.CANDLES_PER_DAY = { '1d': 1, '4h': 6, '1h': 24, '15m': 96, '5m': 288 };

    if (!this.runBtn) return;

    this._syncContextLabel();
    this._populateAssets();
    this.runBtn.addEventListener('click', () => this.runBacktest());
    if (this.intervalSelect) {
      this.intervalSelect.addEventListener('change', () => this._syncContextLabel());
    }
  }

  _exitPolicy() {
    const exits = (typeof CONFIG !== 'undefined' && CONFIG.exits) || {};
    return {
      takeProfitPct: exits.takeProfitPct ?? 10,
      holdLimitDays: exits.holdLimitDays ?? CONFIG?.activeParams?.holdLimit ?? 7,
      stopAtrMult: exits.stopAtrMult ?? 2,
      feePerSide: exits.feePerSide ?? 0.001,
      slippagePerSide: exits.slippagePerSide ?? 0.001,
    };
  }

  _syncContextLabel() {
    if (!this.contextEl) return;
    const p = this._exitPolicy();
    const interval = this.intervalSelect?.value || '1d';
    const cpd = this.CANDLES_PER_DAY[interval] || 1;
    const holdBars = p.holdLimitDays * cpd;
    const rt = ((p.feePerSide + p.slippagePerSide) * 2 * 100).toFixed(2);
    const engine = interval === '5m' ? 'Scalp engine' : (interval === '4h' ? 'Moonshot breakout' : 'Daily core');
    this.contextEl.innerHTML = `
      <span>${engine}</span>
      <span>Next-bar open fills</span>
      <span>${rt}% round-trip costs</span>
      <span>${p.takeProfitPct}% TP · ${p.holdLimitDays}d hold (${holdBars} bars @ ${interval})</span>
    `;
  }

  _populateAssets() {
    if (!this.assetSelect || typeof CONFIG === 'undefined') return;
    this.assetSelect.innerHTML = '';
    
    let assets = CONFIG.assets.crypto;
    if (window.Dashboard && window.Dashboard.state && window.Dashboard.state.allAssets) {
      const dashAssets = window.Dashboard.state.allAssets.map(d => d.asset);
      const merged = [...assets];
      dashAssets.forEach(da => {
        if (!merged.find(m => m.id === da.id)) merged.push(da);
      });
      assets = merged;
    }
    assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
    
    assets.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.symbol})`;
      this.assetSelect.appendChild(opt);
    });
  }

  async runBacktest() {
    this._syncContextLabel();
    this.runBtn.textContent = 'Fetching market data...';
    this.runBtn.disabled = true;
    this.resultsPanel.style.display = 'none';

    try {
      const symbolId = this.assetSelect.value;
      const interval = this.intervalSelect.value;
      const days = parseInt(this.daysInput.value, 10) || 250;
      
      let asset = CONFIG.assets.crypto.find(a => a.id === symbolId);
      if (!asset && window.Dashboard && window.Dashboard.state && window.Dashboard.state.allAssets) {
        const da = window.Dashboard.state.allAssets.find(d => d.asset.id === symbolId);
        if (da) asset = da.asset;
      }
      if (!asset) throw new Error('Asset not found');

      const klines = await this._fetchKlines(asset.id, interval, days);
      if (klines.length < 50) throw new Error('Not enough historical data.');

      const opens = klines.map(k => k.open);
      const closes = klines.map(k => k.close);
      const highs = klines.map(k => k.high);
      const lows = klines.map(k => k.low);
      const volumes = klines.map(k => k.volume);
      
      const btcKlines = await this._fetchKlines('BTCUSDT', interval, days);
      const btcCloses = btcKlines.map(k => k.close);

      const results = this._simulate(asset.symbol, opens, closes, highs, lows, volumes, btcCloses, interval);
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
    const multiplier = this.CANDLES_PER_DAY[interval] || 1;
    const limit = Math.min(days * multiplier, 1000);
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch data for ' + binanceSymbol);
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

  _simulate(symbol, opens, closes, highs, lows, volumes, btcCloses, interval = '1d') {
    let balance = 10000;
    const initialBalance = balance;
    let position = null;
    const trades = [];
    const equityCurve = [];
    const policy = this._exitPolicy();
    const costPerSide = policy.feePerSide + policy.slippagePerSide;
    const tpMult = 1 + (policy.takeProfitPct / 100);
    const candlesPerDay = this.CANDLES_PER_DAY[interval] || 1;
    const holdLimitBars = Math.max(1, policy.holdLimitDays * candlesPerDay);

    for (let i = 50; i < closes.length - 1; i++) {
      const slicedCloses = closes.slice(0, i + 1);
      const slicedHighs = highs.slice(0, i + 1);
      const slicedLows = lows.slice(0, i + 1);
      const slicedVols = volumes.slice(0, i + 1);
      
      let marketRegime = 'flat';
      if (btcCloses.length > i) {
        const btcSliced = btcCloses.slice(0, i + 1);
        const btcSma50Arr = Indicators.sma(btcSliced, 50);
        const btcSma50 = Indicators.last(btcSma50Arr);
        const btcPrice = btcSliced[btcSliced.length - 1];
        if (btcSma50) marketRegime = btcPrice > btcSma50 ? 'bull' : 'bear';
      }

      const result = interval === '5m'
        ? Signals.generateScalp(slicedCloses, {
            highs: slicedHighs,
            lows: slicedLows,
            volumes: slicedVols,
            symbol: symbol,
            marketRegime,
          })
        : interval === '4h'
        ? Signals.generateBreakout(slicedCloses, {
            highs: slicedHighs,
            lows: slicedLows,
            volumes: slicedVols,
            symbol: symbol,
            marketRegime,
          })
        : Signals.generate(slicedCloses, {
            highs: slicedHighs,
            lows: slicedLows,
            volumes: slicedVols,
            symbol: symbol,
            marketRegime,
            ignoreWinnersFilter: true
          });

      // Next-bar execution (matches CLI): signal on bar i close, fill at bar i+1 open
      const nextOpen = opens[i + 1];
      if (!Number.isFinite(nextOpen) || nextOpen <= 0) {
        equityCurve.push({ index: i, equity: position ? position.qty * closes[i] : balance });
        continue;
      }

      if (position) {
        position.holdBars++;
        let exitReason = null;

        // Trigger on current bar's range (same spirit as CLI), fill at next open
        if (position.stopLoss && lows[i] <= position.stopLoss) {
          exitReason = 'STOP_LOSS';
        } else if (position.takeProfit && highs[i] >= position.takeProfit) {
          exitReason = 'TAKE_PROFIT';
        } else if (result.signal === 'SELL' || result.signal === 'STRONG_SELL') {
          exitReason = result.signal;
        } else if (position.holdBars >= holdLimitBars) {
          exitReason = 'HOLD_LIMIT';
        }

        if (exitReason) {
          const exitPrice = nextOpen; // CLI always fills exits at next open
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

      if (!position && (result.signal === 'BUY' || result.signal === 'STRONG_BUY')) {
        const entryFee = balance * costPerSide;
        const investable = balance - entryFee;
        const qty = investable / nextOpen;
        const atrArr = Indicators.atr(slicedHighs, slicedLows, slicedCloses, 14);
        const atr = Indicators.last(atrArr) || (closes[i] * 0.05);
        // Freeze stop + TP at entry (matches CLI)
        const stopLoss = nextOpen - (atr * policy.stopAtrMult);
        const takeProfit = nextOpen * tpMult;
        
        position = {
          entryPrice: nextOpen,
          qty: qty,
          cost: balance,
          holdBars: 0,
          stopLoss,
          takeProfit
        };
        balance = 0;
      }

      let currentEquity = balance;
      if (position) currentEquity += (position.qty * closes[i]);
      equityCurve.push({ index: i, equity: currentEquity });
    }

    if (position) {
      const finalPrice = closes[closes.length - 1];
      const exitValue = position.qty * finalPrice;
      const net = exitValue - (exitValue * costPerSide);
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
      equityCurve,
      policy
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

    const labels = results.equityCurve.map(pt => `Bar ${pt.index}`);
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
