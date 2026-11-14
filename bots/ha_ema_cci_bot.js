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
  createDhanClient,
  isDhanConfigured,
} = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'HA_EMA_CCI_BOT';
const STATE_PATH = path.join(__dirname, 'state_ha_ema_cci.json');

// Empirically tuned default per-asset profiles:
//   NIFTY:    15m + Quiet CCI Cross Back (best net profit +₹1,11,371 / PF 1.90)
//   CRUDEOIL: 15m + Chandelier 2.5x ATR trail (PF 1.50 vs negative CCI baseline)
//   XAU:      1h  + Chandelier 3.5x ATR trail (+25% over CCI, lowest DD)
const DEFAULT_PROFILES = {
  NIFTY:    { sym: 'NIFTY',    tf: '15m', exitMode: 'cci',        chandMult: 4.5, mult: 65,  capitalRs: 165000 },
  CRUDEOIL: { sym: 'CRUDEOIL', tf: '15m', exitMode: 'chandelier', chandMult: 2.5, mult: 100, capitalRs: 210000 },
  XAU:      { sym: 'XAU',      tf: '1h',  exitMode: 'chandelier', chandMult: 3.5, mult: 85,  capitalRs: 140000 },
};

const SYMBOLS = String(process.env.HA_CCI_SYMBOLS || 'NIFTY,CRUDEOIL,XAU')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => Boolean(DEFAULT_PROFILES[s]));
const LOTS = Math.max(1, Number(process.env.HA_CCI_LOTS || 1));
const AUTO_TRADE = String(process.env.HA_CCI_AUTO_TRADE || 'false').toLowerCase() === 'true';
const POLL_MS = Math.max(15000, Number(process.env.HA_CCI_POLL_MS || 60000));
const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');

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
    const prof = DEFAULT_PROFILES[sym];
    bySymbol[sym] = {
      ...createInitialState(),
      profile: prof,
      allocatedCapitalRs: Number(process.env.HA_CCI_CAPITAL_RS || prof.capitalRs),
      realizedRs: 0,
    };
  }
  return { bot: BOT_NAME, lots: LOTS, bySymbol };
}

async function scanOnce(dhan, botState) {
  for (const sym of SYMBOLS) {
    const prof = DEFAULT_PROFILES[sym];
    if (!botState.bySymbol[sym]) {
      botState.bySymbol[sym] = {
        ...createInitialState(),
        profile: prof,
        allocatedCapitalRs: prof.capitalRs,
        realizedRs: 0,
      };
    }
    const symState = botState.bySymbol[sym];
    let bars;
    try {
      bars = OFFLINE
        ? loadOfflineBars(sym, prof.tf)
        : completedBars(await fetchSymbolBars(dhan, sym, prof.tf, prof.tf === '1h' ? 50 : 25), prof.tf);
    } catch (e) {
      console.error(`[${BOT_NAME}] Feed error (${sym} ${prof.tf}):`, e.message);
      continue;
    }
    if (bars.length < 220) {
      console.warn(`[${BOT_NAME}] Need >= 220 bars for ${sym} ${prof.tf} (got ${bars.length})`);
      continue;
    }

    const startIdx = symState.lastProcessedTs > 0
      ? Math.max(201, bars.findIndex((b) => b.t > symState.lastProcessedTs))
      : bars.length - 1;
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
          const orderRes = await executeFuturesOrder(dhan, {
            autoTrade: AUTO_TRADE,
            sym,
            txType: ev.side === 'LONG' ? 'BUY' : 'SELL',
            lots: LOTS,
            tag: 'HACCI',
          });
          await notify(
            `ENTER ${sym} ${prof.tf} ${ev.side} | Entry=${ev.entry.toFixed(2)} | ExitPolicy=${ev.exitMode}(${prof.chandMult}x) | SL=${ev.sl ?? 'CCI±100'} | CCI=${ev.cci} | Mode=${AUTO_TRADE ? 'LIVE' : 'PAPER'} | ${JSON.stringify(orderRes)}`
          );
        } else if (ev.type === 'TRAIL_SL') {
          console.log(`[${BOT_NAME}] TRAIL SL ${sym} ${ev.side} -> ${ev.sl}`);
        } else if (ev.type === 'EXIT') {
          const tr = ev.trade;
          const pnlRs = tr.grossPts * prof.mult * LOTS;
          symState.realizedRs = Math.round((symState.realizedRs || 0) + pnlRs);
          await executeFuturesOrder(dhan, {
            autoTrade: AUTO_TRADE,
            sym,
            txType: tr.side === 'LONG' ? 'SELL' : 'BUY',
            lots: LOTS,
            tag: 'HACCI_X',
          });
          await notify(
            `EXIT ${sym} ${tr.side} (${tr.reason}) | Pts=${tr.grossPts} | MFE=${tr.mfe} | GrossRs=₹${Math.round(pnlRs)} | BotEq=₹${Math.round(symState.allocatedCapitalRs + symState.realizedRs)}`
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
  console.log(`[${BOT_NAME}] Booting | Profiles=${SYMBOLS.map((s) => `${s}:${DEFAULT_PROFILES[s].tf}:${DEFAULT_PROFILES[s].exitMode}`).join(', ')} | Lots=${LOTS} | AutoTrade=${AUTO_TRADE} | Offline=${OFFLINE}`);

  await scanOnce(dhan, botState);
  if (ONCE) return;

  setInterval(() => {
    scanOnce(dhan, botState).catch((e) => console.error(`[${BOT_NAME}] Scan error:`, e.message));
  }, POLL_MS);
})();
