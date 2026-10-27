'use strict';

/**
 * redbar_trend.js — Red Bar / session-mark TREND indicator (course-style, no paid tool)
 *
 * Sagar desk playbook (what we predict from):
 *  1. Magnets / targets = Fib 0/0.44/0.5/0.56/1 on each mark window
 *     (BTC 02:30–03:30, XAU 01:30–02:30, Nifty 15:15–15:45 IST) — targets only.
 *  2. Timeframe ladder: D→H4→H1→M15→M5→M1. Desk pair = H1 direction/structure → M5 entry.
 *  3. Pivot = first 1H red: mark HIGH/LOW (liquidity) + median + Fib 44/50/56 on that 1H bar.
 *     Trade 1 = leave the bar. Trade 2 = HTF level → LTF entry:
 *       - Sweep 1H high (liquidity) → 5m close back BELOW high → SHORT (sells only)
 *       - Sweep 1H low → 5m close back ABOVE low → LONG (buys only)
 *       - Median confluence on that 5m close (above/below).
 *     ENTER only when SL locks to a 5m swing; 50% @ 1:1 → BE → trail 1:2 → TP 1:3.
 *     Telegram fires on that ENTER (desk relay + worker scan) so you need not stare.
 *  4. Clock: pre-London continuation → London hunts Asia H/L → US hunts London
 *     (and Asia if untouched).
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
   * Prior-day Fib / day-range magnets with labels (the levels traders mark on TV).
   * Includes mark-window session fibs AND full calendar-day range fibs (0 / 0.236 /
   * 0.382 / 0.5 / 0.618 / 0.786 / 1) so TV "Fib on the 9th" style levels are visible.
   */
  collectPriorMagnets(bands, asOfDay, bars = null, dayMode = 'ist') {
    const out = [];
    const seen = new Set();
    const push = (price, day, label, tag) => {
      if (price == null || !Number.isFinite(price)) return;
      const key = `${day}|${price.toFixed(1)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ price, day, label, tag });
    };

    const priors = this.priorBands(bands, asOfDay);
    for (const b of priors) {
      const dayShort = String(b.day || '').slice(5); // MM-DD
      if (b.style === 'sessionFib' || b.style === 'istFib0230') {
        for (const [v, name] of [
          [b.f1, 'Sess Fib 1'], [b.f56, 'Sess Fib 0.56'], [b.f50, 'Sess Fib 0.50'],
          [b.f44, 'Sess Fib 0.44'], [b.f0, 'Sess Fib 0'],
        ]) push(v, b.day, `${dayShort} ${name}`, 'prior_fib');
      } else {
        for (const [v, name] of [[b.high, 'High'], [b.mid, 'Mid'], [b.low, 'Low']]) {
          push(v, b.day, `${dayShort} ${name}`, 'prior_day');
        }
      }
    }

    // Full calendar-day H/L fibs (last ~14 prior days) — matches common TV drawings
    if (Array.isArray(bars) && bars.length && asOfDay) {
      const dayFibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const dayNames = { 0: 'Day Fib 0', 0.236: 'Day Fib 0.236', 0.382: 'Day Fib 0.382', 0.5: 'Day Fib 0.50', 0.618: 'Day Fib 0.618', 0.786: 'Day Fib 0.786', 1: 'Day Fib 1' };
      for (let d = 1; d <= 14; d++) {
        const day = this.shiftDay(asOfDay, -d);
        const hl = this.calendarDayHl(bars, day, dayMode);
        if (!hl || !(hl.high > hl.low)) continue;
        const dayShort = String(day).slice(5);
        for (const lvl of dayFibs) {
          const px = this.fibPrice(hl.high, hl.low, lvl);
          push(px, day, `${dayShort} ${dayNames[lvl]}`, 'day_fib');
        }
      }
    }
    return out;
  },

  nearestMagnets(magnets, price) {
    let below = null;
    let above = null;
    for (const m of magnets || []) {
      if (m.price < price && (!below || m.price > below.price)) below = m;
      if (m.price > price && (!above || m.price < above.price)) above = m;
    }
    return { below, above };
  },

  /**
   * Reaction scalp at a prior Fib/day magnet: wick tags the level, close rejects
   * back through it with a decisive body. Helps the desk catch the TV "level hit"
   * trades that pure Renko-fresh continuation misses mid-run.
   * Scans magnets near the wick (not only nearest-to-close) so deeper Fibs like
   * Oct-9 0.236 still qualify when tagged intrabar.
   */
  detectMagnetReaction(bars, i, magnets, touchPct = 0.25) {
    if (!bars || i < 1 || !Array.isArray(magnets) || !magnets.length) return null;
    const cur = bars[i];
    const prev = bars[i - 1];
    const rng = cur.h - cur.l;
    if (!(rng > 0)) return null;
    const body = Math.abs(cur.c - cur.o);
    if (body / rng < 0.18) return null;
    const band = touchPct / 100;

    // Prefer the magnet closest to the wick extreme among those tagged this bar
    let bestLong = null;
    let bestShort = null;
    for (const m of magnets) {
      const px = m.price;
      if (!(px > 0)) continue;
      const taggedLow = cur.l <= px * (1 + band) && cur.h >= px * (1 - band);
      const taggedHigh = cur.h >= px * (1 - band) && cur.l <= px * (1 + band);
      // Long: tag as support, close back above, green, beats prior
      if (taggedLow && cur.c > px && cur.c > cur.o && cur.c > prev.c) {
        const dist = Math.abs(cur.l - px);
        if (!bestLong || dist < bestLong.dist) bestLong = { magnet: m, dist };
      }
      // Short: tag as resistance, close back below, red, beats prior
      if (taggedHigh && cur.c < px && cur.c < cur.o && cur.c < prev.c) {
        const dist = Math.abs(cur.h - px);
        if (!bestShort || dist < bestShort.dist) bestShort = { magnet: m, dist };
      }
    }
    // If both somehow qualify, pick the tighter wick tag
    if (bestLong && bestShort) {
      return bestLong.dist <= bestShort.dist
        ? {
          side: 'bullish',
          magnet: bestLong.magnet,
          label: `Magnet reaction LONG @ ${bestLong.magnet.label} (${bestLong.magnet.price.toFixed?.(0) ?? bestLong.magnet.price})`,
        }
        : {
          side: 'bearish',
          magnet: bestShort.magnet,
          label: `Magnet reaction SHORT @ ${bestShort.magnet.label} (${bestShort.magnet.price.toFixed?.(0) ?? bestShort.magnet.price})`,
        };
    }
    if (bestLong) {
      return {
        side: 'bullish',
        magnet: bestLong.magnet,
        label: `Magnet reaction LONG @ ${bestLong.magnet.label} (${bestLong.magnet.price.toFixed?.(0) ?? bestLong.magnet.price})`,
      };
    }
    if (bestShort) {
      return {
        side: 'bearish',
        magnet: bestShort.magnet,
        label: `Magnet reaction SHORT @ ${bestShort.magnet.label} (${bestShort.magnet.price.toFixed?.(0) ?? bestShort.magnet.price})`,
      };
    }
    return null;
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
      // zonedClockToUtc can sit a few–dozen seconds AFTER true HH:MM, so a bar that
      // opens exactly at endHour:endMinute (e.g. 03:30 IST) would never lock if we
      // required lastT >= hit.t1. Lock when the last bar's clock is at/past the end
      // minute, or wall-clock is past t1 (with the same ~90s slack used for opens).
      const tz = window.timeZone || 'Asia/Kolkata';
      const zLast = this.zonedHms(lastT, tz);
      const endMins = (window.endHour || 0) * 60 + (window.endMinute || 0);
      const lastMins = zLast.hour * 60 + zLast.minute;
      const asOfTs = cfg.asOfTs != null ? cfg.asOfTs : Date.now();
      const locked = lastMins >= endMins || asOfTs >= hit.t1 - 90 * 1000 || lastT >= hit.t1;
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

  /**
   * Builds discrete Renko bricks from candlestick closes.
   * Single source of truth for the gate chip and Renko View chart.
   * Each brick: { t, o, c, dir, barIdx } — bull: o=bot c=top; bear: o=top c=bot.
   */
  buildRenkoSeries(bars, brickSize) {
    if (!bars || !bars.length || !brickSize || brickSize <= 0) return [];
    let curTop = Math.round(bars[0].c / brickSize) * brickSize;
    let curBot = curTop - brickSize;
    let dir = 0;
    const bricks = [];

    const pushUp = (t, barIdx, n) => {
      for (let j = 0; j < n; j++) {
        curBot = curTop;
        curTop += brickSize;
        bricks.push({ t, o: curBot, c: curTop, dir: 1, barIdx });
      }
      dir = 1;
    };
    const pushDown = (t, barIdx, n) => {
      for (let j = 0; j < n; j++) {
        curTop = curBot;
        curBot -= brickSize;
        bricks.push({ t, o: curTop, c: curBot, dir: -1, barIdx });
      }
      dir = -1;
    };

    for (let i = 1; i < bars.length; i++) {
      const c = bars[i].c;
      const t = bars[i].t;
      if (dir === 0) {
        if (c >= curTop + brickSize) pushUp(t, i, Math.floor((c - curTop) / brickSize));
        else if (c <= curBot - brickSize) pushDown(t, i, Math.floor((curBot - c) / brickSize));
      } else if (dir === 1) {
        if (c >= curTop + brickSize) pushUp(t, i, Math.floor((c - curTop) / brickSize));
        else if (c <= curBot - brickSize) pushDown(t, i, Math.floor((curBot - c) / brickSize));
      } else if (dir === -1) {
        if (c <= curBot - brickSize) pushDown(t, i, Math.floor((curBot - c) / brickSize));
        else if (c >= curTop + brickSize) pushUp(t, i, Math.floor((c - curTop) / brickSize));
      }
    }
    return bricks;
  },

  /**
   * Dr. Dev 8.33% Daily ATR Renko state (ADR/12 brick).
   * Derives direction / run / freshness from buildRenkoSeries so the gate and
   * Renko View never disagree. Fresh = brick printed on this or prior bar AND
   * current run length ≤ 3 (enter the start of a run, not mid-air chop).
   */
  computeRenko833(slice, asOfDay, dayMode = 'ist') {
    if (!Array.isArray(slice) || !slice.length) return null;
    const dailyBands = this.buildDailyBands(slice, 30, dayMode);
    const priors = dailyBands.filter((b) => b.day < asOfDay && b.high > b.low).slice(-7);
    const lastBar = slice[slice.length - 1];
    const lastPrice = lastBar.c;
    const dailyAtr = priors.length
      ? priors.reduce((s, b) => s + (b.high - b.low), 0) / priors.length
      : lastPrice * 0.022;
    const brickSize = Math.max(lastPrice * 0.0005, dailyAtr / 12);

    const bricks = this.buildRenkoSeries(slice, brickSize);
    let dir = 0;
    let bricksInRun = 0;
    let brickTop = Math.round(lastPrice / brickSize) * brickSize;
    let brickBot = brickTop - brickSize;
    let flippedBarIdx = 0;
    let newBrickBarIdx = 0;

    if (bricks.length) {
      const last = bricks[bricks.length - 1];
      dir = last.dir;
      brickTop = Math.max(last.o, last.c);
      brickBot = Math.min(last.o, last.c);
      newBrickBarIdx = last.barIdx;
      let run = 0;
      for (let i = bricks.length - 1; i >= 0; i--) {
        if (bricks[i].dir !== dir) break;
        run++;
      }
      bricksInRun = run;
      flippedBarIdx = bricks[bricks.length - run].barIdx;
    }

    const flipLevel = dir === 1 ? brickBot - brickSize : dir === -1 ? brickTop + brickSize : lastPrice;
    const nextBrickLevel = dir === 1 ? brickTop + brickSize : dir === -1 ? brickBot - brickSize : lastPrice;
    const barsSinceFlip = slice.length - 1 - flippedBarIdx;
    const barsSinceBrick = slice.length - 1 - newBrickBarIdx;
    const curBody = Math.abs(lastBar.c - lastBar.o);
    const overextendedBar = curBody > brickSize * 1.6;

    return {
      dailyAtr,
      brickSize,
      brickPct: (brickSize / lastPrice) * 100,
      dir,
      trend: dir === 1 ? 'bullish' : dir === -1 ? 'bearish' : 'neutral',
      brickTop,
      brickBot,
      bricksInRun,
      flipLevel,
      nextBrickLevel,
      barsSinceFlip,
      barsSinceBrick,
      // Allow the brick bar or the next candle; only first 3 bricks of a run are "fresh"
      freshBrick: bricks.length > 0 && barsSinceBrick <= 1 && bricksInRun <= 3,
      overextendedBar,
      brickCount: bricks.length,
    };
  },

  /**
   * Dr. Dev CPR (Central Pivot Range) from prior day's high/low/close:
   * Pivot = (H + L + C) / 3
   * Bottom Central (BC) = (H + L) / 2
   * Top Central (TC) = (Pivot - BC) + Pivot
   */
  computeCpr(bars, asOfDay, dayMode = 'ist') {
    if (!bars || !bars.length || !asOfDay) return null;
    const days = [...new Set(bars.map((b) => this.dayKey(b.t, dayMode)))].sort();
    const curIdx = days.indexOf(asOfDay);
    const priorDayKey = curIdx > 0 ? days[curIdx - 1] : null;
    if (!priorDayKey) return null;
    let h = null, l = null, c = null;
    for (const b of bars) {
      if (this.dayKey(b.t, dayMode) !== priorDayKey) continue;
      h = h == null ? b.h : Math.max(h, b.h);
      l = l == null ? b.l : Math.min(l, b.l);
      c = b.c;
    }
    if (h == null || l == null || c == null) return null;
    const pivot = (h + l + c) / 3;
    const bc = (h + l) / 2;
    const tc = (pivot - bc) + pivot;
    return {
      day: priorDayKey,
      pivot,
      bc: Math.min(bc, tc),
      tc: Math.max(bc, tc),
      range: Math.abs(tc - bc),
      high: h,
      low: l,
      close: c,
    };
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
    const fmtWait = (m) => {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return h > 0 ? `${h}h ${r}m` : `${r}m`;
    };
    if (mins < 12 * 60 + 30) {
      const rem = (12 * 60 + 30) - mins;
      return {
        id: 'pre_london',
        label: 'Pre-London',
        nextWindow: `London Open (12:30 PM IST) in ${fmtWait(rem)}`,
        tip: 'Until ~12:30 IST, BTC often keeps the morning direction.',
      };
    }
    if (mins < 16 * 60 + 30) {
      const rem = (16 * 60 + 30) - mins;
      return {
        id: 'london',
        label: 'London Active (12:30–4:30 PM)',
        nextWindow: `US Open (4:30 PM IST) in ${fmtWait(rem)}`,
        tip: 'London usually sweeps Asia high or low, then reverses.',
      };
    }
    if (mins < 19 * 60) {
      const rem = (19 * 60) - mins;
      return {
        id: 'us_open',
        label: 'US Open Active (4:30–7:00 PM)',
        nextWindow: `US Heavy Window · ${fmtWait(rem)} left (till 7:00 PM IST)`,
        tip: 'US hunts London H/L (Asia if untouched). Heavy window ~4:30–7:00 IST.',
      };
    }
    const remToLondon = (24 * 60 - mins) + (12 * 60 + 30);
    return {
      id: 'late',
      label: 'After US Open (Late Session)',
      nextWindow: `Next Prime Session: London (12:30 PM IST) in ${fmtWait(remToLondon)}`,
      tip: 'Pivot stays the first 1H red; watch prior-day H/L as book magnets.',
    };
  },

  /**
   * Median + Fib 44/50/56 marked on the first 1H red candle high→low (not on 5m).
   * Median = Fib 50 = midpoint of that 1H bar.
   */
  firstRedFibs(firstRed) {
    if (!firstRed || firstRed.high == null || firstRed.low == null) return null;
    const high = firstRed.high;
    const low = firstRed.low;
    if (!(high > low)) return null;
    const f44 = this.fibPrice(high, low, 0.44);
    const f50 = this.fibPrice(high, low, 0.5);
    const f56 = this.fibPrice(high, low, 0.56);
    return {
      high,
      low,
      f0: high,
      f44,
      f50,
      f56,
      f1: low,
      median: f50,
    };
  },

  /**
   * Trade 2 on 5m (HTF→LTF ladder: 1H structure → 5m entry).
   * Reel + Sagar:
   *  - Sweep 1H HIGH (liquidity) then 5m CLOSE BELOW high → SHORT (sells only)
   *  - Sweep 1H LOW then 5m CLOSE ABOVE low → LONG (buys only)
   *  - Same-bar wick sweep + close-through counts (rejection candle).
   *  - Median confluence on the trigger close for ENTER (strong).
   * Without a sweep: close vs median alone = WATCH (not strong).
   */
  _trade2Confirm5m(bars5m, firstRed, fibs, asOfTs, touchPct = 0.15) {
    if (!Array.isArray(bars5m) || !bars5m.length || !firstRed || !fibs) return null;
    const median = fibs.median;
    const hi = firstRed.high;
    const lo = firstRed.low;
    const barMs = 5 * 60 * 1000;
    const lookMs = 3 * 3600 * 1000;
    const closed = [];
    for (let i = 0; i < bars5m.length; i++) {
      const b = bars5m[i];
      if (b.t <= firstRed.t) continue;
      if (asOfTs != null && b.t + barMs > asOfTs) continue;
      if (asOfTs != null && (asOfTs - b.t) > lookMs) continue;
      closed.push(b);
    }
    if (!closed.length) return null;

    // Newest closed bars first — require sweep on the trigger bar or earlier
    for (let i = closed.length - 1; i >= 0; i--) {
      const trig = closed[i];
      // Fresh trigger only — stale ENTERs were sitting on the desk for ~1h and inviting chases
      if (asOfTs != null && (asOfTs - trig.t) > 20 * 60 * 1000) break;

      let sweepHi = trig.h > hi ? trig.h : null;
      let sweepLo = trig.l < lo ? trig.l : null;
      for (let j = 0; j < i; j++) {
        if (closed[j].h > hi) sweepHi = sweepHi == null ? closed[j].h : Math.max(sweepHi, closed[j].h);
        if (closed[j].l < lo) sweepLo = sweepLo == null ? closed[j].l : Math.min(sweepLo, closed[j].l);
      }

      // SHORT: swept high, closed back below high (reel: CLOSED BELOW)
      const shortTrig = sweepHi != null && trig.c < hi;
      // LONG: swept low, closed back above low
      const longTrig = sweepLo != null && trig.c > lo;

      if (shortTrig && !longTrig) {
        const medOk = trig.c < median;
        return {
          side: 'bearish',
          read: 'liq_sweep_high',
          bar: trig,
          strong: medOk,
          sweepExtreme: sweepHi,
          level: hi,
          sellsOnly: true,
          medianOk: medOk,
        };
      }
      if (longTrig && !shortTrig) {
        const medOk = trig.c > median;
        return {
          side: 'bullish',
          read: 'liq_sweep_low',
          bar: trig,
          strong: medOk,
          sweepExtreme: sweepLo,
          level: lo,
          buysOnly: true,
          medianOk: medOk,
        };
      }
      // Both possible (rare): prefer the side that closed through relative to median
      if (shortTrig && longTrig) {
        if (trig.c < median) {
          return {
            side: 'bearish',
            read: 'liq_sweep_high',
            bar: trig,
            strong: true,
            sweepExtreme: sweepHi,
            level: hi,
            sellsOnly: true,
            medianOk: true,
          };
        }
        if (trig.c > median) {
          return {
            side: 'bullish',
            read: 'liq_sweep_low',
            bar: trig,
            strong: true,
            sweepExtreme: sweepLo,
            level: lo,
            buysOnly: true,
            medianOk: true,
          };
        }
      }
    }

    // No liquidity close-through — median in zone = WATCH
    const tol = (touchPct / 100) * firstRed.high;
    const zoneHi = Math.max(hi, fibs.f44) + tol;
    const zoneLo = Math.min(lo, fibs.f56) - tol;
    for (let i = closed.length - 1; i >= 0; i--) {
      const b = closed[i];
      if (!(b.l <= zoneHi && b.h >= zoneLo)) continue;
      if (b.c > median) {
        return { side: 'bullish', read: 'median_watch', bar: b, strong: false, sweepExtreme: null, medianOk: true };
      }
      if (b.c < median) {
        return { side: 'bearish', read: 'median_watch', bar: b, strong: false, sweepExtreme: null, medianOk: true };
      }
      return { side: null, read: 'at_median', bar: b, strong: false, sweepExtreme: null };
    }
    return null;
  },

  /**
   * First-red: Trade 1 (leave) / Trade 2 (1H liquidity → 5m close-through).
   * Trade 2 anytime after first red (incl. Asia / within ~5m).
   */
  firstRedSetup(price, firstRed, asOfTs, touchPct = 0.15, slice = null, bars5m = null) {
    if (!firstRed || price == null) {
      return { id: 'no_red', label: 'No 1H first red yet', near: false, hoursSince: null };
    }
    const hoursSince = asOfTs != null && firstRed.t != null
      ? (asOfTs - firstRed.t) / 3600000
      : null;
    const fibs = this.firstRedFibs(firstRed);
    const pivotMid = fibs ? fibs.median : (firstRed.high + firstRed.low) / 2;
    const nearHigh = (Math.abs(price - firstRed.high) / firstRed.high) * 100 <= touchPct;
    const nearLow = (Math.abs(price - firstRed.low) / firstRed.low) * 100 <= touchPct;
    const inside = price <= firstRed.high && price >= firstRed.low;
    const nearFibBand = !!(fibs && price <= fibs.f44 * (1 + touchPct / 100) && price >= fibs.f56 * (1 - touchPct / 100));
    const near = nearHigh || nearLow || inside || nearFibBand;
    const leftAbove = price > firstRed.high;
    const leftBelow = price < firstRed.low;

    let hadLeftAbove = false;
    let hadLeftBelow = false;
    let sweptHigh5 = false;
    let sweptLow5 = false;
    let curBar = null;
    if (Array.isArray(slice) && slice.length) {
      curBar = slice[slice.length - 1];
      const startLook = Math.max(0, slice.length - 48);
      for (let k = startLook; k < slice.length - 1; k++) {
        const b = slice[k];
        if (b.t <= firstRed.t) continue;
        if (b.c > firstRed.high * (1 + touchPct / 100)) hadLeftAbove = true;
        if (b.c < firstRed.low * (1 - touchPct / 100)) hadLeftBelow = true;
      }
    }
    if (Array.isArray(bars5m) && bars5m.length) {
      for (let k = Math.max(0, bars5m.length - 80); k < bars5m.length; k++) {
        const b = bars5m[k];
        if (b.t <= firstRed.t) continue;
        if (asOfTs != null && b.t >= asOfTs) continue;
        if (b.c > firstRed.high) hadLeftAbove = true;
        if (b.c < firstRed.low) hadLeftBelow = true;
        if (b.h > firstRed.high) sweptHigh5 = true;
        if (b.l < firstRed.low) sweptLow5 = true;
      }
    }

    const tol = (touchPct / 100) * firstRed.high;
    const zoneHi = fibs ? Math.max(firstRed.high, fibs.f44) + tol : firstRed.high + tol;
    const zoneLo = fibs ? Math.min(firstRed.low, fibs.f56) - tol : firstRed.low - tol;
    const barTouchedPivot = curBar
      ? (curBar.l <= zoneHi && curBar.h >= zoneLo)
      : near;

    const leftThen = hadLeftAbove || hadLeftBelow;
    // Active when revisiting zone OR after a 5m liquidity sweep of 1H H/L
    const revisitWindow = (near || barTouchedPivot || sweptHigh5 || sweptLow5 || (near && leftThen))
      && hoursSince != null && hoursSince >= (5 / 60) && hoursSince <= 20;

    let revisitRead = null;
    let revisitSide = null;
    let revisitStrong = false;
    let sweepExtreme = null;
    let sellsOnly = false;
    let buysOnly = false;
    const conf5 = revisitWindow
      ? this._trade2Confirm5m(bars5m, firstRed, fibs, asOfTs, touchPct)
      : null;
    if (revisitWindow && conf5 && conf5.side) {
      revisitSide = conf5.side;
      revisitRead = conf5.read;
      revisitStrong = !!conf5.strong;
      sweepExtreme = conf5.sweepExtreme ?? null;
      sellsOnly = !!conf5.sellsOnly;
      buysOnly = !!conf5.buysOnly;
    } else if (revisitWindow && curBar) {
      if ((leftThen || sweptHigh5 || sweptLow5) && curBar.l <= zoneHi && curBar.h >= zoneLo) {
        if (curBar.c > pivotMid) {
          revisitRead = 'median_watch';
          revisitSide = 'bullish';
        } else if (curBar.c < pivotMid) {
          revisitRead = 'median_watch';
          revisitSide = 'bearish';
        }
        revisitStrong = false;
      }
    }

    const distFromPivotPct = leftAbove
      ? ((price - firstRed.high) / firstRed.high) * 100
      : leftBelow
        ? ((firstRed.low - price) / firstRed.low) * 100
        : 0;
    let justDeparted = false;
    if ((leftAbove || leftBelow) && Array.isArray(slice) && slice.length >= 2) {
      const lookBars = slice.slice(-3, -1);
      justDeparted = leftAbove
        ? lookBars.some((b) => b.c <= firstRed.high + tol)
        : lookBars.some((b) => b.c >= firstRed.low - tol);
    }
    const trade1Fresh = (leftAbove || leftBelow)
      && justDeparted
      && (hoursSince == null || (hoursSince >= 0.25 && hoursSince <= 3.0))
      && distFromPivotPct <= 1.0;

    let id = 'marked';
    let label = '1H first red marked (H/L liquidity + median)';
    if (revisitWindow) {
      id = 'trade2_revisit';
      label = revisitRead === 'liq_sweep_high'
        ? (revisitStrong
          ? 'Trade 2 · 1H high swept → 5m closed below (SHORT)'
          : 'Trade 2 · 1H high swept — wait 5m close below high & median')
        : revisitRead === 'liq_sweep_low'
          ? (revisitStrong
            ? 'Trade 2 · 1H low swept → 5m closed above (LONG)'
            : 'Trade 2 · 1H low swept — wait 5m close above low & median')
          : revisitRead === 'median_watch'
            ? (revisitSide === 'bullish'
              ? 'Trade 2 WATCH · 5m above median — need liquidity sweep of 1H low'
              : 'Trade 2 WATCH · 5m below median — need liquidity sweep of 1H high')
            : 'Trade 2 · H1→M5 — wait sweep of 1H H/L then close back through';
    } else if (leftAbove || leftBelow) {
      id = 'trade1_away';
      label = leftAbove ? 'Trade 1 · left above first red' : 'Trade 1 · left below first red';
    } else if (near) {
      id = 'at_pivot';
      label = 'At 1H first-red (mark HIGH/LOW liquidity + median)';
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
      /** 5m bar time of Trade 2 confirm (for ENTER freshness). */
      triggerTs: (conf5 && conf5.bar && conf5.bar.t) || null,
      distFromPivotPct,
      leftAbove,
      leftBelow,
      pivotHigh: firstRed.high,
      pivotLow: firstRed.low,
      pivotMid,
      fibs,
      sweepExtreme,
      sellsOnly,
      buysOnly,
      sweptHigh5,
      sweptLow5,
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
    const prior3 = slice.slice(-4, -1);
    const rng = cur.h - cur.l;
    if (!(rng > 0)) return null;

    const checkPool = (pool, poolName) => {
      if (!pool || pool.high == null || pool.low == null) return null;
      // Bearish sweep: prior 2 closes intact below pool high, wick above, close back inside as red
      // with ≥25% upper rejection. Soft pivot align (prefer below first-red high).
      const prior2 = prior3.slice(-2);
      const highIntact = prior2.every((b) => b.c <= pool.high);
      const upperWick = cur.h - Math.max(cur.o, cur.c);
      const pivotOkShort = !firstRed1h || cur.c < firstRed1h.high;
      if (highIntact && cur.h > pool.high && cur.c < pool.high && cur.c < cur.o && upperWick / rng >= 0.25 && pivotOkShort) {
        return {
          id: `sweep_${poolName}_high`,
          side: 'bearish',
          pool: poolName,
          level: pool.high,
          wickExtreme: cur.h,
          label: `${clock.label} swept ${poolName} high (${pool.high.toFixed?.(0) ?? pool.high}) & rejected → SHORT`,
        };
      }
      // Bullish sweep: prior 2 closes intact above pool low, wick below, close back inside as green
      // with ≥25% lower rejection. Soft pivot align (prefer above first-red low).
      const lowIntact = prior2.every((b) => b.c >= pool.low);
      const lowerWick = Math.min(cur.o, cur.c) - cur.l;
      const pivotOkLong = !firstRed1h || cur.c > firstRed1h.low;
      if (lowIntact && cur.l < pool.low && cur.c > pool.low && cur.c > cur.o && lowerWick / rng >= 0.25 && pivotOkLong) {
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
    cpr = null,
    minRR = 1.5,
    preferSwingStop = false,
    /** Trade 2: fixed 1:1 / 1:2 / 1:3 ladder (book = 1:3) */
    rrLadder = false,
    /** Trade 2 beginner SL: 5m swing H/L (Sagar: stay on 5m until ready for 15m) */
    bars5m = null,
    /** Trade 2 liquidity-sweep wick extreme (beyond 1H high/low) */
    sweepExtreme = null,
  }) {
    if (trend !== 'bullish' && trend !== 'bearish') {
      return {
        invalidation: null,
        invalidationReason: null,
        stopStructural: false,
        tp1: null,
        tp2: null,
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

    const workRecent = Array.isArray(slice) ? slice.slice(-10) : [];
    let localLow = workRecent.length ? Math.min(...workRecent.map((b) => b.l)) : null;
    let localHigh = workRecent.length ? Math.max(...workRecent.map((b) => b.h)) : null;
    let swingStopTagLow = 'prev swing low';
    let swingStopTagHigh = 'prev swing high';
    // Trade 2: lock SL to 5m swing (not working-TF / 15m yet)
    if (preferSwingStop && Array.isArray(bars5m) && bars5m.length >= 10) {
      const i5 = bars5m.length - 1;
      const sw5 = this.nearestSwings(bars5m, i5, 2);
      const recent5 = bars5m.slice(-24); // ~2h of 5m structure
      const min5 = Math.min(...recent5.map((b) => b.l));
      const max5 = Math.max(...recent5.map((b) => b.h));
      // Prefer nearest completed 5m swing; fall back to recent 5m extreme
      localLow = (sw5.nearLow != null ? sw5.nearLow : sw5.swingLow) ?? min5;
      localHigh = (sw5.nearHigh != null ? sw5.nearHigh : sw5.swingHigh) ?? max5;
      swingStopTagLow = '5m swing low';
      swingStopTagHigh = '5m swing high';
    }
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
      // Trade 2 (Sagar): prefer recent swing low for SL; mark-window Fibs are targets only.
      const rawCands = preferSwingStop
        ? [
          // Public USD-M winners: prefer 5m swing over sweep wick / 1H red (wick-only bled)
          localLow != null && localLow < price ? { v: localLow - pad, tag: swingStopTagLow } : null,
          sweepExtreme != null && sweepExtreme < price ? { v: sweepExtreme - pad, tag: '5m sweep wick (1H low)' } : null,
          sweep?.side === 'bullish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme - pad, tag: 'session sweep wick' } : null,
          firstRed1h?.low != null && firstRed1h.low < price ? { v: firstRed1h.low - pad, tag: '1H red low' } : null,
          support != null && support < price ? { v: support - pad, tag: 'prior fib support' } : null,
        ]
        : [
          sweep?.side === 'bullish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme - pad, tag: 'sweep wick' } : null,
          firstRed1h?.low != null && firstRed1h.low < price ? { v: firstRed1h.low - pad, tag: '1H red low' } : null,
          localLow != null && localLow < price ? { v: localLow - pad, tag: 'prev swing low' } : null,
          or?.low != null && or.low < price ? { v: or.low - pad, tag: 'Fib 1 edge' } : null,
          support != null && support < price ? { v: support - pad, tag: 'prior fib support' } : null,
          swingLow != null && swingLow < price ? { v: swingLow, tag: 'pivot swing low' } : null,
        ];
      const candidates = rawCands.filter((x) => x && Number.isFinite(x.v) && x.v < price);

      // Pick the tightest structural stop that is at least minStopDist away and at most maxStopDist away
      const valid = candidates
        .filter((x) => (price - x.v) >= minStopDist && (price - x.v) <= maxStopDist)
        .sort((a, b) => b.v - a.v); // closest to price first
      // Winning formula: lock to 5m swing whenever it exists (clamp into 0.28–1.5% if needed)
      // so ENTER + Telegram can fire — do not fall through to 1H red / fib (those bled OOS).
      const swingCands = preferSwingStop
        ? candidates.filter((x) => /5m swing/i.test(x.tag)).sort((a, b) => b.v - a.v)
        : [];
      const swingInWindow = swingCands.filter((x) => (price - x.v) >= minStopDist && (price - x.v) <= maxStopDist);
      const pickLong = swingInWindow[0] || null;
      if (pickLong) {
        invalidation = pickLong.v;
        invalidationReason = pickLong.tag;
        stopStructural = true;
      } else if (swingCands[0]) {
        const rawDist = price - swingCands[0].v;
        invalidation = price - Math.min(maxStopDist, Math.max(minStopDist, rawDist));
        invalidationReason = capReason(rawDist, swingCands[0].tag);
        stopStructural = true; // real 5m structure — floor/cap must not block Telegram ENTER
      } else if (valid[0]) {
        invalidation = valid[0].v;
        invalidationReason = valid[0].tag;
        stopStructural = true;
      } else {
        const anyBelow = candidates.slice().sort((a, b) => b.v - a.v)[0];
        if (anyBelow) {
          const rawDist = price - anyBelow.v;
          invalidation = price - Math.min(maxStopDist, Math.max(minStopDist, rawDist));
          invalidationReason = capReason(rawDist, anyBelow.tag);
          stopStructural = rawDist <= maxStopDist;
        } else {
          invalidation = price - price * 0.0065;
          invalidationReason = '0.65% default — no structure found';
          stopStructural = false;
        }
      }
    } else {
      const rawCands = preferSwingStop
        ? [
          localHigh != null && localHigh > price ? { v: localHigh + pad, tag: swingStopTagHigh } : null,
          sweepExtreme != null && sweepExtreme > price ? { v: sweepExtreme + pad, tag: '5m sweep wick (1H high)' } : null,
          sweep?.side === 'bearish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme + pad, tag: 'session sweep wick' } : null,
          firstRed1h?.high != null && firstRed1h.high > price ? { v: firstRed1h.high + pad, tag: '1H red high' } : null,
          resist != null && resist > price ? { v: resist + pad, tag: 'prior fib resistance' } : null,
        ]
        : [
          sweep?.side === 'bearish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme + pad, tag: 'sweep wick' } : null,
          firstRed1h?.high != null && firstRed1h.high > price ? { v: firstRed1h.high + pad, tag: '1H red high' } : null,
          localHigh != null && localHigh > price ? { v: localHigh + pad, tag: 'prev swing high' } : null,
          or?.high != null && or.high > price ? { v: or.high + pad, tag: 'Fib 0 edge' } : null,
          resist != null && resist > price ? { v: resist + pad, tag: 'prior fib resistance' } : null,
          swingHigh != null && swingHigh > price ? { v: swingHigh, tag: 'pivot swing high' } : null,
        ];
      const candidates = rawCands.filter((x) => x && Number.isFinite(x.v) && x.v > price);

      const valid = candidates
        .filter((x) => (x.v - price) >= minStopDist && (x.v - price) <= maxStopDist)
        .sort((a, b) => a.v - b.v); // closest to price first
      const swingCandsShort = preferSwingStop
        ? candidates.filter((x) => /5m swing/i.test(x.tag)).sort((a, b) => a.v - b.v)
        : [];
      const swingInWindowShort = swingCandsShort.filter((x) => (x.v - price) >= minStopDist && (x.v - price) <= maxStopDist);
      const pickShort = swingInWindowShort[0] || null;
      if (pickShort) {
        invalidation = pickShort.v;
        invalidationReason = pickShort.tag;
        stopStructural = true;
      } else if (swingCandsShort[0]) {
        const rawDist = swingCandsShort[0].v - price;
        invalidation = price + Math.min(maxStopDist, Math.max(minStopDist, rawDist));
        invalidationReason = capReason(rawDist, swingCandsShort[0].tag);
        stopStructural = true;
      } else if (valid[0]) {
        invalidation = valid[0].v;
        invalidationReason = valid[0].tag;
        stopStructural = true;
      } else {
        const anyAbove = candidates.slice().sort((a, b) => a.v - b.v)[0];
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
    pushMag(cpr?.tc, 'cpr_tc');
    pushMag(cpr?.pivot, 'cpr_pivot');
    pushMag(cpr?.bc, 'cpr_bc');
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

    // Sagar manage (Trade 2 ladder when rrLadder):
    // 1) Stop = recent swing (1R)
    // 2) 50% TP at 1:1 → move SL to breakeven
    // 3) Trail at 1:2, take profit at 1:3
    // Otherwise: 1:1 partial + magnet/stretch book (Trade 1 / sweep)
    const tp1 = trend === 'bullish' ? price + risk : price - risk;
    const tp2 = trend === 'bullish' ? price + risk * 2.0 : price - risk * 2.0;
    const tp3 = trend === 'bullish' ? price + risk * 3.0 : price - risk * 3.0;
    if (rrLadder) {
      bookZone = tp3;
      bookReason = 'rr_1_3';
      firstMagnet = { val: tp2, tag: 'rr_1_2_trail' };
    }
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
      tp2,
      tp3,
      bookZone,
      firstMagnet: firstMagnetOut,
      bookReason,
      // false when no real magnet sat ≥1.5R away and we fell back to a synthetic 1.8R target
      bookIsMagnet: bookReason !== 'r_target_1.8R' && bookReason !== 'rr_1_3',
      stopPct,
      targetPct,
      rr,
      rrLadder: !!rrLadder,
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
    const firstRedFibs = this.firstRedFibs(firstRed1h);
    const bars5m = Array.isArray(c.bars5m) && c.bars5m.length ? c.bars5m : null;
    const dayMode = c.dayMode || 'ist';
    const istDay = this.zonedDay(bars[i].t, 'Asia/Kolkata');
    const priorDayStr = this.shiftDay(istDay, -1);
    const priorDay = this.calendarDayHl(slice, priorDayStr, dayMode);
    const clock = this.istClockPhase(bars[i].t);
    const redSetup = this.firstRedSetup(
      price, firstRed1h, bars[i].t, c.touchPct ?? 0.15, slice, bars5m,
    );

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
    // 1. Mark window still forming -> WAIT
    // 2. Trade 1 fresh departure WINS over Trade 2 (leave ≠ retest)
    // 3. Trade 2 revisit (H1 liquidity → 5m close-through)
    // 4. Session liquidity sweep
    // 5. Inside Fib box (no Trade 1/2/sweep) -> WAIT
    // 6. Fib break bias / pullback
    let trend = 'neutral';
    let setupKind = 'wait';
    if (phase === 'first_candle') {
      trend = 'neutral';
      setupKind = 'wait';
    } else if (redSetup.trade1Fresh && (redSetup.leftAbove || redSetup.leftBelow)) {
      // Fresh leave of 1H first-red — do not steal into Trade 2 sweep window
      trend = redSetup.leftAbove ? 'bullish' : 'bearish';
      setupKind = 'trade1_departure';
    } else if (redSetup.revisitSide) {
      trend = redSetup.revisitSide;
      setupKind = redSetup.revisitStrong ? 'trade2_confirmed' : 'trade2_watch';
    } else if (redSetup.revisitWindow) {
      trend = orBias === 'bull' ? 'bullish' : orBias === 'bear' ? 'bearish' : 'neutral';
      setupKind = 'trade2_watch';
      if (trend === 'neutral') trend = redSetup.leftAbove ? 'bullish' : redSetup.leftBelow ? 'bearish' : 'neutral';
    } else if (sweep) {
      trend = sweep.side;
      setupKind = 'session_sweep';
    } else if (phase === 'inside_or') {
      trend = 'neutral';
      setupKind = 'wait';
    } else if (orBias === 'bull') {
      if (firstRed1h && redSetup.leftBelow) {
        trend = 'bearish';
        setupKind = 'pivot_reversal';
      } else {
        trend = 'bullish';
        setupKind = active.length ? 'fib_pullback' : 'trend_bias';
      }
    } else if (orBias === 'bear') {
      if (firstRed1h && redSetup.leftAbove) {
        trend = 'bullish';
        setupKind = 'pivot_reversal';
      } else {
        trend = 'bearish';
        setupKind = active.length ? 'fib_pullback' : 'trend_bias';
      }
    }

    // Renko / CPR / prior Fibs = chart context only. Not separate strategies.
    // Do NOT promote session_continuation or magnet_reaction into setupKind —
    // those playbooks are incomplete / OOS-weak and stay unwired until taught.
    const renko = this.computeRenko833(slice, istDay, dayMode);
    const cpr = this.computeCpr(bars, istDay, dayMode);
    const magnetBars = Array.isArray(c.bars1h) && c.bars1h.length ? c.bars1h : slice;
    const priorMagnets = this.collectPriorMagnets(bands, asOfDay, magnetBars, dayMode);
    const { below: magnetBelow, above: magnetAbove } = this.nearestMagnets(priorMagnets, price);

    // Annotate nearest magnet touch for the chart; never flip Red Bar setup/trend.
    let magnetReaction = null;
    if (
      phase !== 'first_candle'
      && setupKind !== 'trade1_departure'
      && setupKind !== 'trade2_confirmed'
      && setupKind !== 'session_sweep'
    ) {
      magnetReaction = this.detectMagnetReaction(bars, i, priorMagnets, 0.25);
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
      firstRedF44: firstRedFibs ? firstRedFibs.f44 : null,
      firstRedF50: firstRedFibs ? firstRedFibs.f50 : null,
      firstRedF56: firstRedFibs ? firstRedFibs.f56 : null,
      firstRedMedian: firstRedFibs ? firstRedFibs.median : null,
      cprPivot: cpr ? cpr.pivot : null,
      cprBc: cpr ? cpr.bc : null,
      cprTc: cpr ? cpr.tc : null,
    };

    const isTrade2 = setupKind === 'trade2_confirmed' || setupKind === 'trade2_watch';
    // Public USD-M study: ENTERs with a real 5m swing stop were the only robust winners.
    // Prefer 5m structure for Trade 1 / Trade 2 / sweep — not only Trade 2.
    const preferSwingStop = isTrade2
      || setupKind === 'trade1_departure'
      || setupKind === 'session_sweep';
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
      cpr,
      minRR: isTrade2 ? 1.0 : 1.5,
      preferSwingStop,
      rrLadder: isTrade2,
      bars5m,
      sweepExtreme: redSetup.sweepExtreme ?? null,
    });

    const invalidation = levels.invalidation;
    const bookZone = levels.bookZone;

    // Entry gate: Red Bar only — Trade 1 / Trade 2 / session sweep.
    const { state: actionState, reason: actionReason } = this.entryGate({
      trend,
      setupKind,
      rr: levels.rr,
      stopStructural: levels.stopStructural,
      invalidationReason: levels.invalidationReason,
      stopPct: levels.stopPct,
      renko,
      clock,
      asOfTs: bars[i].t,
      instrumentId: c.id || c.instrumentId || null,
      season: this._istSeasonBucket(bars[i].t),
      setupTriggerTs: redSetup.triggerTs
        || (setupKind === 'session_sweep' ? bars[i].t : null)
        || null,
      entryPrice: price,
      stopPrice: invalidation,
      livePrice: price,
    });

    const sizing = (actionState === 'enter' && invalidation != null && bookZone != null)
      ? this.futuresSizing({ entry: price, stop: invalidation, exit: bookZone })
      : null;

    const playbook = {
      clock,
      redSetup,
      renko,
      cpr,
      priorDay,
      asiaHl,
      londonHl,
      nyHl,
      asiaUntouched,
      sweep,
      setupKind,
      magnetBelow,
      magnetAbove,
      magnetReaction,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rrLadder: levels.rrLadder,
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
      firstRedFibs,
      renko,
      cpr,
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
        swingStopTf: preferSwingStop ? '5m' : null,
      },
      invalidation,
      invalidationReason: levels.invalidationReason,
      stopStructural: levels.stopStructural,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rrLadder: levels.rrLadder,
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

  /**
   * Red Bar only — setups that may ENTER.
   * Continuation / magnet / Renko / EMA are not strategies on this desk until taught.
   */
  ACTIONABLE_SETUPS: ['trade1_departure', 'trade2_confirmed', 'session_sweep'],

  /** True in the first `quietMins` of London (12:30 IST) or US (16:30 IST). */
  _inSessionQuietWindow(asOfTs, quietMins = 45) {
    if (asOfTs == null) return false;
    const z = this.zonedHms(asOfTs, 'Asia/Kolkata');
    const mins = z.hour * 60 + z.minute;
    if (mins >= 12 * 60 + 30 && mins < 12 * 60 + 30 + quietMins) return true; // London open
    if (mins >= 16 * 60 + 30 && mins < 16 * 60 + 30 + quietMins) return true; // US open
    return false;
  },

  /**
   * Single source of truth for "enter now" vs "watch" vs "wait".
   * Used by the desk UI, the Telegram bot and the walk-forward backtest.
   */
  _istSeasonBucket(ts) {
    const day = this.zonedHms(ts, 'Asia/Kolkata').day;
    const m = parseInt(String(day).slice(5, 7), 10);
    if (m <= 3) return 'JAN–MAR';
    if (m <= 8) return 'APR–AUG';
    return 'SEP–DEC';
  },

  entryGate({
    trend, setupKind, rr, stopStructural, invalidationReason, stopPct, renko, clock,
    asOfTs, instrumentId, season, setupTriggerTs, entryPrice, stopPrice, livePrice,
  }) {
    if (trend !== 'bullish' && trend !== 'bearish') {
      return { state: 'wait', reason: 'No directional setup.' };
    }
    if (!this.ACTIONABLE_SETUPS.includes(setupKind)) {
      const why = {
        trend_bias: 'Red Bar bias only — wait for Trade 1 departure, Trade 2 revisit, or session sweep.',
        fib_pullback: 'Near mark-window Fibs (context) — wait for Trade 1 / Trade 2 / sweep.',
        session_continuation: 'Continuation is not active — Red Bar only (Trade 1 / 2 / sweep).',
        magnet_reaction: 'Fib magnet is chart context — not a Red Bar ENTER.',
        magnet_bounce_watch: 'Fib bounce is chart context — not a Red Bar ENTER.',
        pivot_reversal: 'Price crossed the 1H red against Fib bias — conflicting, wait.',
        trade2_watch: 'H1→M5 Trade 2: wait for 1H high/low liquidity sweep, then 5m close back through that level (median confluence).',
      }[setupKind] || 'Red Bar: wait for Trade 1 / Trade 2 / session sweep.';
      return { state: 'watch', reason: why };
    }
    // Spike filter uses Renko brick size as a volatility ruler only (not a Renko strategy).
    if (renko && renko.overextendedBar && setupKind !== 'session_sweep') {
      return {
        state: 'watch',
        reason: `Candle spiked >1.6× brick ruler ($${renko.brickSize.toFixed(0)}) in one bar — wait for pullback instead of chasing.`,
      };
    }
    if (!(rr >= 1.0)) {
      return { state: 'watch', reason: `Setup present but R:R ${rr != null ? rr.toFixed(2) : '—'} < 1.0.` };
    }
    if (!stopStructural) {
      return { state: 'watch', reason: `Setup present but no real swing fits the stop window (${invalidationReason}).` };
    }
    // Winning formula (public BTCUSDT USD-M Oct24–Sep26): only 5m-swing SL book
    // stayed green train+OOS (n=274, WR≈61%). 1H red / fib / wick-only stops bled.
    if (!/5m swing/i.test(String(invalidationReason || ''))) {
      return {
        state: 'watch',
        reason: `Setup present but SL is ${invalidationReason || 'not a 5m swing'} — wait until stop locks to a 5m swing (quality ENTER).`,
      };
    }
    // Loser DNA (same public book): late-session ENTERs bled (n=141, sum≈−8%);
    // skipping late lifted train+OOS (+9% / +14%, total +23% vs +15% baseline).
    if (clock && clock.id === 'late') {
      return {
        state: 'watch',
        reason: 'Setup present but IST late session — stand aside (loser cluster on public USD-M). Wait for next day’s pre-London / London.',
      };
    }
    // Wide stops (>1%) were rare (~3% of book) but toxic (WR≈24%, sum≈−14%).
    // Soft gate only — keeps ~97% of ENTERs; mid-band filters that cut frequency are not applied.
    if (stopPct != null && Number.isFinite(stopPct) && stopPct > 1.0) {
      return {
        state: 'watch',
        reason: `Setup present but stop is ${stopPct.toFixed(2)}% (>1%) — stand aside until a tighter 5m swing fits.`,
      };
    }

    // Freshness: do not keep LIVE ENTER long after the trigger (chase bait).
    const asOf = asOfTs != null ? Number(asOfTs) : Date.now();
    const trigTs = setupTriggerTs != null ? Number(setupTriggerTs) : null;
    const ENTER_FRESH_MS = 20 * 60 * 1000;
    if (trigTs != null && Number.isFinite(trigTs) && (asOf - trigTs) > ENTER_FRESH_MS) {
      return {
        state: 'watch',
        reason: 'ENTER window closed (>20m since trigger bar) — do not chase. Wait for the next Trade 1 / 2 / sweep.',
      };
    }
    // Already ran: price ≥0.5R into the trade from the signal print → late.
    const ep = Number(entryPrice);
    const sp = Number(stopPrice);
    const lp = Number(livePrice);
    const R = Math.abs(ep - sp);
    if (R > 0 && Number.isFinite(ep) && Number.isFinite(lp)) {
      const favR = trend === 'bullish' ? (lp - ep) / R : (ep - lp) / R;
      if (favR >= 0.5) {
        return {
          state: 'watch',
          reason: `Price already ${favR.toFixed(1)}R into the move — ENTER is stale. Do not chase; manage if filled or wait next setup.`,
        };
      }
    }

    // Nifty desk book (2024–2026 real 1m→5m): baseline PASS, but Trade 2 alone fails OOS
    // (n=325, train +0.15% / oos −0.69%). Trade 1 carries the edge — keep T2 as WATCH only.
    const inst = String(instrumentId || '').toUpperCase();
    if (inst === 'NIFTY' && setupKind === 'trade2_confirmed') {
      return {
        state: 'watch',
        reason: 'Nifty: Trade 2 confirmed is chart context only (OOS bled on 2y book). Prefer Trade 1 departure ENTER.',
      };
    }
    // Soft seasonal stand-aside for Nifty APR–AUG (weaker half; T1 + not APR–AUG still PASS).
    if (inst === 'NIFTY' && (season === 'APR–AUG' || (!season && asOfTs != null && this._istSeasonBucket(asOfTs) === 'APR–AUG'))) {
      return {
        state: 'watch',
        reason: 'Nifty: APR–AUG season — stand aside (weaker half on 2y book). Prefer SEP–DEC / JAN–MAR Trade 1.',
      };
    }
    // Nifty gated book: stopPct>0.65 is rare but 0% WR (n=3) — tighten vs BTC’s 1% soft cap.
    if (inst === 'NIFTY' && stopPct != null && Number.isFinite(stopPct) && stopPct > 0.65) {
      return {
        state: 'watch',
        reason: `Nifty: stop ${stopPct.toFixed(2)}% (>0.65%) — wait for a tighter 5m swing.`,
      };
    }

    const trailBit = setupKind === 'trade2_confirmed'
      ? 'H1→M5 sweep+close-through · SL 5m swing · 50% @ 1:1 → BE → trail 1:2 → TP 1:3'
      : 'SL 5m swing · 50% TP at 1:1 → trail runner (stretch target)';
    return { state: 'enter', reason: `Fresh trigger · ${trailBit}.` };
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
      ? ` ${playbook.redSetup.label}.`
      : playbook?.redSetup?.id === 'trade1_away'
        ? ' Price has left the 1H first red — Trade 1 style: structural stop, book toward liquidity magnet.'
        : '';

    if (phase === 'first_candle') {
      return 'Mark window still forming — record high/low only; do not trade until it locks.';
    }
    if (playbook?.setupKind === 'trade2_confirmed' || playbook?.setupKind === 'trade2_watch') {
      return `Trade 2 at 1H first-red Fibs (44/50/56).${redBit}${clockBit}`;
    }
    if (phase === 'inside_or' && !playbook?.sweep) {
      return `Price inside today’s mark-window fib box — Fibs are targets only. Wait for Trade 1 / Trade 2 / sweep.${clockBit}`;
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
