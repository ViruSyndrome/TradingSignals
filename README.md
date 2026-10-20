# TrendRunner — Red Bar Futures Desk

Visual **Futures** research desk for **BTC** (`02:30–03:30 IST` mark window), **XAU / Gold** (`01:30–02:30 IST`), and **NIFTY** (`15:15–15:45 IST` institutional close):
- **Mark-Window Fib Boxes (`0 · 0.44 · 0.5 · 0.56 · 1`)** extended across the session
- **1H First Red Candle** as the daily session pivot (**Trade 1** departure & **Trade 2** 2–3h revisit)
- **Session Liquidity Clock** (**Asia → London sweep → US open**)
- **Structural Stops, `+0.8R → Breakeven` protection & `≥1.5R` Liquidity Targets**
- **Futures Position Sizing, Safe Isolated Leverage & Liquidation Price** (inline on the desk and in the Risk Calculator tab)

Educational only — the app does **not** place trades automatically.

## Live Desk Architecture

| Piece | Role |
|--------|------|
| **Red Bar Desk** | Primary screen (`CONFIG.ui.redBarOnly = true`) |
| **`js/redbar_trend.js`** | 4-pillar engine: mark-window Fibs, 1H first-red Trade 1/Trade 2, session sweeps, `≥1.5R` liquidity magnet ladder, and `futuresSizing()` |
| **`js/range_ema_ui.js`** | Interactive multi-instrument chart (`5m / 15m / 30m / 1h`), LONG/SHORT/WAIT action plan, and inline Futures Sizing strip |
| **`redbar_desk_backtest.js`** | Walk-forward 30m + 1H Futures CLI backtester (0.08% round-trip fees, `+0.8R → BE` lock, `≥1.5R` targets) |
| **Risk Calculator (`#riskSection`)** | Full Futures LONG & SHORT position size, isolated leverage, and liquidation price calculator |

## Walk-Forward Backtest CLI

```bash
# Run 4,000-bar (83-day) 30m + 1H walk-forward backtest + live BTC/XAU readout
node redbar_desk_backtest.js --live

# Compare naive box-breakout vs Trade 1 + Trade 2 + Sweep + 0.8R BE lock
node redbar_desk_backtest.js --compare
```

## Disclaimer

Crypto and futures trading can result in total loss of margin (liquidation). Always use isolated margin and a hard stop-loss on the exchange.

