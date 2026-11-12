# Red Bar Trader's Blueprint: Live Execution & Multi-Timeframe Specification

**Target Strategy:** Dr. Dev / Sagar Advanced Fib Median Intraday Options Scalper  
**Primary Instruments:** NIFTY 50 Intraday Weekly Options (CE / PE) & MCX Commodities (Crude / NG)  
**Core Principle:** "Trade like a disciplined floor scalper, not a blind script."

---

## 1. The Multi-Timeframe Framework

| Layer | Timeframe | Role & Objective | Rules |
|---|---|---|---|
| **Canvas Anchor** | **15-Minute** (NIFTY) / **30-Minute** (MCX) | Sets the structural highway, anchor medians, and session boundaries. | Drawn from the 09:15–09:30 opening candle and the first closed red bar. |
| **Setup Filter** | **5-Minute** | Identifies median retests, rejections, and structural trend. | Requires 1–2 confirmation candles. Rejects blind first-touch entries. |
| **Micro Execution** | **1-Minute** | "Trader's Eye": Verifies real-time institutional bids/asks, double bottoms/tops, and order book momentum. | Fine-tunes fill price; prevents catching falling knives. |

---

## 2. The Step-by-Step Mock Trade Narrative (The Story of a Live Trade)

### Phase 1: 09:15 – 10:00 IST — Drawing the Canvas & Marking the Highway
* **09:15 IST (Market Open)**:
  * Bot subscribes to live data feeds for `^NSEI` (Index Spot), ATM CE (e.g., `25250 CE`), and ATM PE (e.g., `25200 PE`).
  * Bot computes the Opening Gap: `Gap = 09:15 Open - Prior Day Close`.
    * If `|Gap| >= 40 pts`, calculate the **Gap Median** (50% retracement of the opening gap) and the 0.44–0.56 band.
* **09:30 IST (15m Open Candle Closes)**:
  * The 15m Opening Candle is locked.
  * **On Index Spot**: Compute 15m Day Open Median (0.50) and 0.44–0.56 band.
  * **On Option Charts (CE & PE)**: Compute 15m Opening Range (High, Low, 0.50 median).
    * *Example from Nov 12*: `25250 CE` 15m Opening Low was **₹204.15**. This level becomes the primary structural ceiling / breakdown retest target for the entire afternoon.
* **10:00 IST (First Red 15m Bar Closes)**:
  * The first closed red 15m bar *after* 09:15 is locked.
  * Bot calculates the **Red Bar Median** (0.50) and 0.44–0.56 band.
  * **Mark the Sandwich Zone**: The area between Day Open Median and First Red Bar Median.
    * **Rule**: When price is strictly *inside* the sandwich, auto-trading stands aside. Empirical study across 246 trading days proves price spends only 21.6% of time here; 78.4% of high-momentum trending runs occur *outside* the sandwich.

---

### Phase 2: Stalking the Setup (5m Filter)
* **The Context**: Price broke below the Day Open Median, trending downward. Later, during the 12:15–13:30 period, the Call Option (`25250 CE`) falls to its major support band at **₹180–₹185**.
* **13:40–13:45 IST**:
  * The 5-minute candle wicks into the ₹180 support band.
  * **What the naive bot used to do**: Blindly place a market buy on the very first touch $\rightarrow$ caught a falling wick and got stopped out.
  * **What the Trader Bot does now**:
    1. Enters state `WATCH_CONFIRMATION`.
    2. Waits for the 5m candle to close at 13:45.
    3. The 13:45 5m candle closes with a rejection wick: `Low: 180.00, Close: 183.00`. It proves buyers are defending the 180 support band!

---

### Phase 3: The "Trader's Eye" Micro Confirmation (1m Execution)
* At 13:45:12, before firing the Dhan order, the bot inspects the 1-minute chart:
  * **13:45:00**: 1m touched 180.00 and closed green at 183.00.
  * **13:46:00**: 1m dipped to 181.00 — creating a **Higher Low (Double Bottom)** on 1m!
  * **13:47:00**: 1m exploded bullish: `Open: 185.85, High: 193.95, Close: 193.45`.
* **Decision**: All three timeframes agree:
  * 15m Anchor: Major bottom support band.
  * 5m Filter: Confirmed rejection wick, closing back above the band.
  * 1m Micro: Double bottom + bullish expansion candle.
* **Execution**:
  * Bot fires Dhan SuperOrder on `25250 CE`:
    * **Entry**: Limit order @ **₹185.95**.
    * **Stop Loss Leg**: Anchored to **Previous Wick Low** (`180.00 - 2 pts buffer = ₹178.00`). Risk = 7.95 pts (~₹1,033 per 130 qty).
    * **Target Leg**: Anchored to the **15m Structural Ceiling** (the 09:15-09:30 open bar low at **₹204.15**). Reward = 18.2 pts (~₹2,366 per 130 qty, 1:2.3 RR).

---

### Phase 4: Active Trade Management (Trailing & Breakeven)
* **Minutes 1–3 (Noise Protection)**:
  * Stop loss remains strictly at ₹178.00.
  * The trailing engine is locked to prevent early-breakeven knockouts from normal bid-ask spread.
* **Minute 5 (13:50 IST — Target Hit #1)**:
  * The 1m candle blasts to **High = ₹204.85**, tagging the 15m structural target of **₹204.15**!
  * **The Trader's Eye**: The limit target order fills on exchange at **₹204.60**.
  * **Realized P&L**: **+₹2,424.50**.
  * If a manual trader had waited for index points to expand, they would have seen the option fail at 203.70 at 13:52 and collapse to 178.55 by 13:58, turning a +₹2,424 win into a loss! Taking profit at the option chart's structural level is essential.

---

---

## 4. Two-Lot Scaling: Maximizing Profit vs. Capital Preservation

A critical trader question: **Is 1:1 on Lot 1 + Runner on Lot 2 the best way to get maximum gains?**

### The Trade-off Comparison:

| Execution Model | Win Rate Character | What Happens on Full Run (e.g. +18.2 pts) | What Happens on Reversal after 1:1 (+8 pts) | Best Used For |
|---|---|---|---|---|
| **A. All-In / All-Out (130 Qty to Target)** | Lower Win% (~38–42%), higher variance | Max profit: `18.2 * 130 = ` **+₹2,366.00** | Full loss if it reverses back to SL: **-₹1,033.50** | Strong morning trending breakout days |
| **B. Banker + Runner (65 Qty @ 1:1, 65 Qty @ Target)** | Higher Win% (~65–72%), smooth equity curve | Scaled profit: `(8 * 65) + (18.2 * 65) = ` **+₹1,703.00** | Profit protected: **+₹520.00** banked, 0 loss on Leg 2 | Standard intraday scalping & choppy ranges |
| **C. Dynamic Trailing Model (The Floor Trader's Choice)** | Highest Expected Value (+EV) | If momentum is high, hold all 130 qty and trail behind 5m swing lows: **+₹2,366.00** | If momentum stalls at 1:1, bank 65 qty and lock BE on runner | **Adaptive Market Condition Engine** |

### The Bot's Optimized Two-Lot Logic:
1. **Default Mode (Banker + Runner)**:
   * Leg 1 (65 qty): Exits at **1:1 RR** (banks ~₹520).
   * **Instant Action**: Leg 2 Stop Loss is moved to **Entry Price + 0.05 (Breakeven)**.
   * Leg 2 (65 qty): Rides to the **15m Structural Target** (banks ~₹1,180).
2. **High-Momentum Override**:
   * If the 1m candle blasts through 1:1 with high volume and no rejection wick, Leg 1 does **not** dump early; the bot trails the stop loss for *both* lots to entry breakeven, aiming for maximum gains on the full 130 quantity.

---

## 5. Hard Flatten (15:10 IST): Why Exiting Early is Proven Superior

Is exiting at 15:10 IST good? Is it proven bad to let trades run until the 15:30 close?

### The Empirical & Financial Facts:
1. **The Broker Penalty Fee (₹59 Per Order)**:
   * Dhan automatically squares off all intraday (MIS) positions between **15:15 and 15:20 IST**.
   * Dhan charges an **auto-squareoff penalty of ₹50 + 18% GST (₹59.00) per order**. 
   * A 2-lot position squared off by Dhan pays an avoidable ₹59 fine directly from your profits.
2. **Terminal Theta Acceleration (The 15:15 Cliff)**:
   * On weekly options, theta decay reaches its steepest curve in the final 15 minutes. Even if NIFTY spot moves 5 points in your direction, the option premium collapses due to closing bid-ask spread and IV crush.
3. **Closing 30-Minute VWAP Distortion**:
   * The official exchange closing price of NIFTY is calculated as the **volume-weighted average price (VWAP) of the last 30 minutes (15:00–15:30)**. This calculation causes underlying spot price to lag and option premiums to get dumped by institutional closing books.
4. **Conclusion**: Exiting with a clean limit/market order at **15:10–15:12 IST** preserves profits, avoids slippage, and eliminates broker penalties.

---

## 6. Global Catalysts & Dynamic UK/Europe Daylight Savings (DST)

### The London Open Window & Daylight Savings:
* The UK / Europe open injects massive foreign institutional liquidity into Indian markets, often causing the **"Lunch Turnaround"** (e.g. today's 12:15 bottom).
* **The Daylight Savings Problem**:
  * **British Summer Time (BST)**: London opens at 08:00 BST = **12:30 IST**.
  * **Greenwich Mean Time (GMT / Winter)**: London opens at 08:00 GMT = **13:30 IST**.
* **The Bot's Solution**:
  * The bot **never hardcodes 12:30 or 13:30 IST**.
  * The bot checks the live local time in London dynamically using the standard IANA timezone:
    ```javascript
    const ukHour = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
    const isLondonOpen = (ukHour === '08'); // Automatically triggers at 12:30 IST in Summer, 13:30 IST in Winter
    ```
  * Daylight Savings is 100% automated without manual calendar updates.

---

## 7. Lean Architecture: Preventing Analysis Paralysis & Speed Optimization

The user noted: **"We must not add too many gates that no trades happen. A slow bot is also not effective."**

### A. The 4-Stage Lean Pipeline (No Gate Bloat):
Instead of 15 overlapping filters that paralyze execution, the bot runs a single lean pipeline:
1. **Stage 1 (Canvas / 15m)**: Are we outside the Sandwich? (Yes $\rightarrow$ proceed).
2. **Stage 2 (Filter / 5m)**: Did a 5m candle touch an option structural support/resistance band and close with a rejection wick? (Yes $\rightarrow$ proceed).
3. **Stage 3 (Trigger / 1m)**: Did the 1m candle print a higher low / bullish confirmation? (Yes $\rightarrow$ proceed).
4. **Stage 4 (Execution)**: Fire 2-lot SuperOrder on Dhan in under 250 milliseconds.

### B. Execution Speed & Sub-Second Latency:
* Option scalping requires speed. A 5-second delay can cost 3–6 option points.
* **Architecture Rules for Speed**:
  * In-memory cache for 1m and 5m bars updated via WebSocket / non-blocking polling.
  * Pre-calculated strike selection: ATM CE and PE security IDs are pre-fetched at 09:16 and held ready in memory.
  * Single round-trip asynchronous Dhan API order placement.


---

## 8. Trade Transitions, Cooldowns & Structural Invalidation

### Why the Old 30-Minute Cooldown is Obsolete
* The old bot used an arbitrary 30-minute timer because it was blindly knife-catching and re-entering the same failing candle 5 times.
* When executing with a **15m Anchor $\rightarrow$ 5m Confirmation $\rightarrow$ 1m Micro Structure**, an arbitrary timer is harmful: it blocks great valid setups while doing nothing to fix bad entries.

### The Replacement: "Structural Level Consumption"
1. **Level Consumption**: Once a median bounce is traded and reaches its target (or hits SL), that specific test is marked **CONSUMED**.
2. **When Can the Next Trade Enter?**:
   * **Immediately**, IF price moves to a **different structural median** (e.g. price broke through and is now retesting the next median).
   * On the **same level**, ONLY IF price pulls away by $\ge 15$ points and returns with a **completely new confirmation cycle** (a new 5m closed candle + new 1m double bottom/higher low).
   * This completely prevents rapid-fire overtrading while never missing a genuine setup on a different level.

### What Happens When Stop Loss is Hit?
1. The tested level is tagged **FAILED / BROKEN**.
2. **No Immediate Revenge Flip**: The bot does not instantly buy puts or flip direction.
3. The bot waits for:
   * Price to travel to the **Next Structural Level** (e.g. the next lower median or prior day 15:15 close), OR
   * A **Confirmed Breakdown Retest**: Price breaks below the level, pulls back to test it from underneath, and confirms rejection on 5m/1m for a high-probability PE scalp.

---

## 9. Theta Decay & Expiry Day Protocols

### A. The Mid-Day Theta Rule:
* If an option trade has been active for **> 20 minutes** without hitting 1:1, and the underlying index has moved sideways within a 5-point range:
  * The bot treats theta as the primary risk.
  * Adjusts target to Breakeven / small exit to protect capital.

### B. Expiry Day Protocol (NIFTY Expiry):
1. **Moneyness Shift**: On Expiry day, OTM strikes decay to zero rapidly and have erratic delta. **The bot strictly trades ITM or Deep ATM strikes** (Delta $\ge 0.55–0.65$).
2. **Shorter Time Horizons**: Scalps are capped at 5–15 minutes maximum.
3. **Hard Expiry Cut-off**: No 0-DTE (same day expiry) trades after **14:00 IST**. After 14:00, all new setups must be routed to the **Next Week's Expiry** contract to eliminate gamma wipeout risk.

---

## 10. Large Sample Size Statistical Findings (246 Trading Days)

From our empirical analysis of 18,254 5-minute bars across 246 trading days (Nov 2025 – Nov 2026):

1. **The Sandwich Zone (Open Median to Red Bar Median)**:
   * **Only 21.6% of time is spent inside the sandwich.**
   * Only 7.7% of days (19 out of 246) are choppy days trapped inside the sandwich for >60% of the session.
   * **Rule Confirmed**: Never initiate new trades inside the sandwich. Wait for a breakout above the Red Bar Median or a breakdown below the Open Median.
2. **Trending Expansion Days (78.4% of Market Time)**:
   * **35.8% of time is spent ABOVE the Red Bar Median**: Strong bullish expansion days where Call options run cleanly.
   * **42.5% of time is spent BELOW the Day Open Median**: Strong bearish breakdown days where Put options run cleanly.
3. **Gap Days (65.0% of Sessions)**:
   * 160 out of 246 days have gaps $\ge 40$ points.
   * On gap days, when price breaks below the open median, the **Gap Median** and **Prior Day 15:15 Median** act as high-probability magnet targets.
