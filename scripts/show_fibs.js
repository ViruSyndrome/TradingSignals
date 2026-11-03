'use strict';
/**
 * CLI utility to display current day's Fib & Red Bar levels.
 *   node scripts/show_fibs.js BTCUSDT
 */
const RedBarTrend = require('../js/redbar_trend.js');

async function main() {
  const sym = process.argv[2] || 'BTCUSDT';
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=300`;
  const res = await fetch(url);
  const rows = await res.json();
  const bars = rows.map((r) => [r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
  const klines = bars.map((b) => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
  const readout = RedBarTrend.read(klines, {
    instrument: {
      id: 'BTC',
      markWindow: {
        timeZone: 'Asia/Kolkata',
        startHour: 2, startMinute: 30,
        endHour: 3, endMinute: 30,
      },
      bandStyle: 'sessionFib',
      firstRedTf: '15m',
    },
    markWindow: {
      timeZone: 'Asia/Kolkata',
      startHour: 2, startMinute: 30,
      endHour: 3, endMinute: 30,
    },
    bandStyle: 'sessionFib',
    fibLevels: [0, 0.44, 0.5, 0.56, 1],
  });

  const b = readout.currentBand || {};
  const hi = Number(b.f1 ?? b.high);
  const lo = Number(b.f0 ?? b.low);
  const range = hi - lo;
  const f44 = lo + range * 0.44;
  const f50 = lo + range * 0.50;
  const f56 = lo + range * 0.56;

  console.log(`\n========================================`);
  console.log(`   TODAY'S FIB LEVELS (${sym})`);
  console.log(`========================================`);
  console.log(`Day:                 ${b.day || 'Today'}`);
  console.log(`Fib 1.00 (Ceiling):  $${hi.toFixed(2)}`);
  console.log(`Fib 0.56 (POB Top):  $${f56.toFixed(2)}`);
  console.log(`Fib 0.50 (Fair Mid): $${f50.toFixed(2)}`);
  console.log(`Fib 0.44 (POB Bot):  $${f44.toFixed(2)}`);
  console.log(`Fib 0.00 (Floor):    $${lo.toFixed(2)}`);

  const fr = readout.firstRed1h;
  if (fr && fr.high) {
    const frRange = fr.high - fr.low;
    console.log(`\n--- FIRST RED BAR (ANCHOR BOX) ---`);
    console.log(`High:                $${fr.high.toFixed(2)}`);
    console.log(`Fib 0.56:            $${(fr.low + frRange * 0.56).toFixed(2)}`);
    console.log(`Median (50%):        $${((fr.high + fr.low) / 2).toFixed(2)}`);
    console.log(`Fib 0.44:            $${(fr.low + frRange * 0.44).toFixed(2)}`);
    console.log(`Low:                 $${fr.low.toFixed(2)}`);
  }
  console.log(`========================================\n`);
}

main().catch(console.error);
