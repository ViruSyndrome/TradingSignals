'use strict';

/**
 * Heikin-Ashi EMA(20/50/200) + Quiet CCI(200) Multi-Asset Futures Engine.
 * Empirically calibrated per asset:
 *  - NIFTY 15m: CCI Cross Back (default; optional wide 4.5x ATR Chandelier)
 *  - CRUDEOIL 15m: Chandelier 2.5x ATR(14) trail (PF 1.50 vs -₹26k baseline)
 *  - GOLD / XAU 1h: Chandelier 3.5x ATR(14) trail (PF 1.54, +656.8 net pts / 2.8Y)
 */

const { computeATR } = require('./patrick_swing_engine.js');

function toHA(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const hc = (b.o + b.h + b.l + b.c) / 4;
    const ho = i === 0 ? (b.o + b.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out[i] = { t: b.t, o: ho, h: Math.max(b.h, ho, hc), l: Math.min(b.l, ho, hc), c: hc };
  }
  return out;
}

function computeEMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += vals[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < vals.length; i++) {
    e = vals[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function computeCCI(bars, period = 200) {
  const tp = bars.map((b) => b.c);
  const out = new Array(bars.length).fill(null);
  for (let i = period - 1; i < tp.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const sma = sum / period;
    let mad = 0;
    for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - sma);
    mad /= period;
    out[i] = mad === 0 ? 0 : (tp[i] - sma) / (0.015 * mad);
  }
  return out;
}

function istParts(ts) {
  const d = new Date(ts + 330 * 60000);
  return {
    day: d.toISOString().slice(0, 10),
    mins: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function allowNewEntry(sym, ts) {
  if (sym === 'XAU' || sym === 'GOLD' || sym === 'XAUUSDT') return true;
  const { mins } = istParts(ts);
  if (sym === 'NIFTY') return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 20;
  return mins >= 9 * 60 && mins <= 23 * 60 + 15;
}

function prepareIndicators(bars) {
  const ha = toHA(bars);
  const hc = ha.map((b) => b.c);
  return {
    ha,
    hc,
    e20: computeEMA(hc, 20),
    e50: computeEMA(hc, 50),
    e200: computeEMA(hc, 200),
    cci: computeCCI(bars, 200),
    atr: computeATR(bars, 14),
  };
}

function createInitialState() {
  return {
    pos: null,
    longTaken: false,
    shortTaken: false,
    lastProcessedTs: 0,
    closedTrades: [],
  };
}

/**
 * Evaluate bar `idx` cleanly with precomputed or newly computed indicators.
 * opts:
 *   symbol: 'NIFTY' | 'CRUDEOIL' | 'XAU' | 'GOLDM'
 *   quietFilter: true (default)
 *   exitMode: 'cci' | 'chandelier'
 *   chandMult: 2.5 (CRUDEOIL) | 3.5 (XAU 1h) | 4.5 (optional NIFTY)
 */
function stepHaEmaCciBar(bars, idx, state, opts = {}) {
  const sym = (opts.symbol || 'NIFTY').toUpperCase();
  const quietFilter = opts.quietFilter !== false;
  const exitMode = (opts.exitMode || (sym === 'NIFTY' ? 'cci' : 'chandelier')).toLowerCase();
  const chandMult = Number(opts.chandMult || (sym === 'CRUDEOIL' ? 2.5 : sym === 'XAU' || sym === 'GOLDM' ? 3.5 : 4.5));
  const ind = opts.ind || prepareIndicators(bars);

  const events = [];
  if (idx < 201) return { state, events };
  const b = bars[idx];
  if (b.t <= state.lastProcessedTs) return { state, events };
  state.lastProcessedTs = b.t;

  const { hc, e20, e50, e200, cci, atr } = ind;
  const cNow = cci[idx];
  const cPrev = cci[idx - 1];
  const curAtr = atr[idx] || (b.h - b.l);
  if (cNow == null || cPrev == null || e200[idx] == null) return { state, events };

  const ls = e20[idx] != null && hc[idx] > e20[idx] && e20[idx] > e50[idx] && e50[idx] > e200[idx];
  const ss = e20[idx] != null && hc[idx] < e20[idx] && e20[idx] < e50[idx] && e50[idx] < e200[idx];
  const lsPrev = e20[idx - 1] != null && hc[idx - 1] > e20[idx - 1] && e20[idx - 1] > e50[idx - 1] && e50[idx - 1] > e200[idx - 1];
  const ssPrev = e20[idx - 1] != null && hc[idx - 1] < e20[idx - 1] && e20[idx - 1] < e50[idx - 1] && e50[idx - 1] < e200[idx - 1];

  const crossUp100 = cPrev < 100 && cNow >= 100;
  const crossDn100 = cPrev >= 100 && cNow < 100;
  const crossDnNeg100 = cPrev > -100 && cNow <= -100;
  const crossUpNeg100 = cPrev <= -100 && cNow > -100;

  // 1) Manage open position
  if (state.pos) {
    const pos = state.pos;
    if (pos.side === 'LONG') {
      pos.peak = Math.max(pos.peak, b.h);
      pos.mfe = Math.max(pos.mfe, pos.peak - pos.entry);
    } else {
      pos.trough = Math.min(pos.trough, b.l);
      pos.mfe = Math.max(pos.mfe, pos.entry - pos.trough);
    }

    const doExit = (exitPx, reason) => {
      const grossPts = pos.side === 'LONG' ? exitPx - pos.entry : pos.entry - exitPx;
      const trade = {
        side: pos.side,
        entry: pos.entry,
        exit: exitPx,
        entryTs: pos.entryTs,
        exitTs: b.t,
        grossPts: +grossPts.toFixed(2),
        mfe: +pos.mfe.toFixed(2),
        reason,
      };
      if (pos.side === 'LONG') state.longTaken = false;
      else state.shortTaken = false;
      state.closedTrades.push(trade);
      events.push({ type: 'EXIT', trade });
      state.pos = null;
    };

    if (exitMode === 'cci') {
      if ((pos.side === 'LONG' && crossDn100) || (pos.side === 'SHORT' && crossUpNeg100)) {
        doExit(b.c, 'CCI_CROSS_BACK');
      }
      return { state, events };
    }

    if (exitMode === 'chandelier') {
      if (pos.side === 'LONG') {
        if (pos.sl != null && b.l <= pos.sl) {
          doExit(Math.min(b.o, pos.sl), `CHANDELIER_${chandMult}X_SL`);
          return { state, events };
        }
        const cand = pos.peak - chandMult * curAtr;
        if (cand > pos.sl) {
          pos.sl = cand;
          events.push({ type: 'TRAIL_SL', side: 'LONG', sl: +cand.toFixed(2), barTs: b.t });
        }
      } else {
        if (pos.sl != null && b.h >= pos.sl) {
          doExit(Math.max(b.o, pos.sl), `CHANDELIER_${chandMult}X_SL`);
          return { state, events };
        }
        const cand = pos.trough + chandMult * curAtr;
        if (cand < pos.sl) {
          pos.sl = cand;
          events.push({ type: 'TRAIL_SL', side: 'SHORT', sl: +cand.toFixed(2), barTs: b.t });
        }
      }
      return { state, events };
    }
  }

  // 2) Reset one-trade-per-stack latch when stack breaks
  if (!ls) state.longTaken = false;
  if (!ss) state.shortTaken = false;
  if (!allowNewEntry(sym, b.t)) return { state, events };

  let enterLong = crossUp100 && ls && lsPrev && !state.longTaken;
  let enterShort = crossDnNeg100 && ss && ssPrev && !state.shortTaken;

  if ((enterLong || enterShort) && quietFilter) {
    const jump = Math.abs(cNow - cPrev);
    const thrust = enterLong ? (cNow - 100) : (-100 - cNow);
    let badOpen = false;
    if (sym !== 'XAU' && sym !== 'GOLD' && sym !== 'XAUUSDT') {
      const clk = istParts(b.t);
      const prevDay = istParts(bars[idx - 1].t).day;
      badOpen = clk.day !== prevDay || (sym === 'NIFTY' && clk.mins === 9 * 60 + 15);
    }
    if (badOpen || jump >= 25 || thrust < 0 || thrust >= 15) {
      enterLong = false;
      enterShort = false;
    }
  }

  if (enterLong || enterShort) {
    const side = enterLong ? 'LONG' : 'SHORT';
    if (enterLong) state.longTaken = true;
    else state.shortTaken = true;
    const sl = exitMode === 'chandelier'
      ? (side === 'LONG' ? b.c - chandMult * curAtr : b.c + chandMult * curAtr)
      : null;
    state.pos = {
      side,
      entry: b.c,
      entryTs: b.t,
      entryAtr: curAtr,
      sl,
      peak: b.c,
      trough: b.c,
      mfe: 0,
      cciAtEntry: +cNow.toFixed(1),
    };
    events.push({
      type: 'ENTER',
      side,
      entry: b.c,
      sl: sl != null ? +sl.toFixed(2) : null,
      atr: +curAtr.toFixed(2),
      cci: +cNow.toFixed(1),
      exitMode,
      barTs: b.t,
    });
  }

  return { state, events };
}

module.exports = {
  toHA,
  computeEMA,
  computeCCI,
  prepareIndicators,
  createInitialState,
  stepHaEmaCciBar,
};
