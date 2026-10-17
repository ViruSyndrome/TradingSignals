'use strict';

/**
 * range_ema_engine.js — Prior-day range bands + EMA cross (futures long/short)
 *
 * Theory (mechanical translation):
 * 1. Every completed UTC day gets a range band: high / mid / low — NO day is skipped.
 * 2. Bands extend forward forever (used on later 30m bars).
 * 3. Trade EMA10/EMA30 cross on the working timeframe when price is interacting
 *    with at least one prior-day band (inside the day's range or touching H/M/L).
 * 4. Optional 4h EMA bias must agree.
 * 5. Stop = prior swing extreme (lookback). Take-profit = next prior-day band
 *    edge in trade direction (the "magnet"); fallback = R × risk.
 *
 * Browser: global RangeEmaEngine
 * Node:    module.exports
 */
const RangeEmaEngine = {

  DEFAULTS: {
    emaFast: 10,
    emaSlow: 30,
    swingLookback: 10,
    touchPct: 0.15,       // % distance to H/M/L to count as "touch"
    maxRiskPct: 5,        // skip if stop wider than this
    rFallback: 1.5,       // if no forward band target
    lookbackDays: 90,     // how many completed days of bands to keep
    requireBand: true,
    useHtfFilter: true,   // 4h EMA agree
    feePerSide: 0.0004,
  },

  ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let prev = sum / period;
    out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },

  utcDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  },

  /**
   * Build one band per completed UTC day from intraday bars.
   * All days — no selection. Mid = (high+low)/2.
   */
  buildDailyBands(bars, lookbackDays = 90) {
    const byDay = new Map();
    for (const b of bars) {
      const day = this.utcDay(b.t);
      if (!byDay.has(day)) byDay.set(day, { high: b.h, low: b.l });
      else {
        const d = byDay.get(day);
        d.high = Math.max(d.high, b.h);
        d.low = Math.min(d.low, b.l);
      }
    }
    const days = [...byDay.keys()].sort();
    // Drop incomplete current day if last bar is still that day and we want only completed —
    // caller should pass bars up to "now"; we keep all days present and let asOfDay filter.
    const bands = days.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        high: r.high,
        low: r.low,
        mid: (r.high + r.low) / 2,
      };
    });
    if (bands.length > lookbackDays) return bands.slice(-lookbackDays);
    return bands;
  },

  /** Prior days only (day < asOfDay). */
  priorBands(bands, asOfDay) {
    return bands.filter((b) => b.day < asOfDay);
  },

  /**
   * Price interacts with a prior-day band if:
   * - inside [low, high], or
   * - within touchPct of high, mid, or low.
   */
  interactingBands(bands, price, asOfDay, touchPct) {
    const prior = this.priorBands(bands, asOfDay);
    const hit = [];
    for (const b of prior) {
      const inside = price >= b.low && price <= b.high;
      const near =
        (Math.abs(price - b.high) / b.high) * 100 <= touchPct ||
        (Math.abs(price - b.mid) / b.mid) * 100 <= touchPct ||
        (Math.abs(price - b.low) / b.low) * 100 <= touchPct;
      if (inside || near) hit.push(b);
    }
    return hit;
  },

  /**
   * Next magnet: nearest prior-day level beyond entry in trade direction,
   * at least minDist away (avoids microscopic TPs when bands are dense).
   * Long → smallest level > entry+minDist; Short → largest < entry-minDist.
   */
  nextBandTarget(bands, entry, side, asOfDay, minDist = 0) {
    const prior = this.priorBands(bands, asOfDay);
    const levels = [];
    for (const b of prior) {
      levels.push(b.high, b.mid, b.low);
    }
    if (side === 'long') {
      let best = null;
      for (const lv of levels) {
        if (lv >= entry + minDist && (best == null || lv < best)) best = lv;
      }
      return best;
    }
    let best = null;
    for (const lv of levels) {
      if (lv <= entry - minDist && (best == null || lv > best)) best = lv;
    }
    return best;
  },

  swingExtreme(bars, i, lookback, side) {
    const from = Math.max(0, i - lookback);
    if (side === 'long') {
      let lo = bars[from].l;
      for (let j = from; j < i; j++) lo = Math.min(lo, bars[j].l);
      return lo;
    }
    let hi = bars[from].h;
    for (let j = from; j < i; j++) hi = Math.max(hi, bars[j].h);
    return hi;
  },

  htfBias(bars4h, t, emaFast, emaSlow) {
    if (!bars4h || !bars4h.length) return 'flat';
    let idx = 0;
    for (let i = 0; i < bars4h.length; i++) {
      if (bars4h[i].t <= t) idx = i;
      else break;
    }
    const closes = bars4h.map((b) => b.c);
    const f = this.ema(closes, emaFast);
    const s = this.ema(closes, emaSlow);
    if (f[idx] == null || s[idx] == null) return 'flat';
    if (f[idx] > s[idx]) return 'bull';
    if (f[idx] < s[idx]) return 'bear';
    return 'flat';
  },

  /**
   * Evaluate the latest closed bar (or bar at index i).
   * bars30 / bars4h: [{t,o,h,l,c}, ...] ascending.
   */
  evaluateAt(bars30, bars4h, i, cfg = {}) {
    const c = { ...this.DEFAULTS, ...cfg };
    if (i < Math.max(c.emaSlow + 2, c.swingLookback + 2)) return null;

    const closes = bars30.map((b) => b.c);
    const emaF = this.ema(closes, c.emaFast);
    const emaS = this.ema(closes, c.emaSlow);
    if (emaF[i] == null || emaS[i] == null || emaF[i - 1] == null || emaS[i - 1] == null) {
      return null;
    }

    const prevUp = emaF[i - 1] > emaS[i - 1];
    const prevDn = emaF[i - 1] < emaS[i - 1];
    const nowUp = emaF[i] > emaS[i];
    const nowDn = emaF[i] < emaS[i];

    let side = null;
    if (!prevUp && nowUp) side = 'long';
    if (!prevDn && nowDn) side = 'short';
    if (!side) return null;

    if (c.useHtfFilter) {
      const bias = this.htfBias(bars4h, bars30[i].t, c.emaFast, c.emaSlow);
      if (side === 'long' && bias !== 'bull') {
        return { skipped: true, reason: 'htf_disagree', side, bias };
      }
      if (side === 'short' && bias !== 'bear') {
        return { skipped: true, reason: 'htf_disagree', side, bias };
      }
    }

    const bands = this.buildDailyBands(bars30.slice(0, i + 1), c.lookbackDays);
    const asOfDay = this.utcDay(bars30[i].t);
    const entry = bars30[i].c;
    const active = this.interactingBands(bands, entry, asOfDay, c.touchPct);

    if (c.requireBand && !active.length) {
      return { skipped: true, reason: 'no_band_interaction', side, entry };
    }

    const swing = this.swingExtreme(bars30, i, c.swingLookback, side);
    const risk = side === 'long' ? entry - swing : swing - entry;
    if (risk <= 0) return { skipped: true, reason: 'zero_risk', side };
    const riskPct = (risk / entry) * 100;
    if (riskPct > c.maxRiskPct) {
      return { skipped: true, reason: 'risk_too_wide', side, riskPct };
    }

    const stop = side === 'long' ? entry - risk : entry + risk;
    // Require TP at least 0.8R away so dense all-day bands don't scalp pennies
    const minTpDist = risk * 0.8;
    let takeProfit = this.nextBandTarget(bands, entry, side, asOfDay, minTpDist);
    let tpReason = 'next_band';
    if (takeProfit == null) {
      const dist = risk * c.rFallback;
      takeProfit = side === 'long' ? entry + dist : entry - dist;
      tpReason = 'r_fallback';
    }
    // If next band is closer than a few ticks past stop distance in wrong way, keep it;
    // if TP is on wrong side of entry, fall back.
    if (side === 'long' && takeProfit <= entry) {
      takeProfit = entry + risk * c.rFallback;
      tpReason = 'r_fallback';
    }
    if (side === 'short' && takeProfit >= entry) {
      takeProfit = entry - risk * c.rFallback;
      tpReason = 'r_fallback';
    }

    return {
      skipped: false,
      side,
      entry,
      stop,
      takeProfit,
      riskPct,
      tpReason,
      asOfDay,
      activeBands: active.slice(-5),
      bandCountPrior: this.priorBands(bands, asOfDay).length,
      emaFast: emaF[i],
      emaSlow: emaS[i],
      t: bars30[i].t,
      index: i,
    };
  },

  /** Latest signal on the series (last bar). */
  evaluate(bars30, bars4h, cfg) {
    return this.evaluateAt(bars30, bars4h, bars30.length - 1, cfg);
  },

  /**
   * Walk-forward simulate non-overlapping trades.
   * Returns { trades, summary }.
   */
  backtest(bars30, bars4h, cfg = {}) {
    const c = { ...this.DEFAULTS, ...cfg };
    const trades = [];
    let i = Math.max(c.emaSlow + 2, c.swingLookback + 2);
    while (i < bars30.length - 2) {
      const sig = this.evaluateAt(bars30, bars4h, i, c);
      if (!sig || sig.skipped) {
        i++;
        continue;
      }

      let exit = null;
      let reason = null;
      let exitIdx = null;
      const { side, entry, stop, takeProfit } = sig;

      for (let j = i + 1; j < bars30.length; j++) {
        const b = bars30[j];
        if (side === 'long') {
          if (b.l <= stop) {
            exit = stop;
            reason = 'sl';
            exitIdx = j;
            break;
          }
          if (b.h >= takeProfit) {
            exit = takeProfit;
            reason = 'tp';
            exitIdx = j;
            break;
          }
        } else {
          if (b.h >= stop) {
            exit = stop;
            reason = 'sl';
            exitIdx = j;
            break;
          }
          if (b.l <= takeProfit) {
            exit = takeProfit;
            reason = 'tp';
            exitIdx = j;
            break;
          }
        }
      }
      if (exit == null) {
        exit = bars30[bars30.length - 1].c;
        reason = 'open';
        exitIdx = bars30.length - 1;
      }

      const raw = side === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
      const pnlPct = (raw - 2 * c.feePerSide) * 100;
      trades.push({
        side,
        entryT: sig.t,
        entry,
        stop,
        takeProfit,
        exit,
        reason,
        pnlPct,
        riskPct: sig.riskPct,
        tpReason: sig.tpReason,
        activeBandDays: (sig.activeBands || []).map((b) => b.day),
        barsHeld: exitIdx - i,
      });
      i = exitIdx + 1;
    }

    const wins = trades.filter((t) => t.pnlPct > 0);
    const sum = trades.reduce((a, t) => a + t.pnlPct, 0);
    return {
      trades,
      summary: {
        n: trades.length,
        winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
        avgPct: trades.length ? sum / trades.length : 0,
        sumPct: sum,
        longs: trades.filter((t) => t.side === 'long').length,
        shorts: trades.filter((t) => t.side === 'short').length,
        tp: trades.filter((t) => t.reason === 'tp').length,
        sl: trades.filter((t) => t.reason === 'sl').length,
      },
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RangeEmaEngine;
}
if (typeof window !== 'undefined') {
  window.RangeEmaEngine = RangeEmaEngine;
}
