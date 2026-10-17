'use strict';

const CONFIG = {

  // ─── UI mode ────────────────────────────────────────────────────────────────
  // redBarOnly: hide legacy multi-coin High Conf / tapes / moonshots (solo trader).
  ui: {
    redBarOnly: true,
  },

  // ─── Assets to track ────────────────────────────────────────────────────────
  assets: {

    // Red Bar focus: BTC only (Nifty / gold later when feeds exist)
    crypto: [
      { id: 'BTCUSDT', symbol: 'BTC', name: 'Bitcoin', currency: 'USD', icon: '₿' },
    ],

    coreWinners: ['BTC'],
    probationWinners: [],
    provenWinners: ['BTC'],
  },

  signals: {
    winnersOnlyBuys: true, // Week experiment: allow S.BUY on any tracked coin (you still only take S.BUY)
    coreOnlyBuys: true,   // Week experiment: allow probation S.BUY too
    // Hard gates (kill buys after scoring — stronger than soft dampeners)
    bearRegimeBlockBuys: true,     // No alt BUY/STRONG_BUY when BTC regime is bear
    extremeGreedBlockBuys: false,  // Soft only: F&G dampener + Research chip (no hard NEUTRAL kill)
    extremeGreedBlockAt: 75,
    // Strong Buy badge (alerts/Telegram/X) — match the rule that worked for you
    strongConfidenceGate: 100,  // all directional indicators must agree
    strongBuyMaxRsi: 40,        // require cool/low RSI for S.BUY (score floor is 4.0 in LEVELS)
    strongSellMinRsi: 60,
    // X "watch" names: full agreement and close to the S.BUY score floor (4.0)
    watchScoreFloor: 3.5,
    // Score ≥ 4 and 100% confidence. Both halves must average above 0 or the buy is withheld.
    // Older half (25 closed trades): -2.12%. Newer half (39 closed trades): +2.70%.
    expectancy: {
      allowBuys: true,
      minScore: 4,
      minConfidence: 100,
      olderAvgPct: -2.12,
      newerAvgPct: 2.70,
    },
  },

  // ─── Experimental score factors (A/B via backtest --no-smc / --smc-ablation) ─
  // Heuristics — not full institutional SMC/Wyckoff. Live defaults ON; validate with CLI.
  factors: {
    enableSmc: true,       // Liquidity sweep (+2 / +3 vol confirm)
    enableWyckoff: true,   // Spring (+1.5)
    enableVpoc: true,      // Near POC support (+1)
  },

  // ─── New listings research (watch/alert only — never auto-buy) ─────────────
  listings: {
    enabled: false, // off in Red Bar–only mode
    catalogId: 48,         // Binance CMS "New Cryptocurrency Listing"
    pollMs: 5 * 60 * 1000,
    snapshotKey: 'trading_listings_symbols_v1',
    seenArticlesKey: 'trading_listings_articles_v1',
  },

  // ─── Live exit policy (single source of truth for OCO, bots, UI, backtests) ─
  // Keep take-profit / hold-limit messaging identical everywhere.
  exits: {
    takeProfitPct: 15,      // Single Target: exit 100% at this %
    holdLimitDays: 7,       // Time stop if neither bank TP nor trail exits
    stopAtrMult: 1.5,         // Initial protective stop distance
    // Single target plan: exit 100% at TP
    partialPct: 100,
    runnerTrailAtrMult: 2,
    moveStopToBreakevenAfterPartial: true,
    feePerSide: 0.001,      // 0.10% exchange fee per side
    slippagePerSide: 0.001, // 0.10% slippage per side → 0.40% round-trip
  },

  // ─── Red Bar Desk (trend prediction) + optional EMA overlay ────────────────
  // CORE = prior-day bands + opening-range break + red-bar refs (js/redbar_trend.js).
  // EMA 10/30 is a SEPARATE overlay on the desk — not the trend engine.
  // Same map later: Nifty / gold / oil / NG once OHLC is wired.
  rangeEma: {
    enabled: true,
    symbols: ['BTCUSDT'],
    workingTf: '30m',
    timeframes: ['5m', '30m', '1h'],
    dayMode: 'utc', // crypto default; use 'ny' to align with US session day
    lookbackDays: 90,
    touchPct: 0.15,
    emaFast: 10,
    emaSlow: 30,
    ohlcLimit: { '5m': 1000, '30m': 1000, '1h': 720 },
    chartBars: { '5m': 180, '30m': 120, '1h': 96 },
    // Vertical markers on the chart X timeline (cash-session style, TZ-aware)
    showSessionMarkers: true,
    sessions: [
      { id: 'asia', label: 'Asia', timeZone: 'Asia/Tokyo', open: [9, 0], close: [15, 0], color: '#818cf8' },
      { id: 'london', label: 'London', timeZone: 'Europe/London', open: [8, 0], close: [16, 30], color: '#f472b6' },
      { id: 'ny', label: 'US', timeZone: 'America/New_York', open: [9, 30], close: [16, 0], color: '#cbd5e1' },
    ],
  },

  // ─── Dynamic Optimization Parameters ───────────────────────────────────────
  // EMA/RSI are auto-updated by the backtester parameter sweep.
  // holdLimit mirrors exits.holdLimitDays for older call sites.
  activeParams: {
    holdLimit: 7,
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14
  },

  // Public trust badge — refreshed by weekly `node backtest.js` / GitHub Action.
  lastBacktest: {
    runAt: '2026-10-11T06:31:02.654Z',
    totalRuns: 14,
    coreCount: 1,
    probationCount: 0,
    winnersTrades: 4621,
    winnersWinRate: 49.2,
    winnersAvgReturn: 1.14,
  },
  // Signal thresholds are defined in signals.js LEVELS object.

  // ─── Owner click-to-trade (Render bot; keys never in browser) ──────────────
  trade: {
    // Public Render URL of bot.js (no trailing slash). Override in localStorage trade_bot_url.
    botBaseUrl: '',
    defaultQuoteUsdt: 50,
  },

  // ─── Scanner denylist (moonshots + scalps) ─────────────────────────────────
  // Stables / fiat / gold pegs can print fake S.BUY on tiny range noise.
  scanner: {
    denyExact: [
      'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT',
      'RLUSDUSDT', 'XUSDUSDT', 'USDEUSDT', 'BFUSDUSDT', 'USD1USDT',
      'EURUSDT', 'EURIUSDT', 'AEURUSDT', 'EULUSDT',
      'XAUTUSDT', 'PAXGUSDT', // gold — not crypto momentum
    ],
    denyBases: [
      'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'RLUSD', 'XUSD', 'USDE',
      'BFUSD', 'USD1', 'EUR', 'EURI', 'AEUR', 'EUL', 'XAUT', 'PAXG',
    ],
  },

  // ─── 5m Scalper (volatile alts — pullback entries, not chase) ───────────────
  // Separate from daily core and 4H moonshots. Paper/small size only.
  scalper: {
    enabled: false, // Hidden from main UX — experimental 5m scanner kept in code
    scanIntervalMs: 2 * 60 * 1000,  // rescan every 2 minutes
    initialDelayMs: 12 * 1000,
    minQuoteVolume: 2_000_000,      // $2M+ 24h quote vol (liquidity floor)
    topVolatile: 80,                // scan top-N by daily range
    maxSetups: 8,
    minBuyScore: 4.5,
    minStrongScore: 6.0,
    requireImpulse: true,           // need recent upper-BB touch (momentum pullback)
    requireConfirmForStrong: true,  // S.BUY only on EMA retest CONFIRM
    softBearPenalty: 1.0,           // soft score hit if BTC regime bear (when passed)
    stopAtrMult: 1.2,
    takeProfitR: 2,
    maxStopPct: 1.5,                // hard cap ~1.5% stop on 5m
    holdBarsHint: 12,               // ~1 hour on 5m — time-stop mindset
  },

  // ─── Data refresh & caching ─────────────────────────────────────────────────
  refresh: {
    intervalMs:  30 * 1000,    // UI refresh every 30 seconds
    cacheMs:     25 * 1000,    // cache data for 25 seconds
    historyDays: 250,          // days of OHLCV history to fetch (>=200 so SMA200 computes)
    bootPoolLimit: 8,          // parallel OHLC workers on first paint
    bootSkip4H: true,          // first pass: 1d only (halves requests); 4H backfills after paint
    // Prefer CONFIG.signals.strongConfidenceGate (kept here for older UI readers)
    strongConfidenceGate: 100,
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
