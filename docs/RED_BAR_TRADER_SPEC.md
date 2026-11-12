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

## 4. Two-Lot Scaling Architecture (1:1 Sell Half + Runner)

A single bracket order cannot partially exit on Indian exchanges. The professional institutional method is **Two-Order Coordinated Execution**:

```mermaid
flowchart LR
    A["Entry Trigger (130 Qty / 2 Lots)"] --> B["Leg 1: Banker (65 Qty)<br/>Target = 1:1 Risk-Reward<br/>SL = Previous Wick Low"]
    A --> C["Leg 2: Runner (65 Qty)<br/>Target = 15m Structural Ceiling<br/>SL = Previous Wick Low"]
    B -- "Hits 1:1 TP" --> D["Bank +₹516.75 Profit<br/>INSTANT ACTION: Move Leg 2 SL to Breakeven"]
    D --> E["Leg 2 is now 100% Risk-Free<br/>Rides to 15m Structural Target"]
    E -- "Hits 204.15 TP" --> F["Bank +₹1,183.00 on Runner<br/>Total Profit = +₹1,699.75"]
```

### The Exact Mathematical Logic:
* **Entry**: 130 qty @ **₹185.95**
* **Initial SL**: **₹178.00** (anchored to previous wick low). Risk per unit = **7.95 pts**.
* **Order 1 (Banker - 65 qty)**:
  * Limit TP placed at `Entry + 1R = 185.95 + 7.95 = ₹193.90`.
  * Triggered at 13:47 (1m candle reached 193.95).
  * Profit banked: **+₹516.75**.
  * **Event Trigger**: When Order 1 fills, the bot immediately calls Dhan `modifyOrder` on Order 2, adjusting its Stop Loss price to **₹186.00 (Breakeven + 0.05 buffer)**.
* **Order 2 (Runner - 65 qty)**:
  * Limit TP placed at **₹204.15** (15m Open Bar Low / structural target).
  * Triggered at 13:50 (1m candle reached 204.85).
  * Profit banked: **+₹1,183.00**.
  * Total Net P&L: **+₹1,699.75** (Zero risk after minute 2).

---

## 5. Trade Transitions, Cooldowns & Structural Invalidation

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

## 6. Time Windows, Timing Gates & Global Market Catalysts

### A. Intraday Session Gates:
* **09:15 – 09:30 IST**: **NO TRADES ALLOWED**. 
  * The 15-minute opening candle is forming. Let high-frequency algorithms settle.
* **09:30 – 10:00 IST**: **AWAIT FIRST RED BAR**.
  * No directional trades until the First Closed 15m Red Bar is established.
* **10:00 – 11:30 IST**: **Prime Morning Window**.
  * Trend expansion outside the Sandwich. Highest momentum of the day.
* **11:30 – 12:30 IST**: **Lunch Theta Zone**.
  * High decay, low volume. Strict 1:1 quick scalp rule; reduce position size or hold times.
* **14:45 IST**: **LAST TRADE GATE**.
  * No new positions initiated after 14:45 IST.
* **15:10 IST**: **HARD FLATTEN**.
  * Close all remaining open intraday positions before broker auto-squareoff.

### B. International Market Catalysts & Their Indian Impact:
1. **Asian / Gift Nifty (06:30 – 07:30 IST)**:
   * Sets morning index sentiment and dictates the 09:15 opening gap.
   * Captured by our **Gap Fib Median** ($\ge 40$ pts).
2. **Europe / UK Market Open (12:30 – 13:30 IST / London opens 13:00 IST)**:
   * **The 12:30–13:15 London Liquidity Injection**:
   * European cash markets open at 12:30–13:00 IST. Foreign institutional desks execute cross-asset rebalancing.
   * **The "Lunch Turnaround"**: A morning trend in NIFTY often stalls or reverses during this exact window. Today, NIFTY bottomed at 12:15, and London's open fueled the afternoon consolidation and CE bounces.
3. **US Cash Market Open (19:00 IST)**:
   * The primary volume driver for **MCX Crude Oil and Natural Gas**. 
   * Morning and afternoon MCX setups are pre-runs; the massive trending impulse on Crude/NG almost always ignites between 19:00 and 21:30 IST.

---

## 7. Theta Decay & Expiry Day Protocols

### A. The Mid-Day Theta Rule:
* If an option trade has been active for **> 20 minutes** without hitting 1:1, and the underlying index has moved sideways within a 5-point range:
  * The bot treats theta as the primary risk.
  * Adjusts target to Breakeven / small exit to protect capital.

### B. Expiry Day Protocol (NIFTY Expiry):
1. **Moneyness Shift**: On Expiry day, OTM strikes decay to zero rapidly and have erratic delta. **The bot strictly trades ITM or Deep ATM strikes** (Delta $\ge 0.55–0.65$).
2. **Shorter Time Horizons**: Scalps are capped at 5–15 minutes maximum.
3. **Hard Expiry Cut-off**: No 0-DTE (same day expiry) trades after **14:00 IST**. After 14:00, all new setups must be routed to the **Next Week's Expiry** contract to eliminate gamma wipeout risk.


---

## 8. Large Sample Size Statistical Findings (246 Trading Days)

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
