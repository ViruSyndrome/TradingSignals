---
name: trendrunner-desk
description: >-
  Authoritative operational guide, live bot inventory, Fib box / Red Bar rules,
  Oracle VM deploy runbook, and verification checklist for the TrendRunner
  Trading workspace (BTC, ETH, NIFTY, SENSEX). Always read this skill before
  modifying TrendRunner UI, Fib boxes, bots, Dhan/Binance execution, or VM state.
---

# TrendRunner Trading Workspace — Authoritative Reference

## 1. Live 4-Market Architecture
TrendRunner tracks **exactly 4 live-traded markets** (`js/config.js`, `index.html`):
- **Crypto (Binance USD-M Futures, 24/7, One-Way Mode):** `BTC` (`BTCUSDT`), `ETH` (`ETHUSDT`)
- **India (Dhan Official API, Mon–Fri `09:15–15:30 IST`):** `NIFTY` (`^NSEI`, `IDX_I/13`, `NSE_FNO`, lot `65`), `SENSEX` (`^BSESN`, `IDX_I/51`, `BSE_FNO`, lot `20`)
- **Retired / Removed (do NOT re-add):** `BANKNIFTY`, `CRUDEOIL`, `NG`, `XAU`, `ha-cci-dhan-paper`, `nov6-nifty-track1`.

---

## 2. Live Production Bots (Oracle VM `ubuntu@144.24.135.68`)
- **Host:** Oracle Cloud Always Free `VM.Standard.E2.1.Micro` (954 MB RAM, 2 vCPU)
- **SSH Key:** `C:/Users/Vinod/.ssh/oracle-bot.key`
- **VM Repo Path:** `/home/ubuntu/Trading/`
- **PM2 Processes (8 total, managed by `bots/ecosystem.tracks.config.js`):**

| PM2 Name | Script | Market & TF | Live Rules & Key Params | State File |
|---|---|---|---|---|
| `trendrunner` | `server.js` | Port `3000` | Web UI + **45s shared `/api/dhan/ohlc` cache** (prevents Dhan `429`) | — |
| `cloudflared` | tunnel | Public URL | Exposes local `trendrunner` server | — |
| `ai-renko-nifty-paper` | `bots/ai_renko_supertrend_bot.js` | NIFTY `15m` | **Mode C LIVE** (`1 lot = 65 qty`, `7–25 DTE ATM`, `MARGIN`, `PATRICK_RESERVE_RS=0`). Brick `33.33`, `(14,3)`. Lock `+120p → +30p`, 36h Theta `→ +50p`, `5× ATR` @ `+180p`, Cap SL `-150p`, Stage 3 @ `+700p/-150p`. **Intrabar LTP watch: `15s`** (only when in position). | `bots/state_ai_renko_st.json` |
| `ai-renko-sensex-live` | `bots/ai_renko_supertrend_bot.js` | SENSEX `15m` | **Mode C LIVE** (`1 lot = 20 qty`, `7–25 DTE ATM`, `BSE_FNO`, `MARGIN`, `PATRICK_RESERVE_RS=0`). Brick `0.15%`, `(14,3)`. Lock `+0.48% → +0.24%` (`~+200p`), 36h Theta `→ +0.28%`, `5× ATR` @ `+0.72%`, Cap SL `-0.75%`, Stage 3 @ `+2.5%/-0.6%`. **Intrabar LTP watch: `17s`** (staggered). | `bots/state_ai_renko_sensex_st.json` |
| `redbar-trade1-live` | `bots/redbar_trade1_paper_bot.js` | NIFTY `15m` (Red=`1h`) | **LIVE** (`1 lot = 65 qty`, `MARGIN`, `PATRICK_RESERVE_RS=20000`). Skips `09:15–10:15` 1H bar → first closed 1H Red → Trade 1 only (`StrongClose >= 0.70`, `AlignRenko=false` — leading signal, 1yr replay: 189 tr / ₹1.06L opt vs 127 tr / ₹52k when aligned, max 1/day). BE `+10p` @ `+35p`, `3R` TP, **`15:10 IST` EOD exit**. | `bots/state_redbar_trade1.json` |
| `patrick-nifty-paper` | `bots/patrick_futures_bot.js` | NIFTY `15m` | **LIVE** (`1 lot = 65 qty`, `7–25 DTE ATM`, `Mode=ALL`, `VolFilter=true`). Selective (~26 trades/yr). | `bots/state_patrick_futures.json` |
| `ha-cci-btc-trader` | `bots/ha_ema_cci_btc_bot.js` | `BTCUSDT` `1h` | **LIVE** `4x Isolated`, `45%` wallet, Chandelier `4.5× ATR`, entry window `03:00–09:50 UTC` (`08:30–15:20 IST`). Same-side stacking enabled (`allowSameSideStack: true`) + `closeBotSlice` exits. | `bots/state_ha_cci_btc.json` |
| `ai-renko-eth-trader` | `bots/ai_renko_eth_bot.js` | `ETHUSDT` `4h` | **LIVE** `4x Isolated`, `45%` wallet, AI Renko `(14,6)` Brick `0.5%` + `EMA200`, `8%` SL. Same-side stacking enabled + `closeBotSlice` exits. | `bots/state_ai_renko_ethusdt.json` |

---

## 3. Critical Rules & Pitfalls (NEVER Get These Wrong)

### A. Fib Box & Red Bar Rules (`js/config.js`, `js/redbar_trend.js`, `js/range_ema_ui.js`)
1. **BTC & ETH Fib Box:** `16:00–17:00 America/New_York` (US Cash Close / CME Settle = `02:30–03:30 IST` winter / `01:30–02:30 IST` summer), `0 / 0.44 / 0.50 / 0.56 / 1.0`. No second 1H red box (`firstRedTf: null`).
2. **NIFTY & SENSEX Intraday Red Bar Rules (Dr. Devendra):**
   - **NSE/BSE trading hours are `09:15–15:30 IST`** (there is NO `15:30–15:45` candle).
   - **First Candle (`09:15`)** vs **First Red Bar (skip `09:15`)**:
     - Never enter on the `09:15` candle or the First Red Bar itself.
     - **Trade 1 (Departure):** Wait for a candle to **close** cleanly outside the First Red High (LONG) or Low (SHORT).
     - **Trade 2 (Shelf Retest):** After departure, wait for pullback to High/Low + **5m candle CLOSE** back in trend direction (never enter on raw wick touch).
     - **5m POB (`0.44–0.56`):** SHORT-only setup — reject close below `0.44` after retest; close above `0.56` invalidates.
   - **Chart Fib Box Consistency Rule (LOCKED):**
     - **NIFTY & SENSEX Fib Box Anchor = `09:15–09:20 IST` (5m opening candle)** (`js/config.js` `markWindow: 09:15–09:20`, `buildAdvancedNiftyFibs` prefers `bars5m` over `bars15m`).
     - Both the chart canvas (`Fib 09:15–09:20`) and the Equilibrium Anchors panel (`09:15–09:20 Fib (5m)`, `Mark mid-zone 44–56%`, `Mark median 50%`) MUST read from `o.advancedFibs.firstBar.fibs` (never the retired `15:00–15:45` window).
   - **Y-Axis Level Pills:** Always render right-axis pills (`PDH`, `ASIA HI`, `SWG HI`, `NY HI`) in the right Y-axis gutter (`afterFit`), never overlapping candles.

### B. Execution & Safety Rules
1. **AI Renko Mode C Re-Entry:** Mode C does **not** re-enter the same direction after a profit-lock exit; it waits for the next fresh `15m` SuperTrend flip.
2. **Intrabar Mutex:** `checkModeCLiveIntrabar` MUST stay guarded by `intrabarBusy` + `scanBusy` so the `15s`/`17s` LTP watcher and `67s`/`69s` bar scanner can never double-sell.
3. **Dhan Rate Limits (`429`):**
   - All Indian bots MUST fetch OHLC through `http://127.0.0.1:3000/api/dhan/ohlc` first (`fetchSymbolBars` in `js/futures_bot_runtime.js`).
   - Off-hours sleep (`09:10–15:35 IST` Mon–Fri) MUST stay active on Indian bot loops.
   - Never run extra LTP polls when flat (`if (!botState.modeC?.pos) return`).
4. **Binance One-Way Mode:**
   - Do **not** tell the user to enable Hedge Mode without first updating `js/binance_futures_trade.js` to pass `positionSide`.
   - Keep `allowSameSideStack: true` + `closeBotSlice` so bots stack safely on same-side manual trades without cancelling manual SL/TP, and skip + alert on opposite-side manual trades.
5. **Dhan Token Refresh:**
   - Tokens expire every 24h (`exp` JWT claim).
   - Always update **both** local `c:\Users\Vinod\Desktop\Trading\.env` AND Oracle VM `/home/ubuntu/Trading/.env` (preserving all other 32 env vars on VM!), then restart `trendrunner patrick-nifty-paper ai-renko-nifty-paper redbar-trade1-live ai-renko-sensex-live` and verify with `getFundLimits()`.

---

## 4. Standard Deploy & Verification Workflow
1. Edit locally, then run syntax + unit tests:
   ```powershell
   node -c bots/ai_renko_supertrend_bot.js; node scripts/test_futures_bots.js
   ```
   Confirm `ALL_FUTURES_BOT_ENGINE_TESTS_PASSED`.
2. Commit & push to `origin/main`.
3. Upload changed files to Oracle VM via `scp -i C:/Users/Vinod/.ssh/oracle-bot.key ... ubuntu@144.24.135.68:/home/ubuntu/Trading/...`.
4. Reload affected PM2 apps (`pm2 startOrRestart bots/ecosystem.tracks.config.js --only <app> --update-env && pm2 save`) and inspect `pm2 logs <app> --lines 10 --nostream`.
5. Never change strategy parameters without first backtesting on real cached data in `.cache_desk/` (`NIFTY_5m/15m.json`, `SENSEX_5m/15m.json`) or `.cache_binance_um/`.
