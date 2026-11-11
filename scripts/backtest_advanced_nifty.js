'use strict';
/**
 * Advanced NIFTY Red Bar — index-path backtest of the live engine.
 * Walks closed 15m bars the way the desk does, fills at the index close,
 * and exits on the 5m path: stop, tp1, or the 15:10 flatten.
 *
 *   node scripts/backtest_advanced_nifty.js
 *
 * Points are NIFTY index points. This is not option-premium P&L.
 * Dhan .cache_desk only.
 */
const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const BAR15 = 15 * 60000;
const BAR5 = 5 * 60000;
const AUTO = new Set([
  'trade1_departure',
  'trade2_confirmed',
  'fib_bounce',
  'session_sweep',
  'pob_reject',
  'setup3_rubber_band',
  'afternoon_1245_reversal',
  'afternoon_1245_breakout',
  'afternoon_1245_retest',
]);

function load(tf) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache_desk', `NIFTY_${tf}.json`), 'utf8'));
  const bars = (Array.isArray(raw) && raw[0] && typeof raw[0].t === 'number')
    ? raw.slice()
    : raw.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function ist(ts) {
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
    fmt.formatToParts(new Date(ts)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    mins: hour * 60 + Number(parts.minute),
    stamp: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${parts.minute}`,
  };
}

function lastClosed(bars, asOf, barMs) {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + barMs <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function walkExit(bars5, fromTs, side, entry, stop, tp) {
  const i0 = lastClosed(bars5, fromTs, BAR5) + 1;
  for (let i = Math.max(0, i0); i < bars5.length; i++) {
    const b = bars5[i];
    const clock = ist(b.t);
    if (clock.mins >= 15 * 60 + 10 || clock.mins < 9 * 60 + 15) {
      const px = b.o;
      const pnl = side === 'LONG' ? px - entry : entry - px;
      return { exit: px, exitIst: clock.stamp, pnl, reason: 'flatten_1510', barsHeld: i - i0 + 1 };
    }
    const hitSl = side === 'LONG' ? b.l <= stop : b.h >= stop;
    const hitTp = side === 'LONG' ? b.h >= tp : b.l <= tp;
    if (hitSl && hitTp) {
      const pnl = side === 'LONG' ? stop - entry : entry - stop;
      return { exit: stop, exitIst: clock.stamp, pnl, reason: 'stop', barsHeld: i - i0 + 1 };
    }
    if (hitSl) {
      const pnl = side === 'LONG' ? stop - entry : entry - stop;
      return { exit: stop, exitIst: clock.stamp, pnl, reason: 'stop', barsHeld: i - i0 + 1 };
    }
    if (hitTp) {
      const pnl = side === 'LONG' ? tp - entry : entry - tp;
      return { exit: tp, exitIst: clock.stamp, pnl, reason: 'tp1', barsHeld: i - i0 + 1 };
    }
    if (i - i0 > 80) break;
  }
  return null;
}

function runWindow(bars15, bars5, startTs, endTs, advanced) {
  const inst = (CONFIG.rangeEma.instruments || []).find((x) => x.id === 'NIFTY');
  const cfg = {
    ...inst,
    id: 'NIFTY',
    instrumentId: 'NIFTY',
    advancedFibs: advanced,
    advancedFibGapPts: 40,
    touchPct: 0.15,
    dayMode: 'ist',
  };
  const trades = [];
  const bySetup = {};
  let sandwichBars = 0;
  let enterSignals = 0;
  const seen = new Set();

  for (let i = 80; i < bars15.length; i++) {
    const bar = bars15[i];
    if (bar.t < startTs || bar.t >= endTs) continue;
    const asOf = bar.t + BAR15 - 1000;
    const clock = ist(bar.t);
    if (clock.mins < 9 * 60 + 15 || clock.mins >= 15 * 60) continue;

    const slice15 = bars15.slice(Math.max(0, i - 499), i + 1);
    const i5 = lastClosed(bars5, asOf, BAR5);
    if (i5 < 30) continue;
    const m5 = bars5.slice(Math.max(0, i5 - 499), i5 + 1);
    const calDay = RedBarTrend.dayKey(bar.t, 'ist');
    const firstRed1h = RedBarTrend.firstRedBarOfSession(m5, calDay, {
      ...cfg,
      asOfTs: asOf,
      barMs: BAR5,
    });
    const o = RedBarTrend.readAt(slice15, slice15.length - 1, {
      ...cfg,
      asOfTs: asOf,
      firstRed1h,
      bars5m: m5,
    });
    if (!o) continue;
    if (o.setupKind === 'fib_sandwich_wait') sandwichBars += 1;
    if (o.actionState !== 'enter') continue;
    if (!AUTO.has(o.setupKind)) continue;
    enterSignals += 1;
    const side = o.trend === 'bullish' ? 'LONG' : o.trend === 'bearish' ? 'SHORT' : null;
    const stop = Number(o.invalidation);
    const tp = Number(o.playbook && o.playbook.tp1);
    const entry = Number(o.price);
    if (!side || !Number.isFinite(stop) || !Number.isFinite(tp) || !Number.isFinite(entry)) continue;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1) || risk > 800) continue;
    if (side === 'LONG' && !(tp > entry && stop < entry)) continue;
    if (side === 'SHORT' && !(tp < entry && stop > entry)) continue;
    const key = `${o.setupKind}|${o.triggerTs || clock.stamp}|${side}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ex = walkExit(bars5, asOf, side, entry, stop, tp);
    if (!ex) continue;
    const trade = {
      side,
      setup: o.setupKind,
      entryIst: clock.stamp,
      exitIst: ex.exitIst,
      entry: Math.round(entry * 100) / 100,
      exit: Math.round(ex.exit * 100) / 100,
      stop: Math.round(stop * 100) / 100,
      tp: Math.round(tp * 100) / 100,
      pnl: Math.round(ex.pnl * 100) / 100,
      r: Math.round((ex.pnl / risk) * 100) / 100,
      reason: ex.reason,
      barsHeld: ex.barsHeld,
    };
    trades.push(trade);
    bySetup[o.setupKind] = bySetup[o.setupKind] || { n: 0, wins: 0, pts: 0 };
    bySetup[o.setupKind].n += 1;
    if (trade.pnl > 0) bySetup[o.setupKind].wins += 1;
    bySetup[o.setupKind].pts = Math.round((bySetup[o.setupKind].pts + trade.pnl) * 100) / 100;

    const exitMs = Date.parse(ex.exitIst.replace(' ', 'T') + ':00+05:30');
    while (i + 1 < bars15.length && bars15[i + 1].t < exitMs) i += 1;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const pts = Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  const sumR = Math.round(trades.reduce((s, t) => s + t.r, 0) * 100) / 100;
  return {
    advancedFibs: advanced,
    from: ist(startTs).stamp,
    to: ist(endTs).stamp,
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? Math.round((100 * wins.length) / trades.length * 10) / 10 : 0,
    sumPts: pts,
    sumR,
    sandwichBars,
    enterSignals,
    bySetup,
    book: trades,
  };
}

function summarize(row) {
  const { book, ...rest } = row;
  return rest;
}

const bars15 = load('15m');
const bars5 = load('5m');
const last = bars15[bars15.length - 1].t;
const twoWeeks = last - 14 * 86400000;
const year = last - 365 * 86400000;

const windows = [
  ['last14d', twoWeeks, last + BAR15],
  ['year', Math.max(year, bars15[80].t), last + BAR15],
];

const results = [];
for (const [name, a, b] of windows) {
  for (const advanced of [true, false]) {
    const t0 = Date.now();
    const row = runWindow(bars15, bars5, a, b, advanced);
    row.window = name;
    row.seconds = Math.round((Date.now() - t0) / 1000);
    results.push(row);
    console.error(name, advanced ? 'advanced' : 'dna-only', row.trades, 'trades', row.sumPts, 'pts', row.seconds + 's');
  }
}

const reportPath = path.join(ROOT, 'docs', 'backtests', `advanced_nifty_${Date.now()}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results.map(summarize), null, 2));
console.log(`\nWrote ${reportPath}`);
