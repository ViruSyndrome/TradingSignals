const fs = require('fs');

const bars15 = require('../.cache_desk/NIFTY_15m.json');
const bars5 = require('../.cache_desk/NIFTY_5m.json');

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function calcFibs(high, low) {
  const range = high - low;
  return {
    low,
    high,
    range,
    f0: low,
    f44: low + 0.44 * range,
    f50: low + 0.50 * range,
    f56: low + 0.56 * range,
    f1: high,
  };
}

// Group bars by day
const daysMap15 = new Map();
for (const b of bars15) {
  const d = fmtDate(b.t);
  if (!daysMap15.has(d)) daysMap15.set(d, []);
  daysMap15.get(d).push(b);
}

const daysMap5 = new Map();
for (const b of bars5) {
  const d = fmtDate(b.t);
  if (!daysMap5.has(d)) daysMap5.set(d, []);
  daysMap5.get(d).push(b);
}

const sortedDays = [...daysMap15.keys()].sort();
console.log(`Analyzing ${sortedDays.length} trading days...`);

let totalDays = 0;
let gapDaysCount = 0;
let insideSandwichBars = 0;
let aboveRedBarBars = 0;
let belowDayOpenBars = 0;
let totalIntradayBars = 0;

// Statistics on directional runs
const stats = {
  sandwichChopDays: 0,
  cleanTrendDays: 0,
  breakoutAboveRedDays: 0,
  breakdownBelowOpenDays: 0,
  gapBounceDays: 0,
};

const dayResults = [];

for (let di = 1; di < sortedDays.length; di++) {
  const day = sortedDays[di];
  const prevDay = sortedDays[di - 1];
  const b15 = daysMap15.get(day) || [];
  const prevB15 = daysMap15.get(prevDay) || [];
  const b5 = daysMap5.get(day) || [];

  if (b15.length < 10 || prevB15.length < 10) continue;
  totalDays++;

  // Prior day close
  const prevClose = prevB15[prevB15.length - 1].c;

  // Day open bar 15m (09:15-09:30)
  const openBar15 = b15[0];
  const openBar5 = b5[0];

  // Gap calculation
  const gapPts = openBar15.o - prevClose;
  const isGapDay = Math.abs(gapPts) >= 40;
  if (isGapDay) gapDaysCount++;

  // Day open fibs (using 15m open candle)
  const openFibs = calcFibs(openBar15.h, openBar15.l);
  const openMed = openFibs.f50;

  // First red 15m bar
  const firstRed15 = b15.slice(1).find(b => b.c < b.o);
  const firstRedMed = firstRed15 ? calcFibs(firstRed15.h, firstRed15.l).f50 : null;

  // Sandwich definition
  let swLo = null, swHi = null;
  if (firstRedMed != null && openMed != null) {
    swLo = Math.min(openMed, firstRedMed);
    swHi = Math.max(openMed, firstRedMed);
  }

  // Measure where subsequent 5m bars spent their time
  let insideSwCount = 0;
  let aboveRedCount = 0;
  let belowOpenCount = 0;
  let dayBarsCount = 0;

  let maxAbove = 0;
  let maxBelow = 0;

  for (let bi = 1; bi < b5.length; bi++) {
    const b = b5[bi];
    dayBarsCount++;
    totalIntradayBars++;

    if (swLo != null && swHi != null) {
      if (b.c >= swLo && b.c <= swHi) {
        insideSwCount++;
        insideSandwichBars++;
      } else if (b.c > swHi) {
        aboveRedCount++;
        aboveRedBarBars++;
        maxAbove = Math.max(maxAbove, b.h - swHi);
      } else {
        belowOpenCount++;
        belowDayOpenBars++;
        maxBelow = Math.max(maxBelow, swLo - b.l);
      }
    }
  }

  const pctInside = dayBarsCount > 0 ? (insideSwCount / dayBarsCount) * 100 : 0;
  const pctAbove = dayBarsCount > 0 ? (aboveRedCount / dayBarsCount) * 100 : 0;
  const pctBelow = dayBarsCount > 0 ? (belowOpenCount / dayBarsCount) * 100 : 0;

  if (pctInside > 60) stats.sandwichChopDays++;
  if (pctAbove > 50) stats.breakoutAboveRedDays++;
  if (pctBelow > 50) stats.breakdownBelowOpenDays++;

  dayResults.push({
    day,
    gapPts: +gapPts.toFixed(1),
    isGapDay,
    openMed: +openMed.toFixed(1),
    firstRedMed: firstRedMed ? +firstRedMed.toFixed(1) : null,
    swSpan: swHi && swLo ? +(swHi - swLo).toFixed(1) : null,
    pctInside: +pctInside.toFixed(1),
    pctAbove: +pctAbove.toFixed(1),
    pctBelow: +pctBelow.toFixed(1),
    maxAbove: +maxAbove.toFixed(1),
    maxBelow: +maxBelow.toFixed(1),
  });
}

console.log("\n================ 1-YEAR STATISTICAL STUDY RESULTS ================");
console.log(`Total Trading Days Analyzed: ${totalDays}`);
console.log(`Days with Significant Gap (>= 40 pts): ${gapDaysCount} (${((gapDaysCount/totalDays)*100).toFixed(1)}%)`);
console.log(`Days with Flat/Small Gap (< 40 pts): ${totalDays - gapDaysCount} (${(((totalDays - gapDaysCount)/totalDays)*100).toFixed(1)}%)`);

console.log("\n--- WHERE DOES PRICE SPEND ITS TIME? ---");
console.log(`Total 5m Bars Analyzed: ${totalIntradayBars}`);
console.log(`Inside the Sandwich (between Open Med & Red Bar Med): ${insideSandwichBars} bars (${((insideSandwichBars/totalIntradayBars)*100).toFixed(1)}%)`);
console.log(`Above the Red Bar Median: ${aboveRedBarBars} bars (${((aboveRedBarBars/totalIntradayBars)*100).toFixed(1)}%)`);
console.log(`Below the Day Open Median: ${belowDayOpenBars} bars (${((belowDayOpenBars/totalIntradayBars)*100).toFixed(1)}%)`);

console.log("\n--- DAY REGIME DISTRIBUTION ---");
console.log(`Days trapped in Sandwich Chop (>60% time inside): ${stats.sandwichChopDays} days (${((stats.sandwichChopDays/totalDays)*100).toFixed(1)}%)`);
console.log(`Days with Bullish Breakout above Red Bar Med (>50% time above): ${stats.breakoutAboveRedDays} days (${((stats.breakoutAboveRedDays/totalDays)*100).toFixed(1)}%)`);
console.log(`Days with Bearish Breakdown below Open Med (>50% time below): ${stats.breakdownBelowOpenDays} days (${((stats.breakdownBelowOpenDays/totalDays)*100).toFixed(1)}%)`);

// Show sample of recent 10 days
console.log("\n--- RECENT 10 DAYS SUMMARY TABLE ---");
console.table(dayResults.slice(-10));
