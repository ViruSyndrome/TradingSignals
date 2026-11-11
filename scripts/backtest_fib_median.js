'use strict';
/**
 * Advanced NIFTY Red Bar — median wick backtest. Dhan 5m only.
 *
 * Fibs: 09:15 candle, the first red candle (tradable only after it closes),
 * and the gap when it is at least 40 points.
 * A candle that wicks into a median and closes back, or flips color as it
 * cuts the median, is the entry. Stop is that wick. Target is the next median.
 * One position, flat by the close.
 *
 *   node scripts/backtest_fib_median.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAP_MIN = 40;
const TOL = 10;

function load() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache_desk', 'NIFTY_5m.json'), 'utf8'));
  const bars = (raw[0] && typeof raw[0].t === 'number' ? raw : raw.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })))
    .filter((b) => Number.isFinite(b.t));
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function ist(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    mins: hour * 60 + Number(p.minute),
    stamp: `${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, '0')}:${p.minute}`,
  };
}

function zone(id, low, high) {
  const r = high - low;
  if (!(r > 1)) return null;
  return { id, lo: low + 0.44 * r, hi: low + 0.56 * r, mid: low + 0.5 * r };
}

function wickMeets(bar, z) {
  return bar.l <= z.hi + TOL && bar.h >= z.lo - TOL;
}

/** Close back through the band, or a color-flip that cuts the band. */
function signal(bar, prev, z) {
  if (!wickMeets(bar, z)) return null;
  const flipLong = prev && prev.c < prev.o && bar.c > bar.o && bar.l <= z.lo + TOL;
  const flipShort = prev && prev.c > prev.o && bar.c < bar.o && bar.h >= z.hi - TOL;
  if (bar.c > z.hi && bar.l <= z.hi + TOL) return 'LONG';
  if (bar.c < z.lo && bar.h >= z.lo - TOL) return 'SHORT';
  if (flipLong && bar.c > z.lo - TOL) return 'LONG';
  if (flipShort && bar.c < z.hi + TOL) return 'SHORT';
  return null;
}

function nextMedian(side, price, zones) {
  if (side === 'LONG') {
    const above = zones.filter((z) => z.lo > price + TOL).sort((a, b) => a.lo - b.lo);
    return above.length ? above[0].lo : null;
  }
  const below = zones.filter((z) => z.hi < price - TOL).sort((a, b) => b.hi - a.hi);
  return below.length ? below[0].hi : null;
}

function dayTrades(dayBars, prevClose) {
  if (dayBars.length < 3) return [];
  const open = dayBars[0];
  const openZ = zone('open', open.l, open.h);
  if (!openZ) return [];
  let redZ = null;
  let gapZ = null;
  if (prevClose != null && Math.abs(open.o - prevClose) >= GAP_MIN) {
    gapZ = zone('gap', Math.min(prevClose, open.o), Math.max(prevClose, open.o));
  }
  const trades = [];
  let pos = null;

  const medians = () => [openZ, redZ, gapZ].filter(Boolean);

  function enter(bar, clock, prev) {
    if (clock.mins >= 15 * 60 + 5) return;
    let best = null;
    for (const z of medians()) {
      const side = signal(bar, prev, z);
      if (!side) continue;
      const stop = side === 'LONG' ? bar.l : bar.h;
      if (side === 'LONG' && !(stop < bar.c)) continue;
      if (side === 'SHORT' && !(stop > bar.c)) continue;
      const target = nextMedian(side, bar.c, medians());
      const score = Math.abs((side === 'LONG' ? bar.l : bar.h) - z.mid);
      if (!best || score < best.score) best = { side, stop, target, line: z.id, score };
    }
    if (!best) return;
    pos = {
      side: best.side,
      entry: bar.c,
      stop: best.stop,
      target: best.target,
      line: best.line,
      entryIst: clock.stamp,
    };
  }

  function closePos(bar, clock, px, reason) {
    const pnl = pos.side === 'LONG' ? px - pos.entry : pos.entry - px;
    trades.push({
      side: pos.side,
      line: pos.line,
      entryIst: pos.entryIst,
      exitIst: clock.stamp,
      entry: Math.round(pos.entry * 10) / 10,
      exit: Math.round(px * 10) / 10,
      stop: Math.round(pos.stop * 10) / 10,
      target: pos.target == null ? null : Math.round(pos.target * 10) / 10,
      pnl: Math.round(pnl * 10) / 10,
      reason,
    });
    pos = null;
  }

  for (let i = 1; i < dayBars.length; i++) {
    const bar = dayBars[i];
    const prev = dayBars[i - 1];
    const clock = ist(bar.t);
    if (clock.mins < 9 * 60 + 20 || clock.mins > 15 * 60 + 25) continue;

    if (!redZ && bar.c < bar.o) {
      redZ = zone('red', bar.l, bar.h);
      continue;
    }

    let exitedOnTarget = false;
    const lastBar = i === dayBars.length - 1;
    if (pos) {
      if (lastBar) {
        const long = pos.side === 'LONG';
        const stopHit = long ? bar.l <= pos.stop : bar.h >= pos.stop;
        const tgtHit = pos.target != null && (long ? bar.h >= pos.target : bar.l <= pos.target);
        if (stopHit) closePos(bar, clock, pos.stop, 'stop');
        else if (tgtHit) closePos(bar, clock, pos.target, 'median');
        else closePos(bar, clock, bar.c, 'session');
      } else {
        const long = pos.side === 'LONG';
        const stopHit = long ? bar.l <= pos.stop : bar.h >= pos.stop;
        const tgtHit = pos.target != null && (long ? bar.h >= pos.target : bar.l <= pos.target);
        if (stopHit) closePos(bar, clock, pos.stop, 'stop');
        else if (tgtHit) {
          closePos(bar, clock, pos.target, 'median');
          exitedOnTarget = true;
        } else if (pos.target == null) {
          const z = medians().find((x) => x.id === pos.line);
          if (z && (long ? bar.c < z.lo : bar.c > z.hi)) closePos(bar, clock, bar.c, 'back');
        }
      }
    }
    if (!pos && !exitedOnTarget) enter(bar, clock, prev);
    else if (!pos && exitedOnTarget) enter(bar, clock, prev);
  }
  if (pos) {
    const last = dayBars[dayBars.length - 1];
    closePos(last, ist(last.t), last.c, 'session');
  }
  return trades;
}

const bars = load();
const days = new Map();
for (const b of bars) {
  const k = ist(b.t);
  if (k.mins < 9 * 60 + 15 || k.mins > 15 * 60 + 30) continue;
  if (!days.has(k.day)) days.set(k.day, []);
  days.get(k.day).push(b);
}
const keys = [...days.keys()].sort();
const all = [];
let prevClose = null;
for (const day of keys) {
  const dayBars = days.get(day);
  for (const t of dayTrades(dayBars, prevClose)) all.push({ day, ...t });
  prevClose = dayBars[dayBars.length - 1].c;
}

const wins = all.filter((t) => t.pnl > 0);
const pts = all.reduce((s, t) => s + t.pnl, 0);
const byReason = {};
for (const t of all) {
  byReason[t.reason] = byReason[t.reason] || { n: 0, pts: 0 };
  byReason[t.reason].n += 1;
  byReason[t.reason].pts = Math.round((byReason[t.reason].pts + t.pnl) * 10) / 10;
}
const summary = {
  from: keys[0],
  to: keys[keys.length - 1],
  sessions: keys.length,
  trades: all.length,
  wins: wins.length,
  losses: all.length - wins.length,
  winRate: all.length ? Math.round((1000 * wins.length) / all.length) / 10 : 0,
  points: Math.round(pts * 10) / 10,
  inr1Lot: Math.round(pts * 65),
  perWeek: Math.round((all.length / (keys.length / 5)) * 10) / 10,
  byReason,
};
const want = ['2026-11-04', '2026-11-06', '2026-11-11', '2026-08-03'];
const samples = {};
for (const d of want) samples[d] = all.filter((t) => t.day === d);
const reportPath = path.join(ROOT, 'docs', 'backtests', `fib_median_${Date.now()}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, samples, book: all }, null, 2));
console.log(JSON.stringify({ summary, samples }, null, 2));
console.log(`\nWrote ${reportPath}`);
