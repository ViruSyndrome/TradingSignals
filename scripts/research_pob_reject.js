/**
 * Dr. Dev POB reject — session-anchored SHORT (correct model).
 *
 *   NIFTY: 5m X-Candle @ 09:15 IST · entry≤12:15 · flat@12:45
 *   BTC:   5m X-Candle @ Asia 05:30 / London 13:00–13:30 / NY 19:00–20:00 IST
 *          · SL above POB 0.56 (tight) · TP1 = Anchor low · TP2 = 2R
 *          · max 2.5h after X · hold≤45m · SHORT only
 *
 *   node scripts/research_pob_reject.js          # BTC (default)
 *   node scripts/research_pob_reject.js --nifty
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../js/redbar_trend.js');

const ROOT = path.join(__dirname, '..');
const NIFTY_CACHE = path.join(ROOT, '.cache_desk', 'NIFTY_5m.json');
const BTC_CACHE = path.join(ROOT, '.cache_binance_um');
const BAR_MS = 5 * 60000;
const MAX_HOLD_BARS = 9; // 45 minutes — no overnight hope

const useNifty = process.argv.includes('--nifty');
const FEE = useNifty ? 0.0004 : 0.0008;

function loadNifty() {
  const raw = JSON.parse(fs.readFileSync(NIFTY_CACHE, 'utf8'));
  return raw.map((b) => (b.t != null
    ? { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
    : { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }))
    .sort((a, b) => a.t - b.t);
}

function loadBtc(startYm = '2024-10', endYm = '2026-09') {
  const files = fs.readdirSync(BTC_CACHE)
    .filter((f) => f.startsWith('BTCUSDT_5m_') && f.endsWith('.json'))
    .sort()
    .filter((f) => {
      const ym = f.slice('BTCUSDT_5m_'.length, -5);
      return ym >= startYm && ym <= endYm;
    });
  const bars = [];
  const seen = new Set();
  for (const f of files) {
    for (const b of JSON.parse(fs.readFileSync(path.join(BTC_CACHE, f), 'utf8'))) {
      const bar = b.t != null ? { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
        : { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      if (seen.has(bar.t)) continue;
      seen.add(bar.t);
      bars.push(bar);
    }
  }
  return bars.sort((a, b) => a.t - b.t);
}

function istMins(ts) {
  const z = RedBarTrend.zonedHms(ts, 'Asia/Kolkata');
  return z.hour * 60 + z.minute;
}

function summarize(label, trades) {
  if (!trades.length) {
    console.log(`${label}: n=0`);
    return { n: 0, wr: 0, sum: 0, train: 0, oos: 0, pass: false };
  }
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const sum = trades.reduce((s, t) => s + t.pnlPct, 0);
  const mid = Math.floor(trades.length / 2);
  const train = trades.slice(0, mid).reduce((s, t) => s + t.pnlPct, 0);
  const oos = trades.slice(mid).reduce((s, t) => s + t.pnlPct, 0);
  const wr = (wins / trades.length) * 100;
  const pass = train > 0 && oos > 0;
  console.log(
    `${pass ? 'PASS' : 'fail'} ${label}: n=${trades.length} WR=${wr.toFixed(1)}% `
    + `sum=${sum.toFixed(2)}% Train=${train >= 0 ? '+' : ''}${train.toFixed(2)}% `
    + `OOS=${oos >= 0 ? '+' : ''}${oos.toFixed(2)}%`,
  );
  return { n: trades.length, wr, sum, train, oos, pass };
}

/**
 * SHORT: bank TP1 (Anchor low) at full size for research simplicity.
 * Geometry assumes tight SL @ POB 0.56 → inherent multi-R to X-low.
 */
function scoreShort(bars, iEntry, entry, stop, xLow, day, flatCutoffMins) {
  const risk = Math.abs(entry - stop);
  const tp1 = (Number.isFinite(xLow) && xLow < entry) ? xLow : entry - risk;
  const tp2 = entry - risk * 2;
  const maxI = Math.min(bars.length - 1, iEntry + MAX_HOLD_BARS);
  let banked = false;
  let half1 = 0;
  let activeStop = stop;
  for (let i = iEntry + 1; i <= maxI; i++) {
    const b = bars[i];
    if (RedBarTrend.zonedDay(b.t, 'Asia/Kolkata') !== day
      || (flatCutoffMins != null && istMins(b.t) >= flatCutoffMins)) {
      const px = b.o;
      const openRet = (entry - px) / entry - FEE;
      return {
        pnlPct: banked ? (0.5 * half1 + 0.5 * openRet) * 100 : openRet * 100,
        exit: 'session_flat',
      };
    }
    if (!banked) {
      if (b.h >= activeStop) return { pnlPct: ((entry - activeStop) / entry - FEE) * 100, exit: 'sl' };
      if (b.l <= tp1) {
        banked = true;
        half1 = ((entry - tp1) / entry - FEE);
        activeStop = entry; // BE after TP1
        continue;
      }
    } else {
      if (b.h >= activeStop) {
        return { pnlPct: (0.5 * half1 + 0.5 * ((entry - activeStop) / entry - FEE)) * 100, exit: 'be' };
      }
      if (b.l <= tp2) {
        return { pnlPct: (0.5 * half1 + 0.5 * ((entry - tp2) / entry - FEE)) * 100, exit: 'tp2' };
      }
    }
  }
  const px = bars[maxI].c;
  const openRet = (entry - px) / entry - FEE;
  return {
    pnlPct: banked ? (0.5 * half1 + 0.5 * openRet) * 100 : openRet * 100,
    exit: 'time_45m',
  };
}

function findX(bars, asOf) {
  if (useNifty) {
    return RedBarTrend.findOpeningXCandle5m(bars, asOf, {
      timeZone: 'Asia/Kolkata',
      openHour: 9,
      openMinute: 15,
      maxBars: 6,
      sessionId: 'nse',
      sessionLabel: 'NSE 09:15 IST',
    });
  }
  return RedBarTrend.findPrimeSessionXCandle5m(bars, asOf, {
    timeZone: 'Asia/Kolkata',
    maxBars: 6,
  });
}

function inScanWindow(mins) {
  if (useNifty) return mins >= 9 * 60 + 20 && mins <= 12 * 60 + 15;
  // BTC: Asia + London + NY only (not 24/7 dead hours)
  const asia = mins >= 5 * 60 + 30 && mins < 8 * 60 + 30;
  const london = mins >= 13 * 60 && mins < 16 * 60;
  const ny = mins >= 19 * 60 && mins < 22 * 60 + 30;
  return asia || london || ny;
}

function flatCutoffFor(x) {
  if (useNifty) return 12 * 60 + 45;
  if (!x) return null;
  // Flat ~2.5h after the session open clock used for X
  const openM = (x.openHour || 0) * 60 + (x.openMinute || 0);
  return openM + 150;
}

(async () => {
  const bars = useNifty ? loadNifty() : loadBtc();
  const asset = useNifty ? 'NIFTY' : 'BTCUSDT';
  console.log(
    `${asset} 5m ${new Date(bars[0].t).toISOString().slice(0, 10)} → `
    + `${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)} bars=${bars.length}`,
  );
  console.log(`ACTIONABLE has pob_reject? ${RedBarTrend.ACTIONABLE_SETUPS.includes('pob_reject')}`);
  console.log(
    useNifty
      ? 'Rules: NSE 09:15 X · SL@POB0.56 · TP1 Anchor · SHORT · hold≤45m'
      : 'Rules: Asia 05:30 / London 13:00–13:30 / NY 19:00–20:00 · SL@POB0.56 · TP1 Anchor · TP2 2R · hold≤45m',
  );

  const trades = [];
  const seen = new Set();
  let nInvalid = 0;
  const bySession = { asia: [], london: [], ny: [], nse: [] };

  for (let i = 40; i < bars.length - MAX_HOLD_BARS - 1; i++) {
    const asOf = bars[i].t + BAR_MS - 1000;
    const mins = istMins(asOf);
    if (!inScanWindow(mins)) continue;

    const day = RedBarTrend.zonedDay(asOf, 'Asia/Kolkata');
    const x = findX(bars.slice(0, i + 1), asOf);
    if (!x) continue;

    const pr = RedBarTrend.detectPobReject(x, bars.slice(0, i + 1), asOf, useNifty ? 0.12 : 0.15, {
      timeZone: 'Asia/Kolkata',
      entryCutoffMins: useNifty ? 12 * 60 + 15 : undefined,
      maxEntryMins: useNifty ? 180 : 150,
      freshMins: 20,
    });
    if (!pr) continue;
    if (pr.status === 'short_invalidated') {
      const k = `inv|${day}|${x.sessionId || 'nse'}`;
      if (!seen.has(k)) {
        seen.add(k);
        nInvalid++;
      }
      continue;
    }
    if (!pr.triggered || pr.side !== 'bearish') continue;

    const key = `trig|${day}|${pr.triggerTs}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = pr.triggerPrice;
    // Tight SL: POB high (0.56) — never the full X-Candle high
    let stop = pr.stopHint;
    if (!(stop > entry)) stop = Math.max(pr.pobHi || 0, entry) * 1.00015;
    const xLow = pr.tpHint != null && pr.tpHint < entry ? pr.tpHint : (x.low || x.l);
    const risk = Math.abs(entry - stop);
    // Micro stops <1.5bps skip; >1.5% means geometry broke (shouldn't with POB SL)
    if (risk / entry < 0.00015 || risk / entry > 0.015) continue;
    // Classic geometry: entry above Anchor low; keep trades with ≥1.0R to TP1 (POB edge)
    if (!(Number.isFinite(xLow) && xLow < entry)) continue;
    if ((entry - xLow) / risk < 1.0) continue;

    let iTrig = -1;
    for (let k = i; k >= Math.max(0, i - 40); k--) {
      if (bars[k].t === pr.triggerTs) {
        iTrig = k;
        break;
      }
    }
    if (iTrig < 0) iTrig = i;

    const sc = scoreShort(bars, iTrig, entry, stop, xLow, day, flatCutoffFor(x));
    const row = {
      ...sc,
      side: 'SHORT',
      day,
      session: x.sessionId || 'nse',
      sessionLabel: x.sessionLabel || '',
      entryT: pr.triggerTs,
      riskPct: (risk / entry) * 100,
    };
    trades.push(row);
    if (bySession[row.session]) bySession[row.session].push(row);
  }

  console.log(`\nInvalidated blow-through days≈${nInvalid}`);
  console.log(`POB SHORT triggers: n=${trades.length}`);
  const exits = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  console.log('Exits:', exits);

  const all = summarize(`POB reject SHORT (${asset} 5m session)`, trades);
  if (!useNifty) {
    summarize('  Asia 05:30', bySession.asia);
    summarize('  London open', bySession.london);
    summarize('  NY open', bySession.ny);
  }

  console.log(
    `\nVerdict: ${all.pass ? 'PASS — candidate for DNA ACTIONABLE' : 'FAIL / MIXED — keep overlay only (do not Telegram)'}`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
