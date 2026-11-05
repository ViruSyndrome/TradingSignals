/**
 * Complete test suite for:
 * 1. Sagar's Morning Range (09:15-12:30 IST)
 * 2. Sagar's 12:45 Afternoon Engine (Reversal & Breakout)
 * 3. Dr. Dev's Equinox Macro Territory Engine (Positive vs Negative Territory)
 * 4. Dr. Dev's 5m Squeeze Pattern Engine
 */

function zonedHms(ts, tz = 'Asia/Kolkata') {
  const d = new Date(ts);
  const s = d.toLocaleString('en-US', { timeZone: tz, hour12: false });
  const parts = s.split(', ');
  const [m, day, y] = parts[0].split('/').map(Number);
  const [hour, minute, second] = parts[1].split(':').map(Number);
  const dayStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year: y, month: m, day: dayStr, hour, minute, second };
}

function computeMorningRange(bars5m, evalTs, tz = 'Asia/Kolkata') {
  if (!Array.isArray(bars5m) || !bars5m.length) return null;
  const evalHms = zonedHms(evalTs, tz);
  const targetDay = evalHms.day;

  const morningBars = bars5m.filter((b) => {
    if (b.t > evalTs) return false;
    const h = zonedHms(b.t, tz);
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
}

function detect1245AfternoonSetup(bars5m, evalTs, tz = 'Asia/Kolkata') {
  if (!Array.isArray(bars5m) || !bars5m.length) return null;
  const evalHms = zonedHms(evalTs, tz);
  const evalMins = evalHms.hour * 60 + evalHms.minute;
  const targetDay = evalHms.day;

  const morning = computeMorningRange(bars5m, evalTs, tz);
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

  // 12:45 30m bar spans 12:45 to 13:15 IST (6 5m bars)
  const window1245Bars = bars5m.filter((b) => {
    if (b.t > evalTs) return false;
    const h = zonedHms(b.t, tz);
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
    const h = zonedHms(b.t, tz);
    if (h.day !== targetDay) return false;
    const mins = h.hour * 60 + h.minute;
    return mins >= 12 * 60 + 45 && mins <= 15 * 60 + 5;
  });

  const lastBar = afternoonBars[afternoonBars.length - 1];
  const currentPrice = lastBar.c;

  // Bullish Breakout (Expansion above Morning High)
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

  // Bearish Breakout (Expansion below Morning Low)
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

  // Reversal 1: Bullish Reversal (Trap of Sellers)
  // Morning was bearish / down trend. 12:45 bar was RED.
  // Now price breaks and closes above 12:45 bar High (or 12:45 50% fib & above recent 5m swing)
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

  // Reversal 2: Bearish Reversal (Trap of Buyers)
  // Morning was bullish / up trend. 12:45 bar was GREEN.
  // Now price breaks and closes below 12:45 bar Low
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
    label: `12:45 London Candle Marked (${bar1245Color.toUpperCase()}) · Awaiting Reversal or Breakout`,
  };
}

function computeEquinoxMacro(price, instId = 'NIFTY') {
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
    label: `Equinox Baseline: ${baseline} · Territory: ${territory.toUpperCase()} (${allowedSide.replace('_', ' ')}) · ${diff >= 0 ? '+' : ''}${diff.toFixed(0)} pts (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%)`,
    allowsBullish: isPositive,
    allowsBearish: !isPositive,
  };
}

function detectSqueezePattern(bars5m, evalTs, count = 6) {
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
}

// ==========================
// RUN RIGOROUS VERIFICATION
// ==========================
console.log('--- 1. Testing Equinox Gate Rule ---');
const eqPositive = computeEquinoxMacro(24500, 'NIFTY');
console.log('Positive Territory Check:', eqPositive.territory === 'positive' && eqPositive.allowsBullish === true && eqPositive.allowsBearish === false ? 'PASS' : 'FAIL');
const eqNegative = computeEquinoxMacro(22500, 'NIFTY');
console.log('Negative Territory Check:', eqNegative.territory === 'negative' && eqNegative.allowsBullish === false && eqNegative.allowsBearish === true ? 'PASS' : 'FAIL');

console.log('\n--- 2. Testing 12:45 Afternoon Bullish Reversal ---');
// Scenario: Morning down (09:15 to 12:30: drops 24300 -> 24150)
// 12:45 to 13:15: bar1245 is RED (open 24150, low 24120, close 24130, high 24155)
// At 13:20: 5m candle breaks above 24155 to 24175
const baseTs = new Date('2026-11-04T09:15:00+05:30').getTime();
const barsRevLong = [];
let px = 24300;
// 09:15 to 12:30 (39 bars)
for (let i = 0; i < 39; i++) {
  px -= (150 / 39);
  barsRevLong.push({ t: baseTs + i * 5 * 60000, o: px + 1, h: px + 3, l: px - 2, c: px });
}
// 12:30 to 12:45 (3 bars wait)
for (let i = 39; i < 42; i++) {
  barsRevLong.push({ t: baseTs + i * 5 * 60000, o: px, h: px + 2, l: px - 2, c: px });
}
// 12:45 to 13:15 (6 bars - 12:45 30m candle RED)
// open 24150, low 24120, high 24155, close 24130
for (let i = 42; i < 48; i++) {
  px = 24150 - (i - 42) * 3;
  barsRevLong.push({ t: baseTs + i * 5 * 60000, o: px + 2, h: 24155, l: 24120, c: px });
}
// 13:20: 5m candle closes at 24175 (BREAKS 12:45 High 24155!)
barsRevLong.push({ t: baseTs + 48 * 5 * 60000, o: 24150, h: 24180, l: 24145, c: 24175 });

const revLongRes = detect1245AfternoonSetup(barsRevLong, barsRevLong[barsRevLong.length - 1].t);
console.log('Bullish Reversal Triggered:', revLongRes.triggered, 'Side:', revLongRes.side, 'Setup:', revLongRes.setupKind);
console.log('Stop Loss:', revLongRes.stopLoss, 'TP3:', revLongRes.tp3, 'RR:', revLongRes.rr.toFixed(2));
console.log('Result Check:', revLongRes.triggered && revLongRes.side === 'bullish' && revLongRes.setupKind === 'afternoon_1245_reversal' ? 'PASS' : 'FAIL');

console.log('\n--- 3. Testing 12:45 Afternoon Bullish Breakout ---');
// At 13:30, price surges past morningHigh (24300) to 24320
barsRevLong.push({ t: baseTs + 50 * 5 * 60000, o: 24290, h: 24330, l: 24285, c: 24320 });
const breakoutRes = detect1245AfternoonSetup(barsRevLong, barsRevLong[barsRevLong.length - 1].t);
console.log('Breakout Triggered:', breakoutRes.triggered, 'Side:', breakoutRes.side, 'Setup:', breakoutRes.setupKind);
console.log('Result Check:', breakoutRes.triggered && breakoutRes.side === 'bullish' && breakoutRes.setupKind === 'afternoon_1245_breakout' ? 'PASS' : 'FAIL');

console.log('\n--- 4. Testing Squeeze Detection ---');
const sqBars = [
  { t: 1, o: 24200, h: 24220, l: 24190, c: 24210 },
  { t: 2, o: 24210, h: 24215, l: 24200, c: 24208 },
  { t: 3, o: 24208, h: 24212, l: 24202, c: 24205 },
  { t: 4, o: 24205, h: 24209, l: 24203, c: 24206 },
  { t: 5, o: 24206, h: 24208, l: 24204, c: 24205 },
  { t: 6, o: 24205, h: 24207, l: 24204.5, c: 24206 },
];
const sqRes = detectSqueezePattern(sqBars, 6);
console.log('Squeeze Res:', sqRes);
console.log('Squeeze Check:', sqRes.isSqueezing ? 'PASS' : 'FAIL');
