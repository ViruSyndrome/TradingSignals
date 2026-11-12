const fs = require('fs');
const path = require('path');

const bars15 = require('../.cache_desk/NIFTY_15m.json');
const bars5 = require('../.cache_desk/NIFTY_5m.json');

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function getIstMins(ts) {
  const d = new Date(ts);
  const parts = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function calcFibs(high, low) {
  const range = high - low;
  return {
    low,
    high,
    range,
    f0: low,
    f44: +(low + 0.44 * range).toFixed(2),
    f50: +(low + 0.50 * range).toFixed(2),
    f56: +(low + 0.56 * range).toFixed(2),
    f1: high,
  };
}

// 10 recent expiry Thursdays
const expiryDays = [
  '2026-09-03',
  '2026-09-10',
  '2026-09-17',
  '2026-09-24',
  '2026-10-01',
  '2026-10-08',
  '2026-10-15',
  '2026-10-22',
  '2026-10-29',
  '2026-11-05',
];

console.log('========================================================================================');
console.log('       BLIND WALK-FORWARD REPLAY SIMULATION: 10 WEEKLY EXPIRY DAYS (NIFTY 50)          ');
console.log('       Strategy: Dr. Dev / Sagar Fib Median Scalper with Model B (Two-Lot Scaling)      ');
console.log('========================================================================================\n');

const allTrades = [];
const daySummaries = [];

for (const targetDay of expiryDays) {
  const dayBars15 = bars15.filter((b) => fmtDate(b.t) === targetDay);
  const dayBars5 = bars5.filter((b) => fmtDate(b.t) === targetDay);

  if (!dayBars15.length || !dayBars5.length) continue;

  // Step 1: 09:15-09:30 Open Bar
  const openBar15 = dayBars15[0];
  const openFibs = calcFibs(openBar15.h, openBar15.l);

  // Step 2: First closed 15m Red Bar
  let firstRed15 = null;
  let redFibs = null;
  let sandwich = null;

  for (let i = 1; i < dayBars15.length; i++) {
    const b = dayBars15[i];
    if (b.c < b.o) {
      firstRed15 = b;
      redFibs = calcFibs(b.h, b.l);
      sandwich = {
        lo: Math.min(openFibs.f50, redFibs.f50),
        hi: Math.max(openFibs.f50, redFibs.f50),
      };
      break;
    }
  }

  if (!firstRed15) {
    daySummaries.push({ day: targetDay, status: 'NO_RED_BAR', trades: 0, pnlB: 0, pnlA: 0 });
    continue;
  }

  const swSpan = sandwich.hi - sandwich.lo;
  const isWideHighway = swSpan >= 120;

  // Structural Levels
  const levels = [
    { id: 'open_median', name: 'Open Med', price: openFibs.f50, lo: openFibs.f44, hi: openFibs.f56 },
    { id: 'red_median', name: 'Red Med', price: redFibs.f50, lo: redFibs.f44, hi: redFibs.f56 },
  ];

  let inTrade = null;
  let lastExitLevel = null;
  let lastExitTime = 0;
  const dayTrades = [];

  for (let i = 0; i < dayBars5.length; i++) {
    const b = dayBars5[i];
    const mins = getIstMins(b.t);
    const tStr = fmtTime(b.t);
    const prev = i > 0 ? dayBars5[i - 1] : null;

    // Hard Flatten at 15:10 IST
    if (mins >= 910 && inTrade) {
      // 15:10 IST exit
      const exitPx = b.c;
      const leg1Pts = inTrade.leg1Hit ? inTrade.risk : (inTrade.side === 'LONG' ? exitPx - inTrade.entry : inTrade.entry - exitPx);
      const leg2Pts = inTrade.side === 'LONG' ? exitPx - inTrade.entry : inTrade.entry - exitPx;
      const pnlPtsB = (inTrade.leg1Hit ? inTrade.risk : leg1Pts) * 0.5 + leg2Pts * 0.5;
      const pnlRsB = Math.round((inTrade.leg1Hit ? inTrade.risk : leg1Pts) * 65 + leg2Pts * 65);
      const pnlRsA = Math.round((inTrade.side === 'LONG' ? exitPx - inTrade.entry : inTrade.entry - exitPx) * 130);

      inTrade.outcome = '15:10_FLATTEN';
      inTrade.exitPrice = exitPx;
      inTrade.exitTime = '15:10';
      inTrade.leg1Pts = +(leg1Pts).toFixed(1);
      inTrade.leg2Pts = +(leg2Pts).toFixed(1);
      inTrade.pnlRsB = pnlRsB;
      inTrade.pnlRsA = pnlRsA;
      dayTrades.push({ ...inTrade });
      allTrades.push({ ...inTrade });
      lastExitLevel = inTrade.levelTested;
      lastExitTime = b.t;
      inTrade = null;
      continue;
    }

    // Trade Management
    if (inTrade) {
      const isLong = inTrade.side === 'LONG';
      const isShort = inTrade.side === 'SHORT';

      // 1. Check Stop Loss
      const slHit = isLong ? b.l <= inTrade.sl : b.h >= inTrade.sl;
      if (slHit) {
        if (inTrade.leg1Hit) {
          // Breakeven hit on runner!
          const leg1Pts = inTrade.risk;
          const leg2Pts = 0; // BE exit
          const pnlRsB = Math.round(leg1Pts * 65); // Banked leg 1
          const pnlRsA = 0; // Model A closed at BE or full loss

          inTrade.outcome = 'RUNNER_BE';
          inTrade.exitPrice = inTrade.entry;
          inTrade.exitTime = tStr;
          inTrade.leg1Pts = +(leg1Pts).toFixed(1);
          inTrade.leg2Pts = 0;
          inTrade.pnlRsB = pnlRsB;
          inTrade.pnlRsA = 0;
          dayTrades.push({ ...inTrade });
          allTrades.push({ ...inTrade });
        } else {
          // Full SL hit on both lots!
          const lossPts = -inTrade.risk;
          const pnlRsB = Math.round(lossPts * 130);
          const pnlRsA = Math.round(lossPts * 130);

          inTrade.outcome = 'FULL_SL';
          inTrade.exitPrice = inTrade.sl;
          inTrade.exitTime = tStr;
          inTrade.leg1Pts = +(lossPts).toFixed(1);
          inTrade.leg2Pts = +(lossPts).toFixed(1);
          inTrade.pnlRsB = pnlRsB;
          inTrade.pnlRsA = pnlRsA;
          dayTrades.push({ ...inTrade });
          allTrades.push({ ...inTrade });
        }
        lastExitLevel = inTrade.levelTested;
        lastExitTime = b.t;
        inTrade = null;
        continue;
      }

      // 2. Check 1:1 Banker TP
      if (!inTrade.leg1Hit) {
        const tp1Hit = isLong ? b.h >= inTrade.tp1 : b.l <= inTrade.tp1;
        if (tp1Hit) {
          inTrade.leg1Hit = true;
          inTrade.leg1HitTime = tStr;
          // Move Leg 2 SL to Breakeven
          inTrade.sl = inTrade.entry;
        }
      }

      // 3. Check Target (TP2 / Structural)
      const tp2Hit = isLong ? b.h >= inTrade.tp2 : b.l <= inTrade.tp2;
      if (tp2Hit) {
        const leg1Pts = inTrade.risk;
        const leg2Pts = isLong ? inTrade.tp2 - inTrade.entry : inTrade.entry - inTrade.tp2;
        const pnlRsB = Math.round(leg1Pts * 65 + leg2Pts * 65);
        const pnlRsA = Math.round(leg2Pts * 130);

        inTrade.outcome = 'FULL_TARGET';
        inTrade.exitPrice = inTrade.tp2;
        inTrade.exitTime = tStr;
        inTrade.leg1Pts = +(leg1Pts).toFixed(1);
        inTrade.leg2Pts = +(leg2Pts).toFixed(1);
        inTrade.pnlRsB = pnlRsB;
        inTrade.pnlRsA = pnlRsA;
        dayTrades.push({ ...inTrade });
        allTrades.push({ ...inTrade });
        lastExitLevel = inTrade.levelTested;
        lastExitTime = b.t;
        inTrade = null;
        continue;
      }
    }

    // Check New Entry (Only if NOT in trade and after firstRed)
    if (!inTrade && b.t > firstRed15.t && mins < 900) {
      // 0. Dr. Dev 2-Consecutive Loss Rule ("दो लॉस लगातार"):
      // Morning (pre-12:45) vs Afternoon (12:45+): 2 consecutive full losses pauses the session!
      const isPm = mins >= (12 * 60 + 45);
      const sessTrades = dayTrades.filter(t => (getIstMins(t.entryTs) >= 12 * 60 + 45) === isPm);
      if (sessTrades.length >= 2) {
        const lastTwo = sessTrades.slice(-2);
        if (lastTwo.every(t => t.outcome === 'FULL_SL')) {
          continue; // Paused for this session
        }
      }

      // 1. Sandwich Stand-Aside Rule
      const inSandwich = b.c > sandwich.lo && b.c < sandwich.hi;
      if (inSandwich && !isWideHighway) {
        continue; // STAND ASIDE strictly inside sandwich
      }

      // 2. Cooldown check: if same level, require 15 pts clearance; if different level, 3m
      if (lastExitLevel && (b.t - lastExitTime) < 3 * 60000) {
        continue; // 3m breathing room
      }

      // 3. Test structural levels
      for (const lvl of levels) {
        // If same level as last exit, must pull away >= 15 pts before retest
        if (lastExitLevel === lvl.id && Math.abs(b.c - lvl.price) < 15 && (b.t - lastExitTime) < 20 * 60000) {
          continue;
        }

        const touchesLevel = b.l <= lvl.hi + 6 && b.h >= lvl.lo - 6;
        if (!touchesLevel) continue;

        // Long Reclaim/Bounce: candle touches level, closes green above level.lo
        const isLongConfirm = b.c > b.o && b.c >= lvl.lo && (prev ? prev.c <= lvl.hi + 10 : true);
        // Short Breakdown/Reject: candle touches level, closes red below level.hi
        const isShortConfirm = b.c < b.o && b.c <= lvl.hi && (prev ? prev.c >= lvl.lo - 10 : true);

        if (isLongConfirm) {
          const entry = b.c;
          const sl = Math.min(b.l, prev ? prev.l : b.l) - 2.5; // Stop on prev wick extreme
          const risk = +(entry - sl).toFixed(1);
          if (risk < 8 || risk > 45) continue; // Reasonable scalp risk range

          const tp1 = +(entry + risk).toFixed(1);
          // Target next level or 2.2R
          const higherLevels = levels.filter((l) => l.price > entry + 15);
          const tp2 = higherLevels.length ? +(higherLevels[0].price).toFixed(1) : +(entry + 2.2 * risk).toFixed(1);

          inTrade = {
            day: targetDay,
            tradeNum: dayTrades.length + 1,
            side: 'LONG',
            levelTested: lvl.id,
            levelName: lvl.name,
            entryTs: b.t,
            entryTime: tStr,
            entry,
            sl,
            risk,
            tp1,
            tp2,
            leg1Hit: false,
          };
          break;
        } else if (isShortConfirm) {
          const entry = b.c;
          const sl = Math.max(b.h, prev ? prev.h : b.h) + 2.5; // Stop on prev wick extreme
          const risk = +(sl - entry).toFixed(1);
          if (risk < 8 || risk > 45) continue;

          const tp1 = +(entry - risk).toFixed(1);
          const lowerLevels = levels.filter((l) => l.price < entry - 15);
          const tp2 = lowerLevels.length ? +(lowerLevels[0].price).toFixed(1) : +(entry - 2.2 * risk).toFixed(1);

          inTrade = {
            day: targetDay,
            tradeNum: dayTrades.length + 1,
            side: 'SHORT',
            levelTested: lvl.id,
            levelName: lvl.name,
            entryTs: b.t,
            entryTime: tStr,
            entry,
            sl,
            risk,
            tp1,
            tp2,
            leg1Hit: false,
          };
          break;
        }
      }
    }
  }

  // Day summary
  const totB = dayTrades.reduce((sum, t) => sum + t.pnlRsB, 0);
  const totA = dayTrades.reduce((sum, t) => sum + t.pnlRsA, 0);
  const wins = dayTrades.filter((t) => t.pnlRsB > 0).length;
  const losses = dayTrades.filter((t) => t.pnlRsB < 0).length;
  const bes = dayTrades.filter((t) => t.pnlRsB === 0).length;

  daySummaries.push({
    day: targetDay,
    status: 'COMPLETED',
    trades: dayTrades.length,
    wins,
    losses,
    bes,
    pnlRsB: totB,
    pnlRsA: totA,
    firstRedTime: fmtTime(firstRed15.t),
    sandwichSpan: swSpan.toFixed(1),
  });
}

// Print Output Table
console.log('------------------------------------------------------------------------------------------------------------------------');
console.log('TRADE-BY-TRADE LEDGER ACROSS EXPIRY SESSIONS');
console.log('------------------------------------------------------------------------------------------------------------------------');
console.log(
  'Date'.padEnd(12) +
  '#'.padEnd(4) +
  'Time'.padEnd(8) +
  'Side'.padEnd(7) +
  'Level'.padEnd(10) +
  'Entry'.padEnd(9) +
  'SL'.padEnd(9) +
  'Risk'.padEnd(7) +
  'Exit Time'.padEnd(10) +
  'Outcome'.padEnd(15) +
  'Model B (Rs)'.padEnd(14) +
  'Model A (Rs)'
);
console.log('------------------------------------------------------------------------------------------------------------------------');

for (const t of allTrades) {
  const pnlBStr = (t.pnlRsB >= 0 ? `+Rs ${t.pnlRsB}` : `-Rs ${Math.abs(t.pnlRsB)}`).padEnd(14);
  const pnlAStr = (t.pnlRsA >= 0 ? `+Rs ${t.pnlRsA}` : `-Rs ${Math.abs(t.pnlRsA)}`);
  console.log(
    t.day.padEnd(12) +
    `T${t.tradeNum}`.padEnd(4) +
    t.entryTime.slice(0, 5).padEnd(8) +
    t.side.padEnd(7) +
    t.levelName.padEnd(10) +
    String(t.entry).padEnd(9) +
    String(t.sl).padEnd(9) +
    String(t.risk).padEnd(7) +
    (t.exitTime || '').padEnd(10) +
    t.outcome.padEnd(15) +
    pnlBStr +
    pnlAStr
  );
}

console.log('------------------------------------------------------------------------------------------------------------------------\n');

console.log('========================================================================================');
console.log('                           EXPIRY DAY-BY-DAY PERFORMANCE SUMMARY                        ');
console.log('========================================================================================');
console.log(
  'Date'.padEnd(12) +
  'First Red'.padEnd(11) +
  'Sandwich'.padEnd(11) +
  'Trades'.padEnd(8) +
  'W / L / BE'.padEnd(14) +
  'Win Rate'.padEnd(10) +
  'Model B Net P&L'.padEnd(18) +
  'Model A Net P&L'
);
console.log('----------------------------------------------------------------------------------------');

let totalTradesCount = 0;
let totalWins = 0;
let totalLosses = 0;
let totalBEs = 0;
let grandTotalPnlB = 0;
let grandTotalPnlA = 0;

for (const s of daySummaries) {
  if (s.status === 'NO_RED_BAR') {
    console.log(`${s.day.padEnd(12)} NO RED BAR FORMED (STOOD ASIDE 100% OF DAY)`);
    continue;
  }
  totalTradesCount += s.trades;
  totalWins += s.wins;
  totalLosses += s.losses;
  totalBEs += s.bes;
  grandTotalPnlB += s.pnlRsB;
  grandTotalPnlA += s.pnlRsA;

  const winRate = s.trades > 0 ? `${((s.wins / s.trades) * 100).toFixed(0)}%` : 'N/A';
  const pnlBStr = (s.pnlRsB >= 0 ? `+Rs ${s.pnlRsB}` : `-Rs ${Math.abs(s.pnlRsB)}`).padEnd(18);
  const pnlAStr = (s.pnlRsA >= 0 ? `+Rs ${s.pnlRsA}` : `-Rs ${Math.abs(s.pnlRsA)}`);

  console.log(
    s.day.padEnd(12) +
    s.firstRedTime.slice(0, 5).padEnd(11) +
    `${s.sandwichSpan} pts`.padEnd(11) +
    String(s.trades).padEnd(8) +
    `${s.wins}W / ${s.losses}L / ${s.bes}BE`.padEnd(14) +
    winRate.padEnd(10) +
    pnlBStr +
    pnlAStr
  );
}

console.log('========================================================================================');
const overallWinRate = totalTradesCount > 0 ? `${(((totalWins + totalBEs) / totalTradesCount) * 100).toFixed(1)}%` : 'N/A';
const strictlyProfitableRate = totalTradesCount > 0 ? `${((totalWins / totalTradesCount) * 100).toFixed(1)}%` : 'N/A';

console.log(`TOTAL EXPIRY DAYS EVALUATED: ${expiryDays.length}`);
console.log(`TOTAL TRADES TAKEN:          ${totalTradesCount} (${(totalTradesCount / expiryDays.length).toFixed(1)} trades/day average)`);
console.log(`OUTCOME BREAKDOWN:           ${totalWins} WINS | ${totalBEs} BREAKEVENS (Runner BE) | ${totalLosses} LOSSES`);
console.log(`CAPITAL PRESERVATION RATE:   ${overallWinRate} (Trades ending in Profit or Zero Loss)`);
console.log(`WIN RATE (Strictly Profit):  ${strictlyProfitableRate}`);
console.log(`MODEL B REALIZED NET P&L:    ${grandTotalPnlB >= 0 ? '+' : '-'}Rs ${Math.abs(grandTotalPnlB).toLocaleString('en-IN')}`);
console.log(`MODEL A (ALL-IN) NET P&L:    ${grandTotalPnlA >= 0 ? '+' : '-'}Rs ${Math.abs(grandTotalPnlA).toLocaleString('en-IN')}`);
console.log('========================================================================================\n');
