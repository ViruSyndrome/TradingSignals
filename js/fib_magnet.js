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

    const state = confirmed ? 'PULL_ACTIVE' : 'PULL_WATCH';

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
        ? `🧲 FIB MAGNET ${setup.side} (1m Rebound)`
        : `🧲 FIB MAGNET ${setup.side} (Stretched)`,
      title: `Context Radar · Equilibrium Magnet Destination (${setup.side})`,
      subtitle: `Target Fib ${setup.side === 'LONG' ? 'f0' : 'f1'} (${setup.tp.toFixed(1)}) · Stretched ${setup.distPct.toFixed(2)}% · Equilibrium Anchor (Destination Only)`,
    };
  },

  /**
   * Detects real-world session opening tells & predictive bias:
   *  1. London Judas Swing (sweeping Asia High or Low in first 75m)
   *  2. NY Opening Hunt (sweeping London High or Low)
   *  3. Pre-London Ramp/Drift (12:00-13:00 IST)
   *  4. Fib Magnet Pull (69.2% reversion probability)
   */
  detectSessionTell({ bars, sessionBand, refs, asOfTs, instrumentId }) {
    const now = asOfTs || (bars && bars.length ? bars[bars.length - 1].t : Date.now());
    const d = new Date(now);
    const inv = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hour = inv.getHours();
    const minute = inv.getMinutes();
    const mins = hour * 60 + minute;

    if (!bars || bars.length < 5) return null;
    const lastBar = bars[bars.length - 1];
    const price = lastBar.c;

    const instUpper = String(instrumentId || '').toUpperCase();
    if (instUpper === 'NIFTY') {
      if (mins >= 555 && mins < 735) {
        return {
          id: 'nifty_prime_pob',
          badge: '🇮🇳 NSE PRIME WINDOW',
          session: 'NSE Open · POB & Trade 1 (09:15–12:15 IST)',
          predictedDir: 'WATCH 09:15 5m X-CANDLE POB 44–56 OR 1H FIRST RED LEAVE',
          confidence: '94.9% 2Y POB Win Rate',
          headline: '🇮🇳 Dr. Dev 09:15 5m X-Candle POB & 1H Trade 1 Active',
          detail: 'First 5m red candle at 09:15 IST = X-Candle. Wait for retest of POB 0.44–0.56 and 5m close < 0.44 for SHORT (SL @ 0.56, TP1 @ Anchor Low), or Trade 1 departure of 1H First Red.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins >= 735 && mins <= 795) {
        return {
          id: 'nifty_1245_hunt',
          badge: '⚡ 12:45 PM LIQUIDITY HUNT',
          session: 'Dr. Dev 12:45 PM Hunt Window (12:15–13:15 IST)',
          predictedDir: 'FLATTEN MORNING SCALPS · WATCH H/L SWEEP',
          confidence: 'Institutional Stop Hunt Window',
          headline: '⚡ 12:45 PM IST Institutional Liquidity Sweep Window',
          detail: 'Dr. Dev rule: flatten morning POB scalps by 12:45 PM. Institutions sweep morning High/Low around 12:45 PM before European desks open.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins >= 915 && mins <= 945) {
        return {
          id: 'nifty_close_mark',
          badge: '📐 15:15–15:45 MARK WINDOW',
          session: 'NSE Closing Range Mark Window (15:15–15:45 IST)',
          predictedDir: 'LOCKING NEXT SESSION FIB 0 / POB 44–56 / FIB 1',
          confidence: 'Closing Anchor Window',
          headline: '📐 NSE 15:15–15:45 IST Closing Fib Box Forming',
          detail: 'High and Low wicks of 15:15–15:45 IST lock the Fib 0, POB 44–56, and Fib 1 levels for the next NSE session.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins < 555 || mins > 945) {
        return {
          id: 'nifty_closed',
          badge: '⏸️ NSE CLOSED',
          session: 'NSE Cash Hours: 09:15–15:30 IST',
          predictedDir: 'WAIT FOR 09:15 IST NSE OPEN BELL',
          confidence: '94.9% 2Y POB Win Rate',
          headline: '🇮🇳 NSE Closed — Next Prime POB X-Candle at 09:15 IST',
          detail: 'Prior day 15:15–15:45 IST Mark Fibs and 1H First Red levels are locked on chart. Next live X-Candle forms at 09:15 IST.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      return {
        id: 'nifty_afternoon',
        badge: '🇮🇳 NSE AFTERNOON',
        session: 'NSE Afternoon Session (13:15–15:15 IST)',
        predictedDir: 'TRADE 1 DEPARTURE OR SETUP 3 RUBBER BAND',
        confidence: 'Post-12:45 Trend Window',
        headline: '🇮🇳 Post-12:45 PM Afternoon Continuation / Mean Reversion',
        detail: 'Morning POB window closed (12:15 cutoff). Watch 1H First Red Trade 1 leave or 30m 5 EMA Rubber Band (Setup 3).',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    if (instUpper === 'NG') {
      if (mins >= 540 && mins < 720) {
        return {
          id: 'ng_mcx_open',
          badge: '🔥 MCX MORNING OPEN',
          session: 'MCX Morning Session · POB & 30m First Red (09:00–12:00 IST)',
          predictedDir: 'WATCH 09:00 5m X-CANDLE POB 44–56 OR 30m FIRST RED LEAVE',
          confidence: 'Dr. Dev Trikal Commodity Window',
          headline: '🔥 MCX 09:00 IST 5m X-Candle POB & 30m First Red Active',
          detail: 'First 5m red candle at 09:00 IST = X-Candle (POB 0.44–0.56 retest SHORT). Also marks today’s 30m First Red anchor after the 09:00–09:30 open bar.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins >= 1020 && mins < 1110) {
        return {
          id: 'ng_mcx_eve',
          badge: '⚡ 5:00 PM MCX EVENING OPEN',
          session: 'Dr. Dev 5:00 PM IST Energy Window (17:00–18:30 IST)',
          predictedDir: 'EUROPEAN ENERGY INJECTION · WATCH 17:00 5m POB & DAY H/L SWEEP',
          confidence: 'Prime MCX Evening Slot',
          headline: '⚡ 17:00 IST MCX Evening Session & Liquidity Sweep Window',
          detail: 'Dr. Dev’s signature 5:00 PM IST commodity window: European energy traders enter, sweeping MCX Morning High/Low and forming a fresh 17:00 5m X-Candle POB.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins >= 1110 && mins < 1380) {
        return {
          id: 'ng_nymex_open',
          badge: '🇺🇸 US NYMEX PIT OPEN',
          session: 'US NYMEX Energy Session (18:30/19:30–23:00 IST)',
          predictedDir: 'PEAK NATGAS VOLATILITY · NYMEX POB & 30m TRADE 2 / SETUP 3',
          confidence: 'Highest Daily Volume Window',
          headline: '🇺🇸 US NYMEX Open — Peak Natural Gas Liquidity Injection',
          detail: 'NYMEX 09:00 ET pit open drives the largest daily Natural Gas trend. Watch NYMEX 5m X-Candle POB 44–56, 30m First Red Trade 2 sweep, or 30m 5 EMA Rubber Band.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
      if (mins >= 1380 && mins <= 1410) {
        return {
          id: 'ng_close_mark',
          badge: '📐 23:00–23:30 MCX MARK WINDOW',
          session: 'MCX Closing Range Mark Window (23:00–23:30 IST)',
          predictedDir: 'LOCKING NEXT SESSION FIB 0 / POB 44–56 / FIB 1',
          confidence: 'Closing Anchor Window',
          headline: '📐 MCX 23:00–23:30 IST Closing Fib Box Forming',
          detail: 'High and Low wicks of 23:00–23:30 IST lock the Fib 0, POB 44–56, and Fib 1 levels for the next Natural Gas session.',
          candleTime: lastBar.t,
          type: 'neutral',
        };
      }
    }

    if (instUpper === 'XAU' && mins >= 90 && mins < 150) {
      return {
        id: 'xau_mark_window',
        badge: '📐 01:30–02:30 GOLD MARK WINDOW',
        session: 'Gold Daily Mark Window (01:30–02:30 IST)',
        predictedDir: 'LOCKING TODAY’S GOLD FIB 0 / POB 44–56 / FIB 1',
        confidence: 'Brahmastra Session Fib Anchor',
        headline: '📐 XAU 01:30–02:30 IST Mark Window Forming',
        detail: 'High and Low wicks of 01:30–02:30 IST lock today’s Gold Fib 0, POB 44–56, and Fib 1 levels. Today’s 30m First Red anchors after 02:30 IST.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // Dynamic conversion tracking US & European Daylight Saving Time (DST)
    const getSessionMins = (tz, h, m) => {
      try {
        const dIso = new Date(d.toLocaleString('en-US', { timeZone: tz }));
        const dUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
        const diffHours = (dUtc - dIso) / (3600 * 1000);
        return (h * 60 + m + Math.round(diffHours * 60) + (5 * 60 + 30) + 1440) % 1440;
      } catch (_) {
        return h * 60 + m;
      }
    };
    const nyOpenMins = getSessionMins('America/New_York', 9, 30);
    const lonOpenMins = getSessionMins('Europe/London', 8, 0);
    const lonCloseMins = getSessionMins('Europe/London', 16, 30);
    const fmtHm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
    const nyOpenStr = fmtHm(nyOpenMins);
    const nyEndStr = fmtHm(nyOpenMins + 60);
    const lonOpenStr = fmtHm(lonOpenMins);
    const lonEndStr = fmtHm(lonOpenMins + 75);

    const asiaHigh = refs?.asiaHigh;
    const asiaLow = refs?.asiaLow;
    const lonHigh = refs?.londonHigh;
    const lonLow = refs?.londonLow;

    // Check last 4 bars for recent sweeps
    const recentBars = bars.slice(-4);
    const minRecent = Math.min(...recentBars.map(b => b.l));
    const maxRecent = Math.max(...recentBars.map(b => b.h));

    const markHigh = sessionBand?.f1 ?? sessionBand?.high ?? refs?.markHigh;
    const markLow = sessionBand?.f0 ?? sessionBand?.low ?? refs?.markLow;

    // 1. Asia Open Window: 05:30 to 07:15 IST (mins 330 to 435) — 00:00 UTC Midnight Daily Open
    if (mins >= 330 && mins <= 435) {
      if (markLow != null && minRecent < markLow && price >= markLow * 0.998) {
        return {
          id: 'asia_sweep_mark_low',
          badge: '⚡ MARK LOW SWEPT',
          session: 'Asia Open / Daily Open (05:30–07:15 IST)',
          predictedDir: 'POTENTIAL ASIA BOUNCE',
          confidence: '71.7% Session Extreme Window',
          headline: `⚡ Mark Low Swept ($${Number(markLow).toFixed(1)}) — UTC Daily Low Tell`,
          detail: `In 729 days of BTC data, 71.7% of sessions set the Asia extreme in the first 90m. Mark window low was swept; contextual tell only — wait for Red Bar DNA to enter.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (markHigh != null && maxRecent > markHigh && price <= markHigh * 1.002) {
        return {
          id: 'asia_sweep_mark_high',
          badge: '⚡ MARK HIGH SWEPT',
          session: 'Asia Open / Daily Open (05:30–07:15 IST)',
          predictedDir: 'POTENTIAL ASIA FADE',
          confidence: '71.7% Session Extreme Window',
          headline: `⚡ Mark High Swept ($${Number(markHigh).toFixed(1)}) — UTC Daily High Tell`,
          detail: `In 729 days of BTC data, 71.7% of sessions set the Asia extreme in the first 90m. Mark window high was swept; contextual tell only — wait for Red Bar DNA to enter.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      return {
        id: 'asia_open_window',
        badge: '🌏 ASIA OPEN (UTC 00:00)',
        session: 'Asia Open Active (05:30–07:15 IST)',
        predictedDir: 'WATCH FOR OPENING RANGE ESTABLISHMENT',
        confidence: '71.7% Session Extreme Window',
        headline: '🌏 Asia Opening Liquidity Window Active',
        detail: '05:30 IST is UTC Midnight (new daily candle). In 729 days of BTC data, 71.7% of sessions set the Asia extreme in the first 90m. Watch reaction at Mark Fibs.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 2. Pre-Asia Window: 03:30 to 05:30 IST (mins 210 to 330)
    if (mins >= 210 && mins < 330) {
      return {
        id: 'pre_asia_drift',
        badge: '🌏 PRE-ASIA DRIFT',
        session: 'Pre-Asia (03:30–05:30 IST)',
        predictedDir: 'WAIT FOR 05:30 UTC DAILY OPEN',
        confidence: 'Low Volume Consolidation',
        headline: '🌏 Pre-Asia Low-Volume Drift',
        detail: 'Mark window has locked. Low-volume drift into 05:30 IST Daily Open. Avoid chasing small pre-market moves before Asian volume arrives.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 3. Pre-London Window: 12:00 to 13:00 IST (mins 720 to 750)
    if (mins >= 720 && mins < 750) {
      const slicePre = bars.slice(-4);
      const preDelta = (slicePre[slicePre.length - 1].c - slicePre[0].o) / slicePre[0].o * 100;
      if (preDelta > 0.20) {
        return {
          id: 'pre_london_pump',
          badge: '🕒 PRE-LONDON RAMP',
          session: 'Pre-London (12:00–13:00 IST)',
          predictedDir: 'POTENTIAL OPENING FADE',
          confidence: 'Context Tell (Pre-London)',
          headline: '🕒 Pre-London Ramp (+0.2% into open)',
          detail: 'Slow upward grind in low pre-market volume often acts as opening bait. London open (13:00 IST) frequently counter-punches. Context tell only.',
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
          confidence: 'Context Tell (Pre-London)',
          headline: '🕒 Pre-London Slide (-0.2% into open)',
          detail: 'Slow downward slide into London open. Watch for an opening flush below Asia Low to form London session low. Context tell only.',
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
    }

    // 4. London Open Window (dynamic: 13:30 in winter GMT, 12:30 in summer BST)
    if (mins >= lonOpenMins && mins <= lonOpenMins + 75) {
      if (asiaLow != null && minRecent < asiaLow && price >= asiaLow * 0.998) {
        return {
          id: 'london_judas_low',
          badge: '⚡ ASIA LOW SWEPT',
          session: `London Open (${lonOpenStr}–${lonEndStr} IST)`,
          predictedDir: 'POTENTIAL BOUNCE',
          confidence: '62.7% Session Extreme Window',
          headline: `⚡ Asia Low Swept ($${Number(asiaLow).toFixed(1)}) — London Judas Swing`,
          detail: `In 729 sessions of BTC data, 62.7% set the London session extreme in the first 45m. Asia Low was punctured; watch for rejection wicks back toward equilibrium. Contextual tell only.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (asiaHigh != null && maxRecent > asiaHigh && price <= asiaHigh * 1.002) {
        return {
          id: 'london_judas_high',
          badge: '⚡ ASIA HIGH SWEPT',
          session: `London Open (${lonOpenStr}–${lonEndStr} IST)`,
          predictedDir: 'POTENTIAL FADE',
          confidence: '62.7% Session Extreme Window',
          headline: `⚡ Asia High Swept ($${Number(asiaHigh).toFixed(1)}) — London Judas Swing`,
          detail: `In 729 sessions of BTC data, 62.7% set the London session extreme in the first 45m. Asia High was swept; watch for rejection wicks back toward equilibrium. Contextual tell only.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      return {
        id: 'london_open_hunt',
        badge: '🕒 LONDON OPEN WINDOW',
        session: `London Open Active (${lonOpenStr}–${lonEndStr} IST)`,
        predictedDir: 'WATCH FOR OPENING SWEEP',
        confidence: '62.7% Session Extreme Window',
        headline: '🕒 London Opening Liquidity Hunt in Progress',
        detail: 'In 729 days of BTC data, 62.7% of sessions set their London high or low in the first 45m. Watch for fakeout sweeps at Asia High/Low before real direction establishes.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 5. New York Open Window (dynamic: 20:00 in winter EST, 19:00 in summer EDT)
    if (mins >= nyOpenMins && mins < nyOpenMins + 60) {
      if (lonLow != null && minRecent < lonLow && price >= lonLow * 0.998) {
        return {
          id: 'ny_sweep_lon_low',
          badge: '⚡ LONDON LOW SWEPT',
          session: `New York Open (${nyOpenStr}–${nyEndStr} IST)`,
          predictedDir: 'BULLISH BOUNCE',
          confidence: '53.7% Historical Range Return',
          headline: `⚡ London Low Swept ($${Number(lonLow).toFixed(1)}) — NY Opening Tell`,
          detail: `New York swept the London session low. In 729 days of BTC data, 53.7% of early London sweeps returned back into the daily range. Context tell only — wait for Red Bar DNA to enter.`,
          candleTime: lastBar.t,
          type: 'bullish',
        };
      }
      if (lonHigh != null && maxRecent > lonHigh && price <= lonHigh * 1.002) {
        return {
          id: 'ny_sweep_lon_high',
          badge: '⚡ LONDON HIGH SWEPT',
          session: `New York Open (${nyOpenStr}–${nyEndStr} IST)`,
          predictedDir: 'POTENTIAL RETRACE',
          confidence: '48.4% Historical Range Return',
          headline: `⚡ London High Swept ($${Number(lonHigh).toFixed(1)}) — NY Opening Tell`,
          detail: `New York swept the London session high. In 729 days of BTC data, 48.4% of early London sweeps returned back into the daily range. Context tell only — wait for Red Bar DNA to enter.`,
          candleTime: lastBar.t,
          type: 'bearish',
        };
      }
      return {
        id: 'ny_open_window',
        badge: '🕒 NY OPEN WINDOW',
        session: `New York Open Active (${nyOpenStr}–${nyEndStr} IST)`,
        predictedDir: 'WATCH NY SWEEP OF LONDON H/L',
        confidence: '56% Extreme Window',
        headline: '🕒 New York Opening Volatility Active',
        detail: '56.0% of days form NY session extreme in first 45m. Watch how price reacts around London High/Low levels.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 6. London Close / 4 PM Fix Window: (dynamic: 21:00 to 22:30 in winter, 20:00 to 21:30 in summer)
    if (mins >= lonCloseMins - 60 && mins <= lonCloseMins + 30) {
      return {
        id: 'london_close_fix',
        badge: '🇬🇧 LONDON CLOSE / 4PM FIX',
        session: `London Close (${fmtHm(lonCloseMins - 60)}–${fmtHm(lonCloseMins + 30)} IST)`,
        predictedDir: 'REVERSAL / CHOP WARNING',
        confidence: '61.8% Non-Continuation Rate',
        headline: '🇬🇧 London 4 PM Fix — Institutional Rebalancing',
        detail: '61.8% of trend days reverse (46%) or chop (16%) during London close as European desks square books. Avoid chasing late breakout momentum; watch for squeezes back to VWAP.',
        candleTime: lastBar.t,
        type: 'neutral',
      };
    }

    // 7. US Close & Settlement: 01:15 to 02:30 IST (mins 75 to 150)
    if (mins >= 75 && mins < 150) {
      return {
        id: 'us_close_settle',
        badge: '🇺🇸 US CLOSE & SETTLE',
        session: 'US Equity Close (01:15–02:30 IST)',
        predictedDir: 'COMPRESSION INTO MARK WINDOW',
        confidence: 'Post-Settle Consolidation',
        headline: '🇺🇸 US Cash Closed (01:30 IST) & CME Settle',
        detail: 'US equities closed at 01:30 IST. Volatility compresses as liquidity drains before the next 02:30 IST Mark Window forms.',
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
          badge: `🧲 TARGET $${f0.toFixed(0)}`,
          session: 'Daily Equilibrium Anchor',
          predictedDir: 'EQUILIBRIUM DESTINATION',
          confidence: '69.2% Equilibrium Revisit Rate',
          headline: `Stretched -${distBelowPct.toFixed(2)}% below $${f0.toFixed(1)} Anchor Low`,
          detail: `Price is stretched ${distBelowPct.toFixed(2)}% below the daily mark window ($${f0.toFixed(1)}). In 729 days of BTC data, 69.2% of sessions revisit the box after a >= 0.5% stretch. Destination magnet only — stop loss belongs below the lowest structural wick.`,
          candleTime: lastBar.t,
          type: 'bullish',
          targetPrice: f0,
        };
      }
      if (distAbovePct >= 0.50) {
        return {
          id: 'fib_magnet_short',
          badge: `🧲 TARGET $${f1.toFixed(0)}`,
          session: 'Daily Equilibrium Anchor',
          predictedDir: 'EQUILIBRIUM DESTINATION',
          confidence: '69.2% Equilibrium Revisit Rate',
          headline: `Stretched +${distAbovePct.toFixed(2)}% above $${f1.toFixed(1)} Anchor High`,
          detail: `Price is stretched ${distAbovePct.toFixed(2)}% above the daily mark window ($${f1.toFixed(1)}). In 729 days of BTC data, 69.2% of sessions revisit the box after a >= 0.5% stretch. Destination magnet only — stop loss belongs above the highest structural wick.`,
          candleTime: lastBar.t,
          type: 'bearish',
          targetPrice: f1,
        };
      }
    }

    // 5. Default Session Context
    return {
      id: 'session_standard',
      badge: mins < lonOpenMins ? '🌏 ASIA SESSION' : mins < nyOpenMins ? '🇬🇧 LONDON SESSION' : '🇺🇸 NY SESSION',
      session: 'Standard Flow',
      predictedDir: 'WAIT FOR SESSION OPEN OR FIB STRETCH',
      confidence: 'Market in Equilibrium',
      headline: `Holding between Fib Anchor & Session Pivots`,
      detail: `Price is trading near fair value. High-conviction tells appear at London Open (${lonOpenStr} IST), NY Open (${nyOpenStr} IST), or when price stretches ≥0.5% away from the Fib box.`,
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
