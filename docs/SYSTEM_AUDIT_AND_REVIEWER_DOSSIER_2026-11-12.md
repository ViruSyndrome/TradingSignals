# SYSTEM AUDIT & INDEPENDENT REVIEWER DOSSIER (UPDATED)
**System**: Dr. Dev / Sagar Advanced Fib Median Options Scalper & Multi-TF Option Engine  
**Target Market**: NSE NIFTY 50 Weekly Options (Dhan Brokerage API) + Futures Research Sleeves  
**Date of Audit**: November 13, 2026 (02:40 IST)  
**Auditor / Engineering Lead**: Antigravity Quantitative Systems  
**Git Branch**: `main` | **Included Commits**: `446a1ae` .. `bbdaeeb` + reviewer-remediation patch  
**Production Server**: Ubuntu 24.04 LTS (`144.24.135.68`) | PM2 App: `trendrunner` (`online`)  

---

## 1. Executive Summary & Honest Bot Readiness Verdict

This dossier provides the transparent technical audit, reviewer-remediation log, empirical backtests (backed by saved JSON artifacts in `docs/backtests/`), and production deployment readiness assessment for the **NIFTY 50 Weekly Options** system.

### Is the Bot Configured Correctly & Ready?
* **Ready for Manual Trading Tomorrow (`DHAN_AUTO_TRADE=false`)**: **YES.** `DHAN_AUTO_TRADE=false` is strictly locked in `~/Trading/.env` on `144.24.135.68` (and the code also fails safe when unset). Live Dhan market-data & option-chain tokens are verified active (`status: success`), PM2 `trendrunner` is online scanning `NIFTY`, and all offline + live API probes pass.
* **3 Technical Pre-Live Gaps Bridged & Verified in Code**:
  1. **Gap 1 — 1m `OPTIDX` Date-Window Bug Fixed + Live Telemetry**: Live Dhan `/v2/charts/intraday` testing proved single-day (`fromDate === toDate`) queries return `0` bars. Fixed `fetchOptionIntradayBars()` in [`js/dhan_nifty_trade.js`](file:///c:/Users/Vinod/Desktop/Trading/js/dhan_nifty_trade.js#L611-L625) to query a 3-day rolling IST window through tomorrow (`probe_live_option_engine.js` verified **770 live 1m bars / 385 latest session** on ATM CE & PE). Added bounded JSONL telemetry (`logs/option_engine_telemetry.jsonl`), tightened higher-low & stale-wick guards in `check1mMicroConfirmation()`, and added fail-closed `DHAN_ALLOW_DELTA_FALLBACK=false` in `bot.js`.
  2. **Gap 2 — Synchronized Telegram Alert, Exit Plan Text & 1m Option Gate**: Extracted shared [`_evaluateNiftyOptionSetup()`](file:///c:/Users/Vinod/Desktop/Trading/bot.js#L936-L1059) in `bot.js`. Telegram `ENTER` now holds when `PENDING_1M` or `WIDE_SPREAD` (`> 2.5`), aligns fallback delta to `0.55`, prints the exact structural Option Chart bracket (`Ask`, `SL`, `1:1 Bank`, `15m Target`) when confirmed, and updates `planLine` to accurately describe Model B (`50% @ 1:1 + BE +0.50`) rather than contradicting it with `"No half-off at 1:1"`.
  3. **Gap 3 — Explicit Cooldown Separation**: `bot.js` explicitly distinguishes `3m structural median switch`, `5m won-setup rotation`, and `30m DHAN_AUTO_COOLDOWN_MS` repeat/loss throttle.
* **Operational Gate Before Flipping `DHAN_AUTO_TRADE=true`**: Still observe 1 full live market session (`09:15–15:30 IST`) with `DHAN_AUTO_TRADE=false` reviewing `logs/option_engine_telemetry.jsonl` (so real intraday latency & live 1m bar fills are confirmed in runtime telemetry before enabling automated real-money orders).

---

## 2. Git Commit Audit Trail & Remediation History

| Commit / Patch | Scope & Files Modified | Engineering Intent & Verified Impact |
| :--- | :--- | :--- |
| **Reviewer Remediation** | `bot.js`, `js/nifty_option_engine.js`, `js/redbar_trend.js`, `scripts/test_nifty_option_engine.js`, `scripts/test_advanced_nifty_fibs.js`, `scripts/test_ha_ema_cci_futures_matrix.js`, `scripts/test_patrick_futures_swing.js` | Closed every discrepancy flagged in independent review: aligned Telegram `planLine` with Model B; added fail-closed `DHAN_ALLOW_DELTA_FALLBACK=false`; tightened `hasHigherLow`; added true 1m + `[4, 14]` SL clamp tests; added true narrow/wide sandwich unit tests & accurate `signal/prior wick extreme` reason; fixed HA matrix `jump`/`thrust` formula and saved JSON artifacts in `docs/backtests/`. |
| **`bbdaeeb`** | `bot.js`, `js/dhan_nifty_trade.js`, `js/nifty_option_engine.js`, `scripts/probe_live_option_engine.js` | Fixed Dhan `/charts/intraday` same-day empty response; synchronized Telegram `ENTER` & 1m Option Engine; fixed stale prior-bar wick label (`prev_rejection_wick_hold`); added JSONL telemetry + live CE/PE 1m probe. |
| **`eaebfdb`** | `bot.js`, `js/dhan_nifty_trade.js`, `scripts/test_ha_ema_cci_futures_matrix.js`, `scripts/test_patrick_futures_swing.js` | Exposed `top_bid_price` as `bid` for true `ask - bid` spread check; trimmed unfinished `<58s` forming 1m candle; enabled option-LTP + index 1:1 detection for Model B in `t.medianTrade`. |
| **`d510957`** | `js/nifty_option_engine.js`, `js/dhan_nifty_trade.js`, `bot.js`, `scripts/test_nifty_option_engine.js` | Created 15m Canvas + 1m Micro-Confirmation Option Engine & closed Model B `bankHalfAtOneR` bypass on median trades. |
| **`446a1ae` / `a8a4827`** | `bot.js`, `js/redbar_trend.js`, `scripts/` | Configurable `DHAN_EXIT_MODEL` (`A`/`B`), First Red Bar gate, Sandwich stand-aside `< 120 pts`, structural cooldown, dynamic IANA London DST. |

---

## 3. Forensic Honesty Audit: Exact Code Mechanics (No Overstatements)

An independent reviewer checking line-by-line should note the exact implemented behavior:
1. **Strictness of `check1mMicroConfirmation()` (`js/nifty_option_engine.js`)**:
   * Confirms on any **one** of four patterns on closed `1m` option candles:
     1. Current `>= 30%` lower rejection wick (`rejection_wick_*pct`), or prior `>= 30%` wick when current holds (`curIsGreen || cur.l >= prev.l`, labeled `prev_rejection_wick_hold_*pct`).
     2. Green reversal bar (`curIsGreen && (curWickRatio >= 0.25 || curLowerWick >= 3.0)`).
     3. Green momentum break (`curIsGreen && (cur.c > prev.h || (cur.c > prev.c && curBody > curRange * 0.4))`).
     4. Micro higher low with buyer confirmation (`cur.l >= prev.l && ((curIsGreen && (curBody >= curRange * 0.25 || curWickRatio >= 0.20)) || curWickRatio >= 0.25)`).
   * If the `1m` fetch returns `< 2` closed bars or errors, `bot.js` now **holds the auto order by default** (`DHAN_ALLOW_DELTA_FALLBACK=false`). Only setting `DHAN_ALLOW_DELTA_FALLBACK=true` allows falling back to `Δ = 0.55` mapped index levels.
2. **Option Stop Clamp (`calculateOptionLevels()` in `js/nifty_option_engine.js`)**:
   * Raw structural stop is `signalLow - 2.0`, **clamped so final option risk lies within `[4.0, 14.0]` points** (`Math.max(4, Math.min(14, entry - rawStop))`). Example `186 -> 178` (`8.0` pts) sits inside the unclamped band.
3. **Dual-Exit Architecture on NIFTY Median (`fib_bounce`) Trades (`bot.js`)**:
   * **Broker SuperOrder (`openOptionSuperTrade`)**: When the 1m gate passes with `directOptionLevels`, Leg 1 (`65` qty in Model B) + runner hold Option SL `[4..14]` pts and Option Target = `openBarLow` (`15m` Opening Range Low if `> 1.5R`, otherwise `2.2R`).
   * **Active Position Monitor (`pollManagedDhanStops`)**: Checks **Model B 1:1** (`bankHalfAtOneR()` sells 65 qty and moves runner SL to Cost `+0.50` when **either** live option LTP hits `entryPremium + oneRPts` **or** underlying index hits `1:1`) AND monitors the **closed 5m index candle** against `t.indexTp1` (`done` / `flip` / `back`) as a tactical exit if the index hits a median and reverses before option ceiling fills.
4. **Sandwich Stand-Aside & Signal Wick Behavior (`js/redbar_trend.js`)**:
   * `detectFibBounceSetup()` skips any closed 5m candle whose close sits strictly inside `[sandwich.lo, sandwich.hi]` when the span `< 120` pts (explicitly tested in `scripts/test_advanced_nifty_fibs.js` section `[5]`, which passes BOTH narrow block `< 120` and wide allowance `>= 120`).
   * Stop uses the further of current signal candle wick and immediately preceding 5m candle wick (`Math.min(b.l, prev.l)` / `Math.max(b.h, prev.h)`), accurately reported as `'signal/prior wick extreme'`.

---

## 4. Verification of Option Chart Engine (Offline Fixtures + Live Dhan Probe)

1. **Offline Test Suite (`scripts/test_nifty_option_engine.js` — ALL PASS)**:
   * **5m Replay (`today_option_candles.json`, `NIFTY 25250 CE`, `77` 5m bars)**:
     * 15m Canvas Open High `269.50` / Open Low `204.15` / Open Median `236.80`.
     * `13:40` red dump (`5.4%` wick) -> `confirmed: false`.
     * `13:45` bounce (`L=180, C=196.15`, `30.1%` wick) -> `confirmed: true` (`Entry 186.00`, `SL 178.00`, `1:1 194.00`, `Target 204.15`, `RR 2.27`).
   * **1m Strict Gating & Clamp Assertions (Test 5)**: Confirms weak `<25%`-body green higher-low doji (`false`), stale prior wick followed by red lower-low flush (`false`), true `1m` buyer rejection (`true`), and `[4.00, 14.00]` pt risk clamps.
2. **Live Dhan `OPTIDX` 1m Endpoint Probe (`scripts/probe_live_option_engine.js` — PASSED LIVE)**:
   * **`NIFTY 25250 CE 2026-11-17` (`SecId=45396`)**: Quote `LTP=203.2, Bid=202.15, Ask=203.35, Spread=1.20`; fetched **`770` live 1m bars** (`385` for `2026-11-12`, Open `162.8..269.5`); `Micro: confirmed=true (rejection_wick_38pct)`; `Entry=203.35 SL=197.45 (5.9 risk) 1:1=209.25 Target=216.35 RR=2.20`.
   * **`NIFTY 25300 PE 2026-11-17` (`SecId=45403`)**: Quote `LTP=188.25, Bid=187.95, Ask=189.00, Spread=1.05`; fetched **`770` live 1m bars** (`385` for `2026-11-12`, Open `183.45..314.85`); `Micro: confirmed=true (prev_rejection_wick_hold_32pct)`; `Entry=189.00 SL=185.00 (4.0 clamped risk) 1:1=193.00 Target=197.80 RR=2.20`.

---

## 5. Official Red Bar / Fib Median Performance Audits

### 5.1 Official 1-Year & Recent 14-Day Engine Walk-Forward (`docs/backtests/advanced_nifty_1794509192305.json`)
Source: [`scripts/backtest_advanced_nifty.js`](file:///c:/Users/Vinod/Desktop/Trading/scripts/backtest_advanced_nifty.js) calling `RedBarTrend.readAt()` (Index points only; does NOT simulate the new 1m option gate or Model B scaling):
* **Full 1-Year Window (`results[2]`)**: `700` trades | **Win Rate**: `37.7%` | **Net**: **+1,460.70 pts (+44.83 R)**
  * `fib_bounce`: `592` trades, `210` wins, **+1,410.56 pts**
  * `afternoon_1245_reversal`: `14` trades, `11` wins (`78.6%`), **+131.77 pts**
  * `afternoon_1245_breakout`: `21` trades, `14` wins (`66.7%`), **+122.70 pts**
  * `afternoon_1245_retest`: `45` trades, `16` wins, `-98.85 pts` | `trade1_departure`: `16` trades, `-119.23 pts`
* **Recent 14-Day Window (`results[0]`, Oct 28 – Nov 11, 2026)**: `30` trades (`12W / 18L`, `40.0%` WR) | **Net**: **+6.64 pts (`-2.27 R`)**
  * `fib_bounce`: `21` trades (`8W`), **`-19.26 pts`** | `afternoon_1245_breakout`: `4` trades, `+11.25 pts` | `afternoon_1245_retest`: `5` trades, `+14.65 pts`.
  * *Takeaway*: Recent 2-week pre-election/trend chop dragged index-level `fib_bounce` flat/negative (`-19.26 pts`), reinforcing why live 1m Option Chart gating + Model B profit banking were required before live auto-trading.

### 5.2 Expiry vs. Normal Days Simplified Delta Replay (2 Lots = 130 Qty)
Computed by standalone simplified Δ=0.55 option-replay harnesses (`scripts/replay_multi_expiry_days.js` and `scripts/replay_normal_days.js`, separate from `readAt()`):
* **10 Weekly Expiry Thursdays (`scripts/replay_multi_expiry_days.js`, `26` Trades)**: Model A **+₹28,462** (`57.7%` WR) | Model B **+₹18,616**
* **10 Normal Non-Expiry Days (`scripts/replay_normal_days.js`, `25` Trades)**: Model A **-₹6,993** (`6W / 7BE / 12L`, `24.0%` strict WR) | Model B **-₹3,911** (`7` trades hit 1:1 before reversing, halving normal-day drag).

---

## 6. Research Appendix A: HA + EMA + CCI Swing on NIFTY Futures (Non-Intraday)
Saved JSON artifact: [`docs/backtests/ha_ema_cci_futures_matrix_latest.json`](file:///c:/Users/Vinod/Desktop/Trading/docs/backtests/ha_ema_cci_futures_matrix_latest.json) (`scripts/test_ha_ema_cci_futures_matrix.js`, overnight Futures holds @ `₹65/pt` per 1 lot). Quiet filter matches `scripts/backtest_ha_ema_cci.js` (`jump = |dCCI| < 25`, `0 <= thrust < 15`, skip session open / `09:15`):

| Timeframe & Variant | Bars (Span) | Trades | Win Rate | Net Pts | 1-Lot Futures (₹65) | PF | Max DD | Avg Hold |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **15m Exact User (HA + Close CCI, Unfiltered)** | 6,252 (1y) | 109 | 24.8% | **+1,751.7** | **+₹1,13,857** | 1.43 | 2,135.4 | 0.9d |
| **15m Exact User (HA + HLC3 CCI, Unfiltered)** | 6,252 (1y) | 93 | 33.3% | **+1,981.2** | **+₹1,28,781** | 1.47 | 1,787.1 | 1.2d |
| **15m Normal Candles (Raw + Close CCI, Unfiltered)** | 6,252 (1y) | 123 | 22.8% | +1,221.8 | +₹79,420 | 1.26 | 2,328.7 | 0.8d |
| **15m Quiet-Filtered (`HA Stack + Close CCI`)** | 6,252 (1y) | 63 | 19.0% | **+2,189.7** | **+₹1,42,331** | **2.30** | **808.1** | 0.8d |
| **30m Exact User (HA + Close CCI, Unfiltered)** | 9,051 (2.8y) | 171 | 28.1% | +211.1 | +₹13,722 | 1.03 | 1,945.1 | 1.9d |
| **1h Exact User (HA + Close CCI, Unfiltered)** | 4,877 (2.8y) | 104 | 28.8% | **+1,549.8** | **+₹1,00,737** | 1.26 | 1,318.9 | 3.4d |
| **5m Exact User (HA + Close CCI, Unfiltered)** | 18,665 (1y) | 299 | 24.1% | +1,683.9 | +₹1,09,457 | 1.24 | 1,085.4 | 0.3d |
| **5m Quiet-Filtered (`HA Stack + Close CCI`)** | 18,665 (1y) | 193 | 24.9% | **+3,406.3** | **+₹2,21,409** | 2.06 | 617.7 | 0.3d |

* **Key Engineering Caveats**: (1) HA smoothing outperforms Normal candlestick stacks on `15m`, `30m`, and `1h`. (2) On `15m`, almost all net gain came from a single 13-day trend (`2026-10-29 -> 2026-11-11`: `+2,215.4 pts`); the other `108` unfiltered trades netted `-463.7 pts`. Low ~20%–34% win rate makes it strictly a **Futures swing sleeve**, unsuitable for decaying weekly options.

---

## 7. Research Appendix B: Patrick Nill (`2hyqdVF0JVk` Visual Audit + Futures Swing)
Saved JSON artifact: [`docs/backtests/patrick_futures_swing_latest.json`](file:///c:/Users/Vinod/Desktop/Trading/docs/backtests/patrick_futures_swing_latest.json) (`scripts/test_patrick_futures_swing.js`, `-2 pts/trade` slippage deducted, multi-day holds scaling `1/3` @ `1.5R` + BE, `1/3` @ `3.0R`, `1/3` structure-trailed):

| Timeframe & Span | Mode | Trades | Win Rate | Net Pts | 1-Lot Futures | PF | Max DD | Avg Hold |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **15m (1y: Nov 25–Nov 26)** | **ALL Combined** | **31** | **58.1%** | **+2,489.7** | **+₹1,61,833** | **3.75** | **445.0** | **1.4d** |
| **15m (1y)** | `CONFIRMED_BREAKOUT` | 12 | 58.3% | **+1,312.7** | +₹85,325 | 3.95 | 145.4 | 1.3d |
| **15m (1y)** | `TIGHT_RECLAIM` | 19 | 52.6% | +885.1 | +₹57,532 | 2.46 | 431.2 | 1.4d |
| **30m (2.8y: Jan 24–Oct 26)** | `ALL Combined` | 51 | 33.3% | -941.9 | -₹61,226 | 0.71 | 1,467.8 | 1.4d |
| **1h (2.8y: Jan 24–Oct 26)** | `ALL Combined` | 50 | 34.0% | -604.6 | -₹39,301 | 0.85 | 1,914.7 | 2.2d |
| **1h (2.8y)** | `CONFIRMED_BREAKOUT` | 18 | 50.0% | **+704.6** | +₹45,797 | 1.48 | 714.4 | 3.5d |

*(Note: Individual `5`-trade sub-slices such as `15m B_BREAKDOWN` (`n=5`) are excluded from headline claims as statistically too small. Strategy remains research-only and is not wired to live orders.)*

---

## 8. Verified Oracle VM Deployment Checklist (External Server)
Deployed and verified via SSH on `144.24.135.68` (`~/Trading/.env` & `pm2 status trendrunner` — `.env` is intentionally excluded from git):
* `DHAN_AUTO_TRADE=false` — **Strictly OFF** for manual trading tomorrow.
* `DHAN_ALLOW_DELTA_FALLBACK=false` (default in code) — Fail-closed protection against blind delta entries if 1m option feed fails.
* `DHAN_EXIT_MODEL=B` | `DHAN_NIFTY_LOTS=2` (`130` units) | `NIFTY_OPT_DELTA=0.55` | `REDBAR_BOT_INSTRUMENTS=NIFTY`.
* `PM2 trendrunner` — Running latest patched code cleanly online.
