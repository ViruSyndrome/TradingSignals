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
  getNiftySpotLtp,
  resolveSwingOption,
  fetchOptionLiveOrEstExit,
  executeOptionSwingOrder,
  createDhanClient,
  isDhanConfigured,
} = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'AI_RENKO_ST';
const STATE_PATH = path.join(__dirname, 'state_ai_renko_st.json');
const SYM = 'NIFTY';
const TF = process.env.AI_RENKO_TF || '15m';
const ATR_LENGTH = Number(process.env.AI_RENKO_ATR_LEN || 14);
const BASE_FACTOR = Number(process.env.AI_RENKO_FACTOR || 3);
const BRICK_SIZE = Number(process.env.AI_RENKO_BRICK || 33.33);
const CHOPPY_FILTER = String(process.env.AI_RENKO_ADX_FILTER || 'false').toLowerCase() === 'true';
const ADX_THRESHOLD = Number(process.env.AI_RENKO_ADX_THRESH || 15);

// Mode B Profit-Lock parameters (from 1-year Dhan NIFTY 15m study: 70.6% Net WR, +2,652 net pts)
const MODE_B_TRIGGER_PTS = Number(process.env.AI_RENKO_LOCK_TRIG || 66.66); // 2 Bricks
const MODE_B_LOCK_PTS = Number(process.env.AI_RENKO_LOCK_FLOOR || 25.0);

// Mode C Hybrid Smart-Lock + Tail-Risk Cap (+120p trigger -> +20p floor, Hard Cap SL -150p)
const MODE_C_TRIGGER_PTS = Number(process.env.AI_RENKO_C_TRIG || 120.0);
const MODE_C_LOCK_PTS = Number(process.env.AI_RENKO_C_FLOOR || 20.0);
const MODE_C_CAP_SL_PTS = Number(process.env.AI_RENKO_C_CAP_SL || 150.0);
const BOOT_PING_COOLDOWN_MS = 30 * 60 * 1000;
const FEED_ERR_LOG_COOLDOWN_MS = 15 * 60 * 1000;

const LOTS = Math.max(1, Number(process.env.AI_RENKO_LOTS || 1));
const MULT = 65; // NIFTY 1 lot = 65 qty
const FUT_COST_PTS = 9.3; // ~₹605/lot Dhan Futures brokerage + taxes + slippage
const OPT_COST_PTS = 1.5; // ~₹97.5/lot Dhan Option round-trip brokerage + STT + slippage
const FUT_CAPITAL_RS = Number(process.env.AI_RENKO_FUT_CAPITAL_RS || 200000);
const OPT_CAPITAL_RS = Number(process.env.AI_RENKO_OPT_CAPITAL_RS || 37790);
const MIN_DTE_DAYS = Math.max(0, Number(process.env.AI_RENKO_MIN_DTE || 7));
const MAX_DTE_DAYS = Math.max(MIN_DTE_DAYS + 7, Number(process.env.AI_RENKO_MAX_DTE || 25));
const STRIKE_MODE = String(process.env.AI_RENKO_STRIKE_MODE || 'atm').toLowerCase();

const POLL_MS = Math.max(15000, Number(process.env.AI_RENKO_POLL_MS || 60000));
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');
const AUTO_TRADE = !OFFLINE && String(process.env.AI_RENKO_AUTO_TRADE || 'false').toLowerCase() === 'true';
const PATRICK_STATE_PATH = path.join(__dirname, 'state_patrick_futures.json');
const PAUSE_ON_PATRICK = String(process.env.AI_RENKO_PAUSE_ON_PATRICK || 'opposite').toLowerCase(); // 'opposite' | 'all' | 'none'
const PATRICK_RESERVE_RS = Math.max(0, Number(process.env.AI_RENKO_PATRICK_RESERVE_RS || 20000));
const TG_MODE_C_ONLY = String(process.env.AI_RENKO_TG_MODE_C_ONLY || 'true').toLowerCase() === 'true';

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

const PROTECTED_MODES = [
  {
    key: 'modeB',
    tag: '[MODE B - 70% WR Lock]',
    lockTag: '[MODE B - Profit Lock]',
    entryLabel: `Mode B (+${MODE_B_TRIGGER_PTS}p -> +${MODE_B_LOCK_PTS}p)`,
    trig: MODE_B_TRIGGER_PTS,
    floor: MODE_B_LOCK_PTS,
    capSl: Infinity,
  },
  {
    key: 'modeC',
    tag: '[MODE C - Smart Lock+Cap]',
    lockTag: '[MODE C - Smart Lock]',
    entryLabel: `Mode C (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p)`,
    trig: MODE_C_TRIGGER_PTS,
    floor: MODE_C_LOCK_PTS,
    capSl: MODE_C_CAP_SL_PTS,
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
            footer: `Mode C Hybrid (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p)`,
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

/**
 * Evaluate real-time intrabar Spot triggers for Mode C (+120p lock, -150p hard cap, expiry close).
 */
async function checkModeCLiveIntrabar(activeDhan, botState) {
  const cfg = PROTECTED_MODES.find((m) => m.key === 'modeC');
  const pos = botState.modeC?.pos;
  if (OFFLINE || !cfg || !pos || !activeDhan || !isDhanConfigured()) return;

  const clk = getIstClock();
  if (!clk.isOpen) return;

  const spot = await getNiftySpotLtp(activeDhan);
  if (!(spot > 0)) return;

  if (!pos.locked) {
    const hitTrig = pos.side === 'LONG' ? spot >= pos.entryIdx + cfg.trig : spot <= pos.entryIdx - cfg.trig;
    if (hitTrig) {
      pos.locked = true;
      pos.lockPrice = +(pos.side === 'LONG' ? pos.entryIdx + cfg.floor : pos.entryIdx - cfg.floor).toFixed(2);
      await notify(
        `🔒 ${cfg.lockTag} LIVE INTRABAR ${SYM} hit +${cfg.trig} pts @ Spot ${spot}!\n` +
        `Floor Stop locked at ${pos.lockPrice} (+${cfg.floor} pts)`
      );
    }
  }

  let exitPx = null;
  let reason = null;
  if (pos.locked && ((pos.side === 'LONG' && spot <= pos.lockPrice) || (pos.side === 'SHORT' && spot >= pos.lockPrice))) {
    exitPx = spot;
    reason = 'PROFIT_LOCK_LTP';
  } else if ((pos.side === 'LONG' && spot <= pos.entryIdx - cfg.capSl) || (pos.side === 'SHORT' && spot >= pos.entryIdx + cfg.capSl)) {
    exitPx = spot;
    reason = 'HARD_CAP_SL_LTP';
  } else if (pos.expiry && pos.expiry === clk.dateStr && clk.mins >= 910) {
    exitPx = spot;
    reason = 'EXPIRY_DAY_EXIT';
  }

  if (exitPx !== null) {
    pos.exitTs = Date.now();
    await closeModeBookPosition(cfg, botState.modeC, pos, exitPx, reason, activeDhan, true);
  }
}

/**
 * Evaluate bar-by-bar profit-lock activation and exit triggers for Mode B / Mode C.
 */
async function processProtectedModeBar(cfg, book, bar, sig, activeDhan) {
  const pos = book.pos;
  if (!pos) return;

  if (!pos.locked) {
    const triggered = pos.side === 'LONG'
      ? bar.h >= pos.entryIdx + cfg.trig
      : bar.l <= pos.entryIdx - cfg.trig;
    if (triggered) {
      pos.locked = true;
      pos.lockPrice = +(pos.side === 'LONG' ? pos.entryIdx + cfg.floor : pos.entryIdx - cfg.floor).toFixed(2);
      if (!OFFLINE && (!TG_MODE_C_ONLY || cfg.key === 'modeC')) {
        await notify(
          `🔒 ${cfg.lockTag} ${SYM} ${TF} ${pos.side} hit +${cfg.trig} pts!\n` +
          `Floor Stop locked at ${pos.lockPrice} (+${cfg.floor} pts guaranteed profit)`
        );
      }
    }
  }

  let exitPx = null;
  let reason = null;

  if (pos.locked) {
    if (pos.side === 'LONG' && bar.l <= pos.lockPrice) {
      exitPx = pos.lockPrice;
      reason = 'PROFIT_LOCK';
    } else if (pos.side === 'SHORT' && bar.h >= pos.lockPrice) {
      exitPx = pos.lockPrice;
      reason = 'PROFIT_LOCK';
    }
  }

  if (exitPx === null && Number.isFinite(cfg.capSl)) {
    if (pos.side === 'LONG' && bar.l <= pos.entryIdx - cfg.capSl) {
      exitPx = +(pos.entryIdx - cfg.capSl).toFixed(2);
      reason = 'HARD_CAP_SL';
    } else if (pos.side === 'SHORT' && bar.h >= pos.entryIdx + cfg.capSl) {
      exitPx = +(pos.entryIdx + cfg.capSl).toFixed(2);
      reason = 'HARD_CAP_SL';
    }
  }

  if (exitPx === null) {
    if ((pos.side === 'LONG' && sig.sellSignal) || (pos.side === 'SHORT' && sig.buySignal)) {
      exitPx = bar.c;
      reason = 'ST_FLIP';
    }
  }

  if (exitPx === null) return;

  pos.exitTs = bar.t;
  await closeModeBookPosition(cfg, book, pos, exitPx, reason, activeDhan, sig._isLatestBar);
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
    choppyFilterAdx: CHOPPY_FILTER,
    adxThreshold: ADX_THRESHOLD,
  });

  const startIdx = botState.lastProcessedTs > 0
    ? bars.findIndex((b) => b.t > botState.lastProcessedTs)
    : (OFFLINE ? 20 : bars.length - 1);

  if (startIdx < 0) return;

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
    const sigWithFlag = { ...sig, _isLatestBar: isLatestBar };
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
        optLive: optSnap.live,
        entryOpt: optSnap.premium,
        delta: optSnap.delta,
        locked: false,
        lockPrice: null,
        liveOrderPlaced: false,
      };

      const enteredModes = [];
      let liveExecMsg = '';
      if (!botState.modeA.pos) {
        botState.modeA.pos = { ...newPosBase };
        enteredModes.push('Mode A (Paper)');
      }
      if (!botState.modeB.pos) {
        botState.modeB.pos = { ...newPosBase };
        enteredModes.push('Mode B (Paper)');
      }
      if (!botState.modeC.pos) {
        const patPos = getActivePatrickPosition();
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
                txType: 'BUY',
                lots: LOTS,
                qtyPerLot: MULT,
                estPremium: optSnap.premium,
                minRemainingRs: patPos ? 0 : PATRICK_RESERVE_RS,
                tag: 'RENKO_C_ENT',
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
        const capSl = side === 'LONG' ? b.c - MODE_C_CAP_SL_PTS : b.c + MODE_C_CAP_SL_PTS;
        const trigPx = side === 'LONG' ? b.c + MODE_C_TRIGGER_PTS : b.c - MODE_C_TRIGGER_PTS;
        const enterMsg =
          `🟢 ENTER (${tagExec}) [AI Renko ST Brick=${BRICK_SIZE}] ${SYM} ${TF} ${side}\n` +
          `Index Entry: ${b.c.toFixed(2)} | Mode C Cap SL: ${capSl.toFixed(2)} | Bar: ${barIso}\n` +
          `Dhan Option (${optSnap.live ? 'LIVE QUOTE' : 'EST'}): BUY ${optSnap.label} @ ₹${optSnap.premium} (Δ ${optSnap.delta})\n` +
          `Active Books: ${enteredModes.join(' & ')}${liveExecMsg}`;
        await notify(OFFLINE ? enterMsg : {
          text: enterMsg,
          card: {
            kind: side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
            title: `AI RENKO MODE C • ${SYM} ${TF}`,
            subtitle: `Brick ${BRICK_SIZE} • ST ${sig.supertrend.toFixed(2)}`,
            execBadge: tagExec,
            ts: b.t,
            bars: bars.slice(Math.max(0, i - 47), i + 1),
            levels: [
              { price: b.c, label: `ENTRY ${b.c.toFixed(1)}`, color: '#38bdf8' },
              { price: capSl, label: `CAP SL ${capSl.toFixed(1)}`, color: '#ef4444' },
              { price: trigPx, label: `LOCK +120p ${trigPx.toFixed(1)}`, color: '#f59e0b', dash: '3 3' },
            ],
            metrics: [
              { label: 'Dhan Option', value: optSnap.label, sub: `${LOTS} lot (${LOTS * MULT} qty)` },
              { label: 'Option Entry', value: `₹${optSnap.premium}`, sub: `Delta ${optSnap.delta} (${optSnap.live ? 'LIVE' : 'EST'})` },
              { label: 'Index Levels', value: `${b.c.toFixed(1)} → Cap ${capSl.toFixed(1)}`, sub: `+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p Lock` },
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
  const dhan = !OFFLINE && isDhanConfigured() ? createDhanClient() : null;

  const execBadge = OFFLINE ? 'OFFLINE REPLAY' : (AUTO_TRADE ? 'LIVE OPTIONS (MODE C)' : 'PAPER LIVE');
  console.log(
    `[${BOT_NAME}] Starting (${execBadge}) | ${SYM} ${TF} | ` +
    `ATR=${ATR_LENGTH}, Factor=${BASE_FACTOR}, Brick=${BRICK_SIZE} | DTE ${MIN_DTE_DAYS}-${MAX_DTE_DAYS} | Lots=${LOTS}`
  );

  if (!OFFLINE && !ONCE) {
    const now = Date.now();
    if (now - (botState.lastBootPingAt || 0) >= BOOT_PING_COOLDOWN_MS) {
      botState.lastBootPingAt = now;
      saveJsonState(STATE_PATH, botState);
      await notify(
        `🤖 AI Renko Supertrend™ Bot STARTED (${execBadge})\n` +
        `Symbol: ${SYM} ${TF} | Brick=${BRICK_SIZE} | Lots=${LOTS} (${MIN_DTE_DAYS}-${MAX_DTE_DAYS} DTE ${STRIKE_MODE.toUpperCase()})\n` +
        `Mode C LIVE (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p) + Mode A & B Paper tracking`
      );
    }
  }

  if (ONCE || OFFLINE) {
    await scanOnce(dhan, botState);
  } else {
    try {
      await scanOnce(dhan, botState);
      saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Initial scan error (continuing loop):`, e.message);
    }
  }
  if (!OFFLINE) {
    saveJsonState(STATE_PATH, botState);
  } else {
    console.log('\n=== OFFLINE REPLAY SUMMARY (1-Year Actual Dhan NIFTY 15m Candles) ===');
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

  setInterval(async () => {
    try {
      await scanOnce(dhan, botState);
      saveJsonState(STATE_PATH, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Poll error:`, e.message);
    }
  }, POLL_MS);
}

main().catch((e) => {
  console.error(`[${BOT_NAME}] Fatal error:`, e);
  process.exit(1);
});
