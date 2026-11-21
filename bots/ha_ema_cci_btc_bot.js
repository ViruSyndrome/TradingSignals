'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { prepareIndicators, createInitialState, stepHaEmaCciBar } = require('../js/ha_ema_cci_engine.js');
const { createBinanceFuturesTrade, env } = require('../js/binance_futures_trade.js');
const { createNotifier, loadJsonState, saveJsonState } = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'HA_CCI_BTC';
const STATE_PATH = path.join(__dirname, 'state_ha_cci_btc.json');
const SYMBOL = String(process.env.HA_BTC_SYMBOL || 'BTCUSDT').toUpperCase();
const TF = String(process.env.HA_BTC_TF || '1h').toLowerCase();
const CHAND_MULT = Math.max(1.5, Number(process.env.HA_BTC_CHAND_MULT || 4.5));
const LEVERAGE = Math.max(1, Math.min(10, Math.floor(Number(process.env.HA_BTC_LEVERAGE || 2))));
const MARGIN_FRAC = Math.max(0.2, Math.min(0.95, Number(process.env.HA_BTC_MARGIN_FRAC || 0.90)));
const POLL_MS = Math.max(15000, Number(process.env.HA_BTC_POLL_MS || 60000));
const FAPI_BASE = env('BINANCE_FAPI_BASE', 'https://fapi.binance.com').replace(/\/$/, '');
const FEE_RT_PCT = 0.001; // 0.10% conservative round-trip taker fee + slippage budget

function parseEntryWindowsUtc(spec) {
  const s = String(spec || '').trim().toLowerCase();
  if (!s || s === 'all' || s === '24/7') return null;
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const a = Number(m[1]) * 60 + Number(m[2]);
    const b = Number(m[3]) * 60 + Number(m[4]);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) out.push([a, b]);
  }
  return out.length ? out : null;
}
const ENTRY_WINDOWS_UTC = parseEntryWindowsUtc(process.env.HA_BTC_ENTRY_WINDOWS_UTC || '03:00-09:50');

const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');
const HAS_KEYS = Boolean(env('BINANCE_API_KEY') && env('BINANCE_API_SECRET'));
const AUTO_TRADE = !OFFLINE && HAS_KEYS && String(process.env.HA_BTC_AUTO_TRADE || 'false').toLowerCase() === 'true';

const rawNotify = createNotifier(BOT_NAME);
const notify = async (msg) => {
  if (OFFLINE) {
    const s = typeof msg === 'string' ? msg : String(msg?.text || '');
    console.log(`[${BOT_NAME}][OFFLINE] ${s.replace(/\n/g, ' | ')}`);
    return;
  }
  return rawNotify(msg);
};

function makeDefaultBotState() {
  return {
    bot: BOT_NAME,
    symbol: SYMBOL,
    tf: TF,
    leverage: LEVERAGE,
    chandMult: CHAND_MULT,
    ...createInitialState(),
    livePos: null, // { side, qty, entry, sl, stopAlgoId, leverage, marginUsdt, liveOrderPlaced, entryTs }
    paperTrades: [],
    netRealizedUsdt: 0,
    unmanagedAlertKey: '',
    lastBootPingAt: 0,
  };
}

function loadOfflineBars() {
  const dir = path.join(__dirname, '..', '.cache_binance_um');
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${SYMBOL}_${TF}_`) && f.endsWith('.json'))
    .sort();
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const b of arr) {
      out.push({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0) });
    }
  }
  return out.filter((b) => b.t > 0 && b.c > 0).sort((a, b) => a.t - b.t);
}

async function fetchClosedBinanceKlines(symbol = SYMBOL, interval = TF, limit = 350) {
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Binance klines HTTP ${r.status}: ${txt.slice(0, 120)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('Invalid Binance klines response');
  const now = Date.now();
  return rows
    .filter((k) => Number(k[6]) <= now) // keep strictly closed candles only
    .map((k) => ({
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5] || 0),
    }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

async function inspectBinancePosition(trader) {
  if (!trader) return { amt: 0, row: null };
  const rows = await trader.getPositionRisk(SYMBOL);
  const row = (rows || []).find((p) => String(p.symbol).toUpperCase() === SYMBOL) || null;
  const amt = parseFloat(row?.positionAmt || 0);
  return { amt, row };
}

/**
 * Reconcile bot's live Binance position on every poll: detect exchange SL fills or self-heal missing protective stops.
 */
async function syncLiveBtcPosition(trader, botState) {
  if (OFFLINE || !AUTO_TRADE || !trader) return;
  const lp = botState.livePos;
  if (!lp || !lp.liveOrderPlaced) return;

  const { amt } = await inspectBinancePosition(trader);
  if (Math.abs(amt) === 0) {
    // Exchange STOP_MARKET filled between polls — record closure cleanly and clear remaining algos
    try { await trader.clearSymbolForEntry(SYMBOL, { closePosition: false }); } catch (_) {}
    let markPx = lp.sl;
    try { markPx = await trader.getMarkPrice(SYMBOL); } catch (_) {}
    const exitPx = lp.sl || markPx;
    const rawPct = lp.side === 'LONG' ? (exitPx - lp.entry) / lp.entry : (lp.entry - exitPx) / lp.entry;
    const netUsdt = +(lp.qty * lp.entry * (rawPct - FEE_RT_PCT)).toFixed(2);
    botState.netRealizedUsdt = +(Number(botState.netRealizedUsdt || 0) + netUsdt).toFixed(2);
    botState.paperTrades.push({
      at: new Date().toISOString(),
      side: lp.side,
      entry: lp.entry,
      exit: exitPx,
      qty: lp.qty,
      reason: 'EXCHANGE_SL_FILLED',
      netUsdt,
      mode: 'LIVE',
    });
    botState.pos = null;
    botState.livePos = null;
    const wins = botState.paperTrades.filter((x) => x.netUsdt > 0).length;
    await notify(
      `${netUsdt >= 0 ? '✅ WON' : '🛑 LOST'} EXCHANGE SL CLOSED (${SYMBOL} ${TF} ${lp.side})\n` +
      `Entry: $${lp.entry.toFixed(1)} → Stop ~$${exitPx.toFixed(1)} | Qty: ${lp.qty} BTC\n` +
      `Est Net P&L: ${netUsdt >= 0 ? '+' : ''}$${netUsdt} | Scoreboard: ${wins}W/${botState.paperTrades.length - wins}L (Net $${botState.netRealizedUsdt})`
    );
    return;
  }

  // Verify protective SL algo still exists; re-attach if missing
  if (lp.sl > 0) {
    try {
      const algos = await trader.getOpenAlgoOrders(SYMBOL);
      const hasStop = (algos || []).some((a) => String(a.type || a.orderType || '').includes('STOP'));
      if (!hasStop) {
        const res = await trader.moveStopToBreakeven({
          symbol: SYMBOL,
          side: lp.side,
          stopPrice: lp.sl,
          quantity: Math.abs(amt),
        });
        lp.stopAlgoId = res.stopOrder?.algoId || null;
        await notify(`🛡️ Re-attached missing Binance STOP_MARKET @ $${res.bePrice} for open ${lp.side} ${Math.abs(amt)} ${SYMBOL}`);
      }
    } catch (e) {
      console.error(`[${BOT_NAME}] Stop self-heal check error:`, e.message);
    }
  }
}

const ERR_LOG_COOLDOWN_MS = 15 * 60 * 1000;
let lastErrAt = 0;
let lastErrMsg = '';

async function scanOnce(trader, botState) {
  await syncLiveBtcPosition(trader, botState);

  let bars;
  try {
    bars = OFFLINE ? loadOfflineBars() : await fetchClosedBinanceKlines(SYMBOL, TF, 350);
    lastErrMsg = '';
  } catch (e) {
    const now = Date.now();
    if (e.message !== lastErrMsg || now - lastErrAt >= ERR_LOG_COOLDOWN_MS) {
      lastErrAt = now;
      lastErrMsg = e.message;
      console.error(`[${BOT_NAME}] Feed error:`, e.message);
    }
    return;
  }

  if (bars.length < 220) {
    console.warn(`[${BOT_NAME}] Need >= 220 bars for ${SYMBOL} ${TF} (got ${bars.length})`);
    return;
  }

  botState.lastClosePx = bars[bars.length - 1].c;
  botState.lastBarIso = new Date(bars[bars.length - 1].t).toISOString();

  const startIdx = botState.lastProcessedTs > 0
    ? bars.findIndex((b) => b.t > botState.lastProcessedTs)
    : (OFFLINE ? 205 : bars.length - 1);
  if (startIdx < 0) return;

  const ind = prepareIndicators(bars);
  for (let i = Math.max(205, startIdx); i < bars.length; i++) {
    const isLatestBar = i >= bars.length - 2;
    const { events } = stepHaEmaCciBar(bars, i, botState, {
      symbol: SYMBOL,
      entryWindowsUtc: ENTRY_WINDOWS_UTC, // Asia-London impulse window (24/7 Chandelier exits)
      quietFilter: false,
      exitMode: 'chandelier',
      chandMult: CHAND_MULT,
      entryGate: 'all',
      ind,
    });

    for (const ev of events) {
      if (ev.type === 'ENTER') {
        let liveNote = '';
        let liveBlocked = false;
        if (AUTO_TRADE && trader) {
          try {
            const { amt } = await inspectBinancePosition(trader);
            if (Math.abs(amt) > 0) {
              liveBlocked = true;
              const key = `${SYMBOL}:${amt}`;
              liveNote = `\n⏸️ LIVE SKIPPED: Unmanaged ${SYMBOL} position (${amt} BTC) already open on Binance — will auto-trade cleanly once flat.`;
              if (botState.unmanagedAlertKey !== key) {
                botState.unmanagedAlertKey = key;
                await notify(`⚠️ ${BOT_NAME} saw unmanaged ${SYMBOL} position (${amt} BTC). Standing by cleanly without interfering.`);
              }
            } else {
              botState.unmanagedAlertKey = '';
              const bal = await trader.getUsdtBalances();
              const marginUsdt = +Math.min(bal.available * 0.95, Math.max(bal.wallet, bal.available) * MARGIN_FRAC).toFixed(2);
              const ord = await trader.openSingleStopTrade({
                symbol: SYMBOL,
                side: ev.side,
                marginUsdt,
                leverage: LEVERAGE,
                stopPrice: ev.sl,
                entryHint: ev.entry,
              });
              if (ord.placed) {
                botState.livePos = {
                  side: ev.side,
                  qty: ord.qty,
                  entry: ord.avgPrice,
                  sl: ord.stopPrice,
                  stopAlgoId: ord.stopAlgoId,
                  leverage: LEVERAGE,
                  marginUsdt,
                  liveOrderPlaced: true,
                  entryTs: bars[i].t,
                };
                if (botState.pos) {
                  botState.pos.entry = ord.avgPrice;
                  botState.pos.sl = ord.stopPrice;
                }
                liveNote = `\n✅ LIVE BINANCE (${LEVERAGE}x Isolated): Qty=${ord.qty} BTC @ $${ord.avgPrice} | Stop=$${ord.stopPrice} (Algo=${ord.stopAlgoId || 'PENDING'})${ord.warning ? ` ⚠️ ${ord.warning}` : ''}`;
              } else {
                liveBlocked = true;
                liveNote = `\n⚠️ LIVE SKIPPED (${ord.reason}${ord.notional !== undefined ? `: $${ord.notional} < min $${ord.minNotional}` : ''})`;
              }
            }
          } catch (e) {
            liveBlocked = true;
            liveNote = `\n❌ Binance ENTER Error: ${e.message}`;
          }
          if (liveBlocked) {
            botState.pos = null;
            if (ev.side === 'LONG') botState.longTaken = false;
            else botState.shortTaken = false;
          }
        }
        if (!OFFLINE || isLatestBar) {
          const execBadge = botState.livePos?.liveOrderPlaced ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER';
          const enterText =
            `🟢 ENTER (${botState.livePos?.liveOrderPlaced ? 'LIVE BINANCE' : 'PAPER'}) ${SYMBOL} ${TF} ${ev.side} [HA+EMA+CCI]\n` +
            `Entry: $${ev.entry.toFixed(1)} | Chandelier ${CHAND_MULT}x SL: $${ev.sl.toFixed(1)} | CCI: ${ev.cci}${liveNote}`;
          await notify(OFFLINE ? enterText : {
            text: enterText,
            card: {
              kind: ev.side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
              title: `BTC BINANCE • ${SYMBOL} ${TF}`,
              subtitle: `HA+EMA+CCI • Chandelier ${CHAND_MULT}x ATR`,
              execBadge,
              ts: bars[i].t,
              bars: bars.slice(Math.max(0, i - 47), i + 1),
              levels: [
                { price: ev.entry, label: `ENTRY $${ev.entry.toFixed(1)}`, color: '#38bdf8' },
                { price: ev.sl, label: `STOP $${ev.sl.toFixed(1)}`, color: '#ef4444' },
              ],
              metrics: [
                { label: 'Side & Entry', value: `${ev.side} @ $${ev.entry.toFixed(1)}`, sub: `CCI(200) ${ev.cci}` },
                { label: 'Chandelier SL', value: `$${ev.sl.toFixed(1)}`, sub: `${CHAND_MULT}x ATR(${ev.atr})` },
                { label: 'Position Sizing', value: botState.livePos?.qty ? `${botState.livePos.qty} BTC` : `${Math.round(MARGIN_FRAC * 100)}% Avail`, sub: `${LEVERAGE}x Isolated` },
                { label: 'Entry Window', value: '03:00–09:50 UTC', sub: '24/7 Chandelier Trail' },
              ],
              footer: 'Exchange Reduce-Only STOP_MARKET + Dynamic Hourly Trail',
            },
          });
        }
      } else if (ev.type === 'TRAIL_SL') {
        if (AUTO_TRADE && trader && botState.livePos?.liveOrderPlaced) {
          try {
            const res = await trader.moveStopToBreakeven({
              symbol: SYMBOL,
              side: ev.side,
              stopPrice: ev.sl,
              stopAlgoId: botState.livePos.stopAlgoId,
              quantity: botState.livePos.qty,
            });
            botState.livePos.sl = res.bePrice;
            botState.livePos.stopAlgoId = res.stopOrder?.algoId || botState.livePos.stopAlgoId;
            await notify(`🛡️ LIVE BINANCE TRAIL SL ${SYMBOL}: $${res.bePrice}`);
          } catch (e) {
            await notify(`⚠️ TRAIL SL Error ${SYMBOL}: ${e.message}`);
          }
        }
      } else if (ev.type === 'EXIT') {
        const t = ev.trade;
        const rawPct = t.side === 'LONG' ? (t.exit - t.entry) / t.entry : (t.entry - t.exit) / t.entry;
        const netPct = rawPct - FEE_RT_PCT;
        const notional = botState.livePos?.liveOrderPlaced
          ? botState.livePos.qty * botState.livePos.entry
          : (84 * LEVERAGE * MARGIN_FRAC);
        const netUsdt = +(notional * netPct).toFixed(2);
        let execNote = '';
        if (AUTO_TRADE && trader && botState.livePos?.liveOrderPlaced) {
          try {
            const { amt } = await inspectBinancePosition(trader);
            if (Math.abs(amt) > 0) {
              await trader.closeMarketOnly(SYMBOL);
              execNote = '\n✅ LIVE BINANCE EXIT Market Closed & Algos Cleared';
            } else {
              execNote = '\nINFO: Binance exchange SL already flattened position.';
            }
          } catch (e) {
            execNote = `\n❌ Binance EXIT Error: ${e.message}`;
          }
        }
        botState.livePos = null;
        botState.netRealizedUsdt = +(Number(botState.netRealizedUsdt || 0) + netUsdt).toFixed(2);
        botState.paperTrades.push({
          at: new Date(bars[i].t).toISOString(),
          side: t.side,
          entry: t.entry,
          exit: t.exit,
          reason: t.reason,
          netPct: +(netPct * 100).toFixed(2),
          netUsdt,
          mode: AUTO_TRADE ? 'LIVE' : 'PAPER',
        });
        if (botState.paperTrades.length > 200) botState.paperTrades.shift();
        const wins = botState.paperTrades.filter((x) => x.netUsdt > 0).length;
        const wr = ((wins / botState.paperTrades.length) * 100).toFixed(1);
        if (!OFFLINE || isLatestBar) {
          const exitText =
            `${netUsdt >= 0 ? '✅ WON' : '🛑 LOST'} EXIT (${AUTO_TRADE ? 'LIVE BINANCE' : 'PAPER'}) ${SYMBOL} ${TF} ${t.side} (${t.reason})\n` +
            `Entry: $${t.entry.toFixed(1)} → Exit: $${t.exit.toFixed(1)} (${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}% net)\n` +
            `Est Net: ${netUsdt >= 0 ? '+' : ''}$${netUsdt} | Scoreboard: ${wins}W/${botState.paperTrades.length - wins}L (${wr}%) | Total Net: ${botState.netRealizedUsdt >= 0 ? '+' : ''}$${botState.netRealizedUsdt}${execNote}`;
          await notify(OFFLINE ? exitText : {
            text: exitText,
            card: {
              kind: netUsdt >= 0 ? 'WIN' : 'LOSS',
              title: `BTC BINANCE • ${SYMBOL} ${TF}`,
              subtitle: `${t.side} ${t.reason}`,
              execBadge: AUTO_TRADE ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER',
              ts: bars[i].t,
              bars: bars.slice(Math.max(0, i - 47), i + 1),
              levels: [
                { price: t.entry, label: `ENTRY $${t.entry.toFixed(1)}`, color: '#94a3b8', dash: '3 3' },
                { price: t.exit, label: `EXIT $${t.exit.toFixed(1)}`, color: netUsdt >= 0 ? '#22c55e' : '#ef4444' },
              ],
              metrics: [
                { label: 'Side & Reason', value: `${t.side} (${t.reason})`, sub: `${LEVERAGE}x Isolated` },
                { label: 'Price Move', value: `$${t.entry.toFixed(1)} → $${t.exit.toFixed(1)}`, sub: `${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}% net`, color: netUsdt >= 0 ? '#22c55e' : '#f43f5e' },
                { label: 'Trade Net P&L', value: `${netUsdt >= 0 ? '+' : ''}$${netUsdt}`, sub: `Total ${botState.netRealizedUsdt >= 0 ? '+' : ''}$${botState.netRealizedUsdt}`, color: netUsdt >= 0 ? '#22c55e' : '#f43f5e' },
                { label: 'Scoreboard', value: `${wins}W / ${botState.paperTrades.length - wins}L`, sub: `WR ${wr}%` },
              ],
              footer: 'HA+EMA+CCI Chandelier 4.5x • Compounding Isolated Margin',
            },
          });
        }
      }
    }
  }
}

async function main() {
  const botState = OFFLINE ? makeDefaultBotState() : loadJsonState(STATE_PATH, makeDefaultBotState);
  const trader = !OFFLINE && HAS_KEYS ? createBinanceFuturesTrade() : null;
  const badge = OFFLINE ? 'OFFLINE REPLAY' : (AUTO_TRADE ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER LIVE');
  console.log(`[${BOT_NAME}] Starting (${badge}) | ${SYMBOL} ${TF} | Chandelier=${CHAND_MULT}x | MarginFrac=${MARGIN_FRAC} | KeysConfigured=${HAS_KEYS}`);

  await scanOnce(trader, botState);
  if (OFFLINE) {
    const tr = botState.paperTrades;
    const wins = tr.filter((x) => x.netUsdt > 0).length;
    console.log(`\n=== OFFLINE ${SYMBOL} ${TF} SUMMARY: ${tr.length} trades, WR=${tr.length ? (wins / tr.length * 100).toFixed(1) : 0}%, Net=$${botState.netRealizedUsdt} ===`);
    return;
  }

  saveJsonState(STATE_PATH, botState);
  if (ONCE) return;

  const now = Date.now();
  if (now - (botState.lastBootPingAt || 0) > 15 * 60 * 1000) {
    botState.lastBootPingAt = now;
    saveJsonState(STATE_PATH, botState);
    let balLine = 'API keys not set (paper only)';
    if (trader) {
      try {
        const [bal, posInfo] = await Promise.all([trader.getUsdtBalances(), inspectBinancePosition(trader)]);
        balLine = `Avail: $${bal.available.toFixed(2)} / Wallet: $${bal.wallet.toFixed(2)} | Binance Pos: ${posInfo.amt} BTC`;
      } catch (e) {
        balLine = `Binance Check Err: ${e.message}`;
      }
    }
    await notify(
      `₿ BTC HA+EMA+CCI Bot Online (${badge})\n` +
      `Pair: ${SYMBOL} ${TF} (Chandelier ${CHAND_MULT}x ATR) | Last Close: $${botState.lastClosePx || '?'}\n` +
      `Account: ${balLine}`
    );
  }

  setInterval(async () => {
    try {
      await scanOnce(trader, botState);
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
