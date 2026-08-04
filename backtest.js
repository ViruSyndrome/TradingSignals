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

const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');

// Signals.js references Indicators as a global (browser pattern).
// Make it available globally for Node.js as well.
global.Indicators = Indicators;

// ─── Configuration ─────────────────────────────────────────────────────────────
const MIN_HISTORY  = 50;   // Minimum days of data before generating first signal
const HOLD_LIMIT   = 14;   // Max days to hold if no exit signal fires
const STOP_MULT    = 2.0;  // ATR multiplier for stop-loss (same as live dashboard)

// ─── Fetch historical data from Binance ────────────────────────────────────────
async function fetchHistory(symbol, days = 250) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${days}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`No data for ${symbol}`);
  return {
    opens:      data.map(r => parseFloat(r[1])),
    highs:      data.map(r => parseFloat(r[2])),
    lows:       data.map(r => parseFloat(r[3])),
    closes:     data.map(r => parseFloat(r[4])),
    volumes:    data.map(r => parseFloat(r[5])),
    timestamps: data.map(r => r[0]),
  };
}

// ─── Run backtest on a single asset ────────────────────────────────────────────
function backtestAsset(name, symbol, ohlcv) {
  const { closes, highs, lows, volumes } = ohlcv;
  const trades = [];
  let position = null; // { entryPrice, entryDay, signal, stopLoss }

  for (let day = MIN_HISTORY; day < closes.length; day++) {
    // Generate signal using data up to (and including) this day
    const slicedCloses  = closes.slice(0, day + 1);
    const slicedHighs   = highs.slice(0, day + 1);
    const slicedLows    = lows.slice(0, day + 1);
    const slicedVolumes = volumes.slice(0, day + 1);

    const result = Signals.generate(slicedCloses, {
      highs: slicedHighs,
      lows: slicedLows,
      volumes: slicedVolumes,
    });

    const price = closes[day];
    const sig   = result.signal;
    const conf  = result.confidence ?? 0;
    const score = result.score ?? 0;

    // ─── EXIT LOGIC ─────────────────────────────────────────────────────
    if (position) {
      const holdDays = day - position.entryDay;
      let exitReason = null;

      // Stop-loss hit
      if (position.stopLoss && price <= position.stopLoss) {
        exitReason = 'STOP_LOSS';
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
        const returnPct = ((price - position.entryPrice) / position.entryPrice) * 100;
        trades.push({
          entrySignal: position.signal,
          entryScore:  position.score,
          entryConf:   position.confidence,
          entryPrice:  position.entryPrice,
          exitPrice:   price,
          exitReason,
          holdDays,
          returnPct,
          win: returnPct > 0,
        });
        position = null;
      }
    }

    // ─── ENTRY LOGIC ────────────────────────────────────────────────────
    if (!position && (sig === 'BUY' || sig === 'STRONG_BUY')) {
      // Calculate ATR for stop-loss
      const atr = Indicators.atr(slicedHighs, slicedLows, slicedCloses, 14);
      const stopLoss = atr ? price - (atr * STOP_MULT) : null;

      position = {
        entryPrice: price,
        entryDay:   day,
        signal:     sig,
        score,
        confidence: conf,
        stopLoss,
      };
    }
  }

  // Close any open position at the last price
  if (position) {
    const price = closes[closes.length - 1];
    const holdDays = closes.length - 1 - position.entryDay;
    const returnPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    trades.push({
      entrySignal: position.signal,
      entryScore:  position.score,
      entryConf:   position.confidence,
      entryPrice:  position.entryPrice,
      exitPrice:   price,
      exitReason:  'STILL_OPEN',
      holdDays,
      returnPct,
      win: returnPct > 0,
    });
  }

  return trades;
}

// ─── Aggregate statistics ──────────────────────────────────────────────────────
function computeStats(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const returns = trades.map(t => t.returnPct);
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
    const sigReturns = sigTrades.map(t => t.returnPct);
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

  return {
    totalTrades: trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     ((wins.length / trades.length) * 100).toFixed(1) + '%',
    avgReturn:   avgReturn.toFixed(2) + '%',
    maxReturn:   maxReturn.toFixed(2) + '%',
    minReturn:   minReturn.toFixed(2) + '%',
    avgHoldDays: avgHold.toFixed(1),
    bySignal:    signalStats,
    byExit,
    highConfidence: highConf.length > 0 ? {
      trades:   highConf.length,
      winRate:  ((highConf.filter(t => t.win).length / highConf.length) * 100).toFixed(1) + '%',
      avgReturn: (highConf.map(t => t.returnPct).reduce((a, b) => a + b, 0) / highConf.length).toFixed(2) + '%',
    } : 'No trades with >= 75% confidence',
    lowConfidence: lowConf.length > 0 ? {
      trades:   lowConf.length,
      winRate:  ((lowConf.filter(t => t.win).length / lowConf.length) * 100).toFixed(1) + '%',
      avgReturn: (lowConf.map(t => t.returnPct).reduce((a, b) => a + b, 0) / lowConf.length).toFixed(2) + '%',
    } : 'No trades with < 75% confidence',
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  📊 TRADING SIGNALS BACKTESTER');
  console.log('  Replaying 250 days of history against your signal engine');
  console.log('  Entry: BUY or STRONG_BUY | Exit: SELL, STRONG_SELL, Stop-Loss, or ' + HOLD_LIMIT + '-day limit');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allTrades = [];
  const assetResults = [];

  for (const asset of CONFIG.assets.crypto) {
    try {
      process.stdout.write(`Scanning ${asset.symbol.padEnd(8)}...`);
      const ohlcv = await fetchHistory(asset.id, 250);
      const trades = backtestAsset(asset.name, asset.symbol, ohlcv);
      allTrades.push(...trades);

      const wins = trades.filter(t => t.win).length;
      const wr = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(0) : '0';
      const avg = trades.length > 0
        ? (trades.map(t => t.returnPct).reduce((a, b) => a + b, 0) / trades.length).toFixed(2)
        : '0.00';

      assetResults.push({ symbol: asset.symbol, trades: trades.length, winRate: wr, avgReturn: avg });
      console.log(` ${trades.length} trades | Win rate: ${wr}% | Avg return: ${avg}%`);

    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200)); // Rate limit
  }

  // ─── OVERALL RESULTS ─────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  📈 OVERALL RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const stats = computeStats(allTrades);
  if (!stats) {
    console.log('No trades generated. Check your signal thresholds.');
    return;
  }

  console.log(`  Total Trades:     ${stats.totalTrades}`);
  console.log(`  Wins / Losses:    ${stats.wins} / ${stats.losses}`);
  console.log(`  Win Rate:         ${stats.winRate}`);
  console.log(`  Avg Return:       ${stats.avgReturn}`);
  console.log(`  Best Trade:       ${stats.maxReturn}`);
  console.log(`  Worst Trade:      ${stats.minReturn}`);
  console.log(`  Avg Hold (days):  ${stats.avgHoldDays}`);

  console.log('\n─── By Entry Signal ───────────────────────────────────────────');
  for (const [sig, s] of Object.entries(stats.bySignal)) {
    console.log(`  ${sig.padEnd(14)} | ${s.trades} trades | Win: ${s.winRate} | Avg: ${s.avgReturn} | Best: ${s.bestTrade} | Worst: ${s.worstTrade}`);
  }

  console.log('\n─── By Exit Reason ────────────────────────────────────────────');
  for (const [reason, count] of Object.entries(stats.byExit)) {
    console.log(`  ${reason.padEnd(14)} | ${count} trades`);
  }

  console.log('\n─── Confidence Analysis ───────────────────────────────────────');
  console.log('  High Confidence (>= 75%):', JSON.stringify(stats.highConfidence));
  console.log('  Low Confidence  (< 75%): ', JSON.stringify(stats.lowConfidence));

  console.log('\n─── Per-Asset Leaderboard ─────────────────────────────────────');
  assetResults.sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));
  for (const r of assetResults) {
    const bar = parseFloat(r.avgReturn) >= 0 ? '🟢' : '🔴';
    console.log(`  ${bar} ${r.symbol.padEnd(8)} | ${r.trades} trades | Win: ${r.winRate}% | Avg return: ${r.avgReturn}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Backtest complete. These numbers reflect YOUR signal engine');
  console.log('  running against real historical Binance OHLCV data.');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => console.error('Fatal error:', e));
