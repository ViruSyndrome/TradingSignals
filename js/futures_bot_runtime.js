'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramBot } = require('node-telegram-bot-api');
const { createDhanClient, isDhanConfigured } = require('./dhan_client.js');
const { createDhanNiftyTrade } = require('./dhan_nifty_trade.js');
const { renderTradeCardPng } = require('./tg_card.js');

const DEFAULT_CONTRACTS = {
  NIFTY: {
    symbol: 'NIFTY',
    signalSeg: 'IDX_I',
    signalInst: 'INDEX',
    signalScripEnv: 'PATRICK_NIFTY_SIG_SCRIP',
    defaultSigScrip: '13',
    execSeg: 'NSE_FNO',
    execInst: 'FUTIDX',
    optSeg: 'NSE_FNO',
    execScripEnv: 'DHAN_NIFTY_FUT_SCRIP',
    lotQty: 65,
    strikeStep: 50,
    tickSize: 0.05,
    productType: 'MARGIN',
  },
  SENSEX: {
    symbol: 'SENSEX',
    signalSeg: 'IDX_I',
    signalInst: 'INDEX',
    signalScripEnv: 'AI_RENKO_SENSEX_SIG_SCRIP',
    defaultSigScrip: '51',
    execSeg: 'BSE_FNO',
    execInst: 'OPTIDX',
    optSeg: 'BSE_FNO',
    lotQty: 20,
    strikeStep: 100,
    tickSize: 0.05,
    productType: 'MARGIN',
  },
  CRUDEOIL: {
    symbol: 'CRUDEOIL',
    signalSeg: 'MCX_COMM',
    signalInst: 'FUTCOM',
    signalScripEnv: 'DHAN_CRUDEOIL_SCRIP',
    defaultSigScrip: '576264',
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

function escapeTgHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramHtml(botLabel, text) {
  const lines = String(text || '').split('\n');
  const head = escapeTgHtml(lines[0] || '');
  const body = lines.slice(1).map((l) => {
    const m = l.match(/^([^:|]+):\s*(.+)$/);
    if (m && m[1].length <= 28) {
      return `<b>${escapeTgHtml(m[1])}:</b> <code>${escapeTgHtml(m[2])}</code>`;
    }
    return escapeTgHtml(l);
  }).join('\n');
  return body ? `<b>[${escapeTgHtml(botLabel)}] ${head}</b>\n${body}` : `<b>[${escapeTgHtml(botLabel)}] ${head}</b>`;
}

function createNotifier(botLabel) {
  const tgDisabled = String(process.env.NOTIFY_TELEGRAM || 'true').toLowerCase() === 'false';
  const token = tgDisabled ? null : process.env.TELEGRAM_BOT_TOKEN;
  const chatId = tgDisabled ? null : process.env.TELEGRAM_CHAT_ID;
  const tg = token && chatId ? new TelegramBot(token, { polling: false }) : null;
  return async function notify(msgOrOpts) {
    const isObj = msgOrOpts && typeof msgOrOpts === 'object' && !Array.isArray(msgOrOpts);
    const rawText = isObj ? String(msgOrOpts.text || '') : String(msgOrOpts || '');
    const card = isObj ? msgOrOpts.card : null;
    const line = `[${botLabel}] ${rawText}`;
    console.log(line);
    if (!tg || !chatId) return;

    const html = formatTelegramHtml(botLabel, rawText);
    try {
      if (card) {
        const png = renderTradeCardPng(card);
        if (png && png.length > 0) {
          const caption = html.length <= 1000 ? html : `${html.slice(0, 990)}...`;
          await Promise.race([
            tg.sendPhoto(chatId, png, { caption, parse_mode: 'HTML' }, { filename: 'trade_card.png', contentType: 'image/png' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Telegram photo timeout 7000ms')), 7000)),
          ]);
          return;
        }
      }
      await Promise.race([
        tg.sendMessage(chatId, html, { parse_mode: 'HTML', disable_web_page_preview: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Telegram timeout 5000ms')), 5000)),
      ]);
    } catch (e) {
      console.error(`[${botLabel}] Telegram send failed:`, e.message);
      try {
        await tg.sendMessage(chatId, line, { disable_web_page_preview: true });
      } catch (_) {}
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
  const tfMin = tfToMinutes(tf);
  const apiInterval = tfMin === 60 ? '60' : tfMin === 5 ? '5' : '15';

  // Prefer shared local TrendRunner OHLC cache (45s TTL + dedupe) to prevent Dhan 429 rate limits across PM2 bots
  if (String(process.env.DHAN_SHARED_CACHE || 'true').toLowerCase() !== 'false') {
    const localPort = Number(process.env.DHAN_CACHE_PORT || process.env.PORT || 3000);
    const localUrl = `http://127.0.0.1:${localPort}/api/dhan/ohlc?securityId=${encodeURIComponent(String(scripId))}&exchangeSegment=${encodeURIComponent(spec.signalSeg)}&instrument=${encodeURIComponent(spec.signalInst)}&interval=${encodeURIComponent(apiInterval)}&daysBack=${encodeURIComponent(String(daysBack))}`;
    try {
      const ctrl = new AbortController();
      const tmo = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(localUrl, { signal: ctrl.signal });
      clearTimeout(tmo);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && Array.isArray(j.rows) && j.rows.length > 0) {
          const bars = rowsToBars(j.rows);
          return tfMin === 30 ? resampleBars(bars, 30) : bars;
        }
      }
    } catch (_) {
      // Fall back to direct Dhan API if local trendrunner proxy is not running
    }
  }

  const toMs = Date.now();
  const fromMs = toMs - daysBack * 86400000;
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

async function getSpotLtp(dhan, symbol = 'NIFTY') {
  if (!dhanReady(dhan)) return null;
  const spec = DEFAULT_CONTRACTS[String(symbol || 'NIFTY').toUpperCase()] || DEFAULT_CONTRACTS.NIFTY;
  const scrip = (spec.signalScripEnv && process.env[spec.signalScripEnv]) || spec.defaultSigScrip || '13';
  return dhan.getMarketLtp(spec.signalSeg || 'IDX_I', String(scrip));
}

async function getNiftySpotLtp(dhan) {
  return getSpotLtp(dhan, 'NIFTY');
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
 * Pick live 7–25 DTE Index Option contract (CE on LONG, PE on SHORT), or deterministic offline estimate.
 */
async function resolveSwingOption({
  dhan,
  instrumentId = 'NIFTY',
  side,
  spot,
  minDteDays = 7,
  maxDteDays = 25,
  strikeMode = 'atm',
  offline = false,
}) {
  const inst = String(instrumentId || 'NIFTY').toUpperCase();
  const spec = DEFAULT_CONTRACTS[inst] || DEFAULT_CONTRACTS.NIFTY;
  const step = Number(spec.strikeStep) || (inst === 'SENSEX' ? 100 : 50);
  const optSeg = spec.optSeg || (inst === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO');
  const optType = side === 'LONG' ? 'CE' : 'PE';
  const baseStrike = side === 'LONG' ? Math.floor(spot / step) * step : Math.ceil(spot / step) * step;
  const strike = strikeMode === 'itm' ? (side === 'LONG' ? baseStrike - step : baseStrike + step) : baseStrike;
  if (!offline && dhan && isDhanConfigured()) {
    try {
      const optHelper = createDhanNiftyTrade({ client: dhan, instrumentId: inst, productType: 'MARGIN' });
      const pick = await optHelper.pickOptionContract({ side, spot, minDteDays, maxDteDays, strikeMode });
      const px = pick.ask > 0 ? pick.ask : pick.ltp;
      if (px > 0) {
        return {
          label: `${pick.strike} ${pick.optSide} (${pick.expiry})`,
          expiry: pick.expiry,
          strike: pick.strike,
          optSide: pick.optSide,
          optSeg,
          securityId: pick.securityId,
          premium: +px.toFixed(2),
          delta: +(pick.delta || 0.55).toFixed(2),
          live: true,
        };
      }
    } catch (e) {
      console.warn(`[SwingOpt] ${inst} Option resolution failed for ${side} @ ${spot} (falling back to Est):`, e.message);
    }
  }
  return {
    label: `${strike} ${optType} (Est)`,
    expiry: null,
    strike,
    optSide: optType,
    optSeg,
    securityId: null,
    premium: inst === 'SENSEX' ? 950.0 : 170.0,
    delta: strikeMode === 'itm' ? 0.65 : 0.52,
    live: false,
  };
}

/**
 * Read live Dhan Option LTP when live securityId is present, else fall back to calibrated delta/gamma/theta estimate.
 */
async function fetchOptionLiveOrEstExit({
  dhan,
  securityId,
  exchangeSegment = 'NSE_FNO',
  live,
  side,
  entryIdx,
  entryOpt,
  exitIdx,
  delta = 0.55,
  entryTs,
  exitTs,
  offline = false,
}) {
  const seg = exchangeSegment || 'NSE_FNO';
  if (!offline && live && securityId && dhan && isDhanConfigured()) {
    try {
      const ltp = await dhan.getMarketLtp(seg, securityId);
      if (ltp > 0) return +ltp.toFixed(2);
    } catch (_) {
      // Fallback below
    }
  }
  const idxMove = side === 'LONG' ? (exitIdx - entryIdx) : (entryIdx - exitIdx);
  const d = delta || 0.55;
  const gammaCoef = seg === 'BSE_FNO' ? 0.00015 : 0.0005;
  const rawMove = idxMove > 0
    ? idxMove * d + gammaCoef * idxMove * idxMove
    : Math.max(-(entryOpt - 5), idxMove * d * 0.85);
  const holdDays = Math.max(0.05, ((exitTs || Date.now()) - (entryTs || Date.now())) / 86400000);
  const thetaPerDay = seg === 'BSE_FNO' ? 8 : 10;
  const thetaEst = Math.min(holdDays, 6) * thetaPerDay;
  return +Math.max(1, entryOpt + rawMove - thetaEst).toFixed(2);
}

/**
 * Execute an isolated Dhan carry-forward (MARGIN) Option BUY/SELL MARKET order with margin & position guards.
 */
async function executeOptionSwingOrder(dhan, {
  autoTrade,
  securityId,
  exchangeSegment = 'NSE_FNO',
  txType, // 'BUY' | 'SELL'
  lots = 1,
  qtyPerLot = 65,
  estPremium = 0,
  productType = 'MARGIN',
  tag = 'OPTBOT',
  minRemainingRs = 0,
  nowMs = Date.now(),
}) {
  const seg = exchangeSegment || 'NSE_FNO';
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
    exchangeSegment: seg,
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
  getSpotLtp,
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
