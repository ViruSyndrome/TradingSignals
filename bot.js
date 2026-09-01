require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');

// Load exact same indicator math as the frontend — now via proper require()
const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');
global.CONFIG = CONFIG;
global.Indicators = Indicators; // signals.js references Indicators as a global

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

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
  bot = new TelegramBot(token, { polling: true });
  console.log("📱 Telegram bot initialized successfully.");
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
  const fearGreed = await fetchFearGreed();
  if (fearGreed !== undefined) console.log(`Fear & Greed index: ${fearGreed}`);
  
  for(const asset of CONFIG.assets.crypto) {
    try {
      const days = CONFIG.refresh.historyDays;
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${asset.id}&interval=1d&limit=${days}`);
      const data = await res.json();
      if(Array.isArray(data) && data.length > 0) {
        const closes  = data.map(r => parseFloat(r[4]));
        const highs   = data.map(r => parseFloat(r[2]));
        const lows    = data.map(r => parseFloat(r[3]));
        const volumes = data.map(r => parseFloat(r[5]));
        const result = Signals.generate(closes, { highs, lows, volumes, fearGreed, symbol: asset.symbol });
        const price = closes[closes.length - 1];

        const owned = !!portfolio[asset.symbol];
        const alertKey = owned ? `${result.signal}|owned` : result.signal;
        const alreadyAlerted = lastAlerted[asset.symbol] === alertKey;

        let message = null;
        let tweetMessage = null;
        let stopText = '';
        const winnerTier = result.winnerTier ?? 'none';
        if (result.stopSuggest) {
          stopText = `\n\n🛡️ Stop-Loss: $${result.stopSuggest.stopPrice} (-${result.stopSuggest.distancePct}%)\n🎯 Take-Profit: $${result.stopSuggest.takeProfitPrice} (+${result.stopSuggest.takeProfitPct}%)\n⚠️ Place both as real exchange orders now — this edge only works if losers are cut at the stop.`;
        }

        if (result.signal === 'STRONG_BUY') {
          const tierLabel = winnerTier === 'core' ? 'Core Winner' : winnerTier === 'probation' ? 'Probation Winner' : 'Watchlist';
          message = `🟢 STRONG BUY ALERT: ${asset.symbol} (${tierLabel})\nScore: +${result.score}\nPrice: $${price.toFixed(4)}\n\n${result.recommendation}${stopText}\n\nIf you buy this, reply /buy ${asset.symbol}`;
          
          const cleanSymbol = asset.symbol.replace('USDT','');
          tweetMessage = `🚨 ALGORITHMIC ALERT: $${cleanSymbol} just triggered a flawless STRONG BUY signal on the daily timeframe!\n\n📈 Trend Score: +${result.score}/10\n🎯 Confidence: ${result.confidence}%\n\nGet the exact Stop-Loss & Take-Profit targets free 👇\nhttps://trendrunner.app\n\n#CryptoTrading #${cleanSymbol} #TradingSignals`;
        } else if (result.signal === 'BUY') {
          message = `👀 BUY SETUP: ${asset.symbol}\nScore: +${result.score}\nPrice: $${price.toFixed(4)}\n\nIndicators are leaning bullish. Good time to research for an entry.${stopText}\n\nIf you buy this, reply /buy ${asset.symbol}`;
        } else if (result.signal === 'SELL' && owned) {
          message = `⚠️ EARLY WARNING: ${asset.symbol}\nScore: ${result.score}\nPrice: $${price.toFixed(4)}\n\nThis asset is losing momentum. If you are in profit, consider taking some off the table.`;
        } else if (result.signal === 'STRONG_SELL' && owned) {
          message = `🚨 STRONG SELL ALERT: ${asset.symbol}\nScore: ${result.score}\nPrice: $${price.toFixed(4)}\n\nThe indicators have crashed into a Strong Sell. Cut losses or exit your position.\n\nIf you sell, reply /sell ${asset.symbol}`;
        }

          if (message && !alreadyAlerted) {
          if (bot) {
            bot.sendMessage(chatId, message).catch(err => console.error('Send failed:', err.message));
          }
          
          // --- TWITTER SPAM CONTROL ---
          if (tweetMessage && twitterClient) {
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
              console.log(`🐦 Skipped tweet for ${asset.symbol} due to rate limiting (Global: ${Math.round(timeSinceGlobal/1000/60)}m ago, Coin: ${Math.round(timeSinceCoin/1000/60/60)}h ago).`);
            }
          }

          lastAlerted[asset.symbol] = alertKey;
          saveAlertState(lastAlerted);
        } else if (!message) {
          delete lastAlerted[asset.symbol];
          saveAlertState(lastAlerted);
        }
      }
    } catch (e) {
      console.error(`Error fetching ${asset.id}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('Scan complete.');
}

// Scan every 1 hour (3600000 ms)
setInterval(scanMarket, 3600000);

// Run an initial scan 5 seconds after startup
setTimeout(scanMarket, 5000);

// Send welcome message, but catch error if user hasn't clicked Start yet
if (bot) {
  bot.sendMessage(chatId, "🤖 Trade Signals Bot is now online! Scanning every 1 hour.\n\nUse /buy BTC to track a coin you own for sell alerts.\nUse /status to see your owned coins.").catch(e => {
    console.log("Could not send welcome message. User needs to click Start on Telegram first.");
  });
}


// --- Cloud Keep-Alive Server ---
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
