# TrendRunner Desk — Live Multi-Market Trading & Research Platform

Visual trading desk and automated execution suite covering **4 live-traded markets**:
- **Crypto (Binance USD-M Futures, 24/7):** `BTCUSDT` (`1h HA+EMA+CCI`), `ETHUSDT` (`4h AI Renko + EMA200`)
- **Indian Indices (Dhan Official API, `09:15–15:30 IST`):** `NIFTY` (`AI Renko Mode C`, `RedBar Trade 1`, `Patrick Swing`), `SENSEX` (`AI Renko Mode C`)

## Workspace Architecture

| Component | Path | Purpose |
|---|---|---|
| **Web Desk UI** | `index.html`, `js/config.js`, `js/range_ema_ui.js`, `js/redbar_trend.js` | 4-tab live chart desk (`BTC`, `ETH`, `NIFTY`, `SENSEX`) with Fib boxes, Red Bar pivots, session liquidity clocks, and bot status strip |
| **API & Cache Server** | `server.js` | Serves the web desk + 45s shared in-memory `/api/dhan/ohlc` cache to prevent Dhan `429` rate limits |
| **AI Renko Mode C Bot** | `bots/ai_renko_supertrend_bot.js` | Live options swing bot for **NIFTY** (`15m`, brick `33.33`, lock `+120p→+30p`, Cap `-150p`, `15s` LTP watch) & **SENSEX** (`15m`, brick `0.15%`, lock `+0.48%→+0.24%`, Cap `-0.75%`, `17s` LTP watch) |
| **RedBar Trade 1 Bot** | `bots/redbar_trade1_paper_bot.js` | Live NIFTY intraday options bot (`1h` First Red + `15m` `StrongClose >= 0.70`, `AlignRenko=true`, BE `+10p` @ `+35p`, `3R` TP, `15:10 IST` EOD exit) |
| **Patrick Swing Bot** | `bots/patrick_futures_bot.js` | Live NIFTY `15m` selective swing options bot (`Mode=ALL`, `VolFilter=true`, `7–25 DTE ATM`) |
| **Crypto Bots** | `bots/ha_ema_cci_btc_bot.js`, `bots/ai_renko_eth_bot.js` | Live Binance `4x Isolated` bots (`45%` margin frac, One-Way Mode same-side stacking + `closeBotSlice` exits) |
| **PM2 Process Config** | `bots/ecosystem.tracks.config.js` | Single source of truth for all production PM2 apps on Oracle VM |
| **Agent Skill / Runbook** | `.agents/skills/trendrunner-desk/SKILL.md` | Authoritative reference for rules, Fib box conventions, VM deployment, and safety checks |

## Verification & Testing

```powershell
# Run full futures/options/Binance bot engine test suite
node scripts/test_futures_bots.js

# Syntax check core bot files
node -c bots/ai_renko_supertrend_bot.js; node -c bots/redbar_trade1_paper_bot.js; node -c js/binance_futures_trade.js
```

## Key Documentation
- **Workspace Skill & Runbook:** `.agents/skills/trendrunner-desk/SKILL.md`
- **Red Bar Learning Guide:** `docs/redbar-learning-guide.md`
- **Red Bar Trader Blueprint:** `docs/RED_BAR_TRADER_SPEC.md`
- **Portfolio & Tuning Notes:** `docs/STRATEGY_PORTFOLIO_AND_TUNING_2026-11-17.md`

## Disclaimer
Options and leveraged futures trading carry significant risk of loss. All live bots enforce hard exchange/broker stop-losses and isolated margin caps.
