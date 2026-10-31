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
  },

  /**
   * Detects real-world session opening tells & predictive bias:
   *  1. London Judas Swing (sweeping Asia High or Low in first 75m)
   *  2. NY Opening Hunt (sweeping London High or Low)
   *  3. Pre-London Ramp/Drift (12:00-13:00 IST)
   *  4. Fib Magnet Pull (69.2% reversion probability)
   */
  detectSessionTell({ bars, sessionBand, refs, asOfTs }) {
    const now = asOfTs || (bars && bars.length ? bars[bars.length - 1].t : Date.now());
    const d = new Date(now);
    const inv = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hour = inv.getHours();
    const minute = inv.getMinutes();
    const mins = hour * 60 + minute;

    if (!bars || bars.length < 5) return null;
    const lastBar = bars[bars.length - 1];
    const price = lastBar.c;

    const asiaHigh = refs?.asiaHigh;
    const asiaLow = refs?.asiaLow;
    const lonHigh = refs?.londonHigh;
    const lonLow = refs?.londonLow;

    // Check last 4 bars for recent sweeps
    const recentBars = bars.slice(-4);
    const minRecent = Math.min(...recentBars.map(b => b.l));
    const maxRecent = Math.max(...recentBars.map(b => b.h));

    // 1. London Open Window: 12:30 to 14:15 IST (mins 750 to 855)
    if (mins >= 750 && mins <= 855) {
      if (asiaLow != null && minRecent < asiaLow && price >= asiaLow * 0.998) {
        return {
          id: 'london_judas_low',
          badge: '⚡ ASIA LOW SWEPT',
          session: 'London Open (13:00–14:15 IST)',
          predictedDir: 'BULLISH REVERSAL',
          confidence: '62.7% London Extreme',
          headline: `⚡ Asia Low Swept ($${asiaLow.toFixed(1)}) — London Judas Swing`,
          detail: `62.7% of trading days form London's session extreme in this opening 45m window. Asia Low was punctured; watch for 15m twin bars & 1m EMA bullish cross to enter Long back to Fib Magnet.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (asiaHigh != null && maxRecent > asiaHigh && price <= asiaHigh * 1.002) {
        return {
          id: 'london_judas_high',
          badge: '⚡ ASIA HIGH SWEPT',
          session: 'London Open (13:00–14:15 IST)',
          predictedDir: 'BEARISH REVERSAL',
          confidence: '62.7% London Extreme',
          headline: `⚡ Asia High Swept ($${asiaHigh.toFixed(1)}) — London Judas Swing`,
          detail: `62.7% of trading days form London's session extreme in this opening 45m window. Asia High was swept; watch for 15m twin rejection bars & 1m EMA bearish cross to fade back to Fib Magnet.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      return {
        id: 'london_open_hunt',
        badge: '🕒 LONDON OPEN WINDOW',
        session: 'London Open Active (13:00–14:30 IST)',
        predictedDir: 'WATCH FOR FAKE OPENING MOVE',
        confidence: '62.7% Session Extreme Window',
        headline: '🕒 London Opening Liquidity Hunt in Progress',
        detail: 'The first 45m of London frequently produces a fake run (Judas Swing) to engineer liquidity before the real trend starts. Look for traps at Asia High/Low.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 2. Pre-London Window: 12:00 to 13:00 IST (mins 720 to 750)
    if (mins >= 720 && mins < 750) {
      const slicePre = bars.slice(-4);
      const preDelta = (slicePre[slicePre.length - 1].c - slicePre[0].o) / slicePre[0].o * 100;
      if (preDelta > 0.20) {
        return {
          id: 'pre_london_pump',
          badge: '🕒 PRE-LONDON RAMP',
          session: 'Pre-London (12:00–13:00 IST)',
          predictedDir: 'POTENTIAL OPENING DUMP',
          confidence: '43% Reversal Tell',
          headline: '🕒 Pre-London Ramp (+0.2% into open)',
          detail: 'Slow upward grind in low pre-market volume often acts as bait. London open (13:00 IST) frequently counter-punches with a sharp fake dump.',
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      if (preDelta < -0.20) {
        return {
          id: 'pre_london_dump',
          badge: '🕒 PRE-LONDON SLIDE',
          session: 'Pre-London (12:00–13:00 IST)',
          predictedDir: 'POTENTIAL OPENING BOUNCE',
          confidence: '37% Reversal Tell',
          headline: '🕒 Pre-London Slide (-0.2% into open)',
          detail: 'Slow downward slide into London open. Watch for an opening liquidity flush below Asia Low to establish London session low.',
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
    }

    // 3. New York Open Window: 18:30 to 20:15 IST (mins 1110 to 1215)
    if (mins >= 1110 && mins <= 1215) {
      if (lonLow != null && minRecent < lonLow && price >= lonLow * 0.998) {
        return {
          id: 'ny_sweep_lon_low',
          badge: '⚡ LONDON LOW SWEPT',
          session: 'New York Open (18:30–20:00 IST)',
          predictedDir: 'BULLISH BOUNCE',
          confidence: '53.7% Historical Reversal',
          headline: `⚡ London Low Swept ($${lonLow.toFixed(1)}) — NY Opening Trap`,
          detail: `New York swept the London session low. 53.7% of the time, this is an opening liquidity grab that reverses back into the day's range. Watch 1m EMA cross for Long.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (lonHigh != null && maxRecent > lonHigh && price <= lonHigh * 1.002) {
        return {
          id: 'ny_sweep_lon_high',
          badge: '⚡ LONDON HIGH SWEPT',
          session: 'New York Open (18:30–20:00 IST)',
          predictedDir: 'BEARISH FADE',
          confidence: '48.4% Fade Odds',
          headline: `⚡ London High Swept ($${lonHigh.toFixed(1)}) — NY Liquidity Grab`,
          detail: `New York swept the London session high. Watch for rejection twin bars and 1m EMA rollover back towards the daily Fib anchor.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      return {
        id: 'ny_open_window',
        badge: '🕒 NY OPEN WINDOW',
        session: 'New York Open Active (18:30–20:00 IST)',
        predictedDir: 'WATCH NY SWEEP OF LONDON H/L',
        confidence: '56% Extreme Window',
        headline: '🕒 New York Opening Volatility Active',
        detail: '56.0% of days form NY session extreme in first 45m. Watch how price reacts around London High/Low levels.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 4. Daily Fib Magnet Pull (Any session post-03:30 IST)
    if (sessionBand && sessionBand.locked && Number.isFinite(sessionBand.f0) && Number.isFinite(sessionBand.f1)) {
      const { f0, f1 } = sessionBand;
      const distBelowPct = (f0 - price) / price * 100;
      const distAbovePct = (price - f1) / price * 100;

      if (distBelowPct >= 0.50) {
        return {
          id: 'fib_magnet_long',
          badge: '🧲 FIB MAGNET PULL',
          session: 'Daily Equilibrium Anchor',
          predictedDir: 'BULLISH MEAN REVERSION',
          confidence: '69.2% Fib Return Rate',
          headline: `🧲 Fib Magnet Pull (-${distBelowPct.toFixed(2)}% Stretched Below Fib)`,
          detail: `Price is stretched significantly below the daily mark window ($${f0.toFixed(1)}). In 730 days of data, 69.2% of sessions return to touch the Fib box. Look for Long tweezer bottom.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (distAbovePct >= 0.50) {
        return {
          id: 'fib_magnet_short',
          badge: '🧲 FIB MAGNET PULL',
          session: 'Daily Equilibrium Anchor',
          predictedDir: 'BEARISH MEAN REVERSION',
          confidence: '69.2% Fib Return Rate',
          headline: `🧲 Fib Magnet Pull (+${distAbovePct.toFixed(2)}% Stretched Above Fib)`,
          detail: `Price is stretched significantly above the daily mark window ($${f1.toFixed(1)}). In 730 days of data, 69.2% of sessions return to touch the Fib box. Look for Short tweezer top.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
    }

    // 5. Default Session Context
    return {
      id: 'session_standard',
      badge: hour < 12 ? '🌏 ASIA SESSION' : hour < 18 ? '🇬🇧 LONDON SESSION' : '🇺🇸 NY SESSION',
      session: 'Standard Flow',
      predictedDir: 'WAIT FOR SESSION OPEN OR FIB STRETCH',
      confidence: 'Market in Equilibrium',
      headline: `Holding between Fib Anchor & Session Pivots`,
      detail: `Price is trading near fair value. High-conviction tells appear at London Open (13:00 IST), NY Open (18:30 IST), or when price stretches ≥0.5% away from the Fib box.`,
      candleTime: lastBar.t,
      type: 'neutral',
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FibMagnet;
}
if (typeof window !== 'undefined') {
  window.FibMagnet = FibMagnet;
}
