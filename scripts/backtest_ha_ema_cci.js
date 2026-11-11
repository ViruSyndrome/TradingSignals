'use strict';
/**
 * Backtest: Heikin Ashi 15m + EMA 20/50/200 stack + CCI ±100
 * Futures only — Dhan .cache_desk (NOT Yahoo).
 *
 *   node scripts/backtest_ha_ema_cci.js
 *   node scripts/backtest_ha_ema_cci.js --exit=cci
 *   node scripts/backtest_ha_ema_cci.js --exit=atr
 *   node scripts/backtest_ha_ema_cci.js --soft2
 *   node scripts/backtest_ha_ema_cci.js --symbol NIFTY
 *
 * ENTRY: Heikin Ashi EMA stack already true (prior bar + signal bar), then CCI(200)
 *   on the regular close steps through ±100. Only a quiet step: the CCI jump is
 *   under 25 and the close finishes less than 15 points past the line. Skip the
 *   first bar of the day and the 09:15 bar (gap smashes).
 *   A new cross is allowed after the previous trade has exited.
 * ENTRY (soft2): CCI cross first → wait ≤2 bars for stack (off unless --soft2)
 *
 * EXIT --exit=cci (default):
 *   LONG  exits when CCI crosses back DOWN through +100.
 *   SHORT exits when CCI crosses back UP through -100.
 *   No forced cash-session flatten — futures can hold across sessions.
 *
 * EXIT --exit=atr (old research): 1×ATR SL / 2R TP
 *
 * Peak analysis: between entry and exit, track MFE (best unrealized pts).
 * Capture% = realizedPts / MFE. Ideal = 100% (exited at absolute peak).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache_desk');
const symbolArg = (() => {
  const i = process.argv.indexOf('--symbol');
  return (i >= 0 ? process.argv[i + 1] : 'ALL').toUpperCase();
})();
const USE_SOFT2 = process.argv.includes('--soft2');
const EXIT_MODE = (() => {
  const a = process.argv.find((x) => x.startsWith('--exit='));
  return (a ? a.split('=')[1] : 'cci').toLowerCase();
})();
const TF_MIN = (() => {
  const a = process.argv.find((x) => x.startsWith('--tf='));
  const n = a ? Number(a.split('=')[1]) : 5;
  return [5, 15, 30].includes(n) ? n : 5;
})();
const CANDLES = (() => {
  const a = process.argv.find((x) => x.startsWith('--candles='));
  return (a ? a.split('=')[1] : 'raw').toLowerCase() === 'ha' ? 'ha' : 'raw';
})();
const CCI_SOURCE = (() => {
  const a = process.argv.find((x) => x.startsWith('--cciSource='));
  return (a ? a.split('=')[1] : 'close').toLowerCase();
})();
const CCI_LEN = (() => {
  const a = process.argv.find((x) => x.startsWith('--cciLen='));
  const n = a ? Number(a.split('=')[1]) : 200;
  return Number.isFinite(n) && n >= 5 ? n : 200;
})();
const ATR_LEN = 14;
const SL_ATR = 1.0;
const TP_R = 2.0;

function resample(bars, minutes) {
  if (minutes <= 15) return bars;
  const barMs = minutes * 60000;
  const buckets = new Map();
  for (const b of bars) {
    const key = Math.floor(b.t / barMs) * barMs;
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

function loadBars(sym) {
  const fileMin = TF_MIN === 5 ? 5 : 15;
  const p = path.join(CACHE, `${sym}_${fileMin}m.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p} — pull via Dhan prepare_*_hist.js first`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bars = Array.isArray(raw) ? raw : raw.bars || [];
  if (!bars.length) throw new Error(`Empty ${p}`);
  const mapped = bars
    .map((b) => ({
      t: Number(b.t),
      o: Number(b.o),
      h: Number(b.h),
      l: Number(b.l),
      c: Number(b.c),
      v: Number(b.v || 0),
    }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
  return resample(mapped, TF_MIN);
}

function toHA(bars) {
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haC = (b.o + b.h + b.l + b.c) / 4;
    const prev = ha[i - 1];
    const haO = prev ? (prev.o + prev.c) / 2 : (b.o + b.c) / 2;
    ha.push({
      t: b.t,
      o: haO,
      h: Math.max(b.h, haO, haC),
      l: Math.min(b.l, haO, haC),
      c: haC,
      raw: b,
    });
  }
  return ha;
}

function ema(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += vals[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < vals.length; i++) {
    e = vals[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function atr(ha, period) {
  const out = new Array(ha.length).fill(null);
  const trs = ha.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prev = ha[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i === period - 1) out[i] = sum / period;
    else if (i >= period) out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function cci(ha, period) {
  const out = new Array(ha.length).fill(null);
  // Default source is the candle close. HLC3 can print a cross the chart never closed.
  const tp = ha.map((b) => (CCI_SOURCE === 'close' ? b.c : (b.h + b.l + b.c) / 3));
  for (let i = period - 1; i < ha.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const sma = sum / period;
    let mad = 0;
    for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - sma);
    mad /= period;
    out[i] = mad === 0 ? 0 : (tp[i] - sma) / (0.015 * mad);
  }
  return out;
}

function istStamp(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(ts)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} IST`;
}

function istParts(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(new Date(ts))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    mins: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** New entries only in liquid hours; open futures positions may hold overnight. */
function allowNewEntry(sym, ts) {
  const { mins } = istParts(ts);
  if (sym === 'NIFTY') return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 20;
  return mins >= 9 * 60 && mins <= 23 * 60 + 15;
}

function longStack(i, closes, e20, e50, e200) {
  const c = closes[i];
  const a = e20[i];
  const b = e50[i];
  const d = e200[i];
  if (a == null || b == null || d == null) return false;
  return c > a && a > b && b > d;
}

function shortStack(i, closes, e20, e50, e200) {
  const c = closes[i];
  const a = e20[i];
  const b = e50[i];
  const d = e200[i];
  if (a == null || b == null || d == null) return false;
  return c < a && a < b && b < d;
}

function closeTrade(open, i, ha, exitPx, reason) {
  const b = ha[i];
  const pnl = open.side === 'LONG' ? exitPx - open.entry : open.entry - exitPx;
  const capture = open.mfe > 0 ? +(100 * Math.max(0, pnl) / open.mfe).toFixed(1) : pnl > 0 ? 100 : 0;
  const giveback = open.mfe > 0 ? +(open.mfe - Math.max(0, pnl)).toFixed(2) : 0;
  return {
    ...open,
    exitTs: b.t,
    exit: exitPx,
    exitReal: (b.raw ? b.raw.c : b.c),
    entryIst: istStamp(open.entryTs),
    exitIst: istStamp(b.t),
    pnl: +pnl.toFixed(2),
    R: open.risk > 0 ? +(pnl / open.risk).toFixed(3) : 0,
    barsHeld: i - open.i,
    reason,
    day: istParts(open.entryTs).day,
    mfe: +open.mfe.toFixed(2),
    mae: +open.mae.toFixed(2),
    capturePct: capture,
    givebackPts: giveback,
  };
}

function runSymbol(sym) {
  const bars = loadBars(sym);
  const ha = toHA(bars);
  const haCloses = ha.map((b) => b.c);
  const e20 = ema(haCloses, 20);
  const e50 = ema(haCloses, 50);
  const e200 = ema(haCloses, 200);
  const cciA = cci(bars, CCI_LEN);
  const atrA = atr(bars, ATR_LEN);

  const trades = [];
  let pending = null;
  let open = null;
  let longTaken = false;
  let shortTaken = false;
  let skippedNoStack = 0;
  let skippedRepeat = 0;

  const openPos = (side, i, mode) => {
    const b = bars[i];
    const atrV = atrA[i] || b.h - b.l;
    const risk = Math.max(atrV * SL_ATR, sym === 'NIFTY' ? 15 : 5);
    open = {
      side,
      i,
      entryTs: b.t,
      entry: b.c,
      entryReal: b.c,
      entryCciPrev: cciA[i - 1],
      entryCci: cciA[i],
      ema20: e20[i],
      ema50: e50[i],
      ema200: e200[i],
      risk,
      mode,
      sl: side === 'LONG' ? b.c - risk : b.c + risk,
      tp: side === 'LONG' ? b.c + risk * TP_R : b.c - risk * TP_R,
      mfe: 0,
      mae: 0,
      peakPx: b.c,
      troughPx: b.c,
    };
  };

  for (let i = Math.max(200, CCI_LEN); i < bars.length; i++) {
    const b = bars[i];
    const cciNow = cciA[i];
    const cciPrev = cciA[i - 1];
    const crossUp100 = cciPrev != null && cciNow != null && cciPrev < 100 && cciNow >= 100;
    const crossDn100 = cciPrev != null && cciNow != null && cciPrev > 100 && cciNow <= 100;
    const crossUpNeg100 = cciPrev != null && cciNow != null && cciPrev < -100 && cciNow >= -100;
    const crossDnNeg100 = cciPrev != null && cciNow != null && cciPrev > -100 && cciNow <= -100;
    const ls = longStack(i, haCloses, e20, e50, e200);
    const ss = shortStack(i, haCloses, e20, e50, e200);

    if (open) {
      // Track peak / trough on raw HA extremes (favorable)
      if (open.side === 'LONG') {
        open.peakPx = Math.max(open.peakPx, b.h);
        open.troughPx = Math.min(open.troughPx, b.l);
        open.mfe = Math.max(open.mfe, open.peakPx - open.entry);
        open.mae = Math.max(open.mae, open.entry - open.troughPx);
      } else {
        open.troughPx = Math.min(open.troughPx, b.l);
        open.peakPx = Math.max(open.peakPx, b.h);
        open.mfe = Math.max(open.mfe, open.entry - open.troughPx);
        open.mae = Math.max(open.mae, open.peakPx - open.entry);
      }

      if (EXIT_MODE === 'atr') {
        const hitSL = open.side === 'LONG' ? b.l <= open.sl : b.h >= open.sl;
        const hitTP = open.side === 'LONG' ? b.h >= open.tp : b.l <= open.tp;
        if (hitSL) {
          trades.push(closeTrade(open, i, ha, open.sl, 'sl'));
          open = null;
        } else if (hitTP) {
          trades.push(closeTrade(open, i, ha, open.tp, 'tp'));
          open = null;
        }
      } else {
        // Exit only on the next cross of the SAME level that entered the trade.
        // LONG entered on +100 → exit when CCI crosses back down through +100.
        // SHORT entered on -100 → exit when CCI crosses back up through -100.
        let exitNow = false;
        let exitReason = null;
        if (open.side === 'LONG' && crossDn100) {
          exitNow = true;
          exitReason = 'cci_back_through_100';
        }
        if (open.side === 'SHORT' && crossUpNeg100) {
          exitNow = true;
          exitReason = 'cci_back_through_-100';
        }
        if (exitNow && i > open.i) {
          open.exitCciPrev = cciPrev;
          open.exitCci = cciNow;
          if (open.side === 'LONG') longTaken = false;
          else shortTaken = false;
          trades.push(closeTrade(open, i, bars, b.c, exitReason));
          open = null;
        }
      }
    }

    if (open) continue;

    if (pending && i > pending.expireIdx) pending = null;
    if (pending && i <= pending.expireIdx) {
      const ok = pending.side === 'LONG' ? ls : ss;
      if (ok && allowNewEntry(sym, b.t)) {
        openPos(pending.side, i, 'soft2');
        pending = null;
        continue;
      }
    }

    if (!ls) longTaken = false;
    if (!ss) shortTaken = false;

    if (!allowNewEntry(sym, b.t)) continue;

    const lsPrev = longStack(i - 1, haCloses, e20, e50, e200);
    const ssPrev = shortStack(i - 1, haCloses, e20, e50, e200);
    const clock = istParts(b.t);
    const prevDay = i > 0 ? istParts(bars[i - 1].t).day : '';
    const firstBar = clock.day !== prevDay;
    const quiet = (now, prev, side) => {
      const jump = Math.abs(now - prev);
      const thrust = side === 'LONG' ? now - 100 : -100 - now;
      return jump < 25 && thrust >= 0 && thrust < 15 && !firstBar && clock.mins !== 9 * 60 + 15;
    };

    if (crossUp100 && ls && lsPrev && !longTaken && quiet(cciNow, cciPrev, 'LONG')) {
      openPos('LONG', i, 'quietStep');
      longTaken = true;
      pending = null;
    } else if (crossDnNeg100 && ss && ssPrev && !shortTaken && quiet(cciNow, cciPrev, 'SHORT')) {
      openPos('SHORT', i, 'quietStep');
      shortTaken = true;
      pending = null;
    } else if (crossUp100 && !ls) {
      skippedNoStack += 1;
    } else if (crossDnNeg100 && !ss) {
      skippedNoStack += 1;
    } else if (crossUp100 && ls && longTaken) {
      skippedRepeat += 1;
    } else if (crossDnNeg100 && ss && shortTaken) {
      skippedRepeat += 1;
    } else if (USE_SOFT2 && crossUp100 && !ls) {
      pending = { side: 'LONG', crossIdx: i, expireIdx: i + 2 };
    } else if (USE_SOFT2 && crossDnNeg100 && !ss) {
      pending = { side: 'SHORT', crossIdx: i, expireIdx: i + 2 };
    }
  }
  if (open) trades.push(closeTrade(open, bars.length - 1, bars, bars[bars.length - 1].c, 'eod_data'));

  return summarize(sym, bars, trades, { skippedNoStack, skippedRepeat });
}

function summarize(sym, bars, trades, extra = {}) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sumR = trades.reduce((s, t) => s + t.R, 0);
  const sumPts = trades.reduce((s, t) => s + t.pnl, 0);
  const sumMfe = trades.reduce((s, t) => s + t.mfe, 0);
  const sumGive = trades.reduce((s, t) => s + t.givebackPts, 0);
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  const captures = trades.filter((t) => t.mfe > 0).map((t) => t.capturePct);
  const avgCapture = captures.length
    ? +(captures.reduce((a, b) => a + b, 0) / captures.length).toFixed(1)
    : 0;
  const first = bars[0]?.t;
  const last = bars[bars.length - 1]?.t;

  // Rough ₹ sketch (futures points × multiplier) — illustrative, not broker P&L
  const mult = sym === 'NIFTY' ? 65 : 100; // NIFTY fut ~₹65/pt per lot; Crude ~₹100/pt
  const lots = 1;
  const approxInr1Lot = +(sumPts * mult * lots).toFixed(0);

  return {
    symbol: sym,
    source: `.cache_desk/${sym}_${TF_MIN === 5 ? 5 : 15}m.json (Dhan)`,
    tf: `${TF_MIN}m`,
    cci: `CCI(${CCI_LEN}) source=${CCI_SOURCE} on regular close`,
    candles: 'Heikin Ashi for the EMA stack. Regular close for CCI and the fill.',
    exitMode: EXIT_MODE,
    entry: 'Quiet CCI step only: HA stack already true, jump under 25, finish less than 15 past ±100, skip the day open. Exit on the next close back through the same level.',
    skippedCciNoStack: extra.skippedNoStack || 0,
    skippedRepeatCrossSameStack: extra.skippedRepeat || 0,
    soft2: USE_SOFT2,
    meaning: {
      sumR: 'Total reward in multiples of entry risk (ATR). +26R ≈ twenty-six wins of size=risk if every loss were -1R.',
      sumPts: 'Sum of regular-close points. Not rupees.',
      approxInr1Lot: `Illustrative ₹ if 1 lot futures @ ₹${mult}/pt — fees/slippage NOT included`,
      capturePct: 'How much of the peak move (MFE) we kept at CCI exit. 100% = exited at absolute peak.',
      givebackPts: 'Points left on the table (MFE − realized when realized>0)',
    },
    from: first ? new Date(first).toISOString() : null,
    to: last ? new Date(last).toISOString() : null,
    bars: bars.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? +(100 * wins.length / trades.length).toFixed(1) : 0,
    sumR: +sumR.toFixed(2),
    avgR: trades.length ? +(sumR / trades.length).toFixed(2) : 0,
    sumPts: +sumPts.toFixed(2),
    approxInr1Lot,
    sumMfePts: +sumMfe.toFixed(2),
    sumGivebackPts: +sumGive.toFixed(2),
    avgCapturePct: avgCapture,
    peakLeftOnTablePct: sumMfe > 0 ? +((100 * sumGive) / sumMfe).toFixed(1) : 0,
    byReason,
    heldLe4: (() => {
      const s = trades.filter((t) => t.barsHeld <= 4);
      const pts = s.reduce((a, t) => a + t.pnl, 0);
      return { n: s.length, wins: s.filter((t) => t.pnl > 0).length, sumPts: +pts.toFixed(1) };
    })(),
    heldGe8: (() => {
      const s = trades.filter((t) => t.barsHeld >= 8);
      const pts = s.reduce((a, t) => a + t.pnl, 0);
      return { n: s.length, wins: s.filter((t) => t.pnl > 0).length, sumPts: +pts.toFixed(1) };
    })(),
    book: trades.map((t) => ({
      side: t.side,
      entryIst: t.entryIst,
      exitIst: t.exitIst,
      entry: t.entry,
      exit: t.exit,
      pnl: t.pnl,
      cciEntry: t.entryCci != null ? +t.entryCci.toFixed(1) : null,
      cciExit: t.exitCci != null ? +t.exitCci.toFixed(1) : null,
      barsHeld: t.barsHeld,
    })),
    losses: LIST_LOSSES
      ? trades.filter((t) => t.pnl <= 0).map((t) => ({
        side: t.side,
        signalIst: t.signalIst || null,
        signalCci: t.signalCci != null ? +t.signalCci.toFixed(1) : null,
        entryIst: t.entryIst,
        exitIst: t.exitIst,
        priceEntry: +t.entry.toFixed(2),
        priceExit: +t.exit.toFixed(2),
        cciEntry: t.entryCci != null ? +t.entryCci.toFixed(1) : null,
        cciEntryPrev: t.entryCciPrev != null ? +t.entryCciPrev.toFixed(1) : null,
        cciExit: t.exitCci != null ? +t.exitCci.toFixed(1) : null,
        cciExitPrev: t.exitCciPrev != null ? +t.exitCciPrev.toFixed(1) : null,
        ema20: t.ema20 != null ? +t.ema20.toFixed(2) : null,
        ema50: t.ema50 != null ? +t.ema50.toFixed(2) : null,
        ema200: t.ema200 != null ? +t.ema200.toFixed(2) : null,
        pnl: t.pnl,
        barsHeld: t.barsHeld,
        mfe: t.mfe,
      }))
      : undefined,
    sample: trades.slice(0, 5).map((t) => ({
      side: t.side,
      mode: t.mode,
      entry: +t.entry.toFixed(2),
      exit: +t.exit.toFixed(2),
      pnl: t.pnl,
      R: t.R,
      mfe: t.mfe,
      capturePct: t.capturePct,
      reason: t.reason,
      day: t.day,
      barsHeld: t.barsHeld,
    })),
  };
}

const LIST_LOSSES = process.argv.includes('--listLosses');
const symbols = symbolArg === 'ALL' ? ['NIFTY', 'CRUDEOIL'] : [symbolArg];
const out = [];
for (const sym of symbols) {
  try {
    out.push(runSymbol(sym));
  } catch (e) {
    out.push({ symbol: sym, error: e.message });
  }
}
const reportPath = path.join(ROOT, 'docs', 'backtests', `ha_ema_cci_${EXIT_MODE}_${Date.now()}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), exitMode: EXIT_MODE, soft2: USE_SOFT2, results: out }, null, 2)
);
console.log(JSON.stringify(out.map((r) => {
  if (!r || !r.book) return r;
  const { book, ...rest } = r;
  return rest;
}), null, 2));
console.log(`\nWrote ${reportPath}`);
