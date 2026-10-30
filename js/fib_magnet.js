'use strict';

/**
 * js/fib_magnet.js — Fib Magnet Reversal Engine
 *
 * Captures mean-reversion bounces back to the session Fib box (02:30–03:30 IST):
 *  1. Context: Price stretched ≥ 0.5% away from f0 / f1 anchor after lock.
 *  2. Setup: 15m Tweezer (Red-Green or Green-Red with matching wicks at swing extreme).
 *  3. Micro-Trigger: 1m EMA 10 crossing EMA 20 in the reversal direction.
 *  4. Targets: Structural Swing SL · TP at Fib anchor (f0 for longs, f1 for shorts).
 */
const FibMagnet = {
  DEFAULTS: {
    minStretchPct: 0.50,       // Must be at least 0.5% away from Fib box
    twinTolerancePct: 0.10,    // Wicks within 0.10% price tolerance
    swingLookback: 16,         // Lookback 16 bars (4 hours) for swing extreme
    slBufferPct: 0.20,         // 0.20% buffer beyond the swing extreme
    minRR: 1.0,                // Minimum 1:1 reward to risk ratio
    fastEmaPeriod: 10,         // 1m Fast EMA
    slowEmaPeriod: 20,         // 1m Slow EMA
  },

  calcEma(values, period) {
    if (!values || values.length < period) return new Array(values ? values.length : 0).fill(null);
    const k = 2 / (period + 1);
    const out = new Array(values.length);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  },

  check1mEmaCross(bars1m, fastPeriod = 10, slowPeriod = 20) {
    if (!bars1m || bars1m.length < slowPeriod + 2) {
      return { status: 'unknown', reason: 'Insufficient 1m data' };
    }
    const closes = bars1m.map(b => b.c);
    const emaF = this.calcEma(closes, fastPeriod);
    const emaS = this.calcEma(closes, slowPeriod);
    const last = closes.length - 1;

    const fNow = emaF[last], sNow = emaS[last];
    const fPrev = emaF[last - 1], sPrev = emaS[last - 1];

    if (fNow == null || sNow == null || fPrev == null || sPrev == null) {
      return { status: 'unknown', reason: 'EMA warm-up incomplete' };
    }

    const isBullCross = (fPrev <= sPrev && fNow > sNow);
    const isBearCross = (fPrev >= sPrev && fNow < sNow);
    const isBullStacked = (fNow > sNow);
    const isBearStacked = (fNow < sNow);

    return {
      status: isBullCross ? 'bull_cross' : isBearCross ? 'bear_cross' : isBullStacked ? 'bull_stacked' : 'bear_stacked',
      fast: fNow,
      slow: sNow,
      bullish: isBullStacked,
      bearish: isBearStacked,
      recentBullCross: isBullCross || (emaF[last - 2] <= emaS[last - 2] && fNow > sNow),
      recentBearCross: isBearCross || (emaF[last - 2] >= emaS[last - 2] && fNow < sNow),
    };
  },

  evaluate({ bars, sessionBand, bars1m, opts = {} }) {
    const cfg = { ...this.DEFAULTS, ...opts };
    if (!bars || bars.length < cfg.swingLookback + 2) {
      return { state: 'WAIT', side: 'NONE', reason: 'Insufficient bars' };
    }

    if (!sessionBand || !sessionBand.locked || !Number.isFinite(sessionBand.f0) || !Number.isFinite(sessionBand.f1)) {
      return { state: 'WAIT', side: 'NONE', reason: 'Daily Fib box (02:30–03:30 IST) not locked yet' };
    }

    const { f0, f1, f50 } = sessionBand;
    const i = bars.length - 1;
    const bCurr = bars[i];
    const bPrev = bars[i - 1];
    const price = bCurr.c;

    // Lookback swing highs and lows
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let k = Math.max(0, i - cfg.swingLookback); k <= i - 2; k++) {
      if (bars[k].h > priorHigh) priorHigh = bars[k].h;
      if (bars[k].l < priorLow) priorLow = bars[k].l;
    }

    let setup = null;

    // 1. Check LONG: Tweezer Bottom (Red -> Green with matching lows at extreme)
    const isRedThenGreen = (bPrev.c < bPrev.o) && (bCurr.c > bCurr.o);
    const lowDiffPct = Math.abs(bCurr.l - bPrev.l) / price * 100;
    const twinLow = Math.min(bCurr.l, bPrev.l);

    if (isRedThenGreen && lowDiffPct <= cfg.twinTolerancePct && twinLow <= priorLow) {
      const distBelowFibPct = (f0 - twinLow) / price * 100;
      if (distBelowFibPct >= cfg.minStretchPct) {
        const sl = twinLow * (1 - cfg.slBufferPct / 100);
        const tp = f0; // Fib magnet
        const reward = tp - price;
        const risk = price - sl;
        const rr = risk > 0 ? reward / risk : 0;

        if (rr >= cfg.minRR && tp > price) {
          setup = {
            side: 'LONG',
            entry: price,
            stop: sl,
            tp,
            tpAlt: f50,
            rr,
            distPct: distBelowFibPct,
            swingExtreme: twinLow,
            candleTime: bCurr.t,
          };
        }
      }
    }

    // 2. Check SHORT: Tweezer Top (Green -> Red with matching highs at extreme)
    const isGreenThenRed = (bPrev.c > bPrev.o) && (bCurr.c < bCurr.o);
    const highDiffPct = Math.abs(bCurr.h - bPrev.h) / price * 100;
    const twinHigh = Math.max(bCurr.h, bPrev.h);

    if (!setup && isGreenThenRed && highDiffPct <= cfg.twinTolerancePct && twinHigh >= priorHigh) {
      const distAboveFibPct = (twinHigh - f1) / price * 100;
      if (distAboveFibPct >= cfg.minStretchPct) {
        const sl = twinHigh * (1 + cfg.slBufferPct / 100);
        const tp = f1; // Fib magnet
        const reward = price - tp;
        const risk = sl - price;
        const rr = risk > 0 ? reward / risk : 0;

        if (rr >= cfg.minRR && tp < price) {
          setup = {
            side: 'SHORT',
            entry: price,
            stop: sl,
            tp,
            tpAlt: f50,
            rr,
            distPct: distAboveFibPct,
            swingExtreme: twinHigh,
            candleTime: bCurr.t,
          };
        }
      }
    }

    if (!setup) {
      return { state: 'IDLE', side: 'NONE', reason: 'No tweezer rejection at Fib extreme' };
    }

    // 3. Check 1-minute EMA Confirmation
    const emaCheck = this.check1mEmaCross(bars1m, cfg.fastEmaPeriod, cfg.slowEmaPeriod);
    const confirmed = setup.side === 'LONG'
      ? (emaCheck.bullish || emaCheck.recentBullCross)
      : (emaCheck.bearish || emaCheck.recentBearCross);

    const state = confirmed ? 'ENTER' : 'WATCH_1M';

    return {
      state,
      side: setup.side,
      entry: setup.entry,
      stop: setup.stop,
      tp: setup.tp,
      tpAlt: setup.tpAlt,
      rr: setup.rr,
      distPct: setup.distPct,
      swingExtreme: setup.swingExtreme,
      candleTime: setup.candleTime,
      emaCheck,
      badge: confirmed
        ? `🧲 FIB MAGNET ${setup.side} (1m Confirmed)`
        : `🧲 FIB MAGNET ${setup.side} (Wait 1m EMA)`,
      title: confirmed
        ? `LIVE ENTER · Fib Magnet ${setup.side}`
        : `WATCH · Tweezer formed, awaiting 1m EMA cross`,
      subtitle: `Target Fib ${setup.side === 'LONG' ? 'f0' : 'f1'} (${setup.tp.toFixed(1)}) · Stretched ${setup.distPct.toFixed(2)}% · SL ${setup.stop.toFixed(1)} · R:R ${setup.rr.toFixed(2)}`,
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FibMagnet;
}
if (typeof window !== 'undefined') {
  window.FibMagnet = FibMagnet;
}
