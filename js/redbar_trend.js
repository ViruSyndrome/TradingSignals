'use strict';

/**
 * redbar_trend.js — Red Bar / session-mark TREND indicator (course-style, no paid tool)
 *
 * Sagar desk playbook (what we predict from):
 *  1. Magnets = Fib 0/0.44/0.5/0.56/1 on each mark window
 *     (BTC 02:30–03:30, XAU 01:30–02:30, Nifty 15:15–15:45 IST).
 *  2. Pivot = first 1H red of the session day (trade 1 leave / trade 2 revisit).
 *  3. Stop = prior swing; book = prior calendar-day H/L (then swing / fib).
 *  4. Clock: pre-London continuation → London hunts Asia H/L → US hunts London
 *     (and Asia if untouched); US open often needs 1m for the “zoom” entry.
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
    /* Day clock for dayHl mode */
    dayMode: 'utc', // 'utc' | 'ny' | 'ist'
    /* 'dayHl' | 'sessionFib' (alias: istFib0230) */
    bandStyle: 'dayHl',
    fibLevels: [0, 0.44, 0.5, 0.56, 1],
    /* Mark window: aggregate H/L over [start, end) then Fib — e.g. BTC 02:30–03:30 IST */
    markWindow: null, // { timeZone, startHour, startMinute, endHour, endMinute }
    orAnchor: null, // legacy single-candle → treated as start; prefer markWindow
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

  /** Normalize markWindow from cfg (supports legacy orAnchor). */
  getMarkWindow(cfg = {}) {
    if (cfg.markWindow && cfg.markWindow.timeZone) return cfg.markWindow;
    if (cfg.orAnchor) {
      const a = cfg.orAnchor;
      const sh = a.hour != null ? a.hour : 2;
      const sm = a.minute != null ? a.minute : 30;
      // Legacy: single candle → 1h window from that clock
      let eh = sh + 1;
      let em = sm;
      if (eh >= 24) eh -= 24;
      return {
        timeZone: a.timeZone || 'Asia/Kolkata',
        startHour: sh,
        startMinute: sm,
        endHour: eh,
        endMinute: em,
      };
    }
    return null;
  },

  isSessionFib(cfg = {}) {
    const s = cfg.bandStyle;
    return s === 'sessionFib' || s === 'istFib0230';
  },

  /**
   * Session day for a mark window: before window START → previous calendar day.
   * (Today's fib belongs to calendar day D once that day's window has begun.)
   */
  sessionDayKey(ts, windowOrAnchor) {
    const w = windowOrAnchor && windowOrAnchor.startHour != null
      ? windowOrAnchor
      : this.getMarkWindow({ orAnchor: windowOrAnchor, markWindow: windowOrAnchor });
    const tz = (w && w.timeZone) || 'Asia/Kolkata';
    const h = w && w.startHour != null ? w.startHour : 2;
    const m = w && w.startMinute != null ? w.startMinute : 30;
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
   * Aggregate H/L of all bars that overlap [start, end) on dayStr.
   * e.g. BTC 02:30–03:30 IST = last hour before “universal” open.
   * Uses overlap (not open-only) so binary-search clock skew cannot drop the open bar.
   */
  findMarkWindowRange(bars, dayStr, window) {
    if (!bars || !bars.length || !dayStr || !window) return null;
    const tz = window.timeZone || 'Asia/Kolkata';
    const t0 = this.zonedClockToUtc(dayStr, tz, window.startHour, window.startMinute);
    const t1 = this.zonedClockToUtc(dayStr, tz, window.endHour, window.endMinute);
    if (!(t1 > t0)) return null;
    let high = -Infinity;
    let low = Infinity;
    let i0 = -1;
    let i1 = -1;
    let openT = null;
    // Open-in-window with slack: clock search can sit a few seconds after true HH:MM,
    // which would otherwise drop the exact open bar or pull in the end bar.
    const openFrom = t0 - 90 * 1000;
    const openUntil = t1 - 30 * 1000;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.t >= openFrom && b.t < openUntil) {
        if (i0 < 0) {
          i0 = i;
          openT = b.t;
        }
        i1 = i;
        high = Math.max(high, b.h);
        low = Math.min(low, b.l);
      }
    }
    if (i0 < 0 || !(high > low) || !Number.isFinite(high) || !Number.isFinite(low)) return null;
    return { high, low, i0, i1, openT, t0, t1 };
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
   * Fib 0 / 0.44 / 0.5 / 0.56 / 1 on each day's mark window H/L, extended forward.
   */
  buildSessionFibBands(bars, lookbackDays = 90, cfg = {}) {
    const window = this.getMarkWindow(cfg);
    if (!window) return [];
    const levels = Array.isArray(cfg.fibLevels) && cfg.fibLevels.length
      ? cfg.fibLevels
      : [0, 0.44, 0.5, 0.56, 1];
    const tz = window.timeZone || 'Asia/Kolkata';
    const days = new Set();
    for (const b of bars) days.add(this.zonedDay(b.t, tz));
    const sortedDays = [...days].sort();
    if (sortedDays.length) days.add(this.shiftDay(sortedDays[0], -1));

    const bands = [];
    for (const day of [...days].sort()) {
      const hit = this.findMarkWindowRange(bars, day, window);
      if (!hit) continue;
      const { high, low, i0, openT } = hit;
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
        openT,
        index: i0,
        i1Mark: hit.i1,
        t0: hit.t0,
        t1: hit.t1,
        style: 'sessionFib',
        levels: fib,
      });
    }
    return bands.length > lookbackDays ? bands.slice(-lookbackDays) : bands;
  },

  buildBands(bars, cfg) {
    if (this.isSessionFib(cfg) && this.getMarkWindow(cfg)) {
      return this.buildSessionFibBands(bars, cfg.lookbackDays || 90, cfg);
    }
    return this.buildDailyBands(bars, cfg.lookbackDays || 90, cfg.dayMode || 'utc');
  },

  asOfDayFor(ts, cfg) {
    const w = this.getMarkWindow(cfg);
    if (w) return this.sessionDayKey(ts, w);
    return this.dayKey(ts, cfg.dayMode || 'utc');
  },

  priorBands(bands, asOfDay) {
    return bands.filter((b) => b.day < asOfDay);
  },

  bandLevelList(b) {
    if (b.style === 'sessionFib' || b.style === 'istFib0230') {
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
   * Opening range = mark-window H/L (sessionFib), else first candle of asOfDay.
   * Locked only after the mark window END (institutions done / range complete).
   */
  openingRange(bars, asOfDay, dayMode, cfg = {}) {
    const window = this.getMarkWindow(cfg);
    if (window && this.isSessionFib(cfg)) {
      const hit = this.findMarkWindowRange(bars, asOfDay, window);
      if (!hit) return null;
      const lastT = bars.length ? bars[bars.length - 1].t : 0;
      const locked = lastT >= hit.t1;
      return {
        high: hit.high,
        low: hit.low,
        mid: (hit.high + hit.low) / 2,
        openT: hit.openT,
        index: hit.i0,
        indexEnd: hit.i1,
        t0: hit.t0,
        t1: hit.t1,
        locked,
      };
    }
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
    return {
      high: first.h,
      low: first.l,
      mid: (first.h + first.l) / 2,
      openT: first.t,
      index: firstIdx,
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
   * First red on the calendar day (Sagar: 1H first-red pivot).
   * - Use calendar dayKey (IST), NOT mark-window session day — fibs and first-red
   *   are separate: fibs = mark window; pivot = first red after day open.
   * - Never mark the day’s first candle even if it is red.
   * - Only closed bars (skip the still-forming candle).
   */
  firstRedBarOfSession(bars, asOfDay, cfg = {}) {
    if (!bars || !bars.length || !asOfDay) return null;
    const dayMode = cfg.dayMode || 'ist';
    const now = cfg.asOfTs != null ? cfg.asOfTs : Date.now();
    const barMs = cfg.barMs != null ? cfg.barMs : 3600000; // 1H default
    const dayBars = [];
    for (let i = 0; i < bars.length; i++) {
      if (this.dayKey(bars[i].t, dayMode) !== asOfDay) continue;
      if (bars[i].t + barMs > now) continue; // still forming
      dayBars.push({ bar: bars[i], index: i });
    }
    // Need at least open bar + one later bar
    for (let j = 1; j < dayBars.length; j++) {
      const { bar, index } = dayBars[j];
      if (bar.c < bar.o) {
        return {
          high: bar.h,
          low: bar.l,
          open: bar.o,
          close: bar.c,
          t: bar.t,
          index,
          asOfDay,
          skippedOpen: true,
        };
      }
    }
    return null;
  },

  /** Full calendar-day H/L in dayMode (Sagar book magnets = prior day H/L). */
  calendarDayHl(bars, day, dayMode = 'ist') {
    if (!bars || !day) return null;
    let high = null;
    let low = null;
    for (const b of bars) {
      if (this.dayKey(b.t, dayMode) !== day) continue;
      high = high == null ? b.h : Math.max(high, b.h);
      low = low == null ? b.l : Math.min(low, b.l);
    }
    if (high == null) return null;
    return { day, high, low, mid: (high + low) / 2 };
  },

  /** H/L of one exchange session for the IST calendar day that contains `asOfTs`. */
  sessionHlForIstDay(bars, session, asOfTs) {
    if (!bars || !session || !session.timeZone || !asOfTs) return null;
    const istDay = this.zonedDay(asOfTs, 'Asia/Kolkata');
    const openH = (session.open && session.open[0]) || 0;
    const openM = (session.open && session.open[1]) || 0;
    const closeH = (session.close && session.close[0]) || 23;
    const closeM = (session.close && session.close[1]) || 59;
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    let high = null;
    let low = null;
    let touched = false;
    for (const b of bars) {
      if (this.zonedDay(b.t, 'Asia/Kolkata') !== istDay) continue;
      const z = this.zonedHms(b.t, session.timeZone);
      const mins = z.hour * 60 + z.minute;
      const inSession = closeMins > openMins
        ? (mins >= openMins && mins < closeMins)
        : (mins >= openMins || mins < closeMins);
      if (!inSession) continue;
      touched = true;
      high = high == null ? b.h : Math.max(high, b.h);
      low = low == null ? b.l : Math.min(low, b.l);
    }
    if (!touched || high == null) return null;
    return {
      id: session.id || session.label || 'session',
      label: session.label || session.id || 'Session',
      high,
      low,
      mid: (high + low) / 2,
    };
  },

  /**
   * IST clock phase for BTC/XAU session flow (Sagar).
   * Pre-London continuation → London Asia sweep → US London/Asia hunt.
   */
  istClockPhase(ts) {
    const z = this.zonedHms(ts || Date.now(), 'Asia/Kolkata');
    const mins = z.hour * 60 + z.minute;
    if (mins < 12 * 60 + 30) {
      return {
        id: 'pre_london',
        label: 'Pre-London',
        tip: 'Until ~12:30 IST, BTC often keeps the morning direction.',
      };
    }
    if (mins < 16 * 60 + 30) {
      return {
        id: 'london',
        label: 'London',
        tip: 'London usually sweeps Asia high or low, then reverses.',
      };
    }
    if (mins < 18 * 60 + 30) {
      return {
        id: 'us_open',
        label: 'US open',
        tip: 'US hunts London H/L (Asia if untouched). Heavy window ~4:30–6:30 IST — use 1m when it zooms.',
      };
    }
    return {
      id: 'late',
      label: 'After US open',
      tip: 'Pivot stays the first 1H red; watch prior-day H/L as book magnets.',
    };
  },

  /**
   * First-red trade setup: trade 1 (leave the bar) / trade 2 (2–3h revisit).
   */
  firstRedSetup(price, firstRed, asOfTs, touchPct = 0.15) {
    if (!firstRed || price == null) {
      return { id: 'no_red', label: 'No 1H first red yet', near: false, hoursSince: null };
    }
    const hoursSince = asOfTs != null && firstRed.t != null
      ? (asOfTs - firstRed.t) / 3600000
      : null;
    const nearHigh = (Math.abs(price - firstRed.high) / firstRed.high) * 100 <= touchPct;
    const nearLow = (Math.abs(price - firstRed.low) / firstRed.low) * 100 <= touchPct;
    const inside = price <= firstRed.high && price >= firstRed.low;
    const near = nearHigh || nearLow || inside;
    const leftAbove = price > firstRed.high && !nearHigh;
    const leftBelow = price < firstRed.low && !nearLow;
    // Sagar: after ~2–3h price often revisits the first-red level
    const revisitWindow = near && hoursSince != null && hoursSince >= 1.5 && hoursSince <= 6;
    let id = 'marked';
    let label = '1H first red marked';
    if (revisitWindow) {
      id = 'trade2_revisit';
      label = 'Trade 2 · revisit of 1H first red';
    } else if (leftAbove || leftBelow) {
      id = 'trade1_away';
      label = leftAbove ? 'Trade 1 · left above first red' : 'Trade 1 · left below first red';
    } else if (near) {
      id = 'at_pivot';
      label = 'At 1H first-red pivot';
    }
    return {
      id,
      label,
      near,
      hoursSince,
      revisitWindow,
      leftAbove,
      leftBelow,
      pivotHigh: firstRed.high,
      pivotLow: firstRed.low,
    };
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

    const firstRed1h = c.firstRed1h || null;
    const dayMode = c.dayMode || 'ist';
    const istDay = this.zonedDay(bars[i].t, 'Asia/Kolkata');
    const priorDayStr = this.shiftDay(istDay, -1);
    const priorDay = this.calendarDayHl(slice, priorDayStr, dayMode);
    const clock = this.istClockPhase(bars[i].t);
    const redSetup = this.firstRedSetup(price, firstRed1h, bars[i].t, c.touchPct ?? 0.15);

    const sessions = Array.isArray(c.sessions) ? c.sessions : [];
    const asiaSess = sessions.find((s) => (s.id || '').toLowerCase() === 'asia')
      || sessions.find((s) => /asia/i.test(s.label || ''));
    const londonSess = sessions.find((s) => (s.id || '').toLowerCase() === 'london')
      || sessions.find((s) => /london/i.test(s.label || ''));
    const asiaHl = asiaSess ? this.sessionHlForIstDay(slice, asiaSess, bars[i].t) : null;
    const londonHl = londonSess ? this.sessionHlForIstDay(slice, londonSess, bars[i].t) : null;
    const asiaUntouched = !!(asiaHl && price < asiaHl.high && price > asiaHl.low);

    // Suggested reference levels (what YOU do with them is optional)
    const refs = {
      orHigh: or ? or.high : null,
      orLow: or ? or.low : null,
      bandResist: resist,
      bandSupport: support,
      redHigh: red ? red.high : null,
      redLow: red ? red.low : null,
      priorDayHigh: priorDay ? priorDay.high : null,
      priorDayLow: priorDay ? priorDay.low : null,
      asiaHigh: asiaHl ? asiaHl.high : null,
      asiaLow: asiaHl ? asiaHl.low : null,
      londonHigh: londonHl ? londonHl.high : null,
      londonLow: londonHl ? londonHl.low : null,
      firstRed1hHigh: firstRed1h ? firstRed1h.high : null,
      firstRed1hLow: firstRed1h ? firstRed1h.low : null,
    };

    // Sagar: stop = prior swing; book = prior-day H/L when still ahead of price, else swing / fib
    let invalidation = null;
    let bookZone = null;
    if (trend === 'bullish') {
      invalidation = swingLow != null ? swingLow : (or ? or.low : support);
      const pdh = priorDay?.high;
      bookZone = (pdh != null && pdh > price)
        ? pdh
        : (swingHigh != null ? swingHigh : (red ? red.high : resist));
    } else if (trend === 'bearish') {
      invalidation = swingHigh != null ? swingHigh : (or ? or.high : resist);
      const pdl = priorDay?.low;
      bookZone = (pdl != null && pdl < price)
        ? pdl
        : (swingLow != null ? swingLow : (red ? red.low : support));
    }

    const playbook = {
      clock,
      redSetup,
      priorDay,
      asiaHl,
      londonHl,
      asiaUntouched,
      liquidityTip: this._liquidityTip(clock, asiaHl, londonHl, asiaUntouched),
    };

    const narrative = this._narrative({
      trend,
      phase,
      bandPhase,
      activeCount: active.length,
      orBias,
      playbook,
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
      firstRed1h,
      playbook,
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

  _liquidityTip(clock, asiaHl, londonHl, asiaUntouched) {
    if (!clock) return '';
    if (clock.id === 'london' && asiaHl) {
      return `London liquidity: Asia ${asiaHl.high.toFixed?.(0) ?? asiaHl.high} / ${asiaHl.low.toFixed?.(0) ?? asiaHl.low}`;
    }
    if (clock.id === 'us_open') {
      const bits = [];
      if (londonHl) bits.push(`London ${londonHl.high.toFixed?.(0) ?? londonHl.high} / ${londonHl.low.toFixed?.(0) ?? londonHl.low}`);
      if (asiaUntouched && asiaHl) bits.push('Asia still inside — may get hunted');
      return bits.length ? `US hunt: ${bits.join(' · ')}` : clock.tip;
    }
    return clock.tip || '';
  },

  _narrative({ trend, phase, bandPhase, activeCount, orBias, playbook }) {
    const clockBit = playbook?.clock?.tip ? ` ${playbook.clock.tip}` : '';
    const redBit = playbook?.redSetup?.id === 'trade2_revisit'
      ? ' Price is back at the 1H first-red pivot — Trade 2 window: watch reject vs reverse.'
      : playbook?.redSetup?.id === 'trade1_away'
        ? ' Price has left the 1H first red — Trade 1 style: stop at prior swing, book toward prior-day H/L.'
        : '';

    if (phase === 'first_candle') {
      return 'Mark window still forming — record high/low only; do not trade until it locks.';
    }
    if (phase === 'inside_or') {
      return `Price inside today’s mark-window fib box (no-trade zone). Wait for a break of Fib 0 / Fib 1.${clockBit}`;
    }
    if (trend === 'bullish') {
      if (bandPhase.includes('pullback') || activeCount) {
        return `Bullish (above mark-window fib). Pullback into a prior-session band — hold then continuation.${redBit}${clockBit}`;
      }
      return `Bullish (broke above mark-window Fib 0/1). Book toward prior-day high; 1H first red is the pivot.${redBit}${clockBit}`;
    }
    if (trend === 'bearish') {
      if (bandPhase.includes('pullback') || activeCount) {
        return `Bearish (below mark-window fib). Pullback into a prior-session band — rejection then continuation down.${redBit}${clockBit}`;
      }
      return `Bearish (broke below mark-window Fib 0/1). Book toward prior-day low; 1H first red is the pivot.${redBit}${clockBit}`;
    }
    return `No clear fib-box break yet. Prior-day H/L and session fibs are still magnets.${redBit}${clockBit}`;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RedBarTrend;
}
if (typeof window !== 'undefined') {
  window.RedBarTrend = RedBarTrend;
}
