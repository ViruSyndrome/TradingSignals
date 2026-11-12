/**
 * NIFTY Options Multi-Timeframe Execution Engine
 *
 * Implements Dr. Dev / Sagar floor-trader rules directly on the Option Premium Chart:
 * 1. 15-Minute Canvas: Computes 09:15-09:30 Opening Bar High/Low/Median on Option Premium
 *    (The Opening Low serves as the primary structural ceiling / breakdown target).
 * 2. 5-Minute Filter: Verifies Option is testing concrete support (recent swing low floor).
 * 3. 1-Minute Micro-Confirmation: Rejection wick (>= 35% lower wick), micro double-bottom,
 *    or bullish expansion candle before pulling the trigger.
 * 4. Structural Option Levels: Entry, Stop Loss (wick low - buffer), 1:1 Banker, and 15m Target
 *    calculated directly in option points, eliminating synthetic delta distortion.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OPT_TICK = 0.05;
function tickPrem(n) {
  return +(Math.round(Number(n) / OPT_TICK) * OPT_TICK).toFixed(2);
}

/**
 * Parse raw Dhan OHLC candle payload into clean array of objects
 */
function parseDhanOhlc(payload) {
  if (!payload) return [];
  const opens = payload.open || [];
  const highs = payload.high || [];
  const lows = payload.low || [];
  const closes = payload.close || [];
  const vols = payload.volume || [];
  const ts = payload.timestamp || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const tSec = Number(ts[i]);
    const o = Number(opens[i]);
    const h = Number(highs[i]);
    const l = Number(lows[i]);
    const c = Number(closes[i]);
    if (![tSec, o, h, l, c].every(Number.isFinite)) continue;
    out.push({
      t: tSec * 1000,
      o,
      h,
      l,
      c,
      v: Number(vols[i]) || 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Compute the 15m Canvas from Option 1m/5m/15m bars
 */
function computeOptionCanvas(bars, dayDateStr) {
  if (!Array.isArray(bars) || !bars.length) return null;

  // Filter bars for today's session
  const todayBars = bars.filter((b) => {
    if (!dayDateStr) return true;
    const d = new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return d === dayDateStr;
  });

  if (!todayBars.length) return null;

  // Find 09:15-09:30 opening window bars (first 15 minutes)
  const openBars = todayBars.filter((b) => {
    const ist = new Date(b.t).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    const [hh, mm] = ist.split(':').map(Number);
    const mOfDay = hh * 60 + mm;
    return mOfDay >= (9 * 60 + 15) && mOfDay < (9 * 60 + 30);
  });

  if (!openBars.length) {
    // If exact 09:15-09:30 not parsed, take the first 3 5m bars or first 15 1m bars
    const fallbackCount = Math.min(3, todayBars.length);
    openBars.push(...todayBars.slice(0, fallbackCount));
  }

  const openBarHigh = Math.max(...openBars.map((b) => b.h));
  const openBarLow = Math.min(...openBars.map((b) => b.l));
  const openBarMedian = tickPrem((openBarHigh + openBarLow) / 2);

  // Day High and Low so far
  const dayHigh = Math.max(...todayBars.map((b) => b.h));
  const dayLow = Math.min(...todayBars.map((b) => b.l));

  return {
    openBarHigh,
    openBarLow,
    openBarMedian,
    dayHigh,
    dayLow,
    structuralCeiling: openBarLow, // Primary breakdown retest target
    sampleCount: todayBars.length,
  };
}

/**
 * 1-Minute Micro-Confirmation ("Trader's Eye")
 * Checks if buyers are actively stepping in on the option contract.
 */
function check1mMicroConfirmation(bars1m) {
  if (!Array.isArray(bars1m) || bars1m.length < 2) {
    return {
      confirmed: false,
      reason: 'Insufficient 1-minute option bars (need at least 2)',
    };
  }

  // Look at the last 2 closed 1m bars
  const cur = bars1m[bars1m.length - 1];
  const prev = bars1m[bars1m.length - 2];

  const curRange = cur.h - cur.l;
  const curLowerWick = Math.min(cur.o, cur.c) - cur.l;
  const curWickRatio = curRange > 0 ? (curLowerWick / curRange) : 0;
  const curIsGreen = cur.c > cur.o;

  const prevRange = prev.h - prev.l;
  const prevLowerWick = Math.min(prev.o, prev.c) - prev.l;
  const prevWickRatio = prevRange > 0 ? (prevLowerWick / prevRange) : 0;

  // Dr. Dev / Sagar previous-wick extreme SL:
  // Anchored to the lower of the signal candle and immediately preceding candle
  const signalLow = Math.min(cur.l, prev.l);
  const lookback = bars1m.slice(-5);
  const recentLow = Math.min(...lookback.map((b) => b.l));

  // Condition 1: Rejection Wick (current bar absorbs sellers, or prior bar absorbed sellers and current holds/turns green)
  const hasCurWick = curWickRatio >= 0.30;
  const hasPrevWickHold = prevWickRatio >= 0.30 && (curIsGreen || cur.l >= prev.l);
  const hasStrongWick = hasCurWick || hasPrevWickHold;

  // Condition 2: Bullish Reversal Bar (green bar with lower wick >= 25% or >= 3 pts)
  const hasGreenReversal = curIsGreen && (curWickRatio >= 0.25 || curLowerWick >= 3.0);

  // Condition 3: Bullish Momentum Break (green candle closing above prior close/high)
  const curBody = cur.c - cur.o;
  const hasMicroBreakout = curIsGreen && (cur.c > prev.h || (cur.c > prev.c && curBody > curRange * 0.4));

  // Condition 4: Micro Double Bottom / Higher Low (must still close with real buyer body >= 25% of range or >= 20% lower wick, preventing tiny red/green dojis from confirming)
  const hasHigherLow = cur.l >= prev.l
    && ((curIsGreen && (curBody >= curRange * 0.25 || curWickRatio >= 0.20)) || curWickRatio >= 0.25);

  const confirmed = hasStrongWick || hasGreenReversal || hasMicroBreakout || hasHigherLow;

  let triggerPattern = 'none';
  if (hasCurWick) triggerPattern = `rejection_wick_${(curWickRatio * 100).toFixed(0)}pct`;
  else if (hasPrevWickHold) triggerPattern = `prev_rejection_wick_hold_${(prevWickRatio * 100).toFixed(0)}pct`;
  else if (hasGreenReversal) triggerPattern = `green_reversal_wick_${(curWickRatio * 100).toFixed(0)}pct`;
  else if (hasMicroBreakout) triggerPattern = 'micro_breakout_expansion';
  else if (hasHigherLow) triggerPattern = 'micro_higher_low_double_bottom';

  return {
    confirmed,
    triggerPattern,
    signalLow,
    recentLow,
    curWickRatio: +(curWickRatio * 100).toFixed(1),
    curIsGreen,
    lastClose: cur.c,
    reason: confirmed
      ? `1m confirmation confirmed via ${triggerPattern} (signalLow=${signalLow}, close=${cur.c})`
      : `1m awaiting confirmation: curWickRatio=${(curWickRatio * 100).toFixed(0)}%, isGreen=${curIsGreen}, curL=${cur.l} vs prevL=${prev.l}`,
  };
}

/**
 * Calculate precise structural Option SL, 1:1, and Target directly from Option Charts
 */
function calculateOptionLevels({
  currentPremium,
  optionCanvas,
  microAnalysis,
  bufferPts = 1.5,
  minSlPts = 4.0,
  maxSlPts = 14.0,
}) {
  const entryPrice = tickPrem(currentPremium);
  const baseLow = Number(microAnalysis?.signalLow || microAnalysis?.recentLow) || (entryPrice - 6.0);

  // Stop loss anchored directly to option candle wick low minus buffer
  let slDistance = entryPrice - (baseLow - bufferPts);
  if (slDistance < minSlPts) slDistance = minSlPts;
  if (slDistance > maxSlPts) slDistance = maxSlPts;

  const stopLossPrice = tickPrem(entryPrice - slDistance);
  const riskPts = tickPrem(entryPrice - stopLossPrice);

  // Model B: 1:1 Banker
  const tp1Banker = tickPrem(entryPrice + riskPts);

  // Runner Target: Structural ceiling (e.g. 15m open low) or 2.2R expansion
  let tpTarget = optionCanvas?.structuralCeiling && optionCanvas.structuralCeiling > (entryPrice + riskPts * 1.5)
    ? tickPrem(optionCanvas.structuralCeiling)
    : tickPrem(entryPrice + riskPts * 2.2);

  if (tpTarget <= tp1Banker) {
    tpTarget = tickPrem(entryPrice + riskPts * 2.2);
  }

  return {
    entryPrice,
    stopLossPrice,
    riskPts,
    tp1Banker,
    tpTarget,
    rewardPts: tickPrem(tpTarget - entryPrice),
    rrRatio: +( (tpTarget - entryPrice) / riskPts ).toFixed(2),
  };
}

module.exports = {
  OPT_TICK,
  tickPrem,
  parseDhanOhlc,
  computeOptionCanvas,
  check1mMicroConfirmation,
  calculateOptionLevels,
};
