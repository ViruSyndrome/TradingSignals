'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { computeATR, createInitialState, stepPatrickBar } = require('../js/patrick_swing_engine.js');
const {
  createNotifier,
  loadJsonState,
  saveJsonState,
  completedBars,
  fetchSymbolBars,
  executeFuturesOrder,
  placeExchangeSlOrder,
  modifyExchangeSlOrder,
  cancelExchangeOrder,
  hasOpenFuturesPosition,
  getIstClock,
  getNiftySpotLtp,
  resolveSwingOption,
  fetchOptionLiveOrEstExit,
  executeOptionSwingOrder,
  createDhanClient,
  isDhanConfigured,
} = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'PATRICK_FUTURES';
const STATE_PATH = path.join(__dirname, 'state_patrick_futures.json');
const SYMBOLS = String(process.env.PATRICK_SYMBOLS || 'NIFTY')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TF = process.env.PATRICK_TF || '15m';
const MODE = (process.env.PATRICK_MODE || 'ALL').toUpperCase(); // ALL | CONFIRMED_BREAKOUT
const VOL_FILTER = String(process.env.PATRICK_VOL_FILTER || 'false').toLowerCase() === 'true';
const ATR_FILTER = String(process.env.PATRICK_ATR_FILTER || 'false').toLowerCase() === 'true';
const LOTS = Math.max(1, Number(process.env.PATRICK_LOTS || 1));
const ALLOCATED_CAPITAL_RS = Number(process.env.PATRICK_CAPITAL_RS || 200000);
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');
const AUTO_TRADE = !OFFLINE && String(process.env.PATRICK_AUTO_TRADE || 'false').toLowerCase() === 'true';
const EXEC_MODE = String(process.env.PATRICK_EXECUTION_MODE || 'FUTURES').toUpperCase(); // FUTURES | OPTIONS
const MIN_DTE_DAYS = Math.max(0, Number(process.env.PATRICK_MIN_DTE || 7));
const MAX_DTE_DAYS = Math.max(MIN_DTE_DAYS + 7, Number(process.env.PATRICK_MAX_DTE || 25));
const STRIKE_MODE = String(process.env.PATRICK_STRIKE_MODE || 'atm').toLowerCase();
const POLL_MS = Math.max(15000, Number(process.env.PATRICK_POLL_MS || 60000));
const OPT_COST_PTS = 1.5; // ~₹97.5/lot Dhan Option round-trip brokerage + STT + slippage

const MULT = { NIFTY: 65, CRUDEOIL: 100, XAU: 85 };
const COST_PTS = { NIFTY: 9.3, CRUDEOIL: 7.5, XAU: 0.8 };
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
  return arr.map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) })).filter((b) => b.t > 0 && b.c > 0);
}

function makeDefaultBotState() {
  const bySymbol = {};
  for (const sym of SYMBOLS) {
    bySymbol[sym] = {
      ...createInitialState(),
      allocatedCapitalRs: ALLOCATED_CAPITAL_RS,
      realizedRs: 0,
      netRealizedRs: 0,
    };
  }
  return { bot: BOT_NAME, mode: MODE, tf: TF, lots: LOTS, bySymbol };
}

const FEED_ERR_LOG_COOLDOWN_MS = 15 * 60 * 1000;
let lastFeedErrAt = 0;
let lastFeedErrMsg = '';

function isOptionsMode(sym) {
  return EXEC_MODE === 'OPTIONS' && sym === 'NIFTY';
}

async function closePatrickOptionTrade(activeDhan, sym, symState, exitIdxPx, reason, barTs, closedTrade = null) {
  const pos = symState.pos || (closedTrade ? { side: closedTrade.side, kind: closedTrade.kind, entry: closedTrade.entry } : null);
  const opt = symState.optPos || {};
  const remLots = Math.max(1, symState.openLots || LOTS);
  symState.openLots = 0;
  let execNote = '';

  if (AUTO_TRADE && opt.livePlaced && opt.securityId) {
    try {
      const ord = await executeOptionSwingOrder(activeDhan, {
        autoTrade: true,
        securityId: opt.securityId,
        txType: 'SELL',
        lots: remLots,
        qtyPerLot: MULT[sym] || 65,
        tag: `PAT_${reason}`.slice(0, 12),
      });
      execNote = ord.placed ? `\nBroker EXIT Order: ${ord.orderId || 'OK'}` : `\nBroker EXIT Skipped: ${ord.reason}`;
    } catch (e) {
      execNote = `\n⚠️ Broker EXIT Error: ${e.message}`;
    }
  }

  const exitOptPx = opt.entryOpt > 0
    ? await fetchOptionLiveOrEstExit({
      dhan: activeDhan,
      securityId: opt.securityId,
      live: opt.optLive,
      side: pos?.side || opt.side,
      entryIdx: pos?.entry || opt.entryIdx,
      entryOpt: opt.entryOpt,
      exitIdx: exitIdxPx,
      delta: opt.delta || 0.58,
      entryTs: opt.entryTs || barTs,
      exitTs: barTs || Date.now(),
      offline: OFFLINE,
    })
    : 0;

  const grossIdx = pos
    ? (pos.side === 'LONG' ? exitIdxPx - pos.entry : pos.entry - exitIdxPx)
    : 0;
  const netOptPts = opt.entryOpt > 0 ? +(exitOptPx - opt.entryOpt - OPT_COST_PTS).toFixed(2) : 0;
  const netOptRs = opt.entryOpt > 0 ? Math.round(netOptPts * (MULT[sym] || 65) * LOTS) : Math.round((grossIdx - 9.3) * (MULT[sym] || 65) * LOTS);

  symState.realizedRs = Math.round((symState.realizedRs || 0) + (opt.entryOpt > 0 ? (exitOptPx - opt.entryOpt) * (MULT[sym] || 65) * LOTS : grossIdx * (MULT[sym] || 65) * LOTS));
  symState.netRealizedRs = Math.round((symState.netRealizedRs || 0) + netOptRs);
  symState.paperTrades = Array.isArray(symState.paperTrades) ? symState.paperTrades : [];
  symState.paperTrades.push({
    at: new Date(barTs || Date.now()).toISOString(),
    side: pos?.side || opt.side,
    kind: pos?.kind || opt.kind || 'PATRICK',
    optLabel: opt.label || null,
    entry: pos?.entry || opt.entryIdx,
    exit: exitIdxPx,
    reason,
    grossPts: +grossIdx.toFixed(2),
    entryOpt: opt.entryOpt || null,
    exitOpt: exitOptPx || null,
    netOptPts,
    netRs: netOptRs,
    mode: AUTO_TRADE ? 'LIVE_OPT' : 'PAPER_OPT',
  });
  symState.pos = null;
  symState.optPos = null;
  symState.cooldownLeft = 3;

  const wins = symState.paperTrades.filter((x) => (x.netRs ?? x.grossRs) > 0).length;
  const losses = symState.paperTrades.length - wins;
  const netEq = Math.round((symState.allocatedCapitalRs || ALLOCATED_CAPITAL_RS) + symState.netRealizedRs);
  const icon = netOptRs >= 0 ? '✅ WON' : '🛑 LOST';
  const sideLabel = pos?.side || opt.side;
  const entryIdxPx = pos?.entry || opt.entryIdx;
  const exitText =
    `${icon} EXIT (${AUTO_TRADE ? 'LIVE OPTIONS' : 'PAPER OPTIONS'}) ${sym} ${sideLabel} (${reason})\n` +
    `Index: ${entryIdxPx.toFixed(2)} → ${exitIdxPx.toFixed(2)} (${grossIdx >= 0 ? '+' : ''}${grossIdx.toFixed(1)} pts)\n` +
    `Option (${opt.label || 'ATM'}): ₹${opt.entryOpt || 0} → ₹${exitOptPx} | Net: ${netOptPts >= 0 ? '+' : ''}${netOptPts} pts (₹${netOptRs})\n` +
    `Scoreboard: ${wins}W / ${losses}L | Total Opt Net P&L: ${symState.netRealizedRs >= 0 ? '+' : ''}₹${symState.netRealizedRs} | Equity: ₹${netEq}${execNote}`;
  await notify(OFFLINE ? exitText : {
    text: exitText,
    card: {
      kind: netOptRs >= 0 ? 'WIN' : 'LOSS',
      title: `PATRICK SWING • ${sym} ${TF}`,
      subtitle: `${sideLabel} ${reason}`,
      execBadge: AUTO_TRADE ? 'LIVE OPTIONS' : 'PAPER OPTIONS',
      levels: [
        { price: entryIdxPx, label: `ENTRY ${entryIdxPx.toFixed(1)}`, color: '#94a3b8', dash: '3 3' },
        { price: exitIdxPx, label: `EXIT ${exitIdxPx.toFixed(1)}`, color: netOptRs >= 0 ? '#22c55e' : '#ef4444' },
      ],
      metrics: [
        { label: 'Option Contract', value: opt.label || 'ATM', sub: `${LOTS} lot (${LOTS * (MULT[sym] || 65)} qty)` },
        { label: 'Option Fill', value: `₹${opt.entryOpt || 0} → ₹${exitOptPx}`, sub: `${netOptPts >= 0 ? '+' : ''}${netOptPts} pts`, color: netOptRs >= 0 ? '#22c55e' : '#f43f5e' },
        { label: 'Trade Net P&L', value: `${netOptRs >= 0 ? '+' : ''}₹${netOptRs}`, sub: `${grossIdx >= 0 ? '+' : ''}${grossIdx.toFixed(1)} idx pts`, color: netOptRs >= 0 ? '#22c55e' : '#f43f5e' },
        { label: 'Scoreboard', value: `${wins}W / ${losses}L`, sub: `Equity ₹${netEq}` },
      ],
      footer: 'Patrick Breakout/Reclaim • 1.5R BE -> 10-Bar Trail -> 5.5R TP',
    },
  });
}

/**
 * Real-time intrabar Spot guard for live Patrick NIFTY Options positions (SL, 1.5R BE, expiry close).
 */
async function checkPatrickLiveIntrabar(activeDhan, sym, symState) {
  if (OFFLINE || !isOptionsMode(sym) || !symState.pos || !activeDhan || !isDhanConfigured()) return;
  const clk = getIstClock();
  if (!clk.isOpen) return;
  const spot = await getNiftySpotLtp(activeDhan);
  if (!(spot > 0)) return;

  const pos = symState.pos;
  const opt = symState.optPos || {};
  if (LOTS < 3 && !pos.beMoved && pos.risk > 0) {
    const curR = (pos.side === 'LONG' ? spot - pos.entry : pos.entry - spot) / pos.risk;
    if (curR >= 1.5) {
      pos.beMoved = true;
      pos.sl = pos.entry;
      await notify(`🎯 1.5R LIVE BE ${sym} @ Spot ${spot} → Index SL moved to ${pos.sl.toFixed(2)}`);
    }
  }

  let reason = null;
  if ((pos.side === 'LONG' && spot <= pos.sl) || (pos.side === 'SHORT' && spot >= pos.sl)) {
    reason = pos.beMoved ? 'INTRABAR_TRAIL_SL' : 'INTRABAR_SL_HIT';
  } else if (opt.expiry && opt.expiry === clk.dateStr && clk.mins >= 910) {
    reason = 'EXPIRY_DAY_EXIT';
  }
  if (reason) {
    await closePatrickOptionTrade(activeDhan, sym, symState, spot, reason, Date.now());
  }
}

async function scanOnce(dhan, botState) {
  const activeDhan = dhan || (isDhanConfigured() ? createDhanClient() : null);
  for (const sym of SYMBOLS) {
    if (!botState.bySymbol[sym]) {
      botState.bySymbol[sym] = { ...createInitialState(), allocatedCapitalRs: ALLOCATED_CAPITAL_RS, realizedRs: 0, netRealizedRs: 0 };
    }
    const symState = botState.bySymbol[sym];
    await checkPatrickLiveIntrabar(activeDhan, sym, symState);

    let bars;
    try {
      bars = OFFLINE ? loadOfflineBars(sym, TF) : completedBars(await fetchSymbolBars(activeDhan, sym, TF, 25), TF);
      lastFeedErrMsg = '';
    } catch (e) {
      const now = Date.now();
      if (e.message !== lastFeedErrMsg || now - lastFeedErrAt >= FEED_ERR_LOG_COOLDOWN_MS) {
        lastFeedErrAt = now;
        lastFeedErrMsg = e.message;
        console.error(`[${BOT_NAME}] Feed error (${sym} ${TF}):`, e.message);
      }
      continue;
    }
    if (bars.length < 50) continue;
    symState.lastClosePx = bars[bars.length - 1].c;
    symState.lastBarIso = new Date(bars[bars.length - 1].t).toISOString();

    // On fresh start without processed timestamp, anchor at bar before last in live mode, or bar 0 in --offline replay mode
    const startIdx = symState.lastProcessedTs > 0
      ? bars.findIndex((b) => b.t > symState.lastProcessedTs)
      : (OFFLINE ? 0 : bars.length - 1);

    if (startIdx < 0) continue;
    const atrArr = computeATR(bars, 14);
    const singleLotTrail = LOTS < 3;

    for (let i = startIdx; i < bars.length; i++) {
      const { events } = stepPatrickBar(bars, i, symState, {
        tf: TF,
        mode: MODE,
        singleLotTrail,
        atrArr,
        volFilter: VOL_FILTER,
        atrFilter: ATR_FILTER,
      });

      for (const ev of events) {
        if (ev.type === 'ENTER') {
          symState.openLots = LOTS;
          const mult = MULT[sym] || 65;
          const riskRs = Math.round(ev.risk * mult * LOTS);
          const tpFinal = ev.side === 'LONG' ? ev.entry + 5.5 * ev.risk : ev.entry - 5.5 * ev.risk;

          if (isOptionsMode(sym)) {
            const optSnap = await resolveSwingOption({
              dhan: activeDhan,
              side: ev.side,
              spot: ev.entry,
              minDteDays: MIN_DTE_DAYS,
              maxDteDays: MAX_DTE_DAYS,
              strikeMode: STRIKE_MODE,
              offline: OFFLINE,
            });
            let livePlaced = false;
            let execMsg = '';
            if (AUTO_TRADE && optSnap.live && optSnap.securityId) {
              try {
                const ord = await executeOptionSwingOrder(activeDhan, {
                  autoTrade: true,
                  securityId: optSnap.securityId,
                  txType: 'BUY',
                  lots: LOTS,
                  qtyPerLot: mult,
                  estPremium: optSnap.premium,
                  tag: 'PAT_OPT_ENT',
                });
                livePlaced = Boolean(ord.placed);
                execMsg = ord.placed
                  ? `\n✅ LIVE BUY Placed: ${LOTS} lot (${LOTS * mult} qty) | OrderID: ${ord.orderId || 'OK'}`
                  : `\n⚠️ Live Order Skipped (${ord.reason}${ord.avail !== undefined ? `: Avail ₹${ord.avail}, Need ₹${ord.needed}` : ''}) — tracking Paper`;
              } catch (e) {
                execMsg = `\n❌ Live Option BUY Error: ${e.message}`;
              }
            }
            symState.optPos = {
              side: ev.side,
              kind: ev.kind,
              entryIdx: ev.entry,
              entryTs: bars[i].t,
              label: optSnap.label,
              expiry: optSnap.expiry || null,
              securityId: optSnap.securityId,
              optLive: optSnap.live,
              entryOpt: optSnap.premium,
              delta: optSnap.delta,
              livePlaced,
            };
            const enterText =
              `🟢 ENTER (${livePlaced ? 'LIVE OPTIONS' : 'PAPER OPTIONS'}) ${sym} ${TF} ${ev.side} [${ev.kind}]\n` +
              `Index Entry: ${ev.entry.toFixed(2)} | Index SL: ${ev.sl.toFixed(2)} | 5.5R TP: ${tpFinal.toFixed(2)}\n` +
              `Option (${optSnap.live ? 'LIVE QUOTE' : 'EST'}): BUY ${optSnap.label} @ ₹${optSnap.premium} (Δ ${optSnap.delta}) | ${LOTS} lot (${LOTS * mult} qty)\n` +
              `Plan: 1.5R → Index SL to BE | 2.5R+ → 10-bar swing trail | 5.5R full TP${execMsg}`;
            await notify(OFFLINE ? enterText : {
              text: enterText,
              card: {
                kind: ev.side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
                title: `PATRICK SWING • ${sym} ${TF}`,
                subtitle: `Setup ${ev.kind} • VolFilter=${VOL_FILTER}`,
                execBadge: livePlaced ? 'LIVE OPTIONS' : 'PAPER OPTIONS',
                ts: bars[i].t,
                bars: bars.slice(Math.max(0, i - 47), i + 1),
                levels: [
                  { price: ev.entry, label: `ENTRY ${ev.entry.toFixed(1)}`, color: '#38bdf8' },
                  { price: ev.sl, label: `STOP ${ev.sl.toFixed(1)}`, color: '#ef4444' },
                  { price: tpFinal, label: `5.5R TP ${tpFinal.toFixed(1)}`, color: '#22c55e', dash: '3 3' },
                ],
                metrics: [
                  { label: 'Dhan Option', value: optSnap.label, sub: `${LOTS} lot (${LOTS * mult} qty)` },
                  { label: 'Option Entry', value: `₹${optSnap.premium}`, sub: `Delta ${optSnap.delta} (${optSnap.live ? 'LIVE' : 'EST'})` },
                  { label: 'Index Levels', value: `${ev.entry.toFixed(1)} | SL ${ev.sl.toFixed(1)}`, sub: `Risk ${ev.risk.toFixed(1)}p -> 5.5R ${tpFinal.toFixed(1)}` },
                  { label: 'Plan & Execution', value: livePlaced ? 'LIVE MARGIN' : 'PAPER', sub: '1.5R BE -> 10-Bar Trail' },
                ],
                footer: 'High-Conviction Patrick Breakout • Priority Over Opposite Renko',
              },
            });
          } else {
            await executeFuturesOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: ev.side === 'LONG' ? 'BUY' : 'SELL',
              lots: LOTS,
              tag: 'PATRICK',
            });
            const slSide = ev.side === 'LONG' ? 'SELL' : 'BUY';
            const slRes = await placeExchangeSlOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: slSide,
              lots: LOTS,
              triggerPrice: ev.sl,
              tag: 'PAT_SL',
            });
            symState.slOrderId = slRes.slOrderId || null;
            symState.paperTrades = Array.isArray(symState.paperTrades) ? symState.paperTrades : [];
            await notify(
              `🟢 ENTER (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${TF} ${ev.side} [${ev.kind}]\n` +
              `Entry: ${ev.entry.toFixed(2)} | SL: ${ev.sl.toFixed(2)} | 5.5R TP: ${tpFinal.toFixed(2)}\n` +
              `Risk: ${ev.risk.toFixed(1)} pts (₹${riskRs}) | Size: ${LOTS} lot (${LOTS * mult} qty)\n` +
              `Plan: 1.5R → SL to BE | 2.5R+ → 10-bar swing trail | 5.5R full TP`
            );
          }
        } else if (ev.type === 'PARTIAL_TP1' || ev.type === 'PARTIAL_TP2') {
          const curOpen = Math.max(1, symState.openLots || LOTS);
          const legLots = Math.min(curOpen - 1, Math.max(1, Math.round(LOTS * ev.frac)));
          if (legLots > 0 && curOpen > legLots) {
            symState.openLots = curOpen - legLots;
            if (isOptionsMode(sym)) {
              if (AUTO_TRADE && symState.optPos?.livePlaced && symState.optPos?.securityId) {
                await executeOptionSwingOrder(activeDhan, {
                  autoTrade: true,
                  securityId: symState.optPos.securityId,
                  txType: 'SELL',
                  lots: legLots,
                  qtyPerLot: MULT[sym] || 65,
                  tag: ev.type,
                }).catch(() => {});
              }
            } else {
              const closeTx = symState.pos?.side === 'LONG' ? 'SELL' : 'BUY';
              await executeFuturesOrder(activeDhan, {
                autoTrade: AUTO_TRADE,
                sym,
                txType: closeTx,
                lots: legLots,
                tag: ev.type,
              });
            }
          }
          if (!isOptionsMode(sym) && symState.slOrderId) {
            await modifyExchangeSlOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              slOrderId: symState.slOrderId,
              triggerPrice: ev.sl,
              lots: symState.openLots || LOTS,
              sym,
            });
          }
          await notify(`🎯 ${ev.type} (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} @ ${ev.px.toFixed(2)} → SL moved to ${ev.sl.toFixed(2)} (remLots=${symState.openLots || LOTS})`);
        } else if (ev.type === 'SL_MOVED') {
          if (!isOptionsMode(sym) && symState.slOrderId) {
            await modifyExchangeSlOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              slOrderId: symState.slOrderId,
              triggerPrice: ev.sl,
              lots: symState.openLots || LOTS,
              sym,
            });
          }
          await notify(`🛡️ TRAIL SL (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym}: ${ev.reason} → SL=${ev.sl.toFixed(2)}`);
        } else if (ev.type === 'EXIT') {
          const tr = ev.trade;
          if (isOptionsMode(sym)) {
            await closePatrickOptionTrade(activeDhan, sym, symState, tr.exit, tr.reason, bars[i].t, tr);
          } else {
            const remLots = Math.max(1, symState.openLots || 1);
            symState.openLots = 0;
            if (symState.slOrderId) {
              await cancelExchangeOrder(activeDhan, { autoTrade: AUTO_TRADE, orderId: symState.slOrderId });
              symState.slOrderId = null;
            }
            const mult = MULT[sym] || 65;
            const costPts = COST_PTS[sym] || 9.3;
            const grossRs = Math.round(tr.grossPts * mult * LOTS);
            const netPts = +(tr.grossPts - costPts).toFixed(2);
            const netRs = Math.round(netPts * mult * LOTS);
            symState.realizedRs = Math.round((symState.realizedRs || 0) + grossRs);
            symState.netRealizedRs = Math.round((symState.netRealizedRs || 0) + netRs);
            symState.paperTrades = Array.isArray(symState.paperTrades) ? symState.paperTrades : [];
            symState.paperTrades.push({
              at: new Date(bars[i].t).toISOString(),
              side: tr.side,
              kind: tr.kind,
              entry: tr.entry,
              exit: tr.exit,
              reason: tr.reason,
              grossPts: tr.grossPts,
              netPts,
              rMult: tr.rMult,
              grossRs,
              netRs,
              mode: AUTO_TRADE ? 'LIVE' : 'PAPER',
            });
            const wins = symState.paperTrades.filter((x) => (x.netRs ?? x.grossRs) > 0).length;
            const losses = symState.paperTrades.length - wins;
            const stillOpen = AUTO_TRADE ? await hasOpenFuturesPosition(activeDhan, sym) : true;
            if (stillOpen) {
              await executeFuturesOrder(activeDhan, {
                autoTrade: AUTO_TRADE,
                sym,
                txType: tr.side === 'LONG' ? 'SELL' : 'BUY',
                lots: remLots,
                tag: 'PAT_EXIT',
              });
            } else {
              await notify(`INFO ${sym}: Exchange SL already flattened position; skipping duplicate PAT_EXIT market close.`);
            }
            const icon = netRs >= 0 ? '✅ WON' : '🛑 LOST';
            const netEq = Math.round(symState.allocatedCapitalRs + symState.netRealizedRs);
            await notify(
              `${icon} EXIT (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${tr.side} [${tr.kind}] (${tr.reason})\n` +
              `Entry: ${tr.entry.toFixed(2)} → Exit: ${tr.exit.toFixed(2)} | Move: ${tr.grossPts >= 0 ? '+' : ''}${tr.grossPts} pts (${tr.rMult}R)\n` +
              `Trade P&L: Gross ${grossRs >= 0 ? '+' : ''}₹${grossRs} | Net (after ₹${Math.round(costPts * mult * LOTS)} charges): ${netRs >= 0 ? '+' : ''}₹${netRs}\n` +
              `Scoreboard: ${wins}W / ${losses}L | Total Net P&L: ${symState.netRealizedRs >= 0 ? '+' : ''}₹${symState.netRealizedRs} | Paper Equity: ₹${netEq}`
            );
          }
        }
      }
    }
  }
  if (!OFFLINE) saveJsonState(STATE_PATH, botState);
}

(async () => {
  const dhan = isDhanConfigured() ? createDhanClient() : null;
  const botState = OFFLINE ? makeDefaultBotState() : loadJsonState(STATE_PATH, makeDefaultBotState);
  console.log(`[${BOT_NAME}] Booting | Symbols=${SYMBOLS.join(',')} | TF=${TF} | Exec=${EXEC_MODE} (${MIN_DTE_DAYS}-${MAX_DTE_DAYS} DTE ${STRIKE_MODE.toUpperCase()}) | Mode=${MODE} | Lots=${LOTS} | Capital=₹${ALLOCATED_CAPITAL_RS} | AutoTrade=${AUTO_TRADE} | Offline=${OFFLINE}`);

  if (ONCE || OFFLINE) {
    await scanOnce(dhan, botState);
  } else {
    try {
      await scanOnce(dhan, botState);
    } catch (e) {
      console.error(`[${BOT_NAME}] Initial scan error (continuing loop):`, e.message);
    }
  }
  if (ONCE) {
    console.log(`[${BOT_NAME}] --once scan complete.`);
    process.exit(0);
  }

  if (!OFFLINE && String(process.env.PATRICK_BOOT_PING || 'true').toLowerCase() !== 'false') {
    const now = Date.now();
    if (now - (botState.lastBootPingAt || 0) > 5 * 60 * 1000) {
      botState.lastBootPingAt = now;
      saveJsonState(STATE_PATH, botState);
      const s = botState.bySymbol[SYMBOLS[0]] || {};
      const trades = Array.isArray(s.paperTrades) ? s.paperTrades : [];
      const wins = trades.filter((x) => (x.netRs ?? x.grossRs) > 0).length;
      const losses = trades.length - wins;
      const netReal = s.netRealizedRs || 0;
      const eq = Math.round((s.allocatedCapitalRs || ALLOCATED_CAPITAL_RS) + netReal);
      const boxStatus = s.pos
        ? `OPEN ${s.pos.side} @ ${s.pos.entry.toFixed(2)} (SL ${s.pos.sl.toFixed(2)})${s.optPos?.label ? ` [${s.optPos.label}]` : ''}`
        : s.tightBox
          ? `Tight Box [${s.tightBox.lo.toFixed(1)}–${s.tightBox.hi.toFixed(1)}]`
          : s.wideBox
            ? `Wide Box [${s.wideBox.lo.toFixed(1)}–${s.wideBox.hi.toFixed(1)}]`
            : 'Scanning 15m bars';
      const execLabel = EXEC_MODE === 'OPTIONS'
        ? `OPTIONS ${AUTO_TRADE ? 'LIVE' : 'PAPER'} (${MIN_DTE_DAYS}-${MAX_DTE_DAYS} DTE ${STRIKE_MODE.toUpperCase()}, MARGIN)`
        : `FUTURES ${AUTO_TRADE ? 'LIVE' : 'PAPER'}`;
      await notify(
        `📡 Patrick Swing Bot Online (${execLabel})\n` +
        `Symbol: ${SYMBOLS.join(',')} ${TF} (${MODE} | VolFilter=${VOL_FILTER}) | Last Close: ${s.lastClosePx || 'Awaiting Dhan token refresh'}\n` +
        `Feed: Dhan Official Charts (IDX_I / 13) + 5s .env hot token reload\n` +
        `State: ${boxStatus}\n` +
        `Scoreboard: ${wins}W / ${losses}L | Net P&L: ${netReal >= 0 ? '+' : ''}₹${netReal} | Equity: ₹${eq}`
      );
    }
  }

  setInterval(() => {
    scanOnce(dhan, botState).catch((e) => console.error(`[${BOT_NAME}] Scan error:`, e.message));
  }, POLL_MS);
})();
