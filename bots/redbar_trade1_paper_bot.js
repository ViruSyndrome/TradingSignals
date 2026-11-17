'use strict';

/**
 * redbar_trade1_paper_bot.js — Standalone PAPER/RESEARCH bot for Pre-Nov-6 Red Bar DNA "Trade 1 Only":
 *   1. Waits for the first closed 1H Red candle of the NSE day (never marks the opening 09:15 bar).
 *   2. Enters ONLY the first fresh departure ("Trade 1") on 15m close outside the 1H First-Red High/Low.
 *   3. Strictly max 1 trade per IST day (ignores Trade 2, sweeps, POB, 12:45, etc.).
 *   4. Stop = opposite First-Red edge (min 14 pts), 1:1 -> move SL to breakeven, 3R Target (Swing 7-25 DTE ATM).
 * Completely isolated from all live trading bots (PAPER ONLY, separate state file, NOTIFY_TELEGRAM=false default).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const RedBarTrend = require('../archive/nov6-close/js/redbar_trend.js');
const {
  createNotifier,
  loadJsonState,
  saveJsonState,
  completedBars,
  fetchSymbolBars,
  getIstClock,
  resolveSwingOption,
  fetchOptionLiveOrEstExit,
  createDhanClient,
  isDhanConfigured,
} = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'REDBAR_TRADE1_PAPER';
const STATE_PATH = path.join(__dirname, 'state_redbar_trade1.json');
const SYM = 'NIFTY';
const WORK_TF = '15m';
const RED_TF = '1h';
const RED_MS = 3600 * 1000;
const RR_TARGET = Number(process.env.TRADE1_RR || 2.5);
const BE_AT_1R = String(process.env.TRADE1_BE_1R || 'false').toLowerCase() === 'true';
const EOD_EXIT = String(process.env.TRADE1_EOD_EXIT || 'true').toLowerCase() === 'true';
const CLOSE_BACK_CUT = String(process.env.TRADE1_CLOSE_BACK || 'true').toLowerCase() === 'true';
const MAX_RISK_PCT = Number(process.env.TRADE1_MAX_RISK_PCT || 0.015);
const LOTS = Math.max(1, Number(process.env.TRADE1_LOTS || 1));
const MULT = 65;
const FUT_COST_PTS = 9.3;
const OPT_COST_PTS = 1.5;
const MIN_DTE_DAYS = 7;
const MAX_DTE_DAYS = 25;
const POLL_MS = Math.max(30000, Number(process.env.TRADE1_POLL_MS || 90000));

const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');

// Default Telegram OFF so experimental paper results don't clutter live bots unless opted in
if (process.env.NOTIFY_TELEGRAM === undefined) process.env.NOTIFY_TELEGRAM = 'false';
const rawNotify = createNotifier(BOT_NAME);
const notify = async (msg) => {
  if (OFFLINE) {
    const s = typeof msg === 'string' ? msg : String(msg?.text || '');
    console.log(`[${BOT_NAME}][OFFLINE] ${s.replace(/\n/g, ' | ')}`);
    return;
  }
  return rawNotify(msg);
};

function istPartsFast(ts) {
  const ist = new Date(ts + 19800000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return { day: `${y}-${m}-${d}`, mins };
}

function makeDefaultState() {
  return {
    bot: BOT_NAME,
    symbol: SYM,
    workTf: WORK_TF,
    redTf: RED_TF,
    rr: RR_TARGET,
    beAt1R: BE_AT_1R,
    eodExit: EOD_EXIT,
    pos: null,
    lastProcessedTs: 0,
    lastClosePx: null,
    lastBarIso: null,
    takenDays: [],
    trades: [],
    netFutRs: 0,
    netOptRs: 0,
  };
}

function loadOfflineBars(tf) {
  const p = path.join(__dirname, '..', '.cache_desk', `${SYM}_${tf}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.bars || [];
  return arr
    .map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

function buildFirstRedByDay(redBars) {
  const byDay = new Map();
  for (const b of redBars) {
    const { day } = istPartsFast(b.t);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  const map = new Map();
  for (const [day, list] of byDay.entries()) {
    // Skip day's opening candle (index 0); take first closed red bar after open
    for (let j = 1; j < list.length; j++) {
      const bar = list[j];
      if (bar.c < bar.o) {
        map.set(day, { high: bar.h, low: bar.l, open: bar.o, close: bar.c, t: bar.t, closeTs: bar.t + RED_MS });
        break;
      }
    }
  }
  return map;
}

async function scanOnce(dhan, botState) {
  const activeDhan = OFFLINE ? null : (dhan || (isDhanConfigured() ? createDhanClient() : null));
  const workBars = OFFLINE ? loadOfflineBars(WORK_TF) : completedBars(await fetchSymbolBars(activeDhan, SYM, WORK_TF, 25), WORK_TF);
  const redBars = OFFLINE ? loadOfflineBars(RED_TF) : completedBars(await fetchSymbolBars(activeDhan, SYM, RED_TF, 25), RED_TF);
  if (workBars.length < 30 || redBars.length < 10) return;

  const firstRedMap = buildFirstRedByDay(redBars);
  const takenSet = new Set(Array.isArray(botState.takenDays) ? botState.takenDays : []);
  const startT = OFFLINE ? Math.max(workBars[0].t, redBars[0].t) : 0;
  const endT = OFFLINE ? Math.min(workBars[workBars.length - 1].t, redBars[redBars.length - 1].t + RED_MS) : Infinity;

  const startIdx = botState.lastProcessedTs > 0
    ? workBars.findIndex((b) => b.t > botState.lastProcessedTs)
    : (OFFLINE ? 1 : workBars.length - 1);
  if (startIdx < 0) return;

  for (let i = Math.max(1, startIdx); i < workBars.length; i++) {
    const b = workBars[i];
    if (b.t < startT || b.t > endT) continue;
    const isLatest = i >= workBars.length - 2;
    const { day, mins } = istPartsFast(b.t);

    if (botState.pos) {
      const pos = botState.pos;
      if (BE_AT_1R && !pos.be) {
        const hit1R = pos.side === 'LONG' ? b.h >= pos.entry + pos.risk : b.l <= pos.entry - pos.risk;
        if (hit1R) {
          pos.be = true;
          pos.sl = pos.entry;
        }
      }
      let exitPx = null;
      let reason = null;
      if ((pos.side === 'LONG' && b.l <= pos.sl) || (pos.side === 'SHORT' && b.h >= pos.sl)) {
        exitPx = pos.sl;
        reason = pos.be ? 'BE_STOP' : 'SL_HIT';
      } else if ((pos.side === 'LONG' && b.h >= pos.tp) || (pos.side === 'SHORT' && b.l <= pos.tp)) {
        exitPx = pos.tp;
        reason = `TP_${RR_TARGET}R`;
      } else if (CLOSE_BACK_CUT && ((pos.side === 'LONG' && b.c < pos.frHigh) || (pos.side === 'SHORT' && b.c > pos.frLow))) {
        exitPx = b.c;
        reason = 'CLOSE_BACK_CUT';
      } else if (EOD_EXIT && day === pos.day && mins >= 15 * 60 + 10) {
        exitPx = b.c;
        reason = 'EOD_1510';
      } else if (!OFFLINE && pos.expiry && pos.expiry === day && mins >= 15 * 60 + 10) {
        exitPx = b.c;
        reason = 'EXPIRY_1510';
      }

      if (exitPx !== null) {
        const grossIdx = pos.side === 'LONG' ? exitPx - pos.entry : pos.entry - exitPx;
        const netFutPts = +(grossIdx - FUT_COST_PTS).toFixed(2);
        const netFutRs = Math.round(netFutPts * MULT * LOTS);
        const exitOpt = await fetchOptionLiveOrEstExit({
          dhan: activeDhan,
          securityId: pos.optSecurityId,
          live: pos.optLive,
          side: pos.side,
          entryIdx: pos.entry,
          entryOpt: pos.entryOpt,
          exitIdx: exitPx,
          delta: pos.delta || 0.58,
          entryTs: pos.entryTs,
          exitTs: b.t,
          offline: OFFLINE,
        });
        const netOptPts = +(exitOpt - pos.entryOpt - OPT_COST_PTS).toFixed(2);
        const netOptRs = Math.round(netOptPts * MULT * LOTS);

        botState.netFutRs = Math.round((botState.netFutRs || 0) + netFutRs);
        botState.netOptRs = Math.round((botState.netOptRs || 0) + netOptRs);
        botState.trades.push({
          day: pos.day,
          side: pos.side,
          reason,
          entry: pos.entry,
          exit: exitPx,
          grossIdx: +grossIdx.toFixed(2),
          netFutRs,
          netOptRs,
        });
        if (botState.trades.length > 300) botState.trades.shift();
        botState.pos = null;
        if (!OFFLINE || isLatest) {
          const wins = botState.trades.filter((x) => x.netOptRs > 0).length;
          await notify(
            `${netOptRs >= 0 ? '✅' : '🛑'} [TRADE 1 PAPER EXIT] ${SYM} ${pos.side} (${reason}) | ` +
            `Idx ${pos.entry.toFixed(1)}→${exitPx.toFixed(1)} (Fut ₹${netFutRs}) | Opt ₹${pos.entryOpt}→₹${exitOpt} (Opt ₹${netOptRs}) | ${wins}W/${botState.trades.length - wins}L`
          );
        }
      }
    } else if (!takenSet.has(day) && mins >= 9 * 60 + 25 && mins <= 14 * 60 + 45) {
      const fr = OFFLINE
        ? firstRedMap.get(day)
        : RedBarTrend.firstRedBarOfSession(redBars, day, { dayMode: 'ist', asOfTs: b.t + 900000, barMs: RED_MS });
      const closeTs = fr ? (fr.closeTs || (fr.t + RED_MS)) : Infinity;
      if (fr && b.t + 900000 >= closeTs) {
        const prev = workBars[i - 1];
        if (istPartsFast(prev.t).day === day) {
          const leftAbove = b.c > fr.high && prev.c <= fr.high;
          const leftBelow = b.c < fr.low && prev.c >= fr.low;
          if (leftAbove || leftBelow) {
            const side = leftAbove ? 'LONG' : 'SHORT';
            const rawSl = side === 'LONG' ? fr.low : fr.high;
            const risk = Math.max(14, Math.abs(b.c - rawSl));
            if (risk / b.c <= MAX_RISK_PCT) {
              const sl = +(side === 'LONG' ? b.c - risk : b.c + risk).toFixed(2);
              const tp = +(side === 'LONG' ? b.c + risk * RR_TARGET : b.c - risk * RR_TARGET).toFixed(2);
              const optSnap = await resolveSwingOption({
                dhan: activeDhan,
                side,
                spot: b.c,
                minDteDays: MIN_DTE_DAYS,
                maxDteDays: MAX_DTE_DAYS,
                strikeMode: 'atm',
                offline: OFFLINE,
              });
              takenSet.add(day);
              botState.takenDays = [...takenSet].slice(-90);
              botState.pos = {
                day,
                side,
                entry: b.c,
                sl,
                tp,
                risk: +risk.toFixed(2),
                entryTs: b.t,
                frHigh: fr.high,
                frLow: fr.low,
                be: false,
                optLabel: optSnap.label,
                expiry: optSnap.expiry || null,
                optSecurityId: optSnap.securityId,
                optLive: optSnap.live,
                entryOpt: optSnap.premium,
                delta: optSnap.delta,
              };
              if (!OFFLINE || isLatest) {
                await notify(
                  `🟢 [TRADE 1 PAPER ENTER] ${SYM} ${side} | Entry ${b.c.toFixed(1)} | SL ${sl} | ${RR_TARGET}R TP ${tp} | Opt ${optSnap.label} @ ₹${optSnap.premium}`
                );
              }
            }
          }
        }
      }
    }

    botState.lastProcessedTs = b.t;
    botState.lastClosePx = b.c;
    botState.lastBarIso = new Date(b.t).toISOString();
  }
}

async function main() {
  const botState = OFFLINE ? makeDefaultState() : loadJsonState(STATE_PATH, makeDefaultState);
  const dhan = !OFFLINE && isDhanConfigured() ? createDhanClient() : null;
  console.log(`[${BOT_NAME}] Starting (${OFFLINE ? 'OFFLINE REPLAY' : 'PAPER LIVE'}) | ${SYM} ${WORK_TF} (Red=${RED_TF}) | RR=${RR_TARGET} | BE_1R=${BE_AT_1R} | EOD=${EOD_EXIT}`);

  await scanOnce(dhan, botState);
  if (OFFLINE) {
    const tr = botState.trades;
    const fWins = tr.filter((t) => t.netFutRs > 0).length;
    const oWins = tr.filter((t) => t.netOptRs > 0).length;
    console.log(
      `\n=== OFFLINE TRADE 1 ONLY SUMMARY (${SYM}, 1H First-Red + 15m Leave, Max 1/day) ===\n` +
      `Trades=${tr.length} | FutWR=${tr.length ? ((fWins / tr.length) * 100).toFixed(1) : '0.0'}% Net=₹${botState.netFutRs} | OptWR=${tr.length ? ((oWins / tr.length) * 100).toFixed(1) : '0.0'}% Net=₹${botState.netOptRs}`
    );
    return;
  }

  saveJsonState(STATE_PATH, botState);
  if (ONCE) return;

  setInterval(async () => {
    try {
      const clk = getIstClock();
      if (!clk.isOpen) return;
      await scanOnce(dhan, botState);
      saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Poll error:`, e.message);
    }
  }, POLL_MS);
}

main().catch((e) => {
  console.error(`[${BOT_NAME}] Fatal error:`, e.message);
  process.exit(1);
});
