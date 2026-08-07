'use strict';

const CONFIG = {

  // ─── Assets to track ────────────────────────────────────────────────────────
  assets: {

    // Binance trading pairs (no API key needed, high rate limits)
    crypto: [
      { id: 'BTCUSDT', symbol: 'BTC', name: 'Bitcoin', currency: 'USD', icon: '₿' },
      { id: 'ETHUSDT', symbol: 'ETH', name: 'Ethereum', currency: 'USD', icon: 'Ξ' },
      { id: 'BNBUSDT', symbol: 'BNB', name: 'Binance Coin', currency: 'USD', icon: '⬡' },
      { id: 'SOLUSDT', symbol: 'SOL', name: 'Solana', currency: 'USD', icon: '◎' },
      { id: 'XRPUSDT', symbol: 'XRP', name: 'XRP', currency: 'USD', icon: '✕' },
      { id: 'ADAUSDT', symbol: 'ADA', name: 'Cardano', currency: 'USD', icon: '₳' },
      { id: 'DOGEUSDT', symbol: 'DOGE', name: 'Dogecoin', currency: 'USD', icon: '🐕' },
      { id: 'AVAXUSDT', symbol: 'AVAX', name: 'Avalanche', currency: 'USD', icon: '🔺' },
      { id: 'LINKUSDT', symbol: 'LINK', name: 'Chainlink', currency: 'USD', icon: '🔗' },
      { id: 'DOTUSDT', symbol: 'DOT', name: 'Polkadot', currency: 'USD', icon: '🟣' },
      { id: 'POLUSDT', symbol: 'POL', name: 'Polygon', currency: 'USD', icon: '♾️' },
      { id: 'SHIBUSDT', symbol: 'SHIB', name: 'Shiba Inu', currency: 'USD', icon: '🐕' },
      { id: 'LTCUSDT', symbol: 'LTC', name: 'Litecoin', currency: 'USD', icon: 'Ł' },
      { id: 'BCHUSDT', symbol: 'BCH', name: 'Bitcoin Cash', currency: 'USD', icon: '₿' },
      { id: 'ATOMUSDT', symbol: 'ATOM', name: 'Cosmos', currency: 'USD', icon: '⚛️' },
      { id: 'UNIUSDT', symbol: 'UNI', name: 'Uniswap', currency: 'USD', icon: '🦄' },
      { id: 'XLMUSDT', symbol: 'XLM', name: 'Stellar', currency: 'USD', icon: '🚀' },
      { id: 'NEARUSDT', symbol: 'NEAR', name: 'NEAR Protocol', currency: 'USD', icon: '🌌' },
      { id: 'APTUSDT', symbol: 'APT', name: 'Aptos', currency: 'USD', icon: '🌐' },
      { id: 'INJUSDT', symbol: 'INJ', name: 'Injective', currency: 'USD', icon: '🥷' },
      { id: 'RENDERUSDT', symbol: 'RENDER', name: 'Render', currency: 'USD', icon: '🎨' },
      { id: 'FETUSDT', symbol: 'FET', name: 'Fetch.ai', currency: 'USD', icon: '🤖' },
      
      // Expanded List (Top 50 additions)
      { id: 'TRXUSDT', symbol: 'TRX', name: 'TRON', currency: 'USD', icon: '🇹' },
      { id: 'SUIUSDT', symbol: 'SUI', name: 'Sui', currency: 'USD', icon: '💧' },
      { id: 'ARBUSDT', symbol: 'ARB', name: 'Arbitrum', currency: 'USD', icon: '🛡️' },
      { id: 'OPUSDT', symbol: 'OP', name: 'Optimism', currency: 'USD', icon: '🔴' },
      { id: 'PEPEUSDT', symbol: 'PEPE', name: 'Pepe', currency: 'USD', icon: '🐸' },
      { id: 'WIFUSDT', symbol: 'WIF', name: 'dogwifhat', currency: 'USD', icon: '🐶' },
      { id: 'FLOKIUSDT', symbol: 'FLOKI', name: 'FLOKI', currency: 'USD', icon: '🛡️' },
      { id: 'AAVEUSDT', symbol: 'AAVE', name: 'Aave', currency: 'USD', icon: '👻' },
      { id: 'SKYUSDT', symbol: 'SKY', name: 'Sky (Maker)', currency: 'USD', icon: '🏦' },
      { id: 'LDOUSDT', symbol: 'LDO', name: 'Lido DAO', currency: 'USD', icon: '💧' },
      { id: 'GRTUSDT', symbol: 'GRT', name: 'The Graph', currency: 'USD', icon: '📊' },
      { id: 'THETAUSDT', symbol: 'THETA', name: 'Theta Network', currency: 'USD', icon: '📺' },
      { id: 'FILUSDT', symbol: 'FIL', name: 'Filecoin', currency: 'USD', icon: '🗄️' },
      { id: 'ICPUSDT', symbol: 'ICP', name: 'Internet Computer', currency: 'USD', icon: '♾️' },
      { id: 'VETUSDT', symbol: 'VET', name: 'VeChain', currency: 'USD', icon: 'Ⓥ' },
      { id: 'EGLDUSDT', symbol: 'EGLD', name: 'MultiversX', currency: 'USD', icon: '⚡' },
      { id: 'SANDUSDT', symbol: 'SAND', name: 'The Sandbox', currency: 'USD', icon: '🏜️' },
      { id: 'MANAUSDT', symbol: 'MANA', name: 'Decentraland', currency: 'USD', icon: '🌐' },
      { id: 'GALAUSDT', symbol: 'GALA', name: 'Gala', currency: 'USD', icon: '🎮' },
      { id: 'RUNEUSDT', symbol: 'RUNE', name: 'THORChain', currency: 'USD', icon: 'ᚱ' },
      { id: 'TIAUSDT', symbol: 'TIA', name: 'Celestia', currency: 'USD', icon: '🌌' },
      { id: 'SEIUSDT', symbol: 'SEI', name: 'Sei', currency: 'USD', icon: '🌊' },
      { id: 'STXUSDT', symbol: 'STX', name: 'Stacks', currency: 'USD', icon: '🥞' },
      { id: 'TAOUSDT', symbol: 'TAO', name: 'Bittensor', currency: 'USD', icon: '🧠' }
    ],

    // Temporarily disabled due to Yahoo Finance blocking free public CORS proxies.
    indianStocks: [],
    commodities: [],
    forex: [],

    // ─── Proven winners (backtest-validated) ─────────────────────────────────
    // Assets that were profitable in the last full backtest (node backtest.js).
    // When signals.winnersOnlyBuys is true, BUY/STRONG_BUY signals on assets
    // NOT in this list are downgraded to NEUTRAL. Re-run the backtest monthly
    // and update this list — it reflects a 250-day window and WILL go stale.
    // Core trio (NEAR, INJ, TRX) survived rolling walk-forward out-of-sample;
    // LDO, TAO, UNI are marginal full-window positives kept on probation.
    coreWinners: ['NEAR', 'INJ', 'TRX'],
    probationWinners: ['LDO', 'TAO', 'UNI'],
    provenWinners: ['NEAR', 'INJ', 'TRX', 'LDO', 'TAO', 'UNI'],
  },

  // ─── Signal engine behaviour ─────────────────────────────────────────────────
  signals: {
    winnersOnlyBuys: true,   // suppress buy signals on assets outside provenWinners
    coreOnlyBuys: true,      // demote probation winners to watchlist-only in live usage
  },

  // ─── Technical indicator parameters ─────────────────────────────────────────
  indicators: {
    rsi:  { period: 14, overbought: 70, oversold: 30 },
    macd: { fast: 12,   slow: 26,       signal: 9    },
    sma:  { periods: [20, 50]                         },
    bb:   { period: 20, multiplier: 2                 },
  },

  // Signal thresholds are defined in signals.js LEVELS object.

  // ─── Data refresh & caching ─────────────────────────────────────────────────
  refresh: {
    intervalMs:  60 * 1000,    // UI refresh every 60 seconds
    cacheMs:     55 * 1000,    // cache data for 55 seconds
    historyDays: 250,          // days of OHLCV history to fetch (>=200 so SMA200 computes)
    requestDelayMs: 300,       // delay between Yahoo Finance requests
    strongConfidenceGate: 75,  // % confidence required to escalate to STRONG_BUY/SELL
  },

  // ─── API endpoints ───────────────────────────────────────────────────────────
  api: {
    // coingecko API removed — migrated to Binance
    yahooChart:   'https://query1.finance.yahoo.com/v8/finance/chart/',
    corsProxy:    'https://api.allorigins.win/raw?url=',
  },

  // ─── Market hours (IST) ─────────────────────────────────────────────────────
  marketHours: {
    nse: { open: { h: 9, m: 15 }, close: { h: 15, m: 30 }, timezone: 'Asia/Kolkata', days: [1,2,3,4,5] },
    us:  { open: { h: 19,m: 0  }, close: { h: 1,  m: 30 }, timezone: 'Asia/Kolkata', days: [1,2,3,4,5] },
    crypto: 'always',
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
