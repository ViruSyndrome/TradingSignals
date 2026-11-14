'use strict';

/**
 * Patrick Nill Futures Swing Engine (15m / 30m / 1h).
 * Patterns: "P" & "b" tight-box breakouts/breakdowns + Failed-Breakout Reclaim sweeps.
 * Designed strictly for completed bars (no repainting) and per-strategy isolation.
 */

function computeATR(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
        );
    sum += tr;
    if (i === period - 1) out[i] = sum / period;
    else if (i >= period) out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function analyzeBox(bars, startIdx, endIdx, tol) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    if (bars[i].h > hi) hi = bars[i].h;
    if (bars[i].l < lo) lo = bars[i].l;
  }
  const height = hi - lo;
  if (height <= 0) return null;

  let topTouches = 0;
  let botTouches = 0;
  let stateTop = true;
  let stateBot = true;
  const midHi = hi - height * 0.35;
  const midLo = lo + height * 0.35;

  for (let i = startIdx; i <= endIdx; i++) {
    const b = bars[i];
    if (b.h >= hi - tol && stateTop) {
      topTouches++;
      stateTop = false;
    } else if (b.l < midHi) {
      stateTop = true;
    }
    if (b.l <= lo + tol && stateBot) {
      botTouches++;
      stateBot = false;
    } else if (b.h > midLo) {
      stateBot = true;
    }
  }
  return { hi, lo, height, topTouches, botTouches };
}

function createInitialState() {
  return {
    pos: null,
    sweepPending: null,
    cooldownBarTs: 0,
    lastProcessedTs: 0,
    closedTrades: [],
  };
}

/**
 * Evaluate the latest completed bar against prior structure and manage any open position.
 * Returns { state, events: Array<object> }.
 */
function stepPatrickBar(bars, idx, state, opts = {}) {
  const tf = opts.tf || '15m';
  const mode = (opts.mode || 'ALL').toUpperCase(); // ALL | CONFIRMED_BREAKOUT | FAILED_RECLAIM | WIDE_FADE
  const singleLotTrail = Boolean(opts.singleLotTrail); // true when lots === 1 (cannot split 1/3)
  const atrArr = opts.atrArr || computeATR(bars, 14);
  const lookback = tf === '15m' ? 18 : tf === '30m' ? 14 : 10;
  const impLook = tf === '15m' ? 16 : 12;

  const events = [];
  if (idx < lookback + impLook + 5) return { state, events };
  const b = bars[idx];
  const curAtr = atrArr[idx];
  if (!curAtr || b.t <= state.lastProcessedTs) return { state, events };
  state.lastProcessedTs = b.t;

  // 1) Manage existing open position
  if (state.pos) {
    const pos = state.pos;
    const risk = pos.risk;
    let closed = false;
    let closeReason = null;

    if (pos.side === 'LONG') {
      if (b.l <= pos.sl) {
        const exitPx = Math.min(b.o, pos.sl);
        pos.realizedPts += (exitPx - pos.entry) * pos.remFrac;
        closed = true;
        closeReason = 'SL_HIT';
      } else if (singleLotTrail) {
        if (!pos.tp1Hit && b.h >= pos.entry + 1.5 * risk) {
          pos.tp1Hit = true;
          pos.sl = Math.max(pos.sl, pos.entry);
          events.push({ type: 'SL_MOVED', reason: '1.5R_BE', sl: pos.sl, barTs: b.t });
        }
        if (b.h >= pos.entry + 5.5 * risk) {
          pos.realizedPts += (5.5 * risk) * pos.remFrac;
          closed = true;
          closeReason = 'TP_5.5R';
        } else if (pos.tp1Hit && b.h >= pos.entry + 2.5 * risk) {
          let trLow = Infinity;
          for (let k = Math.max(0, idx - 10); k < idx; k++) trLow = Math.min(trLow, bars[k].l);
          if (trLow < Infinity && trLow > pos.sl) {
            pos.sl = trLow;
            events.push({ type: 'SL_MOVED', reason: '10BAR_SWING_TRAIL', sl: pos.sl, barTs: b.t });
          }
        }
      } else {
        if (!pos.tp1Hit && b.h >= pos.entry + 1.5 * risk) {
          pos.tp1Hit = true;
          pos.realizedPts += (1.5 * risk) * (1 / 3);
          pos.remFrac -= 1 / 3;
          pos.sl = Math.max(pos.sl, pos.entry);
          events.push({ type: 'PARTIAL_TP1', frac: 1 / 3, px: pos.entry + 1.5 * risk, sl: pos.sl, barTs: b.t });
        }
        if (!pos.tp2Hit && b.h >= pos.entry + 3.0 * risk) {
          pos.tp2Hit = true;
          pos.realizedPts += (3.0 * risk) * (1 / 3);
          pos.remFrac -= 1 / 3;
          pos.sl = Math.max(pos.sl, pos.entry + 1.5 * risk);
          events.push({ type: 'PARTIAL_TP2', frac: 1 / 3, px: pos.entry + 3.0 * risk, sl: pos.sl, barTs: b.t });
        }
        if (pos.tp2Hit && b.h >= pos.entry + 5.5 * risk) {
          pos.realizedPts += (5.5 * risk) * pos.remFrac;
          closed = true;
          closeReason = 'TP3_5.5R';
        } else if (pos.tp1Hit && b.h >= pos.entry + 2.5 * risk) {
          let trLow = Infinity;
          for (let k = Math.max(0, idx - 10); k < idx; k++) trLow = Math.min(trLow, bars[k].l);
          if (trLow < Infinity && trLow > pos.sl) {
            pos.sl = trLow;
            events.push({ type: 'SL_MOVED', reason: '10BAR_SWING_TRAIL', sl: pos.sl, barTs: b.t });
          }
        }
      }
    } else {
      if (b.h >= pos.sl) {
        const exitPx = Math.max(b.o, pos.sl);
        pos.realizedPts += (pos.entry - exitPx) * pos.remFrac;
        closed = true;
        closeReason = 'SL_HIT';
      } else if (singleLotTrail) {
        if (!pos.tp1Hit && b.l <= pos.entry - 1.5 * risk) {
          pos.tp1Hit = true;
          pos.sl = Math.min(pos.sl, pos.entry);
          events.push({ type: 'SL_MOVED', reason: '1.5R_BE', sl: pos.sl, barTs: b.t });
        }
        if (b.l <= pos.entry - 5.5 * risk) {
          pos.realizedPts += (5.5 * risk) * pos.remFrac;
          closed = true;
          closeReason = 'TP_5.5R';
        } else if (pos.tp1Hit && b.l <= pos.entry - 2.5 * risk) {
          let trHi = -Infinity;
          for (let k = Math.max(0, idx - 10); k < idx; k++) trHi = Math.max(trHi, bars[k].h);
          if (trHi > -Infinity && trHi < pos.sl) {
            pos.sl = trHi;
            events.push({ type: 'SL_MOVED', reason: '10BAR_SWING_TRAIL', sl: pos.sl, barTs: b.t });
          }
        }
      } else {
        if (!pos.tp1Hit && b.l <= pos.entry - 1.5 * risk) {
          pos.tp1Hit = true;
          pos.realizedPts += (1.5 * risk) * (1 / 3);
          pos.remFrac -= 1 / 3;
          pos.sl = Math.min(pos.sl, pos.entry);
          events.push({ type: 'PARTIAL_TP1', frac: 1 / 3, px: pos.entry - 1.5 * risk, sl: pos.sl, barTs: b.t });
        }
        if (!pos.tp2Hit && b.l <= pos.entry - 3.0 * risk) {
          pos.tp2Hit = true;
          pos.realizedPts += (3.0 * risk) * (1 / 3);
          pos.remFrac -= 1 / 3;
          pos.sl = Math.min(pos.sl, pos.entry - 1.5 * risk);
          events.push({ type: 'PARTIAL_TP2', frac: 1 / 3, px: pos.entry - 3.0 * risk, sl: pos.sl, barTs: b.t });
        }
        if (pos.tp2Hit && b.l <= pos.entry - 5.5 * risk) {
          pos.realizedPts += (5.5 * risk) * pos.remFrac;
          closed = true;
          closeReason = 'TP3_5.5R';
        } else if (pos.tp1Hit && b.l <= pos.entry - 2.5 * risk) {
          let trHi = -Infinity;
          for (let k = Math.max(0, idx - 10); k < idx; k++) trHi = Math.max(trHi, bars[k].h);
          if (trHi > -Infinity && trHi < pos.sl) {
            pos.sl = trHi;
            events.push({ type: 'SL_MOVED', reason: '10BAR_SWING_TRAIL', sl: pos.sl, barTs: b.t });
          }
        }
      }
    }

    if (closed) {
      const closedTrade = {
        side: pos.side,
        kind: pos.kind,
        entry: pos.entry,
        entryTs: pos.entryTs,
        exitTs: b.t,
        grossPts: +pos.realizedPts.toFixed(2),
        rMult: +(pos.realizedPts / pos.risk).toFixed(2),
        reason: closeReason,
      };
      state.closedTrades.push(closedTrade);
      events.push({ type: 'EXIT', trade: closedTrade });
      state.pos = null;
      const tfMs = tf === '15m' ? 15 * 60000 : tf === '30m' ? 30 * 60000 : 60 * 60000;
      state.cooldownBarTs = b.t + tfMs * 3;
    }
    return { state, events };
  }

  if (b.t < state.cooldownBarTs) return { state, events };

  const tryOpen = (side, kind, sl) => {
    const risk = side === 'LONG' ? b.c - sl : sl - b.c;
    if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
      state.pos = {
        side,
        kind,
        entry: b.c,
        sl,
        risk,
        entryTs: b.t,
        tp1Hit: false,
        tp2Hit: false,
        remFrac: 1.0,
        realizedPts: 0,
      };
      events.push({ type: 'ENTER', side, kind, entry: b.c, sl, risk, barTs: b.t });
      return true;
    }
    return false;
  };

  // 2) Pending Failed-Breakout Reclaim
  if (state.sweepPending) {
    const sw = state.sweepPending;
    if (idx > sw.expiresAtIdx) {
      state.sweepPending = null;
    } else if (sw.side === 'LONG') {
      sw.sweepExt = Math.min(sw.sweepExt, b.l);
      if (b.c > sw.boxLo && b.c > b.o) {
        if (tryOpen('LONG', sw.isWide ? 'WIDE_RECLAIM' : 'TIGHT_RECLAIM', sw.sweepExt - curAtr * 0.2)) {
          state.sweepPending = null;
          return { state, events };
        }
      }
    } else {
      sw.sweepExt = Math.max(sw.sweepExt, b.h);
      if (b.c < sw.boxHi && b.c < b.o) {
        if (tryOpen('SHORT', sw.isWide ? 'WIDE_RECLAIM' : 'TIGHT_RECLAIM', sw.sweepExt + curAtr * 0.2)) {
          state.sweepPending = null;
          return { state, events };
        }
      }
    }
  }

  // 3) Box structure check ending at idx - 1
  const boxStart = idx - lookback;
  const boxEnd = idx - 1;
  const box = analyzeBox(bars, boxStart, boxEnd, curAtr * 0.35);
  if (!box) return { state, events };
  const valid3Touch = (box.topTouches >= 3 && box.botTouches >= 2) || (box.botTouches >= 3 && box.topTouches >= 2);
  if (!valid3Touch) return { state, events };

  let impHi = -Infinity;
  let impLo = Infinity;
  for (let k = boxStart - impLook; k < boxStart; k++) {
    if (bars[k].h > impHi) impHi = bars[k].h;
    if (bars[k].l < impLo) impLo = bars[k].l;
  }
  const priorImpSize = impHi - impLo;
  const boxRatio = box.height / b.c;
  const isTight = box.height <= 3.2 * curAtr && boxRatio <= 0.0085 && priorImpSize >= box.height * 1.4;
  const isWide = !isTight && box.height >= 2.8 * curAtr && boxRatio <= 0.022;

  if (mode === 'ALL' || mode === 'FAILED_RECLAIM' || (mode === 'WIDE_FADE' && isWide)) {
    if (b.l < box.lo - curAtr * 0.15 && b.c >= box.lo - curAtr * 0.4) {
      if (b.c > box.lo) {
        if (tryOpen('LONG', isWide ? 'WIDE_FADE' : 'TIGHT_RECLAIM', b.l - curAtr * 0.2)) return { state, events };
      } else {
        state.sweepPending = { side: 'LONG', boxHi: box.hi, boxLo: box.lo, sweepExt: b.l, expiresAtIdx: idx + 3, isWide };
      }
    } else if (b.h > box.hi + curAtr * 0.15 && b.c <= box.hi + curAtr * 0.4) {
      if (b.c < box.hi) {
        if (tryOpen('SHORT', isWide ? 'WIDE_FADE' : 'TIGHT_RECLAIM', b.h + curAtr * 0.2)) return { state, events };
      } else {
        state.sweepPending = { side: 'SHORT', boxHi: box.hi, boxLo: box.lo, sweepExt: b.h, expiresAtIdx: idx + 3, isWide };
      }
    }
  }

  if ((mode === 'ALL' || mode === 'CONFIRMED_BREAKOUT') && isTight) {
    const pShape = (bars[boxStart - 1].c - impLo) > (impHi - bars[boxStart - 1].c);
    if (pShape && b.c > box.hi + curAtr * 0.15 && b.c > b.o) {
      const sl = Math.max(box.lo - curAtr * 0.2, b.c - Math.max(box.height, curAtr * 1.4));
      tryOpen('LONG', 'P_BREAKOUT', sl);
    } else if (!pShape && b.c < box.lo - curAtr * 0.15 && b.c < b.o) {
      const sl = Math.min(box.hi + curAtr * 0.2, b.c + Math.max(box.height, curAtr * 1.4));
      tryOpen('SHORT', 'B_BREAKDOWN', sl);
    }
  }

  return { state, events };
}

module.exports = {
  computeATR,
  analyzeBox,
  createInitialState,
  stepPatrickBar,
};
