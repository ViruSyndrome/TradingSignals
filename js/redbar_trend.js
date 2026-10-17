'use strict';

/**
 * redbar_trend.js — Red Bar / prior-day range TREND indicator (course-style, no paid tool)
 *
 * THIS is the trend-prediction layer ("finding gold"):
 *  1. Every completed day → high / mid / low band, extended forward (all days, no pick).
 *  2. Session opening range = first working-TF candle of the day — do not trade it;
 *     after it closes: break above high → bullish bias, break below low → bearish,
 *     stuck inside → no-trade zone.
 *  3. Where price sits vs prior-day bands: inside (balance) vs held break (trend).
 *  4. Last red bar: high = book/resistance reference, low = support reference.
 *
 * EMA is NOT part of this indicator. Overlay it separately if you want.
 *
 * Browser: RedBarTrend | Node: module.exports
 */
const RedBarTrend = {

  DEFAULTS: {
    lookbackDays: 90,
    touchPct: 0.15,
    /* Crypto has no NSE 9:15 — UTC day open is the default session clock */
    dayMode: 'utc', // 'utc' | 'ny' (America/New_York calendar day)
  },

  utcDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  },

  /** Calendar day string in a timezone (for NY session later). */
  zonedDay(ts, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(ts));
    } catch (_) {
      return this.utcDay(ts);
    }
  },

  dayKey(ts, dayMode) {
    if (dayMode === 'ny') return this.zonedDay(ts, 'America/New_York');
    return this.utcDay(ts);
  },

  buildDailyBands(bars, lookbackDays = 90, dayMode = 'utc') {
    const byDay = new Map();
    for (const b of bars) {
      const day = this.dayKey(b.t, dayMode);
      if (!byDay.has(day)) byDay.set(day, { high: b.h, low: b.l });
      else {
        const d = byDay.get(day);
        d.high = Math.max(d.high, b.h);
        d.low = Math.min(d.low, b.l);
      }
    }
    const days = [...byDay.keys()].sort();
    const bands = days.map((day) => {
      const r = byDay.get(day);
      return { day, high: r.high, low: r.low, mid: (r.high + r.low) / 2 };
    });
    return bands.length > lookbackDays ? bands.slice(-lookbackDays) : bands;
  },

  priorBands(bands, asOfDay) {
    return bands.filter((b) => b.day < asOfDay);
  },

  interactingBands(bands, price, asOfDay, touchPct) {
    const hit = [];
    for (const b of this.priorBands(bands, asOfDay)) {
      const inside = price >= b.low && price <= b.high;
      const near =
        (Math.abs(price - b.high) / b.high) * 100 <= touchPct ||
        (Math.abs(price - b.mid) / b.mid) * 100 <= touchPct ||
        (Math.abs(price - b.low) / b.low) * 100 <= touchPct;
      if (inside || near) hit.push(b);
    }
    return hit;
  },

  nearestLevels(bands, price, asOfDay) {
    const levels = [];
    for (const b of this.priorBands(bands, asOfDay)) {
      levels.push(b.high, b.mid, b.low);
    }
    let resist = null;
    let support = null;
    for (const lv of levels) {
      if (lv > price && (resist == null || lv < resist)) resist = lv;
      if (lv < price && (support == null || lv > support)) support = lv;
    }
    return { resist, support };
  },

  /**
   * First candle of asOfDay on this series = opening range.
   * Returns null if that candle is still the only / forming first bar.
   */
  openingRange(bars, asOfDay, dayMode) {
    let first = null;
    let firstIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (this.dayKey(bars[i].t, dayMode) === asOfDay) {
        first = bars[i];
        firstIdx = i;
        break;
      }
    }
    if (!first) return null;
    const complete = firstIdx < bars.length - 1 || true; // use closed high/low of first bar
    return {
      high: first.h,
      low: first.l,
      mid: (first.h + first.l) / 2,
      openT: first.t,
      index: firstIdx,
      /* True once at least one later bar exists — first candle is "ignored" for entries */
      locked: firstIdx < bars.length - 1,
    };
  },

  /** Most recent closed red candle (close < open) before or at index i. */
  lastRedBar(bars, i) {
    for (let j = i; j >= 0; j--) {
      if (bars[j].c < bars[j].o) {
        return {
          high: bars[j].h,
          low: bars[j].l,
          open: bars[j].o,
          close: bars[j].c,
          t: bars[j].t,
          index: j,
        };
      }
    }
    return null;
  },

  /**
   * Core readout at bar index i — trend prediction, not an auto-entry bot.
   */
  readAt(bars, i, cfg = {}) {
    const c = { ...this.DEFAULTS, ...cfg };
    if (!bars || i < 1) return null;

    const price = bars[i].c;
    const asOfDay = this.dayKey(bars[i].t, c.dayMode);
    const bands = this.buildDailyBands(bars.slice(0, i + 1), c.lookbackDays, c.dayMode);
    const prior = this.priorBands(bands, asOfDay);
    const active = this.interactingBands(bands, price, asOfDay, c.touchPct);
    const { resist, support } = this.nearestLevels(bands, price, asOfDay);
    const or = this.openingRange(bars.slice(0, i + 1), asOfDay, c.dayMode);
    const red = this.lastRedBar(bars, i);

    // Opening-range bias (Red Bar theory direction engine)
    let orBias = 'neutral';
    let phase = 'waiting_or';
    if (or && or.locked) {
      if (price > or.high) {
        orBias = 'bull';
        phase = 'break_above_or';
      } else if (price < or.low) {
        orBias = 'bear';
        phase = 'break_below_or';
      } else {
        orBias = 'neutral';
        phase = 'inside_or'; // no-trade zone vs first candle
      }
    } else if (or && !or.locked) {
      phase = 'first_candle'; // ignore — do not trade
      orBias = 'neutral';
    }

    // Band structure: balance vs held break
    let bandPhase = 'clear';
    if (active.length) {
      bandPhase = 'in_prior_band';
      // If OR already broke and we are still hugging a band → trend pullback into structure
      if (orBias === 'bull') bandPhase = 'bull_pullback_in_band';
      if (orBias === 'bear') bandPhase = 'bear_pullback_in_band';
    } else if (orBias === 'bull' && support != null && price > support) {
      bandPhase = 'bull_held_above_bands';
    } else if (orBias === 'bear' && resist != null && price < resist) {
      bandPhase = 'bear_held_below_bands';
    }

    // Composite trend (the prediction)
    let trend = 'neutral';
    if (orBias === 'bull' && bandPhase !== 'inside_or') trend = 'bullish';
    if (orBias === 'bear' && bandPhase !== 'inside_or') trend = 'bearish';
    if (phase === 'inside_or' || phase === 'first_candle') trend = 'neutral';

    // Suggested reference levels (what YOU do with them is optional)
    const refs = {
      orHigh: or ? or.high : null,
      orLow: or ? or.low : null,
      bandResist: resist,
      bandSupport: support,
      redHigh: red ? red.high : null,
      redLow: red ? red.low : null,
    };

    // Book-profit zone for a long: red bar high (as in the course videos)
    // Invalidation lean: opposite side of OR or active band
    let invalidation = null;
    let bookZone = null;
    if (trend === 'bullish') {
      invalidation = or ? or.low : support;
      bookZone = red ? red.high : resist;
    } else if (trend === 'bearish') {
      invalidation = or ? or.high : resist;
      bookZone = red ? red.low : support;
    }

    const narrative = this._narrative({
      trend,
      phase,
      bandPhase,
      activeCount: active.length,
      orBias,
    });

    return {
      t: bars[i].t,
      price,
      asOfDay,
      trend, // bullish | bearish | neutral  ← the gold
      orBias,
      phase,
      bandPhase,
      narrative,
      openingRange: or,
      lastRedBar: red,
      activeBands: active.slice(-8),
      bandCountPrior: prior.length,
      refs,
      invalidation,
      bookZone,
    };
  },

  read(bars, cfg) {
    return this.readAt(bars, bars.length - 1, cfg);
  },

  _narrative({ trend, phase, bandPhase, activeCount, orBias }) {
    if (phase === 'first_candle') {
      return 'First candle of the day — mark high/low only; do not trade yet.';
    }
    if (phase === 'inside_or') {
      return 'Price inside today’s opening range (no-trade zone). Wait for a break of that high or low.';
    }
    if (trend === 'bullish') {
      if (bandPhase.includes('pullback') || activeCount) {
        return 'Bullish (above opening range). Price is back in a prior-day band — classic pullback into old range; watch for hold then continuation.';
      }
      return 'Bullish (broke above opening range). Prior-day bands above are magnets; red-bar high is a book-profit reference.';
    }
    if (trend === 'bearish') {
      if (bandPhase.includes('pullback') || activeCount) {
        return 'Bearish (below opening range). Price is back in a prior-day band — pullback into old range; watch for rejection then continuation down.';
      }
      return 'Bearish (broke below opening range). Prior-day bands below are magnets; red-bar low is a book-profit reference for shorts.';
    }
    return 'No clear opening-range break yet. Prior-day bands still matter as magnets when price reaches them.';
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RedBarTrend;
}
if (typeof window !== 'undefined') {
  window.RedBarTrend = RedBarTrend;
}
