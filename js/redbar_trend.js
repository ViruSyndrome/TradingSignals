'use strict';

/**
 * redbar_trend.js — Red Bar / prior-day range TREND indicator (course-style, no paid tool)
 *
 * THIS is the trend-prediction layer ("finding gold"):
 *  1. Magnets = prior session ranges (full day H/L/M, OR 02:30 IST fib on BTC).
 *  2. Opening range = first candle of the desk day / 02:30 IST anchor candle —
 *     do not trade it; after lock: break above → bull, below → bear, inside → WAIT.
 *  3. Where price sits vs prior bands: inside (balance) vs held break (trend).
 *  4. Last red bar / swings: book & stop references.
 *
 * EMA is NOT part of this indicator. Overlay it separately if you want.
 *
 * Browser: RedBarTrend | Node: module.exports
 */
const RedBarTrend = {

  DEFAULTS: {
    lookbackDays: 90,
    touchPct: 0.15,
    chartBandDays: 7,
    swingPivot: 3,
    /* Day clock for opening-range / prior-day bands */
    dayMode: 'utc', // 'utc' | 'ny' | 'ist'
    /* 'dayHl' = full calendar-day H/L/M | 'istFib0230' = Fib on 02:30 IST candle */
    bandStyle: 'dayHl',
    fibLevels: [0, 0.44, 0.5, 0.56, 1],
    orAnchor: null, // { timeZone, hour, minute } — when set, OR = that candle
  },

  utcDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  },

  /** Calendar day string in a timezone. */
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
    if (dayMode === 'ist') return this.zonedDay(ts, 'Asia/Kolkata');
    return this.utcDay(ts);
  },

  /** Calendar day ± n days (YYYY-MM-DD arithmetic in local noon UTC). */
  shiftDay(dayStr, delta) {
    const t = Date.parse(`${dayStr}T12:00:00Z`) + delta * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  },

  zonedHms(ts, timeZone) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts))) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    return {
      day: `${parts.year}-${parts.month}-${parts.day}`,
      hour: parseInt(parts.hour, 10),
      minute: parseInt(parts.minute, 10),
    };
  },

  /**
   * Session day for an anchor clock (e.g. 02:30 IST).
   * Before the anchor → still previous session day.
   */
  sessionDayKey(ts, anchor) {
    const tz = (anchor && anchor.timeZone) || 'Asia/Kolkata';
    const h = (anchor && anchor.hour) != null ? anchor.hour : 2;
    const m = (anchor && anchor.minute) != null ? anchor.minute : 30;
    const p = this.zonedHms(ts, tz);
    if (p.hour < h || (p.hour === h && p.minute < m)) return this.shiftDay(p.day, -1);
    return p.day;
  },

  /** UTC ms when hour:minute occurs on calendar dayStr in timeZone. */
  zonedClockToUtc(dayStr, timeZone, hour, minute) {
    const targetHm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const base = Date.parse(`${dayStr}T12:00:00Z`);
    let lo = base - 36 * 3600 * 1000;
    let hi = base + 36 * 3600 * 1000;
    const fmtDay = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const fmtHm = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    while (hi - lo > 30 * 1000) {
      const mid = Math.floor((lo + hi) / 2);
      const d = new Date(mid);
      const day = fmtDay.format(d);
      const hm = fmtHm.format(d);
      if (day < dayStr || (day === dayStr && hm < targetHm)) lo = mid;
      else hi = mid;
    }
    return hi;
  },

  /** Fib price on candle range (0 = low / bottom, 1 = high / top — matches TV shot). */
  fibPrice(high, low, level) {
    return low + (high - low) * level;
  },

  /**
   * Bar whose open is at (or nearest containing) the session anchor on dayStr.
   */
  findAnchorBar(bars, dayStr, anchor) {
    if (!bars || !bars.length || !dayStr) return null;
    const tz = (anchor && anchor.timeZone) || 'Asia/Kolkata';
    const h = (anchor && anchor.hour) != null ? anchor.hour : 2;
    const m = (anchor && anchor.minute) != null ? anchor.minute : 30;
    const target = this.zonedClockToUtc(dayStr, tz, h, m);
    const barMs = bars.length > 1 ? Math.abs(bars[1].t - bars[0].t) : 30 * 60 * 1000;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const open = b.t;
      const close = b.t + barMs;
      if (target >= open && target < close) return { bar: b, index: i };
      const dist = Math.abs(open - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = { bar: b, index: i };
      }
    }
    if (best && bestDist <= barMs * 1.1) return best;
    return null;
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
      return {
        day,
        high: r.high,
        low: r.low,
        mid: (r.high + r.low) / 2,
        style: 'dayHl',
      };
    });
    return bands.length > lookbackDays ? bands.slice(-lookbackDays) : bands;
  },

  /**
   * Friend's TV method: Fib 0 / 0.44 / 0.5 / 0.56 / 1 on each 02:30 IST candle,
   * extended forward. One band per session day.
   */
  buildIstFibBands(bars, lookbackDays = 90, cfg = {}) {
    const anchor = cfg.orAnchor || { timeZone: 'Asia/Kolkata', hour: 2, minute: 30 };
    const levels = Array.isArray(cfg.fibLevels) && cfg.fibLevels.length
      ? cfg.fibLevels
      : [0, 0.44, 0.5, 0.56, 1];
    const days = new Set();
    for (const b of bars) days.add(this.zonedDay(b.t, anchor.timeZone || 'Asia/Kolkata'));
    // Also include previous calendar day so early-session bars still find yesterday's fib
    const sortedDays = [...days].sort();
    if (sortedDays.length) days.add(this.shiftDay(sortedDays[0], -1));

    const bands = [];
    for (const day of [...days].sort()) {
      const hit = this.findAnchorBar(bars, day, anchor);
      if (!hit) continue;
      const { bar, index } = hit;
      const high = bar.h;
      const low = bar.l;
      if (!(high > low)) continue;
      const fib = {};
      for (const lv of levels) fib[`f${String(lv).replace('.', '_')}`] = this.fibPrice(high, low, lv);
      bands.push({
        day,
        high,
        low,
        mid: this.fibPrice(high, low, 0.5),
        f0: this.fibPrice(high, low, 0),
        f44: this.fibPrice(high, low, 0.44),
        f50: this.fibPrice(high, low, 0.5),
        f56: this.fibPrice(high, low, 0.56),
        f1: this.fibPrice(high, low, 1),
        openT: bar.t,
        index,
        style: 'istFib0230',
        levels: fib,
      });
    }
    return bands.length > lookbackDays ? bands.slice(-lookbackDays) : bands;
  },

  buildBands(bars, cfg) {
    if (cfg.bandStyle === 'istFib0230') {
      return this.buildIstFibBands(bars, cfg.lookbackDays || 90, cfg);
    }
    return this.buildDailyBands(bars, cfg.lookbackDays || 90, cfg.dayMode || 'utc');
  },

  asOfDayFor(ts, cfg) {
    if (cfg.bandStyle === 'istFib0230' || cfg.orAnchor) {
      return this.sessionDayKey(ts, cfg.orAnchor || { timeZone: 'Asia/Kolkata', hour: 2, minute: 30 });
    }
    return this.dayKey(ts, cfg.dayMode || 'utc');
  },

  priorBands(bands, asOfDay) {
    return bands.filter((b) => b.day < asOfDay);
  },

  bandLevelList(b) {
    if (b.style === 'istFib0230') {
      return [b.f1, b.f56, b.f50, b.f44, b.f0].filter((v) => v != null && Number.isFinite(v));
    }
    return [b.high, b.mid, b.low].filter((v) => v != null && Number.isFinite(v));
  },

  interactingBands(bands, price, asOfDay, touchPct) {
    const hit = [];
    for (const b of this.priorBands(bands, asOfDay)) {
      const inside = price >= b.low && price <= b.high;
      let near = false;
      for (const lv of this.bandLevelList(b)) {
        if ((Math.abs(price - lv) / lv) * 100 <= touchPct) {
          near = true;
          break;
        }
      }
      if (inside || near) hit.push(b);
    }
    return hit;
  },

  nearestLevels(bands, price, asOfDay) {
    const levels = [];
    for (const b of this.priorBands(bands, asOfDay)) {
      levels.push(...this.bandLevelList(b));
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
   * Swing high/low on the working TF (TV-style prior peaks).
   * - swingHigh / swingLow: most recent completed swing above/below price (previous high/low).
   * - nearHigh / nearLow: closest-in-price swing (may be a minor nearer peak).
   */
  nearestSwings(bars, i, pivot = 3) {
    let swingHigh = null;
    let swingLow = null;
    let nearHigh = null;
    let nearLow = null;
    if (!bars || i < pivot * 2) {
      return { swingHigh, swingLow, nearHigh, nearLow };
    }
    const price = bars[i].c;
    const end = i - pivot; // only completed swings
    for (let j = pivot; j <= end; j++) {
      let isHigh = true;
      let isLow = true;
      for (let k = 1; k <= pivot; k++) {
        if (bars[j].h <= bars[j - k].h || bars[j].h <= bars[j + k].h) isHigh = false;
        if (bars[j].l >= bars[j - k].l || bars[j].l >= bars[j + k].l) isLow = false;
      }
      if (isHigh && bars[j].h > price) {
        swingHigh = bars[j].h; // last write = most recent in time
        if (nearHigh == null || bars[j].h < nearHigh) nearHigh = bars[j].h;
      }
      if (isLow && bars[j].l < price) {
        swingLow = bars[j].l;
        if (nearLow == null || bars[j].l > nearLow) nearLow = bars[j].l;
      }
    }
    // Prefer the most recent prior peak for book; fall back to nearest-in-price
    if (swingHigh == null) swingHigh = nearHigh;
    if (swingLow == null) swingLow = nearLow;
    return { swingHigh, swingLow, nearHigh, nearLow };
  },

  /**
   * Opening range = first candle of asOfDay, OR the session-anchor candle
   * (e.g. 02:30 IST) when orAnchor / istFib0230 is configured.
   */
  openingRange(bars, asOfDay, dayMode, cfg = {}) {
    let first = null;
    let firstIdx = -1;
    if (cfg.orAnchor || cfg.bandStyle === 'istFib0230') {
      const anchor = cfg.orAnchor || { timeZone: 'Asia/Kolkata', hour: 2, minute: 30 };
      const hit = this.findAnchorBar(bars, asOfDay, anchor);
      if (hit) {
        first = hit.bar;
        firstIdx = hit.index;
      }
    } else {
      for (let i = 0; i < bars.length; i++) {
        if (this.dayKey(bars[i].t, dayMode) === asOfDay) {
          first = bars[i];
          firstIdx = i;
          break;
        }
      }
    }
    if (!first) return null;
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
    const slice = bars.slice(0, i + 1);
    const asOfDay = this.asOfDayFor(bars[i].t, c);
    const bands = this.buildBands(slice, c);
    const prior = this.priorBands(bands, asOfDay);
    const active = this.interactingBands(bands, price, asOfDay, c.touchPct);
    const { resist, support } = this.nearestLevels(bands, price, asOfDay);
    const { swingHigh, swingLow } = this.nearestSwings(bars, i, c.swingPivot || 3);
    const or = this.openingRange(slice, asOfDay, c.dayMode, c);
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

    // Book-profit: prefer nearest prior swing (TV-style previous high/low),
    // then red-bar ref, then prior-day band.
    let invalidation = null;
    let bookZone = null;
    if (trend === 'bullish') {
      invalidation = or ? or.low : (swingLow != null ? swingLow : support);
      bookZone = swingHigh != null ? swingHigh : (red ? red.high : resist);
    } else if (trend === 'bearish') {
      invalidation = or ? or.high : (swingHigh != null ? swingHigh : resist);
      bookZone = swingLow != null ? swingLow : (red ? red.low : support);
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
      // Last N prior session magnets (day H/L/M or 02:30 IST fibs)
      recentBands: prior.slice(-(c.chartBandDays || 7)).map((b) => ({
        day: b.day,
        high: b.high,
        mid: b.mid,
        low: b.low,
        style: b.style || 'dayHl',
        f0: b.f0,
        f44: b.f44,
        f50: b.f50,
        f56: b.f56,
        f1: b.f1,
        openT: b.openT,
        index: b.index,
      })),
      bandCountPrior: prior.length,
      bandStyle: c.bandStyle || 'dayHl',
      // Today's 02:30 fib / day range (extends right on the chart)
      currentBand: bands.find((b) => b.day === asOfDay) || null,
      refs: {
        ...refs,
        swingHigh,
        swingLow,
      },
      invalidation,
      bookZone,
    };
  },

  read(bars, cfg) {
    return this.readAt(bars, bars.length - 1, cfg);
  },

  _narrative({ trend, phase, bandPhase, activeCount, orBias }) {
    if (phase === 'first_candle') {
      return 'Anchor candle (02:30 IST / day open) — mark high/low only; do not trade yet.';
    }
    if (phase === 'inside_or') {
      return 'Price inside today’s opening range / 02:30 fib box (no-trade zone). Wait for a break of that high or low.';
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
