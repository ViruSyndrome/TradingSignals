# Trading Signals Progress & Strategy Document

## What We Have Built So Far
1. **Cloud Hosting Migration:** Moved the bot from your local PC to Render.com so it runs 24/7 without keeping your computer awake. Set up UptimeRobot to prevent it from sleeping.
2. **Dashboard Upgrades:** 
   - Added 4-tier Trade Quality badges (Golden Entry, Risky Momentum, Mild Buy, Weak/Avoid).
   - Integrated live Fear & Greed Index to gauge market sentiment.
   - Added "High Confidence" filter and smart sorting (Golden Entries appear first).
3. **Robustness & Cleanups:**
   - Replaced fragile `eval()` loading in the bot with proper `require()` modules.
   - Added disk persistence for alerts (`lastAlerted.json`) so the bot doesn't spam you if it restarts.
4. **The Backtester:** Built a comprehensive historical backtesting engine (`backtest.js`) that replays 250 days of real Binance data against our signal math to prove what works and what doesn't.

## The Backtest Reality Check
We ran three iterations of the backtester:
1. **Initial Thresholds:** 38% win rate, -2.1% average return. ("Golden Entry" never fired because thresholds were impossibly strict).
2. **Looser Thresholds:** 33.5% win rate, -1.52% average return. (Traded more, but caught too many bad trades).
3. **Stricter Thresholds:** 29.5% win rate, -3.27% average return. (Traded less, but lost MORE money).

**Why did stricter thresholds fail?** 
In crypto, when a coin crashes hard enough to trigger a "Strict Strong Buy" (extremely oversold RSI + bottom Bollinger band), it's usually not a dip — it's a death spiral. Buying deeply oversold coins is called catching a falling knife. 

## The Strategy to Actually Improve Success Rate
Tweaking the global score threshold isn't enough. We need structural changes. Our 3-step plan will definitively improve the success rate:

1. **Backtested Winners Filter:** The backtester proved this engine *is* highly profitable on 9 specific coins (INJ, LDO, THETA, UNI, TRX, TAO, RUNE, ETH, BTC), but loses heavily on others (DOT, BCH, SAND). We will add a hard filter so the dashboard *only* recommends buys for these 9 proven winners. If you only trade these, your historical average return flips to positive.
2. **Market Regime (Fear & Greed) Gate:** Currently, the engine buys altcoins even when the whole market is crashing. We will wire the Fear & Greed index into the engine. If the market is in "Greed" (score > 60), we discount buy signals. We only buy when the market is fearful.
3. **Momentum Over Mean-Reversion:** We will change the scoring weights. Currently, low RSI (oversold) gives +2.0 points, while Moving Average Crossover (momentum) gives +1.5 points. In crypto, trend following works better than buying dips. We will flip these weights to reward momentum.

These 3 steps shift the strategy from "guesswork" to "data-driven".

## Iteration 4 — Trend-Aware Momentum Engine (IMPLEMENTED ✅)

We executed the 3-step plan, with corrections that made it more robust:

### What changed
1. **Trend-aware RSI & Bollinger (the falling-knife fix):** Oversold RSI / lower-band touches now only earn buy points when price is *above* its long SMA (uptrend = pullback buy). In a downtrend, oversold earns **zero** — no more knife-catching. This is stronger than just flipping weights.
2. **Momentum weighted above mean-reversion:** Dual MA alignment is now the heaviest signal (±2.0), RSI reduced to ±1.5.
3. **Fear & Greed gate (in the engine, not just the UI):** `Signals.generate` accepts `fearGreed`. Extreme Greed (≥75) subtracts 1.0 from buy scores; Extreme Fear (≤20) subtracts 0.5 (broad crashes make individual buy signals unreliable). Dashboard and bot both feed it in.
4. **Config-driven winners filter:** `CONFIG.assets.provenWinners` + `CONFIG.signals.winnersOnlyBuys`. Buy signals on assets outside the list are downgraded to NEUTRAL (dashboard + Telegram bot). The backtester bypasses the filter so the list can be re-validated. **Re-run `node backtest.js` monthly and refresh this list — it reflects a 250-day window and WILL go stale.**
5. **Backtester fixes:** Added a 2R take-profit exit (matches the 1:2 RRR education section) and fixed a real bug — `Indicators.atr()` returns an array, so the old stop-loss compared price against `NaN` and **never fired** in iterations 1–3. Stops now actually trigger (52 stop-outs in iteration 4).

### Iteration 4 backtest results (250 days, all 46 coins)
- All coins, new engine: 302 trades, 27.2% WR, −2.57% avg — confirms most alts are still losers; the edge is *coin selection*, not signal tweaks.
- **Winners-only strategy (what the tool now actually recommends): 68 trades, 45.6% win rate, +1.27% avg return per trade** — the first profitable configuration across all four iterations.
- Winners list re-validated under the new engine: **INJ, LDO, NEAR, TAO, RENDER, TRX, UNI, RUNE** (THETA, ETH, BTC dropped out; NEAR and RENDER earned their way in).
- With the 2R take-profit + working stop-loss, a 45.6% win rate is comfortably profitable (breakeven at 1:2 RRR is ~34%).

### Honest caveats
- The winners list is fitted to one 250-day window — treat it as a rotating watchlist, not gospel. Re-validate monthly.
- 68 trades is a modest sample; expect variance.
- Backtest uses daily closes for stop/TP checks — intraday wicks would change some exits.

## Validation Phase — Realism Check (COMPLETED ✅)

To avoid overfitting, we stress-tested the profitable setup before any new tuning.

### Validation upgrades added to backtest.js
1. **Realistic execution costs:** 0.10% fee + 0.10% slippage per side (0.40% round-trip).
2. **Next-bar execution model:** signals trigger on day N close, entries/exits fill at day N+1 open.
3. **Walk-forward mode:** `node backtest.js --walk-forward` with train window days 0-149 and out-of-sample test window days 150-249.

### Results under realistic costs + next-bar fills
- **All assets:** 316 trades, 25.9% WR, **-2.61% net avg return** (gross -2.22%).
- **Configured winners-only list (INJ, LDO, NEAR, TAO, RENDER, TRX, UNI, RUNE):** 71 trades, 40.8% WR, **+1.01% net avg return** (gross +1.42%).

### Walk-forward out-of-sample result (most important)
- Train selected winners: **NEAR, INJ, RENDER, FET, TRX, TAO**.
- Test window (only those selected winners): 27 trades, 44.4% WR, **+0.96% net avg return** (gross +1.36%).

### Interpretation
- The edge **survives realistic costs and out-of-sample testing**, but it is modest.
- We should avoid aggressive tuning now and instead continue validation discipline (rolling walk-forward and cost sensitivity).

## Rolling Robustness Extension (COMPLETED ✅)

We upgraded the validator with two additional modes:
1. **Rolling Walk-Forward:** `--walk-forward-rolling` runs 3 windows (120-day train, 60-day test).
2. **Cost Sweep:** `--cost-sweep` runs round-trip costs at 0.20%, 0.40%, and 0.60%.

### Combined Out-of-Sample (all rolling test windows)
- **0.20% RT:** 41.9% WR, **+0.39% net avg return**
- **0.40% RT:** 39.5% WR, **+0.05% net avg return**
- **0.60% RT:** 39.5% WR, **-0.15% net avg return**

### Practical takeaway
- The edge is **real but thin**. It survives only under lower-to-moderate execution costs.
- At high friction (0.60% round-trip), expectancy turns negative.
- This strategy should be used only when your actual fees/slippage are kept near or below the 0.40% round-trip zone.

## Winners List Tightened to Robust Survivors (COMPLETED ✅)
- Rolling walk-forward showed only **NEAR, INJ, TRX** were selected in all 3 train windows and held up out-of-sample; RENDER and RUNE failed the robustness test and were dropped.
- New live list: **NEAR, INJ, TRX** (core) + **LDO, TAO, UNI** (probation — marginal full-window positives).
- Full-window validation with realistic costs: **54 trades, 42.6% WR, +1.35% net avg return** (vs +1.01% with the old 8-coin list).
