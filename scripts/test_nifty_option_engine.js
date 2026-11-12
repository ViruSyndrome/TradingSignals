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

  console.log('\n>>> ALL TESTS PASSED! Multi-timeframe option logic verified against real exchange data. <<<\n');
}

runTest();
