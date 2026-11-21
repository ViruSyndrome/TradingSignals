'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { calcATR, calcADX, calcEMA } = require('../js/ai_renko_supertrend.js');
const { createBinanceFuturesTrade, env } = require('../js/binance_futures_trade.js');
const { createNotifier, loadJsonState, saveJsonState } = require('../js/futures_bot_runtime.js');

const BOT_NAME = 'AI_RENKO_ETH';
const SYMBOL = String(process.env.AI_ETH_SYMBOL || 'ETHUSDT').toUpperCase();
const TF = String(process.env.AI_ETH_TF || '4h').toLowerCase();
const ATR_LEN = Math.max(5, Number(process.env.AI_ETH_ATR_LEN || 14));
const FACTOR = Math.max(1, Number(process.env.AI_ETH_FACTOR || 6));
const BRICK_PCT = Math.max(0.001, Number(process.env.AI_ETH_BRICK_PCT || 0.005));
const ADX_MIN = Math.max(0, Number(process.env.AI_ETH_ADX_MIN || 0));
const EMA_LEN = Math.max(0, Number(process.env.AI_ETH_EMA_LEN || 200));
const SL_PCT = Math.max(0.01, Number(process.env.AI_ETH_SL_PCT || 0.08));
const LEVERAGE = Math.max(1, Math.min(10, Math.floor(Number(process.env.AI_ETH_LEVERAGE || 4))));
const MARGIN_FRAC = Math.max(0.2, Math.min(0.95, Number(process.env.AI_ETH_MARGIN_FRAC || 0.45)));
const POLL_MS = Math.max(15000, Number(process.env.AI_ETH_POLL_MS || 60000));
const FAPI_BASE = env('BINANCE_FAPI_BASE', 'https://fapi.binance.com').replace(/\/$/, '');
const STATE_PATH = path.join(__dirname, `state_ai_renko_${SYMBOL.toLowerCase()}.json`);
const FEE_RT_PCT = 0.001; // 0.10% conservative Binance Futures taker round-trip deduction

const ONCE = process.argv.includes('--once');
const OFFLINE = process.argv.includes('--offline');
const HAS_KEYS = Boolean(env('BINANCE_API_KEY') && env('BINANCE_API_SECRET'));
const AUTO_TRADE = !OFFLINE && HAS_KEYS && String(process.env.AI_ETH_AUTO_TRADE || 'false').toLowerCase() === 'true';

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
    lastProcessedTs: 0,
    pos: null,     // { side, entry, sl, entryTs, maePct }
    livePos: null, // { side, qty, entry, sl, stopAlgoId, leverage, marginUsdt, liveOrderPlaced, entryTs }
    paperTrades: [],
    netRealizedUsdt: 0,
    unmanagedAlertKey: '',
    lastBootPingAt: 0,
    lastClosePx: 0,
    lastBarIso: '',
  };
}

/**
 * Compute crypto-scaled AI Renko Supertrend series on closed bars (`%` brick size + ATR + ADX + EMA filter).
 */
function computeCryptoAiRenkoSeries(bars, {
  atrLen = ATR_LEN,
  factor = FACTOR,
  brickPct = BRICK_PCT,
  adxMin = ADX_MIN,
  emaLen = EMA_LEN,
} = {}) {
  const candles = bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
  const atrArr = calcATR(candles, atrLen);
  const adxArr = adxMin > 0 ? calcADX(candles, 14) : null;
  const emaArr = emaLen > 0 ? calcEMA(bars.map((b) => b.c), emaLen) : null;

  let renkoClose = null;
  let renkoDir = 0;
  let upperBand = null;
  let lowerBand = null;
  let trend = 1;
  let prevRenkoClose = null;

  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const atr = atrArr[i] != null ? atrArr[i] : (b.h - b.l || 1);
    const adx = adxArr ? (adxArr[i] || 0) : 99;
    const brickSize = Math.max(b.c * brickPct, 0.1);

    if (renkoClose === null) {
      renkoClose = Math.round(b.c / brickSize) * brickSize;
      renkoDir = 1;
    } else if (renkoDir >= 0) {
      if (b.c >= renkoClose + brickSize) {
        renkoClose += Math.floor((b.c - renkoClose) / brickSize) * brickSize;
        renkoDir = 1;
      } else if (b.c <= renkoClose - 2 * brickSize) {
        renkoClose -= Math.floor((renkoClose - b.c) / brickSize) * brickSize;
        renkoDir = -1;
      }
    } else {
      if (b.c <= renkoClose - brickSize) {
        renkoClose -= Math.floor((renkoClose - b.c) / brickSize) * brickSize;
        renkoDir = -1;
      } else if (b.c >= renkoClose + 2 * brickSize) {
        renkoClose += Math.floor((b.c - renkoClose) / brickSize) * brickSize;
        renkoDir = 1;
      }
    }

    const qDist = Math.max(brickSize, Math.round((factor * atr) / brickSize) * brickSize);
    const basicUpper = renkoClose + qDist;
    const basicLower = renkoClose - qDist;
    if (upperBand === null) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      trend = 1;
    } else {
      upperBand = (basicUpper < upperBand || prevRenkoClose > upperBand) ? basicUpper : upperBand;
      lowerBand = (basicLower > lowerBand || prevRenkoClose < lowerBand) ? basicLower : lowerBand;
    }
    prevRenkoClose = renkoClose;

    const prevTrend = trend;
    const adxOk = adx >= adxMin;
    if (prevTrend === 1) {
      if (b.c < lowerBand && renkoDir === -1 && adxOk) {
        trend = -1;
        upperBand = basicUpper;
      }
    } else if (b.c > upperBand && renkoDir === 1 && adxOk) {
      trend = 1;
      lowerBand = basicLower;
    }

    const ema = emaArr ? emaArr[i] : null;
    out[i] = {
      t: b.t,
      close: b.c,
      trend,
      prevTrend,
      flipped: i > 0 && trend !== prevTrend,
      supertrend: trend === 1 ? lowerBand : upperBand,
      atr,
      adx,
      ema,
      brickSize,
    };
  }
  return out;
}

function loadOfflineBars() {
  const scratch1h = path.join(
    'C:', 'Users', 'Vinod', '.gemini', 'antigravity', 'brain',
    '0023ca22-b79c-4d5d-978e-3b6c0e210599', 'scratch',
    `${SYMBOL.toLowerCase()}_cache_1h_730d.json`
  );
  if (!fs.existsSync(scratch1h)) {
    throw new Error(`Offline cache not found: ${scratch1h}`);
  }
  const bars1h = JSON.parse(fs.readFileSync(scratch1h, 'utf8'));
  if (TF === '1h') return bars1h;
  const tfMs = TF === '4h' ? 14400000 : 3600000;
  const map = new Map();
  for (const b of bars1h) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    if (!map.has(k)) map.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    else {
      const cur = map.get(k);
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function fetchClosedBinanceKlines(symbol = SYMBOL, interval = TF, limit = 1500) {
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
    .filter((k) => Number(k[6]) <= now) // strictly closed candles only
    .map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5] || 0) }))
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

async function inspectBinancePosition(trader) {
  if (!trader) return { amt: 0, row: null };
  const rows = await trader.getPositionRisk(SYMBOL);
  const row = (rows || []).find((p) => String(p.symbol).toUpperCase() === SYMBOL) || null;
  return { amt: parseFloat(row?.positionAmt || 0), row };
}

async function syncLiveEthPosition(trader, botState) {
  if (OFFLINE || !AUTO_TRADE || !trader) return;
  const lp = botState.livePos;
  if (!lp || !lp.liveOrderPlaced) return;

  const { amt } = await inspectBinancePosition(trader);
  if (Math.abs(amt) === 0) {
    try { await trader.clearSymbolForEntry(SYMBOL, { closePosition: false }); } catch (_) {}
    const exitPx = lp.sl || lp.entry;
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
      netPct: +((rawPct - FEE_RT_PCT) * 100).toFixed(2),
      netUsdt,
      mode: 'LIVE',
    });
    botState.pos = null;
    botState.livePos = null;
    const wins = botState.paperTrades.filter((x) => x.netUsdt > 0).length;
    await notify(
      `${netUsdt >= 0 ? '✅ WON' : '🛑 LOST'} EXCHANGE SL CLOSED (${SYMBOL} ${TF} ${lp.side})\n` +
      `Entry: $${lp.entry.toFixed(2)} → Stop $${exitPx.toFixed(2)} | Qty: ${lp.qty} ETH\n` +
      `Est Net P&L: ${netUsdt >= 0 ? '+' : ''}$${netUsdt} | Scoreboard: ${wins}W/${botState.paperTrades.length - wins}L (Net $${botState.netRealizedUsdt})`
    );
    return;
  }

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
  await syncLiveEthPosition(trader, botState);

  let bars;
  try {
    bars = OFFLINE ? loadOfflineBars() : await fetchClosedBinanceKlines(SYMBOL, TF, 1500);
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

  const warmup = Math.max(40, ATR_LEN + 5, EMA_LEN);
  if (bars.length < warmup + 5) {
    console.warn(`[${BOT_NAME}] Need >= ${warmup + 5} bars for ${SYMBOL} ${TF} (got ${bars.length})`);
    return;
  }

  botState.lastClosePx = bars[bars.length - 1].c;
  botState.lastBarIso = new Date(bars[bars.length - 1].t).toISOString();

  const startIdx = botState.lastProcessedTs > 0
    ? bars.findIndex((b) => b.t > botState.lastProcessedTs)
    : (OFFLINE ? warmup : bars.length - 1);
  if (startIdx < 0) return;

  const series = computeCryptoAiRenkoSeries(bars);

  for (let i = Math.max(warmup, startIdx); i < bars.length; i++) {
    const b = bars[i];
    const sig = series[i];
    const isLatestBar = i >= bars.length - 2;
    botState.lastProcessedTs = b.t;

    // 1. Manage open position (intrabar SL in offline mode; flip exit on bar close)
    if (botState.pos) {
      const p = botState.pos;
      const isL = p.side === 'LONG';
      let exitPx = null;
      let exitReason = null;

      if (OFFLINE) {
        const hitSl = isL ? b.l <= p.sl : b.h >= p.sl;
        if (hitSl) {
          exitPx = p.sl;
          exitReason = 'PROTECTIVE_SL_8PCT';
        }
      }
      if (!exitPx && sig.flipped && ((isL && sig.trend === -1) || (!isL && sig.trend === 1))) {
        exitPx = b.c;
        exitReason = 'AI_RENKO_FLIP';
      }

      if (exitPx != null) {
        const rawPct = isL ? (exitPx - p.entry) / p.entry : (p.entry - exitPx) / p.entry;
        const netPct = rawPct - FEE_RT_PCT;
        const notional = botState.livePos?.liveOrderPlaced
          ? botState.livePos.qty * botState.livePos.entry
          : (94.30 * LEVERAGE * MARGIN_FRAC);
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
        botState.pos = null;
        botState.livePos = null;
        botState.netRealizedUsdt = +(Number(botState.netRealizedUsdt || 0) + netUsdt).toFixed(2);
        botState.paperTrades.push({
          at: new Date(b.t).toISOString(),
          side: p.side,
          entry: p.entry,
          exit: exitPx,
          reason: exitReason,
          netPct: +(netPct * 100).toFixed(2),
          netUsdt,
          mode: AUTO_TRADE ? 'LIVE' : 'PAPER',
        });
        if (botState.paperTrades.length > 200) botState.paperTrades.shift();

        const wins = botState.paperTrades.filter((x) => x.netUsdt > 0).length;
        const wr = ((wins / botState.paperTrades.length) * 100).toFixed(1);
        if (!OFFLINE || isLatestBar) {
          const exitText =
            `${netUsdt >= 0 ? '✅ WON' : '🛑 LOST'} EXIT (${AUTO_TRADE ? 'LIVE BINANCE' : 'PAPER'}) ${SYMBOL} ${TF} ${p.side} (${exitReason})\n` +
            `Entry: $${p.entry.toFixed(2)} → Exit: $${exitPx.toFixed(2)} (${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}% net)\n` +
            `Est Net: ${netUsdt >= 0 ? '+' : ''}$${netUsdt} | Scoreboard: ${wins}W/${botState.paperTrades.length - wins}L (${wr}%) | Total Net: ${botState.netRealizedUsdt >= 0 ? '+' : ''}$${botState.netRealizedUsdt}${execNote}`;
          await notify(OFFLINE ? exitText : {
            text: exitText,
            card: {
              kind: netUsdt >= 0 ? 'WIN' : 'LOSS',
              title: `ETH BINANCE • ${SYMBOL} ${TF}`,
              subtitle: `${p.side} ${exitReason}`,
              execBadge: AUTO_TRADE ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER',
              ts: b.t,
              bars: bars.slice(Math.max(0, i - 47), i + 1),
              levels: [
                { price: p.entry, label: `ENTRY $${p.entry.toFixed(1)}`, color: '#94a3b8', dash: '3 3' },
                { price: exitPx, label: `EXIT $${exitPx.toFixed(1)}`, color: netUsdt >= 0 ? '#22c55e' : '#ef4444' },
              ],
              metrics: [
                { label: 'Side & Reason', value: `${p.side} (${exitReason})`, sub: `${LEVERAGE}x Isolated` },
                { label: 'Price Move', value: `$${p.entry.toFixed(1)} → $${exitPx.toFixed(1)}`, sub: `${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}% net`, color: netUsdt >= 0 ? '#22c55e' : '#f43f5e' },
                { label: 'Trade Net P&L', value: `${netUsdt >= 0 ? '+' : ''}$${netUsdt}`, sub: `Total ${botState.netRealizedUsdt >= 0 ? '+' : ''}$${botState.netRealizedUsdt}`, color: netUsdt >= 0 ? '#22c55e' : '#f43f5e' },
                { label: 'Scoreboard', value: `${wins}W / ${botState.paperTrades.length - wins}L`, sub: `WR ${wr}%` },
              ],
              footer: `AI Renko (${ATR_LEN},${FACTOR}) Brick=${(BRICK_PCT * 100).toFixed(1)}% • EMA${EMA_LEN}`,
            },
          });
        }
      }
    }

    // 2. Check new entry on AI Renko flip aligned with EMA(200)
    if (!botState.pos && sig.flipped) {
      const emaOk = !EMA_LEN || !sig.ema || (sig.trend === 1 ? b.c > sig.ema : b.c < sig.ema);
      if (!emaOk) continue;

      const side = sig.trend === 1 ? 'LONG' : 'SHORT';
      const sl = +(side === 'LONG' ? b.c * (1 - SL_PCT) : b.c * (1 + SL_PCT)).toFixed(2);

      let liveNote = '';
      let liveBlocked = false;
      if (AUTO_TRADE && trader) {
        try {
          const { amt } = await inspectBinancePosition(trader);
          if (Math.abs(amt) > 0) {
            liveBlocked = true;
            const key = `${SYMBOL}:${amt}`;
            liveNote = `\n⏸️ LIVE SKIPPED: Unmanaged ${SYMBOL} position (${amt} ETH) already open on Binance — standing by cleanly.`;
            if (botState.unmanagedAlertKey !== key) {
              botState.unmanagedAlertKey = key;
              await notify(`⚠️ ${BOT_NAME} saw unmanaged ${SYMBOL} position (${amt} ETH). Standing by without interfering.`);
            }
          } else {
            botState.unmanagedAlertKey = '';
            const bal = await trader.getUsdtBalances();
            const marginUsdt = +Math.min(bal.available * 0.95, Math.max(bal.wallet, bal.available) * MARGIN_FRAC).toFixed(2);
            const ord = await trader.openSingleStopTrade({
              symbol: SYMBOL,
              side,
              marginUsdt,
              leverage: LEVERAGE,
              stopPrice: sl,
              entryHint: b.c,
            });
            if (ord.placed) {
              botState.livePos = {
                side,
                qty: ord.qty,
                entry: ord.avgPrice,
                sl: ord.stopPrice,
                stopAlgoId: ord.stopAlgoId,
                leverage: LEVERAGE,
                marginUsdt,
                liveOrderPlaced: true,
                entryTs: b.t,
              };
              botState.pos = { side, entry: ord.avgPrice, sl: ord.stopPrice, entryTs: b.t };
              liveNote = `\n✅ LIVE BINANCE (${LEVERAGE}x Isolated): Qty=${ord.qty} ETH @ $${ord.avgPrice} | Stop=$${ord.stopPrice} (Algo=${ord.stopAlgoId || 'PENDING'})${ord.warning ? ` ⚠️ ${ord.warning}` : ''}`;
            } else {
              liveBlocked = true;
              liveNote = `\n⚠️ LIVE SKIPPED (${ord.reason}${ord.notional !== undefined ? `: $${ord.notional} < min $${ord.minNotional}` : ''})`;
            }
          }
        } catch (e) {
          liveBlocked = true;
          liveNote = `\n❌ Binance ENTER Error: ${e.message}`;
        }
      } else {
        botState.pos = { side, entry: b.c, sl, entryTs: b.t };
      }

      if (liveBlocked) {
        botState.pos = null;
      }

      if (!OFFLINE || isLatestBar) {
        const execBadge = botState.livePos?.liveOrderPlaced ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER';
        const enterText =
          `🟢 ENTER (${botState.livePos?.liveOrderPlaced ? 'LIVE BINANCE' : 'PAPER'}) ${SYMBOL} ${TF} ${side} [AI Renko (${ATR_LEN},${FACTOR})]\n` +
          `Entry: $${(botState.pos?.entry || b.c).toFixed(2)} | Protective SL (${(SL_PCT * 100).toFixed(0)}%): $${(botState.pos?.sl || sl).toFixed(2)} | EMA${EMA_LEN}: $${sig.ema ? sig.ema.toFixed(1) : 'n/a'}${liveNote}`;
        await notify(OFFLINE ? enterText : {
          text: enterText,
          card: {
            kind: side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
            title: `ETH BINANCE • ${SYMBOL} ${TF}`,
            subtitle: `AI Renko (${ATR_LEN},${FACTOR}) Brick ${(BRICK_PCT * 100).toFixed(1)}% • EMA${EMA_LEN}`,
            execBadge,
            ts: b.t,
            bars: bars.slice(Math.max(0, i - 47), i + 1),
            levels: [
              { price: botState.pos?.entry || b.c, label: `ENTRY $${(botState.pos?.entry || b.c).toFixed(1)}`, color: '#38bdf8' },
              { price: botState.pos?.sl || sl, label: `SL $${(botState.pos?.sl || sl).toFixed(1)}`, color: '#ef4444' },
            ],
            metrics: [
              { label: 'Side & Entry', value: `${side} @ $${(botState.pos?.entry || b.c).toFixed(1)}`, sub: `AI Renko Flip` },
              { label: 'Hard Stop Cap', value: `$${(botState.pos?.sl || sl).toFixed(1)}`, sub: `-${(SL_PCT * 100).toFixed(0)}% Protective SL` },
              { label: 'Position Sizing', value: botState.livePos?.qty ? `${botState.livePos.qty} ETH` : `${Math.round(MARGIN_FRAC * 100)}% Wallet`, sub: `${LEVERAGE}x Isolated` },
              { label: 'Macro Tide', value: `EMA${EMA_LEN} $${sig.ema ? sig.ema.toFixed(0) : 'n/a'}`, sub: `ADX ${sig.adx.toFixed(1)}` },
            ],
            footer: `Crypto-Tuned AI Renko 4h • Exchange Reduce-Only STOP_MARKET`,
          },
        });
      }
    }
  }
}

async function main() {
  const botState = OFFLINE ? makeDefaultBotState() : loadJsonState(STATE_PATH, makeDefaultBotState);
  const trader = !OFFLINE && HAS_KEYS ? createBinanceFuturesTrade() : null;
  const badge = OFFLINE ? 'OFFLINE REPLAY' : (AUTO_TRADE ? `LIVE ${LEVERAGE}x ISOLATED` : 'PAPER LIVE');
  console.log(`[${BOT_NAME}] Starting (${badge}) | ${SYMBOL} ${TF} | Renko=(${ATR_LEN},${FACTOR}) Brick=${(BRICK_PCT * 100).toFixed(1)}% ADX>=${ADX_MIN} EMA${EMA_LEN} SL=${(SL_PCT * 100).toFixed(0)}% | MarginFrac=${MARGIN_FRAC} | KeysConfigured=${HAS_KEYS}`);

  await scanOnce(trader, botState);
  if (OFFLINE) {
    const tr = botState.paperTrades;
    const wins = tr.filter((x) => x.netUsdt > 0).length;
    console.log(`\n=== OFFLINE ${SYMBOL} ${TF} SUMMARY: ${tr.length} trades, WR=${tr.length ? ((wins / tr.length) * 100).toFixed(1) : 0}%, Uncompounded Net=$${botState.netRealizedUsdt} ===`);
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
        balLine = `Avail: $${bal.available.toFixed(2)} / Wallet: $${bal.wallet.toFixed(2)} | Binance Pos: ${posInfo.amt} ETH`;
      } catch (e) {
        balLine = `Binance Check Err: ${e.message}`;
      }
    }
    await notify(
      `Ξ ETH AI Renko Bot Online (${badge})\n` +
      `Pair: ${SYMBOL} ${TF} (${ATR_LEN},${FACTOR} Brick=${(BRICK_PCT * 100).toFixed(1)}% EMA${EMA_LEN} SL=${(SL_PCT * 100).toFixed(0)}%) | Last Close: $${botState.lastClosePx || '?'}\n` +
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
