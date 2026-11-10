'use strict';

/**
 * redbar_trend.js — Red Bar / session-mark TREND engine
 *
 * Mechanics authored / mentored by Dr. Devendra Pratap Singh (desk adaptation):
 *  1. Dr. Dev Red Bar DNA — first-red / mark-window box; Trade 1 departure + Trade 2 revisit.
 *  2. Dr. Dev 5m X-Candle POB (Point of Balance 44–56%) — session open X → retest → SHORT reject.
 *  3. Stretch snapback — 30m 5 EMA Rubber Band mean reversion (overlay / WATCH).
 *  4. Dr. Dev Trikal Session Anchor — NIFTY 12:45 IST London Open 30m box (trap auction / breakout).
 *  5. Dr. Dev BTC Asia Trikal — 05:30 IST 30m X range breakout (crypto clocks ≠ NSE 12:45).
 *  6. Magnets / targets = Fib 0/0.44/0.5/0.56/1 on each mark window (targets only).
 *  7. Ladder: ENTER with structural SL (15m swing / shelf) · 50% @ 1:1 → BE → trail → TP.
 *     Confirm on 5m close; stop is NOT nearest 5m fractal noise (desk mash-in removed).
 *
 * EMA is NOT part of this indicator's DNA. Overlay / bot-gate separately if desired.
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
      const dur = a.durationMinutes != null ? a.durationMinutes : 60;
      const totalMins = ((sh * 60 + sm + dur) % (24 * 60) + (24 * 60)) % (24 * 60);
      const eh = Math.floor(totalMins / 60);
      const em = totalMins % 60;
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

  /** UTC ms when hour:minute occurs on calendar dayStr in timeZone (exact minute boundary). */
  zonedClockToUtc(dayStr, timeZone, hour, minute) {
    const hNum = Number(hour) || 0;
    const mNum = Number(minute) || 0;
    if (!timeZone || timeZone === 'Asia/Kolkata') {
      // IST is fixed UTC+05:30 with no DST — exact millisecond arithmetic
      const istMidnightUtc = Date.parse(`${dayStr}T00:00:00+05:30`);
      if (Number.isFinite(istMidnightUtc)) {
        return istMidnightUtc + (hNum * 60 + mNum) * 60000;
      }
    }
    if (timeZone === 'UTC' || timeZone === 'Etc/UTC') {
      const utcMidnight = Date.parse(`${dayStr}T00:00:00Z`);
      if (Number.isFinite(utcMidnight)) {
        return utcMidnight + (hNum * 60 + mNum) * 60000;
      }
    }
    const targetHm = `${String(hNum).padStart(2, '0')}:${String(mNum).padStart(2, '0')}`;
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
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      const d = new Date(mid);
      const day = fmtDay.format(d);
      const hm = fmtHm.format(d);
      if (day < dayStr || (day === dayStr && hm < targetHm)) lo = mid;
      else hi = mid;
    }
    return Math.floor(hi / 60000) * 60000;
  },

  /** Infer intraday bar duration (ms), ignoring overnight/weekend session gaps. */
  _inferBarMs(bars, fallbackMs = 15 * 60000, endIdx = null) {
    if (!Array.isArray(bars) || bars.length < 2) return fallbackMs;
    const hi = endIdx != null ? Math.min(bars.length - 1, endIdx) : bars.length - 1;
    const lo = Math.max(1, hi - 16);
    let best = Infinity;
    for (let k = hi; k >= lo; k--) {
      const dt = bars[k].t - bars[k - 1].t;
      if (dt >= 60000 && dt < best) best = dt;
    }
    return (Number.isFinite(best) && best <= 4 * 3600000) ? best : fallbackMs;
  },

  /** Fib price on candle range (0 = low / bottom, 1 = high / top — matches TV shot). */
  fibPrice(high, low, level) {
    return low + (high - low) * level;
  },

  /**
   * Aggregate H/L of all bars that open inside [start, end) on dayStr.
   * e.g. BTC 02:30–03:30 IST = last hour before “universal” open:
   *  - on 1h: the single 02:30 IST candle
   *  - on 30m: the 02:30 and 03:00 IST candles
   *  - on 15m: the 02:30, 02:45, 03:00, and 03:15 IST candles
   *  - on 5m: the twelve 5m candles from 02:30 through 03:25 IST
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
    let endT = null;
    // Exact minute boundaries with ±1s tolerance for exchange millisecond jitter
    const openFrom = t0 - 1000;
    const openUntil = t1 - 1000;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.t >= openFrom && b.t < openUntil) {
        if (i0 < 0) {
          i0 = i;
          openT = b.t;
        }
        i1 = i;
        endT = b.t;
        high = Math.max(high, b.h);
        low = Math.min(low, b.l);
      }
    }
    if (i0 < 0 || !(high > low) || !Number.isFinite(high) || !Number.isFinite(low)) return null;
    return { high, low, i0, i1, openT, endT, t0, t1 };
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

    const barMs = this._inferBarMs(bars, 15 * 60000);
    const maxEndT = bars.length ? (bars[bars.length - 1].t + barMs) : Infinity;
    const rawFine = (Array.isArray(cfg.barsFib) && cfg.barsFib.length)
      ? cfg.barsFib
      : ((Array.isArray(cfg.bars5m) && cfg.bars5m.length) ? cfg.bars5m : null);
    const fineBars = rawFine ? rawFine.filter((fb) => fb.t < maxEndT + 1000) : null;
    // When working TF is short-history (e.g. 5m = ~3.4d), backfill older 1H mark windows from bars1h.
    // Clip to completed HTF bars <= maxEndT so historical replays never include future days/wicks.
    const rawHtf = (Array.isArray(cfg.bars1h) && cfg.bars1h.length) ? cfg.bars1h : null;
    const defaultHtfMs = cfg.firstRedTf === '30m' ? 30 * 60000 : 3600000;
    const htfBarMs = this._inferBarMs(rawHtf, defaultHtfMs);
    const htfBars = rawHtf
      ? rawHtf.filter((hb) => (hb.t + htfBarMs) <= maxEndT + 1000)
      : null;
    if (htfBars && htfBars.length) {
      for (const hb of htfBars) days.add(this.zonedDay(hb.t, tz));
    }

    const bands = [];
    const fbWin = cfg.fallbackWindow && cfg.fallbackWindow.timeZone ? cfg.fallbackWindow : null;
    for (const day of [...days].sort()) {
      let hit = this.findMarkWindowRange(bars, day, window);
      let fromHtf = false;
      let activeWin = window;
      if (!hit && fbWin) {
        hit = this.findMarkWindowRange(bars, day, fbWin);
        if (hit) activeWin = fbWin;
      }
      if (!hit && htfBars) {
        let hHit = this.findMarkWindowRange(htfBars, day, window);
        if (!hHit && fbWin) {
          hHit = this.findMarkWindowRange(htfBars, day, fbWin);
          if (hHit) activeWin = fbWin;
        }
        // Only use htfBars when its bar width fits within the mark window (e.g. 1h for 60m BTC/XAU window)
        if (hHit && htfBarMs <= (hHit.t1 - hHit.t0) + 1000) {
          hit = { ...hHit, i0: -1, i1: -1 };
          fromHtf = true;
        }
      }
      if (!hit) continue;
      let { high, low } = hit;
      const { i0, openT } = hit;
      // Check completeness when working bars start mid-window (e.g. oldest 5m bar is 02:50 IST):
      // prefer full 1H candle H/L from htfBars if working bars missed the start of [t0, t1).
      if (!fromHtf && htfBars && openT > hit.t0 + 1000) {
        const hHit = this.findMarkWindowRange(htfBars, day, activeWin);
        if (hHit && htfBarMs <= (hHit.t1 - hHit.t0) + 1000) {
          high = hHit.high;
          low = hHit.low;
        }
      }
      // When viewing a coarse TF (e.g. 1h = 60m) whose bar is wider than a 30m mark window
      // (Nifty 15:15–15:45 / NG 23:00–23:30 IST), refine H/L from finer bars.
      if (fineBars && barMs > (hit.t1 - hit.t0) + 1000) {
        const fineHit = this.findMarkWindowRange(fineBars, day, activeWin);
        if (fineHit) {
          high = fineHit.high;
          low = fineHit.low;
        }
      }
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
        endT: hit.endT ?? openT,
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
      let { high, low } = hit;
      const barMs = this._inferBarMs(bars, 15 * 60000);
      const fineBars = (Array.isArray(cfg.barsFib) && cfg.barsFib.length)
        ? cfg.barsFib
        : ((Array.isArray(cfg.bars5m) && cfg.bars5m.length) ? cfg.bars5m : null);
      if (fineBars && barMs > (hit.t1 - hit.t0) + 1000) {
        const fineHit = this.findMarkWindowRange(fineBars, asOfDay, window);
        if (fineHit) {
          high = fineHit.high;
          low = fineHit.low;
        }
      }
      const lastT = bars.length ? bars[bars.length - 1].t : 0;
      const asOfTs = cfg.asOfTs != null ? Number(cfg.asOfTs) : Date.now();
      const lastCloseT = lastT + barMs;
      // Locked only once the full mark window [t0, t1) has completed (e.g. >= 03:30:00 IST for BTC)
      const locked = lastT >= hit.t1 || (asOfTs >= hit.t1 - 1000 && lastCloseT >= hit.t1 - 1000);
      return {
        high,
        low,
        mid: (high + low) / 2,
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

  isIndianIndex(instId) {
    return ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(String(instId || '').toUpperCase());
  },

  isMcxCommodity(instId) {
    const s = String(instId || '').toUpperCase();
    return ['NG', 'NATURALGAS', 'CRUDEOIL', 'CRUDE'].some((k) => s === k || s.startsWith(k));
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
    // On 24/7 early-morning session-Fib assets (BTC 02:30–03:30 IST),
    // 00:30 & 01:30 IST belong to the prior US close and the mark window is the day's open anchor.
    // Anchor today's 1H first-red only after that early mark window completes (endHour <= 6).
    const window = this.getMarkWindow(cfg);
    const instId = String(cfg.id || cfg.instrumentId || '').toUpperCase();
    const isMcx = this.isMcxCommodity(instId);
    const isEarlyMark = !!(window && this.isSessionFib(cfg) && (Number(window.endHour) <= 6 || window.timeZone === 'America/New_York'));
    const sessDay = isEarlyMark ? this.sessionDayKey(now, window) : asOfDay;
    const markEndTs = isEarlyMark
      ? this.zonedClockToUtc(sessDay, window.timeZone || 'Asia/Kolkata', window.endHour, window.endMinute)
      : (isMcx
        ? this.zonedClockToUtc(asOfDay, 'Asia/Kolkata', 9, 0)
        : null);
    const dayBars = [];
    for (let i = 0; i < bars.length; i++) {
      const bDay = isEarlyMark ? this.sessionDayKey(bars[i].t, window) : this.dayKey(bars[i].t, dayMode);
      if (bDay !== sessDay) continue;
      if (bars[i].t + barMs > now) continue; // still forming
      if (markEndTs != null && bars[i].t < markEndTs - 1000) continue;
      dayBars.push({ bar: bars[i], index: i });
    }
    // If markEndTs already skipped the mark-window open candle (BTC), start at 0; for MCX/NSE skip open bar [0]
    const startJ = (markEndTs != null && !isMcx) ? 0 : 1;
    for (let j = startJ; j < dayBars.length; j++) {
      const { bar, index } = dayBars[j];
      if (bar.c < bar.o) {
        return {
          high: bar.h,
          low: bar.l,
          open: bar.o,
          close: bar.c,
          t: bar.t,
          barMs,
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
   * IST clock phase for BTC — awareness only (DST-correct London / NY cash opens).
   * Mid-zone prime = Asia 05:30 Trikal. Mark Fib = CME settle (separate).
   * London/NY are liquidity clocks — not extra mid-zone / Fib boxes.
   */
  istClockPhase(ts) {
    const asOf = ts || Date.now();
    const z = this.zonedHms(asOf, 'Asia/Kolkata');
    const mins = z.hour * 60 + z.minute;
    const fmtWait = (m) => {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return h > 0 ? `${h}h ${r}m` : `${r}m`;
    };
    const lonOpen = this.sessionOpenIstMins(asOf, 'Europe/London', 8, 0);
    const nyOpen = this.sessionOpenIstMins(asOf, 'America/New_York', 9, 30);
    const preLon = ((lonOpen - 45) % 1440 + 1440) % 1440;
    const lonEnd = Math.min(lonOpen + 210, 16 * 60 + 30);
    const usEnd = Math.min(nyOpen + 210, 22 * 60 + 30);
    const fmtHm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;

    // Before Asia daily open (00:00–05:30 IST) — dead hours for POB
    if (mins < 5 * 60 + 30) {
      const rem = (5 * 60 + 30) - mins;
      return {
        id: 'pre_asia',
        label: 'Pre-Asia (dead hours)',
        nextWindow: `Asia Trikal (05:30 IST) in ${fmtWait(rem)}`,
        tip: 'No mid-zone X here — wait Asia 05:30 Trikal. CME Fib is magnets only (not Trade 1).',
        isLiquidityHunt: false,
        isPrimePob: false,
      };
    }
    // Asia Trikal — only BTC mid-zone prime (ends before pre-London hunt)
    if (mins >= 5 * 60 + 30 && mins < preLon) {
      const rem = preLon - mins;
      return {
        id: 'asia',
        label: 'Asia Trikal (05:30 IST)',
        nextWindow: `Pre-London liquidity in ${fmtWait(rem)}`,
        tip: 'Prime mid-zone: first opposing 5m at 05:30. Retest 44–56 → SHORT reject. Red Bar T1/T2 still apply.',
        isLiquidityHunt: false,
        isPrimePob: true,
      };
    }
    if (mins >= preLon && mins < lonOpen) {
      return {
        id: 'pre_london',
        label: 'Pre-London liquidity',
        nextWindow: `London open ~${fmtHm(lonOpen)} IST`,
        tip: 'Asia H/L may get hunted into Europe open. Leave / retest / sweep OK — not a fresh BTC mid-zone X.',
        isLiquidityHunt: true,
        isPrimePob: false,
      };
    }
    if (mins >= lonOpen && mins < lonEnd) {
      const rem = Math.max(0, nyOpen - mins);
      return {
        id: 'london',
        label: `London liquidity (~${fmtHm(lonOpen)} IST)`,
        nextWindow: rem > 0 ? `US cash open ~${fmtHm(nyOpen)} IST in ${fmtWait(rem)}` : `US cash open ~${fmtHm(nyOpen)} IST`,
        tip: 'London vol / Asia H/L hunts. Not a second Fib box — Red Bar leave/retest/sweep only.',
        isLiquidityHunt: mins < lonOpen + 60,
        isPrimePob: false,
      };
    }
    if (mins >= lonEnd && mins < nyOpen) {
      const rem = nyOpen - mins;
      return {
        id: 'us_wait',
        label: 'Between London & NY',
        nextWindow: `US cash open ~${fmtHm(nyOpen)} IST in ${fmtWait(rem)}`,
        tip: 'Off mid-zone prime. Leave / retest / sweep still apply. Next mid-zone X is Asia 05:30.',
        isLiquidityHunt: false,
        isPrimePob: false,
      };
    }
    if (mins >= nyOpen && mins < usEnd) {
      return {
        id: 'us_open',
        label: `US cash open (~${fmtHm(nyOpen)} IST)`,
        nextWindow: 'Session wind-down after US cash hours',
        tip: 'High vol / liquidity hunts — not a Dev mid-zone box. Trade Red Bar structure only; next mid-zone X at Asia 05:30.',
        isLiquidityHunt: false,
        isPrimePob: false,
      };
    }
    const remToAsia = (24 * 60 - mins) + (5 * 60 + 30);
    return {
      id: 'late',
      label: 'After NY (dead hours)',
      nextWindow: `Next Prime: Asia / Daily Open (05:30 IST) in ${fmtWait(remToAsia)}`,
      tip: 'No new mid-zone X in dead hours. Red Bar leave/retest still OK if structure is clean; next mid-zone at Asia 05:30.',
      isLiquidityHunt: false,
      isPrimePob: false,
    };
  },

  /**
   * Dr. Dev X-Candle: first 5m RED at/after a session open clock.
   * NIFTY: 09:15 IST. BTC: Asia 05:30 via BTC_POB_PRIMES (see findPrimeSessionXCandle5m).
   */
  findOpeningXCandle5m(bars5m, asOfTs, opts = {}) {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const tz = opts.timeZone || 'Asia/Kolkata';
    const openH = opts.openHour != null ? opts.openHour : 9;
    const openM = opts.openMinute != null ? opts.openMinute : 15;
    const maxBars = opts.maxBars != null ? opts.maxBars : 6; // first 30m
    const asOf = asOfTs != null ? asOfTs : Date.now();
    const day = opts.day || this.zonedDay(asOf, tz);
    const openTs = this.zonedClockToUtc(day, tz, openH, openM);
    if (openTs == null) return null;
    // X-Candle must already exist (open bar started) and asOf must be at/after open
    if (asOf < openTs) return null;

    const session = [];
    for (let i = 0; i < bars5m.length; i++) {
      const b = bars5m[i];
      if (b.t < openTs) continue;
      if (this.zonedDay(b.t, tz) !== day) break;
      session.push(b);
      if (session.length >= maxBars) break;
    }
    for (const b of session) {
      if (b.c < b.o && b.h > b.l) {
        return {
          ...b,
          high: b.h,
          low: b.l,
          open: b.o,
          close: b.c,
          sessionId: opts.sessionId || null,
          sessionLabel: opts.sessionLabel || null,
          openHour: openH,
          openMinute: openM,
        };
      }
    }
    return null;
  },

  /**
   * BTC mid-zone X default: Asia Trikal 05:30 IST only.
   * Mark Fib stays 02:30–03:30 IST (separate). Use btcPobPrimes(asOf) for live list —
   * may expand London/NY on a dated desk test with DST-correct opens.
   */
  BTC_POB_PRIMES: [
    { id: 'asia', label: 'Asia', opens: [[5, 30]], activeFrom: 5 * 60 + 30, activeTo: 8 * 60 + 30 },
  ],

  /** Legacy flag — always false. London/NY mid-zone X must never feed live POB / auto. */
  BTC_POB_SESSION_TEST_DAY: null,

  btcPobSessionTestActive(_asOfTs = Date.now()) {
    return false;
  },

  /** Zone-local open → IST minutes-of-day (single DST-correct slot, not 19:00+20:00 mash). */
  sessionOpenIstMins(asOfTs, timeZone, hour, minute) {
    const day = this.zonedDay(asOfTs != null ? asOfTs : Date.now(), timeZone);
    const utc = this.zonedClockToUtc(day, timeZone, hour, minute);
    if (utc == null || !Number.isFinite(utc)) return hour * 60 + minute;
    const ist = this.zonedHms(utc, 'Asia/Kolkata');
    return ((ist.hour * 60 + ist.minute) % 1440 + 1440) % 1440;
  },

  /** BTC mid-zone POB primes — Asia 05:30 Trikal only (Dr Dev crypto). */
  btcPobPrimes(_asOfTs = Date.now()) {
    return [
      {
        id: 'asia',
        label: 'Asia',
        opens: [[5, 30]],
        activeFrom: 5 * 60 + 30,
        activeTo: 8 * 60 + 30,
      },
    ];
  },

  /**
   * Dr. Dev Brahmastra / Trikal Gold (XAUUSD) prime session transitions (IST):
   * Asia Bullion 05:30 · London Bullion (LBMA) 13:00/13:30 · COMEX / US 18:00/19:00/20:00.
   */
  XAU_POB_PRIMES: [
    { id: 'asia', label: 'Asia Bullion', opens: [[5, 30]], activeFrom: 5 * 60 + 30, activeTo: 8 * 60 + 30 },
    { id: 'london', label: 'London Bullion', opens: [[13, 0], [13, 30]], activeFrom: 13 * 60, activeTo: 16 * 60 },
    { id: 'ny', label: 'COMEX/NY', opens: [[18, 0], [19, 0], [20, 0]], activeFrom: 18 * 60, activeTo: 22 * 60 + 30 },
  ],

  /**
   * Dr. Dev Trikal Commodity / Natural Gas (MCX & NYMEX) prime session transitions (IST):
   * MCX Morning 09:00 · MCX Evening (Europe energy) 17:00 · US NYMEX Pit 18:30/19:30.
   */
  NG_POB_PRIMES: [
    { id: 'mcx_day', label: 'MCX Open', opens: [[9, 0]], activeFrom: 9 * 60, activeTo: 12 * 60 },
    { id: 'mcx_eve', label: 'MCX Eve', opens: [[17, 0]], activeFrom: 17 * 60, activeTo: 18 * 60 + 30 },
    { id: 'us', label: 'NYMEX Open', opens: [[18, 30], [19, 30]], activeFrom: 18 * 60 + 30, activeTo: 22 * 60 },
  ],

  findPrimeSessionXCandle5m(bars5m, asOfTs, opts = {}) {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const tz = opts.timeZone || 'Asia/Kolkata';
    const asOf = asOfTs != null ? asOfTs : Date.now();
    const z = this.zonedHms(asOf, tz);
    const mins = z.hour * 60 + z.minute;
    const day = this.zonedDay(asOf, tz);
    const primes = opts.primes || this.BTC_POB_PRIMES;
    const maxBars = opts.maxBars != null ? opts.maxBars : 6;

    // Strict: only while inside a prime window (no dead-hour fallback to a stale X)
    const candidates = primes.filter((p) => mins >= p.activeFrom && mins < p.activeTo);
    if (!candidates.length) return null;

    for (const prime of candidates) {
      for (const [oh, om] of prime.opens) {
        const x = this.findOpeningXCandle5m(bars5m, asOf, {
          timeZone: tz,
          openHour: oh,
          openMinute: om,
          maxBars,
          day,
          sessionId: prime.id,
          sessionLabel: `${prime.label} ${String(oh).padStart(2, '0')}:${String(om).padStart(2, '0')} IST`,
        });
        if (x) return x;
      }
    }
    return null;
  },

  /**
   * Dr. Dev Setup 1 — 5m X-Candle → POB retest → SHORT only.
   * NIFTY: NSE 09:15. BTC: Asia 05:30 Trikal only (not London/NY discovery boxes).
   * NOT Sagar Trade 1 leave. NOT a 1H candle. NOT a long setup.
   *
   *  1. X-Candle = first 5m red at session open (do not enter on it).
   *  2. Draw POB 0.44–0.56 on that 5m bar.
   *  3. Leave below → bounce retest → SHORT reject (5m close back below 0.44).
   *  4. Close above 0.56 after retest → INVALID — stand down (no auto-long).
   *  5. SL tight above POB high (0.56) / reject wick — NOT the X-Candle high (3–4R geometry).
   *  6. TP1 = Anchor (X) low · TP2 = session extension / ~2R. Session-bounded entry.
   */
  detectPobReject(xCandle, bars5m, asOfTs, touchPct = 0.15, opts = {}) {
    const fibs = this.firstRedFibs(xCandle);
    if (!xCandle || !fibs?.pob || !Array.isArray(bars5m) || bars5m.length < 2) return null;
    const pobHi = fibs.pob.high;
    const pobLo = fibs.pob.low;
    const xHi = Math.max(xCandle.high || 0, xCandle.h || 0, 1);
    const xLoRaw = Math.min(
      xCandle.low != null ? xCandle.low : Infinity,
      xCandle.l != null ? xCandle.l : Infinity,
    );
    const xRange = Number.isFinite(xLoRaw) && xHi > xLoRaw ? (xHi - xLoRaw) : xHi * 0.002;
    // BTC: tol from X size (price-% was too wide). NIFTY/XAU/NG: keep prior price-%.
    const useBtcTol = opts.btcTol === true;
    const tol = useBtcTol
      ? Math.max(xRange * 0.02, Math.min(xRange * 0.08, xHi * (touchPct / 100)))
      : (touchPct / 100) * xHi;
    const asOf = asOfTs != null ? asOfTs : Date.now();
    const tz = opts.timeZone || 'Asia/Kolkata';
    const z = this.zonedHms(asOf, tz);
    const mins = z.hour * 60 + z.minute;
    const entryCutoff = opts.entryCutoffMins; // absolute IST minutes-of-day (optional)
    const maxEntryMins = opts.maxEntryMins != null ? opts.maxEntryMins : 150; // ~2.5h after X
    const barMs = 5 * 60 * 1000;
    const sessBit = xCandle.sessionLabel ? ` · ${xCandle.sessionLabel}` : '';

    // Do not enter on the X-Candle itself — need at least one later closed bar
    const minutesSinceX = (asOf - xCandle.t) / 60000;
    const withinRel = minutesSinceX <= maxEntryMins;
    const withinAbs = entryCutoff == null || mins <= entryCutoff;
    const beforeCutoff = withinRel && withinAbs;
    if (minutesSinceX < 5) {
      return {
        status: 'x_candle_wait',
        watching: true,
        triggered: false,
        side: null,
        pobHi,
        pobLo,
        xCandle,
        fibs,
        label: `Open candle marked${sessBit} @ ${pobLo.toFixed(1)}–${pobHi.toFixed(1)} — do not enter; wait for mid-zone retest`,
      };
    }

    const closed = [];
    for (let k = 0; k < bars5m.length; k++) {
      const b = bars5m[k];
      if (b.t <= xCandle.t) continue;
      if (b.t + barMs - 1500 > asOf) continue;
      closed.push(b);
    }
    if (!closed.length) {
      return {
        status: 'await_retest',
        watching: true,
        triggered: false,
        side: null,
        pobHi,
        pobLo,
        xCandle,
        fibs,
        label: `Await mid-zone retest of open candle${sessBit} ${pobLo.toFixed(1)}–${pobHi.toFixed(1)}`,
      };
    }

    const touchesPob = (b) => b.h >= (pobLo - tol) && b.l <= (pobHi + tol);
    // Classic Dr. Dev: pullback into 44–56 → 5m close back below 0.44.
    // Close > 0.56 after touch = INVALID (no long). TP1 requires entry still above Anchor low.
    const xLo = xCandle.low || xCandle.l;
    let touched = false;
    let invalid = false;
    let rejectBar = null;
    for (const b of closed) {
      if (touchesPob(b)) touched = true;
      if (!touched) {
        if (b.c > pobHi + tol) {
          invalid = true;
          break;
        }
        continue;
      }
      if (b.c > pobHi + tol) {
        invalid = true;
        break;
      }
      if (b.c < pobLo - tol && b.c > xLo) {
        rejectBar = b;
        break;
      }
    }

    const last = closed[closed.length - 1];
    // Fresh impulse window ~20m (4× 5m) — not a multi-hour chase
    const freshMs = (opts.freshMins != null ? opts.freshMins : 20) * 60 * 1000;

    if (invalid) {
      return {
        status: 'short_invalidated',
        watching: false,
        triggered: false,
        side: null,
        pobHi,
        pobLo,
        xCandle,
        fibs,
        label: `POB blew through ${pobHi.toFixed(1)}${sessBit} — short INVALID (stand down, no long)`,
      };
    }

    if (rejectBar) {
      const rejectCloseTs = rejectBar.t + barMs;
      const age = asOf - rejectCloseTs;
      const stillBelow = last.c < pobLo - tol;
      const triggered = age >= 0 && age <= freshMs && stillBelow && beforeCutoff;
      return {
        status: triggered ? 'triggered' : (stillBelow ? 'stale' : 'watching'),
        watching: !triggered && touched && beforeCutoff,
        triggered,
        side: 'bearish',
        pobHi,
        pobLo,
        xCandle,
        fibs,
        triggerBar: rejectBar,
        triggerTs: rejectBar.t,
        // Fill at POB edge (0.44) — Dr. Dev "enter near midpoint" for 3–4R; reject close is confirmation not chase fill
        triggerPrice: pobLo,
        // Asymmetric R:R — SL tight above POB 0.56 (NOT X-Candle high / wild wick)
        stopHint: (() => {
          const band = Math.max(pobHi - pobLo, (xCandle.high || xCandle.h) * 0.0002);
          const wickCap = pobHi + band * 0.5;
          const wick = rejectBar.h;
          const raw = (wick > pobHi && wick <= wickCap) ? wick : pobHi;
          return raw * 1.00008;
        })(),
        // TP1 magnet: Anchor candle low (0.0 Fib of X)
        tpHint: xCandle.low || xCandle.l,
        hoursSince: minutesSinceX / 60,
        label: triggered
          ? `Mid-zone SHORT${sessBit} · 5m close < ${pobLo.toFixed(1)} after retest`
          : (beforeCutoff
            ? `POB rejected${sessBit} — wait fresh window / still below ${pobLo.toFixed(1)}`
            : `POB reject${sessBit} outside session entry window — stand down`),
      };
    }

    if (touched) {
      return {
        status: 'watching',
        watching: beforeCutoff,
        triggered: false,
        side: 'bearish',
        pobHi,
        pobLo,
        xCandle,
        fibs,
        label: `POB retested${sessBit} ${pobLo.toFixed(1)}–${pobHi.toFixed(1)} — wait 5m reject close < 0.44 (SHORT only)`,
      };
    }

    return {
      status: 'await_retest',
      watching: beforeCutoff,
      triggered: false,
      side: null,
      pobHi,
      pobLo,
      xCandle,
      fibs,
      label: `Open candle (5m)${sessBit} — wait pullback into mid-zone ${pobLo.toFixed(1)}–${pobHi.toFixed(1)} then SHORT reject`,
    };
  },

  /**
   * Median + Fib 44/50/56 on a candle high→low (Sagar 1H first-red OR Dr. Dev 5m X-Candle).
   * Median = Fib 50. POB = 0.50 ±6% band (0.44–0.56).
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
      f0: low,
      f44,
      f50,
      f56,
      f1: high,
      median: f50,
      // Dr. Devendra Pratap Singh Point of Balance (POB 44–56):
      // Midpoint (0.50 fair value) with ±6% deviation corridor (0.44 to 0.56).
      pob: {
        high: Math.max(f44, f56),
        low: Math.min(f44, f56),
        mid: f50,
        deviationPct: 6,
        label: 'POB (Point of Balance 44–56)',
      },
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
      if (asOfTs != null && b.t + barMs - 1500 > asOfTs) continue;
      if (asOfTs != null && (asOfTs - b.t) > lookMs) continue;
      closed.push(b);
    }
    if (!closed.length) return null;

    // Sticky confirm bar per sweep OR post-Trade-1 pullback retest episode:
    // 1. Liquidity sweep: price briefly wicks beyond box high (or low) for <2 closes and rejects back inside.
    // 2. Sagar / shelf retest Pullback Re-test:
    //    a) First, price must complete a real Trade 1 departure (closes clear of the box: b.l > hi for LONG, b.h < lo for SHORT).
    //    b) Second, on a later bar, price pulls back to touch/enter the box (b.l <= hi + ptol and b.c <= hi + boxRange * 0.35).
    //    c) Third, on a subsequent bar after the dip, a 5m candle closes back out in trend direction (once per session box).
    const tol = (touchPct / 100) * firstRed.high;
    const boxRange = Math.max(1, hi - lo);
    const ptol = Math.max(firstRed.high * 0.00015, boxRange * 0.12); // ~3.5 pts on NIFTY: real retest of box top/bottom
    let activeSweepHi = null;
    let activeSweepLo = null;
    let barsClosedAboveHi = 0;
    let barsClosedBelowLo = 0;
    let clearedAboveHi = false;
    let clearedBelowLo = false;
    let pullbackFromAboveLo = null;
    let pullbackFromAboveBarIdx = -1;
    let pullbackFromBelowHi = null;
    let pullbackFromBelowBarIdx = -1;
    let didPullbackLong = false;
    let didPullbackShort = false;
    let lastShortConfirm = null;
    let lastLongConfirm = null;
    for (let i = 0; i < closed.length; i++) {
      const b = closed[i];
      if (b.c > hi) {
        barsClosedAboveHi++;
        barsClosedBelowLo = 0;
        if (barsClosedAboveHi >= 2 && b.l > hi) clearedAboveHi = true;
      } else if (b.c < lo) {
        barsClosedBelowLo++;
        barsClosedAboveHi = 0;
        if (barsClosedBelowLo >= 2 && b.h < lo) clearedBelowLo = true;
      }

      // If price breaks all the way through the opposite side of the box, reset pullback state
      if (b.c < lo - tol) {
        pullbackFromAboveLo = null;
        clearedAboveHi = false;
      }
      if (b.c > hi + tol) {
        pullbackFromBelowHi = null;
        clearedBelowLo = false;
      }

      // Confirm Trade 2 Bullish Pullback Continuation on a bar AFTER the pullback dip bar (once per box)
      const maxReclaimChase = hi + Math.max(boxRange * 1.1, firstRed.high * 0.0016);
      if (
        !didPullbackLong
        && pullbackFromAboveLo != null
        && i > pullbackFromAboveBarIdx
        && b.c > hi
        && b.c > b.o
        && b.c <= maxReclaimChase
      ) {
        lastLongConfirm = {
          side: 'bullish',
          read: 'pullback_reclaim_high',
          bar: b,
          strong: true,
          sweepExtreme: pullbackFromAboveLo,
          level: hi,
          buysOnly: true,
          medianOk: true,
        };
        didPullbackLong = true;
        pullbackFromAboveLo = null;
        activeSweepHi = null;
        continue;
      }
      // Confirm Trade 2 Bearish Pullback Continuation on a bar AFTER the pullback bounce bar (once per box)
      const minRejectChase = lo - Math.max(boxRange * 1.1, firstRed.high * 0.0016);
      if (
        !didPullbackShort
        && pullbackFromBelowHi != null
        && i > pullbackFromBelowBarIdx
        && b.c < lo
        && b.c < b.o
        && b.c >= minRejectChase
      ) {
        lastShortConfirm = {
          side: 'bearish',
          read: 'pullback_reject_low',
          bar: b,
          strong: true,
          sweepExtreme: pullbackFromBelowHi,
          level: lo,
          sellsOnly: true,
          medianOk: true,
        };
        didPullbackShort = true;
        pullbackFromBelowHi = null;
        activeSweepLo = null;
        continue;
      }

      // Track post-Trade-1 pullback into the session box (only AFTER price first cleared the box)
      if (!didPullbackLong && clearedAboveHi && b.l <= hi + ptol && b.l >= lo - tol && (b.c <= b.o || b.c <= hi + ptol)) {
        if (pullbackFromAboveLo == null) pullbackFromAboveBarIdx = i;
        pullbackFromAboveLo = pullbackFromAboveLo == null ? b.l : Math.min(pullbackFromAboveLo, b.l);
      }
      if (!didPullbackShort && clearedBelowLo && b.h >= lo - ptol && b.h <= hi + tol && (b.c >= b.o || b.c >= lo - ptol)) {
        if (pullbackFromBelowHi == null) pullbackFromBelowBarIdx = i;
        pullbackFromBelowHi = pullbackFromBelowHi == null ? b.h : Math.max(pullbackFromBelowHi, b.h);
      }

      // Classic liquidity sweep (only when NOT a multi-bar trend breakout pulling back into support/resistance)
      if (b.h > hi && barsClosedAboveHi <= 2) {
        activeSweepHi = activeSweepHi == null ? b.h : Math.max(activeSweepHi, b.h);
      } else if (barsClosedAboveHi > 2) {
        activeSweepHi = null;
      }
      if (b.l < lo && barsClosedBelowLo <= 2) {
        activeSweepLo = activeSweepLo == null ? b.l : Math.min(activeSweepLo, b.l);
      } else if (barsClosedBelowLo > 2) {
        activeSweepLo = null;
      }
      if (activeSweepHi != null && b.c < hi) {
        lastShortConfirm = {
          side: 'bearish',
          read: 'liq_sweep_high',
          bar: b,
          strong: b.c < median,
          sweepExtreme: activeSweepHi,
          level: hi,
          sellsOnly: true,
          medianOk: b.c < median,
        };
        activeSweepHi = null;
      }
      if (activeSweepLo != null && b.c > lo) {
        lastLongConfirm = {
          side: 'bullish',
          read: 'liq_sweep_low',
          bar: b,
          strong: b.c > median,
          sweepExtreme: activeSweepLo,
          level: lo,
          buysOnly: true,
          medianOk: b.c > median,
        };
        activeSweepLo = null;
      }
    }

    const lastBar = closed[closed.length - 1];
    const prevBar = closed.length >= 2 ? closed[closed.length - 2] : null;
    const freshLimitMs = 20 * 60 * 1000;
    // Retest bounce confirmation: latest bar must not be actively drifting against the trade
    const lastBarIsBullish = lastBar && (lastBar.c >= lastBar.o || (prevBar && lastBar.c > prevBar.h));
    const lastBarIsBearish = lastBar && (lastBar.c <= lastBar.o || (prevBar && lastBar.c < prevBar.l));

    const shortValid = lastShortConfirm
      && (asOfTs == null || (asOfTs - lastShortConfirm.bar.t) <= freshLimitMs)
      && (lastShortConfirm.read === 'pullback_reject_low' ? (lastBar.c < lo && lastBarIsBearish) : lastBar.c < hi);
    const longValid = lastLongConfirm
      && (asOfTs == null || (asOfTs - lastLongConfirm.bar.t) <= freshLimitMs)
      && (lastLongConfirm.read === 'pullback_reclaim_high' ? (lastBar.c > hi && lastBarIsBullish) : lastBar.c > lo);

    if (shortValid && !longValid) return lastShortConfirm;
    if (longValid && !shortValid) return lastLongConfirm;
    if (shortValid && longValid) {
      if (lastShortConfirm.bar.t !== lastLongConfirm.bar.t) {
        return lastShortConfirm.bar.t > lastLongConfirm.bar.t ? lastShortConfirm : lastLongConfirm;
      }
      return lastBar.c <= median ? lastShortConfirm : lastLongConfirm;
    }

    // Active post-Trade-1 pullback inside the session box (waiting for 5m close back outside box)
    if (pullbackFromAboveLo != null && lastBar && lastBar.c >= lo - tol && lastBar.c <= hi + tol) {
      return {
        side: 'bullish',
        read: 'pullback_watch_long',
        bar: lastBar,
        strong: false,
        sweepExtreme: pullbackFromAboveLo,
        level: hi,
        buysOnly: true,
        medianOk: lastBar.c >= median,
      };
    }
    if (pullbackFromBelowHi != null && lastBar && lastBar.c <= hi + tol && lastBar.c >= lo - tol) {
      return {
        side: 'bearish',
        read: 'pullback_watch_short',
        bar: lastBar,
        strong: false,
        sweepExtreme: pullbackFromBelowHi,
        level: lo,
        sellsOnly: true,
        medianOk: lastBar.c <= median,
      };
    }

    // No fresh liquidity close-through — check ONLY the latest closed 5m bar in zone for WATCH
    const zoneHi = Math.max(hi, fibs.f44) + tol;
    const zoneLo = Math.min(lo, fibs.f56) - tol;
    if (lastBar && lastBar.l <= zoneHi && lastBar.h >= zoneLo) {
      if (lastBar.c > median) {
        return { side: 'bullish', read: 'median_watch', bar: lastBar, strong: false, sweepExtreme: null, medianOk: true };
      }
      if (lastBar.c < median) {
        return { side: 'bearish', read: 'median_watch', bar: lastBar, strong: false, sweepExtreme: null, medianOk: true };
      }
      return { side: null, read: 'at_median', bar: lastBar, strong: false, sweepExtreme: null };
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
        if (asOfTs != null && b.t + 5 * 60 * 1000 - 1500 > asOfTs) continue;
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

    // Dr. Devendra Pratap Singh: Point of Balance (POB 44–56) Retest & Rejection rule
    // First red candle is an "X Candle / Trap" — institutional confirmation requires
    // waiting for price to retest the POB (0.44–0.56) and reject.
    const pobHi = fibs?.pob?.high ?? (fibs ? Math.max(fibs.f44, fibs.f56) : null);
    const pobLo = fibs?.pob?.low ?? (fibs ? Math.min(fibs.f44, fibs.f56) : null);
    let pobRetested = false;
    let inPob = false;
    let pobRejectedBearish = false;
    let pobRejectedBullish = false;
    if (pobHi != null && pobLo != null) {
      inPob = price <= (pobHi + tol) && price >= (pobLo - tol);
      if (Array.isArray(bars5m) && bars5m.length) {
        for (let k = 0; k < bars5m.length; k++) {
          const b = bars5m[k];
          if (b.t <= firstRed.t) continue;
          if (asOfTs != null && b.t + 5 * 60 * 1000 - 1500 > asOfTs) continue;
          if (b.h >= (pobLo - tol) && b.l <= (pobHi + tol)) {
            pobRetested = true;
          }
        }
      }
      if (pobRetested && price < pobLo) {
        pobRejectedBearish = true;
      } else if (pobRetested && price > pobHi) {
        pobRejectedBullish = true;
      }
    }
    const pobStatus = inPob
      ? 'in_pob'
      : pobRejectedBearish
        ? 'pob_rejected_bearish'
        : pobRejectedBullish
          ? 'pob_rejected_bullish'
          : (pobRetested ? 'pob_retested' : 'pob_untested');
    const isXCandleTrap = (hoursSince != null && hoursSince < 0.25) || (!pobRetested && !sweptHigh5 && !sweptLow5 && inside);

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
    let departBar = null;
    // Sticky first close beyond the pivot in the current leave episode (5m).
    // Walking newest→oldest while still outside; first chronologically = trigger.
    let firstDepart5 = null;
    if ((leftAbove || leftBelow) && Array.isArray(bars5m) && bars5m.length) {
      for (let k = bars5m.length - 1; k >= 0; k--) {
        const b5 = bars5m[k];
        if (b5.t < firstRed.t) break;
        if (asOfTs != null && b5.t + 5 * 60 * 1000 - 1500 > asOfTs) continue;
        const out5 = leftAbove ? b5.c > firstRed.high : b5.c < firstRed.low;
        if (out5) {
          firstDepart5 = b5;
          continue;
        }
        if (firstDepart5) break;
      }
    }
    if ((leftAbove || leftBelow) && Array.isArray(slice) && slice.length >= 2) {
      const lookBars = slice.slice(-3, -1);
      const wasInside = leftAbove
        ? lookBars.some((b) => b.c <= firstRed.high + tol)
        : lookBars.some((b) => b.c >= firstRed.low - tol);
      if (wasInside) {
        const cur15 = slice[slice.length - 1];
        const prev15 = slice[slice.length - 2];
        const workMs = Math.max(60000, cur15.t - prev15.t);
        // Match leftAbove/leftBelow/out5 (no tol) — tol here used to re-arm
        // prevAlreadyOut false and slide triggerTs one extra 15m bar.
        const prevAlreadyOut = leftAbove
          ? prev15.c > firstRed.high
          : prev15.c < firstRed.low;
        const cur15Closed = asOfTs == null || (cur15.t + workMs - 1500 <= asOfTs);
        let closed5mOut = null;
        if (Array.isArray(bars5m) && bars5m.length) {
          const anchorT = prevAlreadyOut ? prev15.t : cur15.t;
          for (let k = bars5m.length - 1; k >= 0; k--) {
            const b5 = bars5m[k];
            if (b5.t < anchorT) break;
            if (asOfTs != null && b5.t + 5 * 60 * 1000 - 1500 > asOfTs) continue;
            const out5 = leftAbove ? b5.c > firstRed.high : b5.c < firstRed.low;
            if (out5) closed5mOut = b5;
          }
        }
        if (prevAlreadyOut) {
          justDeparted = true;
          departBar = firstDepart5 || closed5mOut || prev15;
        } else if (cur15Closed || closed5mOut) {
          justDeparted = true;
          departBar = firstDepart5 || closed5mOut || cur15;
        }
      }
    }
    const trade1Fresh = (leftAbove || leftBelow)
      && justDeparted
      && (hoursSince == null || (hoursSince >= 0.25 && hoursSince <= 3.0))
      && distFromPivotPct <= 1.0;

    let id = 'marked';
    let label = '1H first red marked (H/L liquidity + median)';
    if (revisitWindow) {
      id = 'trade2_revisit';
      label = revisitRead === 'pullback_reclaim_high'
        ? 'Trade 2 · session box retested from above → 5m reclaimed High (LONG)'
        : revisitRead === 'pullback_reject_low'
          ? 'Trade 2 · session box retested from below → 5m rejected Low (SHORT)'
          : revisitRead === 'pullback_watch_long'
            ? 'Trade 2 WATCH · Bullish pullback inside session box — wait 5m close > High for LONG'
            : revisitRead === 'pullback_watch_short'
              ? 'Trade 2 WATCH · Bearish pullback inside session box — wait 5m close < Low for SHORT'
              : revisitRead === 'liq_sweep_high'
                ? (revisitStrong
                  ? 'Trade 2 · box high swept → 5m closed below (SHORT)'
                  : 'Trade 2 · box high swept — wait 5m close below high & median')
                : revisitRead === 'liq_sweep_low'
                  ? (revisitStrong
                    ? 'Trade 2 · box low swept → 5m closed above (LONG)'
                    : 'Trade 2 · box low swept — wait 5m close above low & median')
                  : revisitRead === 'median_watch'
                    ? (revisitSide === 'bullish'
                      ? 'Trade 2 WATCH · 5m above median — wait close > box high or low sweep'
                      : 'Trade 2 WATCH · 5m below median — wait close < box low or high sweep')
                    : 'Trade 2 · Revisit of Red Bar H/L — wait 5m close-through confirmation';
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
      /** Trade 1 wins setupKind over Trade 2 — anchors must follow the same priority. */
      triggerTs: (trade1Fresh && departBar ? departBar.t : null)
        || (conf5 && conf5.bar && conf5.bar.t)
        || null,
      /** Trigger bar close price (anchors 0.5R anti-chase check). */
      triggerPrice: (trade1Fresh && departBar ? departBar.c : null)
        || (conf5 && conf5.bar && conf5.bar.c)
        || null,
      distFromPivotPct,
      trade2TriggerTs: (conf5 && conf5.bar && conf5.bar.t) || null,
      trade2TriggerPrice: (conf5 && conf5.bar && conf5.bar.c) || null,
      leftAbove,
      leftBelow,
      pivotHigh: firstRed.high,
      pivotLow: firstRed.low,
      pivotMid,
      fibs,
      pob: fibs?.pob || null,
      pobStatus,
      pobRetested,
      pobRejectedBearish,
      pobRejectedBullish,
      inPob,
      isXCandleTrap,
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
  detectSessionSweep(slice, clock, asiaHl, londonHl, firstRed1h = null, asOfTs = null) {
    if (!Array.isArray(slice) || slice.length < 5 || !clock) return null;
    const last = slice[slice.length - 1];
    const workBarMs = this._inferBarMs(slice, 15 * 60 * 1000);
    // In live mode, if the tip bar is still forming, evaluate the just-closed bar to avoid unclosed wick fakes
    const useSlice = (asOfTs != null && last.t + workBarMs - 1500 > asOfTs && slice.length >= 6)
      ? slice.slice(0, -1)
      : slice;
    const cur = useSlice[useSlice.length - 1];
    const prior3 = useSlice.slice(-4, -1);
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
          triggerTs: cur.t,
          triggerPrice: cur.c,
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
          triggerTs: cur.t,
          triggerPrice: cur.c,
          label: `${clock.label} swept ${poolName} low (${pool.low.toFixed?.(0) ?? pool.low}) & reclaimed → LONG`,
        };
      }
      return null;
    };

    if ((clock.id === 'london' || clock.id === 'pre_london') && asiaHl) {
      return checkPool(asiaHl, 'Asia');
    }
    if (clock.id === 'us_open') {
      return checkPool(londonHl, 'London') || checkPool(asiaHl, 'Asia');
    }
    return null;
  },

  /**
   * Aggregate smaller timeframe bars (e.g. 5m, 15m) into 30m bars aligned to 30m epoch boundaries.
   */
  aggregateBarsTo30m(bars) {
    if (!Array.isArray(bars) || !bars.length) return [];
    const bucketMs = 30 * 60 * 1000;
    const dur = bars.length >= 2 ? (bars[bars.length - 1].t - bars[bars.length - 2].t) : 0;
    if (dur >= 25 * 60 * 1000 && dur <= 35 * 60 * 1000) {
      return bars.slice();
    }
    const map = new Map();
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.t == null || !Number.isFinite(b.c)) continue;
      const t0 = Math.floor(b.t / bucketMs) * bucketMs;
      const ex = map.get(t0);
      if (!ex) {
        map.set(t0, { t: t0, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
      } else {
        ex.h = Math.max(ex.h, b.h);
        ex.l = Math.min(ex.l, b.l);
        ex.c = b.c;
        ex.v += (b.v || 0);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.t - b.t);
  },

  /**
   * Dr. Devendra Pratap Singh — Setup 3: 30m 5 EMA "Rubber Band" Mean Reversion Reversal.
   *
   * Principle:
   * 1. On a 30m chart with 5 EMA, candles cannot stay detached for long.
   *    Within 4 to 6 candles (usually ~5), price mathematically snaps back like a stretched rubber band.
   * 2. Detachment:
   *    - Oversold: 30m candle high is strictly below 5 EMA (bar.h < ema).
   *    - Overbought: 30m candle low is strictly above 5 EMA (bar.l > ema).
   *    - Consecutive detached count >= 4 primes the setup.
   * 3. The "Barricade" Entry:
   *    - On LTF (5m/15m), find the recent swing lower-high (oversold) or higher-low (overbought).
   *    - When price breaks and closes across the Barricade, tension snaps!
   *    - Target = 30m 5 EMA line (mean reversion magnet).
   *    - Stop Loss = Extreme wick of the drop/rally (extremely tight risk, high R:R).
   */
  detect30m5EmaRubberBand(bars, bars5m = null, evalTs = null) {
    if (!Array.isArray(bars) || bars.length < 5) return null;
    const bucketMs = 30 * 60 * 1000;
    const bars30 = this.aggregateBarsTo30m(bars);
    if (bars30.length < 6) return null;

    // Compute 5 EMA on 30m bars
    const k = 2 / (5 + 1); // 1/3
    let ema = 0;
    for (let i = 0; i < 5; i++) ema += bars30[i].c;
    ema /= 5;
    const emaSeries = [{ t: bars30[4].t, ema, bar: bars30[4] }];
    for (let i = 5; i < bars30.length; i++) {
      ema = bars30[i].c * k + ema * (1 - k);
      emaSeries.push({ t: bars30[i].t, ema, bar: bars30[i] });
    }

    const evalT = evalTs != null ? evalTs : Date.now();
    // Only evaluate completed or nearly completed 30m bars
    const closedEmas = emaSeries.filter((e) => e.t + bucketMs - 1500 <= evalT);
    if (!closedEmas.length) return null;

    const latest = closedEmas[closedEmas.length - 1];
    const latestBar = latest.bar;
    const latestEma = latest.ema;

    let detachedType = null; // 'below' (oversold -> bullish snapback) | 'above' (overbought -> bearish snapback)
    if (latestBar.h < latestEma) detachedType = 'below';
    else if (latestBar.l > latestEma) detachedType = 'above';
    else return null;

    let detachedCount = 0;
    const detachedBars = [];
    for (let i = closedEmas.length - 1; i >= 0; i--) {
      const item = closedEmas[i];
      if (detachedType === 'below' && item.bar.h < item.ema) {
        detachedCount++;
        detachedBars.push(item.bar);
      } else if (detachedType === 'above' && item.bar.l > item.ema) {
        detachedCount++;
        detachedBars.push(item.bar);
      } else {
        break;
      }
    }

    if (detachedCount < 4) {
      return {
        status: 'building',
        primed: false,
        triggered: false,
        detachedCount,
        detachedType,
        ema5: latestEma,
      };
    }

    // >= 4 bars detached: Rubber Band is Primed!
    const ltfBars = (Array.isArray(bars5m) && bars5m.length) ? bars5m : bars;
    const oldestDetachedT = detachedBars[detachedBars.length - 1].t;
    const candidateLtf = ltfBars.filter((b) => b.t >= oldestDetachedT && b.t <= evalT);

    let extremePrice = detachedType === 'below' ? Infinity : -Infinity;
    let extremeBar = null;
    for (const b of candidateLtf) {
      if (detachedType === 'below' && b.l < extremePrice) {
        extremePrice = b.l;
        extremeBar = b;
      } else if (detachedType === 'above' && b.h > extremePrice) {
        extremePrice = b.h;
        extremeBar = b;
      }
    }

    // Barricade = last LTF swing against the dump/rally (Dr. Dev):
    // oversold → most recent swing high before the extreme low;
    // overbought → most recent swing low before the extreme high.
    let barricade = null;
    let extremeIdx = 0;
    if (detachedType === 'below') {
      let lo = Infinity;
      for (let i = 0; i < candidateLtf.length; i++) {
        if (candidateLtf[i].l < lo) { lo = candidateLtf[i].l; extremeIdx = i; }
      }
      const end = Math.max(1, extremeIdx);
      for (let i = 1; i < end; i++) {
        const b = candidateLtf[i];
        const prev = candidateLtf[i - 1];
        const next = candidateLtf[i + 1] || b;
        if (b.h >= prev.h && b.h >= next.h) barricade = b.h;
      }
      if (barricade == null || !Number.isFinite(barricade)) {
        let mh = -Infinity;
        for (let i = 0; i <= end; i++) mh = Math.max(mh, candidateLtf[i].h);
        barricade = mh > -Infinity ? mh : latestBar.h;
      }
    } else {
      let hi = -Infinity;
      for (let i = 0; i < candidateLtf.length; i++) {
        if (candidateLtf[i].h > hi) { hi = candidateLtf[i].h; extremeIdx = i; }
      }
      const end = Math.max(1, extremeIdx);
      for (let i = 1; i < end; i++) {
        const b = candidateLtf[i];
        const prev = candidateLtf[i - 1];
        const next = candidateLtf[i + 1] || b;
        if (b.l <= prev.l && b.l <= next.l) barricade = b.l;
      }
      if (barricade == null || !Number.isFinite(barricade)) {
        let ml = Infinity;
        for (let i = 0; i <= end; i++) ml = Math.min(ml, candidateLtf[i].l);
        barricade = ml < Infinity ? ml : latestBar.l;
      }
    }

    // Trigger only on a closed LTF close through the barricade (not a wick poke).
    const lastBar = candidateLtf[candidateLtf.length - 1] || latestBar;
    const currentPrice = lastBar.c;
    const triggered = detachedType === 'below' ? (currentPrice > barricade) : (currentPrice < barricade);
    const direction = detachedType === 'below' ? 'bullish' : 'bearish';
    const targetPrice = latestEma;
    const stopLoss = extremePrice;
    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(targetPrice - currentPrice);
    const rr = risk > 0 ? (reward / risk) : 1;

    return {
      status: triggered ? 'triggered' : 'primed',
      triggered,
      primed: true,
      direction,
      detachedCount,
      detachedType,
      ema5: latestEma,
      targetPrice,
      stopLoss,
      barricade,
      extremePrice,
      rr,
      triggerBar: triggered ? lastBar : null,
      triggerTs: triggered ? lastBar.t : null,
      triggerPrice: triggered ? currentPrice : null,
      label: triggered
        ? `Setup 3 overlay: Barricade broken (${direction.toUpperCase()}) · 30m 5 EMA target ${targetPrice.toFixed(1)} — not DNA ENTER`
        : `Setup 3 overlay primed: ${detachedCount}× 30m detached · Barricade ${barricade.toFixed(1)} · 5 EMA ${latestEma.toFixed(1)}`,
    };
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
  /**
   * Dr. Devendra Pratap Singh — morning session range (09:15–12:30 IST)
   * for the Trikal 12:45 London Open afternoon engine.
   * Morning High / Low / 50% Mid lock after 12:30.
   */
  computeMorningRange(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const targetDay = evalHms.day;

    const morningBars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 9 * 60 + 15 && mins < 12 * 60 + 30;
    });

    if (!morningBars.length) return null;

    let morningHigh = -Infinity;
    let morningLow = Infinity;
    for (const b of morningBars) {
      if (b.h > morningHigh) morningHigh = b.h;
      if (b.l < morningLow) morningLow = b.l;
    }
    const morningMid = (morningHigh + morningLow) / 2;
    const lastMorningBar = morningBars[morningBars.length - 1];
    const morningBias = lastMorningBar.c >= morningMid ? 'bullish' : 'bearish';

    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const locked = evalMins >= 12 * 60 + 30;

    return {
      day: targetDay,
      morningHigh,
      morningLow,
      morningMid,
      morningBias,
      barCount: morningBars.length,
      locked,
    };
  },

  /**
   * Dr. Devendra Pratap Singh — Trikal 12:45 Afternoon Engine (NIFTY / Indian Indices):
   * - Phase 1: 09:15–12:30 Morning range (H/L/Mid)
   * - Chop: 11:30–12:30 Lunch decay — no fresh entries
   * - Phase 2: 12:45 London Open 30m Trikal Anchor
   *   Reversal: trap the 12:45 auction itself (red → reclaim high / green → reclaim low)
   *            — NOT a required sweep of morning H/L
   *   Breakout: clean expansion beyond morning High / Low after the London box
   */
  detect1245AfternoonSetup(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const targetDay = evalHms.day;

    const morning = this.computeMorningRange(bars5m, evalTs, tz);
    if (!morning || !morning.locked) {
      if (evalMins >= 11 * 60 + 30 && evalMins < 12 * 60 + 30) {
        return {
          status: 'lunch_decay',
          setupKind: 'lunch_decay',
          side: null,
          triggered: false,
          label: 'Lunch Decay Zone (11:30–12:30 IST) · No fresh entries · Wait for 12:45 London Open',
          morning,
        };
      }
      return null;
    }

    if (evalMins < 12 * 60 + 45) {
      return {
        status: 'awaiting_1245',
        setupKind: 'awaiting_1245',
        side: null,
        triggered: false,
        label: 'Awaiting 12:45 IST London Open Candle · Morning Range Locked',
        morning,
      };
    }

    // Dr Dev: decisions on CLOSED 5m candles only — never a still-forming bar.
    const barMs5 = 5 * 60 * 1000;
    const isClosed5 = (b) => b.t + barMs5 - 1500 <= evalTs;

    // 12:45 30m candle (12:45 to 13:15 IST)
    const window1245Bars = bars5m.filter((b) => {
      if (!isClosed5(b)) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 12 * 60 + 45 && mins < 13 * 60 + 15;
    });

    if (!window1245Bars.length) return null;

    // Box must be complete (13:15 IST) before any breakout / trap reversal is read.
    if (evalMins < 13 * 60 + 15) {
      return {
        status: 'box_forming',
        setupKind: 'afternoon_1245_watch',
        side: null,
        triggered: false,
        label: '12:45 London box forming (closes 13:15 IST) · Wait for it to complete',
        morning,
      };
    }

    const bar1245Open = window1245Bars[0].o;
    let bar1245High = -Infinity;
    let bar1245Low = Infinity;
    for (const b of window1245Bars) {
      if (b.h > bar1245High) bar1245High = b.h;
      if (b.l < bar1245Low) bar1245Low = b.l;
    }
    const bar1245Last = window1245Bars[window1245Bars.length - 1];
    const bar1245Close = bar1245Last.c;
    const bar1245Mid = (bar1245High + bar1245Low) / 2;
    const bar1245Color = bar1245Close >= bar1245Open ? 'green' : 'red';

    const afternoonBars = bars5m.filter((b) => {
      if (!isClosed5(b)) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 12 * 60 + 45 && mins <= 15 * 60 + 5;
    });
    if (!afternoonBars.length) return null;

    const lastBar = afternoonBars[afternoonBars.length - 1];
    const currentPrice = lastBar.c;

    // Bullish Breakout & Retest: Price above morning high
    if (currentPrice > morning.morningHigh) {
      let crossIdx = -1;
      for (let i = 0; i < afternoonBars.length; i++) {
        const b = afternoonBars[i];
        const prev = i > 0 ? afternoonBars[i - 1] : null;
        if (b.c > morning.morningHigh && (!prev || prev.c <= morning.morningHigh)) {
          crossIdx = i;
        }
      }
      const crossBar = crossIdx >= 0 ? afternoonBars[crossIdx] : afternoonBars[0] || lastBar;

      // Check for Shelf Retest / Pullback (shelf retest mechanics in afternoon)
      let retestBar = null;
      if (crossIdx >= 0 && crossIdx < afternoonBars.length - 1) {
        let testedShelf = false;
        for (let i = crossIdx + 1; i < afternoonBars.length; i++) {
          const b = afternoonBars[i];
          const prev = afternoonBars[i - 1];
          if (b.l <= morning.morningHigh + 10 && b.l >= morning.morningHigh - 15) {
            testedShelf = true;
          }
          if (testedShelf && b.c > b.o && b.c > prev.h) {
            retestBar = b;
          }
        }
      }

      if (retestBar) {
        const triggerBar = retestBar;
        const triggerPrice = triggerBar.c;
        const triggerTs = triggerBar.t;
        const stopLoss = triggerBar.l; // Structural swing low of the bounce candle
        const risk = triggerPrice - stopLoss;
        const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
        return {
          setupKind: 'afternoon_1245_retest',
          side: 'bullish',
          triggered: isRiskOk,
          stopStructural: isRiskOk,
          triggerPrice,
          triggerTs,
          bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
          morning,
          stopLoss,
          tp1: triggerPrice + risk,
          tp2: triggerPrice + risk * 2,
          tp3: triggerPrice + risk * 3,
          rr: 3,
          label: isRiskOk
            ? 'Afternoon retest · Morning High Shelf Bounce Confirmed · shelf retest'
            : `12:45 Retest risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
        };
      }

      // Initial Breakout
      const triggerBar = crossBar;
      const triggerPrice = triggerBar.c;
      const triggerTs = triggerBar.t;
      const stopLoss = Math.max(bar1245Low, triggerBar.l);
      const risk = triggerPrice - stopLoss;
      const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
      return {
        setupKind: 'afternoon_1245_breakout',
        side: 'bullish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: triggerPrice + risk,
        tp2: triggerPrice + risk * 2,
        tp3: triggerPrice + risk * 3,
        rr: 3,
        label: isRiskOk
          ? 'Afternoon breakout · Afternoon window · Expansion Above Morning High'
          : `12:45 Breakout risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
      };
    }

    // Bearish Breakout & Retest: Price below morning low
    if (currentPrice < morning.morningLow) {
      let crossIdx = -1;
      for (let i = 0; i < afternoonBars.length; i++) {
        const b = afternoonBars[i];
        const prev = i > 0 ? afternoonBars[i - 1] : null;
        if (b.c < morning.morningLow && (!prev || prev.c >= morning.morningLow)) {
          crossIdx = i;
        }
      }
      const crossBar = crossIdx >= 0 ? afternoonBars[crossIdx] : afternoonBars[0] || lastBar;

      // Check for Shelf Retest / Pullback (shelf retest mechanics in afternoon)
      let retestBar = null;
      if (crossIdx >= 0 && crossIdx < afternoonBars.length - 1) {
        let testedShelf = false;
        for (let i = crossIdx + 1; i < afternoonBars.length; i++) {
          const b = afternoonBars[i];
          const prev = afternoonBars[i - 1];
          if (b.h >= morning.morningLow - 10 && b.h <= morning.morningLow + 15) {
            testedShelf = true;
          }
          if (testedShelf && b.c < b.o && b.c < prev.l) {
            retestBar = b;
          }
        }
      }

      if (retestBar) {
        const triggerBar = retestBar;
        const triggerPrice = triggerBar.c;
        const triggerTs = triggerBar.t;
        const stopLoss = triggerBar.h; // Structural swing high of the rejection candle
        const risk = stopLoss - triggerPrice;
        const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
        return {
          setupKind: 'afternoon_1245_retest',
          side: 'bearish',
          triggered: isRiskOk,
          stopStructural: isRiskOk,
          triggerPrice,
          triggerTs,
          bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
          morning,
          stopLoss,
          tp1: triggerPrice - risk,
          tp2: triggerPrice - risk * 2,
          tp3: triggerPrice - risk * 3,
          rr: 3,
          label: isRiskOk
            ? 'Afternoon retest · Morning Low Shelf Rejection Confirmed · shelf retest'
            : `12:45 Retest risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
        };
      }

      // Initial Bearish Breakout
      const triggerBar = crossBar;
      const triggerPrice = triggerBar.c;
      const triggerTs = triggerBar.t;
      const stopLoss = Math.min(bar1245High, triggerBar.h);
      const risk = stopLoss - triggerPrice;
      const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
      return {
        setupKind: 'afternoon_1245_breakout',
        side: 'bearish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: triggerPrice - risk,
        tp2: triggerPrice - risk * 2,
        tp3: triggerPrice - risk * 3,
        rr: 3,
        label: isRiskOk
          ? 'Afternoon breakout · Afternoon window · Expansion Below Morning Low'
          : `12:45 Breakout risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
      };
    }

    // Bullish Reversal: Sellers trapped in red 12:45 candle (auction trap — not morning-low sweep)
    if (bar1245Color === 'red' && currentPrice > bar1245High) {
      let crossBar = null;
      for (let i = 0; i < afternoonBars.length; i++) {
        const b = afternoonBars[i];
        const prev = i > 0 ? afternoonBars[i - 1] : null;
        if (b.c > bar1245High && (!prev || prev.c <= bar1245High)) {
          crossBar = b;
        }
      }
      const triggerBar = crossBar || afternoonBars[0] || lastBar;
      const triggerPrice = triggerBar.c;
      const triggerTs = triggerBar.t;
      // Dr. Dev Reversal Stop: Low of the reversal bounce candle or 12:45 median
      const stopLoss = Math.max(bar1245Mid, triggerBar.l);
      const risk = triggerPrice - stopLoss;
      const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
      return {
        setupKind: 'afternoon_1245_reversal',
        side: 'bullish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: triggerPrice + risk,
        tp2: triggerPrice + risk * 2,
        tp3: Math.max(morning.morningMid, triggerPrice + risk * 3),
        rr: risk > 0 ? ((triggerPrice + risk * 3) - triggerPrice) / risk : 3,
        label: isRiskOk
          ? 'Afternoon reversal · Afternoon window · Sellers Trapped in 12:45 Red Candle'
          : `12:45 Reversal risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
      };
    }

    // Bearish Reversal: Buyers trapped in green 12:45 candle (auction trap — not morning-high sweep)
    if (bar1245Color === 'green' && currentPrice < bar1245Low) {
      let crossBar = null;
      for (let i = 0; i < afternoonBars.length; i++) {
        const b = afternoonBars[i];
        const prev = i > 0 ? afternoonBars[i - 1] : null;
        if (b.c < bar1245Low && (!prev || prev.c >= bar1245Low)) {
          crossBar = b;
        }
      }
      const triggerBar = crossBar || afternoonBars[0] || lastBar;
      const triggerPrice = triggerBar.c;
      const triggerTs = triggerBar.t;
      // Dr. Dev Reversal Stop: High of the reversal drop candle or 12:45 median
      const stopLoss = Math.min(bar1245Mid, triggerBar.h);
      const risk = stopLoss - triggerPrice;
      const isRiskOk = risk > 0; // afternoon: structural stop OK; no Renko-style 25pt mix-in
      return {
        setupKind: 'afternoon_1245_reversal',
        side: 'bearish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: triggerPrice - risk,
        tp2: triggerPrice - risk * 2,
        tp3: Math.min(morning.morningMid, triggerPrice - risk * 3),
        rr: risk > 0 ? (triggerPrice - (triggerPrice - risk * 3)) / risk : 3,
        label: isRiskOk
          ? 'Afternoon reversal · Afternoon window · Buyers Trapped in 12:45 Green Candle'
          : `12:45 Reversal risk (${risk.toFixed(1)} pts) is wide — structural stop kept; size options carefully`,
      };
    }

    return {
      status: 'watching_afternoon',
      setupKind: 'afternoon_1245_watch',
      side: null,
      triggered: false,
      bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
      morning,
      label: `Afternoon window marked (${bar1245Color.toUpperCase()}) · Awaiting Reversal or Breakout`,
    };
  },

  /**
   * Dr. Dev BTC / crypto Asia Trikal (NOT NIFTY 12:45):
   * Mark the 05:30 IST 30m candle (Asia / daily open X). After it closes (06:00),
   * trade breakout of that candle's high/low through the Asia window (~08:30).
   * Risk: structural stop at opposite X extreme; ENTER only if stop ≤ ~1% of price
   * (same desk stopPct gate as other BTC DNA). Red Bar T1/T2 still primary elsewhere.
   */
  detectBtcAsia0530Trikal(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const targetDay = evalHms.day;

    if (evalMins < 5 * 60 + 30) return null;
    if (evalMins >= 8 * 60 + 30) return null;

    const xBars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 5 * 60 + 30 && mins < 6 * 60;
    });
    if (!xBars.length) return null;

    const xOpen = xBars[0].o;
    let xHigh = -Infinity;
    let xLow = Infinity;
    for (const b of xBars) {
      if (b.h > xHigh) xHigh = b.h;
      if (b.l < xLow) xLow = b.l;
    }
    const xLast = xBars[xBars.length - 1];
    const xClose = xLast.c;
    const xMid = (xHigh + xLow) / 2;
    const xColor = xClose >= xOpen ? 'green' : 'red';
    const xRange = xHigh - xLow;
    if (!(xRange > 0)) return null;

    if (evalMins < 6 * 60) {
      return {
        status: 'forming',
        setupKind: 'btc_asia_0530_watch',
        side: null,
        triggered: false,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: 'Asia 05:30 X forming (30m) · Wait for 06:00 close then breakout',
      };
    }

    const barMs5 = 5 * 60 * 1000;
    // Dr Dev: breakout = closed 5m beyond X — never a still-forming wick.
    const afterBars = bars5m.filter((b) => {
      if (b.t + barMs5 - 1500 > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 6 * 60 && mins <= evalMins;
    });
    if (!afterBars.length) {
      return {
        status: 'awaiting_breakout',
        setupKind: 'btc_asia_0530_watch',
        side: null,
        triggered: false,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: `Asia 05:30 X marked (${xColor.toUpperCase()}) · Awaiting breakout of ${xHigh.toFixed(0)} / ${xLow.toFixed(0)}`,
      };
    }

    const lastBar = afterBars[afterBars.length - 1];
    const price = lastBar.c;
    const maxRiskPct = 1.0;

    // Bullish breakout: FIRST 5m close above Asia X high (one-shot; invalidated if price closes back inside X)
    let bullCross = null;
    let bullCrossIdx = -1;
    for (let i = 0; i < afterBars.length; i++) {
      const b = afterBars[i];
      const prev = i > 0 ? afterBars[i - 1] : null;
      if (!bullCross && b.c > xHigh && (!prev || prev.c <= xHigh)) {
        bullCross = b;
        bullCrossIdx = i;
      }
    }
    let bullFailedBackInside = false;
    if (bullCross && bullCrossIdx >= 0) {
      for (let j = bullCrossIdx + 1; j < afterBars.length; j++) {
        if (afterBars[j].c <= xHigh) {
          bullFailedBackInside = true;
          break;
        }
      }
    }

    // Bearish breakout: FIRST 5m close below Asia X low (one-shot; invalidated if price closes back inside X)
    let bearCross = null;
    let bearCrossIdx = -1;
    for (let i = 0; i < afterBars.length; i++) {
      const b = afterBars[i];
      const prev = i > 0 ? afterBars[i - 1] : null;
      if (!bearCross && b.c < xLow && (!prev || prev.c >= xLow)) {
        bearCross = b;
        bearCrossIdx = i;
      }
    }
    let bearFailedBackInside = false;
    if (bearCross && bearCrossIdx >= 0) {
      for (let j = bearCrossIdx + 1; j < afterBars.length; j++) {
        if (afterBars[j].c >= xLow) {
          bearFailedBackInside = true;
          break;
        }
      }
    }

    if (bullCross && !bullFailedBackInside && price > xHigh) {
      const triggerPrice = bullCross.c;
      const triggerTs = bullCross.t;
      const stopLoss = Math.min(xLow, bullCross.l);
      const risk = triggerPrice - stopLoss;
      const riskPct = triggerPrice > 0 ? (risk / triggerPrice) * 100 : 99;
      const isRiskOk = risk > 0 && riskPct <= maxRiskPct;
      return {
        setupKind: 'btc_asia_0530_breakout',
        side: 'bullish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        stopLoss,
        tp1: triggerPrice + risk,
        tp2: triggerPrice + risk * 2,
        tp3: triggerPrice + risk * 3,
        rr: 3,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: isRiskOk
          ? 'BTC Asia 05:30 · Breakout above 30m X high · Asia open clock'
          : `BTC Asia 05:30 breakout risk ${riskPct.toFixed(2)}% > ${maxRiskPct}% — wait tighter retest of X high`,
      };
    }

    if (bearCross && !bearFailedBackInside && price < xLow) {
      const triggerPrice = bearCross.c;
      const triggerTs = bearCross.t;
      const stopLoss = Math.max(xHigh, bearCross.h);
      const risk = stopLoss - triggerPrice;
      const riskPct = triggerPrice > 0 ? (risk / triggerPrice) * 100 : 99;
      const isRiskOk = risk > 0 && riskPct <= maxRiskPct;
      return {
        setupKind: 'btc_asia_0530_breakout',
        side: 'bearish',
        triggered: isRiskOk,
        stopStructural: isRiskOk,
        triggerPrice,
        triggerTs,
        stopLoss,
        tp1: triggerPrice - risk,
        tp2: triggerPrice - risk * 2,
        tp3: triggerPrice - risk * 3,
        rr: 3,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: isRiskOk
          ? 'BTC Asia 05:30 · Breakout below 30m X low · Asia open clock'
          : `BTC Asia 05:30 breakout risk ${riskPct.toFixed(2)}% > ${maxRiskPct}% — wait tighter retest of X low`,
      };
    }

    if (bullFailedBackInside || bearFailedBackInside) {
      return {
        status: 'invalidated_chop',
        setupKind: 'btc_asia_0530_watch',
        side: null,
        triggered: false,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: `Asia 05:30 breakout failed back inside X (${xLow.toFixed(0)}–${xHigh.toFixed(0)}) · Chop — no re-entry`,
      };
    }

    return {
      status: 'watching',
      setupKind: 'btc_asia_0530_watch',
      side: null,
      triggered: false,
      xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
      label: `Asia 05:30 X marked (${xColor.toUpperCase()}) · Inside range · Wait break of ${xHigh.toFixed(0)} / ${xLow.toFixed(0)}`,
    };
  },

  /**
   * Dr. Devendra Pratap Singh: 5:30 Formula & MCX Trikal Anchor (CRUDEOIL & NATURALGAS).
   * - At 17:30 IST (London/Europe energy open), a pivotal 30m candle forms (17:30–18:00 IST).
   * - Closes at 18:00 IST, locking the 30m range High, Low, Midpoint (0.50), and direction.
   * - Execution Window: 18:00 to 22:30 IST (Europe session + US NYMEX floor open).
   * - Setups:
   *   1. Breakout (mcx_530_breakout): First 5m candle closing cleanly outside 30m range.
   *      - Stop Loss: opposite extreme of 30m candle or 5m breakout swing, floored at structural min (15 pts Crude, 2.5 pts NG).
   *      - Target: 2.4R (36 pts) on Crude Oil; 2.5R on NG.
   *   2. Retest (mcx_530_retest): After breakout, price must touch the broken High/Low shelf,
   *      then a later green/red 5m must close back through that shelf (bounce/reject confirm).
   *      Proximity alone is NOT a retest.
   *   3. Trap Reversal (mcx_530_reversal): Failed breakout that closes back inside the range across midpoint.
   */
  detectMcx530FormulaTrikal(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const targetDay = evalHms.day;

    // Active from 17:30 IST until pre-close (22:45 IST)
    if (evalMins < 17 * 60 + 30) return null;
    if (evalMins >= 22 * 60 + 45) return null;

    const barMs5 = 5 * 60 * 1000;
    const isClosed5 = (b) => b.t + barMs5 - 1500 <= evalTs;

    // Filter 5m bars that make up the 17:30–18:00 IST 30m candle
    const xBars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 17 * 60 + 30 && mins < 18 * 60;
    });

    if (!xBars.length) return null;

    const xOpen = xBars[0].o;
    let xHigh = -Infinity;
    let xLow = Infinity;
    for (const b of xBars) {
      if (b.h > xHigh) xHigh = b.h;
      if (b.l < xLow) xLow = b.l;
    }
    const xLast = xBars[xBars.length - 1];
    const xClose = xLast.c;
    const xMid = (xHigh + xLow) / 2;
    const xColor = xClose >= xOpen ? 'green' : 'red';
    const xRange = xHigh - xLow;
    if (!(xRange > 0)) return null;

    // 17:30 to 18:00 IST: 30m candle is still forming
    if (evalMins < 18 * 60) {
      return {
        status: 'forming',
        setupKind: 'mcx_530_watch',
        side: null,
        triggered: false,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: `MCX 5:30 Formula candle forming (17:30–18:00 IST) · Range ${xLow.toFixed(1)}–${xHigh.toFixed(1)} · Wait for 18:00 close`,
      };
    }

    // Closed 5m bars after 18:00 IST
    const afterBars = bars5m.filter((b) => {
      if (!isClosed5(b)) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 18 * 60 && mins <= evalMins;
    });

    if (!afterBars.length) {
      return {
        status: 'awaiting_breakout',
        setupKind: 'mcx_530_watch',
        side: null,
        triggered: false,
        xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
        label: `MCX 5:30 Formula candle marked (${xColor.toUpperCase()}) · Range: ${xLow.toFixed(1)}–${xHigh.toFixed(1)} · Awaiting breakout`,
      };
    }

    const lastBar = afterBars[afterBars.length - 1];
    const price = lastBar.c;

    // Detect first bullish breakout close above xHigh
    let bullCross = null;
    let bullCrossIdx = -1;
    for (let i = 0; i < afterBars.length; i++) {
      const b = afterBars[i];
      const prev = i > 0 ? afterBars[i - 1] : null;
      if (!bullCross && b.c > xHigh && (!prev || prev.c <= xHigh)) {
        bullCross = b;
        bullCrossIdx = i;
      }
    }
    let bullFailedBackInside = false;
    let bullReversalBar = null;
    if (bullCross && bullCrossIdx >= 0) {
      for (let j = bullCrossIdx + 1; j < afterBars.length; j++) {
        if (afterBars[j].c < xMid) {
          bullFailedBackInside = true;
          if (!bullReversalBar) bullReversalBar = afterBars[j];
          break;
        }
      }
    }

    // Detect first bearish breakout close below xLow
    let bearCross = null;
    let bearCrossIdx = -1;
    for (let i = 0; i < afterBars.length; i++) {
      const b = afterBars[i];
      const prev = i > 0 ? afterBars[i - 1] : null;
      if (!bearCross && b.c < xLow && (!prev || prev.c >= xLow)) {
        bearCross = b;
        bearCrossIdx = i;
      }
    }
    let bearFailedBackInside = false;
    let bearReversalBar = null;
    if (bearCross && bearCrossIdx >= 0) {
      for (let j = bearCrossIdx + 1; j < afterBars.length; j++) {
        if (afterBars[j].c > xMid) {
          bearFailedBackInside = true;
          if (!bearReversalBar) bearReversalBar = afterBars[j];
          break;
        }
      }
    }

    // Trap Reversal: price pierced one side then closed back inside past midpoint
    if (bullCross && bullFailedBackInside && bullReversalBar && price < xMid) {
      const targetAchieved = price <= xLow;
      if (!targetAchieved) {
        const triggerPrice = bullReversalBar.c;
        const triggerTs = bullReversalBar.t;
        const stopLoss = xHigh;
        const risk = Math.abs(stopLoss - triggerPrice);
        return {
          setupKind: 'mcx_530_reversal',
          side: 'bearish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Trap Reversal SHORT below mid ${xMid.toFixed(1)} · Target ${xLow.toFixed(1)}`,
        };
      }
    }

    if (bearCross && bearFailedBackInside && bearReversalBar && price > xMid) {
      const targetAchieved = price >= xHigh;
      if (!targetAchieved) {
        const triggerPrice = bearReversalBar.c;
        const triggerTs = bearReversalBar.t;
        const stopLoss = xLow;
        const risk = Math.abs(triggerPrice - stopLoss);
        return {
          setupKind: 'mcx_530_reversal',
          side: 'bullish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Trap Reversal LONG above mid ${xMid.toFixed(1)} · Target ${xHigh.toFixed(1)}`,
        };
      }
    }

    // Bullish: prefer true shelf retest (touch broken high → later 5m bounce close back above)
    // over plain proximity after breakout. Matches Dr Dev / afternoon Trikal shelf DNA.
    if (bullCross && !bullFailedBackInside) {
      const shelfPad = Math.max(xRange * 0.08, Math.abs(xHigh) * 0.0004);
      let retestBar = null;
      if (bullCrossIdx >= 0 && bullCrossIdx < afterBars.length - 1) {
        let testedShelf = false;
        for (let i = bullCrossIdx + 1; i < afterBars.length; i++) {
          const b = afterBars[i];
          const prev = afterBars[i - 1];
          if (b.l <= xHigh + shelfPad && b.l >= xHigh - shelfPad * 1.5) testedShelf = true;
          // Bounce confirm: green 5m that closes above shelf after the touch
          if (testedShelf && b.c > xHigh && b.c > b.o && b.c >= prev.h) {
            retestBar = b;
            break;
          }
        }
      }
      if (retestBar) {
        const triggerPrice = retestBar.c;
        const triggerTs = retestBar.t;
        const stopLoss = Math.min(xLow, retestBar.l);
        const risk = triggerPrice - stopLoss;
        return {
          setupKind: 'mcx_530_retest',
          side: 'bullish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Retest shelf bounce confirmed above ${xHigh.toFixed(1)}`,
        };
      }
      if (price >= xHigh) {
        const triggerPrice = bullCross.c;
        const triggerTs = bullCross.t;
        const stopLoss = Math.min(xLow, bullCross.l);
        const risk = triggerPrice - stopLoss;
        return {
          setupKind: 'mcx_530_breakout',
          side: 'bullish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Bullish breakout above ${xHigh.toFixed(1)} · Europe open momentum`,
        };
      }
    }

    // Bearish: shelf retest = touch broken low → later 5m reject close back below
    if (bearCross && !bearFailedBackInside) {
      const shelfPad = Math.max(xRange * 0.08, Math.abs(xLow) * 0.0004);
      let retestBar = null;
      if (bearCrossIdx >= 0 && bearCrossIdx < afterBars.length - 1) {
        let testedShelf = false;
        for (let i = bearCrossIdx + 1; i < afterBars.length; i++) {
          const b = afterBars[i];
          const prev = afterBars[i - 1];
          if (b.h >= xLow - shelfPad && b.h <= xLow + shelfPad * 1.5) testedShelf = true;
          if (testedShelf && b.c < xLow && b.c < b.o && b.c <= prev.l) {
            retestBar = b;
            break;
          }
        }
      }
      if (retestBar) {
        const triggerPrice = retestBar.c;
        const triggerTs = retestBar.t;
        const stopLoss = Math.max(xHigh, retestBar.h);
        const risk = stopLoss - triggerPrice;
        return {
          setupKind: 'mcx_530_retest',
          side: 'bearish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Retest shelf reject confirmed below ${xLow.toFixed(1)}`,
        };
      }
      if (price <= xLow) {
        const triggerPrice = bearCross.c;
        const triggerTs = bearCross.t;
        const stopLoss = Math.max(xHigh, bearCross.h);
        const risk = stopLoss - triggerPrice;
        return {
          setupKind: 'mcx_530_breakout',
          side: 'bearish',
          triggered: risk > 0,
          stopStructural: true,
          triggerPrice,
          triggerTs,
          stopLoss,
          xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
          label: `MCX 5:30 Formula · Bearish breakdown below ${xLow.toFixed(1)} · Europe open momentum`,
        };
      }
    }

    return {
      status: 'watching',
      setupKind: 'mcx_530_watch',
      side: null,
      triggered: false,
      xCandle: { high: xHigh, low: xLow, mid: xMid, color: xColor, open: xOpen, close: xClose },
      label: `MCX 5:30 Formula candle marked (${xColor.toUpperCase()}) · Inside ${xLow.toFixed(1)}–${xHigh.toFixed(1)} · Stand aside`,
    };
  },

  /**
   * Dr. Devendra Pratap Singh: Equinox Macro Territory Engine
   * Locks Vernal (March 20-21) and Autumnal (Sept 22-23) mean baseline levels.
   * - Above baseline: POSITIVE TERRITORY -> Calls only, Puts forbidden.
   * - Below baseline: NEGATIVE TERRITORY -> Puts only, Calls forbidden.
   */
  computeEquinoxMacro(price, instId = 'NIFTY', evalTs = null) {
    if (instId !== 'NIFTY') return null;
    const asOf = evalTs != null ? Number(evalTs) : Date.now();
    const z = this.zonedHms(asOf, 'Asia/Kolkata');
    const month = parseInt(String(z.day).slice(5, 7), 10);
    // Dr. Dev Equinox seasonal cycles: Vernal (March/April) and Autumnal (September/October)
    const seasonActive = month === 3 || month === 4 || month === 9 || month === 10;
    const baseline = (typeof process !== 'undefined' && process?.env?.NIFTY_EQUINOX_LEVEL)
      ? Number(process.env.NIFTY_EQUINOX_LEVEL)
      : 22860;
    const isPositive = price >= baseline;
    const territory = isPositive ? 'positive' : 'negative';
    const allowedSide = isPositive ? 'CALLS_ONLY' : 'PUTS_ONLY';
    const diff = price - baseline;
    const diffPct = (diff / baseline) * 100;

    return {
      baseline,
      territory,
      allowedSide,
      seasonActive,
      distancePts: diff,
      distancePct: diffPct,
      label: `Equinox Baseline: ${baseline} · Territory: ${territory.toUpperCase()} (${allowedSide.replace('_', ' ')}) · ${diff >= 0 ? '+' : ''}${diff.toFixed(0)} pts (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%)${!seasonActive ? ' [Off-Season]' : ''}`,
      allowsBullish: !seasonActive || isPositive,
      allowsBearish: !seasonActive || !isPositive,
    };
  },

  /**
   * Dr. Devendra Pratap Singh: 5m Squeeze Pattern (Volatility Compression & Expansion)
   * Detects wedge / corridor contraction in 5m candles and projects breakout impulse targets.
   */
  detectSqueezePattern(bars5m, evalTs, count = 6) {
    if (!Array.isArray(bars5m) || bars5m.length < count) return null;
    const recent = bars5m.slice(-count);
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (const b of recent) {
      if (b.h > highestHigh) highestHigh = b.h;
      if (b.l < lowestLow) lowestLow = b.l;
    }
    const height = highestHigh - lowestLow;
    const lastBar = recent[recent.length - 1];
    const currentPrice = lastBar.c;

    const isCompressing = height < (currentPrice * 0.0035);
    const brokenUp = currentPrice > highestHigh;
    const brokenDown = currentPrice < lowestLow;

    return {
      isSqueezing: isCompressing && !brokenUp && !brokenDown,
      brokenUp,
      brokenDown,
      squeezeHigh: highestHigh,
      squeezeLow: lowestLow,
      squeezeHeight: height,
      projectedTargetUp: highestHigh + height,
      projectedTargetDown: lowestLow - height,
    };
  },

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
    /** Trade 1/2/sweep SL: 15m swing H/L (Dev structure — not nearest 5m fractal) */
    bars5m = null,
    /** Trade 2 liquidity-sweep wick extreme (beyond 1H high/low) */
    sweepExtreme = null,
    setupKind = null,
    setup3 = null,
    pobReject = null,
    afternoon1245 = null,
    btcAsia0530 = null,
    mcx530 = null,
    instId = '',
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

    // Mid-zone SHORT — SL above POB 0.56 / reject wick; TP1 Anchor low; TP2 ~2R extension
    if (setupKind === 'pob_reject' && pobReject && pobReject.triggered) {
      const stopPad = price * 0.00008;
      let sp = pobReject.stopHint;
      if (!(Number.isFinite(sp)) || sp <= price) {
        sp = Math.max(pobReject.pobHi || 0, price) * 1.00015;
      }
      sp = sp + stopPad;
      const xLow = pobReject.tpHint != null
        ? pobReject.tpHint
        : (pobReject.xCandle?.low ?? pobReject.xCandle?.l);
      const riskDist = Math.abs(price - sp);
      // Inherent 3–4R when entry is near mid and SL is only ~12% of candle above POB
      let tp1 = Number.isFinite(xLow) && xLow < price ? xLow : price - riskDist;
      if (!(tp1 < price)) tp1 = price - riskDist;
      const tp2 = price - riskDist * 2; // session extension / 1:2R
      const tp3 = price - riskDist * 3;
      const rr = riskDist > 0 ? Math.abs(price - tp1) / riskDist : 1;
      return {
        invalidation: sp,
        invalidationReason: 'above POB 0.56 / reject wick',
        stopStructural: true,
        tp1,
        tp2,
        tp3,
        bookZone: tp1,
        firstMagnet: { price: tp1, label: 'Anchor (X) low' },
        bookReason: 'Mid-zone SHORT · stop mid top · bank at anchor / 2R — no overnight',
        bookIsMagnet: true,
        stopPct: (riskDist / price) * 100,
        targetPct: (Math.abs(tp1 - price) / price) * 100,
        rr,
        rrLadder: true,
        prevSwingLow: null,
        prevSwingHigh: sp,
      };
    }

    // Dr. Dev BTC Asia 05:30 breakout (30m X range)
    if (setupKind === 'btc_asia_0530_breakout' && btcAsia0530 && btcAsia0530.triggered) {
      const triggerP = btcAsia0530.triggerPrice ?? price;
      const sp = btcAsia0530.stopLoss ?? (trend === 'bullish' ? triggerP * 0.995 : triggerP * 1.005);
      const riskDist = Math.abs(triggerP - sp);
      const tp1 = trend === 'bullish' ? triggerP + riskDist : triggerP - riskDist;
      const tp2 = trend === 'bullish' ? triggerP + riskDist * 2 : triggerP - riskDist * 2;
      const tp3 = trend === 'bullish' ? triggerP + riskDist * 3 : triggerP - riskDist * 3;
      const stopPct = triggerP > 0 ? (riskDist / triggerP) * 100 : null;
      return {
        invalidation: sp,
        invalidationReason: 'Asia 05:30 X opposite extreme',
        stopStructural: true,
        tp1,
        tp2,
        tp3,
        bookZone: tp3,
        firstMagnet: { price: tp1, label: '1:1 R' },
        bookReason: 'BTC Asia 05:30 breakout · SL@X extreme · 1:1 → trail',
        bookIsMagnet: true,
        stopPct,
        targetPct: triggerP > 0 ? (Math.abs(tp3 - triggerP) / triggerP) * 100 : null,
        rr: 3.0,
        rrLadder: true,
        prevSwingLow: trend === 'bullish' ? sp : null,
        prevSwingHigh: trend === 'bearish' ? sp : null,
      };
    }

    // Dr. Dev Trikal 12:45 Afternoon Engine (Reversal, Breakout & Retest)
    if (setupKind === 'afternoon_1245_reversal' || setupKind === 'afternoon_1245_breakout' || setupKind === 'afternoon_1245_retest') {
      const isRetest = setupKind === 'afternoon_1245_retest';
      const isReversal = setupKind === 'afternoon_1245_reversal';
      const triggerP = afternoon1245?.triggerPrice ?? price;
      const sp = afternoon1245?.stopLoss ?? (trend === 'bullish' ? triggerP - 20 : triggerP + 20);
      const riskDist = Math.abs(triggerP - sp);
      const tp1 = trend === 'bullish' ? triggerP + riskDist : triggerP - riskDist;
      const tp2 = trend === 'bullish' ? triggerP + riskDist * 2 : triggerP - riskDist * 2;
      const tp3 = isReversal && afternoon1245?.morning?.morningMid
        ? (trend === 'bullish' ? Math.max(afternoon1245.morning.morningMid, triggerP + riskDist * 3) : Math.min(afternoon1245.morning.morningMid, triggerP - riskDist * 3))
        : (trend === 'bullish' ? triggerP + riskDist * 3 : triggerP - riskDist * 3);
      const stopPct = (riskDist / triggerP) * 100;
      const targetPct = (Math.abs(tp3 - triggerP) / triggerP) * 100;
      return {
        invalidation: sp,
        invalidationReason: isRetest
          ? '12:45 retest 5m bounce shelf stop'
          : (isReversal ? '12:45 reversal 5m swing stop' : '12:45 breakout 5m candle stop'),
        stopStructural: afternoon1245?.stopStructural ?? true,
        tp1,
        tp2,
        tp3,
        bookZone: tp3,
        firstMagnet: { price: tp2, label: '1:2R Partial' },
        bookReason: isRetest
          ? '12:45 Retest Morning High Shelf Bounce'
          : (isReversal ? '12:45 Afternoon London Sweep Reversal' : '12:45 Afternoon London Breakout'),
        bookIsMagnet: true,
        stopPct,
        targetPct,
        rr: 3.0,
        rrLadder: true,
        prevSwingLow: trend === 'bullish' ? sp : null,
        prevSwingHigh: trend === 'bearish' ? sp : null,
      };
    }

    // Dr. Dev MCX 5:30 Formula (17:30 IST 30m Europe energy candle breakout / retest / reversal)
    if (
      (setupKind === 'mcx_530_breakout' || setupKind === 'mcx_530_retest' || setupKind === 'mcx_530_reversal')
      && mcx530 && mcx530.triggered
    ) {
      const isRetest = setupKind === 'mcx_530_retest';
      const isReversal = setupKind === 'mcx_530_reversal';
      const triggerP = mcx530.triggerPrice ?? price;
      const isCrude = String(instId || '').toUpperCase().includes('CRUDE');
      const minStopPts = isCrude ? 15 : 2.5; // Dr Dev structural floor: 15 pts on Crude, 2.5 pts on NG
      const rMult = isCrude ? 2.4 : 2.5; // Dr Dev 2.4R on Crude (15 pt SL -> 36 pt TP), 2.5R on NG
      let sp = mcx530.stopLoss;
      let rawRisk = Math.abs(triggerP - sp);
      if (rawRisk < minStopPts) {
        sp = trend === 'bullish' ? triggerP - minStopPts : triggerP + minStopPts;
        rawRisk = minStopPts;
      }
      const riskDist = rawRisk;
      const tp1 = trend === 'bullish' ? triggerP + riskDist : triggerP - riskDist;
      const tp2 = trend === 'bullish' ? triggerP + riskDist * 2 : triggerP - riskDist * 2;
      const tp3 = trend === 'bullish' ? triggerP + riskDist * rMult : triggerP - riskDist * rMult;
      const stopPct = triggerP > 0 ? (riskDist / triggerP) * 100 : null;
      return {
        invalidation: sp,
        invalidationReason: isRetest
          ? '5:30 Formula retest 5m bounce shelf stop'
          : (isReversal ? '5:30 Formula trap reversal swing stop' : '5:30 Formula 30m Europe X stop'),
        stopStructural: true,
        tp1,
        tp2,
        tp3,
        bookZone: tp3,
        firstMagnet: { price: tp1, label: '1:1 R' },
        bookReason: isRetest
          ? 'MCX 5:30 Retest Shelf Bounce'
          : (isReversal ? 'MCX 5:30 Trap Reversal' : 'MCX 5:30 Europe Breakout'),
        bookIsMagnet: true,
        stopPct,
        targetPct: triggerP > 0 ? (Math.abs(tp3 - triggerP) / triggerP) * 100 : null,
        rr: rMult,
        rrLadder: true,
        prevSwingLow: trend === 'bullish' ? sp : null,
        prevSwingHigh: trend === 'bearish' ? sp : null,
      };
    }

    // Dr. Devendra Pratap Singh Setup 3: 30m 5 EMA Rubber Band
    if (setupKind === 'setup3_rubber_band' && setup3 && setup3.triggered) {
      const stopPad = price * 0.0006;
      const sp = setup3.direction === 'bullish'
        ? setup3.stopLoss - stopPad
        : setup3.stopLoss + stopPad;
      const tp = setup3.targetPrice;
      const riskDist = Math.abs(price - sp);
      const rewDist = Math.abs(tp - price);
      const rr = riskDist > 0 ? (rewDist / riskDist) : 1.5;
      const stopPct = (riskDist / price) * 100;
      const targetPct = (rewDist / price) * 100;
      const tp1 = setup3.direction === 'bullish' ? price + riskDist : price - riskDist;
      return {
        invalidation: sp,
        invalidationReason: setup3.direction === 'bullish' ? 'extreme drop wick (Setup 3 SL)' : 'extreme rally wick (Setup 3 SL)',
        stopStructural: true,
        tp1,
        tp2: tp,
        tp3: setup3.direction === 'bullish' ? tp * 1.005 : tp * 0.995,
        bookZone: tp,
        firstMagnet: { price: tp, label: '30m 5 EMA Line' },
        bookReason: '30m 5 EMA stretch snapback (chart guide)',
        bookIsMagnet: true,
        stopPct,
        targetPct,
        rr,
        prevSwingLow: setup3.direction === 'bullish' ? setup3.stopLoss : null,
        prevSwingHigh: setup3.direction === 'bearish' ? setup3.stopLoss : null,
      };
    }

    const workRecent = Array.isArray(slice) ? slice.slice(-10) : [];
    let localLow = workRecent.length ? Math.min(...workRecent.map((b) => b.l)) : null;
    let localHigh = workRecent.length ? Math.max(...workRecent.map((b) => b.h)) : null;
    let swingStopTagLow = 'prev swing low';
    let swingStopTagHigh = 'prev swing high';
    const extraSwingLowCands = [];
    const extraSwingHighCands = [];
    // Dev DNA T1/T2/sweep: SL beyond real structure on the working TF (desk default 15m).
    // Confirm stays on 5m close; stop is NOT nearest 5m fractal (that was desk noise-hunting).
    if (preferSwingStop && Array.isArray(slice) && slice.length >= 10) {
      const iW = slice.length - 1;
      const swW = this.nearestSwings(slice, iW, 2);
      const recentW = slice.slice(-16); // ~4h of 15m structure
      const minW = Math.min(...recentW.map((b) => b.l));
      const maxW = Math.max(...recentW.map((b) => b.h));
      const startW = Math.max(2, iW - 24);
      for (let j = startW; j <= iW - 2; j++) {
        const b = slice[j];
        if (b.l < slice[j - 1].l && b.l < slice[j - 2].l && b.l < slice[j + 1].l && b.l < slice[j + 2].l) {
          extraSwingLowCands.push(b.l);
        }
        if (b.h > slice[j - 1].h && b.h > slice[j - 2].h && b.h > slice[j + 1].h && b.h > slice[j + 2].h) {
          extraSwingHighCands.push(b.h);
        }
      }
      if (swW.swingLow != null) extraSwingLowCands.push(swW.swingLow);
      if (swW.nearLow != null) extraSwingLowCands.push(swW.nearLow);
      if (Number.isFinite(minW)) extraSwingLowCands.push(minW);
      if (swW.swingHigh != null) extraSwingHighCands.push(swW.swingHigh);
      if (swW.nearHigh != null) extraSwingHighCands.push(swW.nearHigh);
      if (Number.isFinite(maxW)) extraSwingHighCands.push(maxW);
      localLow = (swW.nearLow != null ? swW.nearLow : swW.swingLow) ?? minW;
      localHigh = (swW.nearHigh != null ? swW.nearHigh : swW.swingHigh) ?? maxW;
      swingStopTagLow = '15m swing low';
      swingStopTagHigh = '15m swing high';
    }
    const prevSwingLow = localLow;
    const prevSwingHigh = localHigh;
    const isMcxInstr = this.isMcxCommodity(instId);
    const minStopDist = price * 0.0006; // 6 bps minimum (wick pad only — never overwrite real shelf/Red Bar structure with a fake 0.28% floor)
    // BTC/crypto may clamp wide swings to 1.5%. MCX uses structural points only (15 / 2.5 floors elsewhere) — no synthetic % cap.
    const maxStopDist = isMcxInstr ? Infinity : price * 0.015;
    const pad = price * 0.0006;         // 6 bps buffer beyond structure wick
    const dnaSwingRe = /15m swing|structure swing/i;
    // Dr Dev: Trade 2 / sweep / T1 stop = shelf / wick / box edge FIRST — 15m swing is fallback only.
    const eventStructureRe = /shelf|sweep wick|1H red|session sweep/i;
    const shelfFirst = preferSwingStop && (
      setupKind === 'trade2_confirmed'
      || setupKind === 'trade2_watch'
      || setupKind === 'session_sweep'
      || setupKind === 'trade1_departure'
    );

    // Each candidate carries its structural source so the UI can say *why* the stop is there,
    // and flag when no real structure fits the window (BTC % cap / MCX keeps real structure).
    let invalidation = null;
    let invalidationReason = null;
    let stopStructural = false;
    const capReason = (rawDist, tag) => {
      if (isMcxInstr) return tag;
      return rawDist > maxStopDist
        ? `1.5% cap — real ${tag} is ${((rawDist / price) * 100).toFixed(2)}% away`
        : `0.28% floor — ${tag} too close`;
    };
    const pickStructuralStop = (candidates, isLong) => {
      const dist = (x) => (isLong ? price - x.v : x.v - price);
      const inWindow = (x) => dist(x) >= minStopDist && (isMcxInstr || dist(x) <= maxStopDist);
      const sortTight = (a, b) => (isLong ? b.v - a.v : a.v - b.v);
      const take = (pool, allowClamp) => {
        if (!pool.length) return false;
        const inWin = pool.filter(inWindow).sort(sortTight);
        if (inWin[0]) {
          invalidation = inWin[0].v;
          invalidationReason = inWin[0].tag;
          stopStructural = true;
          return true;
        }
        if (allowClamp && pool[0]) {
          const rawDist = dist(pool[0]);
          invalidation = isLong
            ? price - Math.min(maxStopDist, Math.max(minStopDist, rawDist))
            : price + Math.min(maxStopDist, Math.max(minStopDist, rawDist));
          invalidationReason = capReason(rawDist, pool[0].tag);
          stopStructural = true;
          return true;
        }
        return false;
      };
      if (shelfFirst) {
        const eventCands = candidates.filter((x) => eventStructureRe.test(x.tag)).sort(sortTight);
        // Event structure must win when present — do not invent a nearer 15m fractal.
        if (take(eventCands, true)) return;
      }
      const swingCands = preferSwingStop
        ? candidates.filter((x) => dnaSwingRe.test(x.tag)).sort(sortTight)
        : [];
      if (take(swingCands, true)) return;
      const valid = candidates.filter(inWindow).sort(sortTight);
      if (valid[0]) {
        invalidation = valid[0].v;
        invalidationReason = valid[0].tag;
        stopStructural = true;
        return;
      }
      const any = candidates.slice().sort(sortTight)[0];
      if (any) {
        const rawDist = dist(any);
        invalidation = isLong
          ? price - Math.min(maxStopDist, Math.max(minStopDist, rawDist))
          : price + Math.min(maxStopDist, Math.max(minStopDist, rawDist));
        invalidationReason = capReason(rawDist, any.tag);
        stopStructural = rawDist <= maxStopDist;
        return;
      }
      invalidation = isLong ? price - price * 0.0065 : price + price * 0.0065;
      invalidationReason = '0.65% default — no structure found';
      stopStructural = false;
    };

    if (trend === 'bullish') {
      // Dev: structural SL below the move — shelf/wick/box before 15m swing. Fibs = targets only.
      const rawCands = preferSwingStop
        ? [
          sweepExtreme != null && sweepExtreme < price ? { v: sweepExtreme - pad, tag: 'shelf / sweep wick (1H low)' } : null,
          sweep?.side === 'bullish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme - pad, tag: 'session sweep wick' } : null,
          firstRed1h?.low != null && firstRed1h.low < price ? { v: firstRed1h.low - pad, tag: '1H red low' } : null,
          localLow != null && localLow < price ? { v: localLow - pad, tag: swingStopTagLow } : null,
          ...extraSwingLowCands.filter((v) => v != null && v < price).map((v) => ({ v: v - pad, tag: '15m swing low' })),
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
      pickStructuralStop(rawCands.filter((x) => x && Number.isFinite(x.v) && x.v < price), true);
    } else {
      const rawCands = preferSwingStop
        ? [
          sweepExtreme != null && sweepExtreme > price ? { v: sweepExtreme + pad, tag: 'shelf / sweep wick (1H high)' } : null,
          sweep?.side === 'bearish' && sweep.wickExtreme != null ? { v: sweep.wickExtreme + pad, tag: 'session sweep wick' } : null,
          firstRed1h?.high != null && firstRed1h.high > price ? { v: firstRed1h.high + pad, tag: '1H red high' } : null,
          localHigh != null && localHigh > price ? { v: localHigh + pad, tag: swingStopTagHigh } : null,
          ...extraSwingHighCands.filter((v) => v != null && v > price).map((v) => ({ v: v + pad, tag: '15m swing high' })),
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
      pickStructuralStop(rawCands.filter((x) => x && Number.isFinite(x.v) && x.v > price), false);
    }

    // Indian Index (NIFTY / BANKNIFTY / SENSEX) & MCX (CRUDEOIL / NG) leave/retest: stop = real 5m structure (pullback wick / box mid / box edge / real swing).
    // Never pick a micro candle wiggle (< ~0.06% index pts or < ~0.12% MCX pts) when real box/pullback structure is right behind it.
    if (
      (this.isIndianIndex(instId) || this.isMcxCommodity(instId))
      && firstRed1h && Number.isFinite(firstRed1h.low) && Number.isFinite(firstRed1h.high)
      && (setupKind === 'trade1_departure' || setupKind === 'trade2_confirmed')
    ) {
      const isMcxStop = this.isMcxCommodity(instId);
      const boxPad = price * (isMcxStop ? 0.0003 : 0.00015); // ~3.5 pts on NIFTY, ~2.5 pts on Crude
      const minNiftyStop = price * (isMcxStop ? 0.0012 : 0.0006); // ~15 pts on NIFTY, ~36 pts on BANKNIFTY, ~48 pts on SENSEX, ~10 pts on CRUDEOIL, ~0.4 pts on NG
      const preferMax = price * (isMcxStop ? 0.0045 : 0.0016); // preference window only, not a skip rule
      const boxMid = (firstRed1h.high + firstRed1h.low) / 2;
      const last3 = Array.isArray(bars5m) && bars5m.length >= 3 ? bars5m.slice(-4, -1) : (Array.isArray(bars5m) ? bars5m.slice(-2) : []);
      const prev5Lo = last3.length ? Math.min(...last3.map((b) => b.l)) : null;
      const prev5Hi = last3.length ? Math.max(...last3.map((b) => b.h)) : null;
      if (trend === 'bullish') {
        const cands = [
          sweepExtreme != null && sweepExtreme < price ? { v: sweepExtreme - boxPad, tag: '5m swing (pullback low)', prio: 1 } : null,
          boxMid < price ? { v: boxMid - boxPad, tag: '5m swing (box 50% mid)', prio: 2 } : null,
          firstRed1h.low < price ? { v: firstRed1h.low - boxPad, tag: '5m swing (session box low)', prio: 3 } : null,
          prev5Lo != null && prev5Lo < price ? { v: prev5Lo - boxPad, tag: '5m swing (prev candle low)', prio: 4 } : null,
        ].filter((x) => x && Number.isFinite(x.v) && x.v < price);
        // Require at least minNiftyStop (~15 pts) if any candidate has >= minNiftyStop; otherwise pick widest available structure
        const realStruct = cands.filter((x) => (price - x.v) >= minNiftyStop);
        const pool = realStruct.length ? realStruct : cands;
        const preferred = pool
          .filter((x) => (price - x.v) <= preferMax)
          .sort((a, b) => (a.prio - b.prio) || (b.v - a.v));
        const pick = preferred[0] || pool.sort((a, b) => (realStruct.length ? (b.v - a.v) : (a.v - b.v)))[0];
        if (pick) {
          invalidation = pick.v;
          invalidationReason = pick.tag;
          stopStructural = true;
        }
      } else if (trend === 'bearish') {
        const cands = [
          sweepExtreme != null && sweepExtreme > price ? { v: sweepExtreme + boxPad, tag: '5m swing (pullback high)', prio: 1 } : null,
          boxMid > price ? { v: boxMid + boxPad, tag: '5m swing (box 50% mid)', prio: 2 } : null,
          firstRed1h.high > price ? { v: firstRed1h.high + boxPad, tag: '5m swing (session box high)', prio: 3 } : null,
          prev5Hi != null && prev5Hi > price ? { v: prev5Hi + boxPad, tag: '5m swing (prev candle high)', prio: 4 } : null,
        ].filter((x) => x && Number.isFinite(x.v) && x.v > price);
        const realStruct = cands.filter((x) => (x.v - price) >= minNiftyStop);
        const pool = realStruct.length ? realStruct : cands;
        const preferred = pool
          .filter((x) => (x.v - price) <= preferMax)
          .sort((a, b) => (a.prio - b.prio) || (a.v - b.v));
        const pick = preferred[0] || pool.sort((a, b) => (realStruct.length ? (a.v - b.v) : (b.v - a.v)))[0];
        if (pick) {
          invalidation = pick.v;
          invalidationReason = pick.tag;
          stopStructural = true;
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
    const workBarMs = this._inferBarMs(bars, 15 * 60 * 1000, i);
    const evalTs = (c.asOfTs != null && Number.isFinite(Number(c.asOfTs)))
      ? Number(c.asOfTs)
      : (i === bars.length - 1
        ? Math.min(Date.now(), bars[i].t + workBarMs)
        : bars[i].t + workBarMs - 1000);
    const cEval = { ...c, asOfTs: evalTs };
    const asOfDay = this.asOfDayFor(bars[i].t, cEval);
    const bands = this.buildBands(slice, cEval);
    const prior = this.priorBands(bands, asOfDay);
    const active = this.interactingBands(bands, price, asOfDay, c.touchPct);
    const { resist, support } = this.nearestLevels(bands, price, asOfDay);
    const { swingHigh, swingLow } = this.nearestSwings(bars, i, c.swingPivot || 3);
    const or = this.openingRange(slice, asOfDay, c.dayMode, cEval);
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

    const markWin = this.getMarkWindow(c);
    const isEarlyMarkAsset = !!(markWin && this.isSessionFib(c) && (Number(markWin.endHour) <= 6 || markWin.timeZone === 'America/New_York'));
    const cb = bands.find((b) => b.day === asOfDay) || null;
    // Dr Dev: CME / mark-window Fib ≠ Trade 1 first-red. Never invent firstRed from the Fib box.
    // BTC, XAU, and NG (firstRedTf: null) anchor directly to their Mark Fib box (isMarkWindow: true)
    // so there is never a second red box drawn or competing with the Mark Fib box.
    let firstRed1h = c.firstRed1h || null;
    if (!firstRed1h && c.firstRedTf === null) {
      const markBand = (cb && cb.locked !== false) ? cb : (prior.length ? prior[prior.length - 1] : cb);
      firstRed1h = markBand ? {
        high: markBand.high,
        low: markBand.low,
        open: markBand.low,
        close: markBand.high,
        t: markBand.t0,
        asOfDay,
        isMarkWindow: true,
      } : null;
    } else if (!firstRed1h && isEarlyMarkAsset) {
      const frBars = (Array.isArray(c.bars1h) && c.bars1h.length >= 24) ? c.bars1h : slice;
      const defaultFrMs = c.firstRedTf === '30m' ? 1800000 : 3600000;
      const frMs = (Array.isArray(c.bars1h) && c.bars1h.length >= 24)
        ? this._inferBarMs(frBars, defaultFrMs)
        : this._inferBarMs(frBars, 15 * 60 * 1000, i);
      firstRed1h = this.firstRedBarOfSession(frBars, asOfDay, {
        ...c,
        asOfTs: evalTs,
        barMs: frMs,
      });
    } else if (!firstRed1h && !isEarlyMarkAsset) {
      // Non-early assets may still omit firstRed — leave null (no mark-box fake).
      firstRed1h = null;
    }
    const firstRedFibs = this.firstRedFibs(firstRed1h);
    const bars5m = Array.isArray(c.bars5m) && c.bars5m.length ? c.bars5m : null;
    const dayMode = c.dayMode || 'ist';
    const istDay = this.zonedDay(bars[i].t, 'Asia/Kolkata');
    const priorDayStr = this.shiftDay(istDay, -1);
    const priorDay = this.calendarDayHl(slice, priorDayStr, dayMode);
    const clock = this.istClockPhase(evalTs);
    const redSetup = this.firstRedSetup(
      price, firstRed1h, evalTs, c.touchPct ?? 0.15, slice, bars5m,
    );

    const sessions = Array.isArray(c.sessions) ? c.sessions : [];
    const asiaSess = sessions.find((s) => ['asia', 'mcx_day'].includes((s.id || '').toLowerCase()))
      || sessions.find((s) => /asia|mcx\s*day/i.test(s.label || ''));
    const londonSess = sessions.find((s) => ['london', 'mcx_eve'].includes((s.id || '').toLowerCase()))
      || sessions.find((s) => /london|mcx\s*eve/i.test(s.label || ''));
    const nySess = sessions.find((s) => ['ny', 'us', 'newyork'].includes((s.id || '').toLowerCase()))
      || sessions.find((s) => /us|ny|new\s*york/i.test(s.label || ''));
    const asiaHl = asiaSess ? this.sessionHlForIstDay(slice, asiaSess, bars[i].t) : null;
    const londonHl = londonSess ? this.sessionHlForIstDay(slice, londonSess, bars[i].t) : null;
    const nyHl = nySess ? this.sessionHlForIstDay(slice, nySess, bars[i].t) : null;
    const asiaUntouched = !!(asiaHl && price < asiaHl.high && price > asiaHl.low);
    const sweep = this.detectSessionSweep(slice, clock, asiaHl, londonHl, firstRed1h, evalTs);
    // Dr. Devendra Pratap Singh: Setup 3 (30m 5 EMA Rubber Band Mean Reversion)
    const setup3 = this.detect30m5EmaRubberBand(slice, bars5m, evalTs);
    // Dr. Dev Setup 1 POB (5m X-Candle → retest → SHORT only). Never 1H first-red (tautology).
    // Indian indices: NSE/BSE 09:15 IST. BTC: Asia 05:30. MCX (CRUDEOIL, NG): 09:00 / 17:00 / NYMEX 18:30–19:30.
    const instId = String(c.id || c.instrumentId || '').toUpperCase();
    const isIndIdx = this.isIndianIndex(instId);
    const isMcx = this.isMcxCommodity(instId);
    const isBtc = !instId || instId === 'BTC';
    let xCandle5m = null;
    let pobOpts = null;
    if (bars5m && isIndIdx) {
      xCandle5m = this.findOpeningXCandle5m(bars5m, evalTs, {
        timeZone: 'Asia/Kolkata',
        openHour: 9,
        openMinute: 15,
        maxBars: 6,
        sessionId: 'nse',
        sessionLabel: `${instId === 'SENSEX' ? 'BSE' : 'NSE'} 09:15 IST`,
      });
      pobOpts = {
        timeZone: 'Asia/Kolkata',
        entryCutoffMins: 12 * 60 + 15,
        maxEntryMins: 180,
        freshMins: 20,
      };
    } else if (bars5m && isBtc) {
      xCandle5m = this.findPrimeSessionXCandle5m(bars5m, evalTs, {
        timeZone: 'Asia/Kolkata',
        primes: this.btcPobPrimes(evalTs),
        maxBars: 6,
      });
      pobOpts = {
        timeZone: 'Asia/Kolkata',
        maxEntryMins: 150,
        freshMins: 20,
        btcTol: true,
      };
    } else if (bars5m && isMcx) {
      const primes = this.NG_POB_PRIMES;
      xCandle5m = this.findPrimeSessionXCandle5m(bars5m, evalTs, {
        timeZone: 'Asia/Kolkata',
        primes,
        maxBars: 6,
      });
      pobOpts = {
        timeZone: 'Asia/Kolkata',
        maxEntryMins: 150, // ~2.5h after session X — no overnight hope
        freshMins: 20,
      };
    }
    const pobReject = xCandle5m
      ? this.detectPobReject(xCandle5m, bars5m, evalTs, c.touchPct ?? 0.15, pobOpts)
      : null;

    // Dr. Dev Equinox Macro Territory
    const equinox = this.computeEquinoxMacro(price, instId, evalTs);

    // Dr. Dev Trikal 12:45 Afternoon Engine & Dr. Dev 5m Squeeze (NIFTY; same NSE/BSE clocks on BANKNIFTY / SENSEX)
    const afternoon1245 = (bars5m && isIndIdx)
      ? this.detect1245AfternoonSetup(bars5m, evalTs)
      : null;
    const squeeze5m = (bars5m && isIndIdx)
      ? this.detectSqueezePattern(bars5m, evalTs)
      : null;
    // Dr. Dev BTC Asia 05:30 (30m X breakout) — Trikal 05:30 clock
    const btcAsia0530 = (bars5m && isBtc)
      ? this.detectBtcAsia0530Trikal(bars5m, evalTs)
      : null;
    // Dr. Dev MCX 5:30 Formula (17:30 IST 30m Europe energy candle anchor)
    const mcx530 = (bars5m && isMcx)
      ? this.detectMcx530FormulaTrikal(bars5m, evalTs)
      : null;

    // Composite trend & setup classification (Sagar DNA + Dr. Dev):
    // 1. Mark window still forming -> WAIT
    // 2. Actionable setups ALWAYS beat passive watch states:
    //    trade1_departure -> pob_reject -> trade2_confirmed -> session_sweep
    // 3. Active Prime-Session POB watch (5m Open candle marked, awaiting 44-56 retest/reject)
    // 4. Setup 3 rubber band overlay -> Trade 2 revisit watch
    // 5. Inside Fib box -> WAIT
    // 6. Fib break bias / pullback
    let trend = 'neutral';
    let setupKind = 'wait';
    // Europe 5:30 Formula window (17:30–22:45 IST):
    // - While the 17:30–18:00 candle is still forming (mcx_530_watch), do NOT fire Trade 1 /
    //   POB leave of the holiday 17:00 box — wait for the 18:00 Formula lock.
    // - After 18:00, a triggered Formula setup beats any still-fresh Trade 1 leave.
    const evalIst = this.zonedHms(evalTs, 'Asia/Kolkata');
    const evalIstMins = evalIst.hour * 60 + evalIst.minute;
    const inMcx530Window = isMcx && evalIstMins >= 17 * 60 + 30 && evalIstMins < 22 * 60 + 45;
    if (phase === 'first_candle') {
      trend = 'neutral';
      setupKind = 'wait';
    } else if (inMcx530Window && mcx530 && mcx530.triggered && mcx530.side) {
      trend = mcx530.side;
      setupKind = mcx530.setupKind;
    } else if (inMcx530Window && mcx530 && mcx530.setupKind === 'mcx_530_watch') {
      trend = 'neutral';
      setupKind = 'mcx_530_watch';
    } else if (
      redSetup.trade1Fresh && (redSetup.leftAbove || redSetup.leftBelow)
      && !(redSetup.revisitSide && redSetup.revisitStrong
        && redSetup.triggerTs != null && (evalTs - Number(redSetup.triggerTs)) > 20 * 60000)
    ) {
      // Fresh leave of 1H first-red — do not steal into Trade 2 sweep window
      trend = redSetup.leftAbove ? 'bullish' : 'bearish';
      setupKind = 'trade1_departure';
    } else if (afternoon1245 && afternoon1245.triggered && afternoon1245.side) {
      trend = afternoon1245.side;
      setupKind = afternoon1245.setupKind;
    } else if (btcAsia0530 && btcAsia0530.triggered && btcAsia0530.side) {
      trend = btcAsia0530.side;
      setupKind = btcAsia0530.setupKind;
    } else if (mcx530 && mcx530.triggered && mcx530.side) {
      trend = mcx530.side;
      setupKind = mcx530.setupKind;
    } else if (pobReject && pobReject.triggered && pobReject.side) {
      trend = pobReject.side;
      setupKind = 'pob_reject';
    } else if (redSetup.revisitSide && redSetup.revisitStrong) {
      trend = redSetup.revisitSide;
      setupKind = 'trade2_confirmed';
    } else if (sweep) {
      trend = sweep.side;
      setupKind = 'session_sweep';
    } else if (redSetup.revisitSide) {
      trend = redSetup.revisitSide;
      setupKind = redSetup.revisitStrong ? 'trade2_confirmed' : 'trade2_watch';
    } else if (redSetup.revisitWindow) {
      trend = orBias === 'bull' ? 'bullish' : orBias === 'bear' ? 'bearish' : 'neutral';
      setupKind = 'trade2_watch';
      if (trend === 'neutral') trend = redSetup.leftAbove ? 'bullish' : redSetup.leftBelow ? 'bearish' : 'neutral';
    } else if (setup3 && setup3.triggered) {
      trend = setup3.direction;
      setupKind = 'setup3_rubber_band';
    } else if (mcx530 && mcx530.setupKind === 'mcx_530_watch') {
      trend = 'neutral';
      setupKind = 'mcx_530_watch';
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
    // Dev DNA: structural stop on 15m swing / shelf. Confirm still uses 5m close.
    const is1245 = setupKind === 'afternoon_1245_reversal'
      || setupKind === 'afternoon_1245_breakout'
      || setupKind === 'afternoon_1245_retest';
    const isBtc0530 = setupKind === 'btc_asia_0530_breakout';
    const isMcx530 = setupKind === 'mcx_530_breakout'
      || setupKind === 'mcx_530_retest'
      || setupKind === 'mcx_530_reversal';
    const preferSwingStop = isTrade2
      || setupKind === 'trade1_departure'
      || setupKind === 'session_sweep'
      || setupKind === 'pob_reject'
      || setupKind === 'setup3_rubber_band'
      || is1245
      || isBtc0530
      || isMcx530;

    // Event candle first — levels / R:R / auto fill must anchor on the trigger, not a chase print.
    const setupTriggerTs0 = (setupKind === 'session_sweep' && sweep?.triggerTs != null)
      ? sweep.triggerTs
      : (setupKind === 'pob_reject' && pobReject?.triggerTs != null)
        ? pobReject.triggerTs
        : (setupKind === 'setup3_rubber_band' && setup3?.triggerTs != null)
          ? setup3.triggerTs
          : (setupKind === 'btc_asia_0530_breakout')
            ? btcAsia0530?.triggerTs
            : (isMcx530 && mcx530?.triggerTs != null)
              ? mcx530.triggerTs
              : (setupKind === 'afternoon_1245_reversal' || setupKind === 'afternoon_1245_breakout' || setupKind === 'afternoon_1245_retest')
                ? afternoon1245?.triggerTs
                : (redSetup.triggerTs || null);
    const t2Stale = setupKind === 'trade2_confirmed' && redSetup.trade1Fresh && redSetup.trade2TriggerTs != null
      && redSetup.triggerTs != null && (evalTs - Number(redSetup.triggerTs)) > 20 * 60000;
    const setupTriggerTs = t2Stale ? redSetup.trade2TriggerTs : setupTriggerTs0;
    const setupTriggerPrice = (setupKind === 'session_sweep' && sweep?.triggerPrice != null)
      ? sweep.triggerPrice
      : (setupKind === 'pob_reject' && pobReject?.triggerPrice != null)
        ? pobReject.triggerPrice
        : (setupKind === 'setup3_rubber_band' && setup3?.triggerPrice != null)
          ? setup3.triggerPrice
          : (setupKind === 'btc_asia_0530_breakout' && btcAsia0530?.triggerPrice != null)
            ? btcAsia0530.triggerPrice
            : (isMcx530 && mcx530?.triggerPrice != null)
              ? mcx530.triggerPrice
              : (t2Stale && redSetup.trade2TriggerPrice != null ? redSetup.trade2TriggerPrice
                : (redSetup.triggerPrice != null ? redSetup.triggerPrice : price));
    // Levels from live price: auto fills at market, so stop/1:1 must be measured from where we actually get in.
    // Chase is still blocked by entryGate (≤0.5R past the trigger candle).
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
      minRR: isTrade2 || setupKind === 'pob_reject' || is1245 || isBtc0530 || isMcx530 ? 1.0 : 1.5,
      preferSwingStop,
      rrLadder: isTrade2 || is1245 || isBtc0530 || isMcx530,
      bars5m,
      sweepExtreme: redSetup.sweepExtreme ?? null,
      setupKind,
      setup3,
      pobReject,
      afternoon1245,
      btcAsia0530,
      mcx530,
      instId,
    });

    const invalidation = levels.invalidation;
    const bookZone = levels.bookZone;

    const btcConfluence = (isBtc)
      ? this.computeBtcCourseConfluence({
        bars: slice,
        bars5m,
        price,
        trend,
        firstRed1h,
        pobReject,
        btcAsia0530,
        evalTs,
      })
      : null;

    // Entry gate: full DNA pack + Dr. Dev session POB + Crypto Course Filter (see entryGate docstring).
    const { state: actionState, reason: actionReason } = this.entryGate({
      trend,
      setupKind,
      rr: levels.rr,
      stopStructural: levels.stopStructural,
      invalidationReason: levels.invalidationReason,
      stopPct: levels.stopPct,
      renko,
      clock,
      asOfTs: evalTs,
      instrumentId: c.id || c.instrumentId || null,
      season: this._istSeasonBucket(evalTs),
      setupTriggerTs,
      entryPrice: setupTriggerPrice,
      stopPrice: invalidation,
      livePrice: price,
      revisitRead: redSetup.revisitRead || null,
      tpHint: (setupKind === 'pob_reject' && pobReject?.tpHint != null) ? pobReject.tpHint : null,
      equinox,
      phase,
      openingRange: or,
      btcConfluence,
      btcAsia0530,
      mcx530,
    });

    const sizingEntry = (setupKind === 'pob_reject' && setupTriggerPrice != null) ? setupTriggerPrice : price;
    const sizing = (actionState === 'enter' && invalidation != null && bookZone != null)
      ? this.futuresSizing({ entry: sizingEntry, stop: invalidation, exit: bookZone })
      : null;

    const playbook = {
      clock,
      redSetup,
      setup3: setup3 || null,
      pobReject: pobReject || null,
      renko,
      cpr,
      priorDay,
      asiaHl,
      londonHl,
      nyHl,
      asiaUntouched,
      sweep,
      setupKind,
      equinox,
      afternoon1245,
      btcAsia0530,
      mcx530,
      btcConfluence,
      squeeze5m,
      triggerTs: setupTriggerTs,
      triggerPrice: setupTriggerPrice,
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
      evalTs,
      triggerTs: setupTriggerTs,
      triggerPrice: setupTriggerPrice,
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
      equinox: equinox || null,
      afternoon1245: afternoon1245 || null,
      btcAsia0530: btcAsia0530 || null,
      mcx530: mcx530 || null,
      btcConfluence: btcConfluence || null,
      squeeze5m: squeeze5m || null,
      openingRange: or,
      lastRedBar: red,
      firstRed1h,
      firstRedFibs,
      xCandle5m: xCandle5m || null,
      pob: pobReject?.fibs?.pob || firstRedFibs?.pob || null,
      pobStatus: pobReject?.status || redSetup?.pobStatus || null,
      isXCandleTrap: !!(xCandle5m && pobReject && !pobReject.triggered)
        || redSetup?.isXCandleTrap || false,
      pobReject: pobReject || null,
      setup3: setup3 || null,
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
        pob: (b.f44 != null && b.f56 != null) ? {
          high: Math.max(b.f44, b.f56),
          low: Math.min(b.f44, b.f56),
          mid: b.f50 ?? b.mid ?? ((b.f44 + b.f56) / 2),
          deviationPct: 6,
          label: 'POB (Point of Balance 44–56)',
        } : null,
        openT: b.openT,
        endT: b.endT,
        index: b.index,
        i1Mark: b.i1Mark,
        t0: b.t0,
        t1: b.t1,
        locked: true,
      })),
      bandCountPrior: prior.length,
      bandStyle: c.bandStyle || 'dayHl',
      // Today's 02:30 fib / day range (extends right on the chart)
      currentBand: (() => {
        const cb = bands.find((b) => b.day === asOfDay) || null;
        if (!cb) return null;
        return {
          ...cb,
          locked: or ? !!or.locked : true,
          pob: (cb.f44 != null && cb.f56 != null) ? {
            high: Math.max(cb.f44, cb.f56),
            low: Math.min(cb.f44, cb.f56),
            mid: cb.f50 ?? cb.mid ?? ((cb.f44 + cb.f56) / 2),
            deviationPct: 6,
            label: 'POB (Point of Balance 44–56)',
          } : null,
        };
      })(),
      refs: {
        ...refs,
        swingHigh,
        swingLow,
        prevSwingHigh: levels.prevSwingHigh ?? swingHigh,
        prevSwingLow: levels.prevSwingLow ?? swingLow,
        swingStopTf: preferSwingStop ? (isIndIdx ? '5m' : '15m') : null,
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
   * Red Bar DNA + Dr. Dev session POB — setups that may ENTER (Telegram / two-leg).
   * Setup 3 rubber band stays WATCH/overlay until its own walk-forward PASS.
   * Continuation / magnet / Renko are chart context only.
   */
  ACTIONABLE_SETUPS: [
    'trade1_departure',
    'trade2_confirmed',
    'session_sweep',
    'pob_reject',
    'afternoon_1245_reversal',
    'afternoon_1245_breakout',
    'afternoon_1245_retest',
    'btc_asia_0530_breakout',
    'mcx_530_breakout',
    'mcx_530_retest',
    'mcx_530_reversal',
  ],

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

  /**
   * Full DNA ENTER pack — Dr Dev Red Bar (crypto + NIFTY clocks differ).
   * LIVE must match this list — no partial ports.
   *
   * Allow → ENTER when ALL pass:
   *  1. Actionable: trade1_departure | trade2_confirmed | session_sweep | pob_reject | btc_asia_0530_breakout
   *  2. RR ≥ 1, structural stop (shelf / wick / box / 15m swing — not % invent)
   *  3. POB: SL @ POB 0.56; Asia 05:30: SL @ X opposite; DNA: shelf-first
   *  4. BTC: no T1/T2/sweep ENTER in pre_asia; POB = Asia 05:30 only
   *  5. stopPct ≤ 1% desk risk gate (wait tighter base — not fake SL)
   *  6. Freshness: Trade 2 ≤20m; T1/sweep ≤90m BTC / ≤20m NIFTY; POB ≤20m
   *  7. No chase: max ~0.5R extension past trigger for DNA (event candle)
   * Setup 3 = WATCH/overlay until its own PASS.
   */
  entryGate({
    trend, setupKind, rr, stopStructural, invalidationReason, stopPct, renko, clock,
    asOfTs, instrumentId, season, setupTriggerTs, entryPrice, stopPrice, livePrice,
    revisitRead, tpHint, equinox = null, phase = null, openingRange = null,
    btcConfluence = null, btcAsia0530 = null, mcx530 = null,
  }) {
    if (trend !== 'bullish' && trend !== 'bearish') {
      return { state: 'wait', reason: 'No directional setup.' };
    }
    // Dr. Dev Equinox Macro Gate: strictly forbid counter-territory trades during active Equinox seasons (March/April & Sept/Oct)
    if (equinox && equinox.seasonActive && equinox.territory === 'positive' && trend === 'bearish') {
      return {
        state: 'watch',
        reason: `Blocked by Macro Equinox Rule: In Positive Territory (Above ${equinox.baseline}) during Equinox season — Calls only, Puts/Bearish forbidden.`,
      };
    }
    if (equinox && equinox.seasonActive && equinox.territory === 'negative' && trend === 'bullish') {
      return {
        state: 'watch',
        reason: `Blocked by Macro Equinox Rule: In Negative Territory (Below ${equinox.baseline}) during Equinox season — Puts only, Calls/Bullish forbidden.`,
      };
    }

    const instEarly = String(instrumentId || '').toUpperCase();
    const isIndIdxEarly = this.isIndianIndex(instEarly);

    // Indian indices (NIFTY, BANKNIFTY, SENSEX): no clock-based ENTER kills (14:15 / 13:45 / pt caps were desk inventions).
    // Setup quality decides. EOD flatten (~15:10) is ops-only in the bot.
    const isPob = setupKind === 'pob_reject';
    // Indian Index Trade 3 (Setup 3 rubber band) may ENTER when enabled — BTC keeps it overlay-only
    const niftySetup3 = isIndIdxEarly && setupKind === 'setup3_rubber_band';
    if (!this.ACTIONABLE_SETUPS.includes(setupKind) && !niftySetup3) {
      const why = {
        trend_bias: 'Bias only — wait for leave, shelf retest, sweep, or mid-zone reject.',
        fib_pullback: 'Near mark-window levels (context) — wait for leave / retest / sweep / mid-zone reject.',
        session_continuation: 'Continuation is not active — wait for leave / retest / sweep / mid-zone.',
        magnet_reaction: 'Fib magnet is chart context — not an ENTER.',
        magnet_bounce_watch: 'Fib bounce is chart context — not an ENTER.',
        pivot_reversal: 'Price crossed the 1H red against Fib bias — conflicting, wait.',
        trade2_watch: 'H1→M5 Trade 2: wait for 1H high/low liquidity sweep, then 5m close back through that level (median confluence).',
        pob_reject_watch: 'Mid-zone (5m): open candle marked — wait retest of 44–56 then SHORT reject. NSE 09:15 or BTC Asia 05:30.',
        setup3_primed: 'Setup 3 Primed (overlay): ≥4× 30m candles detached from 5 EMA. Watch LTF Barricade — not ENTER until walk-forward PASS.',
        setup3_rubber_band: 'Setup 3 Barricade broken (overlay): rubber-band snapback visible — chart guide only.',
        btc_asia_0530_watch: 'Asia open: 30m range marked or forming — wait breakout close beyond X high/low (06:00–08:30 IST).',
        mcx_530_watch: 'MCX 5:30 Formula: 17:30 IST 30m candle forming or marked — wait breakout close beyond High/Low (18:00–22:30 IST).',
      }[setupKind] || 'Wait for leave / shelf retest / sweep / mid-zone reject.';
      return { state: 'watch', reason: why };
    }

    // Renko brick ruler = chart noise context only (not Red Bar DNA). Do not block ENTER on it.
    // (Was a desk mash-in; Dev Red Bar uses structure stops, not Renko overextension gates.)
    if (!(rr >= 1.0)) {
      return { state: 'watch', reason: `Setup present but R:R ${rr != null ? rr.toFixed(2) : '—'} < 1.0.` };
    }
    if (!stopStructural) {
      return { state: 'watch', reason: `Setup present but no real swing fits the stop window (${invalidationReason}).` };
    }
    const stopTag = String(invalidationReason || '');
    if (isPob) {
      // POB SL is the corridor high (0.56) — not a 5m swing DNA stop
      if (!/POB|0\.56|reject wick/i.test(stopTag)) {
        return {
          state: 'watch',
          reason: `Mid-zone SHORT needs SL locked above mid top (0.56) (got: ${invalidationReason || '—'}).`,
        };
      }
    } else if (niftySetup3) {
      if (!/extreme drop wick|extreme rally wick|5m swing|barricade|setup 3/i.test(stopTag)) {
        // still allow if structural flag set from Setup 3 book
        if (!stopStructural) {
          return {
            state: 'watch',
            reason: `Setup 3 needs structural SL (got: ${invalidationReason || '—'}).`,
          };
        }
      }
    } else if (setupKind === 'btc_asia_0530_breakout') {
      // Dr Dev BTC Asia Trikal: SL is the 30m X opposite extreme — not a 5m swing DNA tag.
      if (!/Asia 05:30|X opposite|X extreme/i.test(stopTag)) {
        return {
          state: 'watch',
          reason: `Asia 05:30 breakout needs SL @ X opposite extreme (got: ${invalidationReason || '—'}).`,
        };
      }
    } else if (setupKind === 'mcx_530_breakout' || setupKind === 'mcx_530_retest' || setupKind === 'mcx_530_reversal') {
      // Dr Dev MCX 5:30 Formula: SL is 30m Europe X opposite extreme / shelf stop
      if (!/5:30 Formula|30m Europe|shelf|swing|extreme/i.test(stopTag) && !stopStructural) {
        return {
          state: 'watch',
          reason: `MCX 5:30 Formula needs structural SL (got: ${invalidationReason || '—'}).`,
        };
      }
    } else {
      // Keep "5m swing" accepted — NIFTY morning T1/T2 still tags stops that way (do not break NIFTY).
      const realStructureStop = (/15m swing|5m swing|shelf|1H red|session sweep|extreme drop wick|extreme rally wick|12:45 reversal|12:45 breakout/i.test(stopTag))
        && !/too close|floor|default|0\.28%|0\.5%/i.test(stopTag);
      if (!realStructureStop) {
        return {
          state: 'watch',
          reason: `Setup present but SL is ${invalidationReason || 'not real structure'} — wait until stop locks to shelf / 15m swing (not a % floor).`,
        };
      }
    }
    // Clocks: BTC mid-zone X is Asia 05:30 only. CME Fib = magnets, not Trade 1.
    // Pre-Asia: no fresh T1/T2/sweep ENTER (dead hours) — wait Asia Trikal / real first red after mark.
    const inst = String(instrumentId || '').toUpperCase();
    const isNifty = this.isIndianIndex(inst);
    const isMcx = this.isMcxCommodity(inst);
    const isBtcGate = !isNifty && !isMcx;
    if (
      isBtcGate
      && clock
      && clock.id === 'pre_asia'
      && (setupKind === 'trade1_departure' || setupKind === 'trade2_confirmed' || setupKind === 'session_sweep')
    ) {
      return {
        state: 'watch',
        reason: 'Pre-Asia dead hours — no fresh Red Bar T1/T2/sweep ENTER. Wait Asia 05:30 Trikal / post-mark first red.',
      };
    }
    const fmtGatePx = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '0';
      if (Math.abs(n) < 20) return n.toFixed(3);
      if (Math.abs(n) < 500) return n.toFixed(2);
      return String(Math.round(n));
    };
    // BTC: do not enter while price is trapped inside today's Mark Fib (0..1) accumulation box.
    const isInsideMarkFib = phase === 'inside_or' || (
      openingRange && openingRange.locked
      && Number.isFinite(Number(livePrice))
      && Number(livePrice) >= Number(openingRange.low)
      && Number(livePrice) <= Number(openingRange.high)
    );
    if (isBtcGate && isInsideMarkFib) {
      const boxStr = (openingRange && openingRange.low != null && openingRange.high != null)
        ? ` (${fmtGatePx(openingRange.low)}–${fmtGatePx(openingRange.high)})`
        : '';
      return {
        state: 'watch',
        reason: `Price is inside today's Mark Fib box${boxStr} — accumulation chop. Wait for a clean break outside the Fib box before entering.`,
      };
    }
    // BTC: do not enter while price is trapped inside the 05:30–06:00 Asia 30m X box.
    const asiaBox = btcAsia0530 && btcAsia0530.xCandle;
    const isInsideAsiaBox = Boolean(
      asiaBox
      && Number.isFinite(Number(asiaBox.low))
      && Number.isFinite(Number(asiaBox.high))
      && Number.isFinite(Number(livePrice))
      && Number(livePrice) >= Number(asiaBox.low)
      && Number(livePrice) <= Number(asiaBox.high)
    );
    if (isBtcGate && isInsideAsiaBox) {
      return {
        state: 'watch',
        reason: `Price is inside today's 05:30–06:00 Asia X range (${fmtGatePx(asiaBox.low)}–${fmtGatePx(asiaBox.high)}) — stand aside until a clean break outside the range.`,
      };
    }
    // BTC: Dr. Dev Course Filter — 200 MA (High/Low/Close) chop band & SuperTrend (10, 4.1) alignment
    if (isBtcGate && btcConfluence) {
      if (btcConfluence.ma200 && btcConfluence.ma200.insideChop) {
        return {
          state: 'watch',
          reason: `Course Filter: Price is inside the 200 MA High–Low chop band (${fmtGatePx(btcConfluence.ma200.low)}–${fmtGatePx(btcConfluence.ma200.high)}) — strict No-Trade Zone.`,
        };
      }
      if (btcConfluence.ma200 && btcConfluence.ma200.high != null && !btcConfluence.ma200.aligned) {
        return {
          state: 'watch',
          reason: `Course Filter: ${trend.toUpperCase()} setup conflicts with 200 MA channel (${btcConfluence.ma200.state === 'bullish' ? `Above ${fmtGatePx(btcConfluence.ma200.high)}` : `Below ${fmtGatePx(btcConfluence.ma200.low)}`}) — stand aside.`,
        };
      }
      if (btcConfluence.supertrend && btcConfluence.supertrend.line != null && !btcConfluence.supertrend.aligned) {
        return {
          state: 'watch',
          reason: `Course Filter: ${trend.toUpperCase()} setup conflicts with ${btcConfluence.supertrend.state.toUpperCase()} SuperTrend (10, 4.1 @ ${fmtGatePx(btcConfluence.supertrend.line)}) — stand aside.`,
        };
      }
    }
    // BTC: Trade 2 LONG on 1H low sweep is WATCH-only unless backed by full 4/4 (A+) Course Confluence
    if (
      isBtcGate
      && setupKind === 'trade2_confirmed'
      && trend === 'bullish'
      && String(revisitRead || '') === 'liq_sweep_low'
      && !(btcConfluence && btcConfluence.score >= 4)
    ) {
      return {
        state: 'watch',
        reason: 'DNA Filter: Trade 2 LONG after low sweep is WATCH-only unless 4/4 (A+) Course Confluence aligns.',
      };
    }
    if (isBtcGate && stopPct != null && Number.isFinite(stopPct) && stopPct > 1.0) {
      return {
        state: 'watch',
        reason: `Setup present but stop is ${stopPct.toFixed(2)}% (>1%) — stand aside until a tighter structure fits.`,
      };
    }
    // Trade 2 confirm window is ~20m; T1/sweep stay wider on BTC; POB = scalp 20m
    const isTrade2Gate = setupKind === 'trade2_confirmed';
    const isMcx530 = setupKind === 'mcx_530_breakout' || setupKind === 'mcx_530_retest' || setupKind === 'mcx_530_reversal';
    const freshMins = isPob || isTrade2Gate || isMcx530 ? 20 : ((isNifty || isMcx) ? 20 : 90);
    const ENTER_FRESH_MS = freshMins * 60 * 1000;
    // Dr Dev: prefer event candle — do not chase mid-air (POB fill@0.44 is not a chase).
    const maxFavR = isPob ? 99 : 0.5;
    const asOf = asOfTs != null ? Number(asOfTs) : Date.now();
    const trigTs = setupTriggerTs != null ? Number(setupTriggerTs) : null;
    if (trigTs == null || !Number.isFinite(trigTs)) {
      return {
        state: 'watch',
        reason: 'Setup missing trigger timestamp — refuse ENTER until the setup is freshly anchored.',
      };
    }
    if ((asOf - trigTs) > ENTER_FRESH_MS) {
      return {
        state: 'watch',
        reason: `ENTER window closed (>${freshMins}m since trigger bar) — do not chase. Wait for the next setup.`,
      };
    }
    const ep = Number(entryPrice);
    const sp = Number(stopPrice);
    const lp = Number(livePrice != null ? livePrice : entryPrice);
    const R = Math.abs(ep - sp);
    if (!(R > 0) || !Number.isFinite(ep) || !Number.isFinite(lp)) {
      return {
        state: 'watch',
        reason: 'Setup missing trigger/live price anchors — refuse ENTER.',
      };
    }
    // POB: if Anchor low already taken, TP1 thesis is done — stand down
    if (isPob && tpHint != null && Number.isFinite(Number(tpHint)) && lp <= Number(tpHint)) {
      return {
        state: 'watch',
        reason: 'POB SHORT: Anchor (X) low already traded through — TP1 done / late. Do not chase.',
      };
    }
    if (!isPob) {
      const favR = trend === 'bullish' ? (lp - ep) / R : (ep - lp) / R;
      if (favR >= maxFavR) {
        return {
          state: 'watch',
          reason: `Price already ${favR.toFixed(1)}R into the move — ENTER is stale. Do not chase; manage if filled or wait next setup.`,
        };
      }
    }

    // Dr Dev Trikal: lunch decay 11:30–12:30 IST — no fresh Indian Index (NIFTY, BANKNIFTY, SENSEX) entries. Wait for 12:45 London box.
    if (isNifty) {
      const lz = this.zonedHms(asOf, 'Asia/Kolkata');
      const lm = lz.hour * 60 + lz.minute;
      if (lm >= 11 * 60 + 30 && lm < 12 * 60 + 30) {
        return {
          state: 'watch',
          reason: 'Lunch decay (11:30–12:30 IST) — no fresh entries. Wait for the 12:45 London box.',
        };
      }
    }
    if (isNifty && !isPob && stopPct != null && Number.isFinite(stopPct) && stopPct > 0.65) {
      return {
        state: 'watch',
        reason: `Index stop ${stopPct.toFixed(2)}% (>0.65%) — wait for a tighter structural base.`,
      };
    }

    const trailBit = isPob
      ? 'Mid-zone SHORT · fill near mid · stop mid top · bank at anchor / 2R · no overnight'
      : setupKind === 'trade2_confirmed'
        ? 'H1→M5 confirm · SL shelf / 15m · 50% @ 1:1 → BE → trail after 1:2 → TP 1:3'
        : setupKind === 'btc_asia_0530_breakout'
          ? 'BTC Asia 05:30 · SL@30m X extreme · 50% @ 1:1 → BE → trail after 1:2 → TP 1:3'
          : setupKind === 'trade1_departure'
            ? 'Trade 1 leave · SL shelf / 15m · 50% TP at 1:1 → trail after 1:2 (stretch)'
            : 'SL shelf / 15m · 50% TP at 1:1 → trail after 1:2 (stretch)';
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
    if (playbook?.setupKind === 'pob_reject') {
      return `Mid-zone SHORT ENTER: open candle retested mid-zone and rejected — fill near mid · stop mid top · bank at anchor / 2R.${clockBit}`;
    }
    if (playbook?.setupKind === 'pob_reject_watch') {
      return `Watching mid-zone (SHORT only · Asia/London/NY or NSE): ${playbook?.pobReject?.label || 'await retest of 44–56 then reject <0.44'}.${clockBit}`;
    }
    if (playbook?.setupKind === 'setup3_rubber_band') {
      return `Setup 3 overlay: Barricade broken (${trend}) toward 30m 5 EMA — chart guide only, not DNA ENTER.${clockBit}`;
    }
    if (playbook?.setupKind === 'setup3_primed') {
      return `Setup 3 overlay: rubber-band tension (≥4× 30m detached from 5 EMA). Watch Barricade — not an ENTER.${clockBit}`;
    }
    if (playbook?.setupKind === 'setup3_primed') {
      return `Setup 3 Primed: 30m candles detached from 5 EMA (rubber band tension). Watch for Barricade breakout.${clockBit}`;
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

  /**
   * 3-Line 200 SMA Channel (High / Close / Low) + SuperTrend (10, 4.1) series
   * from Dr. Devendra's Upsurge Crypto Course. Used for BTC chart overlay & non-blocking Confluence Score.
   */
  compute200MaAndSupertrendSeries(bars, maPeriod = 200, stPeriod = 10, stMult = 4.1) {
    const n = Array.isArray(bars) ? bars.length : 0;
    const maClose = new Array(n).fill(null);
    const maHigh = new Array(n).fill(null);
    const maLow = new Array(n).fill(null);
    const stLine = new Array(n).fill(null);
    const stDir = new Array(n).fill(0); // +1 bullish (green), -1 bearish (red)
    if (!n) return { maClose, maHigh, maLow, stLine, stDir };

    let sumC = 0, sumH = 0, sumL = 0;
    for (let i = 0; i < n; i++) {
      sumC += Number(bars[i].c);
      sumH += Number(bars[i].h);
      sumL += Number(bars[i].l);
      if (i >= maPeriod) {
        sumC -= Number(bars[i - maPeriod].c);
        sumH -= Number(bars[i - maPeriod].h);
        sumL -= Number(bars[i - maPeriod].l);
      }
      const denom = Math.min(i + 1, maPeriod);
      if (i >= Math.min(30, maPeriod - 1)) {
        maClose[i] = sumC / denom;
        maHigh[i] = sumH / denom;
        maLow[i] = sumL / denom;
      }
    }

    // ATR (RMA / Wilder's smoothing) for SuperTrend (10, 4.1)
    const tr = new Array(n).fill(0);
    const atr = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const h = Number(bars[i].h);
      const l = Number(bars[i].l);
      if (i === 0) {
        tr[i] = h - l;
        atr[i] = tr[i];
      } else {
        const pc = Number(bars[i - 1].c);
        tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        if (i < stPeriod) {
          let s = 0;
          for (let k = 0; k <= i; k++) s += tr[k];
          atr[i] = s / (i + 1);
        } else {
          atr[i] = ((atr[i - 1] * (stPeriod - 1)) + tr[i]) / stPeriod;
        }
      }
    }

    const finalUpper = new Array(n).fill(0);
    const finalLower = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const hl2 = (Number(bars[i].h) + Number(bars[i].l)) / 2;
      const basicUpper = hl2 + stMult * atr[i];
      const basicLower = hl2 - stMult * atr[i];
      if (i === 0) {
        finalUpper[i] = basicUpper;
        finalLower[i] = basicLower;
        stDir[i] = 1;
        stLine[i] = finalLower[i];
      } else {
        const prevC = Number(bars[i - 1].c);
        finalUpper[i] = (basicUpper < finalUpper[i - 1] || prevC > finalUpper[i - 1])
          ? basicUpper
          : finalUpper[i - 1];
        finalLower[i] = (basicLower > finalLower[i - 1] || prevC < finalLower[i - 1])
          ? basicLower
          : finalLower[i - 1];
        const curC = Number(bars[i].c);
        if (stDir[i - 1] === -1 && curC > finalUpper[i - 1]) {
          stDir[i] = 1;
        } else if (stDir[i - 1] === 1 && curC < finalLower[i - 1]) {
          stDir[i] = -1;
        } else {
          stDir[i] = stDir[i - 1];
        }
        stLine[i] = stDir[i] === 1 ? finalLower[i] : finalUpper[i];
      }
    }

    return { maClose, maHigh, maLow, stLine, stDir };
  },

  /**
   * Non-blocking 4-point BTC Confluence Score from Dr. Devendra's Upsurge Crypto Course:
   *  1. Red Bar / POB / 05:30 Structure locked
   *  2. 200 MA 3-Line Channel (High / Close / Low) alignment
   *  3. SuperTrend (10, 4.1) alignment
   *  4. Latest 30m Trikal Clock (03:30 / 05:30 / 12:30 / 17:30 IST) 50% midpoint alignment
   */
  computeBtcCourseConfluence({
    bars,
    bars5m,
    price,
    trend,
    firstRed1h,
    pobReject,
    btcAsia0530,
    evalTs,
    tfLabel,
  }) {
    if (!Array.isArray(bars) || bars.length < 30 || !Number.isFinite(Number(price))) return null;
    const tfTag = tfLabel ? `${tfLabel} ` : '';
    const series = this.compute200MaAndSupertrendSeries(bars, 200, 10, 4.1);
    const lastIdx = bars.length - 1;
    const maH = series.maHigh[lastIdx];
    const maC = series.maClose[lastIdx];
    const maL = series.maLow[lastIdx];
    const stVal = series.stLine[lastIdx];
    const stDirection = series.stDir[lastIdx]; // +1 bull, -1 bear

    const isBullBias = trend === 'bullish';
    const isBearBias = trend === 'bearish';
    const refDir = isBullBias ? 1 : isBearBias ? -1 : (price > (maH || price) ? 1 : price < (maL || price) ? -1 : stDirection);

    // 1. Structure locked (First Red 1H / Asia 05:30 / POB)
    const hasStructure = Boolean(firstRed1h || (btcAsia0530 && btcAsia0530.xHigh) || (pobReject && pobReject.xCandle));

    // 2. 200 MA 3-Line Channel (High, Close, Low)
    const above200Band = maH != null && price > maH;
    const below200Band = maL != null && price < maL;
    const inside200Band = maH != null && maL != null && price >= maL && price <= maH;
    const ma200State = above200Band ? 'bullish' : below200Band ? 'bearish' : 'inside_band';
    const ma200Aligned = (refDir === 1 && above200Band) || (refDir === -1 && below200Band);

    // 3. SuperTrend (10, 4.1)
    const stState = stDirection === 1 ? 'bullish' : 'bearish';
    const stAligned = (refDir === 1 && stDirection === 1) || (refDir === -1 && stDirection === -1);

    // 4. Latest active 30m Trikal Clock candle (03:30, 05:30, 12:30, 17:30 IST) 50% level
    const srcBars = (Array.isArray(bars5m) && bars5m.length >= 12) ? bars5m : bars;
    const asOf = evalTs || Date.now();
    const zNow = this.zonedHms(asOf, 'Asia/Kolkata');
    const nowMins = zNow.hour * 60 + zNow.minute;
    const trikalClocks = [
      { id: '03:30', label: '03:30 IST', mins: 3 * 60 + 30 },
      { id: '05:30', label: '05:30 IST', mins: 5 * 60 + 30 },
      { id: '12:30', label: '12:30 IST', mins: 12 * 60 + 30 },
      { id: '17:30', label: '17:30 IST', mins: 17 * 60 + 30 },
    ];
    // Pick the most recently completed 30m clock window (start + 30m <= now)
    let activeClock = null;
    let clockDay = zNow.day;
    for (let k = trikalClocks.length - 1; k >= 0; k--) {
      if (nowMins >= trikalClocks[k].mins + 30) {
        activeClock = trikalClocks[k];
        break;
      }
    }
    if (!activeClock) {
      activeClock = trikalClocks[trikalClocks.length - 1];
      clockDay = this.shiftDay(zNow.day, -1);
    }
    const winStartUtc = this.zonedClockToUtc(clockDay, 'Asia/Kolkata', Math.floor(activeClock.mins / 60), activeClock.mins % 60);
    const winEndUtc = winStartUtc + 30 * 60 * 1000;
    let tHi = -Infinity, tLo = Infinity;
    for (const b of srcBars) {
      if (b.t >= winStartUtc - 1000 && b.t < winEndUtc - 1000) {
        if (b.h > tHi) tHi = b.h;
        if (b.l < tLo) tLo = b.l;
      }
    }
    const trikalMid = (Number.isFinite(tHi) && Number.isFinite(tLo) && tHi >= tLo) ? (tHi + tLo) / 2 : null;
    const trikalF44 = (Number.isFinite(tHi) && Number.isFinite(tLo) && tHi >= tLo) ? tLo + (tHi - tLo) * 0.44 : null;
    const trikalAligned = trikalMid != null
      ? ((refDir === 1 && price >= (trikalF44 ?? trikalMid)) || (refDir === -1 && price <= (2 * trikalMid - (trikalF44 ?? trikalMid))))
      : false;

    const fmtConfPx = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '0';
      if (Math.abs(n) < 20) return n.toFixed(3);
      if (Math.abs(n) < 500) return n.toFixed(2);
      return String(Math.round(n));
    };

    const checks = [
      {
        id: 'structure',
        label: 'Mark Fib Box',
        ok: hasStructure,
        detail: firstRed1h
          ? `${firstRed1h.isMarkWindow ? 'Mark Fib' : '1H Red'} ${fmtConfPx(firstRed1h.low)}–${fmtConfPx(firstRed1h.high)}`
          : 'Structure marked',
      },
      {
        id: 'ma200',
        label: `${tfTag}200 MA (H/L/C)`,
        ok: ma200Aligned,
        detail: above200Band
          ? `Above 200 MA band (>${fmtConfPx(maH)})`
          : below200Band
            ? `Below 200 MA band (<${fmtConfPx(maL)})`
            : `Inside 200 MA chop (${fmtConfPx(maL || 0)}–${fmtConfPx(maH || 0)})`,
      },
      {
        id: 'supertrend',
        label: `${tfTag}ST (10, 4.1)`,
        ok: stAligned,
        detail: stVal != null ? `${stDirection === 1 ? 'Bullish' : 'Bearish'} @ ${fmtConfPx(stVal)}` : 'n/a',
      },
      {
        id: 'trikal50',
        label: `${activeClock.id} 30m 50%`,
        ok: trikalAligned,
        detail: trikalMid != null ? `${price >= trikalMid ? 'Above' : 'Below'} ${fmtConfPx(trikalMid)}` : 'Awaiting bar',
      },
    ];

    const score = checks.reduce((acc, c) => acc + (c.ok ? 1 : 0), 0);
    const grade = score === 4 ? 'A+' : score === 3 ? 'A' : score === 2 ? 'B' : 'C';
    const summaryText = `${score}/4 (${grade}) · ${checks.map((c) => `${c.ok ? '✓' : '○'} ${c.label}`).join(' · ')}`;

    return {
      score,
      maxScore: 4,
      grade,
      refDir: refDir === 1 ? 'LONG' : 'SHORT',
      ma200: { high: maH, close: maC, low: maL, state: ma200State, aligned: ma200Aligned, insideChop: inside200Band },
      supertrend: { line: stVal, dir: stDirection, state: stState, aligned: stAligned },
      trikalClock: { id: activeClock.id, label: activeClock.label, mid: trikalMid, f44: trikalF44, high: Number.isFinite(tHi) ? tHi : null, low: Number.isFinite(tLo) ? tLo : null, aligned: trikalAligned },
      checks,
      summaryText,
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RedBarTrend;
}
if (typeof window !== 'undefined') {
  window.RedBarTrend = RedBarTrend;
}
