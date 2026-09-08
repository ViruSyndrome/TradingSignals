# Trading Signals

A multi-purpose cryptocurrency trading-signal platform consisting of a static web dashboard (PWA), Telegram alert bot, optional X/Twitter posts, and a cost-sensitive backtester.

Both the dashboard and the bot share a single technical analysis (TA) engine so scores and confidence match across surfaces.

## Architecture

- **`js/indicators.js`**: RSI, MACD, Bollinger, EMA, SMA, ATR
- **`js/signals.js`**: Composite scoring + OCO suggestions from `CONFIG.exits`
- **`js/config.js`**: Asset universe, winners lists, live exit policy, last-backtest badge
- **`js/dashboard.js`**: UI, Holdings paper PnL, watchlist/holdings cloud sync
- **`js/auth.js`**: Optional Supabase auth + sync of invested / watchlist / holdings meta
- **`bot.js`**: Telegram (+ optional X) hourly STRONG_BUY / owned STRONG_SELL
- **`backtest.js`**: Walk-forward / rolling / cost-sweep CLI; weekly GitHub Action refreshes winners

### Live exit policy (`CONFIG.exits`)

- Take-profit: **10%**
- Max hold: **7 days**
- Stop: **2× ATR**
- Research costs: **0.40% round-trip** (0.10% fee + 0.10% slippage per side)

Dashboard OCO copy, bots, visual backtester, and CLI all read this policy.

## Setup

### Dashboard
Serve the directory with any static host (or `npx serve .`) and open `index.html`.

### Telegram / X bot
1. `npm install`
2. Copy `.env.example` → `.env` (Telegram + optional Twitter keys)
3. Set `TELEGRAM_POLLING=true` only on the single process that should receive commands
4. `node bot.js` (or `npm start` via `server.js`)

## Validation

- Weekly GitHub Action: `node backtest.js` (updates `provenWinners` + `lastBacktest` badge)
- Monthly robustness check: `node backtest.js --walk-forward-rolling`
- Unit tests: `npm test`

## Disclaimer

**Educational purposes only.** Past backtests and paper PnL do not guarantee future results. Always place stop-loss and take-profit orders.
