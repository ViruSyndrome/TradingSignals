require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Load exact same indicator math as the frontend — now via proper require()
const CONFIG      = require('./js/config.js');
const Indicators  = require('./js/indicators.js');
const Signals     = require('./js/signals.js');
const RedBarTrend = require('./js/redbar_trend.js');
// --- Node.js Polyfills for Browser API ---
if (typeof global.localStorage === 'undefined') {
  global.localStorage = {
    _data: {},
    getItem: function(key) { return this._data[key] || null; },
    setItem: function(key, val) { this._data[key] = String(val); },
    removeItem: function(key) { delete this._data[key]; }
  };
}
const { API } = require('./js/api.js');
const { renderTweetCardPng, TW_OG_FALLBACK } = require('./js/tweet_card.js');
const TrendRunnerCopy = require('./js/public_copy.js');

global.CONFIG = CONFIG;
global.Indicators = Indicators; // signals.js references Indicators as a global
global.RedBarTrend = RedBarTrend;

// Silence legacy Render container so only the Oracle VM sends Telegram alerts & trades
const isLegacyRenderHost = Boolean(
  process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL
) && String(process.env.ALLOW_RENDER_BOT || '').toLowerCase() !== 'true';
if (isLegacyRenderHost) {
  console.log('[Bot] Legacy Render host detected — Telegram & scanner disabled (Oracle VM is primary).');
}
const token = isLegacyRenderHost ? null : process.env.TELEGRAM_BOT_TOKEN;
const chatId = isLegacyRenderHost ? null : process.env.TELEGRAM_CHAT_ID;
const pollingEnabled = Boolean(token && chatId) && process.env.TELEGRAM_POLLING === 'true';

const { TwitterApi } = require('twitter-api-v2');

function envTrim(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : v;
}

// Initialize Twitter Client (if keys are provided)
let twitterClient = null;
const twKey = envTrim('TWITTER_API_KEY');
const twSecret = envTrim('TWITTER_API_SECRET');
const twAccess = envTrim('TWITTER_ACCESS_TOKEN');
const twAccessSecret = envTrim('TWITTER_ACCESS_SECRET');
if (twKey && twSecret && twAccess && twAccessSecret) {
  twitterClient = new TwitterApi({
    appKey: twKey,
    appSecret: twSecret,
    accessToken: twAccess,
    accessSecret: twAccessSecret,
  }).readWrite;
  console.log('🐦 Twitter client initialized successfully.');
  // Prove which account the Access Token belongs to (does not post).
  twitterClient.v2.me().then((me) => {
    const u = me?.data;
    console.log(`🐦 Twitter auth OK as @${u?.username || '?'} (id ${u?.id || '?'})`);
  }).catch((err) => {
    const detail = err?.data?.detail || err?.message || String(err);
    console.error(`🐦 Twitter auth check failed (${err?.code || ''}): ${detail}`);
    if (err?.data) console.error('🐦 Twitter auth error body:', JSON.stringify(err.data));
  });
  // Optional one-shot: set TWITTER_SMOKE_TEST=true in Render, deploy once, then turn it off.
  if (String(process.env.TWITTER_SMOKE_TEST || '').toLowerCase() === 'true') {
    const smoke = `TrendRunner API smoke test ${new Date().toISOString()}`;
    twitterClient.v2.tweet(smoke).then((r) => {
      console.log(`🐦 Smoke tweet OK id=${r?.data?.id || '?'}`);
    }).catch((err) => {
      const detail = err?.data?.detail || err?.message || String(err);
      console.error(`🐦 Smoke tweet FAILED (${err?.code || ''}): ${detail}`);
      if (err?.data) console.error('🐦 Smoke error body:', JSON.stringify(err.data));
      if (err?.rateLimit) console.error('🐦 Smoke rateLimit:', JSON.stringify(err.rateLimit));
    });
  }
} else {
  console.log('⚠️ Twitter keys missing from .env, Twitter posting disabled.');
}

let bot = null;
if (token && chatId) {
  bot = new TelegramBot(token, { polling: pollingEnabled });
  if (pollingEnabled) {
    bot.on('polling_error', error => {
      console.error(`[Telegram] Polling error: ${error.message}`);
    });
    bot.on('error', error => {
      console.error(`[Telegram] Bot error: ${error.message}`);
    });
    console.log('📱 Telegram bot initialized with polling.');
  } else {
    console.log('📱 Telegram bot initialized for outbound alerts only (sendMessage).');
  }
  // Boot ping OFF by default — restarts (Oracle pm2 / Render) were spamming Telegram.
  // Set REDBAR_BOOT_PING=true to enable (still capped to once per 24h).
  const bootPingOn = String(process.env.REDBAR_BOOT_PING || '').toLowerCase() === 'true';
  if (bootPingOn) {
    const BOOT_PING_FILE = path.join(__dirname, 'telegram_boot_ping.json');
    const QUIET_MS = 24 * 60 * 60 * 1000;
    let allowBootPing = true;
    try {
      if (fs.existsSync(BOOT_PING_FILE)) {
        const prev = JSON.parse(fs.readFileSync(BOOT_PING_FILE, 'utf8'));
        if (prev?.at && Date.now() - Number(prev.at) < QUIET_MS) allowBootPing = false;
      }
    } catch (_) {}
    if (allowBootPing) {
      try { fs.writeFileSync(BOOT_PING_FILE, JSON.stringify({ at: Date.now() })); } catch (_) {}
      bot.sendMessage(
        chatId,
        'TrendRunner Desk bot online — ENTER alerts for leave / retest / sweep / session setups.',
        { disable_notification: true }
      ).then(() => console.log('[Telegram] Boot ping sent'))
        .catch((err) => {
          console.error('[Telegram] Boot ping FAILED — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID:', err.message);
        });
    } else {
      console.log('[Telegram] Boot ping skipped (already sent within 24h)');
    }
  } else {
    console.log('[Telegram] Boot ping disabled (set REDBAR_BOOT_PING=true to enable)');
  }
} else {
  console.log('⚠️ Telegram keys missing (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). PWA alerts still work; Telegram will not.');
}

// --- Portfolio Management ---
const PORTFOLIO_FILE = 'ownedAssets.json';
function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return {};
  return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
}
function savePortfolio(data) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2));
}

// --- Interactive Commands (Telegram Only) ---
if (bot) {
  bot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    bot.sendMessage(chatId, "🤖 Trade Signals Bot is online and scans every 1 hour.\n\nUse /buy BTC to track a coin you own for sell alerts.\nUse /status to see your owned coins.");
  });

  bot.onText(/\/buy (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const symbol = match[1].toUpperCase().replace('USDT', '') + 'USDT';
    const port = loadPortfolio();
    port[symbol] = true;
    savePortfolio(port);
    bot.sendMessage(chatId, `✅ Added ${symbol} to your owned assets. I will now track this for sell signals!`);
  });

  bot.onText(/\/sell (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const symbol = match[1].toUpperCase().replace('USDT', '') + 'USDT';
    const port = loadPortfolio();
    delete port[symbol];
    savePortfolio(port);
    bot.sendMessage(chatId, `🛑 Removed ${symbol} from your owned assets. No more sell alerts for this.`);
  });

  bot.onText(/\/status/, (msg) => {
    if (msg.chat.id.toString() !== chatId) return;
    const port = loadPortfolio();
    const assets = Object.keys(port).join(', ') || 'None';
    const count = CONFIG.assets.crypto.length;
    bot.sendMessage(chatId, `📊 Currently scanning ${count} assets.\n\n💼 Owned assets you are tracking for sells: ${assets}\n\nType /buy BTC to add to tracked assets.`);
  });
}

// --- Market Scanner ---
// Persist dedup state so restarts don't re-fire alerts
const ALERT_STATE_FILE = 'lastAlerted.json';
function loadAlertState() {
  try { return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveAlertState(state) {
  fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state, null, 2));
}
const lastAlerted = loadAlertState();
const _instTrendState = new Map();

// Persist Twitter deduplication and rate limits
const TWITTER_STATE_FILE = 'twitterState.json';
const TW_TWO_HOURS = 2 * 60 * 60 * 1000;
const TW_TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TW_DAY_MS = 24 * 60 * 60 * 1000;
const TW_FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

function loadTwitterState() {
  try {
    const s = JSON.parse(fs.readFileSync(TWITTER_STATE_FILE, 'utf8'));
    return {
      lastGlobalTweet: s.lastGlobalTweet || 0,
      lastDailySummary: s.lastDailySummary || 0,
      lastHeartbeat: s.lastHeartbeat || 0,
      lastPulseLine: s.lastPulseLine || '',
      coins: s.coins && typeof s.coins === 'object' ? s.coins : {},
    };
  } catch {
    return { lastGlobalTweet: 0, lastDailySummary: 0, lastHeartbeat: 0, lastPulseLine: '', coins: {} };
  }
}
function saveTwitterState(state) {
  try {
    fs.writeFileSync(TWITTER_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('🐦 Could not save twitterState.json:', e.message);
  }
}
const twitterState = loadTwitterState();

function refreshTwitterStateFromDisk() {
  const fresh = loadTwitterState();
  twitterState.lastGlobalTweet = Math.max(twitterState.lastGlobalTweet || 0, fresh.lastGlobalTweet || 0);
  twitterState.lastDailySummary = Math.max(twitterState.lastDailySummary || 0, fresh.lastDailySummary || 0);
  twitterState.lastHeartbeat = Math.max(twitterState.lastHeartbeat || 0, fresh.lastHeartbeat || 0);
  if (fresh.lastPulseLine) twitterState.lastPulseLine = fresh.lastPulseLine;
  twitterState.coins = { ...(fresh.coins || {}), ...(twitterState.coins || {}) };
  return twitterState;
}

function twCanPostGlobal(now = Date.now()) {
  refreshTwitterStateFromDisk();
  return now - (twitterState.lastGlobalTweet || 0) > TW_TWO_HOURS;
}

/** X / marketing copy for the current TrendRunner Desk (session structure — not legacy STRONG BUY). */
function buildStrongBuyTweet({ cleanSymbol, score, confidence, price, tpPct, holdDays }) {
  const stamp = new Date().toISOString().slice(11, 16);
  const priceStr = price >= 1 ? price.toFixed(2) : price.toFixed(4);
  const variants = [
    `TrendRunner Desk · $${cleanSymbol}

Session structure scan flagged a high-interest long context
Score +${score} · Confidence ${confidence}% · $${priceStr}

Stops, +${tpPct}% targets & ${holdDays}-day hold map on the desk
Educational research — you place your own trades

trendrunner.app
#${cleanSymbol} #Trading #TrendRunner · ${stamp}`,
    `$${cleanSymbol} on TrendRunner Desk

Clarity over noise: structural stop + 1:1 bank plan mapped for you
+${score} · ${confidence}% · $${priceStr}

Open the desk → trendrunner.app
#${cleanSymbol} #FuturesTrading · ${stamp}`,
  ];
  const idx = Math.abs((Date.now() + (cleanSymbol.charCodeAt(0) || 0)) % variants.length);
  return variants[idx];
}

function buildDailySummaryTweet({ fearGreed, marketRegime, strongBuyCount, watchCount, topWatch }) {
  const fg = fearGreed != null ? String(fearGreed) : 'n/a';
  const stamp = new Date().toISOString().slice(0, 10);
  const scoreStr = (n) => (Number.isFinite(n) ? (n >= 0 ? `+${n}` : String(n)) : '');
  let setupLine;
  if (strongBuyCount > 0 && topWatch) {
    setupLine = `${strongBuyCount} high-interest long context(s) — lead $${topWatch.symbol} (${scoreStr(topWatch.score)}, ${topWatch.confidence}%).`;
  } else if (watchCount > 0 && topWatch) {
    setupLine = `No enter-ready alerts yet. ${watchCount} watch(es) — $${topWatch.symbol} (${scoreStr(topWatch.score)}, ${topWatch.confidence}%).`;
  } else {
    setupLine = 'Quiet scan — desk staying selective until structure confirms.';
  }
  return `TrendRunner Desk pulse · ${stamp}

Regime: ${marketRegime} · Fear & Greed: ${fg}
${setupLine}

Session leave / retest / sweep maps → trendrunner.app
#Trading #TrendRunner`;
}

function tweetCardOptsFromScan(asset, result, d, price) {
  const ss = result?.stopSuggest || {};
  const winnerTier = result?.winnerTier ?? 'none';
  const policy = CONFIG.exits || {};
  const stopAtr = policy.stopAtrMult || 2;
  const trailPct = ss.runnerTrailPct ?? (
    ss.distancePct != null
      ? (policy.runnerTrailAtrMult || 2) * (ss.distancePct / stopAtr)
      : null
  );
  return {
    symbol: String(asset.symbol || '').replace(/USDT$/i, ''),
    name: asset.name || asset.symbol,
    score: result.score,
    confidence: result.confidence,
    price,
    rsi: result.indicators?.rsi?.value,
    tvl: d.tvl,
    tpPct: ss.takeProfitPct || ss.bankTakeProfitPct || policy.takeProfitPct || 10,
    holdDays: ss.holdLimitDays || policy.holdLimitDays || 7,
    stopPrice: ss.stopPrice,
    takeProfitPrice: ss.takeProfitPrice,
    distancePct: ss.distancePct,
    bankPct: ss.bankTakeProfitPct ?? ss.takeProfitPct ?? policy.takeProfitPct ?? 10,
    partialPct: ss.partialPct ?? policy.partialPct ?? 50,
    trailPct,
    change1d: d.change24h ?? null,
    change4h: d.change4h ?? null,
    closes1D: d.closes,
    closes4H: d.closes4H,
    signal: result.signal,
    tierLabel: winnerTier === 'core' ? 'Core Winner' : winnerTier === 'probation' ? 'Probation Winner' : 'Crypto',
  };
}

function buildHeartbeatTweet({ fearGreed, marketRegime }) {
  const fg = fearGreed != null ? String(fearGreed) : 'n/a';
  const stamp = new Date().toISOString().slice(11, 16);
  return `TrendRunner Desk is live — mapping session structure on BTC, NIFTY & more.

Regime: ${marketRegime} · Fear & Greed: ${fg}
Clear stop · 1:1 bank · you place the trade

trendrunner.app
#Trading #TrendRunner · ${stamp}`;
}

/** Optional X post when desk ENTER fires (plain language). */
function buildDeskEnterTweet({ label, side, setupKind, price, stop, tp1, isBinance }) {
  const setup = TrendRunnerCopy.setupName(setupKind);
  const tip = TrendRunnerCopy.setupTip(setupKind);
  const px = isBinance ? '$' : '';
  const stamp = new Date().toISOString().slice(11, 16);
  return `TrendRunner Desk · ${label} ${String(side || '').toUpperCase()}

${setup}
Entry ${px}${price} · Stop ${px}${stop} · 1:1 ${px}${tp1}
${tip ? `${tip}\n` : ''}
Educational — not financial advice. You place your own trades.
trendrunner.app · ${stamp}`;
}

async function postTweet(text, label = 'tweet', { withImage = false, mediaBuffer = null } = {}) {
  if (!twitterClient || !text) return false;
  // X app often 403s on raw https:// links — keep plain domain only.
  let safeText = String(text).replace(/https?:\/\/\S+/gi, '').replace(/[ \t]+\n/g, '\n').trim();
  let mediaId = null;
  try {
    if (mediaBuffer && Buffer.isBuffer(mediaBuffer)) {
      try {
        mediaId = await twitterClient.v1.uploadMedia(mediaBuffer, { mimeType: 'image/png' });
      } catch (mediaErr) {
        console.warn(`🐦 Generated card upload failed (${label}): ${mediaErr?.message || mediaErr}`);
      }
    }
    if (!mediaId && withImage) {
      const fallback = typeof TW_OG_FALLBACK !== 'undefined' ? TW_OG_FALLBACK : require('path').join(__dirname, 'og-preview.png');
      if (fs.existsSync(fallback)) {
        try {
          mediaId = await twitterClient.v1.uploadMedia(fallback);
        } catch (mediaErr) {
          console.warn(`🐦 Media upload skipped (${label}): ${mediaErr?.message || mediaErr}`);
        }
      }
    }
    const payload = mediaId
      ? { text: safeText, media: { media_ids: [mediaId] } }
      : safeText;
    await twitterClient.v2.tweet(payload);
    console.log(`✅ Tweeted ${label}${mediaId ? ' (with image)' : ''}`);
    return true;
  } catch (err) {
    const detail = err?.data?.detail || err?.data?.title || err?.message || String(err);
    const code = err?.code || err?.data?.status || '';
    if (Number(code) === 403 && /trendrunner\.app/i.test(safeText)) {
      const stripped = safeText.replace(/\n?trendrunner\.app\S*/gi, '').replace(/\nFree algorithmic setups →\s*/gi, '\n').trim();
      try {
        const retryPayload = mediaId
          ? { text: stripped, media: { media_ids: [mediaId] } }
          : stripped;
        await twitterClient.v2.tweet(retryPayload);
        console.log(`✅ Tweeted ${label} (fallback without domain)`);
        return true;
      } catch (err2) {
        const d2 = err2?.data?.detail || err2?.message || String(err2);
        console.error(`Twitter post failed (${label}) (${err2?.code || ''}): ${d2}`);
        if (err2?.data) console.error('Twitter error body:', JSON.stringify(err2.data));
        return false;
      }
    }
    console.error(`Twitter post failed (${label}) (${code}): ${detail}`);
    if (err?.data) console.error('Twitter error body:', JSON.stringify(err.data));
    return false;
  }
}


let scanInProgress = false;

// Fetch the Crypto Fear & Greed index (0-100). Returns undefined on failure
// so the engine simply skips the sentiment adjustment.
async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    const json = await res.json();
    const v = Number(json?.data?.[0]?.value);
    return isFinite(v) ? v : undefined;
  } catch { return undefined; }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Email (Resend) — set RESEND_API_KEY + ALERT_EMAIL. No Telegram required. */
async function sendAlertEmail({ subject, html, text }) {
  const apiKey = envTrim('RESEND_API_KEY');
  const to = envTrim('ALERT_EMAIL');
  if (!apiKey || !to) return false;
  const from = envTrim('ALERT_EMAIL_FROM') || 'TrendRunner <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text: text || stripHtml(html),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[AlertEmail] Resend ${res.status}: ${body.slice(0, 300)}`);
      return false;
    }
    console.log(`[AlertEmail] Sent to ${to}: ${subject}`);
    return true;
  } catch (e) {
    console.error('[AlertEmail] Failed:', e.message);
    return false;
  }
}

/**
 * Phone push without Telegram — ntfy.sh (or self-hosted).
 * Set NTFY_TOPIC (e.g. trendrunner-vinod-secret) and optionally NTFY_URL / NTFY_TOKEN.
 */
async function sendNtfy({ title, body, clickUrl }) {
  const topic = envTrim('NTFY_TOPIC');
  if (!topic) return false;
  const base = (envTrim('NTFY_URL') || 'https://ntfy.sh').replace(/\/$/, '');
  const url = `${base}/${encodeURIComponent(topic)}`;
  const headers = {
    Title: title || 'TrendRunner ENTER',
    Priority: 'high',
    Tags: 'chart_with_upwards_trend,rotating_light',
    'Content-Type': 'text/plain; charset=utf-8',
  };
  const token = envTrim('NTFY_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clickUrl) headers.Click = clickUrl;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: body || title });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`[ntfy] ${res.status}: ${t.slice(0, 200)}`);
      return false;
    }
    console.log(`[ntfy] Pushed: ${title}`);
    return true;
  } catch (e) {
    console.error('[ntfy] Failed:', e.message);
    return false;
  }
}

async function deliverRedBarAlert({ subject, htmlMsg, plainMsg, clickUrl }) {
  const hasEmail = Boolean(envTrim('RESEND_API_KEY') && envTrim('ALERT_EMAIL'));
  const hasNtfy = Boolean(envTrim('NTFY_TOPIC'));
  const hasTg = Boolean(bot && chatId);
  if (!hasEmail && !hasNtfy && !hasTg) {
    console.warn(
      '[RedBarBot] ENTER fired but Telegram not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID on Render).'
    );
    return false;
  }
  let anyOk = false;
  if (hasTg) {
    try {
      await bot.sendMessage(chatId, htmlMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
      console.log('[RedBarBot] Telegram sent');
      anyOk = true;
    } catch (err) {
      console.error('[RedBarBot] Telegram send failed:', err.message);
    }
  }
  if (hasEmail) {
    anyOk = (await sendAlertEmail({ subject, html: htmlMsg.replace(/\n/g, '<br>'), text: plainMsg })) || anyOk;
  }
  if (hasNtfy) {
    anyOk = (await sendNtfy({ title: subject, body: plainMsg, clickUrl })) || anyOk;
  }
  return anyOk;
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function _escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function _deskBars(inst, interval, limit) {
  // Desk router: BTC/XAU must be binanceFutures (spot OHLC paints wrong mark Fibs / first-red).
  // Do not call missing helpers like getBinanceKlines — that silently killed BTC ENTER alerts.
  return API.getDeskOHLC(inst, interval, limit);
}

async function _scanOneRedBarInstrument(rawInst, rbCfg) {
  const inst = (typeof API.resolveInstrumentForSession === 'function')
    ? API.resolveInstrumentForSession(rawInst)
    : rawInst;
  const workTf = rbCfg.workingTf || '15m';
  const need5m = workTf !== '5m';
  const isIndianIdx = typeof RedBarTrend.isIndianIndex === 'function'
    ? RedBarTrend.isIndianIndex(inst.id)
    : ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(String(inst.id || '').toUpperCase());
  const firstRedTf = inst.firstRedTf !== undefined
    ? inst.firstRedTf
    : (isIndianIdx ? '5m' : null);
  const firstRedBarMs = firstRedTf === '30m' ? 30 * 60000
    : firstRedTf === '15m' ? 15 * 60000
      : firstRedTf === '5m' ? 5 * 60000
        : 3600000;
  const firstRedMinBars = (firstRedTf === '15m' || firstRedTf === '5m') ? 6 : firstRedTf === '30m' ? 48 : 24;
  const needPivotFetch = !!firstRedTf && workTf !== firstRedTf && !(firstRedTf === '5m' && need5m);
  const rawPair = await _withTimeout(
    Promise.all([
      _deskBars(inst, workTf, 500),
      needPivotFetch ? _deskBars(inst, firstRedTf, firstRedTf === '30m' ? 400 : 220) : Promise.resolve(null),
      need5m ? _deskBars(inst, '5m', 500) : Promise.resolve(null),
    ]),
    25000,
    `${inst.id} OHLC`
  );
  const toBars = (raw) => {
    if (!raw || !raw.length) return [];
    if (raw[0] && typeof raw[0].t === 'number') return raw;
    return raw.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  };
  const barsWork = toBars(rawPair[0]);
  const bars5m = need5m ? toBars(rawPair[2]) : barsWork;
  const bars1h = needPivotFetch ? toBars(rawPair[1]) : (firstRedTf === '5m' ? bars5m : barsWork);
  if (!barsWork || barsWork.length < 40) {
    console.warn(`[RedBarBot] ${inst.id}: not enough bars (${barsWork?.length || 0})`);
    return;
  }
  // Compute and cache trend alignment EMAs for this instrument
  if (Array.isArray(barsWork) && barsWork.length >= 35) {
    const calcEma = (arr, p) => {
      const k = 2 / (p + 1);
      let val = arr[0];
      for (let j = 1; j < arr.length; j++) val = arr[j] * k + val * (1 - k);
      return val;
    };
    const closes = barsWork.map((b) => b.c);
    const ema10 = calcEma(closes, 10);
    const ema30 = calcEma(closes, 30);
    const latestClose = closes[closes.length - 1];
    _instTrendState.set(String(inst.id).toUpperCase(), { price: latestClose, ema10, ema30, updatedAt: Date.now() });
  }
  const lastT = barsWork[barsWork.length - 1].t;
  const nowTs = Date.now();
  const calDay = RedBarTrend.dayKey(lastT, inst.dayMode || rbCfg.dayMode || 'ist');
  let firstRed1h = (firstRedTf && bars1h && bars1h.length >= firstRedMinBars)
    ? RedBarTrend.firstRedBarOfSession(bars1h, calDay, {
      ...rbCfg, ...inst, asOfTs: nowTs, barMs: firstRedBarMs,
    })
    : null;
  if (!firstRed1h && isIndianIdx && firstRedTf !== '15m' && bars5m && bars5m.length >= 6) {
    firstRed1h = RedBarTrend.firstRedBarOfSession(bars5m, calDay, {
      ...rbCfg, ...inst, asOfTs: nowTs, barMs: 5 * 60000,
    });
    if (firstRed1h) firstRed1h = { ...firstRed1h, anchorTf: '5m' };
  } else if (firstRed1h) {
    firstRed1h = { ...firstRed1h, anchorTf: firstRedTf };
  }
  const readout = RedBarTrend.readAt(barsWork, barsWork.length - 1, {
    ...rbCfg,
    ...inst,
    asOfTs: nowTs,
    firstRed1h,
    bars1h,
    bars15m: (workTf === '15m' && barsWork.length) ? barsWork : (firstRedTf === '15m' && bars1h?.length ? bars1h : null),
    bars5m: bars5m && bars5m.length ? bars5m : null,
  });
  if (!readout) return;
  const livePrice = Number(readout.price) || barsWork[barsWork.length - 1].c;
  const curTrend = _instTrendState.get(String(inst.id).toUpperCase()) || {};
  const closed5m = Array.isArray(bars5m)
    ? bars5m.filter((b) => b && Number.isFinite(b.t) && b.t + 5 * 60 * 1000 <= nowTs)
    : [];
  const lastClosed5m = closed5m.length ? closed5m[closed5m.length - 1] : null;
  _instTrendState.set(String(inst.id).toUpperCase(), {
    ...curTrend,
    price: livePrice,
    updatedAt: Date.now(),
    lastClosed5m,
    medians: Array.isArray(readout.advancedFibs?.medians) ? readout.advancedFibs.medians : [],
  });
  const side = readout.trend === 'bullish' ? 'LONG' : readout.trend === 'bearish' ? 'SHORT' : 'WAIT';
  const setupKind = readout.setupKind || 'wait';
  const actionState = readout.actionState || 'wait';
  const dayKey = readout.asOfDay || '';
  // Indian indices (NIFTY, BANKNIFTY, SENSEX) keep a 20m trigger bucket (for Rule 6 SL re-entry).
  // BTC / MCX locks morning clock setups (btc_asia_0530_breakout, pob_reject, trade1_departure)
  // to ONCE per session day, and uses a 60m bucket on Trade 2 / sweep so chop cannot re-fire the same level.
  const triggerTs = Number(readout.triggerTs)
    || Number(readout.playbook?.redSetup?.triggerTs)
    || Number(readout.t)
    || Date.now();
  const isNiftyInst = isIndianIdx;
  const isOneShotMorningSetup = !isNiftyInst && (
    setupKind === 'btc_asia_0530_breakout'
    || setupKind === 'pob_reject'
    || setupKind === 'trade1_departure'
    || setupKind === 'mcx_530_breakout'
    || setupKind === 'mcx_530_retest'
    || setupKind === 'mcx_530_reversal'
  );
  const bucketMs = isNiftyInst ? (20 * 60 * 1000) : (60 * 60 * 1000);
  const trigBucket = isOneShotMorningSetup ? 'session' : Math.floor(triggerTs / bucketMs);
  const alertKey = `${side}|${setupKind}|${dayKey}|${trigBucket}`;
  const alreadyAlerted = _rbAlertSeen(inst.id, alertKey);

  if (setupKind === 'fib_sandwich_wait' && readout.advancedFibs?.sandwich) {
    const s = readout.advancedFibs.sandwich;
    console.log(
      `[RedBarBot] ${inst.id}: FIB SANDWICH no-trade · price=${readout.price} between ${s.lo}–${s.hi} (first-bar mid / red mid)`
    );
  }
  console.log(
    `[RedBarBot] ${inst.id} (${inst.symbol}): state=${actionState.toUpperCase()} (${side}) | setup=${setupKind} | price=${readout.price} | stop=${readout.invalidation} (${readout.invalidationReason || '—'}) | book=${readout.bookZone} | RR=${readout.rr != null ? readout.rr.toFixed(2) : '—'}`
  );

  const actionable = Array.isArray(RedBarTrend.ACTIONABLE_SETUPS)
    && RedBarTrend.ACTIONABLE_SETUPS.includes(setupKind);
  if (actionState === 'enter' && actionable && (side === 'LONG' || side === 'SHORT')) {
    // EMA is chart context only — not Red Bar. Never blocks an ENTER.
    if (!_redBarBotInstrumentAllowed(inst)) {
      console.log(`[RedBarBot] ${inst.id}: ENTER ignored on worker (REDBAR_BOT_INSTRUMENTS) — desk can still show it`);
      return;
    }

    // For NIFTY: run the Option Chart Engine (15m Canvas + 1m Micro-Confirmation + Bid/Ask spread)
    // BEFORE firing Telegram ENTER or Dhan Auto so Telegram, Telemetry, and Execution stay 100% in sync.
    let niftyOptEval = null;
    if (
      String(inst.id || '').toUpperCase() === 'NIFTY'
      && _autoSetupAllowed(setupKind)
      && envTrim('DHAN_ACCESS_TOKEN')
      && envTrim('DHAN_CLIENT_ID')
    ) {
      const optDayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      niftyOptEval = await _evaluateNiftyOptionSetup({
        instKey: 'NIFTY',
        side,
        indexEntry: Number(readout.price),
        dayKey: optDayKey,
        setupKind,
      });
      const allowDeltaFallback = String(process.env.DHAN_ALLOW_DELTA_FALLBACK || 'false').toLowerCase() === 'true';
      const holdForOptionGate = niftyOptEval.status === 'PENDING_1M'
        || niftyOptEval.status === 'WIDE_SPREAD'
        || ((niftyOptEval.status === 'FEED_UNAVAILABLE' || niftyOptEval.status === 'ERROR') && !allowDeltaFallback);
      if (!alreadyAlerted && holdForOptionGate) {
        console.log(
          `[RedBarBot] NIFTY: ${side} ${setupKind} index signal armed — holding Telegram ENTER & Auto (${niftyOptEval.status}: ${niftyOptEval.reason})`
        );
        return;
      }
    }

    let alertOk = alreadyAlerted;
    if (!alreadyAlerted) {
      const dec = inst.priceDecimals ?? 2;
      const fmt = (n) => (n != null && Number.isFinite(n) ? Number(n).toFixed(dec) : '—');
      const sz = readout.sizing || RedBarTrend.futuresSizing({
        entry: readout.price,
        stop: readout.invalidation,
        exit: readout.bookZone,
        capital: 1000,
        riskPct: 1,
      });
      const deskUrl = envTrim('DESK_URL') || 'https://trendrunner.app';
      const isBinance = String(inst.feed || '').startsWith('binance') || String(inst.symbol || '').endsWith('USDT');
      const futLink = isBinance
        ? `https://www.binance.com/en/futures/${inst.symbol}?ref=TRENDRUNNER`
        : null;
      const pxPrefix = isBinance ? '$' : '₹';
      const emoji = side === 'LONG' ? '🟢' : '🔴';
      const setupLabel = TrendRunnerCopy.setupName(setupKind);
      const setupTip = TrendRunnerCopy.setupTip(setupKind);
      const dhanNote = (() => {
        if (isBinance) return '';
        const lot = Number(inst.lotSize) || Number(process.env.NIFTY_LOT_SIZE) || 65;
        const mult = Number(inst.contractMultiplier) || 1;
        const unitCount = lot * mult;
        const lotsCfg = Math.max(1, Number(process.env.DHAN_NIFTY_LOTS) || 2);
        const totalUnits = unitCount * lotsCfg;
        if (niftyOptEval?.directOptionLevels && niftyOptEval?.selectedContract) {
          const lv = niftyOptEval.directOptionLevels;
          const sc = niftyOptEval.selectedContract;
          const rsLossTotal = Math.round(lv.riskPts * totalUnits);
          const rsTgtTotal = Math.round(lv.rewardPts * totalUnits);
          return `\nOption Chart Bracket (${_escHtml(sc.symbolHint)} · 1m ${niftyOptEval.micro?.triggerPattern || 'confirmed'}):`
            + `\nAsk ₹${lv.entryPrice} · SL ₹${lv.stopLossPrice} (-${lv.riskPts} pts) · 1:1 Bank ₹${lv.tp1Banker} · 15m Target ₹${lv.tpTarget} (RR ${lv.rrRatio})`
            + `\nDHAN (${lotsCfg} lots · ${totalUnits} units): Risk ~Rs ${rsLossTotal} · Target ~Rs ${rsTgtTotal}`;
        }
        const e = Number(readout.price), s = Number(readout.invalidation), t = Number(readout.tp1);
        if (!(e > 0 && s > 0 && t > 0)) return '';
        const delta = Number(process.env.NIFTY_OPT_DELTA) || 0.55;
        if (['CRUDEOIL', 'NG'].includes(String(inst.id).toUpperCase())) {
          // MCX option SL/TP come from the live contract delta + minSlPts + tpMult at order time.
          // Do not print a guessed premium SL/TP here (it contradicted the real order) — exact levels are in the order confirmation.
          return `\nIndex stop ${fmt(s)} · 1:1 ${fmt(t)} (index levels)\nDHAN (1 lot · ${unitCount} units): exact option SL/TP shown in the order confirmation below`;
        }
        const riskPts = Math.abs(e - s), tgtPts = Math.abs(t - e);
        const optSl = (riskPts * delta).toFixed(1), optTp = (tgtPts * delta).toFixed(1);
        const rsSl = Math.round(riskPts * delta * unitCount), rsTp = Math.round(tgtPts * delta * unitCount);
        return `\nDHAN (1 lot · ${unitCount} units, Δ=${delta}): option SL = buy price − ${optSl} pts · TP = buy price + ${optTp} pts\nSuggested P&amp;L Exit: Max Loss ~Rs ${rsSl} · Max Profit ~Rs ${rsTp}\nExit manually if ${inst.label || inst.id} closes 5m beyond ${fmt(s)}`;
      })();
      const dhanAutoOn = String(process.env.DHAN_AUTO_TRADE || '').toLowerCase() === 'true'
        && _canAutoTradeDhanNifty(inst);
      const alertOnlyNote = !isBinance
        ? (dhanAutoOn
          ? dhanNote + '\n🤖 Dhan AUTO on — placing option Super Order (entry+SL+TP)'
          : dhanNote + '\n⚠️ Alert only — place manually on Dhan')
        : '';
      const subject = `${side}: ${inst.label} · ${setupLabel}`;
      const medianAlert = setupKind === 'fib_bounce';
      const exitModelCfg = String(process.env.DHAN_EXIT_MODEL || 'B').toUpperCase();
      const useModelBPlan = !isBinance && (exitModelCfg === 'B' || Boolean(niftyOptEval?.directOptionLevels));
      const planLine = medianAlert
        ? (useModelBPlan
          ? 'Plan (Model B): stop is Option/Signal wick. Bank 50% @ 1:1 → move runner SL to cost +0.50 → exit runner at Option target / next median or 5m close-back.'
          : (Number(readout.tp1) > 0
            ? 'Plan (Model A): stop is the signal wick. Target is the next median. Full trade exits there (no 1:1 bank).'
            : 'Plan (Model A): stop is the signal wick. No median left in front. Hold until price closes back through the entry median, or the session ends.'))
        : 'Plan: bank ~50% at 1:1 → move stop to cost · trail the rest';
      const targetLabel = medianAlert
        ? (Number(readout.tp1) > 0 ? `next median <b>${pxPrefix}${fmt(readout.tp1)}</b>` : 'no median left — hold')
        : `1:1 bank <b>${pxPrefix}${fmt(readout.tp1)}</b>`;
      const btcConfLine = (!isIndianIdx && readout.btcConfluence?.summaryText)
        ? `\n🎯 Confluence: <b>${_escHtml(readout.btcConfluence.summaryText)}</b>`
        : '';
      const htmlMsg = `${emoji} <b>${_escHtml(TrendRunnerCopy.enterHeadline(inst.label, side))}</b>
<b>${_escHtml(setupLabel)}</b>
${setupTip ? `${_escHtml(setupTip)}\n` : ''}Entry <b>${pxPrefix}${fmt(readout.price)}</b> · Stop <b>${pxPrefix}${fmt(readout.invalidation)}</b> (${_escHtml(readout.invalidationReason || 'structure')}) · ${targetLabel}${isBinance && sz ? ` · ${sz.recLeverage}×` : ''}
${_escHtml(planLine)}${btcConfLine}${alertOnlyNote}
<a href="${deskUrl}">Open TrendRunner Desk</a>${futLink ? ` · <a href="${futLink}">Futures</a>` : ''}`;
      const plainMsg = [
        TrendRunnerCopy.enterHeadline(inst.label, side),
        setupLabel,
        setupTip || null,
        `Entry ${pxPrefix}${fmt(readout.price)} · Stop ${pxPrefix}${fmt(readout.invalidation)} · ${medianAlert ? (Number(readout.tp1) > 0 ? `next median ${pxPrefix}${fmt(readout.tp1)}` : 'no median left — hold') : `1:1 ${pxPrefix}${fmt(readout.tp1)}`}`,
        planLine,
        !isBinance ? (dhanAutoOn ? 'Dhan AUTO placing option order' : 'Alert only — place manually on Dhan') : null,
        deskUrl,
      ].filter(Boolean).join('\n');

      const delivered = await deliverRedBarAlert({
        subject,
        htmlMsg,
        plainMsg,
        clickUrl: deskUrl,
      });
      if (delivered) {
        _rbAlertMark(inst.id, alertKey);
        alertOk = true;
      } else {
        console.error(`[RedBarBot] ${inst.id}: ENTER seen but Telegram delivery failed — will retry next scan`);
      }
    } else {
      console.log(`[RedBarBot] ${inst.id}: already alerted for ${alertKey} — skip`);
    }

    // Place AUTO even if Telegram already fired for this alertKey — otherwise a failed
    // Dhan/Binance attempt (e.g. insufficient funds) cannot retry while setup stays ENTER.
    if (!_autoSetupAllowed(setupKind)) {
      if (alertOk) {
        console.log(`[RedBarBot] ${inst.id}: ENTER alerted but AUTO skipped — setup ${setupKind} not in REDBAR_AUTO_SETUPS`);
      }
    } else {
      await _maybeAutoFuturesTwoLeg({
        inst,
        side,
        readout,
        alertKey,
        dayKey,
      });
      await _maybeAutoDhanNifty({
        inst,
        side,
        readout,
        alertKey,
        dayKey,
        setupKind,
        bars5m,
        barsWork,
        precomputedOptEval: niftyOptEval,
      });
    }
  }
  // Do NOT clear RB keys when leaving ENTER — that re-armed spam on flicker.
}

/** DNA / researched setups eligible for auto (Binance + Dhan). Trade 3 = setup3_rubber_band. Dr. Dev Trikal 12:45 = afternoon_1245_reversal / afternoon_1245_breakout. */
function _autoSetupAllowed(setupKind) {
  const raw = envTrim('REDBAR_AUTO_SETUPS')
    || 'trade1_departure,trade2_confirmed,fib_bounce,session_sweep,pob_reject,setup3_rubber_band,afternoon_1245_reversal,afternoon_1245_breakout,afternoon_1245_retest,btc_asia_0530_breakout,mcx_530_breakout,mcx_530_retest,mcx_530_reversal';
  const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return allow.includes(String(setupKind || ''));
}

function _rbAlertMap(instId) {
  const k = `RB_KEYS_${instId}`;
  if (!lastAlerted[k] || typeof lastAlerted[k] !== 'object') lastAlerted[k] = {};
  return lastAlerted[k];
}

function _rbAlertSeen(instId, alertKey) {
  const map = _rbAlertMap(instId);
  const now = Date.now();
  for (const [key, ts] of Object.entries(map)) {
    if (now - Number(ts) > 36 * 3600 * 1000) delete map[key];
  }
  return Boolean(map[alertKey]);
}

function _rbAlertMark(instId, alertKey) {
  const map = _rbAlertMap(instId);
  map[alertKey] = Date.now();
  lastAlerted[`RB_${instId}_LAST`] = alertKey;
  saveAlertState(lastAlerted);
}

const MANAGED_TRADES_FILE = 'managed_futures_trades.json';
function loadManagedTrades() {
  try {
    const rows = JSON.parse(fs.readFileSync(MANAGED_TRADES_FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function saveManagedTrades(rows) {
  try {
    fs.writeFileSync(MANAGED_TRADES_FILE, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.warn('[RedBarBot] Could not save managed trades:', e.message);
  }
}

/** Live Telegram ENTER allow-list. Default NIFTY only (BTC paused until re-enabled). */
function _redBarBotInstrumentAllowed(inst) {
  const raw = envTrim('REDBAR_BOT_INSTRUMENTS') || 'NIFTY';
  const allow = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const id = String(inst?.id || '').toUpperCase();
  const sym = String(inst?.symbol || '').toUpperCase();
  return allow.includes(id) || allow.includes(sym);
}

/** BTCUSDT on Binance USD-M. Optional REDBAR_BINANCE_AUTO_SYMBOLS filter. */
function _canAutoTradeBinanceFutures(inst) {
  if (!_redBarBotInstrumentAllowed(inst)) return false;
  const sym = String(inst?.symbol || '').toUpperCase();
  const id = String(inst?.id || '').toUpperCase();
  const autoRaw = envTrim('REDBAR_BINANCE_AUTO_SYMBOLS');
  if (autoRaw) {
    const autoAllow = autoRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!autoAllow.includes(sym) && !autoAllow.includes(id)) return false;
  }
  return sym === 'BTCUSDT';
}

function _canAutoTradeDhanNifty(inst) {
  if (!_redBarBotInstrumentAllowed(inst)) return false;
  const id = String(inst?.id || '').toUpperCase();
  const dhanRaw = envTrim('DHAN_AUTO_INSTRUMENTS') || 'NIFTY';
  const dhanAllow = dhanRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return dhanAllow.includes(id);
}

const MANAGED_DHAN_FILE = 'managed_dhan_trades.json';
function loadManagedDhanTrades() {
  try {
    const rows = JSON.parse(fs.readFileSync(MANAGED_DHAN_FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function saveManagedDhanTrades(rows) {
  try {
    fs.writeFileSync(MANAGED_DHAN_FILE, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.warn('[RedBarBot] Could not save managed Dhan trades:', e.message);
  }
}

/** IST minutes since midnight. */
function _istMinsNow() {
  const z = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return z.getHours() * 60 + z.getMinutes();
}

function _logNiftyOptionTelemetry(row) {
  try {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, 'option_engine_telemetry.jsonl');
    if (fs.existsSync(fp) && fs.statSync(fp).size > 2 * 1024 * 1024) {
      const bak = path.join(dir, 'option_engine_telemetry.prev.jsonl');
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
      fs.renameSync(fp, bak);
    }
    const istIso = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('Z', '+05:30');
    fs.appendFileSync(fp, JSON.stringify({ tsIst: istIso, ...row }) + '\n');
  } catch (_) {}
}

/**
 * Shared NIFTY 15m Option Canvas + Closed-1m Micro-Confirmation ("Trader's Eye") Evaluator.
 * Used identically before Telegram ENTER alert and before Dhan SuperOrder placement.
 */
async function _evaluateNiftyOptionSetup({ trader, instKey, side, indexEntry, dayKey, setupKind }) {
  const t0 = Date.now();
  const {
    computeOptionCanvas,
    check1mMicroConfirmation,
    calculateOptionLevels,
  } = require('./js/nifty_option_engine.js');
  let activeTrader = trader;
  if (!activeTrader) {
    const { createDhanNiftyTrade } = require('./js/dhan_nifty_trade.js');
    activeTrader = createDhanNiftyTrade({ instrumentId: instKey });
  }
  try {
    const optDayKey = dayKey || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const selectedContract = await activeTrader.pickOptionContract({ side, spot: indexEntry });
    const rawAsk = selectedContract.rawAsk != null ? Number(selectedContract.rawAsk) : (Number(selectedContract.ask) || 0);
    const rawBid = selectedContract.rawBid != null ? Number(selectedContract.rawBid) : (Number(selectedContract.bid) || 0);
    const hasLiveBook = rawAsk > 0 && rawBid > 0;
    const spread = hasLiveBook ? Number((rawAsk - rawBid).toFixed(2)) : null;
    if ((rawAsk > 0 && rawBid <= 0) || (hasLiveBook && spread > 2.5)) {
      const reason = rawBid <= 0
        ? `missing live bid quote (bid=0, ask=${rawAsk.toFixed(2)})`
        : `wide bid-ask spread (${spread.toFixed(2)} pts > 2.5)`;
      _logNiftyOptionTelemetry({
        instKey, side, setupKind, dayKey: optDayKey, status: 'WIDE_SPREAD',
        symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
        reason, latencyMs: Date.now() - t0,
      });
      return { status: 'WIDE_SPREAD', selectedContract, directOptionLevels: null, spread, reason };
    }

    let bars1m = [];
    try {
      bars1m = await activeTrader.fetchOptionIntradayBars(selectedContract.securityId, '1', 3);
    } catch (e) {
      _logNiftyOptionTelemetry({
        instKey, side, setupKind, dayKey: optDayKey, status: 'FEED_UNAVAILABLE',
        symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
        reason: e.message, latencyMs: Date.now() - t0,
      });
      return { status: 'FEED_UNAVAILABLE', selectedContract, directOptionLevels: null, spread, reason: e.message };
    }

    const nowMs = Date.now();
    const hasForming = Array.isArray(bars1m)
      && bars1m.length >= 3
      && bars1m[bars1m.length - 1].t <= nowMs
      && (nowMs - bars1m[bars1m.length - 1].t) < 60_000;
    const closedBars1m = hasForming ? bars1m.slice(0, -1) : (Array.isArray(bars1m) ? bars1m : []);

    // Filter 1m micro check to today's calendar IST session once >=2 today bars exist so prior close cannot masquerade as 09:16 open
    const todayClosed1m = optDayKey
      ? closedBars1m.filter((b) => new Date(b.t + 5.5 * 3600 * 1000).toISOString().slice(0, 10) === optDayKey)
      : closedBars1m;
    const microInput = todayClosed1m.length >= 2 ? todayClosed1m : closedBars1m;

    if (!Array.isArray(microInput) || microInput.length < 2) {
      const reason = `insufficient closed 1m option bars (${microInput.length})`;
      _logNiftyOptionTelemetry({
        instKey, side, setupKind, dayKey: optDayKey, status: 'FEED_UNAVAILABLE',
        symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
        bars1mCount: bars1m.length, droppedFormingBar: hasForming, reason, latencyMs: Date.now() - t0,
      });
      return { status: 'FEED_UNAVAILABLE', selectedContract, directOptionLevels: null, spread, reason };
    }

    const micro = check1mMicroConfirmation(microInput);
    const canvas = computeOptionCanvas(closedBars1m, optDayKey);
    if (!micro.confirmed) {
      _logNiftyOptionTelemetry({
        instKey, side, setupKind, dayKey: optDayKey, status: 'PENDING_1M',
        symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
        bars1mCount: microInput.length, droppedFormingBar: hasForming,
        openBarHigh: canvas?.openBarHigh ?? null, openBarLow: canvas?.openBarLow ?? null,
        curWickRatio: micro.curWickRatio, lastClose: micro.lastClose,
        reason: micro.reason, latencyMs: Date.now() - t0,
      });
      return {
        status: 'PENDING_1M',
        selectedContract,
        directOptionLevels: null,
        micro,
        canvas,
        spread,
        reason: micro.reason,
      };
    }

    if (!canvas) {
      const reason = `missing option 15m canvas bars for ${optDayKey}`;
      _logNiftyOptionTelemetry({
        instKey, side, setupKind, dayKey: optDayKey, status: 'FEED_UNAVAILABLE',
        symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
        bars1mCount: microInput.length, droppedFormingBar: hasForming,
        reason, latencyMs: Date.now() - t0,
      });
      return { status: 'FEED_UNAVAILABLE', selectedContract, directOptionLevels: null, spread, reason };
    }

    const livePremium = rawAsk > 0 ? rawAsk : (Number(selectedContract.ask) > 0 ? Number(selectedContract.ask) : Number(selectedContract.ltp));
    const directOptionLevels = calculateOptionLevels({
      currentPremium: livePremium,
      optionCanvas: canvas,
      microAnalysis: micro,
      bufferPts: 2.0,
    });
    _logNiftyOptionTelemetry({
      instKey, side, setupKind, dayKey: optDayKey, status: 'CONFIRMED',
      symbol: selectedContract.symbolHint, bid: rawBid, ask: rawAsk, spread,
      bars1mCount: microInput.length, droppedFormingBar: hasForming,
      openBarHigh: canvas.openBarHigh, openBarLow: canvas.openBarLow,
      microPattern: micro.triggerPattern, curWickRatio: micro.curWickRatio, signalLow: micro.signalLow,
      entryPrice: directOptionLevels.entryPrice, stopLossPrice: directOptionLevels.stopLossPrice,
      tp1Banker: directOptionLevels.tp1Banker, tpTarget: directOptionLevels.tpTarget,
      rrRatio: directOptionLevels.rrRatio, latencyMs: Date.now() - t0,
    });
    return {
      status: 'CONFIRMED',
      selectedContract,
      directOptionLevels,
      micro,
      canvas,
      spread,
      reason: micro.reason,
    };
  } catch (err) {
    _logNiftyOptionTelemetry({
      instKey, side, setupKind, dayKey, status: 'ERROR',
      reason: err.message, latencyMs: Date.now() - t0,
    });
    return { status: 'ERROR', selectedContract: null, directOptionLevels: null, reason: err.message };
  }
}

async function _maybeAutoDhanNifty({ inst, side, readout, alertKey, dayKey, setupKind, bars5m, barsWork, precomputedOptEval = null }) {
  if (String(process.env.DHAN_AUTO_TRADE || '').toLowerCase() !== 'true') return;
  if (String(process.env.TRADE_ENABLED || '').toLowerCase() !== 'true') return;
  if (!_canAutoTradeDhanNifty(inst)) return;
  if (!envTrim('DHAN_CLIENT_ID') || !envTrim('DHAN_ACCESS_TOKEN')) {
    console.warn('[RedBarBot] DHAN_AUTO_TRADE on but DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN missing');
    return;
  }
  const instKey = String(inst.id || 'NIFTY').toUpperCase();
  // No clock-based entry kills (14:15 / 13:45 were desk inventions). Setup quality decides.
  // Operational only: EOD flatten ~15:10 (NSE/BSE) or ~23:15 (MCX) still closes open option risk before session end.
  // Optional override: DHAN_ENTRY_CUTOFF_MINS (IST mins) if you ever want a hard cutoff again.
  const mins = _istMinsNow();
  const isMcxInst = ['CRUDEOIL', 'NG'].includes(instKey);
  const mcxEntryCutoff = Number(process.env.DHAN_MCX_ENTRY_CUTOFF_MINS) || (21 * 60 + 30); // 21:30 IST hard stop
  if (isMcxInst && mins >= mcxEntryCutoff) {
    console.log(`[RedBarBot] ${instKey}: past 21:30 IST (${Math.floor(mcxEntryCutoff / 60)}:${String(mcxEntryCutoff % 60).padStart(2, '0')}) — MCX late-session cutoff`);
    return;
  }
  const entryCutoffRaw = process.env.DHAN_ENTRY_CUTOFF_MINS;
  const entryCutoff = entryCutoffRaw === '' || entryCutoffRaw == null ? 0 : Number(entryCutoffRaw);
  if (entryCutoff > 0 && mins >= entryCutoff) {
    console.log(`[RedBarBot] ${instKey}: past ${Math.floor(entryCutoff / 60)}:${String(entryCutoff % 60).padStart(2, '0')} IST — DHAN_ENTRY_CUTOFF_MINS hard stop`);
    return;
  }
  if (lastAlerted[`DHAN_TRADE_${instKey}_DETAIL`] === alertKey) {
    console.log(`[RedBarBot] ${instKey}: Dhan already opened for ${alertKey}`);
    return;
  }
  const rawDhanCap = process.env.DHAN_AUTO_MAX_PER_DAY;
  const dhanCapDisabled = rawDhanCap === '0' || rawDhanCap === 'none' || rawDhanCap === 'unlimited' || rawDhanCap === 'false';
  const maxPerDay = dhanCapDisabled ? 0 : (Number(rawDhanCap) || Number(process.env.REDBAR_AUTO_MAX_PER_DAY) || 0);
  // Min floor 60s so a failed place (funds) can retry next scans; set DHAN_AUTO_COOLDOWN_MS for longer.
  const cooldownMs = Math.max(60 * 1000, Number(process.env.DHAN_AUTO_COOLDOWN_MS) || Number(process.env.REDBAR_AUTO_COOLDOWN_MS) || 75 * 60 * 1000);
  const countKey = `DHAN_TRADE_COUNT_${instKey}_${dayKey || 'noday'}`;
  const dayCount = Number(lastAlerted[countKey]) || 0;
  if (!dhanCapDisabled && maxPerDay > 0 && dayCount >= maxPerDay) {
    console.log(`[RedBarBot] ${instKey}: Dhan day cap ${dayCount}/${maxPerDay} — skip ${alertKey}`);
    return;
  }
  const softFailTs = Number(lastAlerted[`DHAN_SOFT_FAIL_${instKey}_TS`]) || 0;
  if (softFailTs > 0 && (Date.now() - softFailTs) < 3 * 60 * 1000) {
    return;
  }
  const lastTs = Number(lastAlerted[`DHAN_TRADE_${instKey}_LAST_TS`]) || 0;
  const flipBar = Number(lastAlerted[`DHAN_MEDIAN_FLIP_${instKey}_BAR`]) || 0;
  const triggerForFlip = Number(readout.triggerTs) || 0;
  const medianFlipReentry = setupKind === 'fib_bounce'
    && flipBar > 0
    && triggerForFlip > 0
    && Math.abs(triggerForFlip - flipBar) < 6 * 60 * 1000;
  const allManagedDhan = loadManagedDhanTrades();
  const activeTrade = allManagedDhan.find(
    (t) => String(t.instrumentId || 'NIFTY').toUpperCase() === instKey && t.status === 'open'
  );
  if (activeTrade) {
    console.log(`[RedBarBot] ${instKey}: trade already open (${activeTrade.symbolHint || activeTrade.orderId}) — refuse concurrent order`);
    return;
  }

  // Sagar / Dr. Dev Rules for NIFTY:
  if (instKey === 'NIFTY') {
    const adv = readout.advancedFibs;
    // 1. First Red Bar Prerequisite: Never trade before the 15m first red bar has formed and closed
    if (adv && (!adv.firstRed || !adv.firstRed.t)) {
      console.log(`[RedBarBot] ${instKey}: First Red Bar has not yet closed — standing aside until 15m red anchor forms`);
      return;
    }
    // 2. Sandwich Stand-Aside Rule: Stand aside if price is strictly between Day Open median & Red Bar median (unless span >= 120 pts)
    if (adv?.sandwich && Number.isFinite(adv.sandwich.lo) && Number.isFinite(adv.sandwich.hi)) {
      const swSpan = adv.sandwich.hi - adv.sandwich.lo;
      const isWide = swSpan >= (adv.wideHighwayPts || 120);
      const curP = Number(readout.price);
      if (!isWide && curP > adv.sandwich.lo && curP < adv.sandwich.hi) {
        console.log(`[RedBarBot] ${instKey}: price ${curP} is strictly inside Sandwich [${adv.sandwich.lo.toFixed(1)} - ${adv.sandwich.hi.toFixed(1)}] (span ${swSpan.toFixed(0)} < 120 pts) — stand aside per Sagar rule`);
        return;
      }
    }
  }
  const todayManagedDhan = allManagedDhan.filter(
    (t) => String(t.instrumentId || 'NIFTY').toUpperCase() === instKey
      && String(t.alertKey || '').includes(`|${dayKey}|`),
  );

  // User MCX Risk Gate (Independent loss limit per instrument):
  // Configurable via DHAN_MCX_MAX_LOSSES (defaults to 2 losses per MCX instrument).
  // If an instrument hits max losses for the day, pause THIS instrument for today.
  // If it won (1:1 banked or target), it can continue taking setups.
  if (isMcxInst) {
    const mcxMaxLosses = Number(process.env.DHAN_MCX_MAX_LOSSES || 2);
    const instLossesToday = todayManagedDhan.filter((t) => t.status === 'closed_sl' && !t.legABooked);
    if (instLossesToday.length >= mcxMaxLosses) {
      console.log(`[RedBarBot] ${instKey}: MCX max losses reached (${instLossesToday.length}/${mcxMaxLosses}) — prior ${instKey} trades ended in SL loss. Standing down ${instKey} for today.`);
      return;
    }
  }

  // Dr. Dev Day 1 Rulebook ("दो लॉस लगातार") + Morning vs 12:45 Afternoon Trikal separation:
  // Morning (pre-12:45) and Afternoon (12:45+ Trikal) are distinct Dr. Dev sessions.
  // If the current session (AM or PM) hits 2 consecutive SL losses, stand down for that session
  // (so 2 morning SL hits pauses the rest of the morning and waits cleanly for the 12:45 Afternoon Trikal).
  const isAfternoonSession = mins >= (12 * 60 + 45) || String(setupKind || '').startsWith('afternoon_1245') || String(setupKind || '').startsWith('mcx_530');
  const sessBucket = isAfternoonSession ? 'PM' : 'AM';
  const consecLossKey = instKey === 'NIFTY'
    ? `DHAN_CONSEC_LOSSES_${sessBucket}_${dayKey || 'noday'}`
    : `DHAN_CONSEC_LOSSES_${instKey}_${sessBucket}_${dayKey || 'noday'}`;
  const closedSessChron = [...todayManagedDhan]
    .filter((t) => {
      if (!t.status || t.status === 'open') return false;
      const isPmTrade = String(t.setupKind || '').startsWith('afternoon_1245') || String(t.setupKind || '').startsWith('mcx_530');
      return isAfternoonSession ? isPmTrade : !isPmTrade;
    })
    .sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0));
  let consecLosses = Number(lastAlerted[consecLossKey]) || 0;
  if (closedSessChron.length >= 2) {
    const lastTwo = closedSessChron.slice(-2);
    if (lastTwo.every((t) => t.status === 'closed_sl' && !t.legABooked)) {
      consecLosses = Math.max(consecLosses, 2);
    }
  }
  // Also account for today's morning session where 3 morning SLs occurred before closed-history persistence was added
  if (!isAfternoonSession && dayCount >= 3 && closedSessChron.some((t) => t.status === 'closed_sl' && t.rule6Reentry)) {
    consecLosses = Math.max(consecLosses, 2);
  }
  if (consecLosses >= 2) {
    console.log(
      `[RedBarBot] ${instKey}: 2 consecutive ${sessBucket} SL losses (Dr. Dev rule) — ${isAfternoonSession ? 'stopping for the day' : 'morning done, waiting for 12:45 Afternoon Trikal'} (${alertKey})`,
    );
    return;
  }

  // Once Trade 1 (trade1_departure) has already been taken today, do not re-fire trade1_departure
  // in later 20m buckets — 2nd and 3rd morning trades must be Trade 2 (shelf retest / sweep) or Session Sweep,
  // unless Trade 1 stopped out and qualifies for the single Rule 6 re-entry below.
  const priorT1Today = todayManagedDhan.filter((t) => t.setupKind === 'trade1_departure');
  const t1WonKey = instKey === 'NIFTY' ? `DHAN_T1_WON_${dayKey}` : `DHAN_T1_WON_${instKey}_${dayKey}`;
  const t1AlreadyWonToday = Boolean(lastAlerted[t1WonKey])
    || priorT1Today.some((t) => t.legABooked || t.status === 'closed_target' || t.status === 'closed_be');

  // Fix Your Trading Day4 Rule 6: after SL hunt, if ENTER still fires (trend intact)
  // and price revisits the same entry zone — waive cooldown once per day (never chain Rule 6 on Rule 6).
  const rule6CountKey = instKey === 'NIFTY'
    ? `DHAN_RULE6_COUNT_${dayKey || 'noday'}`
    : `DHAN_RULE6_COUNT_${instKey}_${dayKey || 'noday'}`;
  const rule6UsedToday = (Number(lastAlerted[rule6CountKey]) || 0) >= 1
    || todayManagedDhan.some((t) => t.rule6Reentry);
  let rule6SlRow = null;
  if (!rule6UsedToday) {
    const reentryWindowMs = Number(process.env.DHAN_SL_REENTRY_WINDOW_MS) || (90 * 60 * 1000);
    const sameLevelPts = Number(process.env.DHAN_SL_REENTRY_LEVEL_PTS)
      || Math.max(0.5, +(Number(readout.price || 25000) * 0.0006).toFixed(2));
    const recentSl = todayManagedDhan
      .filter((t) => t.status === 'closed_sl'
        && t.side === side
        && !t.rule6Reentered
        && !t.rule6Reentry)
      .sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0))[0];
    const priorEntry = Number(recentSl?.indexEntry);
    const nowEntry = Number(readout.price);
    const freshSl = recentSl && (Date.now() - Number(recentSl.closedAt || 0)) <= reentryWindowMs;
    const levelOk = priorEntry > 0 && nowEntry > 0 && Math.abs(nowEntry - priorEntry) <= sameLevelPts;
    if (freshSl && levelOk) {
      rule6SlRow = recentSl;
    }
  }

  if (setupKind === 'trade1_departure' && (t1AlreadyWonToday || ((priorT1Today.length > 0 || dayCount >= 1) && !rule6SlRow))) {
    console.log(
      `[RedBarBot] ${instKey}: Trade 1 departure already completed today — waiting for Trade 2 (shelf retest) or Sweep for 2nd/3rd trade`,
    );
    return;
  }

  // Cooldown check:
  // - If last trade won (1:1 banked / target) and a NEW setup triggers, require only 5m breathing room.
  // - For median bounces (fib_bounce): opposite bounce (e.g. Short after Long) requires only 3m breathing room after prior closes.
  // - Otherwise enforce full cooldownMs unless waived once today by Rule 6.
  const lastClosed = [...todayManagedDhan]
    .filter((t) => t.status && t.status !== 'open')
    .sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0))[0];
  const lastWonAndNewSetup = Boolean(
    lastClosed
    && (lastClosed.legABooked || lastClosed.status === 'closed_target' || lastClosed.status === 'closed_be')
    && (lastClosed.setupKind !== setupKind || (setupKind === 'fib_bounce' && lastClosed.side !== side)),
  );
  const isMedianOpposite = setupKind === 'fib_bounce' && lastClosed && lastClosed.side !== side;
  const isDifferentMedian = setupKind === 'fib_bounce' && lastClosed && lastClosed.entryMedian
    && readout.fibBounce?.median && Math.abs(readout.fibBounce.median - lastClosed.entryMedian) >= 15;
  const effectiveCooldownMs = (isMedianOpposite || isDifferentMedian)
    ? (3 * 60 * 1000)
    : (lastWonAndNewSetup ? (5 * 60 * 1000) : cooldownMs);

  const cooldownLabel = (isMedianOpposite || isDifferentMedian)
    ? '3m structural median switch'
    : (lastWonAndNewSetup ? '5m won-setup rotation' : `${Math.round(cooldownMs / 60000)}m DHAN_AUTO_COOLDOWN_MS`);

  if (lastTs && Date.now() - lastTs < effectiveCooldownMs && !medianFlipReentry) {
    if (rule6SlRow) {
      console.log(
        `[RedBarBot] ${instKey}: Rule 6 SL-reentry (1/1 today) — waive ${cooldownLabel} cooldown (prior ${rule6SlRow.indexEntry} → now ${readout.price})`,
      );
    } else {
      const left = Math.ceil((effectiveCooldownMs - (Date.now() - lastTs)) / 60000);
      console.log(`[RedBarBot] ${instKey}: Dhan cooldown ${left}m (${cooldownLabel}) — skip ${alertKey}`);
      return;
    }
  }

  const indexEntry = Number(readout.price);
  const indexStop = Number(readout.invalidation);
  const realMedianTp = Number(readout.tp1);
  const medianTrade = setupKind === 'fib_bounce';
  const indexRisk = Math.abs(indexEntry - indexStop);
  // Median trades: the option target stays a stretch. A wick through the median must not fill it.
  // The closed 5m candle decides: tag and close back = out, close through = next median, color flip = reverse.
  let indexTp1 = realMedianTp;
  if (medianTrade && !(indexTp1 > 0)) {
    indexTp1 = side === 'LONG'
      ? indexEntry + Math.max(indexRisk * 3, 30)
      : indexEntry - Math.max(indexRisk * 3, 30);
  }
  if (!(indexEntry > 0 && indexStop > 0 && indexTp1 > 0)) {
    console.warn('[RedBarBot] Dhan AUTO skip — incomplete index levels');
    return;
  }

  // Trigger freshness: never enter an option trade mid-air if the trigger bar is older than 20 minutes
  const triggerTs = Number(readout.triggerTs) || Number(readout.playbook?.redSetup?.triggerTs) || 0;
  if (triggerTs > 0 && (Date.now() - triggerTs) > 20 * 60 * 1000) {
    console.log(`[RedBarBot] ${instKey}: triggerTs is ${Math.round((Date.now() - triggerTs) / 60000)}m old (>20m) — stale trigger, skip Dhan entry`);
    return;
  }

  // Desk note only — not a Dr Dev hard rule. SL stays structural; we do not abort on index-pt width.
  const riskPts = Math.abs(indexEntry - indexStop);
  if (riskPts > 38) {
    console.log(`[RedBarBot] ${instKey}: structural risk ${riskPts.toFixed(1)} pts (wide) — taking trade; size option premium carefully.`);
  }

  // Dhan follows the same ENTER as desk + Telegram. Trade 2 confirmation (5m close back through)
  // is already required by the engine — no extra Dhan-only candle checks.

  try {
    const { createDhanNiftyTrade } = require('./js/dhan_nifty_trade.js');
    const trader = createDhanNiftyTrade({ instrumentId: instKey });
    if (await trader.hasOpenNiftyOptionPosition()) {
      console.log(`[RedBarBot] ${instKey}: open F&O/MCX option position already — skip new Dhan entry`);
      return;
    }

    let directOptionLevels = null;
    let selectedContract = null;

    // Dr. Dev / Sagar NIFTY Multi-Timeframe Option Engine:
    // Reuse same-tick evaluation from _scanOneRedBarInstrument when available, otherwise run _evaluateNiftyOptionSetup.
    if (instKey === 'NIFTY') {
      const optDayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const optEval = precomputedOptEval || await _evaluateNiftyOptionSetup({
        trader,
        instKey,
        side,
        indexEntry,
        dayKey: optDayKey,
        setupKind,
      });
      selectedContract = optEval.selectedContract || null;
      if (optEval.status === 'WIDE_SPREAD') {
        console.log(`[RedBarBot] NIFTY: ${optEval.reason} on ${selectedContract?.symbolHint || 'contract'} — waiting for tighter book`);
        return;
      }
      if (optEval.status === 'PENDING_1M') {
        console.log(
          `[RedBarBot] NIFTY: 1m Micro-Confirmation PENDING for ${selectedContract?.symbolHint || 'contract'}: ${optEval.reason} — standing aside until 1m rejection wick/green bar forms`
        );
        return;
      }
      if (optEval.status === 'CONFIRMED' && optEval.directOptionLevels) {
        directOptionLevels = optEval.directOptionLevels;
        console.log(
          `[RedBarBot] NIFTY: 1m Micro-Confirmation CONFIRMED for ${selectedContract.symbolHint} via ${optEval.micro?.triggerPattern} | Entry=${directOptionLevels.entryPrice} SL=${directOptionLevels.stopLossPrice} 1:1=${directOptionLevels.tp1Banker} Target=${directOptionLevels.tpTarget} (RR ${directOptionLevels.rrRatio})`
        );
      } else {
        const allowDeltaFallback = String(process.env.DHAN_ALLOW_DELTA_FALLBACK || 'false').toLowerCase() === 'true';
        if (!allowDeltaFallback) {
          console.log(`[RedBarBot] NIFTY: option 1m feed unavailable (${optEval.status}: ${optEval.reason}) — holding auto order (DHAN_ALLOW_DELTA_FALLBACK=false)`);
          return;
        }
        console.log(`[RedBarBot] NIFTY: option 1m feed fallback opted-in (${optEval.status}: ${optEval.reason}) — proceeding with mapped index delta levels`);
      }
    }

    console.log(`[RedBarBot] DHAN_AUTO ${instKey} ${side} ${setupKind} index=${indexEntry} stop=${indexStop} tp1=${indexTp1}`);
    const result = await trader.openOptionSuperTrade({
      side,
      indexEntry,
      indexStop,
      indexTp1,
      correlationId: `rb-${instKey.toLowerCase()}-${setupKind}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30),
      directOptionLevels,
      contractOverride: selectedContract,
    });

    if (result.ok && result.orderId) {
      lastAlerted[`DHAN_TRADE_${instKey}_DETAIL`] = alertKey;
      lastAlerted[`DHAN_TRADE_${instKey}_LAST_TS`] = Date.now();
      lastAlerted[countKey] = dayCount + 1;
      if (rule6SlRow) {
        lastAlerted[rule6CountKey] = (Number(lastAlerted[rule6CountKey]) || 0) + 1;
      }
      saveAlertState(lastAlerted);
      const managed = loadManagedDhanTrades().filter((t) => t.status !== 'open' || String(t.instrumentId || 'NIFTY').toUpperCase() !== instKey).slice(-30);
      if (rule6SlRow && rule6SlRow.orderId) {
        for (const row of managed) {
          if (String(row.orderId) === String(rule6SlRow.orderId) && row.status === 'closed_sl') {
            row.rule6Reentered = true;
            row.rule6ReenteredAt = Date.now();
            row.rule6ReentryAlertKey = alertKey;
          }
        }
      }
      managed.push({
        status: 'open',
        instrumentId: instKey,
        underlyingScrip: trader.underlyingScrip,
        underlyingSeg: trader.underlyingSeg,
        optSeg: trader.optSeg,
        dayKey: dayKey || '',
        side,
        setupKind,
        alertKey,
        orderId: result.orderId,
        securityId: result.contract.securityId,
        symbolHint: result.contract.symbolHint,
        strike: result.contract.strike,
        expiry: result.contract.expiry,
        optSide: result.contract.optSide,
        entryPremium: result.contract.ltp,
        stopLossPrice: result.levels.stopLossPrice,
        targetPrice: result.levels.targetPrice,
        oneRPts: result.levels.oneRPts || (result.contract.ltp - result.levels.stopLossPrice),
        directOptionUsed: Boolean(directOptionLevels),
        qty: result.qty,
        indexEntry,
        indexStop,
        indexTp1: medianTrade ? (realMedianTp > 0 ? realMedianTp : null) : indexTp1,
        medianTrade,
        entryMedian: readout.fibBounce?.median ?? null,
        entryBandLo: readout.fibBounce?.entryLo ?? null,
        entryBandHi: readout.fibBounce?.entryHi ?? null,
        medianId: readout.fibBounce?.medianId ?? null,
        lastManagedBarT: Number(readout.triggerTs) || null,
        beMoved: false,
        legABooked: false,
        superActive: true,
        openedAt: Date.now(),
        rule6Reentry: Boolean(rule6SlRow),
      });
      saveManagedDhanTrades(managed);
    }

    const summary = result.ok
      ? `✅ Dhan AUTO ${side} ${result.contract.symbolHint}\nQty ${result.qty} · prem≈${result.contract.ltp} · SL ${result.levels.stopLossPrice} · TP ${result.levels.targetPrice}\nRisk ~Rs ${Math.round((result.levels.entryPrice - result.levels.stopLossPrice) * result.qty * (Number(inst.contractMultiplier) || 1))} · Reward ~Rs ${Math.round((result.levels.targetPrice - result.levels.entryPrice) * result.qty * (Number(inst.contractMultiplier) || 1))}\nSuperOrder ${result.orderId} · status ${result.orderStatus || 'PENDING'} · (${setupKind})`
      : `⚠️ Dhan AUTO failed / no fill · status=${result.orderStatus || 'n/a'} ${result.omsError || JSON.stringify(result).slice(0, 180)}`;
    console.log('[RedBarBot]', summary.replace(/\n/g, ' | '));
    if (bot && chatId) {
      await bot.sendMessage(chatId, summary, { disable_web_page_preview: true }).catch(() => {});
    }
  } catch (e) {
    console.error('[RedBarBot] DHAN_AUTO failed:', e.message);
    const errMsg = String(e.message || e);
    lastAlerted[`DHAN_TRADE_${instKey}_LAST_ERR`] = errMsg.slice(0, 180);
    // Funds / invalid levels are not fills — do not burn the 30m instrument cooldown
    // (otherwise a short-by-₹500 Trade 1 miss blocks the later 5:30 Formula).
    const softFail = /Insufficient funds|Invalid Super Order levels|incomplete index/i.test(errMsg);
    if (!softFail) {
      lastAlerted[`DHAN_TRADE_${instKey}_LAST_TS`] = Date.now();
    } else {
      lastAlerted[`DHAN_SOFT_FAIL_${instKey}_TS`] = Date.now();
      console.log(`[RedBarBot] ${instKey}: soft fail — backing off for 3m (${errMsg.slice(0, 80)})`);
    }
    const lastTgTs = Number(lastAlerted[`DHAN_FAIL_TG_${instKey}_TS`]) || 0;
    // Funds failures: tell once per setup (premium ticks change the text every scan), not every 10m.
    const sameSetupFunds = softFail && lastAlerted[`DHAN_FAIL_TG_${instKey}_KEY`] === alertKey;
    if (bot && chatId && !sameSetupFunds && (Date.now() - lastTgTs > 10 * 60 * 1000)) {
      lastAlerted[`DHAN_FAIL_TG_${instKey}_TS`] = Date.now();
      lastAlerted[`DHAN_FAIL_TG_${instKey}_KEY`] = alertKey;
      await bot.sendMessage(chatId, `❌ Dhan AUTO failed ${instKey} ${side}: ${e.message}`, {
        disable_web_page_preview: true,
      }).catch(() => {});
    }
    saveAlertState(lastAlerted);
  }
}

/**
 * Manage open Dhan Super Orders — Dr Dev ladder:
 *  - At ~1:1 premium R: bank ~50% (2+ lots) / BE-only if 1 lot; runner SL → BE
 *  - At ~2R: trail runner SL up to lock ~1R
 *  - Hard flat at 15:10 IST for NSE/BSE indices, or 23:15 IST for MCX evening commodities
 */
async function pollManagedDhanStops() {
  if (String(process.env.DHAN_AUTO_TRADE || '').toLowerCase() !== 'true') return;
  if (String(process.env.TRADE_ENABLED || '').toLowerCase() !== 'true') return;
  if (!envTrim('DHAN_CLIENT_ID') || !envTrim('DHAN_ACCESS_TOKEN')) return;

  const allRows = loadManagedDhanTrades();
  const closedRows = allRows.filter((t) => t.status !== 'open').slice(-30);
  let rows = allRows.filter((t) => t.status === 'open');
  if (!rows.length) return;

  const { createDhanNiftyTrade } = require('./js/dhan_nifty_trade.js');
  const mins = _istMinsNow();
  const flatMins = Number(process.env.DHAN_FLAT_IST_MINS) || (15 * 60 + 10);
  const mcxFlatMins = Number(process.env.DHAN_MCX_FLAT_IST_MINS) || (23 * 60 + 15);
  const next = [];

  for (const t of rows) {
    try {
      const tInst = String(t.instrumentId || 'NIFTY').toUpperCase();
      const isMcx = ['CRUDEOIL', 'NG'].includes(tInst);
      let trader;
      try {
        trader = createDhanNiftyTrade({ instrumentId: tInst });
      } catch (e) {
        console.warn('[RedBarBot] Dhan manage init:', e.message);
        next.push(t);
        continue;
      }

      const shouldFlatEod = isMcx
        ? (mins >= mcxFlatMins && mins <= 1415)
        : (mins >= flatMins && mins <= 940);
      if (shouldFlatEod) {
        // Only check THIS managed contract — another manual option must not force a flatten.
        const openQty = t.securityId
          ? await trader.getOpenQtyForSecurity(t.securityId).catch(() => null)
          : null;
        if (openQty != null && Math.abs(openQty) === 0) {
          console.log(`[RedBarBot] Dhan position already flat for ${t.symbolHint || t.orderId} (security ${t.securityId}) — marking closed`);
          t.status = 'closed';
          t.closedAt = Date.now();
          next.push(t);
          continue;
        }
        const flatQty = openQty != null && Math.abs(openQty) > 0
          ? Math.abs(openQty)
          : t.qty;
        const flatClockLabel = isMcx ? '23:15' : '15:10';
        console.log(`[RedBarBot] Dhan flat@${flatClockLabel} — closing ${t.symbolHint || t.orderId} qty=${flatQty}`);
        const flatRes = await trader.flattenTrade({
          orderId: t.orderId,
          securityId: t.securityId,
          quantity: flatQty,
          runnerSlOrderId: t.runnerSlOrderId,
          runnerTpOrderId: t.runnerTpOrderId,
        });
        if (flatRes && flatRes.exitError) {
          console.error(`[RedBarBot] 🚨 Dhan flat@${flatClockLabel} FAILED: ${flatRes.exitError}`);
          if (bot && chatId) {
            await bot.sendMessage(
              chatId,
              `🚨 <b>CRITICAL: Dhan EOD Flatten FAILED!</b>\n${flatRes.exitError}\nContract: ${t.symbolHint || t.orderId}\n👉 <b>MANUALLY EXIT ON DHAN BEFORE RMS!</b>`,
              { parse_mode: 'HTML', disable_web_page_preview: true },
            ).catch(() => {});
          }
          next.push(t);
          continue;
        }
        t.status = 'flattened_eod';
        t.closedAt = Date.now();
        if (bot && chatId) {
          await bot.sendMessage(chatId, `🕔 Dhan EOD flat · ${t.symbolHint || t.orderId}`, {
            disable_web_page_preview: true,
          }).catch(() => {});
        }
        next.push(t);
        continue;
      }

      // Dual exit coordination on NIFTY median trades:
      // 1) If DHAN_EXIT_MODEL=B & qty >= 2 lots: bank 50% @ 1:1 (option OR index 1R) and move runner SL to cost +0.50.
      // 2) Closed 5m index median checks handle early reversal ('done'/'flip'/'back'), while broker SuperOrder TP guards the Option Chart ceiling (2.2R / 15m low).
      if (t.medianTrade && t.status === 'open') {
        const st = _instTrendState.get(tInst) || {};
        const bar = st.lastClosed5m;
        const long = String(t.side).toUpperCase() === 'LONG';
        if (bar && Number.isFinite(bar.t) && bar.t !== t.lastManagedBarT && bar.t >= (Number(t.openedAt) || 0) - 5 * 60 * 1000) {
          const target = Number(t.indexTp1);
          const hasTarget = Number.isFinite(target) && target > 0;
          const tagged = hasTarget && (long ? bar.h >= target : bar.l <= target);
          const through = hasTarget && (long ? bar.c > target : bar.c < target);
          const back = hasTarget && (long ? bar.c < target : bar.c > target);
          const flipped = long ? bar.c < bar.o : bar.c > bar.o;
          let decision = 'hold';
          if (hasTarget && tagged && through && flipped) decision = 'flip';
          else if (hasTarget && tagged && through) decision = 'roll';
          else if (hasTarget && tagged && back) decision = 'done';
          else if (!hasTarget) {
            const lo = Number(t.entryBandLo);
            const hi = Number(t.entryBandHi);
            if (long && Number.isFinite(lo) && bar.c < lo) decision = 'back';
            if (!long && Number.isFinite(hi) && bar.c > hi) decision = 'back';
          }
          if (decision === 'roll') {
            const meds = Array.isArray(st.medians) ? st.medians : [];
            const targets = meds
              .map((m) => {
                let nearEdge = long ? Number(m.lo) : Number(m.hi);
                if (!Number.isFinite(nearEdge) && m.fibs && Number.isFinite(Number(m.fibs.f44)) && Number.isFinite(Number(m.fibs.f56))) {
                  const lo = Math.min(Number(m.fibs.f44), Number(m.fibs.f56));
                  const hi = Math.max(Number(m.fibs.f44), Number(m.fibs.f56));
                  nearEdge = long ? lo : hi;
                }
                if (!Number.isFinite(nearEdge)) nearEdge = Number(m.price);
                return Number.isFinite(nearEdge) ? nearEdge : null;
              })
              .filter((p) => p != null)
              .sort((a, b) => a - b);
            const nxt = long
              ? targets.find((p) => p > bar.c + 2)
              : [...targets].reverse().find((p) => p < bar.c - 2);
            t.indexTp1 = nxt || null;
            t.lastManagedBarT = bar.t;
            console.log(`[RedBarBot] ${tInst} median close-through · next near-edge target ${t.indexTp1 || 'none — hold'}`);
          } else if (decision === 'done' || decision === 'flip' || decision === 'back') {
            const openQty = t.securityId
              ? await trader.getOpenQtyForSecurity(t.securityId).catch(() => null)
              : null;
            const flatQty = openQty != null && Math.abs(openQty) > 0 ? Math.abs(openQty) : t.qty;
            const why = decision === 'flip' ? 'color flip' : decision === 'back' ? 'back through entry median' : 'median tagged';
            console.log(`[RedBarBot] ${tInst} median exit (${why}) · ${t.symbolHint} qty=${flatQty}`);
            const flatRes = await trader.flattenTrade({
              orderId: t.orderId,
              securityId: t.securityId,
              quantity: flatQty,
              runnerSlOrderId: t.runnerSlOrderId,
              runnerTpOrderId: t.runnerTpOrderId,
            });
            if (flatRes && flatRes.exitError) {
              console.error(`[RedBarBot] median exit FAILED: ${flatRes.exitError}`);
              next.push(t);
              continue;
            }
            t.lastManagedBarT = bar.t;
            t.status = decision === 'back' ? 'closed_sl' : 'closed_target';
            t.closedAt = Date.now();
            t.medianExit = decision;
            if (decision === 'flip') {
              lastAlerted[`DHAN_MEDIAN_FLIP_${tInst}_BAR`] = bar.t;
              lastAlerted[`DHAN_TRADE_${tInst}_LAST_TS`] = 0;
              saveAlertState(lastAlerted);
            }
            if (bot && chatId) {
              await bot.sendMessage(
                chatId,
                `Median ${why} · ${t.symbolHint || t.orderId}`,
                { disable_web_page_preview: true },
              ).catch(() => {});
            }
            next.push(t);
            continue;
          } else {
            t.lastManagedBarT = bar.t;
          }
        }

        // Move SL to Breakeven (and bank 50% in Model B) once 1:1 risk is reached on either option premium OR underlying index
        if (!t.beMoved && Number(t.indexEntry) > 0 && Number(t.indexStop) > 0 && t.orderId) {
          const risk = Math.abs(Number(t.indexEntry) - Number(t.indexStop));
          // Only consider candles that closed AFTER the trade was opened (never past signal bars)
          const bar5 = (st.lastClosed5m && Number(st.lastClosed5m.t) >= Number(t.openedAt || 0))
            ? st.lastClosed5m
            : null;
          const liveIndexPx = Number(st.price) || 0;
          const curPx = long
            ? Math.max(liveIndexPx, Number(bar5?.h) || 0)
            : Math.min(
              liveIndexPx > 0 ? liveIndexPx : Infinity,
              Number(bar5?.l) > 0 ? Number(bar5.l) : Infinity,
            );
          let optLtpHit1R = false;
          if (Number(t.entryPremium) > 0 && Number(t.oneRPts) > 0 && t.expiry && t.strike != null) {
            try {
              const chain = await trader.dhan.getOptionChain({
                underlyingScrip: t.underlyingScrip || trader.underlyingScrip || 13,
                underlyingSeg: t.underlyingSeg || trader.underlyingSeg || 'IDX_I',
                expiry: t.expiry,
              });
              const oc = chain?.data?.oc || chain?.oc || {};
              const node = oc[String(t.strike)] || oc[Number(t.strike).toFixed(6)] || oc[Object.keys(oc).find((k) => Math.abs(Number(k) - Number(t.strike)) < 0.01)];
              const optSide = t.optSide || (long ? 'CE' : 'PE');
              const leg = optSide === 'CE' ? node?.ce : node?.pe;
              const optLtp = Number(leg?.last_price) || 0;
              if (optLtp >= Number(t.entryPremium) + Number(t.oneRPts)) {
                optLtpHit1R = true;
              }
            } catch (_) {}
          }
          if ((curPx > 0 && risk > 0) || optLtpHit1R) {
            const idxHit1R = curPx > 0 && risk > 0 && (long
              ? (curPx >= Number(t.indexEntry) + risk)
              : (curPx <= Number(t.indexEntry) - risk));
            const hit1R = optLtpHit1R || idxHit1R;
            if (hit1R) {
              console.log(`[RedBarBot] 🎯 1:1 reached on median trade (opt1R=${optLtpHit1R}, idx1R=${idxHit1R}): price=${curPx} vs entry=${t.indexEntry} (risk=${risk.toFixed(1)}pts).`);
              const exitModel = String(process.env.DHAN_EXIT_MODEL || 'B').toUpperCase();
              if (exitModel === 'B' && !t.legABooked && Number(t.qty) >= (Number(t.lotSize) || 65) * 2) {
                try {
                  console.log(`[RedBarBot] 🏦 Model B: Banking 50% @ 1:1 on median trade ${t.symbolHint || t.orderId}...`);
                  const res = await trader.bankHalfAtOneR({
                    orderId: t.orderId,
                    securityId: t.securityId,
                    entryPremium: t.entryPremium,
                    stopLossPrice: t.stopLossPrice,
                    targetPrice: t.targetPrice,
                    quantity: t.qty,
                  });
                  t.legABooked = true;
                  t.legABookedAt = Date.now();
                  t.beMoved = true;
                  t.beMovedAt = Date.now();
                  if (bot && chatId) {
                    await bot.sendMessage(
                      chatId,
                      `🎯 <b>Model B 1:1 Banked</b> (${curPx.toFixed(1)})\n${t.symbolHint || t.orderId}: Banked 50% profit. Runner SL moved to Breakeven (+0.50).`,
                      { parse_mode: 'HTML', disable_web_page_preview: true },
                    ).catch(() => {});
                  }
                } catch (e) {
                  console.warn('[RedBarBot] bankHalfAtOneR error on median trade:', e.message);
                }
              } else if (!t.beMoved) {
                try {
                  const moved = await trader.moveStopToBreakeven(t.orderId, t.entryPremium, 0.5);
                  if (moved && !moved.error) {
                    t.beMoved = true;
                    t.beMovedAt = Date.now();
                    if (bot && chatId) {
                      await bot.sendMessage(
                        chatId,
                        `🎯 <b>1:1 reached on underlying</b> (${curPx.toFixed(1)})\n${t.symbolHint || t.orderId}: SL moved to Breakeven (${(Number(t.entryPremium) + 0.5).toFixed(1)}). Letting full trade run to target median!`,
                        { parse_mode: 'HTML', disable_web_page_preview: true },
                      ).catch(() => {});
                    }
                  }
                } catch (e) {
                  console.warn('[RedBarBot] median moveStopToBreakeven error:', e.message);
                }
              }
            }
          }
        }

        next.push(t);
        continue;
      }

      // Dr Dev ladder: 1:1 → bank ~50% + runner BE; ~2R → trail; soft-stop if broker rejects exit SL.
      // After BE, stopLossPrice can sit ≥ entry — still manage using oneRPts / lockedSl.
      if (t.entryPremium > 0 && (t.stopLossPrice > 0 || t.legABooked)) {
        const oneR = Number(t.oneRPts) > 0
          ? Number(t.oneRPts)
          : Math.max(1, t.entryPremium - Math.min(t.stopLossPrice || t.entryPremium, t.entryPremium - 1));
        // Prefer live option-chain LTP — SuperOrder.ltp often sticks at entry fill and never sees 1R.
        let ltp = null;
        try {
          if (t.expiry && t.strike != null) {
            const chain = await trader.dhan.getOptionChain({
              underlyingScrip: t.underlyingScrip || trader.underlyingScrip || 13,
              underlyingSeg: t.underlyingSeg || trader.underlyingSeg || 'IDX_I',
              expiry: t.expiry,
            });
            const oc = chain?.data?.oc || chain?.oc || {};
            const node = oc[String(t.strike)] || oc[`${Number(t.strike).toFixed(6)}`];
            const leg = t.optSide === 'PE' ? node?.pe : node?.ce;
            ltp = Number(leg?.last_price) || Number(leg?.top_bid_price) || null;
          }
        } catch (_) { /* ignore */ }
        if (ltp == null && t.orderId && !t.legABooked) {
          try {
            const supers = await trader.dhan.getSuperOrders();
            const book = Array.isArray(supers) ? supers : [];
            const row = book.find((o) => String(o.orderId) === String(t.orderId));
            const superLtp = row?.ltp != null ? Number(row.ltp) : null;
            // Ignore stale fill echo (equal to entry)
            if (superLtp != null && Math.abs(superLtp - Number(t.entryPremium)) > 0.5) ltp = superLtp;
          } catch (_) { /* ignore */ }
        }

        if (ltp == null && t.securityId) {
          try {
            ltp = await trader.dhan.getMarketLtp(t.optSeg || 'MCX_COMM', t.securityId);
          } catch (_) { /* ignore */ }
        }

        let hitOneR = false;
        if (ltp != null && oneR > 0) {
          const openR = (ltp - t.entryPremium) / oneR;
          if (openR >= 1.0) hitOneR = true;
        }

        // Also check underlying index/commodity 1:1 level (crucial for MCX commodities or fast index moves)
        // Guard: Trade must be open for at least 45 seconds to prevent noise knockout at fill
        const tradeAgeMs = Date.now() - Number(t.openedAt || t.createTime || 0);
        if (!hitOneR && t.indexEntry && t.indexStop && tradeAgeMs >= 45000) {
          const curIndexPx = Number(_instTrendState.get(tInst)?.price);
          const indexRisk = Math.abs(Number(t.indexEntry) - Number(t.indexStop));
          if (curIndexPx > 0 && indexRisk > 0) {
            const isLong = String(t.side).toUpperCase() === 'LONG';
            const oneRLevel = isLong
              ? (Number(t.indexEntry) + indexRisk)
              : (Number(t.indexEntry) - indexRisk);
            if (isLong && curIndexPx >= oneRLevel) {
              hitOneR = true;
              console.log(`[RedBarBot] 🎯 ${tInst} 1:1 reached on underlying: price=${curIndexPx} >= oneR=${oneRLevel.toFixed(1)}`);
            }
            if (!isLong && curIndexPx <= oneRLevel) {
              hitOneR = true;
              console.log(`[RedBarBot] 🎯 ${tInst} 1:1 reached on underlying: price=${curIndexPx} <= oneR=${oneRLevel.toFixed(1)}`);
            }
          }
        }

        // Step 1 — Exit Model Handling: Model A (All-In/All-Out) vs Model B (1:1 Banker + Runner)
        const exitModel = String(process.env.DHAN_EXIT_MODEL || 'B').toUpperCase();
        if (exitModel === 'A') {
          // Model A: Super Order remains full size to Target or SL on Dhan RMS.
          if (hitOneR && String(process.env.DHAN_MOVE_BE_AT_1R || '').toLowerCase() === 'true' && !t.beMoved) {
            try {
              await trader.moveStopToBreakeven(t.orderId, t.entryPremium, 0.5);
              t.beMoved = true;
              t.beMovedAt = Date.now();
              console.log(`[RedBarBot] 🔒 Model A full size SL moved to Breakeven (${t.entryPremium}) on ${t.symbolHint}`);
            } catch (e) {
              console.warn('[RedBarBot] Model A BE move failed:', e.message);
            }
          }
        } else if (!t.legABooked && hitOneR) {
          // Model B: 1:1 Bank ~50% (2+ lots) + Runner SL to Breakeven
          try {
            const res = await trader.bankHalfAtOneR({
              orderId: t.orderId,
              securityId: t.securityId,
              entryPremium: t.entryPremium,
              stopLossPrice: t.stopLossPrice,
              targetPrice: t.targetPrice,
              quantity: t.qty,
            });
            t.legABooked = true;
            t.legABookedAt = Date.now();
            const tDayKey = t.dayKey || (String(t.alertKey || '').split('|')[2] || '');
            const tSess = (String(t.setupKind || '').startsWith('afternoon_1245') || String(t.setupKind || '').startsWith('mcx_530')) ? 'PM' : 'AM';
            if (tDayKey) {
              const cKey = tInst === 'NIFTY' ? `DHAN_CONSEC_LOSSES_${tSess}_${tDayKey}` : `DHAN_CONSEC_LOSSES_${tInst}_${tSess}_${tDayKey}`;
              const wKey = tInst === 'NIFTY' ? `DHAN_T1_WON_${tDayKey}` : `DHAN_T1_WON_${tInst}_${tDayKey}`;
              lastAlerted[cKey] = 0;
              if (t.setupKind === 'trade1_departure') {
                lastAlerted[wKey] = true;
              }
              saveAlertState(lastAlerted);
            }
            t.legAMode = res.mode;
            t.bankQty = res.bankQty || 0;
            t.qty = res.runnerQty != null ? res.runnerQty : t.qty;
            t.beMoved = true;
            t.beMovedAt = Date.now();
            t.lockedSl = res.be;
            t.stopLossPrice = res.be;
            t.targetPrice = res.tp3 || t.targetPrice;
            t.runnerSlOrderId = res.runnerSlOrderId || null;
            t.runnerTpOrderId = res.runnerTpOrderId || null;
            t.oneRPts = res.oneR || oneR;
            if (res.mode === 'partial') t.superActive = false;
            const ltpDisplay = ltp != null ? `LTP ${ltp}` : 'index 1:1 touched';
            const msg = res.mode === 'partial'
              ? `📒 Dhan 1:1 bank ${res.bankQty} · runner ${res.runnerQty} SL→BE ${res.be} · TP ${res.tp3}\n${t.symbolHint} · ${ltpDisplay}`
              : `🔒 Dhan 1:1 · 1-lot BE-only (need 2+ lots for 50% bank)\nSL→BE ${res.be} · TP ${res.tp3} · ${t.symbolHint} · (${ltpDisplay})`;
            console.log(`[RedBarBot] ${msg.replace(/\n/g, ' | ')}`);
            if (res.bankError || res.runnerSlError) {
              console.warn('[RedBarBot] Dhan 1:1 ladder warnings:', res.bankError || '', res.runnerSlError || '');
            }
            if (bot && chatId) {
              await bot.sendMessage(chatId, msg, { disable_web_page_preview: true }).catch(() => {});
            }
          } catch (e) {
            console.warn(`[RedBarBot] Dhan 1:1 bank failed: ${e.message}`);
          }
        }

        if (ltp != null && oneR > 0) {
          const openR = (ltp - t.entryPremium) / oneR;

          // Step 2 — ~2R: raise soft-stop floor to ~1R (broker exit-SL often RMS-rejects on Dhan options)
          if (t.legABooked && !t.lock2Moved && openR >= 2.0) {
            const trailSl = +(t.entryPremium + oneR * 1.0).toFixed(2);
            const curLock = Number(t.lockedSl) || Number(t.stopLossPrice) || 0;
            if (trailSl > curLock + 0.4) {
              t.lock2Moved = true;
              t.lock2MovedAt = Date.now();
              t.lockedSl = trailSl;
              t.stopLossPrice = trailSl;
              console.log(`[RedBarBot] Dhan runner soft-trail @2R · ${t.symbolHint} floor→${trailSl}`);
              if (bot && chatId) {
                await bot.sendMessage(
                  chatId,
                  `🛡️ Dhan runner trail ~2R · ${t.symbolHint}\nSoft floor→${trailSl} · LTP ${ltp}`,
                  { disable_web_page_preview: true },
                ).catch(() => {});
              }
            }
          }

          // Soft exits when broker won't hold linked SL+TP as two independent sells
          // (pending TP covering qty → extra SELL STOP RMS'd as naked short).
          if (t.legABooked && t.status === 'open') {
            const floor = Number(t.lockedSl) || (Number(t.entryPremium) + 0.5);
            const tpHit = Number(t.targetPrice) > 0 && ltp >= Number(t.targetPrice) - 0.25;
            const slHit = ltp <= floor;
            if ((slHit && !t.softStopFired) || (tpHit && !t.softTpFired)) {
              try {
                const left = await trader.getOpenQtyForSecurity(t.securityId).catch(() => t.qty);
                const flatQty = Math.abs(left != null ? left : t.qty) || t.qty;
                const why = tpHit ? 'soft-TP' : 'soft-SL';
                console.log(`[RedBarBot] Dhan ${why} · ${t.symbolHint} LTP ${ltp} floor ${floor} tp ${t.targetPrice} — flattening ${flatQty}`);
                const flatRes = await trader.flattenTrade({
                  orderId: t.orderId,
                  securityId: t.securityId,
                  quantity: flatQty,
                  runnerSlOrderId: t.runnerSlOrderId,
                  runnerTpOrderId: t.runnerTpOrderId,
                });
                if (tpHit) t.softTpFired = true;
                if (slHit) t.softStopFired = true;
                // After the 1:1 bank the stop is at cost or better — that exit is not an SL hunt (Rule 6 must not fire).
                t.status = tpHit ? 'closed_target' : (t.legABooked ? 'closed_be' : 'closed_sl');
                t.closedAt = Date.now();
                if (bot && chatId) {
                  await bot.sendMessage(
                    chatId,
                    `${tpHit ? '🎯' : '🛑'} Dhan ${why} · ${t.symbolHint}\nLTP ${ltp}`
                      + (flatRes?.exitError ? `\n⚠️ ${flatRes.exitError}` : ''),
                    { disable_web_page_preview: true },
                  ).catch(() => {});
                }
              } catch (e) {
                console.warn(`[RedBarBot] Dhan soft exit failed: ${e.message}`);
              }
            }
          }
        }
      }

      // Drop if super / runner exits closed
      try {
        if (t.legAMode === 'partial' && (t.runnerSlOrderId || t.runnerTpOrderId)) {
          const checkIds = [t.runnerTpOrderId, t.runnerSlOrderId].filter(Boolean);
          for (const oid of checkIds) {
            let st = '';
            try {
              const ord = await trader.dhan.getOrderById(oid);
              st = String(ord?.orderStatus || ord?.status || '').toUpperCase();
            } catch (_) { /* ignore */ }
            if (st === 'TRADED' || st === 'COMPLETE' || st === 'FILLED') {
              const isTp = String(oid) === String(t.runnerTpOrderId);
              t.status = isTp ? 'closed_target' : (t.legABooked ? 'closed_be' : 'closed_sl');
              t.closedAt = Date.now();
              // Cancel the sibling exit leg
              const sibling = isTp ? t.runnerSlOrderId : t.runnerTpOrderId;
              if (sibling) {
                try { await trader.dhan.cancelOrder(sibling); } catch (_) { /* ignore */ }
              }
              console.log(`[RedBarBot] ${isTp ? '✅' : '🛑'} Dhan runner ${isTp ? 'TP' : 'SL'} · ${t.symbolHint}`);
              if (bot && chatId) {
                await bot.sendMessage(
                  chatId,
                  isTp
                    ? `🎯 <b>Dhan runner TP · ${t.symbolHint}</b>\nEntry ${t.entryPremium} · TP ${t.targetPrice}`
                    : `🛑 <b>Dhan runner SL · ${t.symbolHint}</b>\nEntry ${t.entryPremium} · SL ${t.stopLossPrice}`,
                  { parse_mode: 'HTML', disable_web_page_preview: true },
                ).catch(() => {});
              }
              break;
            }
          }
          if (t.status === 'open' && t.securityId) {
            const left = await trader.getOpenQtyForSecurity(t.securityId).catch(() => null);
            if (left != null && Math.abs(left) === 0) {
              t.status = 'closed';
              t.closedAt = Date.now();
            }
          }
        } else {
          const supers = await trader.dhan.getSuperOrders();
          const book = Array.isArray(supers) ? supers : [];
          const row = book.find((o) => String(o.orderId) === String(t.orderId));
          if (row && Array.isArray(row.legDetails)) {
            const targetLeg = row.legDetails.find((l) => l.legName === 'TARGET_LEG');
            const slLeg = row.legDetails.find((l) => l.legName === 'STOP_LOSS_LEG');
            if (targetLeg && String(targetLeg.orderStatus) === 'TRADED') {
              t.status = 'closed_target';
              t.closedAt = Date.now();
              console.log(`[RedBarBot] ✅ Dhan Target hit · ${t.symbolHint}`);
              if (bot && chatId) {
                await bot.sendMessage(
                  chatId,
                  `🎯 <b>Dhan Target Hit · ${t.symbolHint}</b>\nEntry: ${t.entryPremium} · Target: ${t.targetPrice} · Status: Profit Booked!`,
                  { parse_mode: 'HTML', disable_web_page_preview: true },
                ).catch(() => {});
              }
            } else if (slLeg && String(slLeg.orderStatus) === 'TRADED') {
              t.status = t.legABooked ? 'closed_be' : 'closed_sl';
              t.closedAt = Date.now();
              lastAlerted[`DHAN_TRADE_${tInst}_LAST_TS`] = Date.now();
              saveAlertState(lastAlerted);
              console.log(`[RedBarBot] 🛑 Dhan SL hit · ${t.symbolHint}`);
              const isMcxStop = ['CRUDEOIL', 'NG'].includes(tInst);
              const mcxMaxLosses = Number(process.env.DHAN_MCX_MAX_LOSSES || 2);
              const allM = loadManagedDhanTrades();
              const priorLosses = allM.filter((m) => String(m.instrumentId || 'NIFTY').toUpperCase() === tInst && m.status === 'closed_sl' && !m.legABooked && String(m.alertKey || '').includes(`|${dayKey}|`)).length;
              const isMcxPaused = priorLosses >= mcxMaxLosses;
              const mcxNote = isMcxStop && !t.legABooked
                ? (isMcxPaused ? `\n⚠️ <b>MCX Rule: Pausing ${tInst} auto-trading for today (${priorLosses}/${mcxMaxLosses} losses hit).</b>` : `\n⚠️ <b>MCX Rule: ${tInst} loss count ${priorLosses}/${mcxMaxLosses}.</b>`)
                : '';
              if (bot && chatId) {
                await bot.sendMessage(
                  chatId,
                  `🛑 <b>Dhan SL Hit · ${t.symbolHint}</b>\nEntry: ${t.entryPremium} · SL: ${t.stopLossPrice}${mcxNote}`,
                  { parse_mode: 'HTML', disable_web_page_preview: true },
                ).catch(() => {});
              }
            }
          }
          const parentStatus = row ? String(row.orderStatus || '').toUpperCase() : '';
          if (t.status === 'open' && ['CLOSED', 'CANCELLED', 'REJECTED'].includes(parentStatus)) {
            t.status = parentStatus === 'REJECTED' ? 'rejected' : parentStatus === 'CANCELLED' ? 'cancelled' : 'closed';
            t.closedAt = Date.now();
            lastAlerted[`DHAN_TRADE_${tInst}_LAST_TS`] = Date.now();
            saveAlertState(lastAlerted);
            console.log(`[RedBarBot] Dhan SuperOrder ${parentStatus} · ${t.symbolHint || t.orderId} — marking ${t.status}`);
          }
        }
      } catch (_) { /* keep managing */ }

      if (t.status !== 'open') {
        const tDayKey = t.dayKey || (String(t.alertKey || '').split('|')[2] || '');
        const tSess = (String(t.setupKind || '').startsWith('afternoon_1245') || String(t.setupKind || '').startsWith('mcx_530')) ? 'PM' : 'AM';
        if (tDayKey) {
          const cKey = tInst === 'NIFTY' ? `DHAN_CONSEC_LOSSES_${tSess}_${tDayKey}` : `DHAN_CONSEC_LOSSES_${tInst}_${tSess}_${tDayKey}`;
          const wKey = tInst === 'NIFTY' ? `DHAN_T1_WON_${tDayKey}` : `DHAN_T1_WON_${tInst}_${tDayKey}`;
          if (t.legABooked || t.status === 'closed_target' || t.status === 'closed_be') {
            lastAlerted[cKey] = 0;
            if (t.setupKind === 'trade1_departure') {
              lastAlerted[wKey] = true;
            }
          } else if (t.status === 'closed_sl') {
            lastAlerted[cKey] = (Number(lastAlerted[cKey]) || 0) + 1;
          }
        }
        lastAlerted[`DHAN_TRADE_${tInst}_LAST_TS`] = Date.now();
        saveAlertState(lastAlerted);
      }
      next.push(t);
    } catch (e) {
      console.warn('[RedBarBot] Dhan manage row failed:', e.message);
      next.push(t);
    }
  }

  saveManagedDhanTrades([...closedRows, ...next].slice(-40));
}

async function _maybeAutoFuturesTwoLeg({ inst, side, readout, alertKey, dayKey }) {
  if (String(process.env.REDBAR_AUTO_TRADE || '').toLowerCase() !== 'true') return;
  if (String(process.env.TRADE_ENABLED || '').toLowerCase() !== 'true') return;
  if (!_canAutoTradeBinanceFutures(inst)) {
    console.log(`[RedBarBot] ${inst.id}: ENTER alert only — ${inst.symbol} is not a Binance USD-M symbol (no auto trade)`);
    return;
  }
  if (!envTrim('BINANCE_API_KEY') || !envTrim('BINANCE_API_SECRET')) {
    console.warn('[RedBarBot] AUTO_TRADE on but Binance keys missing');
    return;
  }
  if (lastAlerted[`TRADE_${inst.id}_DETAIL`] === alertKey) {
    console.log(`[RedBarBot] ${inst.id}: futures already opened for ${alertKey}`);
    return;
  }
  // Multiple quality autos/day OK — cap + cooldown so we don't flip-chop the wallet.
  const rawFuturesCap = process.env.REDBAR_AUTO_MAX_PER_DAY;
  const futuresCapDisabled = rawFuturesCap === '0' || rawFuturesCap === 'none' || rawFuturesCap === 'unlimited' || rawFuturesCap === 'false';
  const maxPerDay = futuresCapDisabled ? 0 : (Number(rawFuturesCap) || 0);
  const rawCooldown = process.env.REDBAR_AUTO_COOLDOWN_MS;
  // Enforce a hard 45-minute minimum cooldown on Binance USD-M futures (opened OR closed) so chop cannot machine-gun re-entries.
  const minFuturesCooldownMs = 45 * 60 * 1000;
  const cooldownMs = Math.max(minFuturesCooldownMs, Number(rawCooldown) || 45 * 60 * 1000);
  const countKey = `TRADE_COUNT_${inst.id}_${dayKey || 'noday'}`;
  const dayCount = Number(lastAlerted[countKey]) || 0;
  if (!futuresCapDisabled && maxPerDay > 0 && dayCount >= maxPerDay) {
    console.log(`[RedBarBot] ${inst.id}: auto day cap ${dayCount}/${maxPerDay} — skip ${alertKey}`);
    return;
  }
  const lastTs = Number(lastAlerted[`TRADE_${inst.id}_LAST_TS`]) || 0;
  if (lastTs && Date.now() - lastTs < cooldownMs) {
    const mins = Math.ceil((cooldownMs - (Date.now() - lastTs)) / 60000);
    console.log(`[RedBarBot] ${inst.id}: auto cooldown ${mins}m left — skip ${alertKey}`);
    return;
  }
  const stop = Number(readout.invalidation);
  const tpA = Number(readout.tp1);
  // Market fill ≈ live price; engine levels are measured from the same price so $ risk matches sizing.
  const entry = Number(readout.price);
  const oneR = Math.abs(entry - stop);
  const tpB = Number(readout.tp3) || (side === 'LONG' ? entry + 3 * oneR : entry - 3 * oneR);
  if (!(stop > 0 && tpA > 0 && tpB > 0 && entry > 0)) {
    console.warn('[RedBarBot] AUTO_TRADE skip — incomplete levels');
    return;
  }
  // Risk Sizing: Lock max dollar loss at stop to REDBAR_RISK_USD (default $10.00).
  const targetRiskUsd = Number(process.env.REDBAR_RISK_USD)
    || (Number(process.env.REDBAR_TRADE_CAPITAL_USDT) > 0
        ? Number(process.env.REDBAR_TRADE_CAPITAL_USDT) * ((Number(process.env.REDBAR_RISK_PCT) || 2.5) / 100)
        : 10);
  const riskUsd = Math.max(2, Math.min(50, targetRiskUsd));
  const sz = RedBarTrend.futuresSizing({
    entry,
    stop,
    exit: tpB,
    capital: riskUsd * 100, // capital * 1% riskPct = exact riskUsd
    riskPct: 1,
  });
  const leverage = Math.min(10, Math.max(1, Number(sz?.recLeverage) || 5));
  let marginUsdt = sz?.marginRequiredUsd ? Math.max(5, Number(sz.marginRequiredUsd)) : (riskUsd * 10 / leverage);
  const maxMarginCap = Number(process.env.REDBAR_MAX_MARGIN_USDT) || Number(process.env.TRADE_MAX_USDT) || 200;
  if (maxMarginCap > 0 && marginUsdt > maxMarginCap) {
    marginUsdt = maxMarginCap;
  }
  try {
    const { createBinanceFuturesTrade } = require('./js/binance_futures_trade.js');
    const fut = createBinanceFuturesTrade();
    // Ops rule: one open BTC position at a time — never market-close an active runner
    const positions = await fut.getPositionRisk(inst.symbol);
    const openPos = (positions || []).find((p) => String(p.symbol).toUpperCase() === String(inst.symbol).toUpperCase());
    const openAmt = parseFloat(openPos?.positionAmt || 0);
    if (Math.abs(openAmt) > 0) {
      const openSide = openAmt > 0 ? 'LONG' : 'SHORT';
      console.log(`[RedBarBot] ${inst.id}: open ${inst.symbol} ${openSide} (${Math.abs(openAmt)}) already active — skip auto-entry for ${alertKey}`);
      return;
    }
    if (typeof fut.getAvailableUsdt === 'function') {
      try {
        const avbl = await fut.getAvailableUsdt();
        if (avbl > 5 && marginUsdt > avbl * 0.92) {
          marginUsdt = Math.max(5, Math.floor(avbl * 0.92));
        }
      } catch (_) {}
    }
    console.log(`[RedBarBot] AUTO_TRADE ${side} ${inst.symbol} risk=$${riskUsd.toFixed(2)} margin=$${marginUsdt.toFixed(2)} lev=${leverage}× notional≈$${(marginUsdt * leverage).toFixed(0)}`);
    const result = await fut.openTwoLegDeskTrade({
      symbol: inst.symbol,
      side,
      marginUsdt,
      leverage,
      stopPrice: stop,
      tpA,
      tpB,
      entryHint: entry,
      closePosition: false,
    });

    const fillEntry = Number(result.entry?.avgPrice) || entry;
    const stopOrderId = result.stopOrder?.algoId || result.stopOrder?.orderId || null;
    const tpAOrderId = result.tpAOrder?.algoId || result.tpAOrder?.orderId || null;
    // Only count a protected fill — failed flips must be retryable.
    if (result.ok && stopOrderId) {
      lastAlerted[`TRADE_${inst.id}_DETAIL`] = alertKey;
      lastAlerted[`TRADE_${inst.id}_LAST_TS`] = Date.now();
      lastAlerted[countKey] = dayCount + 1;
      saveAlertState(lastAlerted);
      const managed = loadManagedTrades().filter((t) => t.symbol !== inst.symbol);
      managed.push({
        symbol: inst.symbol,
        side,
        alertKey,
        entry: fillEntry,
        qty: result.qty,
        qtyB: result.qtyB,
        stopOrderId,
        stopAlgoId: stopOrderId,
        tpAOrderId,
        tpAAlgoId: tpAOrderId,
        tpBOrderId: result.tpBOrder?.algoId || result.tpBOrder?.orderId || null,
        initialStop: stop,
        oneR: Math.abs(fillEntry - stop),
        tp2: Number(readout.tp2) || (side === 'LONG' ? fillEntry + 2 * Math.abs(fillEntry - stop) : fillEntry - 2 * Math.abs(fillEntry - stop)),
        beMoved: false,
        trailArmed: false,
        openedAt: Date.now(),
      });
      saveManagedTrades(managed);
    }

    const summary = result.ok
      ? `✅ Auto two-leg ${side} ${inst.symbol}\nQty ${result.qty} · margin $${marginUsdt.toFixed(0)} · ${leverage}× · SL ${result.stopPrice} · TP A ${result.tpA} · TP B ${result.tpB}\n(BE stop moves after 1:1 fill)`
      : `⚠️ Auto trade partial ${side} ${inst.symbol}\n${(result.warnings || []).join('\n') || result.error}`;
    console.log('[RedBarBot]', summary.replace(/\n/g, ' | '));
    if (bot && chatId) {
      await bot.sendMessage(chatId, summary, { disable_web_page_preview: true }).catch(() => {});
    }
  } catch (e) {
    console.error('[RedBarBot] AUTO_TRADE failed:', e.message);
    const errKey = `TRADE_FAIL_${inst.id}_${alertKey}`;
    if (!lastAlerted[errKey]) {
      lastAlerted[errKey] = Date.now();
      saveAlertState(lastAlerted);
      if (bot && chatId) {
        const extraHint = /TradFi-Perps agreement/i.test(e.message || '')
          ? '\n👉 Open XAUUSDT or NATGASUSDT once in the Binance app/web Futures tab and click "Agree" on the TradFi-Perps popup — then auto-trade will work.'
          : '';
        await bot.sendMessage(
          chatId,
          `❌ Auto trade failed ${inst.symbol} ${side}: ${e.message}${extraHint}`,
          { disable_web_page_preview: true }
        ).catch(() => {});
      }
    }
  }
}

/** Poll open two-leg trades: when TP A (1:1) fills, move STOP_MARKET to breakeven; trail 15m after 1:2. */
let _manageFuturesInFlight = false;
let _manageFuturesStartedAt = 0;
async function pollManagedFuturesStops() {
  if (String(process.env.REDBAR_AUTO_TRADE || '').toLowerCase() !== 'true') return;
  if (String(process.env.TRADE_ENABLED || '').toLowerCase() !== 'true') return;
  if (!envTrim('BINANCE_API_KEY') || !envTrim('BINANCE_API_SECRET')) return;
  // A hung exchange call must not freeze BE / trail forever.
  if (_manageFuturesInFlight && Date.now() - _manageFuturesStartedAt < 90 * 1000) return;
  _manageFuturesInFlight = true;
  _manageFuturesStartedAt = Date.now();

  try {
    let rows = loadManagedTrades();
    if (!rows.length) return;

    const { createBinanceFuturesTrade } = require('./js/binance_futures_trade.js');
    let fut;
    try {
      fut = createBinanceFuturesTrade();
    } catch {
      return;
    }

    const keep = [];
    const processed = new Set();
    for (const t of rows) {
      const symKey = String(t.symbol || '').toUpperCase();
      processed.add(symKey);
      try {
        const positions = await fut.getPositionRisk(t.symbol);
        const pos = (positions || []).find((p) => String(p.symbol).toUpperCase() === symKey);
        const amt = Math.abs(parseFloat(pos?.positionAmt || 0));
        if (!(amt > 0)) {
          console.log(`[RedBarBot] ${t.symbol}: position flat — cancel leftover algos/orders & start 45m cooldown`);
          const closedInstId = symKey === 'BTCUSDT' ? 'BTC' : symKey === 'XAUUSDT' ? 'XAU' : symKey === 'NATGASUSDT' ? 'NG' : symKey.replace(/USDT$/, '');
          if (closedInstId) {
            lastAlerted[`TRADE_${closedInstId}_LAST_TS`] = Date.now();
            saveAlertState(lastAlerted);
          }
          try {
            if (typeof fut.clearSymbolForEntry === 'function') {
              const notes = await fut.clearSymbolForEntry(t.symbol, { closePosition: false });
              if (notes?.length) console.log(`[RedBarBot] ${t.symbol} cleanup:`, notes.join('; '));
            }
          } catch (e) {
            console.warn(`[RedBarBot] ${t.symbol} flat cleanup:`, e.message);
          }
          continue;
        }
        if (t.beMoved) {
          // Dr Dev ladder: stay at BE until 1:2, then trail behind 15m structure (not 5m noise).
          try {
            const markPrice = await fut.getMarkPrice(t.symbol);
            const isLong = String(t.side).toUpperCase() === 'LONG';
            const curStop = Number(t.currentStopPrice || t.bePrice || t.entry);
            const oneR = Number(t.oneR) > 0
              ? Number(t.oneR)
              : Math.abs(Number(t.entry) - Number(t.initialStop || t.bePrice || t.entry));
            const r2Level = Number(t.tp2) > 0
              ? Number(t.tp2)
              : (isLong ? Number(t.entry) + 2 * oneR : Number(t.entry) - 2 * oneR);
            const reached12 = isLong ? markPrice >= r2Level : markPrice <= r2Level;
            if (!reached12 || !(oneR > 0)) {
              keep.push(t);
              continue;
            }
            if (!t.trailArmed) {
              t.trailArmed = true;
              console.log(`[RedBarBot] ${t.symbol}: 1:2 touched — arming 15m structure trail`);
            }

            const raw15 = await _deskBars({ id: symKey.replace(/USDT$/, '') || 'BTC', symbol: t.symbol, feed: 'binanceFutures' }, '15m', 24).catch(() => null);
            const bars15 = Array.isArray(raw15) ? raw15 : [];
            const buf = markPrice * 0.0003; // ~3 bps (≈$23 on BTC, ≈$1.20 on XAU)
            let trailCandidate = null;
            if (bars15.length >= 5) {
              const completed = bars15.slice(-5, -1); // last ~1h closed 15m structure
              if (isLong) {
                const swingLow = Math.min(...completed.map((b) => Number(b.l != null ? b.l : b[3])));
                trailCandidate = swingLow - buf;
              } else {
                const swingHigh = Math.max(...completed.map((b) => Number(b.h != null ? b.h : b[2])));
                trailCandidate = swingHigh + buf;
              }
            }
            if (!trailCandidate || !Number.isFinite(trailCandidate)) {
              const fallbackDist = Math.max(oneR * 0.35, markPrice * 0.0025);
              trailCandidate = isLong ? (markPrice - fallbackDist) : (markPrice + fallbackDist);
            }

            const minStep = Math.max(buf, oneR * 0.08);
            if (isLong && markPrice > t.entry) {
              if (trailCandidate > curStop + minStep && trailCandidate > t.entry) {
                const moved = await fut.moveStopToBreakeven({
                  symbol: t.symbol,
                  side: t.side,
                  stopPrice: trailCandidate,
                  stopOrderId: t.stopOrderId,
                  stopAlgoId: t.stopAlgoId || t.stopOrderId,
                  quantity: amt,
                });
                t.currentStopPrice = moved.bePrice;
                t.stopOrderId = moved.stopOrder?.algoId || moved.stopOrder?.orderId || t.stopOrderId;
                t.stopAlgoId = t.stopOrderId;
                const lockedUsd = ((moved.bePrice - t.entry) * amt).toFixed(2);
                console.log(`[RedBarBot] ${t.symbol} LONG runner SL trailed behind 15m swing to ${moved.bePrice} (+${lockedUsd})`);
                if (bot && chatId) {
                  await bot.sendMessage(chatId, `🛡️ ${t.symbol} LONG runner SL trailed behind 15m structure to ${moved.bePrice} (Locked +${lockedUsd})`, { disable_web_page_preview: true }).catch(() => {});
                }
              }
            } else if (!isLong && markPrice < t.entry) {
              if (trailCandidate < curStop - minStep && trailCandidate < t.entry) {
                const moved = await fut.moveStopToBreakeven({
                  symbol: t.symbol,
                  side: t.side,
                  stopPrice: trailCandidate,
                  stopOrderId: t.stopOrderId,
                  stopAlgoId: t.stopAlgoId || t.stopOrderId,
                  quantity: amt,
                });
                t.currentStopPrice = moved.bePrice;
                t.stopOrderId = moved.stopOrder?.algoId || moved.stopOrder?.orderId || t.stopOrderId;
                t.stopAlgoId = t.stopOrderId;
                const lockedUsd = ((t.entry - moved.bePrice) * amt).toFixed(2);
                console.log(`[RedBarBot] ${t.symbol} SHORT runner SL trailed behind 15m swing to ${moved.bePrice} (+${lockedUsd})`);
                if (bot && chatId) {
                  await bot.sendMessage(chatId, `🛡️ ${t.symbol} SHORT runner SL trailed behind 15m structure to ${moved.bePrice} (Locked +${lockedUsd})`, { disable_web_page_preview: true }).catch(() => {});
                }
              }
            }
          } catch (e) {
            console.warn(`[RedBarBot] ${t.symbol} 15m trail error:`, e.message);
          }
          keep.push(t);
          continue;
        }
        if (!t.tpAOrderId) {
          keep.push(t);
          continue;
        }

        let tpAStatus = null;
        const tpAId = t.tpAAlgoId || t.tpAOrderId;
        try {
          if (typeof fut.getAlgoOrder === 'function') {
            const ord = await fut.getAlgoOrder(t.symbol, tpAId);
            tpAStatus = ord?.algoStatus || ord?.status || null;
          } else {
            const ord = await fut.getOrder(t.symbol, tpAId);
            tpAStatus = ord?.status || null;
          }
        } catch (e) {
          const runnerTarget = Number(t.qtyB) > 0 ? Number(t.qtyB) : (Number(t.qty) > 0 ? Number(t.qty) * 0.55 : 0);
          if (runnerTarget > 0 && amt <= runnerTarget * 1.05) {
            tpAStatus = 'FILLED';
          } else {
            console.warn(`[RedBarBot] ${t.symbol}: TP A order check: ${e.message}`);
            keep.push(t);
            continue;
          }
        }

        const tpADone = tpAStatus === 'FILLED' || tpAStatus === 'TRIGGERED' || tpAStatus === 'FINISHED';
        if (tpADone) {
          console.log(`[RedBarBot] ${t.symbol}: TP A ${tpAStatus} — moving SL to BE @ ${t.entry}`);
          const moved = await fut.moveStopToBreakeven({
            symbol: t.symbol,
            side: t.side,
            entryPrice: t.entry,
            stopOrderId: t.stopOrderId,
            stopAlgoId: t.stopAlgoId || t.stopOrderId,
            quantity: amt,
          });
          t.beMoved = true;
          t.stopOrderId = moved.stopOrder?.algoId || moved.stopOrder?.orderId || t.stopOrderId;
          t.stopAlgoId = t.stopOrderId;
          t.bePrice = moved.bePrice;
          t.currentStopPrice = moved.bePrice;
          t.beMovedAt = Date.now();
          keep.push(t);
          if (bot && chatId) {
            await bot.sendMessage(
              chatId,
              `🔒 ${t.symbol} ${t.side}: 1:1 hit — SL moved to BE @ ${moved.bePrice}`,
              { disable_web_page_preview: true }
            ).catch(() => {});
          }
        } else if (tpAStatus === 'CANCELED' || tpAStatus === 'EXPIRED' || tpAStatus === 'REJECTED') {
          console.log(`[RedBarBot] ${t.symbol}: TP A ${tpAStatus} — stop manage for this leg`);
        } else {
          keep.push(t);
        }
      } catch (e) {
        console.warn(`[RedBarBot] manage poll ${t.symbol}:`, e.message);
        keep.push(t);
      }
    }
    // Merge: do not drop trades appended while this poll ran.
    const latest = loadManagedTrades();
    const keepBySym = new Map(keep.map((t) => [String(t.symbol).toUpperCase(), t]));
    const merged = [];
    const seen = new Set();
    for (const t of keep) {
      const k = String(t.symbol).toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(t);
    }
    for (const t of latest) {
      const k = String(t.symbol).toUpperCase();
      if (seen.has(k)) continue;
      if (processed.has(k) && !keepBySym.has(k)) continue; // intentionally dropped (flat)
      seen.add(k);
      merged.push(t);
    }
    saveManagedTrades(merged);
  } finally {
    _manageFuturesInFlight = false;
  }
}
async function scanRedBarDesk() {
  if (isLegacyRenderHost) return;
  const rbCfg = CONFIG.rangeEma || {};
  const instruments = Array.isArray(rbCfg.instruments) ? rbCfg.instruments.slice() : [];
  // BTC first so a slow Nifty/Yahoo hop cannot delay the main alert
  instruments.sort((a, b) => (a.id === 'BTC' ? -1 : b.id === 'BTC' ? 1 : 0));
  for (const inst of instruments) {
    try {
      await _scanOneRedBarInstrument(inst, rbCfg);
    } catch (e) {
      console.warn(`[RedBarBot] Failed scanning ${inst.id}:`, e.message);
    }
  }
}

async function scanMarket() {
  if (isLegacyRenderHost) return;
  if (scanInProgress) {
    console.log('Scan already running — skipping overlapping trigger.');
    return;
  }
  scanInProgress = true;
  if (CONFIG.ui?.redBarOnly) {
    console.log('Scanning Red Bar Futures Desk instruments...');
    try {
      // Hard ceiling: never leave scanInProgress stuck if a feed hangs
      await _withTimeout(scanRedBarDesk(), 90000, 'Red Bar desk scan');
    } catch (e) {
      console.error('[RedBarBot] Scan aborted:', e.message);
    } finally {
      scanInProgress = false;
      console.log('Red Bar scan complete.');
    }
    return;
  }
  console.log('Scanning market...');
  const portfolio = loadPortfolio();

  // Dynamically inject user's private portfolio coins into the scanner
  for (const sym of Object.keys(portfolio)) {
    if (!CONFIG.assets.crypto.find(a => a.id === sym || a.symbol === sym.replace('USDT',''))) {
      CONFIG.assets.crypto.push({
        id: sym.endsWith('USDT') ? sym : sym + 'USDT',
        symbol: sym.replace('USDT', ''),
        name: sym.replace('USDT', ''),
        currency: 'USD',
        icon: '💎'
      });
      console.log(`Dynamically added private coin ${sym} to the scan loop.`);
    }
  }

  const fearGreed = await fetchFearGreed();

  // Bot only needs BTC (regime) + core winners + owned coins — cuts Binance weight ~70%
  // and reduces Render IP 418 bans. Full universe still runs on the website.
  const fullUniverse = CONFIG.assets.crypto.slice();
  const needed = new Set([
    'BTC',
    ...((CONFIG.assets.coreWinners || []).map(s => String(s).toUpperCase())),
    ...Object.keys(portfolio).map(s => String(s).toUpperCase().replace(/USDT$/, '')),
  ]);
  CONFIG.assets.crypto = fullUniverse.filter(a => {
    const sym = String(a.symbol || a.id || '').toUpperCase().replace(/USDT$/, '');
    return needed.has(sym);
  });
  console.log(`Bot scan universe: ${CONFIG.assets.crypto.map(a => a.symbol).join(', ')}`);
  
  try {
    const crypto = await API.getAllCrypto();
    const all = [...(crypto || [])].filter(d => d.closes && d.closes.length >= 30);
    
    // --- Scan stats for X daily pulse ---
    let watchCount = 0;
    let strongBuyCount = 0;
    let topWatch = null; // { symbol, score, confidence }
    let alertPostedThisScan = false;
    
    let marketRegime = 'flat';
    const btc = all.find(a => (a.asset?.symbol === 'BTCUSDT' || a.asset?.id === 'BTCUSDT') && a.closes?.length >= 50);
    if (btc) {
      const btcSma50 = Indicators.last(Indicators.sma(btc.closes, 50));
      const btcEma9 = Indicators.last(Indicators.ema(btc.closes, 9));
      const btcEma21 = Indicators.last(Indicators.ema(btc.closes, 21));
      const btcPrice = btc.closes[btc.closes.length - 1];
      if (btcSma50) {
        marketRegime = btcPrice > btcSma50 && btcEma9 > btcEma21 ? 'bull' : btcPrice < btcSma50 && btcEma9 < btcEma21 ? 'bear' : 'flat';
      }
    }
    
    console.log(`Fear & Greed index: ${fearGreed || 'N/A'} | Market Regime: ${marketRegime}`);
    
    for (const d of all) {
      const asset = d.asset;
      if (!asset) continue;
      
      const opts = { 
        highs: d.highs, 
        lows: d.lows, 
        closes4H: d.closes4H, 
        volumes: d.volumes, 
        fearGreed: fearGreed, 
        symbol: asset.symbol || asset.id, 
        marketRegime, 
        marketCap: d.marketCap, 
        tvl: d.tvl 
      };

      const result = asset.isMoonshot ? Signals.generateBreakout(d.closes, opts) : Signals.generate(d.closes, opts);
      const price = d.price || d.closes[d.closes.length - 1];

      const owned = !!portfolio[asset.symbol];
      const alertKey = owned ? `${result.signal}|owned` : result.signal;
      const alreadyAlerted = lastAlerted[asset.symbol] === alertKey;

      let message = null;
      let tweetMessage = null;
      let tweetCardOpts = null;
      let stopText = '';
      const winnerTier = result.winnerTier ?? 'none';
      if (result.stopSuggest) {
        const ss = result.stopSuggest;
        stopText = `

🎯 Single Target exit plan
🛑 Stop Loss (100%): $${ss.stopPrice} (-${ss.distancePct}%)
✅ Take Profit (100%): $${ss.takeProfitPrice} (+${ss.takeProfitPct || ss.bankTakeProfitPct}%)
⏳ Time stop: Exit at market on Day ${ss.holdLimitDays || CONFIG.exits?.holdLimitDays || 7} if neither order fills
⚠️ Place OCO on Binance at entry (Price = TP, Stop = SL, Limit = SL × 0.998).`;
      }

      if (result.signal === 'STRONG_BUY') {
        const tierLabel = winnerTier === 'core' ? 'Core Winner' : winnerTier === 'probation' ? 'Probation Winner' : 'Watchlist';
        const binanceLink = `https://www.binance.com/en/trade/${asset.symbol}_USDT?type=spot&ref=TRENDRUNNER`;
        message = `🟢 STRONG BUY ALERT: ${asset.symbol} (${tierLabel})
Score: +${result.score}
Price: $${price.toFixed(4)}

${result.recommendation}${stopText}

🔗 Trade on Binance: ${binanceLink}

If you buy this, reply /buy ${asset.symbol}`;
        
        // Public X: only trusted core S.BUY (matches live Strong Buy gates)
        const confGate = CONFIG.signals?.strongConfidenceGate ?? CONFIG.refresh?.strongConfidenceGate ?? 100;
        const tweetOk =
          winnerTier === 'core' &&
          Number(result.confidence) >= confGate &&
          !result.regimeBlocked &&
          !result.greedBlocked &&
          !result.coreOnlyFiltered;
        if (tweetOk) {
          const cleanSymbol = String(asset.symbol || '').replace(/USDT$/i, '');
          const holdDays = result.stopSuggest?.holdLimitDays || CONFIG.exits?.holdLimitDays || 7;
          const tpPct = result.stopSuggest?.takeProfitPct || CONFIG.exits?.takeProfitPct || 10;
          tweetMessage = buildStrongBuyTweet({
            cleanSymbol,
            score: result.score,
            confidence: result.confidence,
            price,
            tpPct,
            holdDays,
          });
          tweetCardOpts = tweetCardOptsFromScan(asset, result, d, price);
        }
      } else if (result.signal === 'STRONG_SELL' && owned) {
        const binanceLink = `https://www.binance.com/en/trade/${asset.symbol}_USDT?type=spot&ref=TRENDRUNNER`;
        message = `🔴 STRONG SELL ALERT: ${asset.symbol}
Score: ${result.score}
Price: $${price.toFixed(4)}

The indicators have crashed into a Strong Sell. Cut losses or exit your position.

🔗 Sell on Binance: ${binanceLink}

If you sell, reply /sell ${asset.symbol}`;
      }

      
      if (result.signal === 'STRONG_BUY') strongBuyCount++;
      const confGate = CONFIG.signals?.strongConfidenceGate ?? 100;
      const watchFloor = CONFIG.signals?.watchScoreFloor ?? 3.5;
      const conf = Number(result.confidence) || 0;
      const score = Number(result.score) || 0;
      // Watch = full indicator agreement and close to the S.BUY score floor — not a generic BUY.
      if (!asset.isMoonshot && conf >= confGate && score >= watchFloor) {
        watchCount++;
        const sym = String(asset.symbol || '').replace(/USDT$/i, '');
        if (!topWatch || score > topWatch.score) {
          topWatch = {
            symbol: sym,
            score,
            confidence: conf,
            cardOpts: tweetCardOptsFromScan(asset, result, d, price),
          };
        }
      }
      
      if (message && !alreadyAlerted) {
        if (typeof bot !== 'undefined' && bot) {
          bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(err => console.error('Send failed:', err.message));
        }
        
        // --- TWITTER: STRONG_BUY alerts (priority over daily/heartbeat) ---
        if (tweetMessage && twitterClient) {
          const now = Date.now();
          const timeSinceCoin = now - (twitterState.coins[asset.symbol] || 0);

          if (twCanPostGlobal(now) && timeSinceCoin > TW_FORTY_EIGHT_HOURS) {
            const prevGlobal = twitterState.lastGlobalTweet || 0;
            twitterState.lastGlobalTweet = now;
            twitterState.coins[asset.symbol] = now;
            const cardPng = tweetCardOpts ? renderTweetCardPng(tweetCardOpts) : null;
            const ok = await postTweet(tweetMessage, `STRONG BUY ${asset.symbol}`, {
              withImage: true,
              mediaBuffer: cardPng,
            });
            if (ok) {
              alertPostedThisScan = true;
              saveTwitterState(twitterState);
            } else {
              delete twitterState.coins[asset.symbol];
              twitterState.lastGlobalTweet = prevGlobal;
            }
          } else {
            console.log(`⏭️ Skipped tweet for ${asset.symbol} due to rate limiting.`);
          }
        }

        lastAlerted[asset.symbol] = alertKey;
        saveAlertState(lastAlerted);
      } else if (!message) {
        delete lastAlerted[asset.symbol];
        saveAlertState(lastAlerted);
      }
    }

    // Cadence: alert > daily summary (24h) > heartbeat (12h idle). Global 2h gap between any posts.
    // Only mark timers AFTER a successful post — failed tweets used to look "already sent".
    if (twitterClient && !alertPostedThisScan && twCanPostGlobal()) {
      const now = Date.now();
      const sinceDaily = now - (twitterState.lastDailySummary || 0);
      const sinceHeartbeat = now - (twitterState.lastHeartbeat || 0);
      const sinceAny = now - (twitterState.lastGlobalTweet || 0);

      if (sinceDaily >= TW_DAY_MS) {
        const textDaily = buildDailySummaryTweet({
          fearGreed,
          marketRegime,
          strongBuyCount,
          watchCount,
          topWatch,
        });
        if (textDaily === twitterState.lastPulseLine) {
          console.log('🐦 Skipping duplicate market pulse (same watch line as last post).');
          twitterState.lastDailySummary = now;
          saveTwitterState(twitterState);
        } else {
          const pulsePng = topWatch?.cardOpts ? renderTweetCardPng(topWatch.cardOpts) : null;
          const ok = await postTweet(textDaily, 'daily summary', {
            withImage: true,
            mediaBuffer: pulsePng,
          });
          if (ok) {
            twitterState.lastGlobalTweet = now;
            twitterState.lastDailySummary = now;
            twitterState.lastPulseLine = textDaily;
            saveTwitterState(twitterState);
          } else {
            console.warn('🐦 Daily summary failed — will retry next scan.');
          }
        }
      } else if (
        sinceHeartbeat >= TW_TWELVE_HOURS &&
        sinceDaily >= TW_TWELVE_HOURS &&
        sinceAny >= TW_TWELVE_HOURS
      ) {
        const textBeat = buildHeartbeatTweet({ fearGreed, marketRegime });
        const ok = await postTweet(textBeat, 'heartbeat');
        if (ok) {
          twitterState.lastGlobalTweet = now;
          twitterState.lastHeartbeat = now;
          saveTwitterState(twitterState);
        } else {
          console.warn('🐦 Heartbeat failed — will retry next scan.');
        }
      }
    }
  } catch (err) {
    console.error('Fatal error during scanMarket:', err);
    // Still try a lean daily/heartbeat so X doesn't go silent when Binance scan fails.
    try {
      if (twitterClient && twCanPostGlobal()) {
        const now = Date.now();
        const sinceDaily = now - (twitterState.lastDailySummary || 0);
        if (sinceDaily >= TW_DAY_MS) {
          const textDaily = buildDailySummaryTweet({
            fearGreed: undefined,
            marketRegime: 'unknown',
            strongBuyCount: 0,
            watchCount: 0,
            topWatch: null,
          });
          const ok = await postTweet(textDaily, 'daily summary (scan-failed fallback)', { withImage: true });
          if (ok) {
            twitterState.lastGlobalTweet = now;
            twitterState.lastDailySummary = now;
            saveTwitterState(twitterState);
          }
        }
      }
    } catch (twErr) {
      console.warn('🐦 Fallback daily tweet failed:', twErr?.message || twErr);
    }
  } finally {
    // Restore full asset list so later scans / modules are not permanently trimmed
    if (typeof fullUniverse !== 'undefined' && Array.isArray(fullUniverse) && fullUniverse.length) {
      CONFIG.assets.crypto = fullUniverse;
    }
    scanInProgress = false;
    console.log('Scan complete.');
  }
}

// Red Bar ENTER must reach Telegram without staring at the desk.
// ~30s worker scan backs up the open-tab relay; brief Trade 1/2 windows need this.
const REDBAR_SCAN_MS = Number(process.env.REDBAR_SCAN_MS) || 30000;
const LEGACY_SCAN_MS = 3600000;
const scanEveryMs = CONFIG.ui?.redBarOnly ? REDBAR_SCAN_MS : LEGACY_SCAN_MS;
setInterval(scanMarket, scanEveryMs);
console.log(`[Bot] Scan interval ${scanEveryMs / 1000}s (redBarOnly=${Boolean(CONFIG.ui?.redBarOnly)})`);
console.log(
  `[RedBarBot] worker Telegram=${envTrim('REDBAR_BOT_INSTRUMENTS') || 'NIFTY'} · Dhan auto=${envTrim('DHAN_AUTO_INSTRUMENTS') || 'NIFTY'} · DHAN_AUTO_TRADE=${process.env.DHAN_AUTO_TRADE || 'false'} · Binance auto=${process.env.REDBAR_AUTO_TRADE || 'false'}`,
);

// Delay first scan so Render restarts do not immediately re-trigger a Binance 418 ban
setTimeout(scanMarket, 15000);

// After 1:1 TP fills → move exchange STOP_MARKET to breakeven (complete two-leg manage)
const MANAGE_POLL_MS = Math.max(5000, Number(process.env.REDBAR_MANAGE_POLL_MS) || 8000);
setInterval(() => {
  pollManagedFuturesStops().catch((e) => console.warn('[RedBarBot] manage poll:', e.message));
  pollManagedDhanStops().catch((e) => console.warn('[RedBarBot] Dhan manage poll:', e.message));
}, MANAGE_POLL_MS);
setTimeout(() => {
  pollManagedFuturesStops().catch(() => {});
  pollManagedDhanStops().catch(() => {});
}, 25000);

// ─── New listing announcements (alert only — never auto-buy) ─────────────────
const LISTINGS_STATE_FILE = 'listings_seen.json';
function loadListingsSeen() {
  try {
    if (!fs.existsSync(LISTINGS_STATE_FILE)) return { ids: {} };
    return JSON.parse(fs.readFileSync(LISTINGS_STATE_FILE, 'utf8')) || { ids: {} };
  } catch {
    return { ids: {} };
  }
}
function saveListingsSeen(state) {
  try {
    fs.writeFileSync(LISTINGS_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[Listings] Could not save state:', e.message);
  }
}

async function pollNewListings() {
  if (CONFIG.listings?.enabled === false || CONFIG.ui?.redBarOnly) return;
  if (String(process.env.LISTINGS_ALERTS || 'true').toLowerCase() === 'false') return;
  if (!bot || !chatId) return;
  try {
    const articles = await API.getListingAnnouncements({ pageSize: 10 });
    if (!articles || !articles.length) return;
    const state = loadListingsSeen();
    const known = state.ids || {};
    const firstRun = Object.keys(known).length === 0;
    const fresh = articles.filter(a => a.id != null && !known[a.id]);
    articles.forEach(a => { if (a.id != null) known[a.id] = Date.now(); });
    state.ids = known;
    saveListingsSeen(state);
    if (firstRun) {
      console.log(`[Listings] Baseline saved (${articles.length} articles). Next new ones will alert.`);
      return;
    }
    for (const a of fresh.slice(0, 5).reverse()) {
      const text = `📢 *Binance listing / listing-related*\n${a.title}\n${a.url}\n\n⚠️ Research only — *not* auto-buy. Use OCO or a trailing stop if you trade it.`;
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: false });
    }
    if (fresh.length) console.log(`[Listings] Alerted ${Math.min(fresh.length, 5)} new article(s).`);
  } catch (e) {
    console.warn('[Listings] Poll failed:', e.message);
  }
}

setInterval(pollNewListings, 5 * 60 * 1000);
setTimeout(pollNewListings, 45000);

// --- Cloud Keep-Alive + owner click-to-trade API ---
if (!process.env.BOT_WORKER_ONLY) {
  const express = require('express');
  const { createBinanceTrade, isTradeConfigured, env: tradeEnv } = require('./js/binance_trade.js');
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  const ALLOWED_ORIGINS = new Set([
    'https://trendrunner.app',
    'https://www.trendrunner.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5500',
    'null', // file:// or some sandboxed previews
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.has(origin) || !origin) {
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TrendRunner-Trade-Secret, X-TrendRunner-Alert-Secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/', (req, res) => res.send('Bot is running.'));
  app.get('/health', (req, res) => res.status(200).json({
    status: 'ok',
    alerts: Boolean(token && chatId),
    relay: true,
  }));

  // Proxy Dhan OHLC for browser desk (NIFTY, BANKNIFTY, SENSEX, CRUDEOIL, NG)
  app.get('/api/dhan/ohlc', async (req, res) => {
    try {
      const securityId = String(req.query.securityId || '').trim();
      const exchangeSegment = String(req.query.exchangeSegment || 'IDX_I').trim();
      const instrument = String(req.query.instrument || 'INDEX').trim();
      const interval = String(req.query.interval || '15m').trim();
      const limit = Math.min(600, Math.max(10, Number(req.query.limit) || 260));
      if (!securityId) {
        return res.status(400).json({ ok: false, error: 'securityId required' });
      }
      const { createDhanClient, isDhanConfigured } = require('./js/dhan_client.js');
      if (!isDhanConfigured()) {
        return res.status(503).json({ ok: false, error: 'Dhan credentials not configured on server' });
      }
      const dhan = createDhanClient();
      const rows = await dhan.getKlines({
        securityId,
        exchangeSegment,
        instrument,
        interval,
        limit,
      });
      return res.json({
        ok: true,
        rows: Array.isArray(rows) ? rows : [],
        meta: { feed: 'dhan', unit: 'INR', securityId, exchangeSegment, instrument },
      });
    } catch (e) {
      console.warn('[DhanProxy] /api/dhan/ohlc failed:', e.message);
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Desk → Telegram when PWA sees ENTER (brief Trade 1/2 must not wait for scan)
  const relaySeen = new Map();
  const RELAY_TTL_MS = 4 * 60 * 60 * 1000;
  const escHtmlRelay = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  app.post('/api/alerts/redbar', async (req, res) => {
    if (!bot || !chatId) {
      return res.status(503).json({ ok: false, error: 'Telegram not configured' });
    }
    const alertSecret = (process.env.ALERT_RELAY_SECRET || '').trim();
    if (alertSecret) {
      const got = req.headers['x-trendrunner-alert-secret'] || req.body?.secret || '';
      if (got !== alertSecret) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }
    const body = req.body || {};
    const side = String(body.side || '').toUpperCase();
    const setupKind = String(body.setupKind || '');
    const instrumentId = String(body.instrumentId || body.label || 'BTC');
    const dayKey = String(body.dayKey || '');
    const actionable = Array.isArray(RedBarTrend.ACTIONABLE_SETUPS)
      ? RedBarTrend.ACTIONABLE_SETUPS
      : ['trade1_departure', 'trade2_confirmed', 'session_sweep'];
    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({ ok: false, error: 'bad side' });
    }
    if (!actionable.includes(setupKind)) {
      return res.status(400).json({ ok: false, error: 'not actionable' });
    }
    const triggerTs = Number(body.triggerTs) || Date.now();
    const trigBucket = Math.floor(triggerTs / (20 * 60 * 1000));
    const scannerKey = `${side}|${setupKind}|${dayKey}|${trigBucket}`;
    const alertKey = `RB_${instrumentId}|${scannerKey}`;

    const allowed = (envTrim('REDBAR_BOT_INSTRUMENTS') || 'NIFTY').split(',').map((s) => s.trim().toUpperCase());
    if (!allowed.includes(String(instrumentId).toUpperCase())) {
      return res.json({ ok: true, ignored: true });
    }

    // EMA is chart context only — relays are never blocked on it.
    const now = Date.now();
    for (const [k, t] of relaySeen) {
      if (now - t > RELAY_TTL_MS) relaySeen.delete(k);
    }
    if (relaySeen.has(alertKey) || _rbAlertSeen(instrumentId, scannerKey)) {
      return res.json({ ok: true, deduped: true });
    }
    const label = body.label || instrumentId;
    const emoji = side === 'LONG' ? '🟢' : '🔴';
    const setupLabel = TrendRunnerCopy.setupName(setupKind || body.title);
    const setupTip = TrendRunnerCopy.setupTip(setupKind || body.title);
    const deskUrl = envTrim('DESK_URL') || 'https://trendrunner.app';
    const relaySym = String(instrumentId).toUpperCase() === 'BTC' ? '$' : '₹';
    const text =
      `${emoji} <b>${escHtmlRelay(TrendRunnerCopy.enterHeadline(label, side))}</b>\n` +
      `<b>${escHtmlRelay(setupLabel)}</b>\n` +
      (setupTip ? `${escHtmlRelay(setupTip)}\n` : '') +
      `Entry <b>${relaySym}${escHtmlRelay(body.price ?? '—')}</b> · Stop <b>${relaySym}${escHtmlRelay(body.stop ?? '—')}</b> · 1:1 bank <b>${relaySym}${escHtmlRelay(body.tp1 ?? '—')}</b>\n` +
      `Plan: bank ~50% at 1:1 → move stop to cost · trail the rest\n` +
      `<a href="${deskUrl}">Open TrendRunner Desk</a>`;
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
      relaySeen.set(alertKey, now);
      _rbAlertMark(instrumentId, scannerKey);
      console.log(`[AlertRelay] Telegram sent ${alertKey}`);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[AlertRelay] Telegram failed:', e.message);
      return res.status(502).json({ ok: false, error: e.message });
    }
  });

  const TRADE_SECRET = tradeEnv('TRADE_API_SECRET');
  const TRADE_MAX_USDT = Math.max(5, Number(tradeEnv('TRADE_MAX_USDT', '50')) || 50);
  const TRADE_DEFAULT_TRAIL = Math.min(10, Math.max(0.1, Number(tradeEnv('TRADE_DEFAULT_TRAIL_PCT', '2')) || 2));
  let lastTradeAt = 0;

  function requireTradeSecret(req, res) {
    if (!TRADE_SECRET) {
      res.status(503).json({ ok: false, error: 'TRADE_API_SECRET not set on server' });
      return false;
    }
    const got = req.headers['x-trendrunner-trade-secret'] || req.query.secret || '';
    if (got !== TRADE_SECRET) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  function getTrader() {
    return createBinanceTrade();
  }

  app.get('/api/trade/status', (req, res) => {
    const enabled = String(process.env.TRADE_ENABLED || '').toLowerCase() === 'true';
    const keysOk = Boolean(tradeEnv('BINANCE_API_KEY') && tradeEnv('BINANCE_API_SECRET'));
    res.json({
      ok: true,
      tradeEnabled: enabled && keysOk && Boolean(TRADE_SECRET),
      keysConfigured: keysOk,
      secretConfigured: Boolean(TRADE_SECRET),
      maxUsdt: TRADE_MAX_USDT,
      defaultTrailPct: TRADE_DEFAULT_TRAIL,
      takeProfitPct: CONFIG.exits?.takeProfitPct ?? 10,
      partialPct: CONFIG.exits?.partialPct ?? 50,
    });
  });

  app.get('/api/trade/balances', async (req, res) => {
    if (!requireTradeSecret(req, res)) return;
    if (!isTradeConfigured() && !(tradeEnv('BINANCE_API_KEY') && tradeEnv('BINANCE_API_SECRET'))) {
      return res.status(503).json({ ok: false, error: 'Binance keys not configured' });
    }
    try {
      const trader = getTrader();
      const data = await trader.getBalances({ minUsdt: 1 });
      // Enrich with rough USDT value via public ticker when possible
      const balances = [];
      for (const b of data.balances) {
        const total = b.free + b.locked;
        let usdtValue = null;
        if (b.asset === 'USDT' || b.asset === 'FDUSD' || b.asset === 'USDC') {
          usdtValue = total;
        } else {
          try {
            const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${b.asset}USDT`, { cache: 'no-store' });
            const j = await t.json();
            const px = parseFloat(j.price);
            if (Number.isFinite(px)) usdtValue = total * px;
          } catch (_) { /* ignore */ }
        }
        if (usdtValue != null && usdtValue < 1) continue;
        balances.push({ ...b, total, usdtValue });
      }
      balances.sort((a, b) => (b.usdtValue || 0) - (a.usdtValue || 0));
      res.json({ ok: true, balances, updateTime: data.updateTime });
    } catch (e) {
      console.error('[Trade] balances error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/trade/trades', async (req, res) => {
    if (!requireTradeSecret(req, res)) return;
    try {
      const symbol = String(req.query.symbol || '').toUpperCase();
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const pair = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
      const trader = getTrader();
      const trades = await trader.getMyTrades(pair, Math.min(100, Number(req.query.limit) || 40));
      res.json({ ok: true, symbol: pair, trades });
    } catch (e) {
      console.error('[Trade] trades error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/trade/open-orders', async (req, res) => {
    if (!requireTradeSecret(req, res)) return;
    try {
      const trader = getTrader();
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
      const pair = symbol ? (symbol.endsWith('USDT') ? symbol : `${symbol}USDT`) : undefined;
      const orders = await trader.getOpenOrders(pair);
      res.json({ ok: true, orders });
    } catch (e) {
      console.error('[Trade] open-orders error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/trade/buy-with-exits', async (req, res) => {
    if (!requireTradeSecret(req, res)) return;
    if (String(process.env.TRADE_ENABLED || '').toLowerCase() !== 'true') {
      return res.status(503).json({ ok: false, error: 'TRADE_ENABLED is not true' });
    }
    if (!tradeEnv('BINANCE_API_KEY') || !tradeEnv('BINANCE_API_SECRET')) {
      return res.status(503).json({ ok: false, error: 'Binance API keys missing' });
    }

    const now = Date.now();
    if (now - lastTradeAt < 5000) {
      return res.status(429).json({ ok: false, error: 'Rate limit: wait a few seconds between buys' });
    }

    let symbol = String(req.body?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    if (!symbol.endsWith('USDT')) symbol = `${symbol}USDT`;

    let quoteUsdt = Number(req.body?.quoteUsdt);
    if (!Number.isFinite(quoteUsdt) || quoteUsdt <= 0) {
      return res.status(400).json({ ok: false, error: 'quoteUsdt must be a positive number' });
    }
    if (quoteUsdt > TRADE_MAX_USDT) quoteUsdt = TRADE_MAX_USDT;

    let callbackRate = Number(req.body?.callbackRate);
    if (!Number.isFinite(callbackRate)) callbackRate = TRADE_DEFAULT_TRAIL;
    callbackRate = Math.min(10, Math.max(0.1, callbackRate));

    const takeProfitPct = Number(req.body?.takeProfitPct) || (CONFIG.exits?.takeProfitPct ?? 10);
    const partialPct = Number(req.body?.partialPct) || (CONFIG.exits?.partialPct ?? 50);

    lastTradeAt = now;
    try {
      const trader = getTrader();
      console.log(`[Trade] buy-with-exits ${symbol} $${quoteUsdt} trail=${callbackRate}% tp=${takeProfitPct}% bank=${partialPct}%`);
      const result = await trader.buyWithFiftyFiftyExits({
        symbol,
        quoteUsdt,
        takeProfitPct,
        partialPct,
        callbackRate,
      });

      console.log(`[Trade] result ok=${result.ok} buy=${result.buy?.orderId} bank=${result.bank?.orderId} trail=${result.trail?.orderId} warn=${(result.warnings || []).join('|')}`);

      if (result.buy?.executedQty > 0 && (result.bankError || result.trailError) && bot && chatId) {
        const warn = `⚠️ *Click-trade partial*\nBought ${symbol} but exits incomplete:\n${(result.warnings || []).join('\n')}\nSet stops manually on Binance.`;
        bot.sendMessage(chatId, warn, { parse_mode: 'Markdown' }).catch(() => {});
      }

      const status = result.ok ? 200 : (result.buy?.executedQty > 0 ? 207 : 500);
      res.status(status).json({
        ok: result.ok,
        symbol: result.symbol || symbol,
        buy: result.buy ? {
          orderId: result.buy.orderId,
          executedQty: result.buy.executedQty,
          avgPrice: result.buy.avgPrice,
          cumQuote: result.buy.cumQuote,
        } : null,
        bank: result.bank ? {
          orderId: result.bank.orderId,
          quantity: result.bank.quantity,
          price: result.bank.price,
        } : null,
        trail: result.trail ? {
          orderId: result.trail.orderId,
          quantity: result.trail.quantity,
          callbackRate: result.trail.callbackRate,
        } : null,
        takeProfitPct,
        partialPct,
        callbackRate,
        tpPrice: result.tpPrice,
        warnings: result.warnings || [],
        error: result.error || null,
      });
    } catch (e) {
      console.error('[Trade] buy-with-exits error:', e.message, e.binanceBody || '');
      lastTradeAt = 0; // allow retry on hard failure before buy
      res.status(500).json({ ok: false, error: e.message, binanceCode: e.binanceCode });
    }
  });

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));
  server.on('error', error => console.error(`[Server] Failed to bind port ${PORT}: ${error.message}`));
}
