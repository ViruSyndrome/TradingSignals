# Strategy Learning — 2026-11-11

**Two strategies only (desk framing):**

1. **HA + EMA + CCI** — NIFTY **futures** + Crude **futures** (swing-capable, not options, not forced same-day flat)  
2. **Advanced NIFTY Red Bar** — NIFTY only for now (options book stays Red Bar DNA; fib-median enhancements are the “advanced” layer)

**Do not mash (1) into (2) live auto** until each lane is locked and approved.  
**Data:** Dhan `.cache_desk` only. **No Yahoo.**

**Read `docs/REVIEWER_BRIEF_2026-11-11.md` first.** That is the page to hand a reviewer. Section D is the NIFTY rule now on the bot. Sections C and H are earlier backtests, kept so they can be checked and changed.

---

## A. What “+26.4R / positive expectancy” meant (plain)

Those numbers were **not broker ₹ profit**.

| Term | Meaning |
|---|---|
| **R** | Multiple of **risk at entry** (we sized risk ≈ 1×ATR). A +2R win = made twice what we risked. A −1R loss = lost the risk amount. |
| **Sum R** | All trade Rs added up. **+26R** over ~166 trades ≈ edge in risk units, not “₹26”. |
| **Win% ~40% with 1:2 TP** | Math can still be green: many small losses, fewer larger wins. |
| **Positive expectancy** | Average trade was slightly positive in R. Research signal — **not** a live P&L claim. Fees/slippage not included. |

With your **CCI reverse-cross exit** (below), numbers are clearer in points and an **illustrative** 1-lot ₹ sketch.

---

## B. Why NIFTY options session was bad (Nov 11)

Direction was mostly right. Money lost on **execution / wiring**:

1. Morning CE: index cleared **1:1**; BE never armed (`_instTrendState.price` missing) → hard SL  
2. Afternoon PE: chopped before structure target → SL  
3. 14:15 retest: **Dhan 429**  
4. 14:45 retest: only **1/2 lots** filled → TP saved the day partially  
5. Forensic goof risk: **Yahoo ≠ bot/Dhan prints** (already burned us once)

MCX alert-only Crude/NG signals were clean winners the same day.

---

## C. Strat 2 — HA + EMA + CCI (research only, not live)

Sagar’s charts look like a clean trend: EMA stack already lined up, CCI leaves ±100 and stays out, price runs, exit when CCI comes back through the same line. That picture is real on a few days. A year of Dhan 15-minute bars does not turn it into a strategy that wins most of the time.

**Earlier tables in this file that showed ~50% wins and thousands of points were the wrong test** (CCI length 20, HLC3, a 3-candle delay, Yahoo-era mixes). Do not use them. The numbers below are the locked rules.

### Locked rules

| Piece | Rule |
|---|---|
| Chart | 15-minute. Heikin Ashi only for the EMA stack. Regular candle **close** for CCI and for the fill. |
| Data | Dhan `.cache_desk` only. No Yahoo. |
| Stack | LONG: HA close > EMA20 > EMA50 > EMA200. SHORT: the reverse. True on the prior bar and on the signal bar. |
| CCI | Length **200**. Source = regular close. Not HLC3 (9 Feb 2026 09:15 was a false +100 on HLC3; the close CCI was 99.6, inside the box). |
| Entry | The close where CCI first steps through +100 (long) or −100 (short). No extra confirmation candles. After an exit, the next cross is a new entry even if the stack never broke. |
| Quiet filter | Jump under 25 and the close finishes less than 15 past the line. Skip the first bar of the day, including 09:15. This refuses gap smashes. |
| Exit | Next close back through the **same** level. Not the opposite ±100. Not ATR. |
| Instrument | Futures. Not options. Not forced flat at the cash close. |

### What the winners and losers actually were (NIFTY, unfiltered book, 81 trades)

The six large winners (29 Oct +2,215, 11 Mar +686, 11 May +335, 8 Jan +165, 30 Sep +140, 15 Sep +104) were quiet steps: CCI was already near the line and closed only a little through it. They then held 31–207 bars. Stack age did not separate them.

Losses were three kinds:

1. **Smash / 09:15.** Knowable at entry. The quiet filter removes these (9 Mar −423, 28 Sep gap, 8 Apr smash).
2. **Poke.** One or two candles, then CCI steps back. At the entry close these look the same as 29 Oct. Filtering them also deletes the trends.
3. **Giveback.** Price turns while CCI is still outside ±100, so the exit waits. Worst: 10 Apr Friday 15:00 long, Monday gap, −453. Leaving when the HA close lost EMA20 cut 29 Oct from +2,215 to +93 and the year from +2,216 points to +358. That exit was rejected.

### Backtest of the quiet rule

Report: `docs/backtests/ha_ema_cci_cci_1794401320072.json`. One lot, no fees. NIFTY ₹65/point, Crude ₹100/point.

| | Window | Trades | Wins | Points | Left in the bank |
|---|---|---|---|---|---|
| NIFTY | 11 Nov 2025 – 11 Nov 2026 | 54 | 11 (20%) | **+2,216** | **₹1,44,014** |
| Crude | 20 Jul 2026 – 11 Nov 2026 | 37 | 7 (19%) | **+15** | **₹1,500** |

NIFTY: the 11 winners made ₹2,40,780. The 43 losers gave back ₹96,765. About one trade a week. Losers last ~30 minutes. Winners last about a day or more. Crude is flat: one +458-point short paid for almost every other trade.

**Why it felt positive with Sagar and does not as a book.** The charts were the trades that ran. Those exist. They are 6 of 54 NIFTY trades. The other 48 are mostly failed starts that the chart conversation never lingered on. Crude does not pay. Not wired into the live bot.

---

## D. Strat 1 — Advanced NIFTY Red Bar (NIFTY only)

### Options entries — two kinds (learning)

| Kind | Meaning | Character |
|---|---|---|
| **A — “It will go up/down”** | Directional CE/PE | Needs **speed**; **theta**; lower win rate if late |
| **B — “It will not go that way”** | Boundary / shelf invalidation | Less prediction; often **higher win rate** |

### What is new, and what is now applied

Applied on the live NIFTY path only. Trade 1, Trade 2, and Trikal were not removed. BANKNIFTY, SENSEX, and Crude were not changed.

| Piece | Applied |
|---|---|
| First bar of the day | 09:15 **5m** high/low, fib median (0.44–0.56) |
| First red bar | The first red candle *after* 09:15. If 09:15 is red, skip it (it's the Day Open Bar); wait for the next closed red candle to mark the First Red Bar |
| Gap fib | Only when the open gaps **≥ 40** NIFTY points from the prior close |
| Prior session median | The 15:15–15:45 mark median, kept |
| Between the two medians | That space is the trade. The bot does not stand aside there. We only stand aside if price is deadlocked sideways *inside* a single median band without a rejection wick. |
| Entry | A 5m wick meets a median band (0.44–0.56) and closes back through it, or cuts the band and the candle flips color. This is checked before Trade 1. |
| Stop | The wick of that candle (tight structural risk: 10–25 index points). Not the middle of the red box. Not the far end of the fib. |
| Target (Take Profit Hierarchy) | **1. Highway Target**: Entrance line of the next median band (0.44 lower boundary for longs, 0.56 upper boundary for shorts) so front-running never leaves us unfilled.<br/>**2. Halfway Shelf Target (Scalp)**: 50% retracement midpoint of prior impulse on wide (>120 pt) swings.<br/>**3. Anchor Extreme**: High or Low wick of the anchor candle on retests. |
| After the target | Wick tags the median and the close comes back: the whole option is closed. Close stays through: same trade, target rolls to next median. Close through and the color flips: this trade closes and the new one can open on that candle. A candle of the other color that never takes the line does not close the trade. |
| No median left | Hold. Exit only if a later close comes back through the entry median, or at the 15:10 flatten. |
| Fill | Still the NIFTY option. Stop and target are decided on the index. |

### Pattern from your 5th / 6th / 8th / 11th charts

The trade is a 5-minute wick meeting a median: the 09:15 candle, the first red candle, the gap when it is at least 40 points, and the prior session median. The space between the 09:15 median and the red-bar median is the trip from one line to the other. Stop is the wick. Target is the next median.

### Still open

1. Trade 1 and Trade 2, when no median wick is fresh, still use the older box stop and the 1:1 half-off.
2. The option order’s own target is a stretch, so a wick through the median does not sell the option. The closed 5-minute candle does. That needs a live session to confirm the flatten actually fires.
3. Two stop-outs in the morning still pause the morning. A reviewer may want that changed.  

### SL rule (locked learning)

**Stop reference = NIFTY futures (or index) 5m structure — never the option premium candle chart.**

---

## H. Strat 1 tested — old engine, before the wick rules (index path, 2026-11-11)

This replay is the bot **before** tonight’s change: Trade 1, Trade 2, the old median bounce, 1:1, and the sandwich block. It is kept so a reviewer can see that version. It is not the rule now on the bot. The +3,192 file is a separate rough pass and is also not the live rule. Both are described in the reviewer brief.

`node scripts/backtest_advanced_nifty.js`  
Report: `docs/backtests/advanced_nifty_1794401998571.json`

This walks the **live engine** on Dhan 15m bars (5m for the stop/target path). One position at a time. Exit is the index stop, tp1, or the 15:10 flatten, whichever the 5m bars hit first. If stop and target print on the same 5m candle, it is counted as the stop. **These are index points, not option premium.** A +176 index run is not +176 in the option.

| Window | Layer | Trades | Wins | Win% | Index points | Sum R |
|---|---|---|---|---|---|---|
| Last 14 days (28 Oct – 11 Nov 2026) | **Applied (fibs on)** | 25 | 11 | 44% | **+113** | **−2.4R** |
| Last 14 days | DNA only, fibs off | 19 | 13 | 68% | +273 | +6.8R |
| One year (14 Nov 2025 – 11 Nov 2026) | **Applied (fibs on)** | 657 | 290 | 44% | **−1,642** | **−28R** |
| One year | DNA only, fibs off | 510 | 244 | 48% | −471 | −14R |

About **2 to 3 trades a trading day** with the new layer on. The year is about 657 trades.

Where the year went, with the layer that is live now:

| Setup | Trades | Wins | Points |
|---|---|---|---|
| `fib_bounce` (the new one) | 414 | 169 | **−1,468** |
| Trade 1 | 104 | 53 | −219 |
| Trikal retest | 55 | 20 | −145 |
| Trikal breakout | 46 | 24 | −11 |
| Trikal reversal | 14 | 6 | −30 |
| Trade 2 | 24 | 18 | **+231** |

`fib_bounce` is most of the damage. Over the year it took 215 full stops (−9,537 points) against 116 targets (+6,216) and 83 flatten exits (+1,858). The colliding-median target is often smaller than the stop, so a 44% win rate still loses. The sandwich stood aside on 418 bars. It also sat in front of Trade 2 and the afternoon breakout, which were green when the new layer was off (Trade 2 +312, breakout +212, reversal +184 on the DNA-only year). DNA-only is still a losing year (−471), mostly Trade 1 and the Trikal retest.

Last 14 days with the layer on, the +113 points came from Trade 2 (+66), Trikal, and one 11 Nov short that flattened at 15:10 for +176. `fib_bounce` itself was 11 trades, 3 wins, **+9 points**, with eight −1R stops. Points were green and R was red because several targets paid less than the stop.

**Reading:** this is the old engine, index points, not the option account. The sandwich block and the 1:1 fallback in this test are no longer what the NIFTY bot does. Do not quote −1,642 as the rule that is live now.

## E. Strat 1 wiring (2026-11-11) — NIFTY only

Wired into live path (options fill; **index 5m** SL/TP prices):

| Piece | Status |
|---|---|
| `advancedFibs` on NIFTY config | On (`advancedFibGapPts: 40`) |
| First-bar / red / gap / prior medians | Engine + desk paint |
| Between the medians | Tradable. Not a block. |
| Median wick entry | ACTIONABLE, and it is preferred over Trade 1 when the wick is fresh |
| SL | Signal-candle wick |
| TP | Next median, full exit. No 1:1 bank on these trades. |
| BANKNIFTY / Crude / CCI | Untouched |

Tests: `node scripts/test_advanced_nifty_fibs.js`

## F. Can we apply without mashing?

| | Now | Later |
|---|---|---|
| HA+EMA+CCI (Strat 2 Crude) | Script + Dhan cache only | Futures profile separate — **not** inside NIFTY Red Bar |
| Advanced NIFTY Red Bar (Strat 1) | **Applied** — engine + desk + bot auto allow-list | Monitor live; tighten gap/TF if needed |
| Live options auto | Median wick on NIFTY: wick stop, next-median target, band between the medians is tradable. Trade 1 still runs when no fresh wick is there. | No HA/CCI mash |

---

## G. Checklist — prior prompt points

| Your point | Answered? |
|---|---|
| Session review / why NIFTY bad | Yes — §B |
| HA+EMA+CCI rules + backtest | Yes — §C (quiet step; older +5,000-pt table withdrawn) |
| What did +R mean / is it profit? | Yes — §A |
| CCI reverse-cross exit + capitalize stretch | Yes — §C (exit coded; peak bank ideas listed for next test) |
| Futures, not intraday-forced | Yes — hold across sessions until CCI exit |
| Options two entry kinds | Yes — §D |
| First-bar fib / gap fib / medians / no-trade between | Yes — §D table |
| Prior-day median magnets | Yes — §D |
| Pattern from screenshots | Yes — §D |
| SL on futures 5m | Yes — §D |
| Two strats only | Yes — header |
| Apply without mashing | Yes — §E |
| Document | This file, `REVIEWER_BRIEF_2026-11-11.md`, and the pointer in `redbar-learning-guide.md` |

Re-run:

```bash
node scripts/backtest_ha_ema_cci.js --exit=cci --tf=15 --cciLen=200 --symbol ALL
node scripts/backtest_advanced_nifty.js
node scripts/backtest_fib_median.js
```
