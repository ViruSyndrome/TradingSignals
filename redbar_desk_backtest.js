/**
 * redbar_desk_backtest.js — Walk-forward backtest for Sagar's Red Bar Futures Desk
 *
 * Mirrors the live 15m desk engine (mark-window Fibs, 1H first-red Trade 1/2,
 * Asia/London/US sweeps, session_continuation, magnet_reaction, >=1.5R ladder)
 * with futures taker fees (0.04%/side).
 *
 * Usage:
 *   node redbar_desk_backtest.js
 *   node redbar_desk_backtest.js BTCUSDT 4000
 *   node redbar_desk_backtest.js PAXGUSDT 4000
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
const BAR_MS = 15 * 60000;
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
  const tpCount = trades.filter((t) => t.exitReason === 'tp1+book').length;
  const emaCount = trades.filter((t) => t.exitReason === 'tp1+ema_cross').length;
  const beCount = trades.filter((t) => t.exitReason === 'tp1+be_stop').length;
  const slCount = trades.filter((t) => t.exitReason === 'stop').length;
  const tsCount = trades.filter((t) => t.exitReason === 'session_end' || t.exitReason === 'tp1+session_end').length;
  console.log(
    `  ${label.padEnd(28)} n=${String(trades.length).padStart(3)}  WR=${winRate.toFixed(1).padStart(5)}%  avg=${(avgPct >= 0 ? '+' : '') + avgPct.toFixed(3)}%  sum=${(sumPct >= 0 ? '+' : '') + sumPct.toFixed(2)}%  medRR=${medRR.toFixed(2)}  (1:1+book=${tpCount} 1:1+ema=${emaCount} 1:1+be=${beCount} stop=${slCount} time=${tsCount})`
  );
  return { n: trades.length, winRate, avgPct, sumPct, medRR };
}

/**
 * Accept live desk ENTER setups that pass engine entryGate + directional confirm candle.
 */
function isActionableEntry(o, curBar, prevBar, emaFast, emaSlow) {
  if (!o || !curBar || !prevBar) return false;
  if (o.actionState !== 'enter') return false;
  if (o.invalidation == null || o.tp1 == null || o.bookZone == null || !(o.rr >= 1.5)) return false;
  if (!ACTIONABLE.includes(o.setupKind)) return false;

  const isBull = o.trend === 'bullish';
  const dirCandle = isBull
    ? (curBar.c > curBar.o && curBar.c > prevBar.c)
    : (curBar.c < curBar.o && curBar.c < prevBar.c);
  if (!dirCandle) return false;

  if (o.setupKind === 'trade1_departure') {
    const red = o.firstRed1h;
    if (!red) return false;
    const emaAligned = emaFast != null && emaSlow != null
      ? (isBull ? emaFast >= emaSlow : emaFast <= emaSlow)
      : true;
    if (!emaAligned) return false;
  }

  return true;
}

function runSimulation(bars15, bars1h, cfg, { maxHoldBars = 48 } = {}) {
  const WARM = 48 * 4; // ~2 days of 15m
  const closes = bars15.map((b) => b.c);
  const ema10 = calcEma(closes, 10);
  const ema30 = calcEma(closes, 30);
  const trades = [];
  let pos = null;
  let lastTradeDay = null;
  let tradesToday = 0;

  for (let i = WARM; i < bars15.length; i++) {
    const bar = bars15[i];

    if (pos) {
      const isLong = pos.side === 'LONG';
      const legRet = (exitPx) => (isLong ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry) - 2 * FEE_PER_SIDE;

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
          });
          pos = null;
        } else if (hitTp1) {
          pos.banked50 = true;
          pos.half1Ret = legRet(pos.tp1);
          // Move stop to BE (+ tiny fee cushion) after 1:1
          const bePad = pos.entry * 0.001;
          pos.activeStop = isLong ? pos.entry + bePad : pos.entry - bePad;
        }
      } else {
        const hitBeStop = isLong ? bar.l <= pos.activeStop : bar.h >= pos.activeStop;
        const hitStretch = isLong ? bar.h >= pos.exit : bar.l <= pos.exit;
        const emaCrossAgainst = ema10[i] != null && ema30[i] != null && ema10[i - 1] != null && ema30[i - 1] != null
          ? (isLong
            ? (ema10[i - 1] >= ema30[i - 1] && ema10[i] < ema30[i])
            : (ema10[i - 1] <= ema30[i - 1] && ema10[i] > ema30[i]))
          : false;

        if (hitStretch || hitBeStop || emaCrossAgainst) {
          const runnerExitPx = hitStretch ? pos.exit : hitBeStop ? pos.activeStop : bar.c;
          const runnerReason = hitStretch ? 'tp1+book' : hitBeStop ? 'tp1+be_stop' : 'tp1+ema_cross';
          trades.push({
            ...pos,
            exitPx: runnerExitPx,
            exitT: bar.t,
            exitReason: runnerReason,
            pnlPct: (0.5 * pos.half1Ret + 0.5 * legRet(runnerExitPx)) * 100,
            barsHeld: i - pos.entryIdx,
          });
          pos = null;
        }
      }

      if (pos && (i - pos.entryIdx) >= maxHoldBars) {
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
        });
        pos = null;
      }
    }

    if (pos) continue;

    const asOf = bar.t + BAR_MS - 1000; // near bar close
    const calDay = RedBarTrend.dayKey(bar.t, cfg.dayMode || 'ist');
    if (calDay !== lastTradeDay) {
      lastTradeDay = calDay;
      tradesToday = 0;
    }
    if (tradesToday >= 2) continue;

    const h1 = bars1h.filter((x) => x.t + 3600000 <= asOf);
    const firstRed1h = RedBarTrend.firstRedBarOfSession(h1, calDay, {
      ...cfg,
      asOfTs: asOf,
      barMs: 3600000,
    });

    const slice = bars15.slice(Math.max(0, i - 96 * 10), i + 1);
    const o = RedBarTrend.readAt(slice, slice.length - 1, {
      ...cfg,
      asOfTs: asOf,
      firstRed1h,
      bars1h: h1,
    });
    if (!isActionableEntry(o, bar, bars15[i - 1], ema10[i], ema30[i])) continue;

    const side = o.trend === 'bullish' ? 'LONG' : 'SHORT';
    const okLevels = side === 'LONG'
      ? (o.invalidation < bar.c && o.bookZone > bar.c)
      : (o.invalidation > bar.c && o.bookZone < bar.c);
    if (!okLevels) continue;

    const sess = minsSinceSessionOpen(asOf);
    const oneR = Math.abs(bar.c - o.invalidation);
    const tp1 = side === 'LONG' ? bar.c + oneR : bar.c - oneR;
    pos = {
      side,
      setupKind: o.setupKind,
      clockId: o.playbook?.clock?.id || sess.phase,
      minsOpen: sess.minsOpen,
      earlyOpen45: sess.minsOpen != null && sess.minsOpen < 45,
      entry: bar.c,
      stop: o.invalidation,
      activeStop: o.invalidation,
      tp1,
      banked50: false,
      half1Ret: 0,
      exit: o.bookZone,
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

  console.log(`Fetching ${SYMBOL} 15m (${TARGET_BARS} bars) + 1h candles...`);
  const bars15 = await fetchKlines(SYMBOL, '15m', TARGET_BARS);
  const bars1h = await fetchKlines(SYMBOL, '1h', Math.max(400, Math.ceil(TARGET_BARS / 4) + 80));

  let result = null;
  if (!liveOnly) {
    const fromDate = new Date(bars15[0].t).toISOString().slice(0, 10);
    const toDate = new Date(bars15[bars15.length - 1].t).toISOString().slice(0, 10);
    console.log(`\n=== Red Bar Futures Desk Walk-Forward Backtest: ${SYMBOL} 15m (${fromDate} -> ${toDate}) ===`);
    console.log(`Fee model: ${(FEE_PER_SIDE * 200).toFixed(2)}% round-trip taker · Swing Stop · 50% TP at 1:1 + 50% Runner Trail till EMA 10/30 cross\n`);

    const trades = runSimulation(bars15, bars1h, cfg);
    const all = summarize('ALL TRADES', trades);
    summarize('LONG', trades.filter((t) => t.side === 'LONG'));
    summarize('SHORT', trades.filter((t) => t.side === 'SHORT'));

    const mid = Math.floor(trades.length / 2);
    console.log('\n--- Walk-Forward Split (Older Half vs Newer Unseen Half) ---');
    const h1 = summarize('First Half (Train)', trades.slice(0, mid));
    const h2 = summarize('Second Half (Out-of-Sample)', trades.slice(mid));

    console.log('\n--- By Setup Type ---');
    for (const kind of REPORT_SETUPS) {
      const sub = trades.filter((t) => t.setupKind === kind);
      if (sub.length) summarize(kind, sub);
      else console.log(`  ${kind}: n=0`);
    }

    console.log('\n--- By Clock Phase ---');
    for (const phase of ['pre_london', 'london', 'us_open', 'late']) {
      const sub = trades.filter((t) => t.clockId === phase);
      if (sub.length) summarize(phase, sub);
    }

    console.log('\n--- London / US first 45 min vs rest ---');
    const lonEarly = trades.filter((t) => t.clockId === 'london' && t.earlyOpen45);
    const lonRest = trades.filter((t) => t.clockId === 'london' && !t.earlyOpen45);
    const usEarly = trades.filter((t) => t.clockId === 'us_open' && t.earlyOpen45);
    const usRest = trades.filter((t) => t.clockId === 'us_open' && !t.earlyOpen45);
    summarize('London first 45m', lonEarly);
    summarize('London after 45m', lonRest);
    summarize('US first 45m', usEarly);
    summarize('US after 45m', usRest);

    const passBoth = h1.sumPct > 0 && h2.sumPct > 0;
    console.log(`\nWalk-Forward Verdict: ${passBoth ? 'PASS (Both halves positive after fees)' : 'MIXED / FAIL — see breakdown'}`);

    result = { all, h1, h2, trades };
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
      n: result.all.n,
      sumPct: result.all.sumPct,
      winRate: result.all.winRate,
      trainSum: result.h1.sumPct,
      oosSum: result.h2.sumPct,
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
