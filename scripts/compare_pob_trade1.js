/**
 * OBSOLETE / INVALID A/B — do not use for Dr. Dev POB conclusions.
 *
 * Gating Trade 1 leave with POB is a tautology: leaving below the 1H first-red
 * low already implies price passed through POB mid. Expect Δ≈0 forever.
 *
 * Correct POB research: node scripts/research_pob_reject.js (NIFTY 5m SHORT).
 *
 *   node scripts/compare_pob_trade1.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache_binance_um');
const FEE_PER_SIDE = 0.0004;
const BAR_MS_5 = 5 * 60000;
const BAR_MS_15 = 15 * 60000;

function loadTf(tf, startYm = '2025-10', endYm = '2026-09') {
  const files = fs.readdirSync(CACHE)
    .filter((f) => f.startsWith(`BTCUSDT_${tf}_`) && f.endsWith('.json'))
    .sort()
    .filter((f) => {
      const ym = f.slice(`BTCUSDT_${tf}_`.length, -5);
      return ym >= startYm && ym <= endYm;
    });
  const bars = [];
  const seen = new Set();
  for (const f of files) {
    for (const b of JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'))) {
      const bar = b.t != null ? b : { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      if (seen.has(bar.t)) continue;
      seen.add(bar.t);
      bars.push(bar);
    }
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function lastClosedIdx(bars, asOf, ms) {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + ms <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function seasonOf(ts) {
  const day = RedBarTrend.zonedHms(ts, 'Asia/Kolkata').day;
  const m = parseInt(String(day).slice(5, 7), 10);
  if (m <= 3) return 'JAN–MAR';
  if (m <= 8) return 'APR–AUG';
  return 'SEP–DEC';
}

function summarize(label, trades) {
  if (!trades.length) {
    console.log(`${label}: n=0`);
    return { n: 0, wr: 0, sum: 0, avg: 0 };
  }
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const sum = trades.reduce((s, t) => s + t.pnlPct, 0);
  const wr = (wins / trades.length) * 100;
  const avg = sum / trades.length;
  const mid = Math.floor(trades.length / 2);
  const train = trades.slice(0, mid).reduce((s, t) => s + t.pnlPct, 0);
  const oos = trades.slice(mid).reduce((s, t) => s + t.pnlPct, 0);
  console.log(
    `${label}: n=${trades.length} WR=${wr.toFixed(1)}% sum=${sum.toFixed(2)}% avg=${avg.toFixed(3)}% `
    + `Train=${train >= 0 ? '+' : ''}${train.toFixed(2)}% OOS=${oos >= 0 ? '+' : ''}${oos.toFixed(2)}%`,
  );
  return { n: trades.length, wr, sum, avg, train, oos };
}

function runTrade1Book(bars15, bars1h, bars5m, cfg) {
  const WARM = 48 * 12;
  const trades = [];
  let pos = null;
  let lastTradeDay = null;
  let tradesToday = 0;

  for (let i = WARM; i < bars5m.length; i++) {
    const bar = bars5m[i];
    const asOf = bar.t + BAR_MS_5 - 1000;

    // Manage open trades on every 5m bar
    if (pos) {
      const isLong = pos.side === 'LONG';
      const legRet = (exitPx) => (
        (isLong ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry) - 2 * FEE_PER_SIDE
      );
      if (!pos.banked50) {
        const hitStop = isLong ? bar.l <= pos.activeStop : bar.h >= pos.activeStop;
        const hitTp1 = isLong ? bar.h >= pos.tp1 : bar.l <= pos.tp1;
        if (hitStop) {
          trades.push({
            ...pos,
            exitReason: 'stop',
            pnlPct: legRet(pos.activeStop) * 100,
            season: seasonOf(pos.entryT),
          });
          pos = null;
        } else if (hitTp1) {
          pos.banked50 = true;
          pos.half1Ret = legRet(pos.tp1);
          const bePad = pos.entry * 0.001;
          pos.activeStop = isLong ? pos.entry + bePad : pos.entry - bePad;
        }
      } else {
        const hitBe = isLong ? bar.l <= pos.activeStop : bar.h >= pos.activeStop;
        const hitTp3 = isLong ? bar.h >= pos.exit : bar.l <= pos.exit;
        if (pos.tp2 != null && !pos.trailedAt2) {
          const hitTp2 = isLong ? bar.h >= pos.tp2 : bar.l <= pos.tp2;
          if (hitTp2) {
            pos.trailedAt2 = true;
            pos.activeStop = pos.tp1;
          }
        }
        if (hitTp3 || hitBe) {
          const px = hitTp3 ? pos.exit : pos.activeStop;
          trades.push({
            ...pos,
            exitReason: hitTp3 ? 'tp1+tp3' : (pos.trailedAt2 ? 'tp1+trail' : 'tp1+be'),
            pnlPct: (0.5 * pos.half1Ret + 0.5 * legRet(px)) * 100,
            season: seasonOf(pos.entryT),
          });
          pos = null;
        }
      }
      if (pos && (i - pos.entryIdx) >= 144) {
        const px = bar.c;
        trades.push({
          ...pos,
          exitReason: 'time',
          pnlPct: pos.banked50
            ? (0.5 * pos.half1Ret + 0.5 * legRet(px)) * 100
            : legRet(px) * 100,
          season: seasonOf(pos.entryT),
        });
        pos = null;
      }
    }
    if (pos) continue;

    // New entries only on 15m boundaries (desk working TF) — 3× faster, same signals
    const z = RedBarTrend.zonedHms(bar.t, 'Asia/Kolkata');
    if (z.minute % 15 !== 0) continue;

    const calDay = RedBarTrend.dayKey(bar.t, cfg.dayMode || 'ist');
    if (calDay !== lastTradeDay) {
      lastTradeDay = calDay;
      tradesToday = 0;
    }
    if (tradesToday >= 2) continue;

    const i15 = lastClosedIdx(bars15, asOf, BAR_MS_15);
    if (i15 < 40) continue;
    const slice15 = bars15.slice(Math.max(0, i15 - 480), i15 + 1);
    const i1h = lastClosedIdx(bars1h, asOf, 3600000);
    const h1 = i1h < 0 ? [] : bars1h.slice(Math.max(0, i1h - 80), i1h + 1);
    const firstRed1h = RedBarTrend.firstRedBarOfSession(h1, calDay, {
      ...cfg,
      asOfTs: asOf,
      barMs: 3600000,
    });
    const m5 = bars5m.slice(Math.max(0, i - 599), i + 1);

    const o = RedBarTrend.readAt(slice15, slice15.length - 1, {
      ...cfg,
      asOfTs: asOf,
      firstRed1h,
      bars1h: h1,
      bars5m: m5,
    });
    if (!o || o.actionState !== 'enter' || o.setupKind !== 'trade1_departure') continue;
    if (o.invalidation == null || !(o.rr >= 1)) continue;
    if (o.trend !== 'bullish' && o.trend !== 'bearish') continue;

    const side = o.trend === 'bullish' ? 'LONG' : 'SHORT';
    const ok = side === 'LONG'
      ? (o.invalidation < bar.c && (o.bookZone == null || o.bookZone > bar.c))
      : (o.invalidation > bar.c && (o.bookZone == null || o.bookZone < bar.c));
    if (!ok) continue;

    const oneR = Math.abs(bar.c - o.invalidation);
    const tp1 = side === 'LONG' ? bar.c + oneR : bar.c - oneR;
    const tp2 = side === 'LONG' ? bar.c + oneR * 2 : bar.c - oneR * 2;
    const tp3 = side === 'LONG' ? bar.c + oneR * 3 : bar.c - oneR * 3;
    pos = {
      side,
      setupKind: 'trade1_departure',
      pobStatus: o.pobStatus || o.playbook?.redSetup?.pobStatus || null,
      entry: bar.c,
      stop: o.invalidation,
      activeStop: o.invalidation,
      tp1,
      tp2,
      exit: o.tp3 ?? tp3,
      banked50: false,
      trailedAt2: false,
      half1Ret: 0,
      rr: o.rr,
      entryIdx: i,
      entryT: bar.t,
      day: calDay,
    };
    tradesToday++;
  }
  return trades;
}

(async () => {
  const inst = CONFIG.rangeEma.instruments.find((x) => x.id === 'BTC');
  const cfg = {
    id: 'BTC',
    instrumentId: 'BTC',
    lookbackDays: 90,
    touchPct: 0.15,
    dayMode: inst.dayMode || 'ist',
    bandStyle: inst.bandStyle || 'sessionFib',
    markWindow: inst.markWindow,
    fibLevels: inst.fibLevels || [0, 0.44, 0.5, 0.56, 1],
    sessions: inst.sessions || [],
  };

  console.log('Loading BTCUSDT futures cache…');
  const bars15 = loadTf('15m');
  const bars5 = loadTf('5m');
  const bars1h = loadTf('1h');
  console.log(
    `Bars 15m=${bars15.length} 5m=${bars5.length} 1h=${bars1h.length} · `
    + `${new Date(bars15[0].t).toISOString().slice(0, 10)} → ${new Date(bars15[bars15.length - 1].t).toISOString().slice(0, 10)}`,
  );

  const origGate = RedBarTrend.entryGate.bind(RedBarTrend);

  console.log('\n=== A) Trade 1 ONLY — POB gate ON (live desk) ===');
  RedBarTrend.entryGate = origGate;
  const on = runTrade1Book(bars15, bars1h, bars5, cfg);
  const sumOn = summarize('POB ON', on);

  console.log('\n=== B) Trade 1 ONLY — POB gate OFF (legacy leave-only) ===');
  RedBarTrend.entryGate = (args) => origGate({
    ...args,
    pobRejectedBearish: true,
    pobRejectedBullish: true,
    pobRetested: true,
    pobStatus: 'forced_pass',
  });
  const off = runTrade1Book(bars15, bars1h, bars5, cfg);
  const sumOff = summarize('POB OFF', off);
  RedBarTrend.entryGate = origGate;

  console.log('\n=== Delta ===');
  console.log(
    `ENTERs: ON ${sumOn.n} vs OFF ${sumOff.n} (Δ ${sumOn.n - sumOff.n}) · `
    + `Sum PnL: ON ${sumOn.sum.toFixed(2)}% vs OFF ${sumOff.sum.toFixed(2)}% · `
    + `OOS: ON ${sumOn.oos?.toFixed(2) ?? '—'}% vs OFF ${sumOff.oos?.toFixed(2) ?? '—'}%`,
  );
  const verdict = sumOn.n === 0 && sumOff.n === 0
    ? 'NO TRADE 1 SAMPLES — widen cache / check first-red wiring'
    : (sumOn.oos > 0 && sumOn.train > 0 && (sumOff.n === 0 || sumOn.oos >= sumOff.oos * 0.5)
      ? 'POB ON looks acceptable on this window'
      : 'POB ON not clearly better — review before trusting as DNA upgrade');
  console.log(`Verdict: ${verdict}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
