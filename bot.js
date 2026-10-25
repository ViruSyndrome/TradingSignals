require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');

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

global.CONFIG = CONFIG;
global.Indicators = Indicators; // signals.js references Indicators as a global
global.RedBarTrend = RedBarTrend;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
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
  // Boot ping at most once per 6h so Render redeploys / free-tier wakeups don't spam the chat.
  // Real ENTER alerts are separate (scan + desk relay).
  const BOOT_PING_FILE = 'telegram_boot_ping.json';
  let allowBootPing = true;
  try {
    if (fs.existsSync(BOOT_PING_FILE)) {
      const prev = JSON.parse(fs.readFileSync(BOOT_PING_FILE, 'utf8'));
      if (prev?.at && Date.now() - Number(prev.at) < 6 * 60 * 60 * 1000) allowBootPing = false;
    }
  } catch (_) {}
  if (allowBootPing) {
    bot.sendMessage(
      chatId,
      '🟥 Red Bar bot online — ENTER alerts only (Trade 1 / 2 / sweep). Quiet restarts will not re-ping for 6h.',
      { disable_notification: true }
    ).then(() => {
      try { fs.writeFileSync(BOOT_PING_FILE, JSON.stringify({ at: Date.now() })); } catch (_) {}
      console.log('[Telegram] Boot ping sent');
    }).catch((err) => {
      console.error('[Telegram] Boot ping FAILED — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID:', err.message);
    });
  } else {
    console.log('[Telegram] Boot ping skipped (already sent within 6h)');
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

/** Marketing/SEO STRONG_BUY copy — no raw https:// (403 on this app); plain trendrunner.app + hashtags. */
function buildStrongBuyTweet({ cleanSymbol, score, confidence, price, tpPct, holdDays }) {
  const stamp = new Date().toISOString().slice(11, 16);
  const priceStr = price >= 1 ? price.toFixed(2) : price.toFixed(4);
  const variants = [
    `🚨 ALGORITHMIC ALERT: $${cleanSymbol} just triggered a STRONG BUY on the daily timeframe!

📈 Algo Confluence: +${score}
🎯 Confidence: ${confidence}%
💵 Price: $${priceStr}

Get exact Stop-Loss, Take-Profit (+${tpPct}%), & ${holdDays}-Day hold limits free on TrendRunner 👇

#CryptoTrading #${cleanSymbol} #TradingSignals #AlgoTrading
trendrunner.app
[${stamp}]`,
    `🚨 $${cleanSymbol} STRONG BUY signal locked in (daily chart)

📈 Score +${score} · 🎯 ${confidence}% confidence · $${priceStr}
SL / TP (+${tpPct}%) / ${holdDays}-day max hold — mapped inside TrendRunner

Free algorithmic setups → trendrunner.app

#CryptoTrading #${cleanSymbol} #TradingSignals
[${stamp}]`,
    `⚡ TrendRunner alert: $${cleanSymbol} flipped STRONG BUY on the daily

Confluence +${score} | Confidence ${confidence}% | $${priceStr}
Stops, +${tpPct}% targets & ${holdDays}-day time limit on the dashboard 👇

#Crypto #${cleanSymbol} #CryptoTrading #TradingSignals
trendrunner.app · ${stamp}`,
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
    setupLine = `${strongBuyCount} core STRONG BUY setup(s) this scan — lead: $${topWatch.symbol} (${scoreStr(topWatch.score)}, ${topWatch.confidence}%).`;
  } else if (watchCount > 0 && topWatch) {
    setupLine = `No STRONG BUYs yet. ${watchCount} high-conf watch(es) (≥100% / score ≥3.5) — $${topWatch.symbol} (${scoreStr(topWatch.score)}, ${topWatch.confidence}%).`;
  } else {
    setupLine = 'No 100%-confidence setups near S.BUY this pass — scanner staying selective.';
  }
  return `📊 TrendRunner market pulse · ${stamp}

Regime: ${marketRegime} · Fear & Greed: ${fg}
${setupLine}

Live signals, SL/TP & hold limits → trendrunner.app
#CryptoTrading #TradingSignals #AlgoTrading`;
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
  return `🐦 TrendRunner is scanning 24/7 for algorithmic STRONG BUY setups.

Regime: ${marketRegime} · Fear & Greed: ${fg}
Core winners only · free SL/TP on the dashboard

trendrunner.app
#CryptoTrading #TradingSignals · ${stamp}`;
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
  if (inst.feed === 'yahoo') {
    return API.getYahooOHLC(inst.symbol, interval, limit);
  }
  if (inst.feed === 'binanceFutures') {
    try {
      return await API.getFuturesOHLC(inst.symbol, interval, limit);
    } catch (e) {
      if (inst.fallbackSymbol) return API.getBinanceKlines(inst.fallbackSymbol, interval, limit);
      throw e;
    }
  }
  return API.getBinanceKlines(inst.symbol, interval, limit);
}

async function _scanOneRedBarInstrument(inst, rbCfg) {
  const workTf = rbCfg.workingTf || '15m';
  const rawPair = await _withTimeout(
    Promise.all([
      _deskBars(inst, workTf, 500),
      _deskBars(inst, '1h', 220),
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
  const bars1h = toBars(rawPair[1]);
  if (!barsWork || barsWork.length < 40) {
    console.warn(`[RedBarBot] ${inst.id}: not enough bars (${barsWork?.length || 0})`);
    return;
  }
  const lastT = barsWork[barsWork.length - 1].t;
  const calDay = RedBarTrend.dayKey(lastT, inst.dayMode || rbCfg.dayMode || 'ist');
  const firstRed1h = bars1h && bars1h.length >= 24
    ? RedBarTrend.firstRedBarOfSession(bars1h, calDay, { ...rbCfg, ...inst, asOfTs: lastT, barMs: 3600000 })
    : null;
  const readout = RedBarTrend.readAt(barsWork, barsWork.length - 1, {
    ...rbCfg,
    ...inst,
    firstRed1h,
    bars1h,
  });
  if (!readout) return;
  const side = readout.trend === 'bullish' ? 'LONG' : readout.trend === 'bearish' ? 'SHORT' : 'WAIT';
  const setupKind = readout.setupKind || 'wait';
  const actionState = readout.actionState || 'wait';
  const alertKey = `${side}|${setupKind}|${readout.asOfDay || ''}`;
  const alreadyAlerted = lastAlerted[`RB_${inst.id}`] === alertKey;

  console.log(
    `[RedBarBot] ${inst.id} (${inst.symbol}): state=${actionState.toUpperCase()} (${side}) | setup=${setupKind} | price=${readout.price} | stop=${readout.invalidation} (${readout.invalidationReason || '—'}) | book=${readout.bookZone} | RR=${readout.rr != null ? readout.rr.toFixed(2) : '—'}`
  );

  const actionable = Array.isArray(RedBarTrend.ACTIONABLE_SETUPS)
    && RedBarTrend.ACTIONABLE_SETUPS.includes(setupKind);
  if (actionState === 'enter' && actionable && (side === 'LONG' || side === 'SHORT')) {
    if (alreadyAlerted) {
      console.log(`[RedBarBot] ${inst.id}: ENTER already telegram'd for ${alertKey} — skip`);
      return;
    }
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
    const futLink = `https://www.binance.com/en/futures/${inst.symbol}?ref=TRENDRUNNER`;
    const emoji = side === 'LONG' ? '🟢' : '🔴';
    const setupLabel = readout.playbook?.redSetup?.label || setupKind;
    const subject = `Red Bar ${side}: ${inst.label} · ${setupLabel}`;
    const htmlMsg = `${emoji} <b>Red Bar ${_escHtml(inst.label)} ${side}</b> · ${_escHtml(setupLabel)} (${_escHtml(setupKind)})
Entry <b>$${fmt(readout.price)}</b> · Stop <b>$${fmt(readout.invalidation)}</b> · 1:1 <b>$${fmt(readout.tp1)}</b>${sz ? ` · ${sz.recLeverage}×` : ''}
<a href="${deskUrl}">Desk</a> · <a href="${futLink}">Futures</a>`;
    const plainMsg = [
      `${inst.label} ${side} · ${setupLabel}`,
      `Entry $${fmt(readout.price)} · Stop $${fmt(readout.invalidation)} · 1:1 $${fmt(readout.tp1)}`,
      deskUrl,
    ].join('\n');

    const delivered = await deliverRedBarAlert({
      subject,
      htmlMsg,
      plainMsg,
      clickUrl: deskUrl,
    });
    if (delivered) {
      lastAlerted[`RB_${inst.id}`] = alertKey;
      saveAlertState(lastAlerted);
    } else {
      console.error(`[RedBarBot] ${inst.id}: ENTER seen but Telegram delivery failed — will retry next scan`);
    }
  } else if (actionState !== 'enter') {
    delete lastAlerted[`RB_${inst.id}`];
    saveAlertState(lastAlerted);
  }
}

async function scanRedBarDesk() {
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

// Red Bar ENTER needs ~1–2m cadence; legacy multi-coin scan stays hourly.
// Match desk refresh (~60s) so worker scan is a backup if the open-tab relay misses
const REDBAR_SCAN_MS = Number(process.env.REDBAR_SCAN_MS) || 60000;
const LEGACY_SCAN_MS = 3600000;
const scanEveryMs = CONFIG.ui?.redBarOnly ? REDBAR_SCAN_MS : LEGACY_SCAN_MS;
setInterval(scanMarket, scanEveryMs);
console.log(`[Bot] Scan interval ${scanEveryMs / 1000}s (redBarOnly=${Boolean(CONFIG.ui?.redBarOnly)})`);

// Delay first scan so Render restarts do not immediately re-trigger a Binance 418 ban
setTimeout(scanMarket, 20000);

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
    const alertKey = `RB_${instrumentId}|${side}|${setupKind}|${dayKey}`;
    const now = Date.now();
    for (const [k, t] of relaySeen) {
      if (now - t > RELAY_TTL_MS) relaySeen.delete(k);
    }
    if (relaySeen.has(alertKey)) {
      return res.json({ ok: true, deduped: true });
    }
    const label = body.label || instrumentId;
    const emoji = side === 'LONG' ? '🟢' : '🔴';
    const title = body.title || setupKind;
    const deskUrl = envTrim('DESK_URL') || 'https://trendrunner.app';
    const text =
      `${emoji} <b>Red Bar ${escHtmlRelay(label)} ${side}</b> · ${escHtmlRelay(title)} (${escHtmlRelay(setupKind)})\n` +
      `Entry <b>$${escHtmlRelay(body.price ?? '—')}</b> · Stop <b>$${escHtmlRelay(body.stop ?? '—')}</b> · 1:1 <b>$${escHtmlRelay(body.tp1 ?? '—')}</b>\n` +
      `<a href="${deskUrl}">Desk</a>`;
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
      relaySeen.set(alertKey, now);
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
