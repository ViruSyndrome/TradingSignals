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
const LOTS = Math.max(1, Number(process.env.PATRICK_LOTS || 1));
const ALLOCATED_CAPITAL_RS = Number(process.env.PATRICK_CAPITAL_RS || 200000);
const AUTO_TRADE = String(process.env.PATRICK_AUTO_TRADE || 'false').toLowerCase() === 'true';
const POLL_MS = Math.max(15000, Number(process.env.PATRICK_POLL_MS || 60000));
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');

const MULT = { NIFTY: 65, CRUDEOIL: 100, XAU: 85 };
const COST_PTS = { NIFTY: 9.3, CRUDEOIL: 7.5, XAU: 0.8 };
const notify = createNotifier(BOT_NAME);

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

async function scanOnce(dhan, botState) {
  const activeDhan = dhan || (isDhanConfigured() ? createDhanClient() : null);
  for (const sym of SYMBOLS) {
    if (!botState.bySymbol[sym]) {
      botState.bySymbol[sym] = { ...createInitialState(), allocatedCapitalRs: ALLOCATED_CAPITAL_RS, realizedRs: 0, netRealizedRs: 0 };
    }
    const symState = botState.bySymbol[sym];
    let bars;
    try {
      bars = OFFLINE ? loadOfflineBars(sym, TF) : completedBars(await fetchSymbolBars(activeDhan, sym, TF, 25), TF);
    } catch (e) {
      console.error(`[${BOT_NAME}] Feed error (${sym} ${TF}):`, e.message);
      continue;
    }
    if (bars.length < 50) continue;
    symState.lastClosePx = bars[bars.length - 1].c;
    symState.lastBarIso = new Date(bars[bars.length - 1].t).toISOString();

    // On fresh start without processed timestamp, anchor at bar before last so live starts cleanly without replaying history
    const startIdx = symState.lastProcessedTs > 0
      ? Math.max(0, bars.findIndex((b) => b.t > symState.lastProcessedTs))
      : bars.length - 1;

    if (startIdx < 0) continue;
    const atrArr = computeATR(bars, 14);
    const singleLotTrail = LOTS < 3;

    for (let i = startIdx; i < bars.length; i++) {
      const { events } = stepPatrickBar(bars, i, symState, {
        tf: TF,
        mode: MODE,
        singleLotTrail,
        atrArr,
      });

      for (const ev of events) {
        if (ev.type === 'ENTER') {
          symState.openLots = LOTS;
          const orderRes = await executeFuturesOrder(activeDhan, {
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
          const mult = MULT[sym] || 65;
          const riskRs = Math.round(ev.risk * mult * LOTS);
          const tpFinal = ev.side === 'LONG' ? ev.entry + 5.5 * ev.risk : ev.entry - 5.5 * ev.risk;
          await notify(
            `🟢 ENTER (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${TF} ${ev.side} [${ev.kind}]\n` +
            `Entry: ${ev.entry.toFixed(2)} | SL: ${ev.sl.toFixed(2)} | 5.5R TP: ${tpFinal.toFixed(2)}\n` +
            `Risk: ${ev.risk.toFixed(1)} pts (₹${riskRs}) | Size: ${LOTS} lot (${LOTS * mult} qty)\n` +
            `Plan: 1.5R → SL to BE | 2.5R+ → 10-bar swing trail | 5.5R full TP`
          );
        } else if (ev.type === 'PARTIAL_TP1' || ev.type === 'PARTIAL_TP2') {
          const curOpen = Math.max(1, symState.openLots || LOTS);
          const legLots = Math.min(curOpen - 1, Math.max(1, Math.round(LOTS * ev.frac)));
          if (legLots > 0 && curOpen > legLots) {
            symState.openLots = curOpen - legLots;
            const closeTx = symState.pos?.side === 'LONG' ? 'SELL' : 'BUY';
            await executeFuturesOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: closeTx,
              lots: legLots,
              tag: ev.type,
            });
          }
          if (symState.slOrderId) {
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
          if (symState.slOrderId) {
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
  saveJsonState(STATE_PATH, botState);
}

(async () => {
  const dhan = isDhanConfigured() ? createDhanClient() : null;
  const botState = loadJsonState(STATE_PATH, makeDefaultBotState);
  console.log(`[${BOT_NAME}] Booting | Symbols=${SYMBOLS.join(',')} | TF=${TF} | Mode=${MODE} | Lots=${LOTS} | Capital=₹${ALLOCATED_CAPITAL_RS} | AutoTrade=${AUTO_TRADE} | Offline=${OFFLINE}`);

  await scanOnce(dhan, botState);
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
        ? `OPEN ${s.pos.side} @ ${s.pos.entry.toFixed(2)} (SL ${s.pos.sl.toFixed(2)})`
        : s.tightBox
          ? `Tight Box [${s.tightBox.lo.toFixed(1)}–${s.tightBox.hi.toFixed(1)}]`
          : s.wideBox
            ? `Wide Box [${s.wideBox.lo.toFixed(1)}–${s.wideBox.hi.toFixed(1)}]`
            : 'Scanning 15m bars';
      await notify(
        `📡 Patrick Swing Bot Online (${AUTO_TRADE ? 'LIVE' : 'PAPER TRADER'})\n` +
        `Symbol: ${SYMBOLS.join(',')} ${TF} (${MODE}) | Last Close: ${s.lastClosePx || '—'}\n` +
        `Feed: Dhan + Yahoo ^NSEI automatic fallback (works even if Dhan token is expired)\n` +
        `State: ${boxStatus}\n` +
        `Scoreboard: ${wins}W / ${losses}L | Net P&L: ${netReal >= 0 ? '+' : ''}₹${netReal} | Paper Equity: ₹${eq}`
      );
    }
  }

  setInterval(() => {
    scanOnce(dhan, botState).catch((e) => console.error(`[${BOT_NAME}] Scan error:`, e.message));
  }, POLL_MS);
})();
