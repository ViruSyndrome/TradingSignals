# Mock Trade Reference Data & Tick-by-Tick Audit — 2026-11-12

**Instrument:** `NIFTY 25250 CE` (Dhan Security ID: `45396`, NSE FNO)  
**Trade Timestamp:** 2026-11-12 13:45:12 IST  
**Trade Setup:** 15m Support Retest + 5m Rejection + 1m Double Bottom Confirmation  

---

## 1. Multi-Timeframe Canvas Data (The Reference Levels)

### 15-Minute Anchor Range (09:15 – 09:30 Opening Bar):
* `Open`: 217.85 | `High`: 269.50 | **`Low`: 204.15** | `Close`: 257.00
* **Key Structural Ceiling (TP Target)**: **₹204.15** (Breakdown Retest Target)
* **Afternoon Support Base**: **₹180.00 – ₹185.00**

### 5-Minute Confirmation Sequence (13:30 – 14:00):
| Bar Time | Open | High | Low | Close | Range | Interpretation |
|---|---|---|---|---|---|---|
| 13:30 | 187.70 | 194.10 | 182.50 | 188.00 | 11.60 | Approaching support |
| 13:35 | 187.40 | 201.55 | 183.70 | 198.60 | 17.85 | Pullback bounce |
| 13:40 | 197.25 | 202.40 | 183.85 | 184.85 | 18.55 | Red dump into support |
| **13:45** | **185.15** | **197.10** | **180.00** | **196.15** | **17.10** | **Confirmed Rejection Wick! Touched 180 support, closed at 196.15.** |
| **13:50** | **196.35** | **204.85** | **196.35** | **201.50** | **8.50** | **Target Leg Tagged! High=204.85 (kisses 204.15 target).** |
| 13:55 | 195.45 | 199.10 | 178.55 | 179.95 | 20.55 | Reversal collapse after target hit |

---

## 2. The 1-Minute Micro Execution Log (13:40 – 13:55)

| Minute | Open | High | Low | Close | Event / Action |
|---|---|---|---|---|---|
| 13:40 | 197.25 | 202.00 | 194.30 | 202.00 | Consolidation |
| 13:41 | 200.85 | 202.40 | 196.60 | 197.55 | Sellers press down |
| 13:42 | 196.25 | 196.85 | 190.75 | 191.25 | Breaching 195 |
| 13:43 | 191.05 | 195.20 | 189.65 | 190.65 | Approaching 185 support |
| 13:44 | 190.35 | 192.45 | 183.85 | 184.85 | Testing support boundary |
| **13:45** | **185.15** | **189.55** | **180.00** | **183.00** | **Taps ₹180.00 bottom support. Rejection wick forms.** |
| **13:45:12** | — | — | — | — | **BUY ORDER PLACED @ ₹185.95** (2 Lots = 130 qty) |
| **13:46** | **184.65** | **187.80** | **181.00** | **185.10** | **Higher Low (Double Bottom confirmed on 1m)!** |
| **13:47** | **185.85** | **193.95** | **185.45** | **193.45** | **Bullish breakout candle! High=193.95 tags 1:1 TP!** |
| 13:48 | 192.50 | 195.65 | 189.55 | 195.65 | Momentum holds |
| 13:49 | 195.20 | 197.10 | 192.30 | 196.15 | Approaching 15m structural target |
| **13:50** | **196.35** | **204.85** | **196.35** | **201.50** | **TARGET HIT #1: Blasts to 204.85! (Target was 204.15).** |
| **13:50:33** | — | — | — | — | **EXIT EXECUTED @ ₹204.60** (+₹2,424.50 profit) |
| 13:51 | 200.35 | 201.70 | 196.75 | 196.95 | Retest pullback |
| **13:52** | **197.05** | **203.70** | **196.80** | **201.80** | **TARGET HIT #2: Double Top ceiling test at 203.70!** |
| 13:53 | 201.80 | 201.80 | 189.55 | 189.55 | Buyers exhausted; aggressive sell-off |
| 13:54 | 188.70 | 196.65 | 187.65 | 196.65 | Dead-cat bounce |
| 13:58 | 186.70 | 187.00 | **178.55** | 181.65 | **Crashes to 178.55 (-26 pts from target)!** |

---

## 3. Two-Lot Scaling Math (1:1 Sell Half + Runner)

If trading **2 lots (130 qty)** with the professional 1:1 scaling model:

* **Entry**: 130 qty @ **₹185.95**
* **Initial Stop Loss**: **₹178.00** (anchored below 13:45 wick low of 180.00 - 2 pts buffer).
  * Risk per unit = `185.95 - 178.00 = 7.95 pts`.
  * Total Initial Risk = `7.95 * 130 = ₹1,033.50`.
* **Lot 1 (65 qty) — The 1:1 Banker**:
  * 1:1 Target Price = `185.95 + 7.95 = ₹193.90`.
  * Hit at **13:47:00** (1m high was 193.95).
  * Exits 65 qty @ 193.90 $\rightarrow$ **Banked Profit: +₹516.75**.
  * **Action at 1:1**: Move Stop Loss on Lot 2 to **Breakeven (₹186.00)**. Total downside risk is now **₹0.00**.
* **Lot 2 (65 qty) — The Structural Runner**:
  * Target Price = **₹204.15** (15m structural breakdown low).
  * Hit at **13:50:00** (1m high was 204.85).
  * Exits 65 qty @ 204.15 $\rightarrow$ **Banked Profit: +₹1,183.00**.
* **Total Combined P&L (2 Lots)**:
  * `₹516.75 + ₹1,183.00 = ` **+₹1,699.75** (with zero risk after minute 2).
