# Reviewer brief — 11 Nov 2026 (Revised & Reconciled)

This document reflects the exact code running in `bot.js` and supporting modules, verified against codebase reality and reviewer audit.

---

## 1. What the NIFTY Bot Actually Does Now

NIFTY 50 options only. Default order size is 2 lots (130 units), auto-downscaling to 1 lot if available cash is insufficient. All stops, breakeven triggers, and targets are evaluated strictly on the underlying NIFTY 50 index (from Dhan feed). BANKNIFTY, Sensex, MCX Crude, MCX NG, and Binance Crypto auto-trading and Telegram alerts are disabled.

### The Daily Median Lines:
1. **09:15 Open Bar Median**: Median band (0.44 to 0.56) of the 09:15 candle.
2. **First Red Bar Median**: The first red candle *after* 09:15. If 09:15 itself is red, it serves only as the Open Bar — the code skips 09:15 and waits for the first subsequent closed red candle.
3. **Gap Median**: Drawn only if the gap between yesterday's close and today's open is $\ge 40$ points.
4. **Prior Session Median**: Yesterday's closing session median (15:15–15:45 mark).
5. **Highway 50% Median (Wide Highway Rule)**: Drawn only when the span between the 09:15 Open Median and First Red Bar Median is $\ge 120$ index points (like Nov 4). Subdivides wide canyons into a 44%–56% Point of Balance shelf for structured targets and bounces.

### Tradable Zone:
* The space between the 09:15 median and the First Red Bar median is fully tradable.
* There is no explicit "deadlock" state machine in code; the bot simply takes no trades when price is churning between bands without a qualifying 5m wick meeting a band.

### Entry Trigger:
* A 5-minute candle wick meets one of the 4 median bands and closes back inside/away, OR the wick cuts the band and the candle flips color.
* When this median wick signal occurs, it takes priority ahead of Trade 1.

### Stop Loss:
* Placed at the extreme wick of the signal candle (tight structural risk: typically 10–25 index points).
* Handled as a Dhan SuperOrder SL-M on the option contract.

### Target & Trade Management:
* **First Target**: The near edge of the next median band (0.44 line for longs, 0.56 line for shorts).
* **Underlying 1:1 Breakeven Protection**: Once the underlying index moves a distance equal to the initial stop risk (1:1), the option stop is automatically modified on Dhan to entry cost + 0.5 pt buffer. The full position stays on (no half-off on median trades).
* **Exit Scenarios**:
  - *Wick tags target and candle closes back*: Full position is closed on Dhan.
  - *Candle closes through target*: Position is held, and the target rolls to the near edge of the subsequent median band.
  - *Candle closes through target and color flips*: Current position is closed on Dhan; opposite trade is eligible to open.
  - *Opposite median bounce*: Permitted after a 3-minute cooldown (reduced from the legacy 30–75m cooldown) or immediately upon a color flip.
  - *No median ahead*: If no further median exists in the direction of the trade, the position is held until a 5m close comes back through the entry median, or the 15:10 IST session cutoff.

### Fallback to Legacy Trades:
* Trade 1, Trade 2, and afternoon setups remain in the code as fallbacks, executing only when no fresh median wick is present. They retain their legacy box-midpoint stop and 1:1 half-off exit logic.

### Broker & Risk Safeguards:
* **Dhan HTTP 429 Retry**: 2-tier exponential backoff retry in `js/dhan_client.js` absorbs transient Dhan rate limits.
* **Marketable Limit Buffer**: A +1.0 pt limit pad is applied on entry orders to significantly improve fill rates, though it does not mathematically guarantee 100% fills if spread/slippage exceeds 1 pt during extreme spikes.
* **Margin Downscale**: If wallet balance cannot cover 2 lots, the bot automatically places 1 lot rather than aborting.
* **Execution Lock (Rule 0)**: A strict discipline mandate not to modify running NIFTY parameters during live trading hours (written rule, not a code-level cryptographic lock).

---

## 2. Reconciling the Notes vs. Code Reality

The following distinctions clarify differences between manual chart observations and the coded bot logic:

| Feature | Prose / Chart Observation | Code Reality in `bot.js` |
|---|---|---|
| **Sideways Deadlock** | Stood aside manually when trapped inside a band | No explicit filter; bot simply requires a 5m wick rejection into a band to fire |
| **50% Intermediate Scalp** | Taken manually on moves > 120 pts (Nov 4 chart) | Coded Wide Highway rule: when span between medians $\ge 120$ pts, bot generates Highway 50% Median shelf |
| **Anchor Candle Extremes** | Targeted anchor high/low wick on retests | Not in code; bot targets only median bands |
| **Rolling Target on Close-Through** | Aims at near edge of next median | Originally aimed at midpoint (`m.price`); now updated to near edge (`m.lo`/`m.hi`) |
| **Limit Order Fill Guarantee** | Stated 100% fill guarantee | 1.0 pt pad improves fill probability; does not guarantee against >1 pt slippage |
| **Day Point Totals (+400, +350)** | Discretionary visual chart readings | Not in saved automated backtests; automated tests use mechanical rules |
| **Trade 1 & Trade 2 Mechanics** | Mentioned alongside median rules | Retain legacy box stop and 1:1 half-off when active |
| **HA + EMA + CCI Strategy** | Researched alongside intraday work | Purely offline research in `scripts/backtest_ha_ema_cci.js`; not active on bot |

---

## 3. Backtest References

Saved backtest files reflect index points on Dhan 1-year historical data (no option decay or brokerage included):

1. **HA + EMA + CCI (Offline Lab Script Only)**:
   - File: `docs/backtests/ha_ema_cci_cci_1794401320072.json`
   - Script: `node scripts/backtest_ha_ema_cci.js --exit=cci --tf=15 --cciLen=200 --symbol ALL`
   - NIFTY 1-year: 54 trades, 11 wins (20%), +2,216 index points (driven by 6 major trend runs).
   - MCX Crude: 37 trades, 7 wins (19%), +15 points (flat).

2. **Legacy NIFTY Engine (Pre-Refinement)**:
   - File: `docs/backtests/advanced_nifty_1794401998571.json`
   - 1-Year with old median layer: 657 trades, 290 wins, −1,642 index points. The drag was caused by standing aside between medians and wide stops.

3. **Rough Automated Wick Pass (Exploratory)**:
   - File: `docs/backtests/fib_median_1794409400311.json`
   - 249 sessions, 1,677 trades, 437 wins (26%), +3,192 index points. Used as a rough benchmark for wick rejection logic; exits differed from manual discretionary chart readings.

---

## 4. Live Session Forensic Record (11 Nov 2026)

* **Broker Account Net**: −₹3,191.50 (Dhan Client ID: `1114480301`).
* **Root Causes**:
  1. *Live price missing in state object*: Prevented underlying index 1:1 Breakeven trigger from firing on Trade 1 (morning CE rally to 25,424).
  2. *Dhan HTTP 429 Rate Limit*: Dropped the 14:15 afternoon order.
  3. *Partial Fill*: The 14:45 PE filled only 1 of 2 lots (65 units) due to unpadded limit order, gaining +₹2,734 on that single lot.
* Full incident log: `docs/SESSION_REVIEW_2026-11-11.md`.

---

## 5. Deployment & System Status

* **Host**: Oracle Cloud VM (`ubuntu@144.24.135.68`).
* **Process**: PM2 ID 0 (`trendrunner`), running `bot.js`.
* **Configuration**: `DHAN_AUTO_TRADE=true`, `DHAN_AUTO_INSTRUMENTS=NIFTY`, `DHAN_NIFTY_LOTS=2`, `REDBAR_BOT_INSTRUMENTS=NIFTY`.
* **Broker Balance**: ₹50,353.15 available cash, 0 open positions.
* **Unit Tests**: `node scripts/test_advanced_nifty_fibs.js` — 23/23 assertions passing.
