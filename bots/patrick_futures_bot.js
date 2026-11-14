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
    };
  }
  return { bot: BOT_NAME, mode: MODE, tf: TF, lots: LOTS, bySymbol };
}

async function scanOnce(dhan, botState) {
  for (const sym of SYMBOLS) {
    if (!botState.bySymbol[sym]) {
      botState.bySymbol[sym] = { ...createInitialState(), allocatedCapitalRs: ALLOCATED_CAPITAL_RS, realizedRs: 0 };
    }
    const symState = botState.bySymbol[sym];
    let bars;
    try {
      bars = OFFLINE ? loadOfflineBars(sym, TF) : completedBars(await fetchSymbolBars(dhan, sym, TF, 25), TF);
    } catch (e) {
      console.error(`[${BOT_NAME}] Feed error (${sym} ${TF}):`, e.message);
      continue;
    }
    if (bars.length < 50) continue;

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
          const orderRes = await executeFuturesOrder(dhan, {
            autoTrade: AUTO_TRADE,
            sym,
            txType: ev.side === 'LONG' ? 'BUY' : 'SELL',
            lots: LOTS,
            tag: 'PATRICK',
          });
          const slSide = ev.side === 'LONG' ? 'SELL' : 'BUY';
          const slRes = await placeExchangeSlOrder(dhan, {
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
            `ENTER ${sym} ${ev.side} (${ev.kind}) | Entry=${ev.entry.toFixed(2)} | SL=${ev.sl.toFixed(2)} | Risk=${ev.risk.toFixed(2)} | Lots=${LOTS} | Mode=${AUTO_TRADE ? 'LIVE' : 'PAPER'} | Order=${JSON.stringify(orderRes)} | ExSL=${JSON.stringify(slRes)}`
          );
        } else if (ev.type === 'PARTIAL_TP1' || ev.type === 'PARTIAL_TP2') {
          const curOpen = Math.max(1, symState.openLots || LOTS);
          const legLots = Math.min(curOpen - 1, Math.max(1, Math.round(LOTS * ev.frac)));
          if (legLots > 0 && curOpen > legLots) {
            symState.openLots = curOpen - legLots;
            const closeTx = symState.pos?.side === 'LONG' ? 'SELL' : 'BUY';
            await executeFuturesOrder(dhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: closeTx,
              lots: legLots,
              tag: ev.type,
            });
          }
          if (symState.slOrderId) {
            await modifyExchangeSlOrder(dhan, {
              autoTrade: AUTO_TRADE,
              slOrderId: symState.slOrderId,
              triggerPrice: ev.sl,
              lots: symState.openLots || LOTS,
              sym,
            });
          }
          await notify(`${ev.type} ${sym} @ ${ev.px.toFixed(2)} -> SL moved to ${ev.sl.toFixed(2)} (remLots=${symState.openLots || LOTS})`);
        } else if (ev.type === 'SL_MOVED') {
          if (symState.slOrderId) {
            await modifyExchangeSlOrder(dhan, {
              autoTrade: AUTO_TRADE,
              slOrderId: symState.slOrderId,
              triggerPrice: ev.sl,
              lots: symState.openLots || LOTS,
              sym,
            });
          }
          await notify(`TRAIL SL ${sym}: ${ev.reason} -> ${ev.sl.toFixed(2)}`);
        } else if (ev.type === 'EXIT') {
          const tr = ev.trade;
          const remLots = Math.max(1, symState.openLots || 1);
          symState.openLots = 0;
          if (symState.slOrderId) {
            await cancelExchangeOrder(dhan, { autoTrade: AUTO_TRADE, orderId: symState.slOrderId });
            symState.slOrderId = null;
          }
          const pnlRs = tr.grossPts * (MULT[sym] || 1) * LOTS;
          symState.realizedRs = Math.round((symState.realizedRs || 0) + pnlRs);
          symState.paperTrades = Array.isArray(symState.paperTrades) ? symState.paperTrades : [];
          symState.paperTrades.push({
            at: new Date(bars[i].t).toISOString(),
            side: tr.side,
            kind: tr.kind,
            entry: tr.entry,
            exit: tr.exit,
            reason: tr.reason,
            grossPts: tr.grossPts,
            rMult: tr.rMult,
            grossRs: Math.round(pnlRs),
            mode: AUTO_TRADE ? 'LIVE' : 'PAPER',
          });
          const stillOpen = AUTO_TRADE ? await hasOpenFuturesPosition(dhan, sym) : true;
          if (stillOpen) {
            await executeFuturesOrder(dhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: tr.side === 'LONG' ? 'SELL' : 'BUY',
              lots: remLots,
              tag: 'PAT_EXIT',
            });
          } else {
            await notify(`INFO ${sym}: Exchange SL already flattened position; skipping duplicate PAT_EXIT market close.`);
          }
          await notify(
            `EXIT ${sym} ${tr.side} (${tr.reason}) | Pts=${tr.grossPts} (${tr.rMult}R) | GrossRs=₹${Math.round(pnlRs)} | BotEq=₹${Math.round(symState.allocatedCapitalRs + symState.realizedRs)}`
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

  setInterval(() => {
    scanOnce(dhan, botState).catch((e) => console.error(`[${BOT_NAME}] Scan error:`, e.message));
  }, POLL_MS);
})();
