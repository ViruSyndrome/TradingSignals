'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { calculateAIRenkoSupertrend } = require('../js/ai_renko_supertrend.js');
const { createDhanNiftyTrade } = require('../js/dhan_nifty_trade.js');
const {
  createNotifier,
  loadJsonState,
  saveJsonState,
  completedBars,
  fetchSymbolBars,
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
const OPT_CAPITAL_RS = Number(process.env.AI_RENKO_OPT_CAPITAL_RS || 35000);

const POLL_MS = Math.max(15000, Number(process.env.AI_RENKO_POLL_MS || 60000));
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');

const rawNotify = createNotifier(BOT_NAME);
const notify = async (msg) => {
  if (OFFLINE) {
    console.log(`[${BOT_NAME}][OFFLINE] ${msg.replace(/\n/g, ' | ')}`);
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

/**
 * Resolve ATM/1-step ITM Dhan NIFTY Option quote when live & API configured.
 * Falls back gracefully to a realistic synthetic ATM estimate (~0.58 delta) offline or after-hours.
 */
async function resolveOptionSnapshot(dhan, side, spot) {
  const optType = side === 'LONG' ? 'CE' : 'PE';
  const strike = side === 'LONG' ? Math.floor(spot / 50) * 50 : Math.ceil(spot / 50) * 50;
  if (!OFFLINE && dhan && isDhanConfigured()) {
    try {
      const optHelper = createDhanNiftyTrade({ client: dhan, instrumentId: 'NIFTY' });
      const pick = await optHelper.pickOptionContract({ side, spot });
      const px = pick.ask > 0 ? pick.ask : pick.ltp;
      if (px > 0) {
        return {
          label: `${pick.strike} ${pick.optSide} (${pick.expiry})`,
          securityId: pick.securityId,
          premium: +px.toFixed(2),
          delta: +(pick.delta || 0.58).toFixed(2),
          live: true,
        };
      }
    } catch (e) {
      // Fallback safely if outside market hours or expired token
    }
  }
  return {
    label: `${strike} ${optType} (Est)`,
    securityId: null,
    premium: 170.0,
    delta: 0.58,
    live: false,
  };
}

async function fetchOptionExitPremium(dhan, pos, currentSpot) {
  if (!OFFLINE && pos.optLive && pos.optSecurityId && dhan && isDhanConfigured()) {
    try {
      const ltp = await dhan.getMarketLtp('NSE_FNO', pos.optSecurityId);
      if (ltp > 0) return +ltp.toFixed(2);
    } catch (_) {
      // fallback to delta estimation below
    }
  }
  const idxMove = pos.side === 'LONG' ? (currentSpot - pos.entryIdx) : (pos.entryIdx - currentSpot);
  const delta = pos.delta || 0.58;
  const rawMove = idxMove > 0
    ? idxMove * delta + 0.0005 * idxMove * idxMove
    : Math.max(-(pos.entryOpt - 5), idxMove * delta * 0.85);
  const holdDays = Math.max(0.05, ((pos.exitTs || Date.now()) - pos.entryTs) / 86400000);
  const thetaEst = Math.min(holdDays, 4) * 10;
  return +Math.max(1, pos.entryOpt + rawMove - thetaEst).toFixed(2);
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
      if (!OFFLINE) {
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
  const exitOptPx = await fetchOptionExitPremium(activeDhan, pos, exitPx);
  const res = recordClosedTrade(book, pos, exitPx, exitOptPx, reason);
  const wr = ((book.wins / book.trades) * 100).toFixed(1);
  const optWr = ((book.optWins / book.optTrades) * 100).toFixed(1);
  book.pos = null;

  if (!OFFLINE || sig._isLatestBar) {
    await notify(
      `📙 ${cfg.tag} EXIT ${pos.side} ${SYM} ${TF} (${reason})\n` +
      `Index: ${pos.entryIdx.toFixed(2)} → ${exitPx.toFixed(2)} | Net: ${res.netIdx >= 0 ? '+' : ''}${res.netIdx.toFixed(1)} pts (₹${res.netFutRs})\n` +
      `Option (${pos.optLabel}): ₹${pos.entryOpt} → ₹${exitOptPx} | Net: ${res.netOpt >= 0 ? '+' : ''}${res.netOpt.toFixed(1)} pts (₹${res.netOptRs})\n` +
      `Stats: ${book.trades} tr | Fut WR ${wr}% (Net ₹${book.netRs}) | Opt WR ${optWr}% (Net ₹${book.optNetRs})`
    );
  }
}

async function scanOnce(dhan, botState) {
  if (!botState.modeA) botState.modeA = makeEmptyBook(FUT_CAPITAL_RS);
  if (!botState.modeB) botState.modeB = makeEmptyBook(FUT_CAPITAL_RS);
  if (!botState.modeC) botState.modeC = makeEmptyBook(FUT_CAPITAL_RS);

  const activeDhan = dhan || (!OFFLINE && isDhanConfigured() ? createDhanClient() : null);
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
          await notify(
            `📘 [MODE A - Pure Flip] EXIT ${posA.side} ${SYM} ${TF} (ST_FLIP)\n` +
            `Index: ${posA.entryIdx.toFixed(2)} → ${b.c.toFixed(2)} | Net: ${resA.netIdx >= 0 ? '+' : ''}${resA.netIdx.toFixed(1)} pts (₹${resA.netFutRs})\n` +
            `Option (${posA.optLabel}): ₹${posA.entryOpt} → ₹${exitOptPx} | Net: ${resA.netOpt >= 0 ? '+' : ''}${resA.netOpt.toFixed(1)} pts (₹${resA.netOptRs})\n` +
            `Stats A: ${botState.modeA.trades} tr | Fut WR ${wrA}% (Net ₹${botState.modeA.netRs}) | Opt WR ${optWrA}% (Net ₹${botState.modeA.optNetRs})`
          );
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
        optSecurityId: optSnap.securityId,
        optLive: optSnap.live,
        entryOpt: optSnap.premium,
        delta: optSnap.delta,
        locked: false,
        lockPrice: null,
      };

      const enteredModes = [];
      if (!botState.modeA.pos) {
        botState.modeA.pos = { ...newPosBase };
        enteredModes.push('Mode A (Pure Flip)');
      }
      for (const modeCfg of PROTECTED_MODES) {
        if (!botState[modeCfg.key].pos) {
          botState[modeCfg.key].pos = { ...newPosBase };
          enteredModes.push(modeCfg.entryLabel);
        }
      }

      if (enteredModes.length > 0 && (!OFFLINE || isLatestBar)) {
        await notify(
          `🟢 ENTER (PAPER) [AI Renko ST Brick=${BRICK_SIZE}] ${SYM} ${TF} ${side}\n` +
          `Index Entry: ${b.c.toFixed(2)} | AI Renko ST Stop: ${sig.supertrend.toFixed(2)} | Bar: ${barIso}\n` +
          `Dhan Option (${optSnap.live ? 'LIVE QUOTE' : 'EST'}): BUY ${optSnap.label} @ ₹${optSnap.premium} (Δ ${optSnap.delta})\n` +
          `Active Books: ${enteredModes.join(' & ')}`
        );
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
  if (!botState.modeC) botState.modeC = makeEmptyBook(FUT_CAPITAL_RS);
  const dhan = !OFFLINE && isDhanConfigured() ? createDhanClient() : null;

  console.log(
    `[${BOT_NAME}] Starting (${OFFLINE ? 'OFFLINE REPLAY' : 'PAPER LIVE'}) | ${SYM} ${TF} | ` +
    `ATR=${ATR_LENGTH}, Factor=${BASE_FACTOR}, Brick=${BRICK_SIZE} | Mode A + Mode B + Mode C (Futures & Options)`
  );

  if (!OFFLINE && !ONCE) {
    const now = Date.now();
    if (now - (botState.lastBootPingAt || 0) >= BOOT_PING_COOLDOWN_MS) {
      botState.lastBootPingAt = now;
      saveJsonState(STATE_PATH, botState);
      await notify(
        `🤖 AI Renko Supertrend™ Bot STARTED (PAPER)\n` +
        `Symbol: ${SYM} ${TF} | Brick=${BRICK_SIZE} | ATR(${ATR_LENGTH}) Factor(${BASE_FACTOR})\n` +
        `Tracks Mode A (Pure Flip), Mode B (+${MODE_B_TRIGGER_PTS}p -> +${MODE_B_LOCK_PTS}p), & Mode C (+${MODE_C_TRIGGER_PTS}p -> +${MODE_C_LOCK_PTS}p, Cap -${MODE_C_CAP_SL_PTS}p)`
      );
    }
  }

  await scanOnce(dhan, botState);
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
