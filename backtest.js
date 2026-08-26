'use strict';

/**
 * backtest.js — Historical signal backtester
 * 
 * Replays 250 days of Binance OHLCV data for each tracked crypto asset.
 * At each day, generates the signal using the same engine as the live dashboard.
 * Simulates trades: enters on BUY/STRONG_BUY, exits on SELL/STRONG_SELL or stop-loss.
 * Outputs a real win rate and average return per signal type.
 *
 * Usage: node backtest.js
 */

const fs         = require('fs');
const path       = require('path');
const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');

// Signals.js references Indicators as a global (browser pattern).
// Make it available globally for Node.js as well.
global.CONFIG = CONFIG;
global.Indicators = Indicators;

// ─── Configuration ─────────────────────────────────────────────────────────────
const MIN_HISTORY  = 50;   // Minimum days of data before generating first signal
const HOLD_LIMIT   = 14;   // Max days to hold if no exit signal fires
const STOP_MULT    = 2.0;  // ATR multiplier for stop-loss (same as live dashboard)
const RRR          = 2.0;  // Take-profit at 2× risk (matches the 1:2 RRR education)
const FEE_RATE     = 0.001; // 0.1% entry + 0.1% exit (taker-style)
const SLIPPAGE     = 0.001; // 0.1% entry + 0.1% exit execution friction

const WALK_FORWARD_TRAIN_END_DAY = 149; // Days 0-149 train
const WALK_FORWARD_TEST_START_DAY = 150; // Days 150-249 test

function parseArgs() {
  const args = process.argv.slice(2);
  const walkForward = args.includes('--walk-forward');
  const walkForwardRolling = args.includes('--walk-forward-rolling');
  const costSweep = args.includes('--cost-sweep');
  const intervalArg = args.find(a => a.startsWith('--interval='));
  const interval = intervalArg ? intervalArg.split('=')[1] : '1d';
  const moonshots = args.includes('--moonshots');
  const useTrailingExit = args.includes('--exit=trailing') || moonshots;
  return { walkForward, walkForwardRolling, costSweep, interval, moonshots, useTrailingExit };
}

const PARSED_ARGS = parseArgs();
const INTERVAL = PARSED_ARGS.interval;

function getCostScenarios(useSweep) {
  if (!useSweep) {
    return [{ label: 'Base 0.40% RT', feeRate: FEE_RATE, slippage: SLIPPAGE }];
  }

  // Round-trip cost targets: 0.20%, 0.40%, 0.60%.
  // With symmetric fee/slippage and two sides, rt = 2 * (fee + slip) = 4x.
  const mk = (rtPct) => {
    const x = rtPct / 4;
    return {
      label: `${(rtPct * 100).toFixed(2)}% RT`,
      feeRate: x,
      slippage: x,
    };
  };

  return [mk(0.002), mk(0.004), mk(0.006)];
}

function getRollingWindows() {
  // Three overlapping windows: 120-day train, 60-day test (signal days).
  return [
    { name: 'W1', trainStart: MIN_HISTORY, trainEnd: 129, testStart: 130, testEnd: 189 },
    { name: 'W2', trainStart: MIN_HISTORY, trainEnd: 159, testStart: 160, testEnd: 219 },
    { name: 'W3', trainStart: MIN_HISTORY, trainEnd: 189, testStart: 190, testEnd: 248 },
  ];
}

// ─── Fetch historical data from Binance ────────────────────────────────────────
async function fetchHistory(symbol, days = 250) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${days}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`No data for ${symbol}`);
  const closedData = data.length > 1 ? data.slice(0, -1) : data;
  return {
    opens:      closedData.map(r => parseFloat(r[1])),
    highs:      closedData.map(r => parseFloat(r[2])),
    lows:       closedData.map(r => parseFloat(r[3])),
    closes:     closedData.map(r => parseFloat(r[4])),
    volumes:    closedData.map(r => parseFloat(r[5])),
    timestamps: closedData.map(r => r[0]),
  };
}

// ─── Fetch historical Fear & Greed Index ───────────────────────────────────────
// Returns a Map<dateString, { value, classification }> keyed by 'YYYY-MM-DD'
async function fetchFearGreedHistory(days = 250) {
  const url = `https://api.alternative.me/fng/?limit=${days}&format=json`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (!json || !json.data || json.data.length === 0) {
      console.log('  [WARN] Fear & Greed API returned no data. Regime analysis will be skipped.');
      return null;
    }
    const map = new Map();
    for (const entry of json.data) {
      const date = new Date(parseInt(entry.timestamp) * 1000);
      const key = date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
      map.set(key, {
        value: parseInt(entry.value),
        classification: entry.value_classification,
      });
    }
    console.log(`  [F&G] Fetched ${map.size} days of Fear & Greed history`);
    return map;
  } catch (e) {
    console.log(`  [WARN] Failed to fetch Fear & Greed history: ${e.message}`);
    return null;
  }
}

// ─── Classify F&G value into regime bucket ─────────────────────────────────────
const FG_REGIMES = [
  { name: 'extreme_fear',  min: 0,  max: 24, label: 'Extreme Fear (0-24)' },
  { name: 'fear',          min: 25, max: 44, label: 'Fear (25-44)' },
  { name: 'neutral',       min: 45, max: 55, label: 'Neutral (45-55)' },
  { name: 'greed',         min: 56, max: 74, label: 'Greed (56-74)' },
  { name: 'extreme_greed', min: 75, max: 100, label: 'Extreme Greed (75-100)' },
];

function classifyFG(value) {
  if (value == null || isNaN(value)) return 'unknown';
  for (const r of FG_REGIMES) {
    if (value >= r.min && value <= r.max) return r.name;
  }
  return 'unknown';
}

// Look up F&G value for a given Binance candle timestamp (ms)
function getFGForTimestamp(fgMap, timestampMs) {
  if (!fgMap) return null;
  const key = new Date(timestampMs).toISOString().slice(0, 10);
  const entry = fgMap.get(key);
  return entry ? entry.value : null;
}

function backtestSymbol(asset, ohlcv, btcHistory, windowDef, feeRate, slippage, useTrailingExit) {
  const { closes, highs, lows, volumes } = ohlcv;
  let position = null;
  const trades = [];

  const startDay = windowDef.trainStart;
  const endDay = windowDef.testEnd;

  for (let i = startDay; i <= endDay; i++) {
    // ─── DAILY RECALCULATION (avoid look-ahead bias) ──────────────────────────
    const slicedCloses = closes.slice(0, i + 1);
    const slicedHighs  = highs ? highs.slice(0, i + 1) : undefined;
    const slicedLows   = lows ? lows.slice(0, i + 1) : undefined;
    const slicedVols   = volumes ? volumes.slice(0, i + 1) : undefined;

    let marketRegime = 'flat';
    if (btcHistory && btcHistory.closes && i < btcHistory.closes.length) {
      const btcSlicedCloses = btcHistory.closes.slice(0, i + 1);
      if (btcSlicedCloses.length >= 50) {
        const btcSma50Arr = Indicators.sma(btcSlicedCloses, 50);
        const btcSma50 = Indicators.last(btcSma50Arr);
        const btcPrice = btcSlicedCloses[btcSlicedCloses.length - 1];
        if (btcSma50) marketRegime = btcPrice > btcSma50 ? 'bull' : 'bear';
      }
    }

    const result = useTrailingExit
      ? Signals.generateBreakout(slicedCloses, { 
          highs: slicedHighs, 
          lows: slicedLows, 
          volumes: slicedVols, 
          symbol: asset.symbol,
          marketRegime
        })
      : Signals.generate(slicedCloses, { 
          highs: slicedHighs, 
          lows: slicedLows, 
          volumes: slicedVols, 
          symbol: asset.symbol,
          marketRegime
        });

    const price = closes[i];
    const sig   = result.signal;
    const nextOpenDay = i + 1;
    const costPerSide = feeRate + slippage;

    // EXIT LOGIC
    if (position) {
      const holdDays = i - position.entryDay;
      let exitReason = null;
      
      if (highs && highs[i] > position.maxPriceSeen) position.maxPriceSeen = highs[i];

      if (useTrailingExit) {
        const chandExit = Indicators.last(Indicators.chandelierExit(slicedHighs, slicedLows, slicedCloses, 22, 3));
        if (chandExit && (!position.stopLoss || chandExit > position.stopLoss)) {
          position.stopLoss = chandExit; // Ratchet up
        }
        if (position.riskDistance && position.maxPriceSeen >= position.entryPrice + position.riskDistance) {
          position.stopLoss = Math.max(position.stopLoss || 0, position.entryPrice);
        }
      }

      if (position.stopLoss && lows && lows[i] <= position.stopLoss) exitReason = 'STOP_LOSS';
      else if (position.takeProfit && highs && highs[i] >= position.takeProfit) exitReason = 'TAKE_PROFIT';
      else if (sig === 'SELL' || sig === 'STRONG_SELL') exitReason = sig;
      else if (!useTrailingExit && holdDays >= HOLD_LIMIT) exitReason = 'HOLD_LIMIT';

      if (exitReason) {
        const rawExit = ohlcv.opens[nextOpenDay];
        if (rawExit) {
          const grossReturnPct = ((rawExit - position.entryPrice) / position.entryPrice) * 100;
          const netEntry = position.entryPrice * (1 + costPerSide);
          const netExit = rawExit * (1 - costPerSide);
          const returnPct = ((netExit - netEntry) / netEntry) * 100;
          const maxExcursionPct = ((position.maxPriceSeen - position.entryPrice) / position.entryPrice) * 100;
          trades.push({ ...position, entrySignal: position.signal, entryScore: position.score, entryConf: position.confidence, exitPrice: rawExit, exitReason, grossReturnPct, returnPct, maxExcursionPct, win: returnPct > 0, holdDays });
          position = null;
        }
      }
    }

    // ENTRY LOGIC
    if (!position && (sig === 'BUY' || sig === 'STRONG_BUY')) {
      const entryPrice = ohlcv.opens[nextOpenDay];
      if (entryPrice) {
        const atrArr = Indicators.atr(slicedHighs, slicedLows, slicedCloses, 14);
        const atr = atrArr ? Indicators.last(atrArr) : null;
        position = { 
          entryPrice, entryDay: nextOpenDay, signal: sig, score: result.score, confidence: result.confidence,
          stopLoss: atr ? entryPrice - (atr * STOP_MULT) : null,
          takeProfit: atr ? entryPrice + (atr * RRR) : null,
          riskDistance: atr ? atr * STOP_MULT : null,
          maxPriceSeen: entryPrice,
          entryRegime: marketRegime
        };
      }
    }
  }
  return trades;
}

// ─── Run backtest on a single asset ────────────────────────────────────────────
function backtestAsset(name, symbol, ohlcv, opts = {}) {
  const { opens, closes, highs, lows, volumes, timestamps } = ohlcv;
  const {
    startDay = MIN_HISTORY,
    endDay = closes.length - 2,
    feeRate = FEE_RATE,
    slippage = SLIPPAGE,
    ignoreWinnersFilter = true,
    fgMap = null,
  } = opts;

  const costPerSide = feeRate + slippage;
  const trades = [];
  let position = null; // { entryPrice, entryDay, signal, stopLoss, takeProfit }

  const firstDay = Math.max(MIN_HISTORY, startDay);
  const lastSignalDay = Math.min(endDay, closes.length - 2);

  function closePosition(exitExecDay, exitReason) {
    if (!position) return;
    const rawExit = opens[exitExecDay];
    if (!isFinite(rawExit) || rawExit <= 0) return;

    const grossReturnPct = ((rawExit - position.entryPrice) / position.entryPrice) * 100;
    const netEntry = position.entryPrice * (1 + costPerSide);
    const netExit = rawExit * (1 - costPerSide);
    const returnPct = ((netExit - netEntry) / netEntry) * 100;

    trades.push({
      entrySignal: position.signal,
      entryScore: position.score,
      entryConf: position.confidence,
      entryPrice: position.entryPrice,
      exitPrice: rawExit,
      exitReason,
      holdDays: exitExecDay - position.entryDay,
      grossReturnPct,
      returnPct,
      win: returnPct > 0,
      entryFG: position.entryFG,
      entryFGRegime: position.entryFGRegime,
    });

    position = null;
  }

  for (let day = firstDay; day <= lastSignalDay; day++) {
    // Generate signal using data up to (and including) this day
    const slicedCloses  = closes.slice(0, day + 1);
    const slicedHighs   = highs.slice(0, day + 1);
    const slicedLows    = lows.slice(0, day + 1);
    const slicedVolumes = volumes.slice(0, day + 1);

    // Look up Fear & Greed for this day
    const dayFG = timestamps ? getFGForTimestamp(fgMap, timestamps[day]) : null;

    const result = Signals.generate(slicedCloses, {
      highs: slicedHighs,
      lows: slicedLows,
      volumes: slicedVolumes,
      symbol,
      ignoreWinnersFilter,
      fearGreed: dayFG,  // Now the backtest uses the SAME F&G gate as the live engine
    });

    const price = closes[day];
    const sig   = result.signal;
    const conf  = result.confidence ?? 0;
    const score = result.score ?? 0;
    const nextOpenDay = day + 1;

    // ─── EXIT LOGIC (trigger on today's info, execute next-day open) ───────────
    if (position) {
      const holdDays = day - position.entryDay;
      let exitReason = null;

      // Stop-loss hit intraday
      if (position.stopLoss && lows[day] <= position.stopLoss) {
        exitReason = 'STOP_LOSS';
      }
      // Take-profit hit intraday (2R)
      else if (position.takeProfit && highs[day] >= position.takeProfit) {
        exitReason = 'TAKE_PROFIT';
      }
      // Signal flipped to sell
      else if (sig === 'SELL' || sig === 'STRONG_SELL') {
        exitReason = sig;
      }
      // Held too long without a signal
      else if (holdDays >= HOLD_LIMIT) {
        exitReason = 'HOLD_LIMIT';
      }

      if (exitReason) {
        closePosition(nextOpenDay, exitReason);
      }
    }

    // ─── ENTRY LOGIC (signal on close, execute next-day open) ──────────────────
    if (!position && (sig === 'BUY' || sig === 'STRONG_BUY')) {
      const entryPrice = opens[nextOpenDay];
      if (!isFinite(entryPrice) || entryPrice <= 0) continue;

      // Calculate ATR for stop-loss (atr() returns an array — take the last value)
      const atrArr = Indicators.atr(slicedHighs, slicedLows, slicedCloses, 14);
      const atr = atrArr ? Indicators.last(atrArr) : null;
      const riskDistance = atr ? atr * STOP_MULT : null;
      const stopLoss   = riskDistance ? entryPrice - riskDistance : null;
      const takeProfit = riskDistance ? entryPrice + (riskDistance * RRR) : null;

      position = {
        entryPrice,
        entryDay: nextOpenDay,
        signal: sig,
        score,
        confidence: conf,
        stopLoss,
        takeProfit,
        entryFG: dayFG,
        entryFGRegime: classifyFG(dayFG),
      };
    }
  }

  // Close any open position at the final close (end-of-backtest liquidation)
  if (position) {
    const price = closes[closes.length - 1];
    const grossReturnPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    const netEntry = position.entryPrice * (1 + costPerSide);
    const netExit = price * (1 - costPerSide);
    const returnPct = ((netExit - netEntry) / netEntry) * 100;
    trades.push({
      entrySignal: position.signal,
      entryScore: position.score,
      entryConf: position.confidence,
      entryPrice: position.entryPrice,
      exitPrice: price,
      exitReason: 'STILL_OPEN',
      holdDays: closes.length - 1 - position.entryDay,
      grossReturnPct,
      returnPct,
      win: returnPct > 0,
      entryFG: position.entryFG,
      entryFGRegime: position.entryFGRegime,
    });
  }

  return trades;
}

// ─── Aggregate statistics ──────────────────────────────────────────────────────
function computeStats(trades, returnField = 'returnPct') {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const returns = trades.map(t => t[returnField]);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const maxReturn = Math.max(...returns);
  const minReturn = Math.min(...returns);
  const avgHold   = trades.reduce((a, t) => a + t.holdDays, 0) / trades.length;

  // Breakdown by entry signal
  const bySignal = {};
  for (const t of trades) {
    if (!bySignal[t.entrySignal]) bySignal[t.entrySignal] = [];
    bySignal[t.entrySignal].push(t);
  }

  const signalStats = {};
  for (const [sig, sigTrades] of Object.entries(bySignal)) {
    const sigWins = sigTrades.filter(t => t.win);
    const sigReturns = sigTrades.map(t => t[returnField]);
    signalStats[sig] = {
      trades:    sigTrades.length,
      winRate:   ((sigWins.length / sigTrades.length) * 100).toFixed(1) + '%',
      avgReturn: (sigReturns.reduce((a, b) => a + b, 0) / sigReturns.length).toFixed(2) + '%',
      bestTrade: Math.max(...sigReturns).toFixed(2) + '%',
      worstTrade: Math.min(...sigReturns).toFixed(2) + '%',
    };
  }

  // Breakdown by exit reason
  const byExit = {};
  for (const t of trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = 0;
    byExit[t.exitReason]++;
  }

  // High confidence vs low confidence
  const highConf = trades.filter(t => t.entryConf >= 75);
  const lowConf  = trades.filter(t => t.entryConf < 75);
  
  const reached10 = trades.filter(t => t.maxExcursionPct >= 10).length;
  const reached20 = trades.filter(t => t.maxExcursionPct >= 20).length;
  const reached30 = trades.filter(t => t.maxExcursionPct >= 30).length;

  // Breakdown by F&G Regime
  const byRegime = {};
  for (const t of trades) {
    const regime = t.entryFGRegime || 'unknown';
    if (!byRegime[regime]) byRegime[regime] = [];
    byRegime[regime].push(t);
  }

  const regimeStats = {};
  for (const [r, rTrades] of Object.entries(byRegime)) {
    const rWins = rTrades.filter(t => t.win);
    const rReturns = rTrades.map(t => t[returnField]);
    regimeStats[r] = {
      trades: rTrades.length,
      winRate: ((rWins.length / rTrades.length) * 100).toFixed(1) + '%',
      avgReturn: (rReturns.reduce((a, b) => a + b, 0) / rReturns.length).toFixed(2) + '%'
    };
  }

  return {
    totalTrades: trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     ((wins.length / trades.length) * 100).toFixed(1) + '%',
    avgReturn:   avgReturn.toFixed(2) + '%',
    maxReturn:   maxReturn.toFixed(2) + '%',
    minReturn:   minReturn.toFixed(2) + '%',
    avgHoldDays: avgHold.toFixed(1),
    reached10:   ((reached10 / trades.length) * 100).toFixed(1) + '%',
    reached20:   ((reached20 / trades.length) * 100).toFixed(1) + '%',
    reached30:   ((reached30 / trades.length) * 100).toFixed(1) + '%',
    bySignal:    signalStats,
    byExit,
    byRegime:    regimeStats,
    highConfidence: highConf.length > 0 ? {
      trades:   highConf.length,
      winRate:  ((highConf.filter(t => t.win).length / highConf.length) * 100).toFixed(1) + '%',
      avgReturn: (highConf.map(t => t[returnField]).reduce((a, b) => a + b, 0) / highConf.length).toFixed(2) + '%',
    } : 'No trades with >= 75% confidence',
    lowConfidence: lowConf.length > 0 ? {
      trades:   lowConf.length,
      winRate:  ((lowConf.filter(t => t.win).length / lowConf.length) * 100).toFixed(1) + '%',
      avgReturn: (lowConf.map(t => t[returnField]).reduce((a, b) => a + b, 0) / lowConf.length).toFixed(2) + '%',
    } : 'No trades with < 75% confidence',
  };
}

function summarizeAssetTrades(symbol, trades) {
  const wins = trades.filter(t => t.win).length;
  const wr = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(0) : '0';
  const avg = trades.length > 0
    ? (trades.map(t => t.returnPct).reduce((a, b) => a + b, 0) / trades.length).toFixed(2)
    : '0.00';
  return { symbol, trades: trades.length, winRate: wr, avgReturn: avg };
}

function printBySignalBlock(title, stats) {
  console.log(`\n${title}`);
  if (!stats || !stats.bySignal || Object.keys(stats.bySignal).length === 0) {
    console.log('  No trades generated.');
    return;
  }
  for (const [sig, s] of Object.entries(stats.bySignal)) {
    console.log(`  ${sig.padEnd(14)} | ${s.trades} trades | Win: ${s.winRate} | Avg: ${s.avgReturn} | Best: ${s.bestTrade} | Worst: ${s.worstTrade}`);
  }
}

function selectWinnersFromTraining(assetResults) {
  // Require at least 3 trades to reduce one-hit wonder noise.
  return assetResults
    .filter(r => r.trades >= 3 && parseFloat(r.avgReturn) > 0)
    .map(r => r.symbol);
}

function printStatsBlock(title, statsNet, statsGross) {
  console.log(`\n${title}`);
  if (!statsNet) {
    console.log('  No trades generated.');
    return;
  }
  console.log(`  Total Trades:     ${statsNet.totalTrades}`);
  console.log(`  Wins / Losses:    ${statsNet.wins} / ${statsNet.losses}`);
  console.log(`  Win Rate:         ${statsNet.winRate}`);
  console.log(`  Avg Return (Net): ${statsNet.avgReturn}`);
  if (statsGross) console.log(`  Avg Return (Gross): ${statsGross.avgReturn}`);
  console.log(`  Best Trade (Net): ${statsNet.maxReturn}`);
  console.log(`  Worst Trade (Net): ${statsNet.minReturn}`);
  console.log(`  Avg Hold (days):  ${statsNet.avgHoldDays}`);
  if (statsNet.reached10) {
    console.log(`  MFE +10% Hit Rate: ${statsNet.reached10}`);
    console.log(`  MFE +20% Hit Rate: ${statsNet.reached20}`);
    console.log(`  MFE +30% Hit Rate: ${statsNet.reached30}`);
  }
}

function printCostLine(feeRate, slippage) {
  const costRoundTripPct = ((feeRate + slippage) * 2 * 100).toFixed(2);
  console.log(`  Costs: ${(feeRate * 100).toFixed(2)}% fee + ${(slippage * 100).toFixed(2)}% slippage per side (${costRoundTripPct}% round-trip)`);
}

async function runMoonshotBacktest(histories, assets, feeRate, slippage) {
  const btcHistory = histories.BTC;
  const trades = [];
  const assetResults = [];
  console.log('\n─── Moonshot Breakout Results (closed 4H candles) ─────────────');
  for (const asset of assets) {
    const ohlcv = histories[asset.symbol];
    if (!ohlcv || ohlcv.closes.length < 80) continue;
    const assetTrades = backtestSymbol(asset, ohlcv, btcHistory, {
      trainStart: MIN_HISTORY,
      testEnd: ohlcv.closes.length - 2,
    }, feeRate, slippage, true);
    assetTrades.forEach(t => { t.symbol = asset.symbol; });
    trades.push(...assetTrades);
    const summary = summarizeAssetTrades(asset.symbol, assetTrades);
    assetResults.push(summary);
    if (assetTrades.length) console.log(`  ${asset.symbol.padEnd(8)} | ${summary.trades} trades | Win: ${summary.winRate}% | Avg: ${summary.avgReturn}%`);
  }

  const stats = computeStats(trades, 'returnPct');
  if (!stats) {
    console.log('  No Moonshot trades generated.');
    return;
  }
  printStatsBlock('Moonshot Aggregate', stats, computeStats(trades, 'grossReturnPct'));
  printBySignalBlock('Moonshot By Entry Signal', stats);
  console.log('\n  Moonshot By Market Regime');
  for (const regime of ['bull', 'flat', 'bear']) {
    const regimeTrades = trades.filter(t => t.entryRegime === regime);
    const regimeStats = computeStats(regimeTrades, 'returnPct');
    if (regimeStats) console.log(`  ${regime.padEnd(8)} | ${regimeStats.totalTrades} trades | Win: ${regimeStats.winRate} | Avg: ${regimeStats.avgReturn}`);
  }
  assetResults.sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));
  console.log('\n  Moonshot Asset Leaderboard');
  assetResults.forEach(r => console.log(`  ${parseFloat(r.avgReturn) >= 0 ? '🟢' : '🔴'} ${r.symbol.padEnd(8)} | ${r.trades} trades | Win: ${r.winRate}% | Avg: ${r.avgReturn}%`));
}

function runWalkForwardWindow(histories, assets, windowDef, feeRate, slippage) {
  const trainAssetResults = [];
  const trainTrades = [];
  const btcHistory = histories['BTC'];

  console.log(`─── ${windowDef.name} Train: days ${windowDef.trainStart}-${windowDef.trainEnd} (all assets) ─`);
  for (const asset of assets) {
    const ohlcv = histories[asset.symbol];
    if (!ohlcv || ohlcv.closes.length < MIN_HISTORY) continue;
    process.stdout.write(`Train ${asset.symbol.padEnd(8)}...`);
    const trades = backtestSymbol(asset, ohlcv, btcHistory, {
      trainStart: windowDef.trainStart,
      testEnd: windowDef.trainEnd
    }, feeRate, slippage, PARSED_ARGS.useTrailingExit);
    trades.forEach(t => { t.symbol = asset.symbol; });
    trainTrades.push(...trades);
    const summary = summarizeAssetTrades(asset.symbol, trades);
    trainAssetResults.push(summary);
    console.log(` ${summary.trades} trades | Win rate: ${summary.winRate}% | Avg return (net): ${summary.avgReturn}%`);
  }

  const selectedWinners = selectWinnersFromTraining(trainAssetResults);
  console.log(`Selected Winners: ${selectedWinners.join(', ') || 'None'}`);

  const testTrades = [];
  const testAssetResults = [];
  console.log(`─── ${windowDef.name} Test: days ${windowDef.testStart}-${windowDef.testEnd} (selected winners) ─`);
  for (const asset of assets.filter(a => selectedWinners.includes(a.symbol))) {
    const ohlcv = histories[asset.symbol];
    if (!ohlcv) continue;
    process.stdout.write(`Test  ${asset.symbol.padEnd(8)}...`);
    const trades = backtestSymbol(asset, ohlcv, btcHistory, {
      trainStart: windowDef.testStart,
      testEnd: Math.min(windowDef.testEnd, ohlcv.closes.length - 2),
    }, feeRate, slippage, PARSED_ARGS.useTrailingExit);
    trades.forEach(t => { t.symbol = asset.symbol; });
    testTrades.push(...trades);
    const summary = summarizeAssetTrades(asset.symbol, trades);
    testAssetResults.push(summary);
    console.log(` ${summary.trades} trades | Win rate: ${summary.winRate}% | Avg return (net): ${summary.avgReturn}%`);
  }

  return {
    windowDef,
    selectedWinners,
    trainTrades,
    testTrades,
    trainNet: computeStats(trainTrades, 'returnPct'),
    trainGross: computeStats(trainTrades, 'grossReturnPct'),
    testNet: computeStats(testTrades, 'returnPct'),
    testGross: computeStats(testTrades, 'grossReturnPct'),
    testAssetResults,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const scenarios = getCostScenarios(args.costSweep);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  📊 TRADING SIGNALS BACKTESTER');
  console.log('  Replaying 250 days of history against your signal engine');
  console.log('  Entry: BUY/STRONG_BUY signal at close, fill at next-day open');
  console.log('  Exit trigger: SELL/STRONG_SELL/SL/TP/HOLD on day N, fill at day N+1 open');
  if (args.moonshots) {
    console.log('  Mode: Moonshot breakout validation on closed 4H candles');
  }
  if (args.walkForward) {
    console.log('  Mode: Walk-Forward (Train days 0-149, Test days 150-249)');
  } else if (args.walkForwardRolling) {
    console.log('  Mode: Rolling Walk-Forward (3 windows: 120-day train, 60-day test)');
  }
  if (args.costSweep) {
    console.log('  Cost Sweep: 0.20% / 0.40% / 0.60% round-trip');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  const histories = {};
  for (const asset of CONFIG.assets.crypto) {
    try {
      histories[asset.symbol] = await fetchHistory(asset.id, 250);
    } catch (e) {
      console.log(`Failed to fetch ${asset.symbol}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  
  const fgMap = await fetchFearGreedHistory(250);

  if (args.moonshots) {
    for (const scenario of scenarios) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log(`  Moonshot Scenario: ${scenario.label}`);
      printCostLine(scenario.feeRate, scenario.slippage);
      console.log('═══════════════════════════════════════════════════════════════');
      await runMoonshotBacktest(histories, CONFIG.assets.crypto, scenario.feeRate, scenario.slippage);
    }
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Moonshot validation complete.');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return;
  }

  if (args.walkForward || args.walkForwardRolling) {
    for (const scenario of scenarios) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log(`  Scenario: ${scenario.label}`);
      printCostLine(scenario.feeRate, scenario.slippage);
      console.log('═══════════════════════════════════════════════════════════════');

      const windows = args.walkForwardRolling
        ? getRollingWindows()
        : [{ name: 'WF', trainStart: MIN_HISTORY, trainEnd: WALK_FORWARD_TRAIN_END_DAY, testStart: WALK_FORWARD_TEST_START_DAY, testEnd: 248 }];

      const allTestTrades = [];
      const allTrainTrades = [];

      for (const w of windows) {
        const result = runWalkForwardWindow(histories, CONFIG.assets.crypto, w, scenario.feeRate, scenario.slippage);
        allTrainTrades.push(...result.trainTrades);
        allTestTrades.push(...result.testTrades);

        console.log('\n  Window Summary:');
        printStatsBlock(`  ${w.name} Train`, result.trainNet, result.trainGross);
        printStatsBlock(`  ${w.name} Test`, result.testNet, result.testGross);
      }

      const combinedTrainNet = computeStats(allTrainTrades, 'returnPct');
      const combinedTrainGross = computeStats(allTrainTrades, 'grossReturnPct');
      const combinedTestNet = computeStats(allTestTrades, 'returnPct');
      const combinedTestGross = computeStats(allTestTrades, 'grossReturnPct');

      console.log('\n─── Combined Walk-Forward Summary ─────────────────────────────');
      printStatsBlock('Combined Train (all windows)', combinedTrainNet, combinedTrainGross);
      printStatsBlock('Combined Test (all windows)', combinedTestNet, combinedTestGross);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Walk-forward complete.');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return;
  }

  for (const scenario of scenarios) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  Scenario: ${scenario.label}`);
    printCostLine(scenario.feeRate, scenario.slippage);
    console.log('═══════════════════════════════════════════════════════════════');

    const allTrades = [];
    const assetResults = [];

    for (const asset of CONFIG.assets.crypto) {
      const ohlcv = histories[asset.symbol];
      if (!ohlcv) {
        console.log(`Scanning ${asset.symbol.padEnd(8)}... ERROR: missing history`);
        continue;
      }
      try {
        process.stdout.write(`Scanning ${asset.symbol.padEnd(8)}...`);
        const trades = backtestAsset(asset.name, asset.symbol, ohlcv, {
          feeRate: scenario.feeRate,
          slippage: scenario.slippage,
          fgMap,
        });
        trades.forEach(t => { t.symbol = asset.symbol; });
        allTrades.push(...trades);

        const summary = summarizeAssetTrades(asset.symbol, trades);
        assetResults.push(summary);
        console.log(` ${summary.trades} trades | Win rate: ${summary.winRate}% | Avg return (net): ${summary.avgReturn}%`);

      } catch (e) {
        console.log(` ERROR: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200)); // Rate limit
    }

    // ─── OVERALL RESULTS ───────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  📈 OVERALL RESULTS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const statsNet = computeStats(allTrades, 'returnPct');
    const statsGross = computeStats(allTrades, 'grossReturnPct');
    if (!statsNet) {
      console.log('No trades generated. Check your signal thresholds.');
      continue;
    }

    console.log(`  Total Trades:      ${statsNet.totalTrades}`);
    console.log(`  Wins / Losses:     ${statsNet.wins} / ${statsNet.losses}`);
    console.log(`  Win Rate:          ${statsNet.winRate}`);
    console.log(`  Avg Return (Net):  ${statsNet.avgReturn}`);
    console.log(`  Avg Return (Gross):${statsGross ? ' ' + statsGross.avgReturn : ' n/a'}`);
    console.log(`  Best Trade (Net):  ${statsNet.maxReturn}`);
    console.log(`  Worst Trade (Net): ${statsNet.minReturn}`);
    console.log(`  Avg Hold (days):   ${statsNet.avgHoldDays}`);

    console.log('\n─── By Entry Signal ───────────────────────────────────────────');
    for (const [sig, s] of Object.entries(statsNet.bySignal)) {
      console.log(`  ${sig.padEnd(14)} | ${s.trades} trades | Win: ${s.winRate} | Avg: ${s.avgReturn} | Best: ${s.bestTrade} | Worst: ${s.worstTrade}`);
    }

    console.log('\n─── By Exit Reason ────────────────────────────────────────────');
    for (const [reason, count] of Object.entries(statsNet.byExit)) {
      console.log(`  ${reason.padEnd(14)} | ${count} trades`);
    }

    console.log('\n─── By Fear & Greed Regime ────────────────────────────────────');
    if (statsNet.byRegime && Object.keys(statsNet.byRegime).length > 0) {
      for (const [regime, rStats] of Object.entries(statsNet.byRegime)) {
        console.log(`  ${regime.padEnd(14)} | ${rStats.trades} trades | Win: ${rStats.winRate} | Avg: ${rStats.avgReturn}`);
      }
    } else {
      console.log('  No F&G data available (or fetch failed).');
    }

    console.log('\n─── Confidence Analysis ───────────────────────────────────────');
    console.log('  High Confidence (>= 75%):', JSON.stringify(statsNet.highConfidence));
    console.log('  Low Confidence  (< 75%): ', JSON.stringify(statsNet.lowConfidence));

    console.log('\n─── Per-Asset Leaderboard ─────────────────────────────────────');
    assetResults.sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));
    for (const r of assetResults) {
      const bar = parseFloat(r.avgReturn) >= 0 ? '🟢' : '🔴';
      console.log(`  ${bar} ${r.symbol.padEnd(8)} | ${r.trades} trades | Win: ${r.winRate}% | Avg return: ${r.avgReturn}%`);
    }
    // ─── WINNERS-ONLY RESULTS (what the live strategy actually trades) ───
    const winnersList = CONFIG.assets.provenWinners || [];
    const winnerTrades = allTrades.filter(t => winnersList.includes(t.symbol));
    const wStatsNet = computeStats(winnerTrades, 'returnPct');
    const wStatsGross = computeStats(winnerTrades, 'grossReturnPct');
    const coreList = CONFIG.assets.coreWinners || [];
    const probationList = CONFIG.assets.probationWinners || [];
    const coreTrades = allTrades.filter(t => coreList.includes(t.symbol));
    const probationTrades = allTrades.filter(t => probationList.includes(t.symbol));
    const coreStatsNet = computeStats(coreTrades, 'returnPct');
    const probationStatsNet = computeStats(probationTrades, 'returnPct');
    console.log('\n─── Winners-Only Strategy (provenWinners filter active) ───────');
    if (wStatsNet) {
      console.log(`  Assets:           ${winnersList.join(', ')}`);
      console.log(`  Total Trades:      ${wStatsNet.totalTrades}`);
      console.log(`  Win Rate:          ${wStatsNet.winRate}`);
      console.log(`  Avg Return (Net):  ${wStatsNet.avgReturn}`);
      if (wStatsGross) console.log(`  Avg Return (Gross): ${wStatsGross.avgReturn}`);
      console.log(`  Avg Hold (days):   ${wStatsNet.avgHoldDays}`);
    } else {
      console.log('  No trades on the winners list.');
    }
    printBySignalBlock('─── Winners-Only By Entry Signal ───────────────────────────────', wStatsNet);
    printStatsBlock('Core Winners Only:', coreStatsNet, computeStats(coreTrades, 'grossReturnPct'));
    printStatsBlock('Probation Winners Only:', probationStatsNet, computeStats(probationTrades, 'grossReturnPct'));

    // ─── Save Database & Auto-Update Config ─────────────────────────────────────
    if (!args.walkForward && !args.walkForwardRolling && !args.costSweep && !args.moonshots) {
      try {
        const dbPath = path.join(__dirname, 'js', 'backtest_database.json');
        let db = { meta: { totalRuns: 0 }, runs: [], accumulated: {} };
        if (fs.existsSync(dbPath)) {
          db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        }

        // 1. Record this run
        const runDate = new Date().toISOString();
        const thisRun = {
          runDate,
          engineVersion: '5.13',
          assets: {}
        };
        
        for (const r of assetResults) {
          thisRun.assets[r.symbol] = {
            trades: parseInt(r.trades, 10),
            winRate: parseFloat(r.winRate),
            avgReturn: parseFloat(r.avgReturn)
          };
        }
        db.runs.push(thisRun);
        db.meta.lastRun = runDate;
        db.meta.totalRuns = db.runs.length;

        // 2. Calculate accumulated averages
        const acc = {};
        for (const run of db.runs) {
          for (const [sym, stats] of Object.entries(run.assets)) {
            if (!acc[sym]) acc[sym] = { trades: 0, winRateSum: 0, avgRetSum: 0, runs: 0 };
            acc[sym].trades += stats.trades;
            acc[sym].winRateSum += stats.winRate;
            acc[sym].avgRetSum += stats.avgReturn;
            acc[sym].runs += 1;
          }
        }

        const coreWinners = [];
        const probationWinners = [];

        for (const [sym, data] of Object.entries(acc)) {
          const avgWinRate = data.winRateSum / data.runs;
          const avgReturn = data.avgRetSum / data.runs;
          
          let classification = 'excluded';
          if (avgReturn > 1.0 && avgWinRate > 40) {
            classification = 'core';
            coreWinners.push(sym);
          } else if (avgReturn > 0) {
            classification = 'probation';
            probationWinners.push(sym);
          }

          db.accumulated[sym] = {
            runsIncluded: data.runs,
            totalTrades: data.trades,
            avgWinRate: +avgWinRate.toFixed(2),
            avgReturn: +avgReturn.toFixed(2),
            classification
          };
        }

        // Sort winners alphabetically
        coreWinners.sort();
        probationWinners.sort();

        // Write database
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        console.log(`\n  [DATABASE] Saved run to js/backtest_database.json (Total runs: ${db.meta.totalRuns})`);

        // 3. Auto-update config.js
        const configPath = path.join(__dirname, 'js', 'config.js');
        let configStr = fs.readFileSync(configPath, 'utf8');
        
        const coreRegex = /(coreWinners:\s*\[)(.*?)(\],)/s;
        const probRegex = /(probationWinners:\s*\[)(.*?)(\],)/s;
        const provRegex = /(provenWinners:\s*\[)(.*?)(\],)/s;
        
        const allWinners = [...coreWinners, ...probationWinners].sort();
        
        configStr = configStr.replace(coreRegex, `$1${coreWinners.map(s => `'${s}'`).join(', ')}$3`);
        configStr = configStr.replace(probRegex, `$1${probationWinners.map(s => `'${s}'`).join(', ')}$3`);
        configStr = configStr.replace(provRegex, `$1${allWinners.map(s => `'${s}'`).join(', ')}$3`);
        
        // Auto-enable winners filters if this is the first real database run
        if (db.meta.totalRuns >= 1) {
          configStr = configStr.replace(/(winnersOnlyBuys:\s*)false/, '$1true');
        }

        fs.writeFileSync(configPath, configStr);
        console.log(`  [CONFIG] Auto-updated coreWinners (${coreWinners.length}) and probationWinners (${probationWinners.length}) in js/config.js`);
        
      } catch (e) {
        console.error('  [ERROR] Failed to save database or update config:', e);
      }
    }
  }
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Backtest complete. These numbers reflect YOUR signal engine');
  console.log('  running against real historical Binance OHLCV data.');
  console.log('═══════════════════════════════════════════════════════════════\n');

}

main().catch(e => console.error('Fatal error:', e));
