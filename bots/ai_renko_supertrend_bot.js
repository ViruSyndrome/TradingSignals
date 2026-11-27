'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { calculateAIRenkoSupertrend } = require('../js/ai_renko_supertrend.js');
const {
  createNotifier,
  loadJsonState,
  saveJsonState,
  completedBars,
  fetchSymbolBars,
  getIstClock,
  getSpotLtp,
  resolveSwingOption,
  fetchOptionLiveOrEstExit,
  executeOptionSwingOrder,
  createDhanClient,
  isDhanConfigured,
} = require('../js/futures_bot_runtime.js');

const SYM = String(process.env.AI_RENKO_SYMBOL || 'NIFTY').toUpperCase();
const BOT_NAME = process.env.AI_RENKO_BOT_NAME || (SYM === 'NIFTY' ? 'AI_RENKO_ST' : `AI_RENKO_${SYM}`);
const STATE_PATH = path.resolve(
  __dirname,
  process.env.AI_RENKO_STATE_FILE || (SYM === 'NIFTY' ? 'state_ai_renko_st.json' : `state_ai_renko_${SYM.toLowerCase()}_st.json`)
);
const OPT_SEG = SYM === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
const TF = process.env.AI_RENKO_TF || '15m';
const ATR_LENGTH = Number(process.env.AI_RENKO_ATR_LEN || 14);
const BASE_FACTOR = Number(process.env.AI_RENKO_FACTOR || 3);
const BRICK_SIZE = Number(process.env.AI_RENKO_BRICK || (SYM === 'SENSEX' ? 125 : 33.33));
const BRICK_PCT = Number(process.env.AI_RENKO_BRICK_PCT || 0);
const CHOPPY_FILTER = String(process.env.AI_RENKO_ADX_FILTER || 'false').toLowerCase() === 'true';
const ADX_THRESHOLD = Number(process.env.AI_RENKO_ADX_THRESH || 15);

// Mode B Profit-Lock parameters (point defaults or % overrides via *_PCT)
const MODE_B_TRIGGER_PTS = Number(process.env.AI_RENKO_LOCK_TRIG || (SYM === 'SENSEX' ? 250 : 66.66));
const MODE_B_LOCK_PTS = Number(process.env.AI_RENKO_LOCK_FLOOR || (SYM === 'SENSEX' ? 90 : 25.0));
const MODE_B_TRIGGER_PCT = Number(process.env.AI_RENKO_LOCK_TRIG_PCT || 0);
const MODE_B_LOCK_PCT = Number(process.env.AI_RENKO_LOCK_FLOOR_PCT || 0);

// Mode C Hybrid Smart-Lock + Tail-Risk Cap + Theta Guard + 5x ATR Trail + Stage 3 Blow-Off Trail:
const MODE_C_TRIGGER_PTS = Number(process.env.AI_RENKO_C_TRIG || (SYM === 'SENSEX' ? 400 : 120.0));
const MODE_C_LOCK_PTS = Number(process.env.AI_RENKO_C_FLOOR || (SYM === 'SENSEX' ? 100 : 30.0));
const MODE_C_CAP_SL_PTS = Number(process.env.AI_RENKO_C_CAP_SL || (SYM === 'SENSEX' ? 630 : 150.0));
const MODE_C_THETA_HRS = Math.max(0, Number(process.env.AI_RENKO_C_THETA_HRS ?? 36.0));
const MODE_C_THETA_FLOOR_PTS = Number(process.env.AI_RENKO_C_THETA_FLOOR ?? (SYM === 'SENSEX' ? 165 : 50.0));
const MODE_C_ATR_TRIG_PTS = Math.max(0, Number(process.env.AI_RENKO_C_ATR_TRIG ?? (SYM === 'SENSEX' ? 600 : 180.0)));
const MODE_C_ATR_MULT = Math.max(0.5, Number(process.env.AI_RENKO_C_ATR_MULT ?? 5.0));
const MODE_C_STAGE3_TRIG_PTS = Math.max(0, Number(process.env.AI_RENKO_C_STAGE3_TRIG ?? (SYM === 'SENSEX' ? 2100 : 700.0)));
const MODE_C_STAGE3_GIVE_PTS = Math.max(10, Number(process.env.AI_RENKO_C_STAGE3_GIVE ?? (SYM === 'SENSEX' ? 500 : 150.0)));
const MODE_C_TRIGGER_PCT = Number(process.env.AI_RENKO_C_TRIG_PCT || 0);
const MODE_C_LOCK_PCT = Number(process.env.AI_RENKO_C_FLOOR_PCT || 0);
const MODE_C_CAP_SL_PCT = Number(process.env.AI_RENKO_C_CAP_SL_PCT || 0);
const MODE_C_THETA_FLOOR_PCT = Number(process.env.AI_RENKO_C_THETA_FLOOR_PCT || 0);
const MODE_C_ATR_TRIG_PCT = Number(process.env.AI_RENKO_C_ATR_TRIG_PCT || 0);
const MODE_C_STAGE3_TRIG_PCT = Number(process.env.AI_RENKO_C_STAGE3_TRIG_PCT || 0);
const MODE_C_STAGE3_GIVE_PCT = Number(process.env.AI_RENKO_C_STAGE3_GIVE_PCT || 0);
const BOOT_PING_COOLDOWN_MS = 30 * 60 * 1000;
const FEED_ERR_LOG_COOLDOWN_MS = 15 * 60 * 1000;

const LOTS = Math.max(1, Number(process.env.AI_RENKO_LOTS || 1));
const MULT = Number(process.env.AI_RENKO_MULT || (SYM === 'SENSEX' ? 20 : 65));
const FUT_COST_PTS = SYM === 'SENSEX' ? 24.0 : 9.3;
const OPT_COST_PTS = Number(process.env.AI_RENKO_OPT_COST_PTS || (SYM === 'SENSEX' ? 4.5 : 1.5));
const FUT_CAPITAL_RS = Number(process.env.AI_RENKO_FUT_CAPITAL_RS || 200000);
const OPT_CAPITAL_RS = Number(process.env.AI_RENKO_OPT_CAPITAL_RS || 37790);
const MIN_DTE_DAYS = Math.max(0, Number(process.env.AI_RENKO_MIN_DTE || 7));
const MAX_DTE_DAYS = Math.max(MIN_DTE_DAYS + 7, Number(process.env.AI_RENKO_MAX_DTE || 25));
const STRIKE_MODE = String(process.env.AI_RENKO_STRIKE_MODE || 'atm').toLowerCase();

const POLL_MS = Math.max(15000, Number(process.env.AI_RENKO_POLL_MS || 60000));
const INTRABAR_POLL_MS = Math.max(5000, Number(process.env.AI_RENKO_INTRABAR_POLL_MS || 15000));
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');
const AUTO_TRADE = !OFFLINE && String(process.env.AI_RENKO_AUTO_TRADE || 'false').toLowerCase() === 'true';
const PATRICK_STATE_PATH = path.join(__dirname, 'state_patrick_futures.json');
const EXIT_ON_OPPOSITE_REDBAR = String(process.env.AI_RENKO_EXIT_ON_REDBAR || 'true').toLowerCase() === 'true';
const PAUSE_ON_PATRICK = String(process.env.AI_RENKO_PAUSE_ON_PATRICK || 'opposite').toLowerCase(); // 'opposite' | 'all' | 'none'
const PATRICK_RESERVE_RS = Math.max(0, Number(process.env.AI_RENKO_PATRICK_RESERVE_RS ?? 20000));
const TG_MODE_C_ONLY = String(process.env.AI_RENKO_TG_MODE_C_ONLY || 'true').toLowerCase() === 'true';

/**
 * Self-contained native 1H First-Red + 15m StrongClose (>=0.70) signal map built purely from this symbol's 15m bars.
 * Zero cross-bot dependencies and zero extra Dhan API calls; SENSEX uses SENSEX bars, NIFTY uses NIFTY bars.
 */
function buildNative1hFirstRedSignals(bars15m) {
  const istParts = (ts) => {
    const d = new Date(ts + 19800000);
    return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
  };
  // Aggregate 15m bars into NSE/BSE 1H candles anchored to 09:15 IST (09:15, 10:15, 11:15, ...)
  const byDaySlot = new Map();
  for (const b of bars15m) {
    const { day, mins } = istParts(b.t);
    if (mins < 555 || mins > 930) continue;
    const slot = Math.floor((mins - 555) / 60);
    const key = `${day}|${slot}`;
    let cur = byDaySlot.get(key);
    if (!cur) {
      cur = { day, slot, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, closeTs: b.t + 3600000 };
      byDaySlot.set(key, cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  const byDay1h = new Map();
  for (const h1 of byDaySlot.values()) {
    if (!byDay1h.has(h1.day)) byDay1h.set(h1.day, []);
    byDay1h.get(h1.day).push(h1);
  }
  // Skip opening 09:15-10:15 candle (slot 0); take first closed 1H Red candle after open
  const firstRedByDay = new Map();
  for (const [day, list] of byDay1h.entries()) {
    list.sort((a, b) => a.slot - b.slot);
    for (let j = 1; j < list.length; j++) {
      if (list[j].c < list[j].o) {
        firstRedByDay.set(day, list[j]);
        break;
      }
    }
  }
  const sigMap = new Map();
  const takenDays = new Set();
  for (let i = 1; i < bars15m.length; i++) {
    const b = bars15m[i];
    const { day, mins } = istParts(b.t);
    if (takenDays.has(day) || mins < 565 || mins > 885) continue;
    const fr = firstRedByDay.get(day);
    if (!fr || b.t + 900000 < fr.closeTs) continue;
    const prev = bars15m[i - 1];
    if (istParts(prev.t).day !== day) continue;
    const leftUp = b.c > fr.h && prev.c <= fr.h;
    const leftDn = b.c < fr.l && prev.c >= fr.l;
    if (!leftUp && !leftDn) continue;
    const side = leftUp ? 'LONG' : 'SHORT';
    const rng = Math.max(1e-6, b.h - b.l);
    const closeLoc = side === 'LONG' ? (b.c - b.l) / rng : (b.h - b.c) / rng;
    if (closeLoc < 0.70) continue;
    const risk = Math.max(12, Math.abs(b.c - (side === 'LONG' ? fr.l : fr.h)));
    if (risk / b.c > 0.015) continue;
    takenDays.add(day);
    sigMap.set(b.t, side);
  }
  return sigMap;
}

function getActivePatrickPosition() {
  if (OFFLINE) return null;
  try {
    if (!fs.existsSync(PATRICK_STATE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(PATRICK_STATE_PATH, 'utf8'));
    const pos = raw?.bySymbol?.[SYM]?.pos;
    return pos && pos.side ? pos : null;
  } catch {
    return null;
  }
}

const rawNotify = createNotifier(BOT_NAME);
const notify = async (msg) => {
  if (OFFLINE) {
    const s = typeof msg === 'string' ? msg : String(msg?.text || '');
    console.log(`[${BOT_NAME}][OFFLINE] ${s.replace(/\n/g, ' | ')}`);
    return;
  }
  return rawNotify(msg);
};

function loadOfflineBars(sym, tf) {
  const p = path.join(__dirname, '..', '.cache_desk', `${sym}_${tf}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.bars || [];
  return arr
    .map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

function makeEmptyBook(capitalRs) {
  return {
    pos: null, // { side: 'LONG'|'SHORT', entryIdx, entryOpt, optLabel, delta, entryTs, locked, stLine }
    trades: 0,
    wins: 0,
    grossPts: 0,
    netPts: 0,
    netRs: 0,
    optTrades: 0,
    optWins: 0,
    optNetPts: 0,
    optNetRs: 0,
    capitalRs,
    recentTrades: [],
  };
}

function makeDefaultBotState() {
  return {
    bot: BOT_NAME,
    symbol: SYM,
    tf: TF,
    settings: {
      atrLength: ATR_LENGTH,
      baseFactor: BASE_FACTOR,
      manualBrickSize: BRICK_SIZE,
      choppyFilterAdx: CHOPPY_FILTER,
      adxThreshold: ADX_THRESHOLD,
      modeBTriggerPts: MODE_B_TRIGGER_PTS,
      modeBLockPts: MODE_B_LOCK_PTS,
      modeCTriggerPts: MODE_C_TRIGGER_PTS,
      modeCLockPts: MODE_C_LOCK_PTS,
      modeCCapSlPts: MODE_C_CAP_SL_PTS,
      modeCThetaHrs: MODE_C_THETA_HRS,
      modeCThetaFloorPts: MODE_C_THETA_FLOOR_PTS,
      modeCAtrTrigPts: MODE_C_ATR_TRIG_PTS,
      modeCAtrMult: MODE_C_ATR_MULT,
      modeCStage3TrigPts: MODE_C_STAGE3_TRIG_PTS,
      modeCStage3GivePts: MODE_C_STAGE3_GIVE_PTS,
    },
    lots: LOTS,
    lastProcessedTs: 0,
    lastBootPingAt: 0,
    lastClosePx: 0,
    lastBarIso: null,
    lastTrend: 0,
    lastSupertrend: 0,
    modeA: makeEmptyBook(FUT_CAPITAL_RS),
    modeB: makeEmptyBook(FUT_CAPITAL_RS),
    modeC: makeEmptyBook(FUT_CAPITAL_RS),
  };
}

async function resolveOptionSnapshot(dhan, side, spot) {
  return resolveSwingOption({
    dhan,
    instrumentId: SYM,
    side,
    spot,
    minDteDays: MIN_DTE_DAYS,
    maxDteDays: MAX_DTE_DAYS,
    strikeMode: STRIKE_MODE,
    offline: OFFLINE,
  });
}

async function fetchOptionExitPremium(dhan, pos, currentSpot) {
  return fetchOptionLiveOrEstExit({
    dhan,
    securityId: pos.optSecurityId,
    exchangeSegment: pos.optSeg || OPT_SEG,
    live: pos.optLive,
    side: pos.side,
    entryIdx: pos.entryIdx,
    entryOpt: pos.entryOpt,
    exitIdx: currentSpot,
    delta: pos.delta,
    entryTs: pos.entryTs,
    exitTs: pos.exitTs,
    offline: OFFLINE,
  });
}

function recordClosedTrade(book, pos, exitIdxPx, exitOptPx, reason) {
  const grossIdx = pos.side === 'LONG' ? (exitIdxPx - pos.entryIdx) : (pos.entryIdx - exitIdxPx);
  const netIdx = grossIdx - FUT_COST_PTS;
  const netFutRs = Math.round(netIdx * MULT * LOTS);

  const grossOpt = exitOptPx - pos.entryOpt;
  const netOpt = grossOpt - OPT_COST_PTS;
  const netOptRs = Math.round(netOpt * MULT * LOTS);

  book.trades += 1;
  if (netIdx > 0) book.wins += 1;
  book.grossPts = +(book.grossPts + grossIdx).toFixed(2);
  book.netPts = +(book.netPts + netIdx).toFixed(2);
  book.netRs += netFutRs;

  book.optTrades += 1;
  if (netOpt > 0) book.optWins += 1;
  book.optNetPts = +(book.optNetPts + netOpt).toFixed(2);
  book.optNetRs += netOptRs;

  book.recentTrades.push({
    side: pos.side,
    optLabel: pos.optLabel,
    entryIdx: +pos.entryIdx.toFixed(2),
    exitIdx: +exitIdxPx.toFixed(2),
    netIdx: +netIdx.toFixed(2),
    netFutRs,
    entryOpt: pos.entryOpt,
    exitOpt: exitOptPx,
    netOpt: +netOpt.toFixed(2),
    netOptRs,
    reason,
    exitIso: new Date().toISOString(),
  });
  if (book.recentTrades.length > 40) book.recentTrades.shift();

  return { netIdx, netFutRs, netOpt, netOptRs };
}

function resolveModeThresholds(cfg, entryIdx) {
  const px = Number(entryIdx) || 0;
  const pick = (pct, pts) => (pct > 0 && px > 0 ? +(px * pct).toFixed(2) : pts);
  return {
    trig: pick(cfg.trigPct, cfg.trig),
    floor: pick(cfg.floorPct, cfg.floor),
    capSl: Number.isFinite(cfg.capSl) ? pick(cfg.capSlPct, cfg.capSl) : Infinity,
    thetaHrs: cfg.thetaHrs || 0,
    thetaFloorPts: pick(cfg.thetaFloorPct, cfg.thetaFloorPts || 0),
    atrTrigPts: pick(cfg.atrTrigPct, cfg.atrTrigPts || 0),
    atrMult: cfg.atrMult || 5.0,
    stage3TrigPts: pick(cfg.stage3TrigPct, cfg.stage3TrigPts || 0),
    stage3GivePts: pick(cfg.stage3GivePct, cfg.stage3GivePts || 0),
  };
}

const PROTECTED_MODES = [
  {
    key: 'modeB',
    tag: '[MODE B - 70% WR Lock]',
    lockTag: '[MODE B - Profit Lock]',
    entryLabel: `Mode B (+${MODE_B_TRIGGER_PTS}p -> +${MODE_B_LOCK_PTS}p)`,
    trig: MODE_B_TRIGGER_PTS,
    floor: MODE_B_LOCK_PTS,
    trigPct: MODE_B_TRIGGER_PCT,
    floorPct: MODE_B_LOCK_PCT,
    capSl: Infinity,
  },
  {
    key: 'modeC',
    tag: '[MODE C - Smart Lock+Cap]',
    lockTag: '[MODE C - Smart Lock]',
    entryLabel: `Mode C (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, ${MODE_C_THETA_HRS}h -> +${MODE_C_THETA_FLOOR_PTS}p, ATR ${MODE_C_ATR_MULT}x @ +${MODE_C_ATR_TRIG_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p, S3 +${MODE_C_STAGE3_TRIG_PTS}p/-${MODE_C_STAGE3_GIVE_PTS}p)`,
    trig: MODE_C_TRIGGER_PTS,
    floor: MODE_C_LOCK_PTS,
    capSl: MODE_C_CAP_SL_PTS,
    thetaHrs: MODE_C_THETA_HRS,
    thetaFloorPts: MODE_C_THETA_FLOOR_PTS,
    atrTrigPts: MODE_C_ATR_TRIG_PTS,
    atrMult: MODE_C_ATR_MULT,
    stage3TrigPts: MODE_C_STAGE3_TRIG_PTS,
    stage3GivePts: MODE_C_STAGE3_GIVE_PTS,
    trigPct: MODE_C_TRIGGER_PCT,
    floorPct: MODE_C_LOCK_PCT,
    capSlPct: MODE_C_CAP_SL_PCT,
    thetaFloorPct: MODE_C_THETA_FLOOR_PCT,
    atrTrigPct: MODE_C_ATR_TRIG_PCT,
    stage3TrigPct: MODE_C_STAGE3_TRIG_PCT,
    stage3GivePct: MODE_C_STAGE3_GIVE_PCT,
  },
];

let lastFeedErrAt = 0;
let lastFeedErrMsg = '';

async function closeModeBookPosition(cfg, book, pos, exitPx, reason, activeDhan, isLatestBar) {
  pos.exitTs = pos.exitTs || Date.now();
  let execNote = '';
  if (cfg.key === 'modeC' && AUTO_TRADE && pos.liveOrderPlaced && pos.optSecurityId) {
    try {
      const ord = await executeOptionSwingOrder(activeDhan, {
        autoTrade: true,
        securityId: pos.optSecurityId,
        exchangeSegment: pos.optSeg || OPT_SEG,
        txType: 'SELL',
        lots: LOTS,
        qtyPerLot: MULT,
        tag: `RNK_${reason}`.slice(0, 12),
      });
      execNote = ord.placed ? `\nBroker EXIT Order: ${ord.orderId || 'OK'}` : `\nBroker EXIT Skipped: ${ord.reason}`;
    } catch (e) {
      execNote = `\n⚠️ Broker EXIT Error: ${e.message}`;
    }
  }
  const exitOptPx = await fetchOptionExitPremium(activeDhan, pos, exitPx);
  const res = recordClosedTrade(book, pos, exitPx, exitOptPx, reason);
  const wr = ((book.wins / book.trades) * 100).toFixed(1);
  const optWr = ((book.optWins / book.optTrades) * 100).toFixed(1);
  book.pos = null;

  if (!OFFLINE || isLatestBar) {
    const modeLabel = cfg.key === 'modeC' && AUTO_TRADE ? 'LIVE' : 'PAPER';
    const msg =
      `📙 ${cfg.tag} (${modeLabel}) EXIT ${pos.side} ${SYM} ${TF} (${reason})\n` +
      `Index: ${pos.entryIdx.toFixed(2)} → ${exitPx.toFixed(2)} | Net: ${res.netIdx >= 0 ? '+' : ''}${res.netIdx.toFixed(1)} pts (₹${res.netFutRs})\n` +
      `Option (${pos.optLabel}): ₹${pos.entryOpt} → ₹${exitOptPx} | Net: ${res.netOpt >= 0 ? '+' : ''}${res.netOpt.toFixed(1)} pts (₹${res.netOptRs})\n` +
      `Stats: ${book.trades} tr | Fut WR ${wr}% (Net ₹${book.netRs}) | Opt WR ${optWr}% (Net ₹${book.optNetRs})${execNote}`;
    if (!TG_MODE_C_ONLY || cfg.key === 'modeC') {
      if (cfg.key === 'modeC' && !OFFLINE) {
        const won = res.netOptRs >= 0;
        await notify({
          text: msg,
          card: {
            kind: won ? 'WIN' : 'LOSS',
            title: `AI RENKO MODE C • ${SYM} ${TF}`,
            subtitle: `${pos.side} ${reason}`,
            execBadge: AUTO_TRADE ? 'LIVE OPTIONS' : 'PAPER',
            levels: [
              { price: pos.entryIdx, label: `ENTRY ${pos.entryIdx.toFixed(1)}`, color: '#94a3b8', dash: '3 3' },
              { price: exitPx, label: `EXIT ${exitPx.toFixed(1)}`, color: won ? '#22c55e' : '#ef4444' },
            ],
            metrics: [
              { label: 'Option Contract', value: pos.optLabel, sub: `${LOTS} lot (${LOTS * MULT})` },
              { label: 'Option Exit', value: `₹${pos.entryOpt} → ₹${exitOptPx}`, sub: `${res.netOpt >= 0 ? '+' : ''}${res.netOpt.toFixed(1)} pts`, color: won ? '#22c55e' : '#f43f5e' },
              { label: 'Trade Net P&L', value: `${res.netOptRs >= 0 ? '+' : ''}₹${res.netOptRs}`, sub: `${res.netIdx >= 0 ? '+' : ''}${res.netIdx.toFixed(1)} idx pts`, color: won ? '#22c55e' : '#f43f5e' },
              { label: 'Scoreboard (Opt)', value: `${book.optTrades} tr • ${optWr}% WR`, sub: `Net ₹${book.optNetRs}` },
            ],
            footer: `Mode C (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, ${MODE_C_THETA_HRS}h -> +${MODE_C_THETA_FLOOR_PTS}p, ATR ${MODE_C_ATR_MULT}x @ +${MODE_C_ATR_TRIG_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p, S3 +${MODE_C_STAGE3_TRIG_PTS}p/-${MODE_C_STAGE3_GIVE_PTS}p)`,
          },
        });
      } else {
        await notify(msg);
      }
    } else {
      console.log(`[${BOT_NAME}] ${msg.replace(/\n/g, ' | ')}`);
    }
  }
}

function ratchetFloor(cur, cand, side) {
  if (cur == null) return cand;
  return side === 'LONG' ? (cand > cur ? cand : cur) : (cand < cur ? cand : cur);
}

function hitFloor(px, floor, side) {
  return floor != null && (side === 'LONG' ? px <= floor : px >= floor);
}

function updateModeStage3(th, pos, highPx, lowPx) {
  const fav = pos.side === 'LONG' ? highPx - pos.entryIdx : pos.entryIdx - lowPx;
  if (fav > (pos.peakFavPts || 0)) pos.peakFavPts = +fav.toFixed(2);
  if (!th.stage3TrigPts || th.stage3TrigPts <= 0 || (pos.peakFavPts || 0) < th.stage3TrigPts) return false;
  const wasArmed = pos.stage3Floor != null;
  const cand = +(pos.side === 'LONG' ? pos.entryIdx + (pos.peakFavPts - th.stage3GivePts) : pos.entryIdx - (pos.peakFavPts - th.stage3GivePts)).toFixed(2);
  pos.stage3Floor = ratchetFloor(pos.stage3Floor, cand, pos.side);
  return !wasArmed && pos.stage3Floor != null;
}

function updateModeThetaGuard(th, pos, nowMs) {
  if (!th.thetaHrs || th.thetaHrs <= 0 || !pos.locked || pos.thetaBoosted) return false;
  if ((nowMs - pos.entryTs) / 3600000 < th.thetaHrs) return false;
  const cand = +(pos.side === 'LONG' ? pos.entryIdx + th.thetaFloorPts : pos.entryIdx - th.thetaFloorPts).toFixed(2);
  pos.lockPrice = ratchetFloor(pos.lockPrice, cand, pos.side);
  pos.thetaBoosted = true;
  return true;
}

function updateModeAtrTrail(th, pos, atrPx) {
  if (!th.atrTrigPts || th.atrTrigPts <= 0 || !(atrPx > 0) || (pos.peakFavPts || 0) < th.atrTrigPts) return false;
  const wasArmed = pos.atrTrailFloor != null;
  const rawLockPts = pos.peakFavPts - th.atrMult * atrPx;
  const lockPts = pos.locked ? Math.max(th.floor || 0, rawLockPts) : rawLockPts;
  const cand = +(pos.side === 'LONG' ? pos.entryIdx + lockPts : pos.entryIdx - lockPts).toFixed(2);
  pos.atrTrailFloor = ratchetFloor(pos.atrTrailFloor, cand, pos.side);
  return !wasArmed && pos.atrTrailFloor != null;
}

async function advanceModeProtections(cfg, pos, highPx, lowPx, atrPx, nowMs, tagPrefix) {
  const th = resolveModeThresholds(cfg, pos.entryIdx);
  const canPing = !OFFLINE && (!TG_MODE_C_ONLY || cfg.key === 'modeC');
  if (!pos.locked) {
    const triggered = pos.side === 'LONG' ? highPx >= pos.entryIdx + th.trig : lowPx <= pos.entryIdx - th.trig;
    if (triggered) {
      pos.locked = true;
      pos.lockPrice = +(pos.side === 'LONG' ? pos.entryIdx + th.floor : pos.entryIdx - th.floor).toFixed(2);
      if (canPing) {
        await notify(
          `🔒 ${cfg.lockTag}${tagPrefix} ${SYM} ${TF} ${pos.side} hit +${th.trig} pts!\n` +
          `Floor Stop locked at ${pos.lockPrice} (+${th.floor} pts)`
        );
      }
    }
  }
  const s3Armed = updateModeStage3(th, pos, highPx, lowPx);
  if (updateModeThetaGuard(th, pos, nowMs) && canPing) {
    await notify(
      `⏱️ [MODE C - Theta Guard] ${SYM} held >=${th.thetaHrs}h → Floor raised to ${pos.lockPrice} (+${th.thetaFloorPts}p)`
    );
  }
  if (updateModeAtrTrail(th, pos, atrPx) && canPing) {
    await notify(
      `📈 [MODE C - ${th.atrMult}x ATR Trail] ARMED @ +${pos.peakFavPts}p (ATR ${atrPx.toFixed(1)})!\n` +
      `Trailing Floor at ${pos.atrTrailFloor}`
    );
  }
  if (s3Armed && canPing) {
    await notify(
      `🚀 [MODE C - Stage 3 Blow-Off Trail] ARMED @ +${pos.peakFavPts}p!\n` +
      `Trailing Floor at ${pos.stage3Floor} (Peak - ${th.stage3GivePts}p)`
    );
  }
}

let intrabarBusy = false;
let scanBusy = false;

/**
 * Evaluate real-time intrabar Spot triggers for Mode C (+lock, theta boost, 5x ATR trail, hard cap SL, Stage 3, expiry close).
 * Returns true if Mode C position state changed (closed or lock/trail advanced) so callers can persist immediately.
 */
async function checkModeCLiveIntrabar(activeDhan, botState) {
  if (intrabarBusy) return false;
  const cfg = PROTECTED_MODES.find((m) => m.key === 'modeC');
  const pos = botState.modeC?.pos;
  if (OFFLINE || !cfg || !pos || !activeDhan || !isDhanConfigured()) return false;

  const clk = getIstClock();
  if (!clk.isOpen) return false;

  intrabarBusy = true;
  try {
    if (!botState.modeC?.pos) return false;
    const spot = await getSpotLtp(activeDhan, SYM);
    if (!(spot > 0)) return false;
    const th = resolveModeThresholds(cfg, pos.entryIdx);

    let exitPx = null;
    let reason = null;
    if (pos.locked && hitFloor(spot, pos.lockPrice, pos.side)) {
      exitPx = spot;
      reason = 'PROFIT_LOCK_LTP';
    } else if (hitFloor(spot, pos.stage3Floor, pos.side)) {
      exitPx = spot;
      reason = 'STAGE3_TRAIL_LTP';
    } else if (hitFloor(spot, pos.atrTrailFloor, pos.side)) {
      exitPx = spot;
      reason = 'ATR_TRAIL_LTP';
    } else if ((pos.side === 'LONG' && spot <= pos.entryIdx - th.capSl) || (pos.side === 'SHORT' && spot >= pos.entryIdx + th.capSl)) {
      exitPx = spot;
      reason = 'HARD_CAP_SL_LTP';
    } else if (pos.expiry && pos.expiry === clk.dateStr && clk.mins >= 910) {
      exitPx = spot;
      reason = 'EXPIRY_DAY_EXIT';
    }

    if (exitPx !== null) {
      pos.exitTs = Date.now();
      await closeModeBookPosition(cfg, botState.modeC, pos, exitPx, reason, activeDhan, true);
      return true;
    }

    const beforeSig = `${pos.locked}|${pos.lockPrice}|${pos.peakFavPts}|${pos.atrTrailFloor}|${pos.stage3Floor}|${pos.thetaBoosted}`;
    await advanceModeProtections(cfg, pos, spot, spot, pos.lastAtr || (SYM === 'SENSEX' ? 115 : 35), Date.now(), ' LIVE INTRABAR');
    const afterSig = `${pos.locked}|${pos.lockPrice}|${pos.peakFavPts}|${pos.atrTrailFloor}|${pos.stage3Floor}|${pos.thetaBoosted}`;
    return beforeSig !== afterSig;
  } finally {
    intrabarBusy = false;
  }
}

/**
 * Evaluate bar-by-bar profit-lock activation, theta guard, ATR trail, Stage 3, and exit triggers for Mode B / Mode C.
 */
async function processProtectedModeBar(cfg, book, bar, sig, activeDhan) {
  const pos = book.pos;
  if (!pos) return;

  let exitPx = null;
  let reason = null;

  // Check active stops BEFORE tightening locks on the same bar (prevents lookahead)
  if (pos.locked) {
    const trigPx = pos.side === 'LONG' ? bar.l : bar.h;
    if (hitFloor(trigPx, pos.lockPrice, pos.side)) {
      exitPx = pos.lockPrice;
      reason = 'PROFIT_LOCK';
    }
  }

  if (exitPx === null && pos.stage3Floor != null) {
    const trigPx = pos.side === 'LONG' ? bar.l : bar.h;
    if (hitFloor(trigPx, pos.stage3Floor, pos.side)) {
      exitPx = pos.stage3Floor;
      reason = 'STAGE3_TRAIL';
    }
  }

  if (exitPx === null && pos.atrTrailFloor != null) {
    const trigPx = pos.side === 'LONG' ? bar.l : bar.h;
    if (hitFloor(trigPx, pos.atrTrailFloor, pos.side)) {
      exitPx = pos.atrTrailFloor;
      reason = 'ATR_TRAIL';
    }
  }

  const th = resolveModeThresholds(cfg, pos.entryIdx);
  if (exitPx === null && Number.isFinite(th.capSl)) {
    if (pos.side === 'LONG' && bar.l <= pos.entryIdx - th.capSl) {
      exitPx = +(pos.entryIdx - th.capSl).toFixed(2);
      reason = 'HARD_CAP_SL';
    } else if (pos.side === 'SHORT' && bar.h >= pos.entryIdx + th.capSl) {
      exitPx = +(pos.entryIdx + th.capSl).toFixed(2);
      reason = 'HARD_CAP_SL';
    }
  }

  if (exitPx === null && cfg.key === 'modeC' && EXIT_ON_OPPOSITE_REDBAR) {
    if (sig._rbSide && sig._rbSide !== pos.side && bar.t > Number(pos.entryTs || 0)) {
      exitPx = bar.c;
      reason = 'REDBAR_OPPOSITE_EXIT';
    }
  }

  if (exitPx === null) {
    if ((pos.side === 'LONG' && sig.sellSignal) || (pos.side === 'SHORT' && sig.buySignal)) {
      exitPx = bar.c;
      reason = 'ST_FLIP';
    }
  }

  if (exitPx !== null) {
    pos.exitTs = bar.t;
    await closeModeBookPosition(cfg, book, pos, exitPx, reason, activeDhan, sig._isLatestBar);
    return;
  }

  pos.lastAtr = +(sig.atr || pos.lastAtr || (SYM === 'SENSEX' ? 115 : 35)).toFixed(2);
  await advanceModeProtections(cfg, pos, bar.h, bar.l, pos.lastAtr, bar.t, '');
}

async function scanOnce(dhan, botState) {
  if (!botState.modeA) botState.modeA = makeEmptyBook(FUT_CAPITAL_RS);
  if (!botState.modeB) botState.modeB = makeEmptyBook(FUT_CAPITAL_RS);
  if (!botState.modeC) botState.modeC = makeEmptyBook(OPT_CAPITAL_RS);

  const activeDhan = dhan || (!OFFLINE && isDhanConfigured() ? createDhanClient() : null);
  await checkModeCLiveIntrabar(activeDhan, botState);
  let bars;
  try {
    bars = OFFLINE
      ? loadOfflineBars(SYM, TF)
      : completedBars(await fetchSymbolBars(activeDhan, SYM, TF, 25), TF);
    lastFeedErrMsg = '';
  } catch (e) {
    const now = Date.now();
    if (e.message !== lastFeedErrMsg || now - lastFeedErrAt >= FEED_ERR_LOG_COOLDOWN_MS) {
      lastFeedErrAt = now;
      lastFeedErrMsg = e.message;
      console.error(`[${BOT_NAME}] Feed error (${SYM} ${TF}):`, e.message);
    }
    return;
  }

  if (bars.length < 50) {
    console.warn(`[${BOT_NAME}] Waiting for >= 50 bars (${SYM} ${TF}, got ${bars.length})`);
    return;
  }

  const candles = bars.map((b) => ({
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v || 0,
  }));

  const stArr = calculateAIRenkoSupertrend(candles, {
    atrLength: ATR_LENGTH,
    baseFactor: BASE_FACTOR,
    autoBrickSize: false,
    manualBrickSize: BRICK_SIZE,
    brickPct: BRICK_PCT,
    choppyFilterAdx: CHOPPY_FILTER,
    adxThreshold: ADX_THRESHOLD,
  });

  if (!botState.lastProcessedTs && !OFFLINE && !getIstClock().isOpen && bars.length) {
    const tip = bars[bars.length - 1];
    const tipSig = stArr[bars.length - 1];
    botState.lastProcessedTs = tip.t;
    botState.lastClosePx = tip.c;
    botState.lastBarIso = new Date(tip.t).toISOString();
    botState.lastTrend = tipSig.trend;
    botState.lastSupertrend = +tipSig.supertrend.toFixed(2);
    return;
  }

  const startIdx = botState.lastProcessedTs > 0
    ? bars.findIndex((b) => b.t > botState.lastProcessedTs)
    : (OFFLINE ? 20 : bars.length - 1);

  if (startIdx < 0) return;

  const rbSigMap = EXIT_ON_OPPOSITE_REDBAR ? buildNative1hFirstRedSignals(bars) : null;

  for (let i = Math.max(20, startIdx); i < bars.length; i++) {
    const b = bars[i];
    const sig = stArr[i];
    const barIso = new Date(b.t).toISOString();
    const isLatestBar = i >= bars.length - 2;

    // ------------------------------------------------------------------------
    // MODE A: Pure Candle-Close Flip (Target: +219% / yr, ~43% WR)
    // ------------------------------------------------------------------------
    const posA = botState.modeA.pos;
    if (posA) {
      const shouldFlipExit =
        (posA.side === 'LONG' && sig.sellSignal) ||
        (posA.side === 'SHORT' && sig.buySignal);

      if (shouldFlipExit) {
        posA.exitTs = b.t;
        const exitOptPx = await fetchOptionExitPremium(activeDhan, posA, b.c);
        const resA = recordClosedTrade(botState.modeA, posA, b.c, exitOptPx, 'ST_FLIP');
        const wrA = ((botState.modeA.wins / botState.modeA.trades) * 100).toFixed(1);
        const optWrA = ((botState.modeA.optWins / botState.modeA.optTrades) * 100).toFixed(1);
        botState.modeA.pos = null;

        if (!OFFLINE || isLatestBar) {
          const msgA =
            `📘 [MODE A - Pure Flip] EXIT ${posA.side} ${SYM} ${TF} (ST_FLIP)\n` +
            `Index: ${posA.entryIdx.toFixed(2)} → ${b.c.toFixed(2)} | Net: ${resA.netIdx >= 0 ? '+' : ''}${resA.netIdx.toFixed(1)} pts (₹${resA.netFutRs})\n` +
            `Option (${posA.optLabel}): ₹${posA.entryOpt} → ₹${exitOptPx} | Net: ${resA.netOpt >= 0 ? '+' : ''}${resA.netOpt.toFixed(1)} pts (₹${resA.netOptRs})\n` +
            `Stats A: ${botState.modeA.trades} tr | Fut WR ${wrA}% (Net ₹${botState.modeA.netRs}) | Opt WR ${optWrA}% (Net ₹${botState.modeA.optNetRs})`;
          if (!TG_MODE_C_ONLY) {
            await notify(msgA);
          } else {
            console.log(`[${BOT_NAME}] ${msgA.replace(/\n/g, ' | ')}`);
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // MODE B & MODE C: Profit-Lock & Hybrid Smart-Lock + Tail-Risk Cap
    // ------------------------------------------------------------------------
    const sigWithFlag = { ...sig, _isLatestBar: isLatestBar, _rbSide: rbSigMap ? (rbSigMap.get(b.t) || null) : null };
    for (const modeCfg of PROTECTED_MODES) {
      await processProtectedModeBar(modeCfg, botState[modeCfg.key], b, sigWithFlag, activeDhan);
    }

    // ------------------------------------------------------------------------
    // NEW ENTRY ON AI RENKO SUPERTREND FLIP (Mode A, Mode B & Mode C)
    // ------------------------------------------------------------------------
    if (sig.buySignal || sig.sellSignal) {
      const side = sig.buySignal ? 'LONG' : 'SHORT';
      const optSnap = await resolveOptionSnapshot(activeDhan, side, b.c);

      const newPosBase = {
        side,
        entryIdx: b.c,
        entryTs: b.t,
        entryIso: barIso,
        stLine: +sig.supertrend.toFixed(2),
        optLabel: optSnap.label,
        expiry: optSnap.expiry || null,
        optSecurityId: optSnap.securityId,
        optSeg: optSnap.optSeg || OPT_SEG,
        optLive: optSnap.live,
        entryOpt: optSnap.premium,
        delta: optSnap.delta,
        locked: false,
        lockPrice: null,
        peakFavPts: 0,
        lastAtr: +(sig.atr || (SYM === 'SENSEX' ? 115 : 35)).toFixed(2),
        thetaBoosted: false,
        atrTrailFloor: null,
        stage3Floor: null,
        liveOrderPlaced: false,
      };

      const enteredModes = [];
      let liveExecMsg = '';
      const patPos = getActivePatrickPosition();
      if (!botState.modeA.pos) {
        botState.modeA.pos = { ...newPosBase };
        enteredModes.push('Mode A (Paper)');
      }
      if (!botState.modeB.pos) {
        botState.modeB.pos = { ...newPosBase };
        enteredModes.push('Mode B (Paper)');
      }
      if (!botState.modeC.pos) {
        const pauseDueToPat = patPos && (
          PAUSE_ON_PATRICK === 'all' ||
          (PAUSE_ON_PATRICK === 'opposite' && patPos.side !== side)
        );
        if (pauseDueToPat) {
          liveExecMsg = `\n⏸️ Mode C PAUSED: Patrick active ${patPos.side} takes priority (filter=${PAUSE_ON_PATRICK})`;
        } else {
          const posC = { ...newPosBase };
          if (AUTO_TRADE && optSnap.live && optSnap.securityId) {
            try {
              const ord = await executeOptionSwingOrder(activeDhan, {
                autoTrade: true,
                securityId: optSnap.securityId,
                exchangeSegment: posC.optSeg,
                txType: 'BUY',
                lots: LOTS,
                qtyPerLot: MULT,
                estPremium: optSnap.premium,
                minRemainingRs: patPos ? 0 : PATRICK_RESERVE_RS,
                tag: SYM === 'SENSEX' ? 'RNKSX_C' : 'RENKO_C_ENT',
              });
              if (ord.placed) {
                posC.liveOrderPlaced = true;
                liveExecMsg = `\n✅ LIVE Mode C BUY Placed: ${LOTS} lot (${LOTS * MULT} qty) | OrderID: ${ord.orderId || 'OK'}`;
              } else {
                liveExecMsg = `\n⚠️ Mode C Live Order Skipped (${ord.reason}${ord.avail !== undefined ? `: Avail ₹${ord.avail}, Need ₹${ord.needed}${ord.minRemainingRs ? ` + ₹${ord.minRemainingRs} Patrick reserve` : ''}` : ''}) — tracking Paper`;
              }
            } catch (e) {
              liveExecMsg = `\n❌ Mode C Live BUY Error: ${e.message}`;
            }
          }
          // Only keep paper Mode C active when auto-trade isn't blocked by priority cash reserve
          if (!AUTO_TRADE || posC.liveOrderPlaced || !liveExecMsg.includes('RESERVED_FOR_PRIORITY')) {
            botState.modeC.pos = posC;
            enteredModes.push(`Mode C (${posC.liveOrderPlaced ? 'LIVE OPTIONS' : 'Paper'})`);
          }
        }
      }

      const modeCRelevant = enteredModes.some((m) => m.startsWith('Mode C')) || Boolean(liveExecMsg);
      if (enteredModes.length > 0 && (!OFFLINE || isLatestBar) && (!TG_MODE_C_ONLY || modeCRelevant)) {
        const tagExec = botState.modeC.pos?.liveOrderPlaced ? 'LIVE OPTIONS' : 'PAPER';
        const thC = resolveModeThresholds(PROTECTED_MODES[1], b.c);
        const brickLabel = BRICK_PCT > 0 ? `${(BRICK_PCT * 100).toFixed(2)}% (~${sig.brickSize.toFixed(1)})` : `${BRICK_SIZE}`;
        const capSl = side === 'LONG' ? b.c - thC.capSl : b.c + thC.capSl;
        const trigPx = side === 'LONG' ? b.c + thC.trig : b.c - thC.trig;
        const enterMsg =
          `🟢 ENTER (${tagExec}) [AI Renko ST Brick=${brickLabel}] ${SYM} ${TF} ${side}\n` +
          `Index Entry: ${b.c.toFixed(2)} | Mode C Cap SL: ${capSl.toFixed(2)} (-${thC.capSl}p) | Bar: ${barIso}\n` +
          `Dhan Option (${optSnap.live ? 'LIVE QUOTE' : 'EST'}): BUY ${optSnap.label} @ ₹${optSnap.premium} (Δ ${optSnap.delta})\n` +
          `Active Books: ${enteredModes.join(' & ')}${liveExecMsg}`;
        await notify(OFFLINE ? enterMsg : {
          text: enterMsg,
          card: {
            kind: side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
            title: `AI RENKO MODE C • ${SYM} ${TF}`,
            subtitle: `Brick ${brickLabel} • ST ${sig.supertrend.toFixed(2)}`,
            execBadge: tagExec,
            ts: b.t,
            bars: bars.slice(Math.max(0, i - 47), i + 1),
            levels: [
              { price: b.c, label: `ENTRY ${b.c.toFixed(1)}`, color: '#38bdf8' },
              { price: capSl, label: `CAP SL ${capSl.toFixed(1)}`, color: '#ef4444' },
              { price: trigPx, label: `LOCK +${thC.trig.toFixed(0)}p`, color: '#f59e0b', dash: '3 3' },
            ],
            metrics: [
              { label: 'Dhan Option', value: optSnap.label, sub: `${LOTS} lot (${LOTS * MULT} qty)` },
              { label: 'Option Entry', value: `₹${optSnap.premium}`, sub: `Delta ${optSnap.delta} (${optSnap.live ? 'LIVE' : 'EST'})` },
              { label: 'Index Levels', value: `${b.c.toFixed(1)} → Cap ${capSl.toFixed(1)}`, sub: `+${thC.trig}p -> +${thC.floor}p Lock` },
              { label: 'Active Status', value: tagExec, sub: patPos ? `Patrick ${patPos.side} Active` : `Reserve ₹${PATRICK_RESERVE_RS}` },
            ],
            footer: `7–25 DTE Swing MARGIN • Auto 15:10 Exit Only on Expiry Day`,
          },
        });
      }
    }

    botState.lastProcessedTs = b.t;
    botState.lastClosePx = b.c;
    botState.lastBarIso = barIso;
    botState.lastTrend = sig.trend;
    botState.lastSupertrend = +sig.supertrend.toFixed(2);
  }
}

async function main() {
  const botState = OFFLINE ? makeDefaultBotState() : loadJsonState(STATE_PATH, makeDefaultBotState);
  if (!botState.modeC) botState.modeC = makeEmptyBook(OPT_CAPITAL_RS);

  const execBadge = OFFLINE ? 'OFFLINE REPLAY' : (AUTO_TRADE ? 'LIVE OPTIONS (MODE C)' : 'PAPER LIVE');
  const brickDesc = BRICK_PCT > 0 ? `${(BRICK_PCT * 100).toFixed(2)}%` : `${BRICK_SIZE}`;
  const modeCDesc = MODE_C_CAP_SL_PCT > 0
    ? `+${(MODE_C_TRIGGER_PCT * 100).toFixed(2)}% -> +${(MODE_C_LOCK_PCT * 100).toFixed(2)}%, ${MODE_C_THETA_HRS}h -> +${(MODE_C_THETA_FLOOR_PCT * 100).toFixed(2)}%, ATR ${MODE_C_ATR_MULT}x @ +${(MODE_C_ATR_TRIG_PCT * 100).toFixed(2)}%, Cap -${(MODE_C_CAP_SL_PCT * 100).toFixed(2)}%, S3 >=+${(MODE_C_STAGE3_TRIG_PCT * 100).toFixed(1)}%/-${(MODE_C_STAGE3_GIVE_PCT * 100).toFixed(1)}%`
    : `+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, ${MODE_C_THETA_HRS}h -> +${MODE_C_THETA_FLOOR_PTS}p, ATR ${MODE_C_ATR_MULT}x @ +${MODE_C_ATR_TRIG_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p, S3 >=+${MODE_C_STAGE3_TRIG_PTS}p/-${MODE_C_STAGE3_GIVE_PTS}p`;
  console.log(
    `[${BOT_NAME}] Starting (${execBadge}) | ${SYM} ${TF} | ` +
    `ATR=${ATR_LENGTH}, Factor=${BASE_FACTOR}, Brick=${brickDesc} | DTE ${MIN_DTE_DAYS}-${MAX_DTE_DAYS} | Lots=${LOTS} (${MULT} qty/lot) | IntrabarWatch=${Math.round(INTRABAR_POLL_MS / 1000)}s`
  );

  if (!OFFLINE && !ONCE) {
    const now = Date.now();
    if (now - (botState.lastBootPingAt || 0) >= BOOT_PING_COOLDOWN_MS) {
      botState.lastBootPingAt = now;
      saveJsonState(STATE_PATH, botState);
      await notify(
        `🤖 AI Renko Supertrend™ Bot STARTED (${execBadge})\n` +
        `Symbol: ${SYM} ${TF} | Brick=${brickDesc} | Lots=${LOTS} (${LOTS * MULT} qty · ${MIN_DTE_DAYS}-${MAX_DTE_DAYS} DTE ${STRIKE_MODE.toUpperCase()})\n` +
        `Mode C LIVE (${modeCDesc}) + Mode A & B Paper tracking`
      );
    }
  }

  if (ONCE || OFFLINE) {
    await scanOnce(null, botState);
  } else {
    try {
      await scanOnce(null, botState);
      saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Initial scan error (continuing loop):`, e.message);
    }
  }
  if (!OFFLINE) {
    saveJsonState(STATE_PATH, botState);
  } else {
    console.log(`\n=== OFFLINE REPLAY SUMMARY (${SYM} ${TF} Candles) ===`);
    const summaryBooks = [
      ['Mode A (Pure Flip)', botState.modeA],
      ['Mode B (Profit-Lock 70% WR)', botState.modeB],
      ['Mode C (Smart Lock+Cap)', botState.modeC],
    ];
    for (const [label, b] of summaryBooks) {
      const fWr = b.trades ? ((b.wins / b.trades) * 100).toFixed(1) : '0.0';
      const oWr = b.optTrades ? ((b.optWins / b.optTrades) * 100).toFixed(1) : '0.0';
      console.log(
        `${label}: Futures=${b.trades} tr, WR=${fWr}%, NetPts=${b.netPts}, NetRs=₹${b.netRs} | ` +
        `Options(CE/PE)=${b.optTrades} tr, WR=${oWr}%, NetOptPts=${b.optNetPts}, NetRs=₹${b.optNetRs}`
      );
    }
  }

  if (ONCE || OFFLINE) return;

  const sharedDhan = isDhanConfigured() ? createDhanClient() : null;

  // Fast intrabar LTP watcher: ONLY polls Dhan LTP while Mode C has an open live/paper position during market hours
  setInterval(async () => {
    if (!botState.modeC?.pos || intrabarBusy || scanBusy || !sharedDhan) return;
    try {
      const clk = getIstClock();
      if (!clk.isOpen) return;
      const changed = await checkModeCLiveIntrabar(sharedDhan, botState);
      if (changed) saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Intrabar LTP watch error:`, e.message);
    }
  }, INTRABAR_POLL_MS);

  setInterval(async () => {
    if (scanBusy) return;
    scanBusy = true;
    try {
      const clk = getIstClock();
      if (!clk.isWeekday || clk.mins < 550 || clk.mins > 935) return; // 09:10–15:35 IST Mon–Fri only
      await scanOnce(sharedDhan, botState);
      saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Poll error:`, e.message);
    } finally {
      scanBusy = false;
    }
  }, POLL_MS);
}

main().catch((e) => {
  console.error(`[${BOT_NAME}] Fatal error:`, e);
  process.exit(1);
});
