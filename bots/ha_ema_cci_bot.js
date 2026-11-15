'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { prepareIndicators, createInitialState, stepHaEmaCciBar } = require('../js/ha_ema_cci_engine.js');
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

const BOT_NAME = 'HA_EMA_CCI_BOT';
const STATE_PATH = path.join(__dirname, 'state_ha_ema_cci.json');

// Empirically tuned default per-asset profiles (verified on Dhan broker candles):
//   CRUDEOIL: 15m + Chandelier 2.5x ATR trail (Dhan MCX_COMM / 573422: 27 tr, +668.1 gross / +465.6 net pts = +₹46,556 in 114d, PF 1.50)
//   NIFTY:    15m + Quiet CCI Cross Back (Dhan IDX_I / 13: 54 tr, +2,215.6 gross / +1,713.4 net pts = +₹1,11,371 in 1Y, PF 1.90)
//   XAU:      1h  + Chandelier 3.5x ATR trail (92 tr, +730.4 gross / +656.8 net pts, PF 1.54)
const DEFAULT_PROFILES = {
  CRUDEOIL: { sym: 'CRUDEOIL', tf: '15m', exitMode: 'chandelier', chandMult: 2.5, mult: 100, costPts: 7.5, capitalRs: 210000, feedLabel: 'Dhan MCX_COMM / 573422' },
  NIFTY:    { sym: 'NIFTY',    tf: '15m', exitMode: 'cci',        chandMult: 4.5, mult: 65,  costPts: 9.3, capitalRs: 165000, feedLabel: 'Dhan IDX_I / 13' },
  XAU:      { sym: 'XAU',      tf: '1h',  exitMode: 'chandelier', chandMult: 3.5, mult: 85,  costPts: 0.8, capitalRs: 140000, feedLabel: 'XAUUSDT 1h' },
};

const SYMBOLS = String(process.env.HA_CCI_SYMBOLS || 'CRUDEOIL,NIFTY')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => Boolean(DEFAULT_PROFILES[s]));
const LOTS = Math.max(1, Number(process.env.HA_CCI_LOTS || 1));
const AUTO_TRADE = String(process.env.HA_CCI_AUTO_TRADE || 'false').toLowerCase() === 'true';
const POLL_MS = Math.max(15000, Number(process.env.HA_CCI_POLL_MS || 60000));
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
  return arr.map((b) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) })).filter((b) => b.t > 0 && b.c > 0);
}

function makeDefaultBotState() {
  const bySymbol = {};
  for (const sym of SYMBOLS) {
    const prof = DEFAULT_PROFILES[sym];
    bySymbol[sym] = {
      ...createInitialState(),
      profile: prof,
      allocatedCapitalRs: Number(process.env.HA_CCI_CAPITAL_RS || prof.capitalRs),
      realizedRs: 0,
      netRealizedRs: 0,
      paperTrades: [],
    };
  }
  return { bot: BOT_NAME, lots: LOTS, bySymbol };
}

async function scanOnce(dhan, botState) {
  const activeDhan = dhan || (isDhanConfigured() ? createDhanClient() : null);
  for (const sym of SYMBOLS) {
    const prof = DEFAULT_PROFILES[sym];
    if (!botState.bySymbol[sym]) {
      botState.bySymbol[sym] = {
        ...createInitialState(),
        profile: prof,
        allocatedCapitalRs: prof.capitalRs,
        realizedRs: 0,
        netRealizedRs: 0,
        paperTrades: [],
      };
    }
    const symState = botState.bySymbol[sym];
    let bars;
    try {
      bars = OFFLINE
        ? loadOfflineBars(sym, prof.tf)
        : completedBars(await fetchSymbolBars(activeDhan, sym, prof.tf, prof.tf === '1h' ? 50 : 25), prof.tf);
    } catch (e) {
      console.error(`[${BOT_NAME}] Feed error (${sym} ${prof.tf}):`, e.message);
      continue;
    }
    if (bars.length < 220) {
      console.warn(`[${BOT_NAME}] Need >= 220 bars for ${sym} ${prof.tf} (got ${bars.length})`);
      continue;
    }
    symState.lastClosePx = bars[bars.length - 1].c;
    symState.lastBarIso = new Date(bars[bars.length - 1].t).toISOString();

    const startIdx = symState.lastProcessedTs > 0
      ? Math.max(201, bars.findIndex((b) => b.t > symState.lastProcessedTs))
      : (OFFLINE ? 201 : bars.length - 1);
    if (startIdx < 201) continue;

    const ind = prepareIndicators(bars);
    for (let i = startIdx; i < bars.length; i++) {
      const { events } = stepHaEmaCciBar(bars, i, symState, {
        symbol: sym,
        quietFilter: true,
        exitMode: prof.exitMode,
        chandMult: prof.chandMult,
        ind,
      });

      for (const ev of events) {
        if (ev.type === 'ENTER') {
          await executeFuturesOrder(activeDhan, {
            autoTrade: AUTO_TRADE,
            sym,
            txType: ev.side === 'LONG' ? 'BUY' : 'SELL',
            lots: LOTS,
            tag: 'HACCI',
          });
          if (ev.sl != null) {
            const slSide = ev.side === 'LONG' ? 'SELL' : 'BUY';
            const slRes = await placeExchangeSlOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: slSide,
              lots: LOTS,
              triggerPrice: ev.sl,
              tag: 'HACCI_SL',
            });
            symState.slOrderId = slRes.slOrderId || null;
          }
          const slText = ev.sl != null ? `${ev.sl.toFixed(2)} (Chandelier ${prof.chandMult}x ATR)` : 'CCI(200) ±100 Cross-Back';
          await notify(
            `🟢 ENTER (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${prof.tf} ${ev.side} [QUIET_HA_CCI]\n` +
            `Entry: ${ev.entry.toFixed(2)} | Stop / Exit Policy: ${slText}\n` +
            `CCI(200): ${ev.cci} | Size: ${LOTS} lot (${LOTS * prof.mult} qty) | Feed: ${prof.feedLabel}`
          );
        } else if (ev.type === 'TRAIL_SL') {
          if (symState.slOrderId && ev.sl != null) {
            await modifyExchangeSlOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              slOrderId: symState.slOrderId,
              triggerPrice: ev.sl,
              lots: LOTS,
              sym,
            });
          }
          await notify(`🛡️ TRAIL SL (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${prof.tf} ${ev.side} → Chandelier(${prof.chandMult}x ATR) SL=${ev.sl.toFixed(2)}`);
        } else if (ev.type === 'EXIT') {
          const tr = ev.trade;
          if (symState.slOrderId) {
            await cancelExchangeOrder(activeDhan, { autoTrade: AUTO_TRADE, orderId: symState.slOrderId });
            symState.slOrderId = null;
          }
          const stillOpen = AUTO_TRADE ? await hasOpenFuturesPosition(activeDhan, sym) : true;
          if (stillOpen) {
            await executeFuturesOrder(activeDhan, {
              autoTrade: AUTO_TRADE,
              sym,
              txType: tr.side === 'LONG' ? 'SELL' : 'BUY',
              lots: LOTS,
              tag: 'HACCI_X',
            });
          }
          const grossRs = Math.round(tr.grossPts * prof.mult * LOTS);
          const netPts = +(tr.grossPts - prof.costPts).toFixed(2);
          const netRs = Math.round(netPts * prof.mult * LOTS);
          symState.realizedRs = Math.round((symState.realizedRs || 0) + grossRs);
          symState.netRealizedRs = Math.round((symState.netRealizedRs || 0) + netRs);
          symState.paperTrades = Array.isArray(symState.paperTrades) ? symState.paperTrades : [];
          symState.paperTrades.push({
            at: new Date(bars[i].t).toISOString(),
            side: tr.side,
            entry: tr.entry,
            exit: tr.exit,
            reason: tr.reason,
            grossPts: tr.grossPts,
            netPts,
            mfe: tr.mfe,
            grossRs,
            netRs,
            mode: AUTO_TRADE ? 'LIVE' : 'PAPER',
          });
          const wins = symState.paperTrades.filter((x) => (x.netRs ?? x.grossRs) > 0).length;
          const losses = symState.paperTrades.length - wins;
          const netEq = Math.round((symState.allocatedCapitalRs || prof.capitalRs) + symState.netRealizedRs);
          const icon = netRs >= 0 ? '✅ WON' : '🛑 LOST';
          await notify(
            `${icon} EXIT (${AUTO_TRADE ? 'LIVE' : 'PAPER'}) ${sym} ${prof.tf} ${tr.side} (${tr.reason})\n` +
            `Entry: ${tr.entry.toFixed(2)} → Exit: ${tr.exit.toFixed(2)} | Move: ${tr.grossPts >= 0 ? '+' : ''}${tr.grossPts} pts (Peak MFE: +${tr.mfe} pts)\n` +
            `Trade P&L: Gross ${grossRs >= 0 ? '+' : ''}₹${grossRs} | Net (after ₹${Math.round(prof.costPts * prof.mult * LOTS)} charges): ${netRs >= 0 ? '+' : ''}₹${netRs}\n` +
            `Scoreboard (${sym}): ${wins}W / ${losses}L | Total Net P&L: ${symState.netRealizedRs >= 0 ? '+' : ''}₹${symState.netRealizedRs} | Paper Equity: ₹${netEq}`
          );
        }
      }
    }
  }
  if (!OFFLINE) saveJsonState(STATE_PATH, botState);
}

(async () => {
  const dhan = isDhanConfigured() ? createDhanClient() : null;
  const botState = OFFLINE ? makeDefaultBotState() : loadJsonState(STATE_PATH, makeDefaultBotState);
  console.log(`[${BOT_NAME}] Booting | Profiles=${SYMBOLS.map((s) => `${s}:${DEFAULT_PROFILES[s].tf}:${DEFAULT_PROFILES[s].exitMode}`).join(', ')} | Lots=${LOTS} | AutoTrade=${AUTO_TRADE} | Offline=${OFFLINE}`);

  await scanOnce(dhan, botState);
  if (ONCE) {
    console.log(`[${BOT_NAME}] --once scan complete.`);
    process.exit(0);
  }

  if (!OFFLINE && String(process.env.HA_CCI_BOOT_PING || 'true').toLowerCase() !== 'false') {
    const now = Date.now();
    if (now - (botState.lastBootPingAt || 0) > 5 * 60 * 1000) {
      botState.lastBootPingAt = now;
      saveJsonState(STATE_PATH, botState);
      const summaryLines = SYMBOLS.map((sym) => {
        const s = botState.bySymbol[sym] || {};
        const prof = DEFAULT_PROFILES[sym];
        const trades = Array.isArray(s.paperTrades) ? s.paperTrades : [];
        const w = trades.filter((x) => (x.netRs ?? x.grossRs) > 0).length;
        const l = trades.length - w;
        const net = s.netRealizedRs || 0;
        const stTxt = s.pos ? `OPEN ${s.pos.side} @ ${s.pos.entry.toFixed(2)}` : `Scanning ${prof.tf} (${prof.exitMode})`;
        return `• ${sym} (${prof.feedLabel}): ${s.lastClosePx || 'Awaiting Dhan token'} | ${stTxt} | ${w}W/${l}L (${net >= 0 ? '+' : ''}₹${net})`;
      });
      await notify(
        `📡 Quiet HA+EMA+CCI Bot Online (${AUTO_TRADE ? 'LIVE' : 'PAPER TRADER'})\n` +
        `Feed: 100% Dhan Official Charts + 5s .env hot token reload\n` +
        summaryLines.join('\n')
      );
    }
  }

  setInterval(() => {
    scanOnce(dhan, botState).catch((e) => console.error(`[${BOT_NAME}] Scan error:`, e.message));
  }, POLL_MS);
})();
