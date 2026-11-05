/**
 * Patch js/redbar_trend.js with:
 * 1. computeMorningRange, detect1245AfternoonSetup, computeEquinoxMacro, detectSqueezePattern
 * 2. Update _resolveStopAndBook for afternoon_1245_reversal and afternoon_1245_breakout
 * 3. Update readAt to compute equinox, afternoon1245, squeeze5m, and wire setups
 * 4. Update ACTIONABLE_SETUPS and entryGate with Equinox Macro rule & 12:45 setup rules
 */

const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../js/redbar_trend.js');
let src = fs.readFileSync(filePath, 'utf8');

// 1. Add helper methods before _resolveStopAndBook:
const target1 = `  _resolveStopAndBook({`;

const methodsToAdd = `  /**
   * Sagar's 12:45 Strategy: Morning Session Range (09:15 - 12:30 IST)
   * Defines Asian session boundary: Morning High, Morning Low, and 50% Mid.
   */
  computeMorningRange(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const targetDay = evalHms.day;

    const morningBars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 9 * 60 + 15 && mins < 12 * 60 + 30;
    });

    if (!morningBars.length) return null;

    let morningHigh = -Infinity;
    let morningLow = Infinity;
    for (const b of morningBars) {
      if (b.h > morningHigh) morningHigh = b.h;
      if (b.l < morningLow) morningLow = b.l;
    }
    const morningMid = (morningHigh + morningLow) / 2;
    const lastMorningBar = morningBars[morningBars.length - 1];
    const morningBias = lastMorningBar.c >= morningMid ? 'bullish' : 'bearish';

    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const locked = evalMins >= 12 * 60 + 30;

    return {
      day: targetDay,
      morningHigh,
      morningLow,
      morningMid,
      morningBias,
      barCount: morningBars.length,
      locked,
    };
  },

  /**
   * Sagar's 12:45 Afternoon Engine for NIFTY / Indian Indices:
   * - Phase 1: 09:15 - 12:30 Morning Asian Phase (Morning Range)
   * - Chop: 11:30 - 12:30 Lunch decay zone (avoid new entries)
   * - Phase 2: 12:45 London Open 30m Candle Anchor
   *   Reversal: 12:45 candle swept morning H/L, and 5m closes back across 12:45 High/Low
   *   Breakout: 5m expansion beyond morning range with London volume
   */
  detect1245AfternoonSetup(bars5m, evalTs, tz = 'Asia/Kolkata') {
    if (!Array.isArray(bars5m) || !bars5m.length) return null;
    const evalHms = this.zonedHms(evalTs, tz);
    const evalMins = evalHms.hour * 60 + evalHms.minute;
    const targetDay = evalHms.day;

    const morning = this.computeMorningRange(bars5m, evalTs, tz);
    if (!morning || !morning.locked) {
      if (evalMins >= 11 * 60 + 30 && evalMins < 12 * 60 + 30) {
        return {
          status: 'lunch_decay',
          setupKind: 'lunch_decay',
          side: null,
          triggered: false,
          label: 'Lunch Decay Zone (11:30–12:30 IST) · No fresh entries · Wait for 12:45 London Open',
          morning,
        };
      }
      return null;
    }

    if (evalMins < 12 * 60 + 45) {
      return {
        status: 'awaiting_1245',
        setupKind: 'awaiting_1245',
        side: null,
        triggered: false,
        label: 'Awaiting 12:45 IST London Open Candle · Morning Range Locked',
        morning,
      };
    }

    // 12:45 30m candle (12:45 to 13:15 IST)
    const window1245Bars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 12 * 60 + 45 && mins < 13 * 60 + 15;
    });

    if (!window1245Bars.length) return null;

    const bar1245Open = window1245Bars[0].o;
    let bar1245High = -Infinity;
    let bar1245Low = Infinity;
    for (const b of window1245Bars) {
      if (b.h > bar1245High) bar1245High = b.h;
      if (b.l < bar1245Low) bar1245Low = b.l;
    }
    const bar1245Last = window1245Bars[window1245Bars.length - 1];
    const bar1245Close = bar1245Last.c;
    const bar1245Mid = (bar1245High + bar1245Low) / 2;
    const bar1245Color = bar1245Close >= bar1245Open ? 'green' : 'red';

    const afternoonBars = bars5m.filter((b) => {
      if (b.t > evalTs) return false;
      const h = this.zonedHms(b.t, tz);
      if (h.day !== targetDay) return false;
      const mins = h.hour * 60 + h.minute;
      return mins >= 12 * 60 + 45 && mins <= 15 * 60 + 5;
    });

    const lastBar = afternoonBars[afternoonBars.length - 1];
    const currentPrice = lastBar.c;

    // Bullish Breakout
    if (currentPrice > morning.morningHigh) {
      const stopLoss = Math.max(bar1245Low, morning.morningMid);
      const risk = Math.abs(currentPrice - stopLoss);
      return {
        setupKind: 'afternoon_1245_breakout',
        side: 'bullish',
        triggered: true,
        triggerPrice: currentPrice,
        triggerTs: lastBar.t,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: currentPrice + risk,
        tp2: currentPrice + risk * 2,
        tp3: currentPrice + risk * 3,
        rr: 3,
        label: '12:45 Afternoon Bullish Breakout · Clean Expansion Above Morning High',
      };
    }

    // Bearish Breakout
    if (currentPrice < morning.morningLow) {
      const stopLoss = Math.min(bar1245High, morning.morningMid);
      const risk = Math.abs(stopLoss - currentPrice);
      return {
        setupKind: 'afternoon_1245_breakout',
        side: 'bearish',
        triggered: true,
        triggerPrice: currentPrice,
        triggerTs: lastBar.t,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1: currentPrice - risk,
        tp2: currentPrice - risk * 2,
        tp3: currentPrice - risk * 3,
        rr: 3,
        label: '12:45 Afternoon Bearish Breakout · Clean Expansion Below Morning Low',
      };
    }

    // Bullish Reversal: Sellers trapped in red 12:45 candle
    if (bar1245Color === 'red' && currentPrice > bar1245High) {
      const recentLows = afternoonBars.slice(-6).map((b) => b.l);
      const stopLoss = Math.min(bar1245Low, ...recentLows);
      const risk = Math.abs(currentPrice - stopLoss);
      const tp1 = currentPrice + risk;
      const tp2 = currentPrice + risk * 2;
      const tp3 = Math.max(morning.morningMid, currentPrice + risk * 3);
      return {
        setupKind: 'afternoon_1245_reversal',
        side: 'bullish',
        triggered: true,
        triggerPrice: currentPrice,
        triggerTs: lastBar.t,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rr: risk > 0 ? (tp3 - currentPrice) / risk : 2,
        label: 'Dr. Dev Trikal 12:45 Bullish Reversal · London Open Auction Trap · Sellers Trapped',
      };
    }

    // Bearish Reversal: Buyers trapped in green 12:45 candle
    if (bar1245Color === 'green' && currentPrice < bar1245Low) {
      const recentHighs = afternoonBars.slice(-6).map((b) => b.h);
      const stopLoss = Math.max(bar1245High, ...recentHighs);
      const risk = Math.abs(stopLoss - currentPrice);
      const tp1 = currentPrice - risk;
      const tp2 = currentPrice - risk * 2;
      const tp3 = Math.min(morning.morningMid, currentPrice - risk * 3);
      return {
        setupKind: 'afternoon_1245_reversal',
        side: 'bearish',
        triggered: true,
        triggerPrice: currentPrice,
        triggerTs: lastBar.t,
        bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
        morning,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rr: risk > 0 ? (currentPrice - tp3) / risk : 2,
        label: 'Dr. Dev Trikal 12:45 Bearish Reversal · London Open Auction Trap · Buyers Trapped',
      };
    }

    return {
      status: 'watching_afternoon',
      setupKind: 'afternoon_1245_watch',
      side: null,
      triggered: false,
      bar1245: { high: bar1245High, low: bar1245Low, color: bar1245Color, mid: bar1245Mid },
      morning,
      label: \`12:45 London Candle Marked (\${bar1245Color.toUpperCase()}) · Awaiting Reversal or Breakout\`,
    };
  },

  /**
   * Dr. Devendra Pratap Singh: Equinox Macro Territory Engine
   * Locks Vernal (March 20-21) and Autumnal (Sept 22-23) mean baseline levels.
   * - Above baseline: POSITIVE TERRITORY -> Calls only, Puts forbidden.
   * - Below baseline: NEGATIVE TERRITORY -> Puts only, Calls forbidden.
   */
  computeEquinoxMacro(price, instId = 'NIFTY') {
    const baseline = Number(process.env.NIFTY_EQUINOX_LEVEL) || 22860;
    const isPositive = price >= baseline;
    const territory = isPositive ? 'positive' : 'negative';
    const allowedSide = isPositive ? 'CALLS_ONLY' : 'PUTS_ONLY';
    const diff = price - baseline;
    const diffPct = (diff / baseline) * 100;

    return {
      baseline,
      territory,
      allowedSide,
      distancePts: diff,
      distancePct: diffPct,
      label: \`Equinox Baseline: \${baseline} · Territory: \${territory.toUpperCase()} (\${allowedSide.replace('_', ' ')}) · \${diff >= 0 ? '+' : ''}\${diff.toFixed(0)} pts (\${diffPct >= 0 ? '+' : ''}\${diffPct.toFixed(1)}%)\`,
      allowsBullish: isPositive,
      allowsBearish: !isPositive,
    };
  },

  /**
   * Dr. Devendra Pratap Singh: 5m Squeeze Pattern (Volatility Compression & Expansion)
   * Detects wedge / corridor contraction in 5m candles and projects breakout impulse targets.
   */
  detectSqueezePattern(bars5m, evalTs, count = 6) {
    if (!Array.isArray(bars5m) || bars5m.length < count) return null;
    const recent = bars5m.slice(-count);
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (const b of recent) {
      if (b.h > highestHigh) highestHigh = b.h;
      if (b.l < lowestLow) lowestLow = b.l;
    }
    const height = highestHigh - lowestLow;
    const lastBar = recent[recent.length - 1];
    const currentPrice = lastBar.c;

    const isCompressing = height < (currentPrice * 0.0035);
    const brokenUp = currentPrice > highestHigh;
    const brokenDown = currentPrice < lowestLow;

    return {
      isSqueezing: isCompressing && !brokenUp && !brokenDown,
      brokenUp,
      brokenDown,
      squeezeHigh: highestHigh,
      squeezeLow: lowestLow,
      squeezeHeight: height,
      projectedTargetUp: highestHigh + height,
      projectedTargetDown: lowestLow - height,
    };
  },

  _resolveStopAndBook({`;

if (!src.includes('computeMorningRange')) {
  src = src.replace(target1, methodsToAdd);
}

// 2. Add afternoon_1245 handling to _resolveStopAndBook
const targetStopBook = `    // Dr. Devendra Pratap Singh Setup 3: 30m 5 EMA Rubber Band`;
const afternoonStopBookCode = `    // Sagar's 12:45 Afternoon Engine (Reversal & Breakout)
    if (setupKind === 'afternoon_1245_reversal' || setupKind === 'afternoon_1245_breakout') {
      const isReversal = setupKind === 'afternoon_1245_reversal';
      const stopPad = price * 0.0004;
      let sp = trend === 'bullish'
        ? (levels?.stopLoss ?? (price - price * 0.004)) - stopPad
        : (levels?.stopLoss ?? (price + price * 0.004)) + stopPad;
      const riskDist = Math.abs(price - sp);
      const tp1 = trend === 'bullish' ? price + riskDist : price - riskDist;
      const tp2 = trend === 'bullish' ? price + riskDist * 2 : price - riskDist * 2;
      const tp3 = trend === 'bullish' ? price + riskDist * 3 : price - riskDist * 3;
      const stopPct = (riskDist / price) * 100;
      const targetPct = (Math.abs(tp3 - price) / price) * 100;
      return {
        invalidation: sp,
        invalidationReason: isReversal ? '12:45 reversal 5m swing stop' : '12:45 breakout 5m candle stop',
        stopStructural: true,
        tp1,
        tp2,
        tp3,
        bookZone: tp3,
        firstMagnet: { price: tp2, label: '1:2R Partial' },
        bookReason: isReversal ? 'Dr. Dev Trikal 12:45 London Open Reversal' : 'Dr. Dev Trikal 12:45 London Breakout',
        bookIsMagnet: true,
        stopPct,
        targetPct,
        rr: 3.0,
        rrLadder: true,
        prevSwingLow: trend === 'bullish' ? sp : null,
        prevSwingHigh: trend === 'bearish' ? sp : null,
      };
    }

    // Dr. Devendra Pratap Singh Setup 3: 30m 5 EMA Rubber Band`;

if (!src.includes("setupKind === 'afternoon_1245_reversal'")) {
  src = src.replace(targetStopBook, afternoonStopBookCode);
}

// 3. Update readAt: compute equinox, afternoon1245, squeeze5m
const targetReadAt = `    const pobReject = xCandle5m
      ? this.detectPobReject(xCandle5m, bars5m, evalTs, c.touchPct ?? 0.15, pobOpts)
      : null;`;

const afterPobCode = `    const pobReject = xCandle5m
      ? this.detectPobReject(xCandle5m, bars5m, evalTs, c.touchPct ?? 0.15, pobOpts)
      : null;

    // Dr. Dev Equinox Macro Territory
    const equinox = this.computeEquinoxMacro(price, instId);

    // Sagar 12:45 Afternoon Engine & Dr. Dev 5m Squeeze
    const afternoon1245 = (bars5m && instId === 'NIFTY')
      ? this.detect1245AfternoonSetup(bars5m, evalTs)
      : null;
    const squeeze5m = (bars5m && instId === 'NIFTY')
      ? this.detectSqueezePattern(bars5m, evalTs)
      : null;`;

if (!src.includes('const equinox = this.computeEquinoxMacro')) {
  src = src.replace(targetReadAt, afterPobCode);
}

// 4. Update setupKind logic in readAt to prioritize afternoon1245 triggers
const targetSetupKind = `    } else if (pobReject && pobReject.triggered && pobReject.side) {
      trend = pobReject.side;
      setupKind = 'pob_reject';`;

const afterSetupKindCode = `    } else if (afternoon1245 && afternoon1245.triggered && afternoon1245.side) {
      trend = afternoon1245.side;
      setupKind = afternoon1245.setupKind;
    } else if (pobReject && pobReject.triggered && pobReject.side) {
      trend = pobReject.side;
      setupKind = 'pob_reject';`;

if (!src.includes('afternoon1245.triggered')) {
  src = src.replace(targetSetupKind, afterSetupKindCode);
}

// 5. Update setupTriggerTs and setupTriggerPrice
const targetTriggerTs = `    const setupTriggerTs0 = (setupKind === 'session_sweep' && sweep?.triggerTs != null)
      ? sweep.triggerTs
      : (setupKind === 'pob_reject' && pobReject?.triggerTs != null)
        ? pobReject.triggerTs
        : (setupKind === 'setup3_rubber_band' && setup3?.triggerTs != null)
          ? setup3.triggerTs
          : (redSetup.triggerTs || null);`;

const afterTriggerTsCode = `    const setupTriggerTs0 = (setupKind === 'session_sweep' && sweep?.triggerTs != null)
      ? sweep.triggerTs
      : (setupKind === 'pob_reject' && pobReject?.triggerTs != null)
        ? pobReject.triggerTs
        : (setupKind === 'setup3_rubber_band' && setup3?.triggerTs != null)
          ? setup3.triggerTs
          : (setupKind === 'afternoon_1245_reversal' || setupKind === 'afternoon_1245_breakout')
            ? afternoon1245?.triggerTs
            : (redSetup.triggerTs || null);`;

if (!src.includes("setupKind === 'afternoon_1245_reversal' || setupKind === 'afternoon_1245_breakout')\n            ? afternoon1245?.triggerTs")) {
  src = src.replace(targetTriggerTs, afterTriggerTsCode);
}

// 6. Pass afternoon1245 & equinox into entryGate
const targetEntryGate = `      revisitRead: redSetup.revisitRead || null,
      tpHint: (setupKind === 'pob_reject' && pobReject?.tpHint != null) ? pobReject.tpHint : null,
    });`;

const afterEntryGateCode = `      revisitRead: redSetup.revisitRead || null,
      tpHint: (setupKind === 'pob_reject' && pobReject?.tpHint != null) ? pobReject.tpHint : null,
      equinox,
    });`;

if (!src.includes('equinox,\n    });')) {
  src = src.replace(targetEntryGate, afterEntryGateCode);
}

// 7. Pass equinox, afternoon1245, squeeze5m into playbook & return object
const targetPlaybook = `      sweep,
      setupKind,`;

const afterPlaybookCode = `      sweep,
      setupKind,
      equinox,
      afternoon1245,
      squeeze5m,`;

if (!src.includes('afternoon1245,\n      squeeze5m,\n      triggerTs: setupTriggerTs')) {
  src = src.replace(targetPlaybook, afterPlaybookCode);
}

// Return object
const targetReturn = `      phase,
      isXCandleTrap:`;

const afterReturnCode = `      phase,
      equinox,
      afternoon1245,
      squeeze5m,
      isXCandleTrap:`;

if (!src.includes('equinox,\n      afternoon1245,\n      squeeze5m,\n      isXCandleTrap:')) {
  src = src.replace(targetReturn, afterReturnCode);
}

// 8. Update ACTIONABLE_SETUPS
const targetActionable = `  ACTIONABLE_SETUPS: ['trade1_departure', 'trade2_confirmed', 'session_sweep', 'pob_reject'],`;
const afterActionable = `  ACTIONABLE_SETUPS: ['trade1_departure', 'trade2_confirmed', 'session_sweep', 'pob_reject', 'afternoon_1245_reversal', 'afternoon_1245_breakout'],`;

src = src.replace(targetActionable, afterActionable);

// 9. Update entryGate to enforce Equinox Macro rule & 12:45 setup rules
const targetGateStart = `  entryGate({
    trend, setupKind, rr, stopStructural, invalidationReason, stopPct, renko, clock,
    asOfTs, instrumentId, season, setupTriggerTs, entryPrice, stopPrice, livePrice,
    revisitRead, tpHint,
  }) {`;

const afterGateStart = `  entryGate({
    trend, setupKind, rr, stopStructural, invalidationReason, stopPct, renko, clock,
    asOfTs, instrumentId, season, setupTriggerTs, entryPrice, stopPrice, livePrice,
    revisitRead, tpHint, equinox = null,
  }) {
    // Dr. Dev Equinox Macro Rule:
    // Positive territory: Calls only, Puts forbidden.
    // Negative territory: Puts only, Calls forbidden.
    if (equinox && equinox.territory && String(instrumentId || '').toUpperCase() === 'NIFTY') {
      if (equinox.territory === 'positive' && trend === 'bearish') {
        return {
          state: 'watch',
          reason: \`Blocked by Macro Equinox Rule: NIFTY is in Positive Territory (above Equinox Baseline \${equinox.baseline}). Puts are strictly forbidden — trade Calls only on dips/breakouts.\`,
        };
      }
      if (equinox.territory === 'negative' && trend === 'bullish') {
        return {
          state: 'watch',
          reason: \`Blocked by Macro Equinox Rule: NIFTY is in Negative Territory (below Equinox Baseline \${equinox.baseline}). Calls are strictly forbidden — trade Puts only.\`,
        };
      }
    }`;

if (!src.includes('Blocked by Macro Equinox Rule')) {
  src = src.replace(targetGateStart, afterGateStart);
}

// In entryGate why map:
const targetWhyMap = `        trade2_watch: 'H1→M5 Trade 2: wait for 1H high/low liquidity sweep, then 5m close back through that level (median confluence).',`;
const afterWhyMap = `        trade2_watch: 'H1→M5 Trade 2: wait for 1H high/low liquidity sweep, then 5m close back through that level (median confluence).',
        lunch_decay: 'Lunch Decay Zone (11:30–12:30 IST) — High theta burn, low volatility. Stand aside and wait for 12:45 London Open setup.',
        afternoon_1245_watch: '12:45 London Candle Marked — Awaiting 5m breakout or liquidity reversal trap.',`;

if (!src.includes('Lunch Decay Zone (11:30–12:30 IST)')) {
  src = src.replace(targetWhyMap, afterWhyMap);
}

// In entryGate realFiveMinSwing:
const targetSwingCheck = `const realFiveMinSwing = (/5m swing|extreme drop wick|extreme rally wick/i.test(stopTag)) && !/too close|floor|default|0\\.28%|0\\.5%/i.test(stopTag);`;
const afterSwingCheck = `const realFiveMinSwing = (/5m swing|extreme drop wick|extreme rally wick|12:45 reversal|12:45 breakout/i.test(stopTag)) && !/too close|floor|default|0\\.28%|0\\.5%/i.test(stopTag);`;

src = src.replace(targetSwingCheck, afterSwingCheck);

fs.writeFileSync(filePath, src, 'utf8');
console.log('Successfully patched js/redbar_trend.js');
