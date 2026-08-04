require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');

// Load exact same indicator math as the frontend — now via proper require()
const CONFIG     = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const Signals    = require('./js/signals.js');
global.Indicators = Indicators; // signals.js references Indicators as a global

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- Portfolio Management ---
const PORTFOLIO_FILE = 'portfolio.json';
function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return {};
  return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
}
function savePortfolio(data) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2));
}

bot.onText(/\/buy (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== chatId) return;
  const symbol = match[1].toUpperCase();
  const port = loadPortfolio();
  port[symbol] = true;
  savePortfolio(port);
  bot.sendMessage(chatId, `✅ Added ${symbol} to your owned assets. I will now track this for sell signals!`);
});

bot.onText(/\/sell (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== chatId) return;
  const symbol = match[1].toUpperCase();
  const port = loadPortfolio();
  delete port[symbol];
  savePortfolio(port);
  bot.sendMessage(chatId, `❌ Removed ${symbol} from your owned assets. No more sell alerts for this.`);
});

bot.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== chatId) return;
  const port = loadPortfolio();
  const assets = Object.keys(port).join(', ') || 'None';
  const count = CONFIG.assets.crypto.length;
  bot.sendMessage(chatId, `📊 Currently scanning ${count} assets.\n\n🎒 Owned assets you are tracking for sells: ${assets}\n\nType /buy BTC to add to tracked assets.`);
});

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

async function scanMarket() {
  console.log('Scanning market...');
  const portfolio = loadPortfolio();
  
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
        const result = Signals.generate(closes, { highs, lows, volumes });
        const price = closes[closes.length - 1];

        const owned = !!portfolio[asset.symbol];
        const alertKey = owned ? `${result.signal}|owned` : result.signal;
        const alreadyAlerted = lastAlerted[asset.symbol] === alertKey;

        let message = null;
        let stopText = '';
        if (result.stopSuggest) {
          stopText = `\n\n🛡️ Stop-Loss Suggestion:\nPrice: $${result.stopSuggest.stopPrice}\nDistance: ${result.stopSuggest.distancePct}%`;
        }

        if (result.signal === 'STRONG_BUY') {
          message = `🚀 STRONG BUY ALERT: ${asset.symbol}\nScore: +${result.score}\nPrice: $${price.toFixed(4)}\n\n${result.recommendation}${stopText}\n\nIf you buy this, reply /buy ${asset.symbol}`;
        } else if (result.signal === 'BUY') {
          message = `👀 BUY SETUP: ${asset.symbol}\nScore: +${result.score}\nPrice: $${price.toFixed(4)}\n\nIndicators are leaning bullish. Good time to research for an entry.${stopText}\n\nIf you buy this, reply /buy ${asset.symbol}`;
        } else if (result.signal === 'SELL' && owned) {
          message = `⚠️ EARLY WARNING: ${asset.symbol}\nScore: ${result.score}\nPrice: $${price.toFixed(4)}\n\nThis asset is losing momentum. If you are in profit, consider taking some off the table.`;
        } else if (result.signal === 'STRONG_SELL' && owned) {
          message = `🚨 STRONG SELL ALERT: ${asset.symbol}\nScore: ${result.score}\nPrice: $${price.toFixed(4)}\n\nThe indicators have crashed into a Strong Sell. Cut losses or exit your position.\n\nIf you sell, reply /sell ${asset.symbol}`;
        }

        if (message && !alreadyAlerted) {
          bot.sendMessage(chatId, message).catch(err => console.error('Send failed:', err.message));
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
bot.sendMessage(chatId, "🤖 Trade Signals Bot is now online! Scanning every 1 hour.\n\nUse /buy BTC to track a coin you own for sell alerts.\nUse /status to see your owned coins.").catch(e => {
  console.log("Could not send welcome message. User needs to click Start on Telegram first.");
});


// --- Cloud Keep-Alive Server ---
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
