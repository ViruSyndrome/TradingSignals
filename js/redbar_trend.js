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

  _dtfCache: new Map(),

  _dtf(locale, opts) {
    const key = `${locale}|${opts.timeZone || ''}|${opts.year || ''}|${opts.hour || ''}`;
    let fmt = this._dtfCache.get(key);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, opts);
      this._dtfCache.set(key, fmt);
    }
    return fmt;
  },

  utcDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  },

  /** Calendar day string in a timezone. */
  zonedDay(ts, timeZone) {
    try {
      return this._dtf('en-CA', {
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
    for (const p of this._dtf('en-GB', {
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
    const fmtDay = this._dtf('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const fmtHm = this._dtf('en-GB', {
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
   * Inspects recent bars to distinguish a fresh Trade 1 break, a Trade 2 revisit
   * rejection/reversal, or an overextended late move.
   */
  firstRedSetup(price, firstRed, asOfTs, touchPct = 0.15, slice = null) {
    if (!firstRed || price == null) {
      return { id: 'no_red', label: 'No 1H first red yet', near: false, hoursSince: null };
    }
    const hoursSince = asOfTs != null && firstRed.t != null
      ? (asOfTs - firstRed.t) / 3600000
      : null;
    const pivotMid = (firstRed.high + firstRed.low) / 2;
    const nearHigh = (Math.abs(price - firstRed.high) / firstRed.high) * 100 <= touchPct;
    const nearLow = (Math.abs(price - firstRed.low) / firstRed.low) * 100 <= touchPct;
    const inside = price <= firstRed.high && price >= firstRed.low;
    const near = nearHigh || nearLow || inside;
    const leftAbove = price > firstRed.high && !nearHigh;
    const leftBelow = price < firstRed.low && !nearLow;

    // Check recent bars after firstRed formed to see if price already left the pivot earlier
    let hadLeftAbove = false;
    let hadLeftBelow = false;
    let curBar = null;
    if (Array.isArray(slice) && slice.length) {
      curBar = slice[slice.length - 1];
      const startLook = Math.max(0, slice.length - 14);
      for (let k = startLook; k < slice.length - 1; k++) {
        const b = slice[k];
        if (b.t <= firstRed.t) continue;
        if (b.c > firstRed.high * (1 + touchPct / 100)) hadLeftAbove = true;
        if (b.c < firstRed.low * (1 - touchPct / 100)) hadLeftBelow = true;
      }
    }

    // Did the current bar wick into the 1H first-red zone?
    const tol = ( touchPct / 100 ) * firstRed.high;
    const barTouchedPivot = curBar
      ? (curBar.l <= firstRed.high + tol && curBar.h >= firstRed.low - tol)
      : near;

    // Sagar: after ~1.5–6.5h price often revisits the first-red level
    const revisitWindow = (near || (barTouchedPivot && (hadLeftAbove || hadLeftBelow)))
      && hoursSince != null && hoursSince >= 1.5 && hoursSince <= 6.5;

    // At revisit: classify reject (continue morning bias) vs reverse (flip through pivot)
    let revisitRead = null;
    let revisitSide = null;
    // A single 30m touch false-positives easily. "Strong" = decisive candle: body ≥ 45% of its
    // range and close in the outer 40% of the range in the trade direction. Weak reads are
    // surfaced as Trade 2 WATCH (human confirms the candle), never as an entry.
    let revisitStrong = false;
    if (revisitWindow && curBar) {
      if (hadLeftAbove && curBar.l <= firstRed.high + tol && curBar.c >= pivotMid && curBar.c >= curBar.o) {
        revisitRead = 'reject_bull';
        revisitSide = 'bullish';
      } else if (hadLeftBelow && curBar.h >= firstRed.low - tol && curBar.c <= pivotMid && curBar.c <= curBar.o) {
        revisitRead = 'reject_bear';
        revisitSide = 'bearish';
      } else if (hadLeftAbove && curBar.c < firstRed.low && curBar.c < curBar.o) {
        revisitRead = 'reverse_bear';
        revisitSide = 'bearish';
      } else if (hadLeftBelow && curBar.c > firstRed.high && curBar.c > curBar.o) {
        revisitRead = 'reverse_bull';
        revisitSide = 'bullish';
      }
      if (revisitSide) {
        const rng = curBar.h - curBar.l;
        const body = Math.abs(curBar.c - curBar.o);
        const prevBar = slice && slice.length >= 2 ? slice[slice.length - 2] : null;
        const beatPrev = !prevBar || (revisitSide === 'bullish' ? curBar.c > prevBar.c : curBar.c < prevBar.c);
        // Reject flat doji touches on a single 30m bar: require real body (>=18% of bar range) and close beating prior bar
        revisitStrong = rng > 0 && (body / rng) >= 0.18 && beatPrev;
      }
    }

    // Distance from pivot in % — used to avoid chasing Trade 1 hours after the move happened
    const distFromPivotPct = leftAbove
      ? ((price - firstRed.high) / firstRed.high) * 100
      : leftBelow
        ? ((firstRed.low - price) / firstRed.low) * 100
        : 0;
    // Short freshness window (≤2 bars since leaving the 1H first-red range) so Trade 1
    // only fires on the actual departure, then transitions to WATCH (trend_bias).
    let justDeparted = false;
    if ((leftAbove || leftBelow) && Array.isArray(slice) && slice.length >= 2) {
      const lookBars = slice.slice(-3, -1); // 1–2 bars immediately before current bar
      justDeparted = leftAbove
        ? lookBars.some((b) => b.c <= firstRed.high + tol)
        : lookBars.some((b) => b.c >= firstRed.low - tol);
    }
    const trade1Fresh = (leftAbove || leftBelow)
      && justDeparted
      && (hoursSince == null || (hoursSince >= 0.25 && hoursSince <= 3.0))
      && distFromPivotPct <= 1.0;

    let id = 'marked';
    let label = '1H first red marked';
    if (revisitWindow) {
      id = 'trade2_revisit';
      label = revisitRead === 'reject_bull'
        ? 'Trade 2 · 1H red rejected (LONG continuation)'
        : revisitRead === 'reject_bear'
          ? 'Trade 2 · 1H red rejected (SHORT continuation)'
          : revisitRead === 'reverse_bear'
            ? 'Trade 2 · 1H red broke down (SHORT flip)'
            : revisitRead === 'reverse_bull'
              ? 'Trade 2 · 1H red reclaimed (LONG flip)'
              : 'Trade 2 · revisit of 1H first red';
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
      revisitRead,
      revisitSide,
      revisitStrong,
      trade1Fresh,
      distFromPivotPct,
      leftAbove,
      leftBelow,
      pivotHigh: firstRed.high,
      pivotLow: firstRed.low,
      pivotMid,
    };
  },

  /**
   * Detect session liquidity sweeps (Sagar clock rules):
   * - London sweeps Asia High/Low and reverses.
   * - US sweeps London High/Low (or untouched Asia H/L) and reverses.
   */
  detectSessionSweep(slice, clock, asiaHl, londonHl, firstRed1h = null) {
    if (!Array.isArray(slice) || slice.length < 5 || !clock) return null;
    const cur = slice[slice.length - 1];
    const prev = slice[slice.length - 2];
    const prior3 = slice.slice(-4, -1);
    const rng = cur.h - cur.l;
    if (!(rng > 0)) return null;

    const checkPool = (pool, poolName) => {
      if (!pool || pool.high == null || pool.low == null) return null;
      // Bearish sweep of session high: pool was intact on prior closes, current bar wicked above pool.high,
      // closed back below pool.high as a red candle with ≥35% upper rejection wick, aligned with 1H first-red pivot
      const highIntact = prior3.every((b) => b.c <= pool.high);
      const upperWick = cur.h - Math.max(cur.o, cur.c);
      const pivotOkShort = !firstRed1h || cur.c < firstRed1h.high;
      if (highIntact && cur.h > pool.high && cur.c < pool.high && cur.c < cur.o && cur.c < prev.c && upperWick / rng >= 0.35 && pivotOkShort) {
        return {
          id: `sweep_${poolName}_high`,
          side: 'bearish',
          pool: poolName,
          level: pool.high,
          wickExtreme: cur.h,
          label: `${clock.label} swept ${poolName} high (${pool.high.toFixed?.(0) ?? pool.high}) & rejected → SHORT`,
        };
      }
      // Bullish sweep of session low: pool was intact on prior closes, current bar wicked below pool.low,
      // closed back above pool.low as a green candle with ≥35% lower rejection wick, aligned with 1H first-red pivot
      const lowIntact = prior3.every((b) => b.c >= pool.low);
      const lowerWick = Math.min(cur.o, cur.c) - cur.l;
      const pivotOkLong = !firstRed1h || cur.c > firstRed1h.low;
      if (lowIntact && cur.l < pool.low && cur.c > pool.low && cur.c > cur.o && cur.c > prev.c && lowerWick / rng >= 0.35 && pivotOkLong) {
        return {
          id: `sweep_${poolName}_low`,
          side: 'bullish',
          pool: poolName,
          level: pool.low,
          wickExtreme: cur.l,
          label: `${clock.label} swept ${poolName} low (${pool.low.toFixed?.(0) ?? pool.low}) & reclaimed → LONG`,
        };
      }
      return null;
    };

    if (clock.id === 'london' && asiaHl) {
      return checkPool(asiaHl, 'Asia');
    }
    if (clock.id === 'us_open') {
      return checkPool(londonHl, 'London') || checkPool(asiaHl, 'Asia');
    }
    return null;
  },

  /**
   * Smart structural stop + ordered liquidity-magnet book target.
   * Fixes inverted R:R by:
   *  1. Using tight local structure (1H red pivot / recent 10-bar swing / Fib edge) for the stop,
   *     clamped to a realistic futures stop distance (0.28%–1.50%).
   *  2. Selecting the nearest liquidity magnet (Prior-Day H/L, Session H/L, Fib band, Swing)
   *     that sits at least `minRR` (1.5R) ahead of entry; if PDH/PDL is closer than 1.5R,
   *     it is surfaced as `firstMagnet` (partial / obstacle) while `bookZone` targets the next
   *     magnet ≥ 1.5R (or a 1.8R expansion target).
   */
  _resolveStopAndBook({
    trend,
    price,
    slice,
    or,
    firstRed1h,
    priorDay,
    asiaHl,
    londonHl,
    nyHl,
    priorBands,
    resist,
    support,
    swingHigh,
    swingLow,
    red,
    sweep,
    minRR = 1.5,
  }) {
    if (trend !== 'bullish' && trend !== 'bearish') {
      return {
        invalidation: null,
        invalidationReason: null,
        stopStructural: false,
        tp1: null,
        tp3: null,
        bookZone: null,
        firstMagnet: null,
        bookReason: null,
        bookIsMagnet: false,
        stopPct: null,
        targetPct: null,
        rr: null,
      };
    }

    const recentBars = Array.isArray(slice) ? slice.slice(-10) : [];
    const localLow = recentBars.length ? Math.min(...recentBars.map((b) => b.l)) : null;
    const localHigh = recentBars.length ? Math.max(...recentBars.map((b) => b.h)) : null;
    const prevSwingLow = localLow;
    const prevSwingHigh = localHigh;
    const minStopDist = price * 0.0028; // 0.28% minimum stop floor (avoids micro noise stops)
    const maxStopDist = price * 0.015;  // 1.50% maximum stop cap on 30m futures
    const pad = price * 0.0006;         // 6 bps buffer beyond structure wick

    // Each candidate carries its structural source so the UI can say *why* the stop is there,
    // and flag when no real structure fits the 0.28%–1.50% window (stop = % cap, not a swing).
    let invalidation = null;
    let invalidationReason = null;
    let stopStructural = false;
    const capReason = (rawDist, tag) => (rawDist > maxStopDist
      ? `1.5% cap — real ${tag} is ${((rawDist / price) * 100).toFixed(2)}% away`
      : `0.28% floor — ${tag} too close`);
    if (trend === 'bullish') {
      const candidates = [
        sweep?.side === 'bullish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme - pad, tag: 'sweep wick' } : null,
        firstRed1h?.low != null && firstRed1h.low < price ? { v: firstRed1h.low - pad, tag: '1H red low' } : null,
        localLow != null && localLow < price ? { v: localLow - pad, tag: 'prev swing low' } : null,
        or?.low != null && or.low < price ? { v: or.low - pad, tag: 'Fib 1 edge' } : null,
        support != null && support < price ? { v: support - pad, tag: 'prior fib support' } : null,
        swingLow != null && swingLow < price ? { v: swingLow, tag: 'pivot swing low' } : null,
      ].filter((x) => x && Number.isFinite(x.v) && x.v < price);

      // Pick the tightest structural stop that is at least minStopDist away and at most maxStopDist away
      const valid = candidates
        .filter((x) => (price - x.v) >= minStopDist && (price - x.v) <= maxStopDist)
        .sort((a, b) => b.v - a.v); // closest to price first
      if (valid.length) {
        invalidation = valid[0].v;
        invalidationReason = valid[0].tag;
        stopStructural = true;
      } else {
        const anyBelow = candidates.sort((a, b) => b.v - a.v)[0];
        if (anyBelow) {
          const rawDist = price - anyBelow.v;
          invalidation = price - Math.min(maxStopDist, Math.max(minStopDist, rawDist));
          invalidationReason = capReason(rawDist, anyBelow.tag);
          // If structure was closer than 0.28%, flooring to 0.28% places the stop safely behind structure.
          // Only when rawDist > maxStopDist (1.5%) is the stop capped in mid-air before real structure.
          stopStructural = rawDist <= maxStopDist;
        } else {
          invalidation = price - price * 0.0065;
          invalidationReason = '0.65% default — no structure found';
          stopStructural = false;
        }
      }
    } else {
      const candidates = [
        sweep?.side === 'bearish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme + pad, tag: 'sweep wick' } : null,
        firstRed1h?.high != null && firstRed1h.high > price ? { v: firstRed1h.high + pad, tag: '1H red high' } : null,
        localHigh != null && localHigh > price ? { v: localHigh + pad, tag: 'prev swing high' } : null,
        or?.high != null && or.high > price ? { v: or.high + pad, tag: 'Fib 0 edge' } : null,
        resist != null && resist > price ? { v: resist + pad, tag: 'prior fib resistance' } : null,
        swingHigh != null && swingHigh > price ? { v: swingHigh, tag: 'pivot swing high' } : null,
      ].filter((x) => x && Number.isFinite(x.v) && x.v > price);

      const valid = candidates
        .filter((x) => (x.v - price) >= minStopDist && (x.v - price) <= maxStopDist)
        .sort((a, b) => a.v - b.v); // closest to price first
      if (valid.length) {
        invalidation = valid[0].v;
        invalidationReason = valid[0].tag;
        stopStructural = true;
      } else {
        const anyAbove = candidates.sort((a, b) => a.v - b.v)[0];
        if (anyAbove) {
          const rawDist = anyAbove.v - price;
          invalidation = price + Math.min(maxStopDist, Math.max(minStopDist, rawDist));
          invalidationReason = capReason(rawDist, anyAbove.tag);
          stopStructural = rawDist <= maxStopDist;
        } else {
          invalidation = price + price * 0.0065;
          invalidationReason = '0.65% default — no structure found';
          stopStructural = false;
        }
      }
    }

    const risk = Math.abs(price - invalidation);
    const minReward = risk * minRR;
    const maxReward = risk * 4.0;

    // Build the liquidity magnet ladder in the trade direction
    const rawMagnets = [];
    const pushMag = (val, tag) => {
      if (val != null && Number.isFinite(val)) rawMagnets.push({ val: Number(val), tag });
    };
    pushMag(priorDay?.high, 'prior_day_high');
    pushMag(priorDay?.low, 'prior_day_low');
    pushMag(nyHl?.high, 'ny_high');
    pushMag(nyHl?.low, 'ny_low');
    pushMag(londonHl?.high, 'london_high');
    pushMag(londonHl?.low, 'london_low');
    pushMag(asiaHl?.high, 'asia_high');
    pushMag(asiaHl?.low, 'asia_low');
    pushMag(swingHigh, 'swing_high');
    pushMag(swingLow, 'swing_low');
    pushMag(red?.high, 'red_high');
    pushMag(red?.low, 'red_low');
    if (or && or.high > or.low) {
      const span = or.high - or.low;
      pushMag(or.high + span * 0.618, 'fib_ext_1618');
      pushMag(or.high + span * 1.0, 'fib_ext_200');
      pushMag(or.low - span * 0.618, 'fib_ext_1618');
      pushMag(or.low - span * 1.0, 'fib_ext_200');
    }
    if (Array.isArray(priorBands)) {
      for (const b of priorBands.slice(-10)) {
        for (const lv of this.bandLevelList(b)) pushMag(lv, 'prior_fib');
      }
    }

    let bookZone = null;
    let bookReason = null;
    let firstMagnet = null;

    if (trend === 'bullish') {
      const ahead = rawMagnets
        .filter((m) => m.val > price + risk * 0.4)
        .sort((a, b) => a.val - b.val);
      if (ahead.length) firstMagnet = ahead[0];

      const pdh = priorDay?.high;
      if (pdh != null && pdh >= price + minReward && pdh <= price + maxReward) {
        bookZone = pdh;
        bookReason = 'prior_day_high';
      } else {
        const good = ahead.find((m) => m.val >= price + minReward && m.val <= price + maxReward);
        if (good) {
          bookZone = good.val;
          bookReason = good.tag;
        } else {
          bookZone = price + risk * 1.8;
          bookReason = 'r_target_1.8R';
        }
      }
    } else {
      const ahead = rawMagnets
        .filter((m) => m.val < price - risk * 0.4)
        .sort((a, b) => b.val - a.val);
      if (ahead.length) firstMagnet = ahead[0];

      const pdl = priorDay?.low;
      if (pdl != null && pdl <= price - minReward && pdl >= price - maxReward) {
        bookZone = pdl;
        bookReason = 'prior_day_low';
      } else {
        const good = ahead.find((m) => m.val <= price - minReward && m.val >= price - maxReward);
        if (good) {
          bookZone = good.val;
          bookReason = good.tag;
        } else {
          bookZone = price - risk * 1.8;
          bookReason = 'r_target_1.8R';
        }
      }
    }

    // Sagar rule:
    // 1) Decide Stop-Loss first (invalidation, distance = 1R = risk)
    // 2) 1:1 reward is your 50% TP (tp1), then move stop to BE
    // 3) Trail the remaining 50% until EMA 10/30 cross over (with liquidity magnet / 1:3 as stretch cap)
    const tp1 = trend === 'bullish' ? price + risk : price - risk;
    const tp3 = trend === 'bullish' ? price + risk * 3.0 : price - risk * 3.0;
    const reward = Math.abs(bookZone - price);
    const stopPct = (risk / price) * 100;
    const targetPct = (reward / price) * 100;
    const rr = risk > 0 ? reward / risk : null;

    // First liquidity obstacle between entry and book (only when it is NOT the book itself)
    const firstMagnetOut = firstMagnet && Math.abs(firstMagnet.val - bookZone) > price * 0.0002
      ? {
        price: firstMagnet.val,
        reason: firstMagnet.tag,
        rr: risk > 0 ? Math.abs(firstMagnet.val - price) / risk : null,
      }
      : null;

    return {
      invalidation,
      invalidationReason,
      stopStructural,
      prevSwingHigh,
      prevSwingLow,
      tp1,
      tp3,
      bookZone,
      firstMagnet: firstMagnetOut,
      bookReason,
      // false when no real magnet sat ≥1.5R away and we fell back to a synthetic 1.8R target
      bookIsMagnet: bookReason !== 'r_target_1.8R',
      stopPct,
      targetPct,
      rr,
    };
  },

  /**
   * Futures position & safe-leverage calculator (works for both LONG and SHORT).
   * Guarantees recommended isolated leverage keeps liquidation well behind the stop.
   */
  futuresSizing({
    entry,
    stop,
    exit = null,
    capital = 1000,
    riskPct = 1,
    feePerSide = 0.0004,
    maintMargin = 0.005,
  } = {}) {
    const e = Number(entry);
    const s = Number(stop);
    const t = exit != null ? Number(exit) : null;
    const cap = Math.max(10, Number(capital) || 1000);
    const rPct = Math.max(0.1, Math.min(10, Number(riskPct) || 1));
    if (!Number.isFinite(e) || !Number.isFinite(s) || e <= 0 || s <= 0 || e === s) {
      return null;
    }
    const side = s < e ? 'LONG' : 'SHORT';
    const stopDist = Math.abs(e - s);
    const stopPct = (stopDist / e) * 100;
    const targetDist = t != null && Number.isFinite(t) ? Math.abs(t - e) : 0;
    const targetPct = (targetDist / e) * 100;
    const rr = stopDist > 0 && targetDist > 0 ? targetDist / stopDist : null;

    const riskUsd = cap * (rPct / 100);
    // Include round-trip taker fee (2 * 0.04% = 0.08% of notional) in effective loss at stop
    const effectiveStopFrac = (stopDist / e) + 2 * feePerSide;
    const notionalUsd = riskUsd / effectiveStopFrac;
    const qty = notionalUsd / e;
    const estFeesUsd = notionalUsd * 2 * feePerSide;
    const tp1 = side === 'LONG' ? e + stopDist : e - stopDist;
    const tp3 = side === 'LONG' ? e + stopDist * 3 : e - stopDist * 3;
    // Net profit banked on 50% at 1:1 after half the round-trip fees
    const tp1HalfNetUsd = 0.5 * (qty * stopDist - estFeesUsd);
    const netWinUsd = targetDist > 0
      ? (0.5 * qty * stopDist + 0.5 * qty * targetDist - estFeesUsd)
      : (qty * stopDist - estFeesUsd);

    // Safe isolated leverage: keep liquidation distance >= 1.6x stop distance + maintenance margin
    const rawMaxSafeLev = Math.floor(100 / (stopPct * 1.6 + maintMargin * 100));
    const maxSafeLeverage = Math.max(1, Math.min(20, rawMaxSafeLev));
    const recLeverage = Math.max(1, Math.min(10, maxSafeLeverage));
    const marginRequiredUsd = notionalUsd / recLeverage;
    const liqPrice = side === 'LONG'
      ? e * (1 - (1 / recLeverage) + maintMargin)
      : e * (1 + (1 / recLeverage) - maintMargin);

    return {
      side,
      entry: e,
      stop: s,
      exit: t,
      stopDist,
      stopPct,
      targetDist,
      targetPct,
      rr,
      capital: cap,
      riskPct: rPct,
      riskUsd,
      notionalUsd,
      qty,
      tp1,
      tp3,
      tp1HalfNetUsd,
      estFeesUsd,
      netWinUsd: netWinUsd ?? 0,
      netProfitUsd: netWinUsd ?? 0,
      recLeverage,
      maxSafeLeverage,
      marginRequiredUsd,
      liqPrice,
    };
  },

  /**
   * Core readout at bar index i — trend prediction + Sagar playbook setups.
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

    // Opening-range / mark-window Fib box bias
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
        phase = 'inside_or'; // inside Fib 0..1 box (accumulation / sideways)
      }
    } else if (or && !or.locked) {
      phase = 'first_candle'; // mark window still forming — do not trade
      orBias = 'neutral';
    }

    // Band structure: balance vs held break
    let bandPhase = 'clear';
    if (active.length) {
      bandPhase = 'in_prior_band';
      if (orBias === 'bull') bandPhase = 'bull_pullback_in_band';
      if (orBias === 'bear') bandPhase = 'bear_pullback_in_band';
    } else if (orBias === 'bull' && support != null && price > support) {
      bandPhase = 'bull_held_above_bands';
    } else if (orBias === 'bear' && resist != null && price < resist) {
      bandPhase = 'bear_held_below_bands';
    }

    const firstRed1h = c.firstRed1h || null;
    const dayMode = c.dayMode || 'ist';
    const istDay = this.zonedDay(bars[i].t, 'Asia/Kolkata');
    const priorDayStr = this.shiftDay(istDay, -1);
    const priorDay = this.calendarDayHl(slice, priorDayStr, dayMode);
    const clock = this.istClockPhase(bars[i].t);
    const redSetup = this.firstRedSetup(price, firstRed1h, bars[i].t, c.touchPct ?? 0.15, slice);

    const sessions = Array.isArray(c.sessions) ? c.sessions : [];
    const asiaSess = sessions.find((s) => (s.id || '').toLowerCase() === 'asia')
      || sessions.find((s) => /asia/i.test(s.label || ''));
    const londonSess = sessions.find((s) => (s.id || '').toLowerCase() === 'london')
      || sessions.find((s) => /london/i.test(s.label || ''));
    const nySess = sessions.find((s) => ['ny', 'us', 'newyork'].includes((s.id || '').toLowerCase()))
      || sessions.find((s) => /us|ny|new\s*york/i.test(s.label || ''));
    const asiaHl = asiaSess ? this.sessionHlForIstDay(slice, asiaSess, bars[i].t) : null;
    const londonHl = londonSess ? this.sessionHlForIstDay(slice, londonSess, bars[i].t) : null;
    const nyHl = nySess ? this.sessionHlForIstDay(slice, nySess, bars[i].t) : null;
    const asiaUntouched = !!(asiaHl && price < asiaHl.high && price > asiaHl.low);
    const sweep = this.detectSessionSweep(slice, clock, asiaHl, londonHl, firstRed1h);

    // Composite trend & setup classification (Sagar playbook):
    // 1. Mark-window forming or trapped inside Fib 0..1 box -> neutral (WAIT)
    // 2. Trade 2 revisit with confirmed rejection/reversal -> primary revisit setup
    // 3. Session liquidity sweep (London sweeps Asia H/L or US sweeps London H/L, aligned with 1H red) -> reversal setup
    // 4. Fib break + 1H first-red departure agreement -> Trade 1 or trend bias
    let trend = 'neutral';
    let setupKind = 'wait';
    if (phase !== 'first_candle' && phase !== 'inside_or') {
      if (redSetup.revisitSide) {
        trend = redSetup.revisitSide;
        setupKind = redSetup.revisitStrong ? 'trade2_confirmed' : 'trade2_watch';
      } else if (sweep) {
        trend = sweep.side;
        setupKind = 'session_sweep';
      } else if (orBias === 'bull') {
        // Do not call LONG if price broke down below today's 1H first-red low
        if (firstRed1h && redSetup.leftBelow) {
          trend = 'bearish';
          setupKind = 'pivot_reversal';
        } else {
          trend = 'bullish';
          setupKind = redSetup.trade1Fresh
            ? 'trade1_departure'
            : redSetup.revisitWindow
              ? 'trade2_watch'
              : active.length
                ? 'fib_pullback'
                : 'trend_bias';
        }
      } else if (orBias === 'bear') {
        if (firstRed1h && redSetup.leftAbove) {
          trend = 'bullish';
          setupKind = 'pivot_reversal';
        } else {
          trend = 'bearish';
          setupKind = redSetup.trade1Fresh
            ? 'trade1_departure'
            : redSetup.revisitWindow
              ? 'trade2_watch'
              : active.length
                ? 'fib_pullback'
                : 'trend_bias';
        }
      }
    } else if (phase === 'inside_or' && sweep) {
      // Edge sweep of session high/low at box boundary
      trend = sweep.side;
      setupKind = 'session_sweep';
    }

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
      nyHigh: nyHl ? nyHl.high : null,
      nyLow: nyHl ? nyHl.low : null,
      firstRed1hHigh: firstRed1h ? firstRed1h.high : null,
      firstRed1hLow: firstRed1h ? firstRed1h.low : null,
    };

    const levels = this._resolveStopAndBook({
      trend,
      price,
      slice,
      or,
      firstRed1h,
      priorDay,
      asiaHl,
      londonHl,
      nyHl,
      priorBands: prior,
      resist,
      support,
      swingHigh,
      swingLow,
      red,
      sweep,
      minRR: 1.5,
    });

    const invalidation = levels.invalidation;
    const bookZone = levels.bookZone;

    // Entry gate: only fresh Trade 1, decisive Trade 2, or a session sweep are "enter now".
    // Everything else directional (trend_bias, fib_pullback, pivot_reversal, trade2_watch)
    // is BIAS / WATCH — useful context, never an entry signal.
    const { state: actionState, reason: actionReason } = this.entryGate({
      trend,
      setupKind,
      rr: levels.rr,
      stopStructural: levels.stopStructural,
      invalidationReason: levels.invalidationReason,
    });

    const sizing = (actionState === 'enter' && invalidation != null && bookZone != null)
      ? this.futuresSizing({ entry: price, stop: invalidation, exit: bookZone })
      : null;

    const playbook = {
      clock,
      redSetup,
      priorDay,
      asiaHl,
      londonHl,
      nyHl,
      asiaUntouched,
      sweep,
      setupKind,
      tp1: levels.tp1,
      tp3: levels.tp3,
      firstMagnet: levels.firstMagnet,
      bookReason: levels.bookReason,
      rr: levels.rr,
      stopPct: levels.stopPct,
      targetPct: levels.targetPct,
      liquidityTip: this._liquidityTip(clock, asiaHl, londonHl, asiaUntouched, sweep),
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
      trend, // bullish | bearish | neutral  ← directional bias only
      setupKind,
      actionState, // enter | watch | wait  ← the only field that means "place an order"
      actionReason,
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
        prevSwingHigh: levels.prevSwingHigh ?? swingHigh,
        prevSwingLow: levels.prevSwingLow ?? swingLow,
      },
      invalidation,
      invalidationReason: levels.invalidationReason,
      stopStructural: levels.stopStructural,
      tp1: levels.tp1,
      tp3: levels.tp3,
      bookZone,
      firstMagnet: levels.firstMagnet,
      bookReason: levels.bookReason,
      bookIsMagnet: levels.bookIsMagnet,
      stopPct: levels.stopPct,
      targetPct: levels.targetPct,
      rr: levels.rr,
      sizing,
    };
  },

  read(bars, cfg) {
    return this.readAt(bars, bars.length - 1, cfg);
  },

  /** Setup kinds that may be traded immediately (everything else is bias / watch). */
  ACTIONABLE_SETUPS: ['trade1_departure', 'trade2_confirmed', 'session_sweep'],

  /**
   * Single source of truth for "enter now" vs "watch" vs "wait".
   * Used by the desk UI, the Telegram bot and the walk-forward backtest.
   */
  entryGate({ trend, setupKind, rr, stopStructural, invalidationReason }) {
    if (trend !== 'bullish' && trend !== 'bearish') {
      return { state: 'wait', reason: 'No directional setup.' };
    }
    if (!this.ACTIONABLE_SETUPS.includes(setupKind)) {
      const why = {
        trend_bias: 'Fib-break bias only — no fresh Trade 1, Trade 2 or sweep.',
        fib_pullback: 'Pullback into a prior fib band — wait for a Trade 1/2 trigger.',
        pivot_reversal: 'Price crossed the 1H red against the fib bias — conflicting, wait.',
        trade2_watch: 'At the 1H red revisit, but the candle is not decisive yet — watch the close.',
      }[setupKind] || 'Bias only — not an entry.';
      return { state: 'watch', reason: why };
    }
    if (!(rr >= 1.0)) {
      return { state: 'watch', reason: `Setup present but R:R ${rr != null ? rr.toFixed(2) : '—'} < 1.0.` };
    }
    if (!stopStructural) {
      return { state: 'watch', reason: `Setup present but no real swing fits the stop window (${invalidationReason}).` };
    }
    return { state: 'enter', reason: 'Fresh trigger · Stop set · 50% TP at 1:1 + trail 50% till EMA 10/30 cross.' };
  },

  _liquidityTip(clock, asiaHl, londonHl, asiaUntouched, sweep) {
    if (sweep && sweep.label) return sweep.label;
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
    const sweepBit = playbook?.sweep ? ` ${playbook.sweep.label}.` : '';
    const redBit = playbook?.redSetup?.id === 'trade2_revisit'
      ? ` ${playbook.redSetup.label} — watch reject vs reverse.`
      : playbook?.redSetup?.id === 'trade1_away'
        ? ' Price has left the 1H first red — Trade 1 style: structural stop, book toward liquidity magnet.'
        : '';

    if (phase === 'first_candle') {
      return 'Mark window still forming — record high/low only; do not trade until it locks.';
    }
    if (phase === 'inside_or' && !playbook?.sweep) {
      return `Price inside today’s mark-window fib box (sideways / accumulation zone). Wait for a clean break of Fib 0 / Fib 1.${clockBit}`;
    }
    if (trend === 'bullish') {
      if (playbook?.sweep) {
        return `Bullish session sweep reversal.${sweepBit}${redBit}`;
      }
      if (bandPhase.includes('pullback') || activeCount) {
        return `Bullish (above mark-window fib). Pullback into a prior-session Fib band — hold then continuation.${redBit}${clockBit}`;
      }
      return `Bullish (broke above mark-window Fib 0/1). Book toward liquidity target; 1H first red is the pivot.${redBit}${clockBit}`;
    }
    if (trend === 'bearish') {
      if (playbook?.sweep) {
        return `Bearish session sweep reversal.${sweepBit}${redBit}`;
      }
      if (bandPhase.includes('pullback') || activeCount) {
        return `Bearish (below mark-window fib). Pullback into a prior-session Fib band — rejection then continuation down.${redBit}${clockBit}`;
      }
      return `Bearish (broke below mark-window Fib 0/1). Book toward liquidity target; 1H first red is the pivot.${redBit}${clockBit}`;
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
