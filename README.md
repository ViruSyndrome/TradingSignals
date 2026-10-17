# TrendRunner — BTC Red Bar Desk

Visual **Bitcoin** research desk: prior-day range bands, opening-range bias, red-bar exit refs, and a **LONG / SHORT / WAIT** action strip on a 30m chart.

Educational only — the app does **not** place trades. Futures shorts need an exchange futures account; spot is long-only.

## What the live UI is

| Piece | Role |
|--------|------|
| **Red Bar Desk** | Primary screen (`CONFIG.ui.redBarOnly`) |
| **`js/redbar_trend.js`** | Trend prediction (all prior-day bands + OR break + red bar) |
| **`js/range_ema_ui.js`** | Chart + action strip + EMA overlay chips |
| **EMA 10/30** | Separate overlay (agree/disagree) — not the core engine |
| **Learn** | How to read LONG/SHORT/WAIT and fund a wallet |

Legacy multi-coin High Conf / moonshots / listings are **hidden** from the main UI.

## Quick start

Serve the folder (or open via GitHub Pages / your host) and hard-refresh so the service worker picks up the new cache.

```bash
# Optional research CLI (Node)
node redbar_ema_backtest.js
node redbar_ema_backtest.js --live
```

## Config knobs (`js/config.js`)

- `ui.redBarOnly` — hide legacy chrome  
- `rangeEma.symbols` — default `['BTCUSDT']`  
- `rangeEma.workingTf` — default `30m`  
- `rangeEma.dayMode` — `utc` or `ny`

## Funding guides (not strategy)

India INR ↔ USDT helpers still live under `guides/` (P2P, Convert caution, cash-out). Use them to fund margin/spot, then trade from the desk.

## Architecture (current)

- `js/redbar_trend.js` — Red Bar trend readout  
- `js/range_ema_engine.js` — EMA helpers / older experiment backtest hooks  
- `js/range_ema_ui.js` — desk UI + Chart.js  
- `js/dashboard.js` — boot in red-bar-only mode (skips 50-coin load)  
- `js/config.js` — `ui` + `rangeEma`  
- Legacy: `js/signals.js`, `backtest.js`, moonshot scanner — research / unused in main UI  

## Disclaimer

Crypto and futures trading can result in total loss of margin (liquidation). Levels on the desk are research references, not guarantees.
