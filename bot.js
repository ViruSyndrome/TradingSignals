require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');

// Load exact same indicator math as the frontend — now via proper require()
const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');
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

global.CONFIG = CONFIG;
global.Indicators = Indicators; // signals.js references Indicators as a global

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
    console.log("📱 Telegram bot initialized with polling.");
  } else {
    console.log("📱 Telegram bot initialized for outbound alerts only.");
  }
} else {
  console.log("⚠️ Telegram keys missing from .env. Running in Twitter-only/Headless mode.");
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
      coins: s.coins && typeof s.coins === 'object' ? s.coins : {},
    };
  } catch {
    return { lastGlobalTweet: 0, lastDailySummary: 0, lastHeartbeat: 0, coins: {} };
  }
}
function saveTwitterState(state) {
  fs.writeFileSync(TWITTER_STATE_FILE, JSON.stringify(state, null, 2));
}
const twitterState = loadTwitterState();

function twCanPostGlobal(now = Date.now()) {
  return now - (twitterState.lastGlobalTweet || 0) > TW_TWO_HOURS;
}

/** Trader-desk STRONG_BUY copy — no https URLs (those 403 on this app). */
function buildStrongBuyTweet({ cleanSymbol, score, confidence, price, tpPct, holdDays }) {
  const stamp = new Date().toISOString().slice(11, 16);
  const priceStr = price >= 1 ? price.toFixed(2) : price.toFixed(4);
  const variants = [
    `$${cleanSymbol} just printed a Strong Buy on the daily. Score +${score}, ${confidence}% confidence at $${priceStr}. SL/TP (+${tpPct}%) and ${holdDays}d hold on TrendRunner. ${stamp}Z`,
    `Core alert: $${cleanSymbol} Strong Buy. Confluence +${score} · ${confidence}% · $${priceStr}. Check TrendRunner for stops and targets. ${stamp}Z`,
    `Desk note — $${cleanSymbol} flipped Strong Buy (daily). +${score} score, ${confidence}% conf, $${priceStr}. ${holdDays}d hold / +${tpPct}% TP on TrendRunner. ${stamp}Z`,
  ];
  const idx = Math.abs((Date.now() + (cleanSymbol.charCodeAt(0) || 0)) % variants.length);
  return variants[idx];
}

function buildDailySummaryTweet({ fearGreed, marketRegime, strongBuyCount, buyCount, topBuy }) {
  const fg = fearGreed != null ? String(fearGreed) : 'n/a';
  const stamp = new Date().toISOString().slice(0, 10);
  let setupLine;
  if (strongBuyCount > 0 && topBuy) {
    setupLine = `Core Strong Buys this scan: ${strongBuyCount}. Top: $${topBuy.symbol} (+${topBuy.score}).`;
  } else if (buyCount > 0 && topBuy) {
    setupLine = `No core Strong Buys. Soft buys: ${buyCount}. Leading: $${topBuy.symbol} (+${topBuy.score}).`;
  } else {
    setupLine = 'No core Strong Buys on this pass — staying patient.';
  }
  return `Market pulse ${stamp}
Regime: ${marketRegime} · Fear & Greed: ${fg}
${setupLine}
Alerts fire on core Strong Buys only · TrendRunner`;
}

function buildHeartbeatTweet({ fearGreed, marketRegime }) {
  const fg = fearGreed != null ? String(fearGreed) : 'n/a';
  const stamp = new Date().toISOString().slice(11, 16);
  return `TrendRunner still scanning. Regime: ${marketRegime} · F&G ${fg}. Alerts fire on core Strong Buys only. ${stamp}Z`;
}

async function postTweet(text, label = 'tweet') {
  if (!twitterClient || !text) return false;
  try {
    await twitterClient.v2.tweet(text);
    console.log(`✅ Tweeted ${label}`);
    return true;
  } catch (err) {
    const detail = err?.data?.detail || err?.data?.title || err?.message || String(err);
    const code = err?.code || err?.data?.status || '';
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

async function scanMarket() {
  if (scanInProgress) {
    console.log('Scan already running — skipping overlapping trigger.');
    return;
  }
  scanInProgress = true;
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
    let buyCount = 0;
    let strongBuyCount = 0;
    let topBuy = null; // { symbol, score }
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
      let stopText = '';
      const winnerTier = result.winnerTier ?? 'none';
      if (result.stopSuggest) {
        stopText = `

🎯 Stop-Loss: $${result.stopSuggest.stopPrice} (-${result.stopSuggest.distancePct}%)
✅ Take-Profit: $${result.stopSuggest.takeProfitPrice} (+${result.stopSuggest.takeProfitPct}%)
  ⏳ Time Limit: Max ${result.stopSuggest.holdLimitDays || CONFIG.exits?.holdLimitDays || 7} Days Hold
⚠️ Place both as real exchange orders now — this edge only works if losers are cut at the stop.`;
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
        
        const cleanSymbol = asset.symbol.replace('USDT','');
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
      if (result.signal === 'BUY' || result.signal === 'STRONG_BUY') {
        buyCount++;
        const sym = String(asset.symbol || '').replace(/USDT$/i, '');
        if (!topBuy || result.score > topBuy.score) {
          topBuy = { symbol: sym, score: result.score };
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
            const ok = await postTweet(tweetMessage, `STRONG BUY ${asset.symbol}`);
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
          buyCount,
          topBuy,
        });
        const prevGlobal = twitterState.lastGlobalTweet || 0;
        twitterState.lastGlobalTweet = now;
        twitterState.lastDailySummary = now;
        const ok = await postTweet(textDaily, 'daily summary');
        if (ok) {
          saveTwitterState(twitterState);
        } else {
          twitterState.lastGlobalTweet = prevGlobal;
          twitterState.lastDailySummary = now - sinceDaily;
        }
      } else if (
        sinceHeartbeat >= TW_TWELVE_HOURS &&
        sinceDaily >= TW_TWELVE_HOURS &&
        sinceAny >= TW_TWELVE_HOURS
      ) {
        const textBeat = buildHeartbeatTweet({ fearGreed, marketRegime });
        const prevGlobal = twitterState.lastGlobalTweet || 0;
        const prevBeat = twitterState.lastHeartbeat || 0;
        twitterState.lastGlobalTweet = now;
        twitterState.lastHeartbeat = now;
        const ok = await postTweet(textBeat, 'heartbeat');
        if (ok) {
          saveTwitterState(twitterState);
        } else {
          twitterState.lastGlobalTweet = prevGlobal;
          twitterState.lastHeartbeat = prevBeat;
        }
      }
    }
  } catch (err) {
    console.error('Fatal error during scanMarket:', err);
  } finally {
    // Restore full asset list so later scans / modules are not permanently trimmed
    if (typeof fullUniverse !== 'undefined' && Array.isArray(fullUniverse) && fullUniverse.length) {
      CONFIG.assets.crypto = fullUniverse;
    }
    scanInProgress = false;
    console.log('Scan complete.');
  }
}

// Scan every 1 hour (3600000 ms)
setInterval(scanMarket, 3600000);

// Delay first scan so Render restarts do not immediately re-trigger a Binance 418 ban
setTimeout(scanMarket, 20000);

// --- Cloud Keep-Alive Server ---
if (!process.env.BOT_WORKER_ONLY) {
  const express = require('express');
  const app = express();
  app.get('/', (req, res) => res.send('Bot is running.'));
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
  server.on('error', error => console.error(`[Server] Failed to bind port ${PORT}: ${error.message}`));
}
