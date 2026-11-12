'use strict';
/**
 * Exact Locked-Rules Comparison:
 * Heikin Ashi (HA) EMA Stack vs Normal Candlestick EMA Stack
 * using the locked rules from docs/STRATEGY_LEARNING_2026-11-11.md
 */
const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '..', '.cache_desk');

function loadBars(sym = 'NIFTY') {
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE, `${sym}_15m.json`), 'utf8'));
  return (Array.isArray(raw) ? raw : raw.bars)
    .map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

function ema(vals, p) {
  const out = Array(vals.length).fill(null);
  const k = 2 / (p + 1);
  let e = 0;
  for (let i = 0; i < p; i++) e += vals[i];
  e /= p;
  out[p - 1] = e;
  for (let i = p; i < vals.length; i++) {
    e = vals[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function cciClose(bars, period = 200) {
  const tp = bars.map((b) => b.c); // Locked rule: source = regular close
  const out = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
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

function toHA(bars) {
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const c = (b.o + b.h + b.l + b.c) / 4;
    const prev = ha[i - 1];
    const o = prev ? (prev.o + prev.c) / 2 : (b.o + b.c) / 2;
    ha.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c });
  }
  return ha;
}

function istParts(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}

function runLocked(useHA) {
  const bars = loadBars('NIFTY');
  const stackBars = useHA ? toHA(bars) : bars;
  const stackCloses = stackBars.map((b) => b.c);

  const e20 = ema(stackCloses, 20);
  const e50 = ema(stackCloses, 50);
  const e200 = ema(stackCloses, 200);
  const cciA = cciClose(bars, 200); // Always regular close for CCI per locked rule

  const longOk = (i) => e20[i] != null && stackCloses[i] > e20[i] && e20[i] > e50[i] && e50[i] > e200[i];
  const shortOk = (i) => e20[i] != null && stackCloses[i] < e20[i] && e20[i] < e50[i] && e50[i] < e200[i];

  const trades = [];
  let open = null;
  let longTaken = false;
  let shortTaken = false;

  for (let i = 200; i < bars.length; i++) {
    const b = bars[i];
    const prev = cciA[i - 1];
    const now = cciA[i];
    if (prev == null || now == null) continue;

    const crossUp100 = prev < 100 && now >= 100;
    const crossDn100 = prev > 100 && now <= 100;
    const crossUpNeg100 = prev < -100 && now >= -100;
    const crossDnNeg100 = prev > -100 && now <= -100;

    if (open) {
      const exit = (open.side === 'LONG' && crossDn100) || (open.side === 'SHORT' && crossUpNeg100);
      if (exit && i > open.i) {
        const pnl = open.side === 'LONG' ? b.c - open.entry : open.entry - b.c;
        trades.push({ ...open, exit: b.c, pnl: +pnl.toFixed(2), held: i - open.i });
        if (open.side === 'LONG') longTaken = false;
        else shortTaken = false;
        open = null;
      }
    }

    if (open) continue;

    const ls = longOk(i);
    const ss = shortOk(i);
    if (!ls) longTaken = false;
    if (!ss) shortTaken = false;

    const clock = istParts(b.t);
    if (clock.mins < 9 * 60 + 15 || clock.mins > 15 * 60 + 20) continue;

    const prevDay = istParts(bars[i - 1].t).day;
    const firstBar = clock.day !== prevDay;
    const quiet = (val, pVal, side) => {
      const jump = Math.abs(val - pVal);
      const thrust = side === 'LONG' ? val - 100 : -100 - val;
      return jump < 25 && thrust >= 0 && thrust < 15 && !firstBar && clock.mins !== 9 * 60 + 15;
    };

    if (crossUp100 && ls && longOk(i - 1) && !longTaken && quiet(now, prev, 'LONG')) {
      longTaken = true;
      open = { side: 'LONG', i, entry: b.c, day: clock.day };
    } else if (crossDnNeg100 && ss && shortOk(i - 1) && !shortTaken && quiet(now, prev, 'SHORT')) {
      shortTaken = true;
      open = { side: 'SHORT', i, entry: b.c, day: clock.day };
    }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sumPts = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    stackChart: useHA ? 'Heikin Ashi (HA)' : 'Normal Candlesticks',
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: `${((wins.length / trades.length) * 100).toFixed(1)}%`,
    netPoints: +sumPts.toFixed(1),
    futures1LotRs: Math.round(sumPts * 65),
    grossWinPts: +grossWin.toFixed(1),
    grossLossPts: +grossLoss.toFixed(1),
    profitFactor: +(grossWin / (grossLoss || 1)).toFixed(2),
    bestTrade: Math.max(...trades.map((t) => t.pnl)),
    worstTrade: Math.min(...trades.map((t) => t.pnl)),
  };
}

console.table([runLocked(true), runLocked(false)]);
