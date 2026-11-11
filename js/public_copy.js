'use strict';

/**
 * Public-facing copy for TrendRunner Desk.
 * Internal setupKind IDs stay technical; this map is for UI / Telegram / X only.
 * No third-party educator names or course jargon in user-visible strings.
 */
const TrendRunnerCopy = {
  DESK_NAME: 'TrendRunner Desk',
  DESK_SHORT: 'Desk',

  /** setupKind → beginner-friendly labels */
  SETUP: {
    trade1_departure: {
      name: 'Breakout leave',
      tip: 'Price left the session box with a clear close. Enter with a tight structural stop.',
    },
    trade2_confirmed: {
      name: 'Shelf retest',
      tip: 'Price came back to the box edge and a 5-minute candle closed back through in trend direction.',
    },
    trade2_watch: {
      name: 'Waiting for retest',
      tip: 'Bias is set. Wait for a pullback to the shelf and a confirmed 5-minute close — do not enter on a wick alone.',
    },
    fib_bounce: {
      name: 'Median wick',
      tip: 'A 5-minute wick met a median and closed back, or cut it and flipped color. Stop is that wick. Target is the next median. The whole trade exits there.',
    },
    fib_sandwich_wait: {
      name: 'Between the medians',
      tip: 'Price is between the 09:15 median and the red-bar median. That space is the trade when a wick meets one of the lines.',
    },
    session_sweep: {
      name: 'Liquidity sweep',
      tip: 'Session highs/lows were hunted, then price closed back through. Follow the confirmed direction.',
    },
    pob_reject: {
      name: 'Mid-zone reject',
      tip: 'Price retested the middle of the session open candle and rejected. Classic short after reject below mid-zone.',
    },
    pob_reject_watch: {
      name: 'Watching mid-zone',
      tip: 'Open candle marked. Wait for leave → retest of the mid-zone → confirmed reject close.',
    },
    afternoon_1245_breakout: {
      name: 'Afternoon breakout',
      tip: 'Price expanded beyond the morning high/low after the early-afternoon session window.',
    },
    afternoon_1245_retest: {
      name: 'Afternoon retest',
      tip: 'After the afternoon breakout, price retested the morning shelf and bounced with a confirmed candle.',
    },
    afternoon_1245_reversal: {
      name: 'Afternoon reversal',
      tip: 'The early-afternoon auction trapped one side; price reclaimed and reversed.',
    },
    afternoon_1245_watch: {
      name: 'Afternoon watch',
      tip: 'Morning range locked. Watching the early-afternoon window for breakout or reversal.',
    },
    lunch_decay: {
      name: 'Lunch quiet zone',
      tip: 'Midday chop — stand aside. Wait for the afternoon window.',
    },
    setup3_rubber_band: {
      name: 'Stretch snapback',
      tip: 'Chart guide only — price stretched far from the short average. Not an auto entry by itself.',
    },
    setup3_primed: {
      name: 'Stretch building',
      tip: 'Chart guide — stretch vs the short average is building. Wait for a clearer trigger.',
    },
    trend_bias: {
      name: 'Bias only',
      tip: 'Direction lean only. Not an entry until leave, retest, sweep, or mid-zone reject prints.',
    },
    fib_pullback: {
      name: 'Near target zone',
      tip: 'Price is near mark-window levels (context). Wait for a real entry trigger.',
    },
    wait: {
      name: 'Waiting',
      tip: 'No clear setup. Stay in cash.',
    },
    btc_asia_0530_breakout: {
      name: 'Asia open breakout',
      tip: 'Breakout of the Asia open 30-minute range.',
    },
    btc_asia_0530_watch: {
      name: 'Asia open watch',
      tip: 'Asia open candle marked. Waiting for a breakout close beyond its high or low.',
    },
  },

  setupName(setupKind) {
    const k = String(setupKind || '');
    return (this.SETUP[k] && this.SETUP[k].name) || k.replace(/_/g, ' ') || 'Setup';
  },

  setupTip(setupKind) {
    const k = String(setupKind || '');
    return (this.SETUP[k] && this.SETUP[k].tip) || '';
  },

  /** Telegram / banner headline without legacy branding */
  enterHeadline(instrumentLabel, side) {
    const sideU = String(side || '').toUpperCase();
    return `ENTER NOW · ${instrumentLabel} ${sideU}`;
  },

  stateWord(actionState) {
    const s = String(actionState || '').toLowerCase();
    if (s === 'enter') return 'ENTER';
    if (s === 'watch') return 'WATCH';
    return 'WAIT';
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrendRunnerCopy;
}
if (typeof window !== 'undefined') {
  window.TrendRunnerCopy = TrendRunnerCopy;
}
