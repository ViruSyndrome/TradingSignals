'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramBot } = require('node-telegram-bot-api');
const { createDhanClient, isDhanConfigured } = require('./dhan_client.js');
const { createDhanNiftyTrade } = require('./dhan_nifty_trade.js');

const DEFAULT_CONTRACTS = {
  NIFTY: {
    symbol: 'NIFTY',
    signalSeg: 'IDX_I',
    signalInst: 'INDEX',
    signalScripEnv: 'PATRICK_NIFTY_SIG_SCRIP',
    defaultSigScrip: '13',
    execSeg: 'NSE_FNO',
    execInst: 'FUTIDX',
    execScripEnv: 'DHAN_NIFTY_FUT_SCRIP',
    lotQty: 65,
    tickSize: 0.05,
    productType: 'MARGIN',
  },
  CRUDEOIL: {
    symbol: 'CRUDEOIL',
    signalSeg: 'MCX_COMM',
    signalInst: 'FUTCOM',
    signalScripEnv: 'DHAN_CRUDEOIL_SCRIP',
    defaultSigScrip: '573422',
    execSeg: 'MCX_COMM',
    execInst: 'FUTCOM',
    execScripEnv: 'DHAN_CRUDEOIL_EXEC_SCRIP',
    lotQty: 100, // Standard MCX CRUDEOIL (1 lot = 100 bbl; set DHAN_CRUDEOIL_MINI=true for CRUDEOILM 10 bbl)
    tickSize: 1.0,
    productType: 'MARGIN',
  },
  XAU: {
    symbol: 'XAU',
    feed: 'binance_futures',
    binanceSymbol: 'XAUUSDT',
    execSeg: 'MCX_COMM',
    execInst: 'FUTCOM',
    execScripEnv: 'DHAN_GOLDM_FUT_SCRIP',
    lotQty: 1, // GOLDM MCX Futures uses lot=1 in qty=units or check broker spec; alert-first by default
    tickSize: 1.0,
    productType: 'MARGIN',
  },
};

function createNotifier(botLabel) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const tg = token && chatId ? new TelegramBot(token, { polling: false }) : null;
  return async function notify(text) {
    const line = `[${botLabel}] ${text}`;
    console.log(line);
    if (!tg || !chatId) return;
    try {
      await Promise.race([
        tg.sendMessage(chatId, line, { disable_web_page_preview: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Telegram timeout 5000ms')), 5000)),
      ]);
    } catch (e) {
      console.error(`[${botLabel}] Telegram send failed:`, e.message);
    }
  };
}

function loadJsonState(filePath, makeDefault) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn(`[State] Failed reading ${filePath}, reinitializing:`, e.message);
  }
  return makeDefault();
}

function saveJsonState(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function tfToMinutes(tf) {
  if (tf === '5m') return 5;
  if (tf === '15m') return 15;
  if (tf === '30m') return 30;
  if (tf === '1h') return 60;
  return 15;
}

/** Keep only bars whose candle close timestamp <= now - graceMs (prevents repainting). */
function completedBars(bars, tf, nowMs = Date.now()) {
  const barMs = tfToMinutes(tf) * 60000;
  return bars.filter((b) => b.t + barMs <= nowMs - 2000);
}

function rowsToBars(rows) {
  return rows
    .map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5] || 0),
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

function resampleBars(bars, minutes) {
  const barMs = minutes * 60000;
  const map = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / barMs) * barMs;
    const cur = map.get(k);
    if (!cur) map.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function fetchSymbolBars(dhan, sym, tf = '15m', daysBack = 25) {
  const spec = DEFAULT_CONTRACTS[sym];
  if (!spec) throw new Error(`Unknown futures symbol: ${sym}`);

  if (spec.feed === 'binance_futures') {
    const interval = tf === '1h' ? '1h' : tf === '30m' ? '30m' : '15m';
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${spec.binanceSymbol}&interval=${interval}&limit=500`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance FAPI HTTP ${r.status} for ${spec.binanceSymbol}`);
    const data = await r.json();
    return rowsToBars(data);
  }

  if (!dhan) throw new Error(`Dhan client unavailable for ${sym}`);
  const scripId = process.env[spec.signalScripEnv] || spec.defaultSigScrip;
  const toMs = Date.now();
  const fromMs = toMs - daysBack * 86400000;
  const tfMin = tfToMinutes(tf);
  const apiInterval = tfMin === 60 ? '60' : tfMin === 5 ? '5' : '15';
  const rows = await dhan.getIntradayRange({
    securityId: String(scripId),
    exchangeSegment: spec.signalSeg,
    instrument: spec.signalInst,
    interval: apiInterval,
    fromMs,
    toMs,
    chunkDays: 20,
    pauseMs: 280,
  });
  const bars = rowsToBars(rows);
  return tfMin === 30 ? resampleBars(bars, 30) : bars;
}

/**
 * Execute an isolated Dhan Futures entry / partial / exit order with explicit auto-trade guard.
 * Each bot maintains its own virtual capital & lot count; manual trades elsewhere remain untouched.
 */
async function executeFuturesOrder(dhan, {
  autoTrade,
  sym,
  txType, // 'BUY' | 'SELL'
  lots,
  orderType = 'MARKET',
  triggerPrice = null,
  tag = 'FUTBOT',
}) {
  const spec = DEFAULT_CONTRACTS[sym];
  const scripId = (process.env[spec.execScripEnv] || (sym === 'CRUDEOIL' ? process.env[spec.signalScripEnv] || spec.defaultSigScrip : '')).trim();
  const qty = Math.max(1, Math.round(lots * spec.lotQty));

  if (!autoTrade) {
    return { simulated: true, reason: 'AUTO_TRADE=false', sym, txType, qty, lots };
  }
  if (!dhan || !isDhanConfigured()) {
    return { simulated: true, reason: 'DHAN_NOT_CONFIGURED', sym, txType, qty, lots };
  }
  if (!scripId) {
    return { simulated: true, reason: `MISSING_${spec.execScripEnv}`, sym, txType, qty, lots };
  }

  const body = {
    transactionType: txType,
    exchangeSegment: spec.execSeg,
    productType: spec.productType,
    orderType,
    validity: 'DAY',
    securityId: String(scripId),
    quantity: qty,
    disclosedQuantity: 0,
    price: 0,
    afterMarketOrder: false,
    correlationId: `${tag}_${sym}_${Date.now()}`.slice(0, 25),
  };
  if (triggerPrice != null) body.triggerPrice = Number(triggerPrice.toFixed(2));
  const res = await dhan.placeOrder(body);
  return { simulated: false, orderId: res?.orderId || null, raw: res, sym, txType, qty, lots };
}

function roundToTick(px, tick = 0.05) {
  return Math.round(px / tick) * tick;
}

/**
 * Place an exchange-side STOP_LOSS_MARKET order (or simulate in PAPER mode).
 */
async function placeExchangeSlOrder(dhan, {
  autoTrade,
  sym,
  txType, // closing side: 'SELL' for long, 'BUY' for short
  lots,
  triggerPrice,
  tag = 'FUTBOT_SL',
}) {
  const spec = DEFAULT_CONTRACTS[sym];
  const scripId = (process.env[spec.execScripEnv] || (sym === 'CRUDEOIL' ? process.env[spec.signalScripEnv] || spec.defaultSigScrip : '')).trim();
  const qty = Math.max(1, Math.round(lots * spec.lotQty));
  const trig = Number(roundToTick(Number(triggerPrice), 0.05).toFixed(2));
  if (!autoTrade) {
    return { simulated: true, slOrderId: `PAPER_SL_${Date.now()}`, triggerPrice: trig, qty };
  }
  if (!dhan || !isDhanConfigured() || !scripId) {
    return { simulated: true, reason: 'DHAN_OR_SCRIP_MISSING', triggerPrice: trig, qty };
  }
  try {
    const res = await dhan.placeOrder({
      transactionType: txType,
      exchangeSegment: spec.execSeg,
      productType: spec.productType,
      orderType: 'STOP_LOSS_MARKET',
      validity: 'DAY',
      securityId: String(scripId),
      quantity: qty,
      disclosedQuantity: 0,
      price: 0,
      triggerPrice: trig,
      afterMarketOrder: false,
      correlationId: `${tag}_${sym}_${Date.now()}`.slice(0, 25),
    });
    return { simulated: false, slOrderId: res?.orderId || null, triggerPrice: trig, qty, raw: res };
  } catch (e) {
    return { simulated: false, error: e.message, triggerPrice: trig, qty };
  }
}

async function modifyExchangeSlOrder(dhan, { autoTrade, slOrderId, triggerPrice, lots, sym }) {
  const trig = Number(roundToTick(Number(triggerPrice), 0.05).toFixed(2));
  if (!autoTrade || !slOrderId || String(slOrderId).startsWith('PAPER_')) {
    return { simulated: true, slOrderId, triggerPrice: trig };
  }
  const spec = DEFAULT_CONTRACTS[sym];
  const qty = Math.max(1, Math.round(lots * spec.lotQty));
  try {
    const res = await dhan.modifyOrder(slOrderId, {
      orderType: 'STOP_LOSS_MARKET',
      validity: 'DAY',
      quantity: qty,
      price: 0,
      triggerPrice: trig,
    });
    return { simulated: false, slOrderId, triggerPrice: trig, raw: res };
  } catch (e) {
    return { simulated: false, error: e.message, slOrderId, triggerPrice: trig };
  }
}

async function cancelExchangeOrder(dhan, { autoTrade, orderId }) {
  if (!autoTrade || !orderId || String(orderId).startsWith('PAPER_')) {
    return { simulated: true, orderId };
  }
  try {
    const res = await dhan.cancelOrder(orderId);
    return { simulated: false, orderId, raw: res };
  } catch (e) {
    return { simulated: false, error: e.message, orderId };
  }
}

async function hasOpenFuturesPosition(dhan, sym) {
  const spec = DEFAULT_CONTRACTS[sym];
  const scripId = (process.env[spec.execScripEnv] || (sym === 'CRUDEOIL' ? process.env[spec.signalScripEnv] || spec.defaultSigScrip : '')).trim();
  if (!dhan || !isDhanConfigured() || !scripId) return true; // fail-safe in offline/paper mode
  try {
    const pos = await dhan.getPositions();
    const list = Array.isArray(pos) ? pos : (pos?.data || []);
    const row = list.find((p) => String(p.securityId) === String(scripId));
    return row ? Number(row.netQty || 0) !== 0 : false;
  } catch {
    return true;
  }
}

function getIstClock(nowMs = Date.now()) {
  const dt = new Date(nowMs);
  const dateStr = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const parts = dt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).split(':').map(Number);
  const dow = dt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const mins = (parts[0] || 0) * 60 + (parts[1] || 0);
  const isWeekday = dow !== 'Sat' && dow !== 'Sun';
  return { dateStr, mins, isWeekday, isOpen: isWeekday && mins >= 555 && mins < 930 };
}

function dhanReady(dhan) {
  return Boolean(dhan && (typeof dhan.isConfigured === 'function' ? dhan.isConfigured() : isDhanConfigured()));
}

async function getNiftySpotLtp(dhan) {
  if (!dhanReady(dhan)) return null;
  return dhan.getMarketLtp('IDX_I', '13');
}

async function getAvailableBalance(dhan) {
  if (!dhanReady(dhan)) return null;
  try {
    const f = await dhan.getFundLimits();
    const bal = f?.availabelBalance ?? f?.availableBalance ?? f?.data?.availabelBalance ?? f?.data?.availableBalance;
    return Number.isFinite(Number(bal)) ? Number(bal) : null;
  } catch {
    return null;
  }
}

async function hasOpenSecurityPosition(dhan, securityId) {
  if (!dhanReady(dhan) || !securityId) return false;
  try {
    const pos = await dhan.getPositions();
    const list = Array.isArray(pos) ? pos : (pos?.data || []);
    const row = list.find((p) => String(p.securityId) === String(securityId));
    return row ? Number(row.netQty || 0) > 0 : false;
  } catch {
    return true; // fail-safe on network glitch
  }
}

/**
 * Pick live 7–21 DTE NIFTY Option contract (CE on LONG, PE on SHORT), or deterministic offline estimate.
 */
async function resolveSwingOption({
  dhan,
  side,
  spot,
  minDteDays = 7,
  maxDteDays = 25,
  strikeMode = 'atm',
  offline = false,
}) {
  const optType = side === 'LONG' ? 'CE' : 'PE';
  const baseStrike = side === 'LONG' ? Math.floor(spot / 50) * 50 : Math.ceil(spot / 50) * 50;
  const strike = strikeMode === 'itm' ? (side === 'LONG' ? baseStrike - 50 : baseStrike + 50) : baseStrike;
  if (!offline && dhan && isDhanConfigured()) {
    try {
      const optHelper = createDhanNiftyTrade({ client: dhan, instrumentId: 'NIFTY', productType: 'MARGIN' });
      const pick = await optHelper.pickOptionContract({ side, spot, minDteDays, maxDteDays, strikeMode });
      const px = pick.ask > 0 ? pick.ask : pick.ltp;
      if (px > 0) {
        return {
          label: `${pick.strike} ${pick.optSide} (${pick.expiry})`,
          expiry: pick.expiry,
          strike: pick.strike,
          optSide: pick.optSide,
          securityId: pick.securityId,
          premium: +px.toFixed(2),
          delta: +(pick.delta || 0.58).toFixed(2),
          live: true,
        };
      }
    } catch (e) {
      console.warn(`[SwingOpt] Option resolution failed for ${side} @ ${spot} (falling back to Est):`, e.message);
    }
  }
  return {
    label: `${strike} ${optType} (Est)`,
    expiry: null,
    strike,
    optSide: optType,
    securityId: null,
    premium: 170.0,
    delta: strikeMode === 'itm' ? 0.65 : 0.58,
    live: false,
  };
}

/**
 * Read live Dhan Option LTP when live securityId is present, else fall back to calibrated delta/gamma/theta estimate.
 */
async function fetchOptionLiveOrEstExit({
  dhan,
  securityId,
  live,
  side,
  entryIdx,
  entryOpt,
  exitIdx,
  delta = 0.58,
  entryTs,
  exitTs,
  offline = false,
}) {
  if (!offline && live && securityId && dhan && isDhanConfigured()) {
    try {
      const ltp = await dhan.getMarketLtp('NSE_FNO', securityId);
      if (ltp > 0) return +ltp.toFixed(2);
    } catch (_) {
      // Fallback below
    }
  }
  const idxMove = side === 'LONG' ? (exitIdx - entryIdx) : (entryIdx - exitIdx);
  const d = delta || 0.58;
  const rawMove = idxMove > 0
    ? idxMove * d + 0.0005 * idxMove * idxMove
    : Math.max(-(entryOpt - 5), idxMove * d * 0.85);
  const holdDays = Math.max(0.05, ((exitTs || Date.now()) - (entryTs || Date.now())) / 86400000);
  const thetaEst = Math.min(holdDays, 4) * 10;
  return +Math.max(1, entryOpt + rawMove - thetaEst).toFixed(2);
}

/**
 * Execute an isolated Dhan carry-forward (MARGIN) Option BUY/SELL MARKET order with margin & position guards.
 */
async function executeOptionSwingOrder(dhan, {
  autoTrade,
  securityId,
  txType, // 'BUY' | 'SELL'
  lots = 1,
  qtyPerLot = 65,
  estPremium = 0,
  productType = 'MARGIN',
  tag = 'OPTBOT',
  minRemainingRs = 0,
  nowMs = Date.now(),
}) {
  const qty = Math.max(1, Math.round(lots * qtyPerLot));
  if (!autoTrade) {
    return { simulated: true, reason: 'AUTO_TRADE=false', txType, qty, lots };
  }
  if (!dhanReady(dhan) || !securityId) {
    return { skipped: true, reason: 'DHAN_OR_SECURITY_ID_MISSING', txType, qty, lots };
  }
  const clk = getIstClock(nowMs);
  if (!clk.isOpen) {
    return { skipped: true, reason: 'MARKET_CLOSED', txType, qty, lots };
  }
  if (txType === 'BUY' && estPremium > 0) {
    const avail = await getAvailableBalance(dhan);
    const needed = +(estPremium * qty * 1.03).toFixed(2);
    if (avail !== null && avail < needed) {
      return { skipped: true, reason: 'INSUFFICIENT_FUNDS', avail, needed, txType, qty, lots };
    }
    if (avail !== null && minRemainingRs > 0 && avail < needed + minRemainingRs) {
      return { skipped: true, reason: 'RESERVED_FOR_PRIORITY', avail, needed, minRemainingRs, txType, qty, lots };
    }
  }
  if (txType === 'SELL') {
    const isOpen = await hasOpenSecurityPosition(dhan, securityId);
    if (!isOpen) {
      return { skipped: true, reason: 'NO_OPEN_POSITION', txType, qty, lots };
    }
  }

  const res = await dhan.placeOrder({
    transactionType: txType,
    exchangeSegment: 'NSE_FNO',
    productType,
    orderType: 'MARKET',
    validity: 'DAY',
    securityId: String(securityId),
    quantity: qty,
    disclosedQuantity: 0,
    price: 0,
    triggerPrice: 0,
    afterMarketOrder: false,
    correlationId: `${tag}_${securityId}_${Date.now()}`.slice(0, 28),
  });
  return { simulated: false, placed: true, orderId: res?.orderId || null, raw: res, txType, qty, lots };
}

module.exports = {
  DEFAULT_CONTRACTS,
  createNotifier,
  loadJsonState,
  saveJsonState,
  completedBars,
  rowsToBars,
  resampleBars,
  fetchSymbolBars,
  executeFuturesOrder,
  placeExchangeSlOrder,
  modifyExchangeSlOrder,
  cancelExchangeOrder,
  hasOpenFuturesPosition,
  getIstClock,
  getNiftySpotLtp,
  getAvailableBalance,
  hasOpenSecurityPosition,
  resolveSwingOption,
  fetchOptionLiveOrEstExit,
  executeOptionSwingOrder,
  roundToTick,
  createDhanClient,
  isDhanConfigured,
};
