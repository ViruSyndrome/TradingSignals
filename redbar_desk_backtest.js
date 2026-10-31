/**
 * redbar_desk_backtest.js — Walk-forward backtest for Sagar's Red Bar Futures Desk
 *
 * Mirrors the live desk (1H first-red median/Fibs, Trade 2 = 5m close vs median,
 * 5m swing SL, 1:1→BE→1:2 trail→1:3 TP, session sweeps) + futures taker fees.
 *
 * Sagar: BTC behaves differently by season — always report Jan–Mar / Apr–Aug / post-Sep.
 *
 * Usage:
 *   node redbar_desk_backtest.js
 *   node redbar_desk_backtest.js BTCUSDT 35000
 *   node redbar_desk_backtest.js PAXGUSDT 35000
 *   node redbar_desk_backtest.js --live
 */
'use strict';

const https = require('https');
const RedBarTrend = require('./js/redbar_trend.js');
const CONFIG = require('./js/config.js');

const args = process.argv.slice(2);
const showLive = args.includes('--live') || args.includes('--live-only');
const liveOnly = args.includes('--live-only');
const posArgs = args.filter((a) => !a.startsWith('--'));
const SYMBOL = posArgs[0] || 'BTCUSDT';
const TARGET_BARS = Number(posArgs[1]) || (liveOnly ? 480 : 4000);
const FEE_PER_SIDE = 0.0004; // 0.04% Binance USD-M Futures taker fee
const BAR_MS_15 = 15 * 60000;
const BAR_MS_5 = 5 * 60000;
const ACTIONABLE = [
  'trade1_departure',
  'trade2_confirmed',
  'session_sweep',
];
// Demoted setups still reported if the engine emits them as ENTER under older gates
const REPORT_SETUPS = [...ACTIONABLE, 'session_continuation', 'magnet_reaction'];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.code) reject(new Error(JSON.stringify(parsed)));
            else resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function fetchKlines(symbol, interval, targetBars) {
  const out = [];
  let endTime;
  while (out.length < targetBars) {
    const limit = Math.min(1000, targetBars - out.length + 5);
    let url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const batch = await getJson(url);
    if (!Array.isArray(batch) || !batch.length) break;
    out.unshift(...batch);
    endTime = batch[0][0] - 1;
    if (batch.length < limit) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  const byTs = new Map();
  for (const k of out) byTs.set(k[0], k);
  return [...byTs.values()]
    .sort((a, b) => a[0] - b[0])
    .slice(-targetBars)
    .map((k) => ({
      t: +k[0],
      o: +k[1],
      h: +k[2],
      l: +k[3],
      c: +k[4],
    }));
}

function calcEma(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Minutes since London (12:30 IST) or US (16:30 IST) open; null if outside that session. */
function minsSinceSessionOpen(ts) {
  const z = RedBarTrend.zonedHms(ts, 'Asia/Kolkata');
  const mins = z.hour * 60 + z.minute;
  if (mins >= 12 * 60 + 30 && mins < 16 * 60 + 30) {
    return { phase: 'london', minsOpen: mins - (12 * 60 + 30) };
  }
  if (mins >= 16 * 60 + 30 && mins < 19 * 60) {
    return { phase: 'us_open', minsOpen: mins - (16 * 60 + 30) };
  }
  const clock = RedBarTrend.istClockPhase(ts);
  return { phase: clock.id, minsOpen: null };
}

/** Sagar seasonal buckets for BTC (IST calendar month of entry). */
function seasonOf(ts) {
  const day = RedBarTrend.zonedHms(ts, 'Asia/Kolkata').day; // YYYY-MM-DD
  const m = parseInt(String(day).slice(5, 7), 10);
  if (m >= 1 && m <= 3) return 'JAN–MAR';
  if (m >= 4 && m <= 8) return 'APR–AUG';
  return 'SEP–DEC'; // post-September
}

/** Last index with close time <= asOf (bars sorted ascending), or -1. */
function lastClosedIdx(bars, asOf, barMs) {
  if (!bars || !bars.length) return -1;
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

function summarize(label, trades) {
  if (!trades.length) {
    console.log(`  ${label}: n=0`);
    return { n: 0, winRate: 0, avgPct: 0, sumPct: 0, medRR: 0 };
  }
  const wins = trades.filter((t) => t.pnlPct > 0);
  const sumPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgPct = sumPct / trades.length;
  const winRate = (wins.length / trades.length) * 100;
  const rrs = trades.map((t) => t.rr).filter(Number.isFinite).sort((a, b) => a - b);
  const medRR = rrs.length ? rrs[rrs.length >> 1] : 0;
  const tpCount = trades.filter((t) => t.exitReason === 'tp1+book' || t.exitReason === 'tp1+tp3').length;
  const tp2Count = trades.filter((t) => t.exitReason === 'tp1+trail_1_2').length;
  const emaCount = trades.filter((t) => t.exitReason === 'tp1+ema_cross').length;
  const beCount = trades.filter((t) => t.exitReason === 'tp1+be_stop').length;
  const slCount = trades.filter((t) => t.exitReason === 'stop').length;
  const tsCount = trades.filter((t) => t.exitReason === 'session_end' || t.exitReason === 'tp1+session_end').length;
  console.log(
    `  ${label.padEnd(28)} n=${String(trades.length).padStart(3)}  WR=${winRate.toFixed(1).padStart(5)}%  avg=${(avgPct >= 0 ? '+' : '') + avgPct.toFixed(3)}%  sum=${(sumPct >= 0 ? '+' : '') + sumPct.toFixed(2)}%  medRR=${medRR.toFixed(2)}  (1:3=${tpCount} trail1:2=${tp2Count} ema=${emaCount} be=${beCount} stop=${slCount} time=${tsCount})`
  );
  return { n: trades.length, winRate, avgPct, sumPct, medRR };
}

/**
 * Match live desk entryGate: actionState=enter + actionable setup + valid levels.
 * No extra EMA / direction-candle filters (those skewed Trade 1 to n=0).
 */
function isActionableEntry(o, allowSetups = null) {
  if (!o) return false;
  if (o.actionState !== 'enter') return false;
  if (o.invalidation == null || o.tp1 == null || o.bookZone == null || !(o.rr >= 1.0)) return false;
  if (!ACTIONABLE.includes(o.setupKind)) return false;
  if (Array.isArray(allowSetups) && allowSetups.length && !allowSetups.includes(o.setupKind)) return false;
  if (o.trend !== 'bullish' && o.trend !== 'bearish') return false;
  return true;
}

/**
 * Simulate on 5m closes (desk Trade 2 timing) with 15m context for mark-window / structure.
 * allowSetups: null = combined book; else only those setupKinds may enter (isolated book).
 */
function runSimulation(bars15, bars1h, bars5m, cfg, {
  maxHoldBars5 = 144, // ~12h on 5m
  allowSetups = null,
} = {}) {
  const has5m = Array.isArray(bars5m) && bars5m.length > 0;
  if (!has5m) {
    console.warn('[backtest] No 5m bars — cannot align with desk entry timing');
    return [];
  }
  const WARM = 48 * 12; // ~2 days of 5m
  const trades = [];
  let pos = null;
  let lastTradeDay = null;
  let tradesToday = 0;

  for (let i = WARM; i < bars5m.length; i++) {
    const bar = bars5m[i];
    const asOf = bar.t + BAR_MS_5 - 1000;

    if (pos) {
      const isLong = pos.side === 'LONG';
      const legRet = (exitPx) => (isLong ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry) - 2 * FEE_PER_SIDE;
      const ladder = !!pos.rrLadder;

      if (!pos.banked50) {
        const hitStop = isLong ? bar.l <= pos.activeStop : bar.h >= pos.activeStop;
        const hitTp1 = isLong ? bar.h >= pos.tp1 : bar.l <= pos.tp1;
        if (hitStop) {
          trades.push({
            ...pos,
            exitPx: pos.activeStop,
            exitT: bar.t,
            exitReason: 'stop',
            pnlPct: legRet(pos.activeStop) * 100,
            barsHeld: i - pos.entryIdx,
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
        const hitBeStop = isLong ? bar.l <= pos.activeStop : bar.h >= pos.activeStop;
        const hitTp3 = isLong ? bar.h >= pos.exit : bar.l <= pos.exit;
        if (ladder && pos.tp2 != null && !pos.trailedAt2) {
          const hitTp2 = isLong ? bar.h >= pos.tp2 : bar.l <= pos.tp2;
          if (hitTp2) {
            pos.trailedAt2 = true;
            pos.activeStop = pos.tp1;
          }
        }

        if (hitTp3 || hitBeStop) {
          const runnerExitPx = hitTp3 ? pos.exit : pos.activeStop;
          const runnerReason = hitTp3
            ? (ladder ? 'tp1+tp3' : 'tp1+book')
            : (pos.trailedAt2 ? 'tp1+trail_1_2' : 'tp1+be_stop');
          trades.push({
            ...pos,
            exitPx: runnerExitPx,
            exitT: bar.t,
            exitReason: runnerReason,
            pnlPct: (0.5 * pos.half1Ret + 0.5 * legRet(runnerExitPx)) * 100,
            barsHeld: i - pos.entryIdx,
            season: seasonOf(pos.entryT),
          });
          pos = null;
        }
      }

      if (pos && (i - pos.entryIdx) >= maxHoldBars5) {
        const exitPx = bar.c;
        const pnlPct = pos.banked50
          ? (0.5 * pos.half1Ret + 0.5 * legRet(exitPx)) * 100
          : legRet(exitPx) * 100;
        trades.push({
          ...pos,
          exitPx,
          exitT: bar.t,
          exitReason: pos.banked50 ? 'tp1+session_end' : 'session_end',
          pnlPct,
          barsHeld: i - pos.entryIdx,
          season: seasonOf(pos.entryT),
        });
        pos = null;
      }
    }

    if (pos) continue;

    const calDay = RedBarTrend.dayKey(bar.t, cfg.dayMode || 'ist');
    if (calDay !== lastTradeDay) {
      lastTradeDay = calDay;
      tradesToday = 0;
    }
    if (tradesToday >= 2) continue;

    // 15m context up to this 5m close (desk working TF)
    const i15 = lastClosedIdx(bars15, asOf, BAR_MS_15);
    if (i15 < 40) continue;
    const slice15 = bars15.slice(Math.max(0, i15 - 96 * 10), i15 + 1);

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
    if (!isActionableEntry(o, allowSetups)) continue;

    const side = o.trend === 'bullish' ? 'LONG' : 'SHORT';
    const okLevels = side === 'LONG'
      ? (o.invalidation < bar.c && o.bookZone > bar.c)
      : (o.invalidation > bar.c && o.bookZone < bar.c);
    if (!okLevels) continue;

    const sess = minsSinceSessionOpen(asOf);
    const oneR = Math.abs(bar.c - o.invalidation);
    const tp1 = side === 'LONG' ? bar.c + oneR : bar.c - oneR;
    const tp2 = side === 'LONG' ? bar.c + oneR * 2 : bar.c - oneR * 2;
    const tp3 = side === 'LONG' ? bar.c + oneR * 3 : bar.c - oneR * 3;
    const useLadder = o.setupKind === 'trade2_confirmed'
      || o.setupKind === 'trade1_departure'
      || !!o.rrLadder;
    const redSetup = o.playbook?.redSetup || null;
    pos = {
      side,
      setupKind: o.setupKind,
      clockId: o.playbook?.clock?.id || sess.phase,
      minsOpen: sess.minsOpen,
      earlyOpen45: sess.minsOpen != null && sess.minsOpen < 45,
      revisitRead: redSetup?.revisitRead || null,
      stopReason: o.invalidationReason || null,
      stopPct: o.stopPct != null ? o.stopPct : null,
      entry: bar.c,
      stop: o.invalidation,
      activeStop: o.invalidation,
      tp1,
      tp2: useLadder ? (o.tp2 ?? tp2) : null,
      banked50: false,
      trailedAt2: false,
      half1Ret: 0,
      exit: useLadder ? (o.tp3 ?? tp3) : o.bookZone,
      rr: o.rr,
      rrLadder: useLadder,
      entryIdx: i,
      entryT: bar.t,
      day: calDay,
      season: seasonOf(bar.t),
    };
    tradesToday++;
  }

  return trades;
}

(async () => {
  const inst = (CONFIG.rangeEma?.instruments || []).find((x) => x.symbol === SYMBOL || x.fallbackSymbol === SYMBOL)
    || CONFIG.rangeEma?.instruments?.[0]
    || {
      symbol: SYMBOL,
      dayMode: 'ist',
      bandStyle: 'sessionFib',
      markWindow: { timeZone: 'Asia/Kolkata', startHour: 2, startMinute: 30, endHour: 3, endMinute: 30 },
      fibLevels: [0, 0.44, 0.5, 0.56, 1],
      sessions: [],
    };

  const cfg = {
    lookbackDays: 90,
    touchPct: 0.15,
    chartBandDays: 7,
    dayMode: inst.dayMode || 'ist',
    bandStyle: inst.bandStyle || 'sessionFib',
    markWindow: inst.markWindow,
    fibLevels: inst.fibLevels || [0, 0.44, 0.5, 0.56, 1],
    sessions: inst.sessions || [],
  };

  // ~3× 15m coverage in 5m; allow multi-year samples (was capped at 30k ≈ 104d)
  const bars5Target = Math.min(TARGET_BARS * 3 + 200, 220000);
  console.log(`Fetching ${SYMBOL} 15m (${TARGET_BARS}) + 1h + 5m (~${bars5Target})...`);
  const bars15 = await fetchKlines(SYMBOL, '15m', TARGET_BARS);
  const bars1h = await fetchKlines(SYMBOL, '1h', Math.max(400, Math.ceil(TARGET_BARS / 4) + 80));
  const bars5m = await fetchKlines(SYMBOL, '5m', bars5Target);
  console.log(`Loaded 15m=${bars15.length} 1h=${bars1h.length} 5m=${bars5m.length}`);

  let result = null;
  if (!liveOnly) {
    const fromDate = new Date(bars15[0].t).toISOString().slice(0, 10);
    const toDate = new Date(bars15[bars15.length - 1].t).toISOString().slice(0, 10);
    console.log(`\n=== Red Bar Futures Desk Backtest: ${SYMBOL} (5m entries · 15m context) ${fromDate} -> ${toDate} ===`);
    console.log(`Fee ${(FEE_PER_SIDE * 200).toFixed(2)}% RT · Trade1 leave / Trade2 H1→M5 sweep · SL wick/5m swing · 1:1→BE→1:2→1:3`);
    console.log(`Live-aligned gate (no extra EMA) · Trade 1 priority over Trade 2\n`);

    console.log('--- Book A: COMBINED (path-dependent, max 2/day) ---');
    const trades = runSimulation(bars15, bars1h, bars5m, cfg);
    const all = summarize('COMBINED', trades);
    summarize('  LONG', trades.filter((t) => t.side === 'LONG'));
    summarize('  SHORT', trades.filter((t) => t.side === 'SHORT'));

    console.log('\n--- Book B: TRADE 1 ONLY (isolated) ---');
    const t1Only = runSimulation(bars15, bars1h, bars5m, cfg, {
      allowSetups: ['trade1_departure'],
    });
    const bookT1 = summarize('TRADE 1 ONLY', t1Only);

    console.log('\n--- Book C: TRADE 2 ONLY (isolated) ---');
    const t2Only = runSimulation(bars15, bars1h, bars5m, cfg, {
      allowSetups: ['trade2_confirmed'],
    });
    const bookT2 = summarize('TRADE 2 ONLY', t2Only);

    const mid = Math.floor(trades.length / 2);
    console.log('\n--- Combined Walk-Forward Split ---');
    const h1 = summarize('First Half (Train)', trades.slice(0, mid));
    const h2 = summarize('Second Half (Out-of-Sample)', trades.slice(mid));

    console.log('\n--- Combined By Season ---');
    const bySeason = {};
    for (const s of ['JAN–MAR', 'APR–AUG', 'SEP–DEC']) {
      const sub = trades.filter((t) => (t.season || seasonOf(t.entryT)) === s);
      bySeason[s] = summarize(s, sub);
    }

    console.log('\n--- Combined By Setup (path mix) ---');
    for (const kind of REPORT_SETUPS) {
      const sub = trades.filter((t) => t.setupKind === kind);
      if (sub.length) summarize(kind, sub);
      else console.log(`  ${kind}: n=0`);
    }

    console.log('\n--- Combined By Clock Phase ---');
    for (const phase of ['pre_london', 'london', 'us_open', 'late']) {
      const sub = trades.filter((t) => t.clockId === phase);
      if (sub.length) summarize(phase, sub);
    }

    const passBoth = h1.sumPct > 0 && h2.sumPct > 0;
    console.log(`\nWalk-Forward Verdict (combined): ${passBoth ? 'PASS (Both halves positive after fees)' : 'MIXED / FAIL — see breakdown'}`);
    console.log(`Isolated books: Trade1 sum=${bookT1.sumPct.toFixed(2)}% (n=${bookT1.n}) · Trade2 sum=${bookT2.sumPct.toFixed(2)}% (n=${bookT2.n})`);

    result = { all, h1, h2, trades, bySeason, bookT1, bookT2, t1Only, t2Only };
  }

  if (showLive) {
    const lastBar = bars15[bars15.length - 1];
    const calDay = RedBarTrend.dayKey(lastBar.t, cfg.dayMode);
    const firstRed1h = RedBarTrend.firstRedBarOfSession(bars1h, calDay, {
      ...cfg,
      asOfTs: Date.now(),
      barMs: 3600000,
    });
    const readout = RedBarTrend.read(bars15, { ...cfg, firstRed1h, bars1h });
    console.log('\n--- Current Live Red Bar Futures Readout ---');
    console.log(JSON.stringify({
      symbol: SYMBOL,
      price: readout.price,
      trend: readout.trend,
      setupKind: readout.setupKind,
      actionState: readout.actionState,
      actionReason: readout.actionReason,
      invalidation: readout.invalidation,
      bookZone: readout.bookZone,
      rr: readout.rr,
      clock: readout.playbook?.clock,
      renko: readout.renko && {
        dir: readout.renko.dir,
        run: readout.renko.bricksInRun,
        fresh: readout.renko.freshBrick,
      },
    }, null, 2));
  }

  // Machine-readable summary for tuning scripts
  if (result) {
    const bySetup = {};
    for (const kind of REPORT_SETUPS) {
      const sub = result.trades.filter((t) => t.setupKind === kind);
      bySetup[kind] = {
        n: sub.length,
        sumPct: sub.reduce((s, t) => s + t.pnlPct, 0),
        winRate: sub.length ? (sub.filter((t) => t.pnlPct > 0).length / sub.length) * 100 : 0,
      };
    }
    const earlyBleed = result.trades.filter((t) => t.earlyOpen45);
    console.log('\n--- JSON_SUMMARY ---');
    console.log(JSON.stringify({
      symbol: SYMBOL,
      combined: { n: result.all.n, sumPct: result.all.sumPct, winRate: result.all.winRate },
      trade1Only: result.bookT1,
      trade2Only: result.bookT2,
      trainSum: result.h1.sumPct,
      oosSum: result.h2.sumPct,
      bySeason: result.bySeason,
      bySetup,
      earlyOpen45: {
        n: earlyBleed.length,
        sumPct: earlyBleed.reduce((s, t) => s + t.pnlPct, 0),
      },
    }));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
