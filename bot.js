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

// Initialize Twitter Client (if keys are provided)
let twitterClient = null;
if (process.env.TWITTER_API_KEY && process.env.TWITTER_API_SECRET && process.env.TWITTER_ACCESS_TOKEN && process.env.TWITTER_ACCESS_SECRET) {
  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  }).readWrite;
  console.log("🐦 Twitter client initialized successfully.");
} else {
  console.log("⚠️ Twitter keys missing from .env, Twitter posting disabled.");
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
function loadTwitterState() {
  try { return JSON.parse(fs.readFileSync(TWITTER_STATE_FILE, 'utf8')); } catch { return { lastGlobalTweet: 0, coins: {} }; }
}
function saveTwitterState(state) {
  fs.writeFileSync(TWITTER_STATE_FILE, JSON.stringify(state, null, 2));
}
const twitterState = loadTwitterState();

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
  console.log('Scanning market...');
  const portfolio = loadPortfolio();

  // Dynamically inject user's private portfolio coins into the scanner
  for (const sym of Object.keys(portfolio)) {
    if (!CONFIG.assets.crypto.find(a => a.id === sym)) {
      CONFIG.assets.crypto.push({
        id: sym,
        symbol: sym.replace('USDT', ''),
        name: sym.replace('USDT', ''),
        currency: 'USD',
        icon: '💎'
      });
      console.log(`Dynamically added private coin ${sym} to the scan loop.`);
    }
  }

  const fearGreed = await fetchFearGreed();
  
  try {
    const crypto = await API.getAllCrypto();
    const all = [...(crypto || [])].filter(d => d.closes && d.closes.length >= 30);
    
    // --- Daily Marketing Summary ---
    let highestScoreCoin = null;
    let highestScore = -99;
    let buyCount = 0;
    
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
⚠️ Place both as real exchange orders now — this edge only works if losers are cut at the stop.`;
      }

      if (result.signal === 'STRONG_BUY') {
        const tierLabel = winnerTier === 'core' ? 'Core Winner' : winnerTier === 'probation' ? 'Probation Winner' : 'Watchlist';
        message = `🟢 STRONG BUY ALERT: ${asset.symbol} (${tierLabel})
Score: +${result.score}
Price: $${price.toFixed(4)}

${result.recommendation}${stopText}

If you buy this, reply /buy ${asset.symbol}`;
        
        const cleanSymbol = asset.symbol.replace('USDT','');
        tweetMessage = `🚨 ALGORITHMIC ALERT: $${cleanSymbol} just triggered a flawless STRONG BUY signal on the daily timeframe!

📈 Trend Score: +${result.score}/10
🎯 Confidence: ${result.confidence}%

Get the exact Stop-Loss & Take-Profit targets free 👇
https://trendrunner.app

#CryptoTrading #${cleanSymbol} #TradingSignals`;
      } else if (result.signal === 'BUY') {
        message = `🟡 BUY SETUP: ${asset.symbol}
Score: +${result.score}
Price: $${price.toFixed(4)}

Indicators are leaning bullish. Good time to research for an entry.${stopText}

If you buy this, reply /buy ${asset.symbol}`;
      } else if (result.signal === 'SELL' && owned) {
        message = `⚠️ EARLY WARNING: ${asset.symbol}
Score: ${result.score}
Price: $${price.toFixed(4)}

This asset is losing momentum. If you are in profit, consider taking some off the table.`;
      } else if (result.signal === 'STRONG_SELL' && owned) {
        message = `🔴 STRONG SELL ALERT: ${asset.symbol}
Score: ${result.score}
Price: $${price.toFixed(4)}

The indicators have crashed into a Strong Sell. Cut losses or exit your position.

If you sell, reply /sell ${asset.symbol}`;
      }

      
      // Track highest score for marketing
      if (result.score > highestScore && result.score > 5) {
        highestScore = result.score;
        highestScoreCoin = asset.symbol;
      }
      if (result.signal === 'BUY' || result.signal === 'STRONG_BUY') buyCount++;
      
      if (message && !alreadyAlerted) {
        if (typeof bot !== 'undefined' && bot) {
          bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(err => console.error('Send failed:', err.message));
        }
        
        // --- TWITTER SPAM CONTROL ---
        if (tweetMessage && typeof twitterClient !== 'undefined' && twitterClient) {
          const now = Date.now();
          const TWO_HOURS = 2 * 60 * 60 * 1000;
          const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

          const timeSinceGlobal = now - (twitterState.lastGlobalTweet || 0);
          const timeSinceCoin = now - (twitterState.coins[asset.symbol] || 0);

          if (timeSinceGlobal > TWO_HOURS && timeSinceCoin > FORTY_EIGHT_HOURS) {
            twitterClient.v2.tweet(tweetMessage).then(() => {
              console.log(`🐦 Tweeted STRONG BUY for ${asset.symbol}`);
              twitterState.lastGlobalTweet = now;
              twitterState.coins[asset.symbol] = now;
              saveTwitterState(twitterState);
            }).catch(err => {
              console.error('Twitter post failed:', err);
            });
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
  } catch (err) {
    console.error('Fatal error during scanMarket:', err);
  }
  
    // Post daily marketing summary if we haven't in 24h
    if (typeof twitterClient !== 'undefined' && twitterClient) {
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const timeSinceDaily = now - (twitterState.lastDailyTweet || 0);
      
      if (timeSinceDaily > TWENTY_FOUR_HOURS && highestScoreCoin) {
        const cleanSymbol = highestScoreCoin.replace('USDT', '');
        const dailyMsg = `📊 Daily Market Scan Complete!\n\nGreed Index: ${fearGreed}\nMarket Regime: ${marketRegime.toUpperCase()}\nActive Buy Setups: ${buyCount}\n\nTop Chart Today: ${cleanSymbol} (Score: +${highestScore})\n\nCheck the free dashboard for exact entry and stop-loss targets 👇\nhttps://trendrunner.app\n\n#Crypto #Trading #${cleanSymbol}`;
        
        twitterClient.v2.tweet(dailyMsg).then(() => {
          console.log('🐦 Tweeted Daily Marketing Summary!');
          twitterState.lastDailyTweet = now;
          saveTwitterState(twitterState);
        }).catch(e => console.error('Daily tweet failed:', e));
      }
    }
    
    console.log('Scan complete.');
}
// Scan every 1 hour (3600000 ms)
setInterval(scanMarket, 3600000);

// Run an initial scan 5 seconds after startup
setTimeout(scanMarket, 5000);

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
