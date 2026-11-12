'use strict';
/**
 * Backtest: Patrick Nill's Robbins World Cup Strategy
 *
 * Pattern: "P" and "B" Formations + Failed Breakout Reclaim (Liquidity Sweep)
 * 1. Impulse Push: Strong multi-candle move up (P) or down (B).
 * 2. Range Consolidation: 15m sideways range forming at the extreme.
 * 3. Range Validation: 3 touches of the boundaries.
 * 4. The Trigger (Patrick's Favorite):
 *    - Price breaks below the range low (trapping sellers / sweeping stop liquidity).
 *    - Candle fails to follow through and closes back INSIDE the range!
 *    - Long Entry: At range low immediately upon reclaim.
 *    - Stop Loss: Below the sweep wick low (tiny risk).
 *    - Target: Range High or Next Fair Value Area (3R to 5R).
 */

const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '..', '.cache_desk');

function loadBars(sym = 'NIFTY') {
  const filePath = path.join(CACHE, `${sym}_15m.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return (Array.isArray(raw) ? raw : raw.bars)
    .map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

function runPatrickNillBacktest() {
  const bars = loadBars('NIFTY');
  const trades = [];

  // Look for 15m consolidation ranges (last 12 to 24 bars = 3 to 6 hours)
  const RANGE_BARS = 16;

  for (let i = 30; i < bars.length - 10; i++) {
    // 1. Identify Prior Impulse (Push) over preceding 10 bars
    const impulseBars = bars.slice(i - 25, i - RANGE_BARS);
    const impulseMove = impulseBars[impulseBars.length - 1].c - impulseBars[0].o;
    const isBullishImpulse = impulseMove > 80; // strong push up (>80 pts)
    const isBearishImpulse = impulseMove < -80; // strong push down (<-80 pts)

    // 2. Identify Range Window
    const rangeWindow = bars.slice(i - RANGE_BARS, i);
    const rangeHigh = Math.max(...rangeWindow.map((b) => b.h));
    const rangeLow = Math.min(...rangeWindow.map((b) => b.l));
    const rangeSpan = rangeHigh - rangeLow;

    // Range must be compact relative to impulse (a consolidation box, not wild expansion)
    if (rangeSpan < 35 || rangeSpan > 150) continue;

    // 3. Three touches rule (at least 2 touches near high and 2 near low)
    const tol = rangeSpan * 0.15;
    const touchesHigh = rangeWindow.filter((b) => b.h >= rangeHigh - tol).length;
    const touchesLow = rangeWindow.filter((b) => b.l <= rangeLow + tol).length;
    if (touchesHigh < 2 || touchesLow < 2) continue;

    const curBar = bars[i];
    const prevBar = bars[i - 1];

    // --- PATRICK'S SETUP 1: Long on Bearish Sweep & Reclaim (Patrick's Favorite) ---
    // Candle sweeps below rangeLow, but closes back inside range!
    const sweepLow = prevBar.l < rangeLow || curBar.l < rangeLow;
    const reclaimLow = curBar.c > rangeLow && curBar.c > curBar.o; // closes green back inside

    if (sweepLow && reclaimLow && isBullishImpulse) {
      const sweepExtreme = Math.min(prevBar.l, curBar.l);
      const entry = curBar.c;
      const stop = sweepExtreme - 5.0; // tight stop below sweep wick
      const risk = entry - stop;

      if (risk >= 10 && risk <= 45) {
        // Target 1: Range High, Target 2: 3R
        const tp = entry + risk * 3;
        let exitPrice = null;
        let exitReason = null;
        let held = 0;

        for (let j = i + 1; j < Math.min(bars.length, i + 35); j++) {
          const b = bars[j];
          held++;
          if (b.l <= stop) {
            exitPrice = stop;
            exitReason = 'stop_hit';
            break;
          }
          if (b.h >= tp) {
            exitPrice = tp;
            exitReason = 'target_3r_hit';
            break;
          }
          if (b.h >= rangeHigh && held >= 6 && b.c < rangeHigh - tol) {
            exitPrice = rangeHigh;
            exitReason = 'range_high_bank';
            break;
          }
        }

        if (exitPrice == null) {
          exitPrice = bars[Math.min(bars.length - 1, i + 30)].c;
          exitReason = 'time_exit';
        }

        const pnl = exitPrice - entry;
        trades.push({
          type: 'PATRICK_SWEEP_RECLAIM_LONG',
          index: i,
          entry,
          stop,
          risk: +risk.toFixed(1),
          exitPrice,
          exitReason,
          pnl: +pnl.toFixed(2),
          rr: +(pnl / risk).toFixed(2),
          held,
        });

        i += 10; // skip forward after trade
        continue;
      }
    }

    // --- PATRICK'S SETUP 2: Short on Bullish Sweep & Reclaim ---
    const sweepHigh = prevBar.h > rangeHigh || curBar.h > rangeHigh;
    const reclaimHigh = curBar.c < rangeHigh && curBar.c < curBar.o; // closes red back inside

    if (sweepHigh && reclaimHigh && isBearishImpulse) {
      const sweepExtreme = Math.max(prevBar.h, curBar.h);
      const entry = curBar.c;
      const stop = sweepExtreme + 5.0;
      const risk = stop - entry;

      if (risk >= 10 && risk <= 45) {
        const tp = entry - risk * 3;
        let exitPrice = null;
        let exitReason = null;
        let held = 0;

        for (let j = i + 1; j < Math.min(bars.length, i + 35); j++) {
          const b = bars[j];
          held++;
          if (b.h >= stop) {
            exitPrice = stop;
            exitReason = 'stop_hit';
            break;
          }
          if (b.l <= tp) {
            exitPrice = tp;
            exitReason = 'target_3r_hit';
            break;
          }
          if (b.l <= rangeLow && held >= 6 && b.c > rangeLow + tol) {
            exitPrice = rangeLow;
            exitReason = 'range_low_bank';
            break;
          }
        }

        if (exitPrice == null) {
          exitPrice = bars[Math.min(bars.length - 1, i + 30)].c;
          exitReason = 'time_exit';
        }

        const pnl = entry - exitPrice;
        trades.push({
          type: 'PATRICK_SWEEP_RECLAIM_SHORT',
          index: i,
          entry,
          stop,
          risk: +risk.toFixed(1),
          exitPrice,
          exitReason,
          pnl: +pnl.toFixed(2),
          rr: +(pnl / risk).toFixed(2),
          held,
        });

        i += 10;
        continue;
      }
    }
  }

  // Calculate Metrics
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = totalTrades ? +( (wins.length / totalTrades) * 100 ).toFixed(1) : 0;
  const totalPoints = trades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +( grossProfit / grossLoss ).toFixed(2) : grossProfit > 0 ? 99 : 0;

  console.log('========================================================================================');
  console.log('         PATRICK NILL (ROBBINS WORLD CUP) STRATEGY BACKTEST RESULTS (NIFTY 50)          ');
  console.log('         Setup: "P" and "B" Formations + Failed Breakout Liquidity Reclaim              ');
  console.log('========================================================================================\n');

  console.log(`Total Trades:        ${totalTrades}`);
  console.log(`Wins / Losses:       ${wins.length} Wins / ${losses.length} Losses`);
  console.log(`Win Rate:            ${winRate}%`);
  console.log(`Total Realized P&L:  +${totalPoints.toFixed(1)} Index Points`);
  console.log(`Profit Factor:       ${profitFactor}`);
  console.log(`Average Risk/Reward: ${trades.length ? +(trades.reduce((s, t) => s + (t.pnl > 0 ? t.rr : 0), 0) / (wins.length || 1)).toFixed(2) : 0} R on wins`);
  console.log(`Average P&L / Trade: +${totalTrades ? (totalPoints / totalTrades).toFixed(1) : 0} Points`);

  console.log('\nBreakdown by Outcome:');
  const target3rHits = trades.filter((t) => t.exitReason === 'target_3r_hit').length;
  const rangeBanks = trades.filter((t) => t.exitReason?.includes('bank')).length;
  const stopHits = trades.filter((t) => t.exitReason === 'stop_hit').length;
  console.log(`  • 3R Target Full Runner:  ${target3rHits} trades`);
  console.log(`  • Opposite Range Bank:    ${rangeBanks} trades`);
  console.log(`  • Stop Loss Hits:         ${stopHits} trades`);
}

runPatrickNillBacktest();
