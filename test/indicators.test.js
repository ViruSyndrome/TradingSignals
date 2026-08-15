const assert = require('assert');
const Indicators = require('../js/indicators.js');

function testSMA() {
  const data = [10, 11, 12, 13, 14, 15, 16];
  const sma = Indicators.sma(data, 3);
  
  // First 2 should be null
  assert.strictEqual(sma[0], null);
  assert.strictEqual(sma[1], null);
  
  // sma[2] = (10+11+12)/3 = 11
  assert.strictEqual(sma[2], 11);
  
  // sma[6] = (14+15+16)/3 = 15
  assert.strictEqual(sma[6], 15);
  console.log('✅ SMA test passed');
}

function testLast() {
  const arr = [1, null, 2, 3, null];
  assert.strictEqual(Indicators.last(arr), 3);
  console.log('✅ Last element test passed');
}

try {
  testSMA();
  testLast();
  console.log('All tests passed successfully!');
} catch (e) {
  console.error('Test failed:', e);
  process.exit(1);
}
