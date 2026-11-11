# Reviewer brief — 11 Nov 2026

Two strategies. They are not mixed. Data is Dhan, saved in `.cache_desk`. Yahoo is not used.

Hand this file first. The other notes are the lab book and the live option day.

---

## 1. What the NIFTY bot does now

NIFTY only. The fill is still an option, 2 lots. The stop and the target are decided on the index. BANKNIFTY, Sensex, Crude, and the HA + EMA + CCI research were not changed.

Lines drawn each morning:

- Median band of the 09:15 candle (44% to 56% of that candle).
- Median band of the first red candle, only after that candle has closed.
- Gap median, only when yesterday’s close and today’s open are at least 40 points apart.
- Yesterday’s session median.

The space between the 09:15 median and the red-bar median is the trade.

Entry: a 5-minute wick meets one of those bands and the close comes back through it, or the wick cuts the band and the candle flips color. When that signal is fresh, it is taken ahead of Trade 1.

Stop: the wick of that candle.

Target: the next median, even when that distance is shorter than the stop. The option is not halved at 1:1.

How it leaves:

- The wick tags the target and the candle closes back. The whole option is closed.
- The candle closes through the target. The same trade now aims at the next median.
- The candle closes through and the color flips. This trade closes, and the new trade can open on that candle.
- A candle of the other color that never takes the line does not close the trade.
- If no median is left in front, the trade stays on until a later close comes back through the entry median, or the 15:10 flatten.

Trade 1, Trade 2, and the afternoon setups are still in the bot. They run only when there is no fresh median wick. Their older stop (box midpoint) and 1:1 half-off were not rewritten.

The bot process that is already running does not pick this up until it is restarted.

Check: `node scripts/test_advanced_nifty_fibs.js`

---

## 2. Backtests to review

These three runs are kept so they can be checked and changed. None of them is an option-premium result. None of them includes brokerage. “Per lot” means one NIFTY futures lot, 65 rupees per index point. It is a sketch of the index, not a Dhan statement.

### A. HA + EMA + CCI (research, not on the bot)

15-minute. Heikin Ashi only for the EMA stack (20 / 50 / 200). CCI length 200 on the regular close. Enter on the close where CCI steps through +100 or −100, and only if the stack was already true on the previous bar. Skip a violent cross (jump of 25 or more, or a close more than 15 points through the line) and skip 09:15. Exit when CCI closes back through the same line. Not flattened at 15:30.

File: `docs/backtests/ha_ema_cci_cci_1794401320072.json`  
Script: `node scripts/backtest_ha_ema_cci.js --exit=cci --tf=15 --cciLen=200 --symbol ALL`

| Market | Window | Trades | Wins | Points | Sketch, 1 lot, no fees |
|---|---|---|---|---|---|
| NIFTY | 11 Nov 2025 – 11 Nov 2026 | 54 | 11 (20%) | +2,216 | ₹1,44,014 |
| Crude | 20 Jul 2026 – 11 Nov 2026 | 37 | 7 (19%) | +15 | ₹1,500 |

Most of the NIFTY points are six trades that ran. Crude is flat. The quiet-filter levels were read off this same year. An older table with CCI 20 and about 50% wins was the wrong test. Do not use it.

### B. Old NIFTY engine, before tonight

This replay is the bot as it was: Trade 1, Trade 2, afternoon setups, a median bounce that refused the space between the two medians, a stop beyond the whole fib, and a 1:1 target when the next median was closer than the stop. Index points. Exit on the stop, the first target, or 15:10.

File: `docs/backtests/advanced_nifty_1794401998571.json`  
Script: `node scripts/backtest_advanced_nifty.js`

| Window | Trades | Wins | Points |
|---|---|---|---|
| 28 Oct – 11 Nov 2026, fib layer on | 25 | 11 | +113 |
| Same 14 days, fib layer off | 19 | 13 | +273 |
| 14 Nov 2025 – 11 Nov 2026, fib layer on | 657 | 290 | −1,642 |
| Same year, fib layer off | 510 | 244 | −471 |

The loss sat in the old median bounce: 414 trades, −1,468 points. That bounce is not the rule in section 1.

### C. Rough wick pass

This was a first machine pass at the chart reading. It is not section 1, and it is not what the bot will do. It sold the whole trade on the first touch of the next median, so 4 Nov’s short was closed at 11:00 instead of 12:15. It held one trade at a time, so several of the 11 Nov trades never opened. It also took early pokes the charts skipped.

File: `docs/backtests/fib_median_1794409400311.json`  
Script: `node scripts/backtest_fib_median.js`

249 sessions, 1,677 trades, 437 wins (26%), +3,192 index points. Sketch ₹2,07,480 per futures lot before fees. Average win +64, average loss −20. Useful only as a draft to correct. Do not treat +3,192 as the strategy.

The chart check that draft failed:

| Day | What the chart showed | What this draft did |
|---|---|---|
| 4 Nov | Short 09:55 to 12:15. Long 12:15 to 14:55. | Short closed at 11:00 (+109). Long from 12:25 to 14:55 (+111). Extra small losses before 09:55. |
| 6 Nov | Long off the open, midday reds are not shorts. | One long 09:25 to the 15:25 close, +527. |
| 11 Nov | 09:25 long ran to the 09:40 high, then a short, then another long. | 09:25 long closed at 09:30 for +20. The 09:45 short and 10:05 long never opened. 12:25 short to the gap median, +97. |
| 3 Aug | One long, reds are pauses. The date was matched from the candles and has not been confirmed. | One long to the close, +224. |

---

## 3. Live option account, 11 Nov 2026

The only broker number in this pack. Full note: `docs/SESSION_REVIEW_2026-11-11.md`.

Net **−₹3,191.50**. The index went the right way in the morning and in the afternoon. The morning call reached its old 1:1 and the stop was not moved to entry, because a price field was missing. The afternoon put was sold early. One later order was rejected by Dhan (too many requests). The last retest filled 1 of 2 lots and hit its target.

---

## 4. Other files

| File | What it is |
|---|---|
| `docs/STRATEGY_LEARNING_2026-11-11.md` | Lab notes. Section C is test A. Section D is the rule now on the bot. Section H is test B. |
| `docs/redbar-learning-guide.md` | The older Red Bar playbook: first red box, Trade 1, Trade 2, and the 1:1 half-off. That half-off still applies to Trade 1 and Trade 2. It does not apply to the median wick. |
| `docs/SESSION_REVIEW_2026-11-11.md` | The real option day. |
| `docs/MCX_SESSION_REVIEW_2026-11-10.md` | A separate Crude and natural-gas day. Not part of these two NIFTY tests. |
