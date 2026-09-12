# TrendRunner (Trading Signals)

A multi-purpose cryptocurrency trading-signal platform: static web dashboard (PWA), Telegram alert bot, optional X/Twitter posts, and a cost-sensitive backtester.

The dashboard and bot share one technical analysis engine (`js/signals.js`) so scores and confidence match across surfaces.

## Product surfaces

| Surface | Engine | Notes |
|--------|--------|--------|
| **Daily core** | `Signals.generate` on 1d | Core/probation winners + hard gates; Strong Buy = score ≥ 4, 100% confidence, cool RSI |
| **Moonshots** | `Signals.generateBreakout` on 4H | Breakout + **CONFIRM/WAIT** timing (no chase). Shown in Moonshots tab — **not** auto-added to Watch |
| **5m Scalps** | `Signals.generateScalp` on 5m | EMA pullback after impulse; small size; **5m CONFIRM/WAIT** |
| **Holdings 🔒** | Paper tracker | Edit exact Binance entry price/time; **multiple lots**; cloud sync when signed in |
| **Watch ⭐** | User ideas only | Never means you bought it; moonshot scans do not auto-star |
| **Suggestions followed** | Signal Log | Tap **I followed this** → personal win/loss ledger + Holdings mirror |

### Live exit policy (`CONFIG.exits`)

- **50/50 plan:** bank **50%** at **+10%** TP; trail the other **50%** (~2× ATR); move stop to breakeven after bank leg
- Max hold leftovers: **7 days**
- Initial stop: **2× ATR**
- Research costs: **0.40% round-trip** (0.10% fee + 0.10% slippage per side)

Dashboard OCO copy, bots, visual backtester, and CLI all read this policy for daily trades. Moonshots use tighter stops (~5% cap); scalps use `CONFIG.scalper` (tight ATR stop, ~2R, short time-stop).

## Architecture

- **`js/indicators.js`** — RSI, MACD, Bollinger, EMA, SMA, ATR + heuristic SMC / Wyckoff / VPOC
- **`js/signals.js`** — Daily / breakout / scalp scoring + stop suggestions (`CONFIG.factors` gates)
- **`js/config.js`** — Universe, winners, exits, scalper knobs, `lastBacktest` badge
- **`js/dashboard.js`** — UI, Holdings lots, Watch, followed ledger, scanners
- **`js/auth.js`** — Optional Supabase sync (Watch / Holdings / followed ledger). Prefer `user_portfolios` table; falls back to auth metadata
- **`js/scanner.js`** — Moonshot market scan + 5m scalp scan
- **`bot.js`** — Telegram (+ optional X) alerts; optional new-listing Telegram alerts
- **`backtest.js`** — CLI validation; weekly Action refreshes daily winners
- **`scripts/fetch-coin-logos.js`** — Download missing logos into `assets/coin-logos/`
- **`supabase/portfolio.sql`** — Durable portfolio table (run once in Supabase SQL Editor)

## Setup

### Dashboard
Serve the directory with any static host (or `npx serve .`) and open `index.html`. Hard-refresh after deploys so the service worker picks up the new cache version.

**Supabase Auth → Redirect URLs** must include both (PWA `start_url` is `./index.html`):
- `https://YOUR_DOMAIN/index.html`
- `https://YOUR_DOMAIN/`

**Durable cloud sync (recommended):** in the Supabase SQL Editor, run `supabase/portfolio.sql` (the DROP POLICY/TRIGGER IF EXISTS lines are idempotent setup — they do not wipe user accounts). Until that table exists, sync still uses auth `user_metadata` as a fallback.

**After each production deploy:**
1. Confirm the Render bot redeployed on the latest `main` (X posts: core S.BUY @ ≥100% confidence only).
2. Hard-refresh the PWA (or bump is automatic via service-worker cache version).
3. Google Search Console → Sitemaps → resubmit `https://trendrunner.app/sitemap.xml`.
4. Spot-check a coin ticker hover + asset modal Trade button for referral / 10% kickback copy.

### Telegram / X bot
1. `npm install`
2. Copy `.env.example` → `.env` (Telegram + optional Twitter keys)
3. Set `TELEGRAM_POLLING=true` only on the single process that should receive commands
4. `node bot.js` (or `npm start` via `server.js`)

## Validation & backtests

| Command | Purpose | Updates live `provenWinners`? |
|---------|---------|-------------------------------|
| `node backtest.js` | Daily core engine (weekly GitHub Action) | **Yes** |
| `node backtest.js --walk-forward` / `--walk-forward-rolling` | Out-of-sample robustness | No (log only in Action) |
| `node backtest.js --cost-sweep` | Fee/slip sensitivity | No |
| `node backtest.js --entry-realism` | next_open vs signal_close fills | No |
| `node backtest.js --moonshots` | 4H breakout research (defaults to 4h) | **No** |
| `node backtest.js --scalps` | 5m scalp research | **No** |
| `node backtest.js --no-smc` | Daily engine with SMC/Wyckoff/VPOC off | **No** |
| `node backtest.js --smc-ablation` | Compare factors ON vs OFF (controlled A/B) | **No** |

Visual Backtester timeframe → engine: **1d** daily core, **4h** moonshot breakout, **5m** scalp.

Weekly Action also appends moonshot/scalp research logs and **SMC ablation** (`continue-on-error`); only the plain daily run may commit winner-list changes.

**New Listings:** research tab + optional Telegram CMS alerts (`LISTINGS_ALERTS`). Not an auto-buy sniper.

Unit tests: `npm test`

### Logos
```bash
node scripts/fetch-coin-logos.js
```
UI fallback order: local SVG → local PNG → cryptocurrency-icons → CoinCap → letter chip. See `assets/coin-logos/README.md`.

## Disclaimer

**Educational / research tool only.** Past backtests and paper PnL do not guarantee future results. Always place stop-loss and take-profit orders. TrendRunner does not execute trades or hold exchange API keys.
