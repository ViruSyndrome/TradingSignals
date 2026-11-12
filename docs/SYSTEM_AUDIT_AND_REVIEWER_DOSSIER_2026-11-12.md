# SYSTEM AUDIT & INDEPENDENT REVIEWER DOSSIER (UPDATED)
**System**: Dr. Dev / Sagar Advanced Fib Median Options Scalper & Multi-TF Option Engine  
**Target Market**: NSE NIFTY 50 Weekly Options (Dhan Brokerage API) + Futures Research Sleeves  
**Date of Audit**: November 13, 2026 (02:05 IST)  
**Auditor / Engineering Lead**: Antigravity Quantitative Systems  
**Git Branch**: `main` | **Included Commits**: `446a1ae` .. `d510957` + latest execution-safety & Futures research update  
**Production Server**: Ubuntu 24.04 LTS (`144.24.135.68`) | PM2 App: `trendrunner` (PID `354463`, `online`)  

---

## 1. Executive Summary & Honest Bot Readiness Verdict

This dossier provides the complete, unfiltered technical audit, forensic remediation log, empirical backtests, and live deployment readiness assessment for the **NIFTY 50 Weekly Options** bot and its two supplementary **NIFTY Futures swing** research strategies.

### Is the Bot Configured Correctly & Ready to Go Live?
* **Ready for Manual Trading Tomorrow (`DHAN_AUTO_TRADE=false`)**: **YES.** The Oracle VM is healthy, `DHAN_AUTO_TRADE=false` is strictly locked in `~/Trading/.env`, Dhan API connectivity is verified (`status: success`), PM2 `trendrunner` is online scanning `NIFTY`, and all structural engine tests + live Dhan `OPTIDX` 1m probes pass.
* **All 3 Pre-Live Execution Gaps Now Bridged in Code**:
  1. **Gap 1 Closed (1m `OPTIDX` Date-Window Bug Fixed + Live Telemetry Built In)**: Live Dhan `/v2/charts/intraday` probing discovered that single-day queries (`fromDate === toDate`) returned `0` bars. Fixed `fetchOptionIntradayBars()` in `js/dhan_nifty_trade.js` to query a 3-day rolling IST window through `tomorrow` (verified live returning `770` 1m bars = `385` for `2026-11-12` on both `25250 CE` and `25300 PE`), added live JSONL telemetry (`logs/option_engine_telemetry.jsonl`) + `scripts/probe_live_option_engine.js`, and refined `check1mMicroConfirmation()` so a prior-bar rejection wick only confirms if the current bar holds (`prev_rejection_wick_hold`).
  2. **Gap 2 Closed (Telegram `ENTER` & Option 1m Gate Synchronized)**: Extracted shared `_evaluateNiftyOptionSetup()` in `bot.js`. Telegram `ENTER` now holds when the Option 1m gate is `PENDING_1M` or `WIDE_SPREAD`, prints the actual structural Option Chart Bracket (`Ask`, `Wick SL`, `1:1 Bank`, `15m Ceiling`) instead of synthetic guesses (with fallback delta aligned to `0.55`), and passes `precomputedOptEval` into `_maybeAutoDhanNifty()` with zero duplicate API calls.
  3. **Gap 3 Closed (Explicit Cooldown Distinction)**: Updated cooldown logs in `bot.js` to explicitly report `3m structural median switch` vs `5m won-setup rotation` vs `30m DHAN_AUTO_COOLDOWN_MS repeat/loss throttle`.
* **Operational Gate Before Flipping `DHAN_AUTO_TRADE=true`**: While code + live `OPTIDX` endpoints are verified, still observe 1 live market-hour session (`DHAN_AUTO_TRADE=false`) reviewing `logs/option_engine_telemetry.jsonl` (or PM2 logs) before enabling real-money auto orders.

```
+-----------------------------------------------------------------------------------+
|                        PRODUCTION SYSTEM STATUS OVERVIEW                          |
+-----------------------------------------------------------------------------------+
| Live Auto-Trading Flag   | DHAN_AUTO_TRADE=false (LOCKED OFF FOR MANUAL SESSION)  |
| Execution Exit Model     | DHAN_EXIT_MODEL=B (50% Bank @ 1:1 + Runner BE +0.50)   |
| Active Position Sizing   | DHAN_NIFTY_LOTS=2 (130 Units)                          |
| Dhan API Connectivity    | Active & Verified Live (status: success, token fresh)  |
| Option Engine Unit Test  | scripts/test_nifty_option_engine.js — ALL PASS         |
| Fib Anchor Unit Test     | scripts/test_advanced_nifty_fibs.js — ALL PASS         |
| Production Deployment    | Verified on Oracle VM 144.24.135.68 (PM2 PID 354463)   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Git Commit Audit Trail & Execution Fixes Applied

| Commit / Stage | Scope & Files Modified | Engineering Intent & Verified Fix |
| :--- | :--- | :--- |
| **Latest Audit Patch** | `js/dhan_nifty_trade.js`, `bot.js`, `scripts/test_ha_ema_cci_futures_matrix.js`, `scripts/test_patrick_futures_swing.js` | **3 Execution Fixes + Futures Matrices**: (1) Exposed `top_bid_price` as `bid` in `pickOptionContract()` so `bot.js` measures true `ask - bid` spread instead of `ask - ltp`; (2) Added `<58s` closed-candle guard on live 1m option bars in `bot.js` so mid-minute forming ticks do not falsely trigger `check1mMicroConfirmation()`; (3) Updated `t.medianTrade` 1:1 check in `pollManagedDhanStops()` to trigger Model B (`bankHalfAtOneR`) on **either** option premium `1:1` (`entryPremium + oneRPts`) OR underlying index `1:1`. |
| **`ce5c73d`** | `scripts/compare_locked_ha_vs_normal.js`, `scripts/test_patrick_nill_strategy.js` | Initial HA vs Normal EMA stack check and 12-trade `15m` sweep study. |
| **`d510957`** | `js/nifty_option_engine.js`, `js/dhan_nifty_trade.js`, `bot.js`, `scripts/test_nifty_option_engine.js` | **Live Option Chart Engine & Model B Fix**: Added live 1m/15m option candle analysis, 1m buyer-wick rejection gating ($\ge 30\%$ wick / green expansion), direct option wick SL (`signalLow - 2.0`), and fixed `bankHalfAtOneR` bypass on median trades. |
| **`a8a4827`** | `bot.js` | Added configurable `DHAN_EXIT_MODEL` (`A` = All-In to Target vs `B` = 1:1 Banker + Runner BE). |
| **`446a1ae`** | `bot.js`, `js/redbar_trend.js`, `scripts/` | Applied First Red Bar gate, Sandwich stand-aside, structural level cooldown, dynamic London DST, and expiry replay harness. |

---

## 3. Forensic Honesty Audit: Resolved Bugs vs. Remaining Gaps

### Bugs Discovered & Closed
1. **The Option Chart Disconnect (Fixed in `d510957`)**:
   * *Prior Reality*: While Fib rules ran on the **NIFTY Spot Index**, Dhan orders estimated SL/TP by multiplying index risk by Delta ($\Delta = 0.55$). The bot never read the actual option chart's 15m Opening Bar Low (structural ceiling) or 1m buyer support wicks.
   * *Fix Deployed*: [`js/nifty_option_engine.js`](file:///c:/Users/Vinod/Desktop/Trading/js/nifty_option_engine.js) fetches live `OPTIDX` bars from Dhan, identifies `openBarLow` (`09:15–09:30 IST`), requires a **closed 1m** rejection wick ($\ge 30\%$ lower wick + higher low) or green reversal bar, and anchors SL directly below `signalLow - 2.0` (`directOptionLevels`).
2. **Model B `bankHalfAtOneR` Bypass on Median Trades (Fixed in `d510957` & Refined Today)**:
   * *Prior Reality*: `fib_bounce` trades hit `continue;` inside `if (t.medianTrade)` after moving SL to breakeven, skipping `bankHalfAtOneR()`. Furthermore, checking only **underlying index 1:1** missed tighter **option-chart 1:1** targets when `directOptionLevels` anchored a 6–10 pt option SL.
   * *Fix Deployed*: `pollManagedDhanStops()` in `bot.js` now checks **both** live `OPTIDX` LTP (`entryPremium + oneRPts`) and underlying index 1:1, banking 65 qty (1 lot) at 1:1 and locking Leg 2 at Cost `+0.50`.
3. **Fake Spread Check & Unclosed Live 1m Bar Vulnerability (Fixed Today)**:
   * `pickOptionContract()` in `js/dhan_nifty_trade.js` now returns `bid` (`top_bid_price`) so `bot.js` checks true `ask - bid > 2.5` (previously `ask - ltp`), and `bot.js` strips an incomplete `<58s` live 1m candle before running `check1mMicroConfirmation()`.

### Resolved Gaps + Operational Checklist Before Enabling `DHAN_AUTO_TRADE=true`
1. **Live Telemetry & Same-Day API Fix (`probe_live_option_engine.js` & `logs/option_engine_telemetry.jsonl`) — BUILT & VERIFIED**: Live endpoint testing caught and fixed Dhan `/charts/intraday` returning `0` bars on same-calendar-day ranges; `fetchOptionIntradayBars()` now returns `770` live 1m bars reliably (`385` for latest session on both ATM CE & PE). Monitor 1 live market session via telemetry (`DHAN_AUTO_TRADE=false`) before switching auto live.
2. **Telegram Alert vs. 1m Gate Sequencing — BUILT & VERIFIED**: `_scanOneRedBarInstrument()` now runs `_evaluateNiftyOptionSetup()` upfront and holds Telegram `ENTER` until 1m Option confirmation clears (and prints exact Option Strike / Ask / SL / 1:1 / 15m Target in Telegram instead of synthetic estimates; fallback delta aligned to `0.55`).
3. **30-Minute Repeat Cooldown Clarity (`DHAN_AUTO_COOLDOWN_MS=1800000`) — CLARIFIED IN LOGS**: `bot.js` explicitly distinguishes `3m structural median switch` and `5m won-setup rotation` from the `30m` same-side repeat/loss throttle.
4. **Capital / Profit Expectation Alignment**: Neither this 2-lot (130 qty) NIFTY intraday options system nor single-lot Futures strategies will generate ₹5,00,000/month consistently on ₹2L capital. At verified positive expectancy, ₹5L/month requires larger capital scaling (`₹8L–₹12L+` / 10–15 lots) plus diversified non-correlated sleeves.

---

## 4. Verification of the Live Option Chart Engine (`nifty_option_engine.js`)

Validated against real Dhan exchange candles for **`NIFTY 25250 CE`** (Nov 12, 2026 — [`scripts/test_nifty_option_engine.js`](file:///c:/Users/Vinod/Desktop/Trading/scripts/test_nifty_option_engine.js)):

```
--- 1. 15-Minute Option Canvas ---
Opening Range High:         Rs 269.50
Opening Range Low (Target): Rs 204.15  (Primary structural ceiling for afternoon bounce)

--- 2. Micro-Confirmation Gate (Option Tape) ---
• 13:40 Bar (O:197.25 L:183.85 C:184.85, Red, Wick Ratio 5.4%):
  -> Confirmed = FALSE ("1m awaiting confirmation" — prevents catching falling knife)

• 13:45 Bar (O:185.15 L:180.00 C:196.15, Green, Wick Ratio 30.1%):
  -> Confirmed = TRUE ("rejection_wick_30pct, signalLow=180.00")

--- 3. Structural Option Bracket Built ---
Entry Price:        Rs 186.00 (Live Ask)
Stop Loss:          Rs 178.00 (signalLow 180.00 - 2.00 buffer -> 8.00 pts Risk)
Model B 1:1 Bank:   Rs 194.00 (Sell 65 qty, move Leg 2 SL to Rs 186.50)
15m Target Ceiling: Rs 204.15 (Reward: +18.15 pts -> 1:2.27 Risk/Reward)
```

Also verified after today's final edits: `scripts/test_advanced_nifty_fibs.js` (**ALL PASS** — First Red Bar, Sandwich stand-aside `<120`, previous wick extreme SL, lunch median bounces, halfway POB median).

---

## 5. Official Red Bar / Fib Median Performance Audits

### 5.1 Official 1-Year Production Engine Walk-Forward (`RedBarTrend.readAt()`)
* **Period**: Nov 14, 2025 – Nov 11, 2026 (`scripts/backtest_advanced_nifty.js`)
* **Total Trades**: 700 | **Win Rate**: 37.7% | **Net Index Points**: **+1,460.70 pts (+44.83 R)**
* **Core Setup Breakdown**:
  * `fib_bounce` (Sagar/Dev Medians): 592 trades, 210 wins, **+1,410.56 pts**
  * `afternoon_1245_reversal`: 14 trades, 11 wins (**78.6% WR**), **+131.77 pts**
  * `afternoon_1245_breakout`: 21 trades, 14 wins (**66.7% WR**), **+122.70 pts**

### 5.2 Expiry Days vs. Normal Days Regime Split (2 Lots = 130 Qty)
* **10 Weekly Expiry Thursdays (26 Trades)**: Model A **+₹28,462** (57.7% WR) | Model B **+₹18,615**
* **10 Normal Non-Expiry Days (25 Trades)**: Model A **-₹6,993** (24% WR) | Model B **-₹3,911** (52% profitable; banked +₹11,611 across 7 reversals before reversal, halving drag).

---

## 6. Research Appendix A: HA + EMA + CCI Swing on NIFTY Futures (Updated Matrix)

Tested across the exact non-intraday Futures swing rules specified by the user (`scripts/test_ha_ema_cci_futures_matrix.js`, holding overnight across days at 1 lot = ₹65/pt):
* **Condition 1 (First)**: Trend stack aligned on **Heikin Ashi** candles (`HA Close > EMA20 > EMA50 > EMA200` for Long; reverse for Short).
* **Condition 2 (Second)**: `CCI(200)` crosses `< 100 -> > 100` to enter Long (and `> 100 -> < 100` to exit); crosses `> -100 -> < -100` (e.g., `-98 -> -104`) to enter Short (and `-104 -> -98` to exit).

| Timeframe & Variant | Bars / Span | Trades | Win Rate | Net Pts | 1-Lot Futures (₹65) | Profit Factor | Max DD (Pts) | Avg Hold |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **15m Exact User (HA + Close CCI, Unfiltered)** | 6,252 (1y) | 109 | 24.8% | **+1,751.7** | **+₹1,13,857** | 1.43 | 2,135.4 | 0.9d |
| **15m Exact User (HA + HLC3 CCI, Unfiltered)** | 6,252 (1y) | 93 | 33.3% | **+1,981.2** | **+₹1,28,781** | 1.47 | 1,787.1 | 1.2d |
| **15m Normal Candles (Raw + Close CCI, Unfiltered)** | 6,252 (1y) | 123 | 22.8% | +1,221.8 | +₹79,420 | 1.26 | 2,328.7 | 0.8d |
| **15m Quiet-Filtered (`jump<25, thrust<15`)** | 6,252 (1y) | 53 | 17.0% | -220.9 | -₹14,362 | 0.86 | 764.0 | 0.5d |
| **30m Exact User (HA + Close CCI, Unfiltered)** | 9,051 (2.8y) | 171 | 28.1% | +211.1 | +₹13,722 | 1.03 | 1,945.1 | 1.9d |
| **1h Exact User (HA + Close CCI, Unfiltered)** | 4,877 (2.8y) | 104 | 28.8% | **+1,549.8** | **+₹1,00,737** | 1.26 | 1,318.9 | 3.4d |
| **1h Normal Candles (Raw + Close CCI, Unfiltered)** | 4,877 (2.8y) | 120 | 29.2% | +944.5 | +₹61,389 | 1.14 | 1,494.0 | 3.2d |
| **5m Exact User (HA + Close CCI, Unfiltered)** | 18,665 (1y) | 299 | 24.1% | +1,683.9 | +₹1,09,457 | 1.24 | 1,085.4 | 0.3d |
| **5m Quiet-Filtered (`jump<25, thrust<15`)** | 18,665 (1y) | 133 | 24.8% | **+2,841.4** | **+₹1,84,691** | **2.92** | **520.0** | 0.2d |

### Unfiltered Engineering Findings
1. **Heikin Ashi vs. Normal Stack**: Keeping **HA for EMA 20/50/200 alignment** outperformed Normal candlestick stacks across `15m` (`+1,751.7 vs +1,221.8 pts`), `30m` (`+211.1 vs -296.4 pts`), and `1h` (`+1,549.8 vs +944.5 pts`), confirming HA smoothing preserves trend continuity better while `CCI(200)` triggers cleanly on raw prices.
2. **Concentration Warning on `15m` Unfiltered**: Nearly **all** profit on `15m` (`+1,751.7 pts`) came from a single 13-day rally (`2026-10-29 -> 2026-11-11`: `+2,215.4 pts`); the remaining 108 trades combined for `-463.7 pts` and suffered a `2,135 pt` drawdown (`₹1.39L`/lot). That single rally also crossed a gap/thrust barrier, explaining why the 15m Quiet Filter missed it (`-220.9 pts`), whereas on `5m` the Quiet Filter cut average loss in half (`-14.8 vs -31.0 pts`) and boosted PF to **2.92**.
3. **Verdict**: Strict **Futures trend-following sleeve** only (~24%–34% win rate); completely unsuitable for decaying weekly options.

---

## 7. Research Appendix B: Patrick Nill (`2hyqdVF0JVk` Whiteboard Visuals + NIFTY Futures Swing)

Beyond transcripts (`kJyooWDFXyk`, `2hyqdVF0JVk`), key **visual whiteboard diagrams** from `2hyqdVF0JVk.mp4` (`wb_008`, `wb_030`, `wb_042`, `wb2_005`, `wb2_015`, `wb2_024`) clarified four exact structural rules:
1. **Prior Impulse + 3-Touch Validation (`wb2_005`)**: Wait for an aggressive vertical move (`P` or `b`) into consolidation, then count at least **3 distinct top-to-bottom touches** on the horizontal boundary before trading (half-day to full-day maturation on `15m`).
2. **Tight Box vs. Wide Box (`wb_008`, `wb_054`)**:
   * **Tight Box**: After a strong directional impulse, trade **breakouts** (or **failed-breakdown reclaims**) in the impulse direction — never fade it.
   * **Wide Box**: Only **fade extremes** after 3 touches toward the opposite boundary.
3. **Red Fakeout Reclaim & Tight Structural Stop (`wb_030`)**: Price dips slightly *below* box support (trapping breakout shorts), snaps back inside with a strong candle, and rallies through the box high. SL goes strictly below the **red fakeout sweep wick** — never widened (`never move stop further away`).
4. **Measured-Move ATH Projection & Multi-Day Holds (`wb2_024`)**: Copy the prior impulse height upward above the top range (or trail stops beneath newly stepped `P`/`b` boxes over 2–4+ day Futures holds), scaling out in multiples of 3 contracts.

### Mechanical NIFTY Futures Swing Test (`scripts/test_patrick_futures_swing.js`, -2 pts/trade slippage included)
Rules tested: 3-touch box identification, tight vs. wide classification, failed-breakout reclaim + confirmed `P`/`b` breakout, 3-lot scaling (`1/3` @ 1.5R + BE move, `1/3` @ 3.0R, `1/3` trailing 10-bar swing structure overnight):

| Timeframe & Span | Mode / Setup | Trades | Win Rate | Net Pts | 1-Lot Futures (₹65) | Profit Factor | Max DD (Pts) | Avg Hold |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **15m (1 yr: Nov 25–Nov 26)** | **ALL Combined** | **31** | **58.1%** | **+2,489.7** | **+₹1,61,833** | **3.75** | **445.0** | **1.4d** |
| **15m (1 yr)** | `CONFIRMED_BREAKOUT` | 12 | 58.3% | **+1,312.7** | +₹85,325 | 3.95 | 145.4 | 1.3d |
| **15m (1 yr)** | `TIGHT_RECLAIM` | 19 | 52.6% | +885.1 | +₹57,532 | 2.46 | 431.2 | 1.4d |
| **15m (1 yr)** | `B_BREAKDOWN` subset | 5 | 100.0% | +1,304.5 | +₹84,794 | ∞ | 0.0 | 1.8d |
| **30m (2.8 yr: Jan 24–Oct 26)** | `ALL Combined` | 51 | 33.3% | -941.9 | -₹61,226 | 0.71 | 1,467.8 | 1.4d |
| **1h (2.8 yr: Jan 24–Oct 26)** | `ALL Combined` | 50 | 34.0% | -604.6 | -₹39,301 | 0.85 | 1,914.7 | 2.2d |
| **1h (2.8 yr)** | `CONFIRMED_BREAKOUT` (`B_BREAKDOWN`) | 18 (5) | 50.0% (60%) | **+704.6** (+436.5) | +₹45,797 | 1.48 (2.57) | 714.4 | 3.5d |

* **Honest Assessment**: On **`15m`** (the exact chart Patrick Nill trades), the visual whiteboard rules produced strong swing expectancy (**+2,489.7 pts, 58.1% WR, PF 3.75, MaxDD 445 pts**). On coarser **`30m`/`1h`** candles over 2.8 years, fade/reclaim trades struggled against multi-day gap chop (`-604 to -942 pts`), though **confirmed `b` breakdowns** remained profitable across *all three* timeframes (`15m`, `30m`, `1h`). Furthermore, Patrick explicitly states his real-world 60–75% win rate relies on Weekly Market Profile (`VAH`/`VAL`), footprint confirmation, and proprietary zone-resizing discretion. Therefore, this remains a **high-priority Futures research candidate** pending multi-year `15m` + Weekly TPO validation, not yet wired into live NIFTY execution.

---

## 8. Verified Oracle VM Configuration (Locked Safe for Manual Session)

Verified live on `144.24.135.68` (`~/Trading/.env`, `node --check`, `pm2 status`):
* `DHAN_AUTO_TRADE=false` — **Strictly OFF** (zero automated orders will fire during manual trading).
* `DHAN_EXIT_MODEL=B` — Active (50% 1:1 cash banker + Leg 2 Breakeven `+0.50`).
* `DHAN_NIFTY_LOTS=2` (`NIFTY_LOT_SIZE=65` -> 130 qty) | `NIFTY_OPT_DELTA=0.55`.
* `REDBAR_BOT_INSTRUMENTS=NIFTY` | `DHAN_AUTO_COOLDOWN_MS=1800000` (30m auto cooldown when later enabled).
* `PM2 trendrunner` — Status **`online`**, PID **`354463`**, running today's patched `bot.js`, `js/dhan_nifty_trade.js`, and `js/nifty_option_engine.js`.
