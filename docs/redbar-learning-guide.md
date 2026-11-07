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

---

## 5. Setup 3 — Rubber Band (overlay)

- 30m chart, **5 EMA**: price detaches (≥4 bars) then “barricade” break → mean-reversion snap.
- On TrendRunner this is often **WATCH / overlay** until policy allows ENTER — not core Red Bar DNA.

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

## 8. What TrendRunner automates (map)

| Idea | Role |
|------|------|
| Trade 1 / Trade 2 | Core ENTER DNA |
| POB reject | Session scalp SHORT |
| Trikal 12:45 (NIFTY) | Afternoon engine |
| Asia 05:30 Trikal breakout (BTC) | Crypto session expansion (desk adaptation) |
| CME / 02:30–03:30 IST Fib box (BTC) | Macro equilibrium magnets / stretch context — not ENTER |
| Session sweep | Liquidity hunt continuation |
| Setup 3 | Overlay |
| Equinox | NIFTY macro gate |
| Renko brick ruler | Noise / overextension **filter**, not entry DNA |
| Dhan NIFTY auto | Super Order + full 1:1 bank→BE (trail floor +1R after 1:2) + 15:10 flatten + **Rule 6** re-entry after a real SL only (NIFTY only). Same Red Bar gates as the desk — no extra Dhan-only time/bounce filters. |
| Binance BTC auto | Futures manage with same Red Bar ladder; **1:1→BE**; no Rule 6 |

---

## 9. How to study further (channel map)

- **Trade With Dr Devendra** — main course / Trikal lives / Fix Your Trading shorts.
- **Dr Devendra : The Renko King** — mostly **Renko** pedagogy; also hosts the short **05:30 Trikal for BTC/Gold/Crude**. Useful for Renko depth; **not** required to trade Red Bar on TrendRunner.

---

## 10. Learning status (honest)

| Area | Confidence |
|------|------------|
| NIFTY Red Bar T1/T2 + structural stops | High — production desk |
| NIFTY POB 09:15 + 12:45 Trikal | High |
| BTC Red Bar T1/T2 + 1:1 BE | High (same DNA) |
| BTC session clocks (Asia/London/NY) + no dead-hour chasing | High directionally |
| BTC 05:30 30m Trikal breakout encoding | Medium — adapted from teaching; watch live / refine |
| 23h shadow candle automation | Low — researched, not core bot yet |
| Renko / AI Supertrend as entry DNA | Out of scope by choice |

**100%?** No. Good enough to trade NIFTY Red Bar carefully and to stop treating BTC like NIFTY 12:45. Keep learning from charts + live sessions; change code only when the rule is clear.

---

*Last updated: 2026-11-06 — TrendRunner desk notes (added: BTC dual boxes, Trade 2 closed-candle rule, 1:1 ladder, Rule 6 NIFTY-only).*
