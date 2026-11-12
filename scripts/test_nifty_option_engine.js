const fs = require('fs');
const assert = require('assert');
const {
  parseDhanOhlc,
  computeOptionCanvas,
  check1mMicroConfirmation,
  calculateOptionLevels,
} = require('../js/nifty_option_engine');

function runTest() {
  console.log('=== Running NIFTY Option Engine Unit Test ===\n');

  if (!fs.existsSync('today_option_candles.json')) {
    console.error('today_option_candles.json not found');
    process.exit(1);
  }

  const rawData = JSON.parse(fs.readFileSync('today_option_candles.json', 'utf8'));
  const rawCe = rawData['25250 CE'];
  assert(rawCe, '25250 CE candles missing');

  const bars = parseDhanOhlc(rawCe);
  console.log(`Parsed ${bars.length} 5-minute bars for 25250 CE.`);
  assert.strictEqual(bars.length, 77, 'Expected 77 5m bars');

  // Test 1: 15m Canvas
  const canvas = computeOptionCanvas(bars, '2026-11-12');
  console.log('\n--- Test 1: 15-Minute Canvas ---');
  console.log('Open Bar High:', canvas.openBarHigh);
  console.log('Open Bar Low (Ceiling):', canvas.openBarLow);
  console.log('Open Bar Median:', canvas.openBarMedian);
  assert.strictEqual(canvas.openBarLow, 204.15, 'Open Bar Low must be 204.15');

  // Test 2: Micro Structure Analysis at 13:40 (Bearish plunge without rejection)
  // Bar 53 is 13:40 (O: 197.25, H: 202.4, L: 183.85, C: 184.85)
  const slice1340 = bars.slice(0, 54);
  const micro1340 = check1mMicroConfirmation(slice1340);
  console.log('\n--- Test 2: Micro Structure at 13:40 ---');
  console.log('Confirmed:', micro1340.confirmed);
  console.log('Wick Ratio:', micro1340.curWickRatio + '%');
  console.log('Reason:', micro1340.reason);
  assert.strictEqual(micro1340.confirmed, false, '13:40 must NOT confirm entry (bearish drop)');

  // Test 3: Micro Structure Analysis at 13:45 (Rejection wick bounce from 180 support)
  // Bar 54 is 13:45 (O: 185.15, H: 197.1, L: 180, C: 196.15)
  const slice1345 = bars.slice(0, 55);
  const micro1345 = check1mMicroConfirmation(slice1345);
  console.log('\n--- Test 3: Micro Structure at 13:45 ---');
  console.log('Confirmed:', micro1345.confirmed);
  console.log('Pattern:', micro1345.triggerPattern);
  console.log('Wick Ratio:', micro1345.curWickRatio + '%');
  console.log('Reason:', micro1345.reason);
  assert.strictEqual(micro1345.confirmed, true, '13:45 MUST confirm entry');

  // Test 4: Structural Option Levels Calculation
  const levels = calculateOptionLevels({
    currentPremium: 186.00,
    optionCanvas: canvas,
    microAnalysis: micro1345,
    bufferPts: 2.0,
  });
  console.log('\n--- Test 4: Option Levels Calculation ---');
  console.log('Entry Price:', levels.entryPrice);
  console.log('Stop Loss:', levels.stopLossPrice, `(Risk: ${levels.riskPts} pts)`);
  console.log('1:1 Banker TP1:', levels.tp1Banker);
  console.log('15m Target TP:', levels.tpTarget, `(Reward: ${levels.rewardPts} pts)`);
  console.log('Risk/Reward Ratio:', levels.rrRatio);

  assert.strictEqual(levels.entryPrice, 186.00);
  assert.strictEqual(levels.stopLossPrice, 178.00); // 180.00 low - 2.0 buffer
  assert.strictEqual(levels.riskPts, 8.00);
  assert.strictEqual(levels.tp1Banker, 194.00); // 186 + 8
  assert.strictEqual(levels.tpTarget, 204.15); // Exactly the 15m structural open low!
  assert.strictEqual(levels.rewardPts, 18.15); // 204.15 - 186.00
  assert.strictEqual(levels.rrRatio, 2.27); // 18.15 / 8 = 2.27 RR

  // Test 5: True 1-minute (1m) option candle tests + risk clamp boundaries [4, 14]
  console.log('\n--- Test 5: 1-Minute Bars & [4, 14] SL Clamp Tests ---');
  // 5a: Tiny green doji making higher low without >=25% body or >=20% wick must NOT confirm
  const bars1mDoji = [
    { t: 1794477900000, o: 192.0, h: 193.0, l: 190.0, c: 190.5, v: 5000 },
    { t: 1794477960000, o: 190.5, h: 192.5, l: 190.2, c: 190.6, v: 4000 }, // body=0.10 (<25% of 2.3), wick=0.30 (13%)
  ];
  const microDoji = check1mMicroConfirmation(bars1mDoji);
  assert.strictEqual(microDoji.confirmed, false, 'Weak 1m upper-wick green doji must NOT confirm');

  // 5b: Red dump right after prior bar's 35% wick must NOT trigger stale prev wick alone
  const bars1mFailedHold = [
    { t: 1794477900000, o: 192.0, h: 193.0, l: 189.0, c: 190.5, v: 5000 }, // 37.5% lower wick
    { t: 1794477960000, o: 190.4, h: 190.5, l: 187.0, c: 187.2, v: 9000 }, // Lower low red flush
  ];
  const microFail = check1mMicroConfirmation(bars1mFailedHold);
  assert.strictEqual(microFail.confirmed, false, 'Red lower-low bar must invalidate prior wick');

  // 5c: Real 1m buyer rejection wick confirms cleanly + risk clamps to min 4 pts and max 14 pts
  const bars1mConfirm = [
    { t: 1794477900000, o: 191.0, h: 192.0, l: 189.0, c: 189.5, v: 5000 },
    { t: 1794477960000, o: 189.5, h: 192.0, l: 188.0, c: 191.8, v: 8500 }, // 1m rejection + green close above prev close
  ];
  const microOk = check1mMicroConfirmation(bars1mConfirm);
  assert.strictEqual(microOk.confirmed, true, '1m bullish rejection bar must confirm');

  const tightClamp = calculateOptionLevels({
    currentPremium: 189.0,
    optionCanvas: canvas,
    microAnalysis: { signalLow: 188.5 }, // raw risk = 189 - (188.5 - 2) = 2.5 -> clamps to 4.0
    bufferPts: 2.0,
  });
  assert.strictEqual(tightClamp.riskPts, 4.00, 'Minimum option risk clamp must be 4.00 pts');
  assert.strictEqual(tightClamp.stopLossPrice, 185.00);

  const wideClamp = calculateOptionLevels({
    currentPremium: 190.0,
    optionCanvas: canvas,
    microAnalysis: { signalLow: 170.0 }, // raw risk = 190 - 168 = 22 -> clamps to 14.0
    bufferPts: 2.0,
  });
  assert.strictEqual(wideClamp.riskPts, 14.00, 'Maximum option risk clamp must be 14.00 pts');
  assert.strictEqual(wideClamp.stopLossPrice, 176.00);
  console.log('1m strict gating & [4, 14] risk clamp assertions PASSED.');

  console.log('\n>>> ALL TESTS PASSED! Multi-timeframe option logic verified on 5m canvas + 1m confirmation & clamps. <<<\n');
}

runTest();
