# Red Bar Theory — Learning Guide (TrendRunner / Dr. Dev)

**Purpose:** Shareable notes so someone new can learn the **Red Bar** playbook we run on TrendRunner — not Renko, not AI Supertrend.

**Honesty:** This is a working desk adaptation of Dr. Devendra Pratap Singh’s teaching (YouTube / course family), plus how TrendRunner encodes it. It is **not** a claim of 100% mastery. NIFTY Red Bar + session Trikal is the strongest fit; BTC uses the **same Red Bar DNA** with **different clocks**. Renko / AI Renko Supertrend are separate products — we keep them out of this bot’s DNA.

---

## 1. Mindset

- Learn **how to trade structure**, not tip-chasing.
- Direction + **tight structural risk** + **session timing** beat more alerts.
- EMA overlays on TrendRunner are **chart context only**, not Red Bar DNA — they never block an entry (BTC or NIFTY, desk or bot).
- Option buying (NIFTY) fails most often from wrong direction, wide stops, theta, and fear — cured by structure + risk cap + cutoffs.

---

## 2. Core DNA — First Red Box (Trade 1 / Trade 2)

### Mark the box
- Identify the session’s **first red** on the HTF you use (often 1H after the day’s open/mark locks; NIFTY may refine on 5m).
- On BTC, the **CME / 02:30–03:30 IST Fib box is magnets only** — it is **not** the Trade 1 first-red.
- Box = that first-red bar’s **High / Low / Median** (and POB band 0.44–0.56 when used as context).

### Trade 1 — Departure
- Price **leaves the box** with conviction (closes clearly outside).
- That is the first expansion. Stop = **event structure** (shelf / box edge / sweep wick; 15m swing only as fallback) — not nearest 5m fractal noise or a made-up % comfort stop.
- Manage: partial / bank at **1:1** → BE → trail **after 1:2** on 15m structure.

### Trade 2 — Revisit / shelf
- After a real departure, price **returns to the shelf** (box H or L).
- Confirm with a **5m close back through** in trend direction (reclaim high / reject low).
- **A wick touching the shelf is NOT a Trade 2 entry.** The **5-minute candle must close** back in the trend direction across the shelf level before entering. Entering while a 5m bar is still open invites mid-air chop.
- Opposite of chasing mid-air high-of-day.
- Liquidity-sweep flavour: wick beyond H/L then **close** back — still structure, not FOMO.

### What is *not* Trade 1/2
- Fib magnets alone, Renko flips, “price looks extended”, blind counter-trend into Equinox territory (NIFTY).

---

## 3. POB — Point of Balance (Setup 1, classically SHORT)

1. **X-Candle** = first **5m red** at a **prime session open**. Do **not** buy/sell the X itself.
2. Draw **POB 0.44–0.56** on that 5m bar.
3. Wait leave → **retest of POB** → **5m close reject** (classically SHORT back below 0.44).
4. Close above **0.56** after retest → **invalid** (classic rule: no auto-flip long).
5. SL tight above POB 0.56 / reject wick — **not** the wild X high (keeps R:R).
6. Session-bounded; no overnight hope.

**Prime opens (IST):**
| Market | Primes |
|--------|--------|
| NIFTY | NSE **09:15** |
| BTC | Asia **05:30** only (London/NY = vol / liquidity awareness — not mid-zone POB X) |
| Gold (XAU) | Asia / London bullion / COMEX windows |
| NG | MCX / NYMEX windows |

**Dead hours:** Before Asia open (roughly **00:00–05:30 IST**) and after NY — **no new POB X**. Do not chase fake opens in dead liquidity.

---

## 4. Trikal — clocks matter as much as levels

Trikal is **time + auction**, not one candle magic. **NIFTY Trikal ≠ BTC Trikal.**

### NIFTY / indices (NSE day)
- Morning range ~**09:15–12:30**.
- Lunch decay ~**11:30–12:30** — stand down on fresh entries (enforced in the entry gate: WATCH only). No month/season blocks (old APR–AUG filter removed).
- **12:45 IST** London-related Trikal anchor (30m family):
  - **Breakout:** close beyond morning H/L after the box — SL on structure; do not chase if already ran → wait **shelf retest**.
  - **Reversal / trap:** red 12:45 reclaim high (sellers trapped) / green 12:45 break low (buyers trapped).
- 12:45 decisions use **closed 5m candles**, and only after the 12:45–13:15 box completes.
- Flatten failsafe ~**15:10** (operations). No hard 14:15 cutoff or point cap in code — setup quality decides.

### BTC / crypto / gold clocks (same teacher, different open bells)

BTC on TrendRunner uses **two different reference boxes** — do not conflate them:

| Box | Window (IST) | What it is | Role |
|-----|----------------|------------|------|
| **24h CME Fib / equilibrium** | **02:30–03:30** (≈ 16:00–17:00 ET CME settlement) | Daily mark-window Fib box **0 / 0.44 / 0.50 / 0.56 / 1.0** | Macro stretch + equilibrium **magnet targets** (context / TP magnets — not automatic ENTER DNA) |
| **Asia 05:30 Trikal** | **05:30–06:00** (30m Asia open X) | Intraday session Trikal candle | **Directional morning breakout** of that 30m range (desk ENTER path `btc_asia_0530_breakout`) |

- Trade **breakout of the 05:30 30m range** (and/or Red Bar after it) — **not** NSE 12:45 rules, and **not** “buy/sell the CME Fib box” as Trade 1.
- Next important marks often taught: **12:30 IST** (London), evening **17:30** / NY open — sessions hunt each other’s highs/lows.
- In a **selling** market, piercing a London high can be a **liquidity sweep**, not a fresh long breakout.
- Optional HTF: **22h / 23h “shadow candle”** structure for crypto — context filter, not a replacement for Red Bar.

### MCX Commodities clocks & 5:30 Formula (CRUDEOIL & NATURALGAS)

Commodities trade across global energy sessions (Asia, London, and New York NYMEX):

| Session Phase | Normal Days (IST) | Holiday Split Session (IST) | What it is | Role |
| :--- | :--- | :--- | :--- | :--- |
| **Morning Open** | **09:00–09:30** | *CLOSED* | 15m/30m Asian Open candle | Primary anchor Fib box (`0 / 0.44 / 0.50 / 0.56 / 1.0`) |
| **Holiday Open Fallback** | — | **17:00–17:30** (Day Open) | Opening session mark on equity holidays | Opening X-candle Fib box when 09:00 session is closed |
| **5:30 Formula Trikal Engine** | **17:30–18:00** (30m) | **17:30–18:00** (30m) | Europe/London energy open anchor | **Everyday 5:30 Formula candle (17:30 IST)**; dedicated Trikal engine evaluates 18:00–22:30 IST |
| **US NYMEX Pit Open** | **18:30 / 19:30–22:00** | **18:30 / 19:30–22:00** | US energy floor open & EIA inventory data | High-volatility commodity expansion window |
| **Session Flatten** | **23:15** | **23:15** | Pre-close risk clear | EOD auto-flatten closes open option risk before 23:30 MCX settle |

- **5:30 Formula Engine (Everyday Architecture)**:
  - At **17:30 IST** everyday, London/Europe energy markets open with massive institutional liquidity.
  - The engine tracks the **17:30–18:00 IST 30m candle**. When it closes at 18:00 IST, High, Low, and Midpoint (0.50) are locked.
  - From **18:00 to 22:30 IST**, the engine detects:
    1. **`mcx_530_breakout`**: First 5m candle closing cleanly outside the 17:30 High/Low.
    2. **`mcx_530_retest`**: After breakout, price **touches** the broken shelf, then a later 5m **bounce/reject candle** closes back through that shelf (same DNA as NIFTY afternoon shelf retest). Near-shelf proximity alone is **not** enough.
    3. **`mcx_530_reversal`**: Failed breakout that traps wicks and reclaims back inside across the 50% midpoint.
  - Stop loss: structural opposite extreme or bounce-candle extreme, floored at 15 pts (Crude) / 2.5 pts (NG).
  - Target: **2.4R (36 pts)** on Crude Oil; **2.5R** on NG.
  - **Priority**: Inside the 17:30–22:45 IST Formula window, a **triggered** Formula setup beats a still-fresh morning/holiday Trade 1 leave so Europe cannot be stolen by the open leave.
- **Decoupled from Holiday Fallback**: The 5:30 Formula is a dedicated everyday engine. On normal days, it activates at 17:30 after the morning session; on equity holidays, the 17:00–17:30 opening mark precedes the 17:30 Europe formula.
- **Decoupling from Crypto Gates**:
  - `isBtcGate = !isIndianIndex && !isMcxCommodity` — MCX does not inherit pre-Asia, CME Mark-Fib inside-box, Asia X box, or Course Confluence (200 MA / SuperTrend 10,4.1).
  - EntryGate **1% stopPct** block is BTC-only.
  - Stop resolver: MCX **does not** invent a **1.5% synthetic stop cap** on T1/T2/sweep either — structural stops only (with Crude 15 / NG 2.5 floors on Formula path).

---

## 5. Setup 3 — Rubber Band & Mean Reversion Range

- **Dr. Dev 30m 5 EMA Rubber Band**: 30m chart, 5 EMA. Price detaches (≥4 bars) then "barricade" break → mean-reversion snap.
- **Dr. Dev 5.30 Setup**: An "alert candle" whose body and wicks never touch the 5 EMA. A break of its extreme triggers an aggressive snapback to touch the 5 EMA.
- **Mean Reversion Range (Standard Error Bands — Himanshu Arora `EcxayQ9JWSc`)**:
  - **Setup (5m)**: Standard Error Bands (**50 period, multiplier 2 or 3**). Wait for a full 5m candle to close entirely outside the upper or lower band (statistical exhaustion).
  - **Execution (1m)**: 5, 15, and 50 EMAs. Enter when the 1m price and fast EMAs curl back toward the 50 EMA mean.
  - **Target**: 20–25 points on Nifty, or exit when 1m 5 EMA crosses 50 EMA. Stop loss at extreme wick.
  - **Role in Red Bar System**: Additive overlay. Acts as an **overextension filter** (prevents buying at statistical highs) and a **lunch chop filter** (11:30–12:30 IST).

---

## 6. Equinox macro (NIFTY only)

- Around vernal / autumnal turning seasons: territory vs baseline → calls-only or puts-only when season active.
- **Not** a year-round BTC rule.

---

## 7. Risk doctrine

- Stop = **structure** (candle extreme, shelf, POB edge).
- If structural distance is too wide for the product (NIFTY desk gate 0.65%; BTC desk gate 1%), **the trade is not valid yet** — wait for a tighter base / retest. Do not invent a fake tight stop mid-air.

### 1:1 de-risking ladder (operational)
- At **1:1 R**: **Leg A banks** (~50% profit), and the **remaining runner’s stop moves to Breakeven (cost)**.
- Do **not** move to BE early at +0.5R / a temporary open profit. Example: overnight BTC went ~**+0.57R** then reversed into full stop — under this rule, BE stays off until **1:1 is actually touched**, so the position keeps room for normal auction breathing.
- After BE: trail the runner **only after ~1:2**, using **15m structure** (not tick-by-tick 5m fractals).

### Rule 6 scope — **NIFTY only**
- **Rule 6** (after SL hunt, if thesis still fires ENTER and price revisits the **same entry level** within ~**90 minutes** → one cooldown waive / re-entry shot) is for **NIFTY morning session option buying**, where open wicks often hunt stops before clean 150+ point trend legs.
- **Do not apply Rule 6 to BTC** during chop / 24h crypto noise. BTC keeps the standard cooldown / DNA freshness rules and **1:1 → BE** only.
- AI Renko “Fix Your Trading” fixed 25/80 stops are a **different** playbook — TrendRunner does **not** switch Red Bar DNA to Renko fixed stops.

---

### Commodity Risk Doctrine (MCX CRUDEOIL & NG)
- **Crude Oil Stop & Target (Code & Modal Reconciled)**:
  - Stop Loss: **15 points** option SL (~15 MCX pts) floor.
  - Target: **36 points** (**2.4 R:R**). Exactly matches Dr. Dev's verified live Dhan order ticket (f_0035.jpg / f_0050.jpg). Reconciled in code via `tpMult: 2.4` in `DHAN_INSTRUMENT_SPECS.CRUDEOIL` (15 pt SL * 2.4 = 36 pt TP).
  - Contract size: 1 lot = 100 barrels. Margin needed: ~₹6,500–₹7,500 premium. Max risk at SL floor = **₹1,500**.
- **Natural Gas Stop & Target**:
  - Stop Loss: **2.5 points** option SL (~2.5 MCX pts) floor.
  - Target: **2.5 R:R** (~6.25 pts). Reconciled in code via `tpMult: 2.5` in `DHAN_INSTRUMENT_SPECS.NG`.
  - Contract size: 1 lot = 1,250 mmBtu. Margin needed: ~₹10,000–₹12,000 premium. Max risk at SL floor = **₹3,125**.
- **Contract Freshness & Rollover Guard**:
  - `CRUDEOIL NOV FUT` (573422) expires **2026-11-17** (active & liquid today).
  - `NATURALGAS NOV FUT` (574319) expires **2026-11-20** (active & liquid today).
  - `dhan_nifty_trade.js` includes an automated contract expiry guard that logs rollover warnings 3 days prior to expiry and rejects orders on expired contracts.
  - Environment overrides `DHAN_CRUDEOIL_SCRIP` and `DHAN_NG_SCRIP` allow zero-code rollover on expiration.
- **Independent 1-Loss Circuit Breakers**:
  - Crude loss pauses Crude only for the day.
  - NG loss pauses NG only for the day.
  - A win allows the instrument to continue trading.
- **Mini Contracts Reality**:
  - CRUDEOILM and NATURALGASM exist only as **Futures** on MCX; there are no liquid mini options chains.
  - Standard options buying (1 lot) requires less margin (~₹7,000) and provides defined risk (capped at ₹1,500 SL) compared to uncapped futures margin (~₹15,000).

---

## 8. What TrendRunner automates (map)

| Idea | Role |
|------|------|
| Trade 1 / Trade 2 | Core ENTER DNA |
| POB reject | Session scalp SHORT |
| Trikal 12:45 (NIFTY) | Afternoon engine |
| Asia 05:30 Trikal breakout (BTC) | Crypto session expansion (desk adaptation) |
| CME / 02:30–03:30 IST Fib box (BTC) | Macro equilibrium magnets / stretch context — not ENTER |
| MCX 09:00 / 17:00 dual-window anchor | Dynamic morning & holiday split-session commodity open |
| MCX 17:30 5:30 Formula | London/Europe energy transition shelf |
| MCX NYMEX 18:30/19:30 pit open | High-volatility commodity expansion window |
| Session sweep | Liquidity hunt continuation |
| Setup 3 / Mean Reversion | Overlay & overextension / chop filter |
| Equinox | NIFTY macro gate |
| Renko brick ruler | Noise / overextension **filter**, not entry DNA |
| Dhan NIFTY auto | Super Order + full 1:1 bank→BE (trail floor +1R after 1:2) + 15:10 flatten + **Rule 6** re-entry after a real SL only (NIFTY only). |
| Dhan MCX auto (CRUDEOIL, NG) | 1 lot option Super Order + 1:1 BE-only runner + Crude **2.4R** / NG **2.5R** stretch + 23:15 flatten + independent 1-loss pause per instrument |
| Binance BTC auto | Futures manage with same Red Bar ladder; **1:1→BE**; no Rule 6 |

---

## 9. How to study further (channel map & research evidence)

- **Trade With Dr Devendra** — main course / Trikal lives / Fix Your Trading shorts:
  - V7LoTuCZR9g: *Advanced Crude oil and Natural gas Trading strategy* — 15m MCX chart, opening X-candle Fib (0, 0.44, 0.50, 0.56, 1.0), POB bias, 2nd Red Bar shelf retest.
  - Y8NILq4BITA: *Crude Oil Trading Strategy | 5:30 Formula & MCX Research* — 17:30 IST anchor candle, 15m/30m structure reading, 5m/1m execution, 15 pt stop / 36 pt target (2.4 R:R) on Dhan option buying modal (f_0035.jpg, f_0050.jpg).
  - x9ihDIW4qXw: *Trikal Trading for Commodities - Crude Oil Expiry Special* — 8:00 PM US pit open trap zones, session transition mechanics.
  - ZUdGLvVdwkE: *Nifty & Sensex 12:45 Trikal* — 30m chart for reading London box, 5m for trade execution.
- **Himanshu Arora** (EcxayQ9JWSc): *Mean Reversion Scalping Strategy* — 5m Standard Error Bands (50, 2/3) + 1m EMA (5/15/50) snapback.

---

## 10. Learning status (honest)

| Area | Confidence |
|------|------------|
| NIFTY Red Bar T1/T2 + structural stops | High — production desk |
| NIFTY POB 09:15 + 12:45 Trikal | High |
| CRUDEOIL Red Bar T1/T2 + 5:30 Formula | High on clocks/TP; live Formula fills still proving out |
| CRUDEOIL Dhan options (15 pt SL / 36 pt TP) | High — modal + code `tpMult: 2.4` reconciled |
| NG (MCX) Red Bar + POB primes + Formula | Medium-High — same engine as Crude; 1-loss gate active |
| MCX Dual-Window (09:00/17:00) + everyday Formula priority | High — automated; Formula beats Trade 1 after 17:30 |
| MCX stop doctrine (no BTC 1.5% invent) | High — structural only after residual-cap fix |
| BTC Red Bar T1/T2 + 1:1 BE | High (same DNA) |
| BTC session clocks (Asia/London/NY) | High directionally |
| Mean Reversion Range (Standard Error Bands) | Research-only — **not** in execution pipeline |
| Renko / AI Supertrend as entry DNA | Out of scope by choice |

---

*Last updated: 2026-11-10 afternoon — residual gap closure: MCX no 1.5% stop invent, true shelf+5m bounce retest, Formula priority over Trade 1 in Europe window.*
