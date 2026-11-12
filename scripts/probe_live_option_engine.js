'use strict';

require('dotenv').config();
const { createDhanNiftyTrade } = require('../js/dhan_nifty_trade');
const { computeOptionCanvas, check1mMicroConfirmation, calculateOptionLevels } = require('../js/nifty_option_engine');

(async () => {
    const trader = createDhanNiftyTrade({ instrumentId: 'NIFTY' });
    const nowIstMs = Date.now() + 5.5 * 3600 * 1000;
    const fromDate = new Date(nowIstMs - 3 * 86400 * 1000).toISOString().slice(0, 10);
    const toDate = new Date(nowIstMs + 86400 * 1000).toISOString().slice(0, 10);

    const spotRes = await trader.dhan.getIntradayOhlc({
        securityId: '13',
        exchangeSegment: 'IDX_I',
        instrument: 'INDEX',
        interval: '5',
        fromDate: `${fromDate} 09:15:00`,
        toDate: `${toDate} 15:35:00`,
    });
    const spotCloses = spotRes?.close || spotRes?.data?.close || [];
    const spot = spotCloses.length ? Number(spotCloses[spotCloses.length - 1]) : 25250;
    console.log(`Live NIFTY Spot: ${spot} (${spotCloses.length} 5m bars across ${fromDate}..${toDate})`);

    for (const side of ['LONG', 'SHORT']) {
        const contract = await trader.pickOptionContract({ side, spot });
        const spread = Number((contract.ask - contract.bid).toFixed(2));
        const bars1m = await trader.fetchOptionIntradayBars(contract.securityId, '1', 3);
        const lastDayKey = bars1m.length
            ? new Date(bars1m[bars1m.length - 1].t + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
            : '';
        const today1m = bars1m.filter(b => new Date(b.t + 5.5 * 3600 * 1000).toISOString().slice(0, 10) === lastDayKey);
        const canvas = computeOptionCanvas(bars1m, lastDayKey);
        const micro = check1mMicroConfirmation(today1m.length >= 2 ? today1m : bars1m);
        const levels = calculateOptionLevels({
            currentPremium: contract.ask || contract.ltp,
            optionCanvas: canvas,
            microAnalysis: micro,
            bufferPts: 2.0,
        });
        console.log(`\n[${side} / ${contract.symbolHint}] SecId=${contract.securityId}`);
        console.log(`  Quote: LTP=${contract.ltp} Bid=${contract.bid} Ask=${contract.ask} Spread=${spread} Delta=${contract.delta}`);
        console.log(`  1m Feed: ${bars1m.length} total bars (${today1m.length} on ${lastDayKey}) | Open=${canvas.openBarLow}..${canvas.openBarHigh}`);
        console.log(`  Micro: confirmed=${micro.confirmed} pattern=${micro.triggerPattern || 'none'} wick=${micro.curWickRatio}% signalLow=${micro.signalLow}`);
        console.log(`  Levels: Entry=${levels.entryPrice} SL=${levels.stopLossPrice} (risk=${levels.riskPts}) 1:1=${levels.tp1Banker} Target=${levels.tpTarget} RR=${levels.rrRatio}`);
    }
})().catch((err) => {
    console.error('PROBE FAILED:', err);
    process.exit(1);
});
