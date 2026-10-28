/**
 * Live-wiring regression for Red Bar Gate 7 + mid-15m 5m triggers.
 *
 * Covers the five bugs that DNA/outcomes (closed-bar) never caught:
 *   1. entryPrice must be trigger close, livePrice = tip (favR chase)
 *   2. mid-15m asOfTs must see closed 5m confirms
 *   3. Trade 1 / session_sweep must carry triggerTs (20m expiry)
 *   4. (BTC-only) one-open skip is asserted via bot.js source contract
 *   5. relay/scanner share trigBucket — asserted via bot.js source contract
 *
 * Usage:
 *   node scripts/redbar_live_wiring_test.js
 *   node scripts/redbar_live_wiring_test.js NIFTY
 *   node scripts/redbar_live_wiring_test.js BTC
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../js/redbar_trend.js');
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const WANT = String(process.argv[2] || 'ALL').toUpperCase();
const BAR_MS = { '5m': 5 * 60000, '15m': 15 * 60000, '1h': 3600000 };

let failed = 0;
function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadDesk(id, tf) {
  const p = path.join(ROOT, '.cache_desk', `${id}_${tf}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadBinanceMonth(symbol, tf, yyyyMm) {
  const p = path.join(ROOT, '.cache_binance_um', `${symbol}_${tf}_${yyyyMm}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lastClosedIdx(bars, asOf, barMs) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + barMs <= asOf) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function instCfg(id) {
  const inst = (CONFIG.rangeEma?.instruments || []).find((x) => x.id === id);
  if (!inst) throw new Error(`Unknown instrument ${id}`);
  return {
    id: inst.id,
    instrumentId: inst.id,
    lookbackDays: 90,
    touchPct: 0.15,
    chartBandDays: 7,
    dayMode: inst.dayMode || 'ist',
    bandStyle: inst.bandStyle || 'sessionFib',
    markWindow: inst.markWindow,
    fibLevels: inst.fibLevels || [0, 0.44, 0.5, 0.56, 1],
    sessions: inst.sessions || [],
    firstRedTf: inst.firstRedTf || '1h',
    symbol: inst.symbol,
  };
}

/** Synthetic mid-15m Gate 7 unit (instrument-agnostic prices). */
function unitGate7MidBar(tag, px = 25000) {
  console.log(`\n[${tag}] Gate 7 + mid-15m 5m unit`);
  const t0 = Date.parse('2026-09-15T04:15:00.000Z'); // 09:45 IST
  const hi = px + 100;
  const lo = px - 80;
  const median = (hi + lo) / 2;
  const fibs = {
    median,
    f44: lo + 0.44 * (hi - lo),
    f56: lo + 0.56 * (hi - lo),
  };
  const firstRed = {
    t: t0 - 3 * BAR_MS['1h'],
    open: px + 20,
    high: hi,
    low: lo,
    close: px - 10,
  };

  const bars5 = [];
  for (let i = 0; i < 200; i++) {
    const t = t0 - (200 - i) * BAR_MS['5m'];
    bars5.push({ t, o: px, h: px + 20, l: px - 20, c: px });
  }
  // Closed +5m: sweep 1H high then close back below high (SHORT confirm)
  const trigClose = hi - 40;
  bars5.push({
    t: t0,
    o: hi - 10,
    h: hi + 25,
    l: trigClose - 5,
    c: trigClose,
  });
  // Closed +10m bar (opens +5m) — still valid at +11m
  bars5.push({
    t: t0 + BAR_MS['5m'],
    o: trigClose,
    h: trigClose + 15,
    l: trigClose - 30,
    c: trigClose - 25,
  });
  // Forming +15m bar (opens +10m, closes +15m) — must be ignored at +11m
  bars5.push({
    t: t0 + 2 * BAR_MS['5m'],
    o: trigClose - 25,
    h: trigClose + 5,
    l: trigClose - 60,
    c: trigClose - 50,
  });

  const asOfMid = t0 + 11 * 60000; // +11m into the 15m
  const conf = RedBarTrend._trade2Confirm5m(bars5, firstRed, fibs, asOfMid, 0.15);
  ok('mid-15m sees closed 5m confirm', !!(conf && conf.bar && conf.bar.t <= t0 + BAR_MS['5m']),
    conf ? `trigClose=${conf.bar.c} read=${conf.read} barOff=${(conf.bar.t - t0) / 60000}m` : 'no conf');
  ok('mid-15m ignores forming +10m open bar', !(conf && conf.bar && conf.bar.t === t0 + 2 * BAR_MS['5m']));

  // Gate 7 via entryGate — Trade 1 path (Nifty's live ENTER setup)
  const stop = trigClose + 80;
  const R = Math.abs(trigClose - stop);
  const gFresh = RedBarTrend.entryGate({
    trend: 'bearish',
    setupKind: 'trade1_departure',
    rr: 1.5,
    stopStructural: true,
    invalidationReason: '5m swing high',
    stopPct: 0.32,
    renko: null,
    clock: { id: 'pre_london' },
    asOfTs: asOfMid,
    instrumentId: tag === 'NIFTY' ? 'NIFTY' : 'BTC',
    season: 'SEP–DEC',
    setupTriggerTs: t0,
    entryPrice: trigClose,
    stopPrice: stop,
    livePrice: trigClose,
    revisitRead: null,
  });
  ok(`${tag} fresh Trade1 ENTER`, gFresh.state === 'enter', gFresh.reason);

  if (tag === 'NIFTY') {
    const gT2 = RedBarTrend.entryGate({
      trend: 'bearish',
      setupKind: 'trade2_confirmed',
      rr: 1.5,
      stopStructural: true,
      invalidationReason: '5m swing high',
      stopPct: 0.32,
      renko: null,
      clock: { id: 'pre_london' },
      asOfTs: asOfMid,
      instrumentId: 'NIFTY',
      season: 'SEP–DEC',
      setupTriggerTs: t0,
      entryPrice: trigClose,
      stopPrice: stop,
      livePrice: trigClose,
      revisitRead: 'liq_sweep_high',
    });
    ok('Nifty T2 stays WATCH (DNA)', gT2.state === 'watch', gT2.reason);
  }

  const liveChased = trigClose - 0.7 * R; // short: price already 0.7R in favor
  const gChased = RedBarTrend.entryGate({
    trend: 'bearish',
    setupKind: 'trade1_departure',
    rr: 1.5,
    stopStructural: true,
    invalidationReason: '5m swing high',
    stopPct: 0.32,
    renko: null,
    clock: { id: 'pre_london' },
    asOfTs: asOfMid,
    instrumentId: tag === 'NIFTY' ? 'NIFTY' : 'BTC',
    season: 'SEP–DEC',
    setupTriggerTs: t0,
    entryPrice: trigClose,
    stopPrice: stop,
    livePrice: liveChased,
    revisitRead: null,
  });
  ok('0.7R chase → watch', gChased.state === 'watch' && /0\.7R|stale|chase/i.test(gChased.reason),
    gChased.reason);

  const gExpired = RedBarTrend.entryGate({
    trend: 'bearish',
    setupKind: 'trade1_departure',
    rr: 1.5,
    stopStructural: true,
    invalidationReason: '5m swing high',
    stopPct: 0.32,
    renko: null,
    clock: { id: 'pre_london' },
    asOfTs: t0 + 21 * 60000,
    instrumentId: tag === 'NIFTY' ? 'NIFTY' : 'BTC',
    season: 'SEP–DEC',
    setupTriggerTs: t0,
    entryPrice: trigClose,
    stopPrice: stop,
    livePrice: trigClose,
    revisitRead: null,
  });
  ok('>20m → watch', gExpired.state === 'watch' && /20m|window closed/i.test(gExpired.reason),
    gExpired.reason);
}

/**
 * Sep 3 2026 regression: first leave @ 06:45 close 23918.05 must stay locked;
 * later 15m bars must not slide trigger to 23915.2 / 23923.75 (tol / conf5 steal).
 */
function niftyTriggerLockProbe() {
  console.log('\n[NIFTY] Trade1 triggerTs lock (Sep 3 2026 leave episode)');
  const cfg = instCfg('NIFTY');
  const bars15 = loadDesk('NIFTY', '15m');
  const bars5 = loadDesk('NIFTY', '5m');
  const bars1h = loadDesk('NIFTY', '1h');
  const wantTrigTs = Date.parse('2026-09-03T06:45:00.000Z');
  const wantTrigPx = 23918.05;
  const checkpoints = [
    Date.parse('2026-09-03T06:59:59.000Z'),
    Date.parse('2026-09-03T07:14:59.000Z'),
    Date.parse('2026-09-03T07:29:59.000Z'),
  ];

  function readoutAt(asOf) {
    let i15 = -1;
    for (let i = 0; i < bars15.length; i++) {
      if (bars15[i].t <= asOf) i15 = i;
      else break;
    }
    if (i15 < 60) return null;
    const calDay = RedBarTrend.dayKey(bars15[i15].t, cfg.dayMode);
    const slice15 = bars15.slice(Math.max(0, i15 - 960), i15 + 1);
    const iP = lastClosedIdx(bars1h, asOf, BAR_MS['1h']);
    const pivotSlice = iP < 0 ? [] : bars1h.slice(Math.max(0, iP - 80), iP + 1);
    const firstRed1h = RedBarTrend.firstRedBarOfSession(pivotSlice, calDay, {
      ...cfg, asOfTs: asOf, barMs: BAR_MS['1h'],
    });
    const i5 = lastClosedIdx(bars5, asOf, BAR_MS['5m']);
    const m5 = bars5.slice(Math.max(0, i5 - 599), i5 + 1);
    return RedBarTrend.readAt(slice15, slice15.length - 1, {
      ...cfg, asOfTs: asOf, firstRed1h, bars1h: pivotSlice, bars5m: m5,
    });
  }

  let locked = 0;
  for (const asOf of checkpoints) {
    const o = readoutAt(asOf);
    const good = o
      && o.setupKind === 'trade1_departure'
      && Number(o.triggerTs) === wantTrigTs
      && Number(o.triggerPrice) === wantTrigPx;
    if (good) locked += 1;
    ok(`lock @ ${new Date(asOf).toISOString().slice(11, 16)}Z`,
      good,
      o ? `trig=${o.triggerPrice} ts=${o.triggerTs && new Date(o.triggerTs).toISOString()} state=${o.actionState}` : 'null');
  }
  const late = readoutAt(checkpoints[1]);
  ok('07:14Z is WATCH (>20m), not a slid ENTER',
    late && late.actionState === 'watch' && /20m|window closed/i.test(late.actionReason || ''),
    late ? late.actionReason : 'null');
  ok('Sep3 leave stayed locked on all checkpoints', locked === checkpoints.length, `locked=${locked}`);
}

/** Force a real Nifty Trade1 ENTER, then bump tip 0.7R — must flip to watch via readAt. */
function niftyReadAtChaseProbe() {
  console.log('\n[NIFTY] readAt chase probe on real Sep bars');
  const cfg = instCfg('NIFTY');
  const bars15 = loadDesk('NIFTY', '15m');
  const bars5 = loadDesk('NIFTY', '5m');
  const bars1h = loadDesk('NIFTY', '1h');
  const start = Date.parse('2026-09-01T00:00:00+05:30');
  const end = Date.parse('2026-10-01T00:00:00+05:30');
  let probed = false;

  for (let i = 60; i < bars15.length - 2; i++) {
    const bar15 = bars15[i];
    if (bar15.t < start || bar15.t >= end) continue;
    const asOf = bar15.t + BAR_MS['15m'] - 1000;
    const calDay = RedBarTrend.dayKey(bar15.t, cfg.dayMode);
    const slice15 = bars15.slice(Math.max(0, i - 960), i + 1);
    const iP = lastClosedIdx(bars1h, asOf, BAR_MS['1h']);
    const pivotSlice = iP < 0 ? [] : bars1h.slice(Math.max(0, iP - 80), iP + 1);
    const firstRed1h = RedBarTrend.firstRedBarOfSession(pivotSlice, calDay, {
      ...cfg, asOfTs: asOf, barMs: BAR_MS['1h'],
    });
    const i5 = lastClosedIdx(bars5, asOf, BAR_MS['5m']);
    if (i5 < 50) continue;
    const m5 = bars5.slice(Math.max(0, i5 - 599), i5 + 1);
    const fresh = RedBarTrend.readAt(slice15, slice15.length - 1, {
      ...cfg, asOfTs: asOf, firstRed1h, bars1h: pivotSlice, bars5m: m5,
    });
    if (!fresh || fresh.actionState !== 'enter' || fresh.setupKind !== 'trade1_departure') continue;
    if (!(fresh.invalidation != null && fresh.triggerPrice != null)) continue;

    const ep = Number(fresh.triggerPrice);
    const sp = Number(fresh.invalidation);
    const R = Math.abs(ep - sp);
    if (!(R > 0)) continue;
    const chasedPx = fresh.trend === 'bullish' ? ep + 0.7 * R : ep - 0.7 * R;
    // Prove Gate 7 favR on the same anchors (renko may also block a spiked tip bar)
    const gateChase = RedBarTrend.entryGate({
      trend: fresh.trend,
      setupKind: 'trade1_departure',
      rr: fresh.rr,
      stopStructural: true,
      invalidationReason: fresh.invalidationReason || '5m swing high',
      stopPct: fresh.stopPct,
      renko: null,
      clock: fresh.playbook?.clock || { id: 'pre_london' },
      asOfTs: asOf,
      instrumentId: 'NIFTY',
      season: 'SEP–DEC',
      setupTriggerTs: fresh.triggerTs,
      entryPrice: ep,
      stopPrice: sp,
      livePrice: chasedPx,
      revisitRead: null,
    });
    const tip = {
      ...slice15[slice15.length - 1],
      c: chasedPx,
      h: Math.max(slice15[slice15.length - 1].h, chasedPx),
      l: Math.min(slice15[slice15.length - 1].l, chasedPx),
    };
    const work = slice15.slice();
    work[work.length - 1] = tip;
    const chased = RedBarTrend.readAt(work, work.length - 1, {
      ...cfg, asOfTs: asOf, firstRed1h, bars1h: pivotSlice, bars5m: m5,
    });
    ok('readAt fresh Trade1 was ENTER', fresh.actionState === 'enter',
      `${new Date(asOf).toISOString()} ${fresh.trend}`);
    ok('Gate7 favR blocks 0.7R chase',
      gateChase.state === 'watch' && /0\.7R|stale|chase/i.test(gateChase.reason),
      gateChase.reason);
    ok('readAt after chased tip does NOT stay ENTER',
      chased && chased.actionState !== 'enter',
      chased ? `${chased.actionState}: ${chased.actionReason}` : 'null');
    ok('triggerPrice stayed anchored (≠ chased tip)',
      chased && Number(chased.triggerPrice) === ep
      && Number(chased.price) === chasedPx,
      `trig=${chased?.triggerPrice} live=${chased?.price}`);
    probed = true;
    break;
  }
  ok('found a Sep Trade1 ENTER to probe', probed);
}

/**
 * Replay live tip style: for each 15m bar, evaluate at +5m / +10m / close
 * with asOfTs = wall time (like bot.js nowTs), including the forming tip candle.
 */
function replayLiveTip(id, bars15, bars5, bars1h, monthStart, monthEnd) {
  const cfg = instCfg(id);
  const pivotMs = BAR_MS[cfg.firstRedTf] || BAR_MS['1h'];
  let enter = 0;
  let watchChase = 0;
  let watchStale = 0;
  let watchOther = 0;
  let t1 = 0;
  let t2 = 0;
  let sweep = 0;
  let missingTrigTs = 0;
  let entryEqLiveOnEnter = 0;
  const samples = [];

  const WARM = 60;
  for (let i = WARM; i < bars15.length; i++) {
    const bar = bars15[i];
    if (bar.t < monthStart || bar.t >= monthEnd) continue;

    // Three live tip snapshots inside / at end of this 15m
    for (const offsetMin of [5, 10, 14]) {
      const asOf = bar.t + offsetMin * 60000;
      if (asOf >= monthEnd) continue;
      // Slice including this forming bar (mirrors Binance/Dhan tip)
      const slice15 = bars15.slice(Math.max(0, i - 960), i + 1);
      // Mutate tip close toward "live" using last closed 5m at asOf when available
      const i5 = lastClosedIdx(bars5, asOf, BAR_MS['5m']);
      if (i5 < 50) continue;
      const tip = { ...bar };
      if (offsetMin < 14) {
        // forming: use last 5m close as tip price (live mark)
        tip.c = bars5[i5].c;
        tip.h = Math.max(bar.h, tip.c);
        tip.l = Math.min(bar.l, tip.c);
      }
      const work = slice15.slice();
      work[work.length - 1] = tip;

      const calDay = RedBarTrend.dayKey(bar.t, cfg.dayMode);
      const iP = lastClosedIdx(bars1h, asOf, pivotMs);
      const pivotSlice = iP < 0 ? [] : bars1h.slice(Math.max(0, iP - 80), iP + 1);
      const firstRed1h = RedBarTrend.firstRedBarOfSession(pivotSlice, calDay, {
        ...cfg, asOfTs: asOf, barMs: pivotMs,
      });
      const m5 = bars5.slice(Math.max(0, i5 - 599), i5 + 1);

      const o = RedBarTrend.readAt(work, work.length - 1, {
        ...cfg,
        asOfTs: asOf,
        firstRed1h,
        bars1h: pivotSlice,
        bars5m: m5,
      });
      if (!o) continue;

      const reason = String(o.actionReason || '');
      if (o.actionState === 'enter') {
        enter += 1;
        if (o.setupKind === 'trade1_departure') t1 += 1;
        else if (o.setupKind === 'trade2_confirmed') t2 += 1;
        else if (o.setupKind === 'session_sweep') sweep += 1;
        if (!(o.triggerTs != null)) missingTrigTs += 1;
        if (o.triggerPrice != null && Number(o.triggerPrice) === Number(o.price)) {
          // OK when tip hasn't moved; only flag if reason claims fresh AND later chase would be 0
        }
        // Contract: entryGate got distinct anchors available
        if (o.triggerPrice == null) entryEqLiveOnEnter += 1;
        if (samples.length < 8) {
          samples.push({
            when: new Date(asOf).toISOString(),
            setup: o.setupKind,
            side: o.trend,
            px: o.price,
            trig: o.triggerPrice,
            trigTs: o.triggerTs,
            reason: reason.slice(0, 80),
          });
        }
      } else if (/already .*R into the move|Do not chase/i.test(reason)) {
        watchChase += 1;
      } else if (/window closed \(>20m/i.test(reason)) {
        watchStale += 1;
      } else if (o.actionState === 'watch') {
        watchOther += 1;
      }
    }
  }

  const monthLabel = new Date(monthStart + 6 * 3600000).toISOString().slice(0, 7);
  console.log(`\n[${id}] Live-tip replay ${monthLabel} (3 snapshots/bar, raw scan hits)`);
  console.log(`  ENTER=${enter} (T1=${t1} T2=${t2} sweep=${sweep})  watchChase=${watchChase}  watchStale=${watchStale}  watchOther=${watchOther}`);
  ok('every ENTER carries triggerTs', missingTrigTs === 0, `missing=${missingTrigTs}`);
  ok('every ENTER has triggerPrice anchor', entryEqLiveOnEnter === 0,
    `missing anchor=${entryEqLiveOnEnter}`);
  if (id === 'NIFTY') {
    ok('Nifty live-tip T2 ENTER leak = 0', t2 === 0, `t2=${t2}`);
    ok('Nifty live-tip produces Trade1 ENTERs', t1 >= 1, `t1=${t1}`);
  }
  if (samples.length) {
    console.log('  sample ENTERs:');
    for (const s of samples.slice(0, 5)) {
      console.log(`    ${s.when} ${s.setup} ${s.side} px=${s.px} trig=${s.trig} Δ=${(Number(s.px) - Number(s.trig)).toFixed(2)}`);
    }
  }
  return { enter, watchChase, watchStale, t1, t2, sweep };
}

function assertBotSourceContracts() {
  const btcInst = (CONFIG.rangeEma?.instruments || []).find((x) => x.id === 'BTC');
  ok('BTC markWindow is 02:30–03:30 IST (1H wick H/L)',
    btcInst && btcInst.markWindow && btcInst.markWindow.startHour === 2 && btcInst.markWindow.startMinute === 30 && btcInst.markWindow.endHour === 3 && btcInst.markWindow.endMinute === 30,
    btcInst && btcInst.markLabel);
  console.log('\n[SOURCE] bot.js / futures one-open + relay dedupe');
  const bot = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
  const fut = fs.readFileSync(path.join(ROOT, 'js/binance_futures_trade.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const btcBlock = cfg.match(/id:\s*'BTC'[\s\S]*?feed:\s*'([^']+)'/);
  ok('BTC instrument feed is binanceFutures (not spot)',
    btcBlock && btcBlock[1] === 'binanceFutures',
    btcBlock ? `feed=${btcBlock[1]}` : 'BTC block missing');
  ok('getDeskOHLC forces futures if BTC/XAU marked spot',
    /forcing binanceFutures \(spot Fibs are wrong/.test(
      fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8')));
  ok('bot skips auto when position open',
    /openAmt[\s\S]{0,120}Math\.abs\(openAmt\) > 0/.test(bot)
    && /already active — skip auto-entry/.test(bot));
  ok('auto openTwoLeg uses closePosition:false',
    /openTwoLegDeskTrade\(\{[\s\S]*?closePosition:\s*false/.test(bot));
  ok('futures respects p.closePosition',
    /const closePos = p\.closePosition != null/.test(fut));
  ok('scanner alertKey includes trigBucket',
    /trigBucket[\s\S]{0,80}alertKey = `\$\{side\}\|\$\{setupKind\}\|\$\{dayKey\}\|\$\{trigBucket\}`/.test(bot)
    || /\$\{side\}\|\$\{setupKind\}\|\$\{dayKey\}\|\$\{trigBucket\}/.test(bot));
  ok('relay uses shared _rbAlertSeen + trigBucket',
    /_rbAlertSeen\(instrumentId,\s*scannerKey\)/.test(bot)
    && /trigBucket/.test(bot));
  ok('Nifty cannot auto-trade Binance path',
    /sym === 'BTCUSDT'/.test(bot)
    && /Alert only — place manually on Dhan/.test(bot));
  ok('readAt uses setupTriggerPrice vs livePrice',
    /entryPrice:\s*setupTriggerPrice/.test(fs.readFileSync(path.join(ROOT, 'js/redbar_trend.js'), 'utf8'))
    && /livePrice:\s*price/.test(fs.readFileSync(path.join(ROOT, 'js/redbar_trend.js'), 'utf8')));
}

function replayNiftySep2026() {
  const bars15 = loadDesk('NIFTY', '15m');
  const bars5 = loadDesk('NIFTY', '5m');
  const bars1h = loadDesk('NIFTY', '1h');
  // Sep 2026 IST session month (cache ends ~2026-10-26)
  const start = Date.parse('2026-09-01T00:00:00+05:30');
  const end = Date.parse('2026-10-01T00:00:00+05:30');
  return replayLiveTip('NIFTY', bars15, bars5, bars1h, start, end);
}

function replayBtcSep2026() {
  const yyyyMm = '2026-09';
  const bars15 = loadBinanceMonth('BTCUSDT', '15m', yyyyMm);
  const bars5 = loadBinanceMonth('BTCUSDT', '5m', yyyyMm);
  const bars1h = loadBinanceMonth('BTCUSDT', '1h', yyyyMm);
  if (!bars15 || !bars5 || !bars1h) {
    console.log('\n[BTC] skip month replay — missing .cache_binance_um BTCUSDT_*_2026-09.json');
    return null;
  }
  // Need prior bars for warmup — stitch Aug if present
  const aug15 = loadBinanceMonth('BTCUSDT', '15m', '2026-08') || [];
  const aug5 = loadBinanceMonth('BTCUSDT', '5m', '2026-08') || [];
  const aug1h = loadBinanceMonth('BTCUSDT', '1h', '2026-08') || [];
  const start = Date.parse('2026-09-01T00:00:00Z');
  const end = Date.parse('2026-10-01T00:00:00Z');
  return replayLiveTip(
    'BTC',
    aug15.concat(bars15),
    aug5.concat(bars5),
    aug1h.concat(bars1h),
    start,
    end,
  );
}

(async () => {
  console.log('Red Bar live-wiring regression');
  assertBotSourceContracts();

  if (WANT === 'ALL' || WANT === 'BTC') {
    unitGate7MidBar('BTC', 68000);
    try { replayBtcSep2026(); } catch (e) { failed += 1; console.log('  FAIL  BTC replay', e.message); }
  }
  if (WANT === 'ALL' || WANT === 'NIFTY') {
    unitGate7MidBar('NIFTY', 25000);
    try { niftyReadAtChaseProbe(); } catch (e) { failed += 1; console.log('  FAIL  NIFTY chase probe', e.message); }
    try { niftyTriggerLockProbe(); } catch (e) { failed += 1; console.log('  FAIL  NIFTY trigger lock', e.message); }
    try { replayNiftySep2026(); } catch (e) { failed += 1; console.log('  FAIL  NIFTY replay', e.message); }
  }

  // Closed-bar DNA outcomes quick pass for Nifty (ENTER count under live gates)
  if (WANT === 'ALL' || WANT === 'NIFTY') {
    console.log('\n[NIFTY] Closed-bar outcomes gate sanity (Sep–Oct window sample)');
    const cfg = instCfg('NIFTY');
    const bars15 = loadDesk('NIFTY', '15m');
    const bars5 = loadDesk('NIFTY', '5m');
    const bars1h = loadDesk('NIFTY', '1h');
    const start = Date.parse('2026-09-01T00:00:00+05:30');
    const end = Date.parse('2026-10-01T00:00:00+05:30');
    let closedEnter = 0;
    let t2Enter = 0;
    for (let i = 60; i < bars15.length - 2; i++) {
      const bar15 = bars15[i];
      if (bar15.t < start || bar15.t >= end) continue;
      const asOf = bar15.t + BAR_MS['15m'] - 1000;
      const calDay = RedBarTrend.dayKey(bar15.t, cfg.dayMode);
      const slice15 = bars15.slice(Math.max(0, i - 960), i + 1);
      const iP = lastClosedIdx(bars1h, asOf, BAR_MS['1h']);
      const pivotSlice = iP < 0 ? [] : bars1h.slice(Math.max(0, iP - 80), iP + 1);
      const firstRed1h = RedBarTrend.firstRedBarOfSession(pivotSlice, calDay, {
        ...cfg, asOfTs: asOf, barMs: BAR_MS['1h'],
      });
      const i5 = lastClosedIdx(bars5, asOf, BAR_MS['5m']);
      if (i5 < 50) continue;
      const m5 = bars5.slice(Math.max(0, i5 - 599), i5 + 1);
      const o = RedBarTrend.readAt(slice15, slice15.length - 1, {
        ...cfg, asOfTs: asOf, firstRed1h, bars1h: pivotSlice, bars5m: m5,
      });
      if (o && o.actionState === 'enter') {
        closedEnter += 1;
        if (o.setupKind === 'trade2_confirmed') t2Enter += 1;
      }
    }
    console.log(`  closed-bar ENTER=${closedEnter} (T2 ENTER leak=${t2Enter})`);
    ok('Nifty T2 never ENTERs under DNA gates', t2Enter === 0, `t2Enter=${t2Enter}`);
    ok('Nifty still produces Trade 1 ENTERs in Sep', closedEnter >= 1, `enter=${closedEnter}`);
  }

  console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
