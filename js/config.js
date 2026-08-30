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
      { id: 'TAOUSDT', symbol: 'TAO', name: 'Bittensor', currency: 'USD', icon: '🧠' },
      
      // User specific holdings / Moonshots
      { id: 'KERNELUSDT', symbol: 'KERNEL', name: 'Kernel', currency: 'USD', icon: '🚀', isMoonshot: true },
      { id: 'DASHUSDT', symbol: 'DASH', name: 'Dash', currency: 'USD', icon: '💨' }
    ],


    // ─── Proven winners (backtest-validated, last run: 26 Aug 2026) ────────────
    // Assets that were profitable in the last full backtest (node backtest.js).
    // When signals.winnersOnlyBuys is true, BUY/STRONG_BUY signals on assets
    // NOT in this list are downgraded to NEUTRAL. Re-run the backtest monthly
    // and update this list — it reflects a 250-day window and WILL go stale.
    // Core: consistently profitable with >1% avg return AND >40% win rate.
    // Probation: profitable but marginal (<1% avg return OR low win rate).
    coreWinners: ['ARB', 'ETH', 'INJ', 'LDO', 'NEAR', 'POL'],
    probationWinners: ['BTC', 'LINK', 'OP', 'RENDER', 'RUNE', 'TAO', 'THETA', 'TRX'],
    provenWinners: ['ARB', 'BTC', 'ETH', 'INJ', 'LDO', 'LINK', 'NEAR', 'OP', 'POL', 'RENDER', 'RUNE', 'TAO', 'THETA', 'TRX'],
  },

  signals: {
    winnersOnlyBuys: true, // [TEMPORARILY DISABLED BY USER] Only allow BUY/STRONG_BUY on provenWinners
    coreOnlyBuys: false,    // [TEMPORARILY DISABLED BY USER] Restrict STRONG_BUY to coreWinners only
  },

  // ─── Dynamic Optimization Parameters ───────────────────────────────────────
  // These parameters are auto-updated by the backtester parameter sweep.
  // The live dashboard reads these to adjust its mathematical engine.
  activeParams: {
    holdLimit: 3,
    emaFast: 12,
    emaSlow: 26,
    rsiPeriod: 14
  },
  // Signal thresholds are defined in signals.js LEVELS object.

  // ─── Data refresh & caching ─────────────────────────────────────────────────
  refresh: {
    intervalMs:  30 * 1000,    // UI refresh every 30 seconds
    cacheMs:     25 * 1000,    // cache data for 25 seconds
    historyDays: 250,          // days of OHLCV history to fetch (>=200 so SMA200 computes)
    strongConfidenceGate: 75,  // % confidence required to escalate to STRONG_BUY/SELL
  },

  // ─── API endpoints ───────────────────────────────────────────────────────────
  api: {
    // coingecko API removed — migrated to Binance
  },

  // ─── Market hours (IST) ─────────────────────────────────────────────────────
  marketHours: {
    nse: { open: { h: 9, m: 15 }, close: { h: 15, m: 30 }, timezone: 'Asia/Kolkata', days: [1,2,3,4,5] },
    us:  { open: { h: 19,m: 0  }, close: { h: 1,  m: 30 }, timezone: 'Asia/Kolkata', days: [1,2,3,4,5] },
    crypto: 'always',
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
