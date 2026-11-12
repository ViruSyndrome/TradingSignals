'use strict';

const fs = require('fs');
const path = require('path');

function loadBars(tf) {
    const p = path.join(__dirname, '..', '.cache_desk', `NIFTY_${tf}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const bars = Array.isArray(raw) ? raw : (raw.bars || raw.candles || []);
    return bars
        .map(b => ({
            t: Number(b.t),
            o: Number(b.o),
            h: Number(b.h),
            l: Number(b.l),
            c: Number(b.c),
        }))
        .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c))
        .sort((a, b) => a.t - b.t);
}

function toHA(bars) {
    const out = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const hc = (b.o + b.h + b.l + b.c) / 4;
        const ho = i === 0 ? (b.o + b.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
        const hh = Math.max(b.h, ho, hc);
        const hl = Math.min(b.l, ho, hc);
        out[i] = { t: b.t, o: ho, h: hh, l: hl, c: hc };
    }
    return out;
}

function computeEMA(vals, period) {
    const k = 2 / (period + 1);
    const out = new Array(vals.length).fill(null);
    if (vals.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += vals[i];
    let prev = sum / period;
    out[period - 1] = prev;
    for (let i = period; i < vals.length; i++) {
        prev = vals[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

function computeCCI(bars, period, srcMode) {
    const src = bars.map(b => (srcMode === 'hlc3' ? (b.h + b.l + b.c) / 3 : b.c));
    const out = new Array(bars.length).fill(null);
    for (let i = period - 1; i < src.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += src[j];
        const sma = sum / period;
        let mdSum = 0;
        for (let j = i - period + 1; j <= i; j++) mdSum += Math.abs(src[j] - sma);
        const md = mdSum / period;
        out[i] = md === 0 ? 0 : (src[i] - sma) / (0.015 * md);
    }
    return out;
}

function istHHMM(ms) {
    const d = new Date(ms + 5.5 * 3600 * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function fmtDate(ms) {
    return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function runBacktest(bars, opts) {
    const { stackType, cciSource, quietFilter, waitStackOrder } = opts;
    const haBars = toHA(bars);
    const stackBars = stackType === 'HA' ? haBars : bars;
    const stackClose = stackBars.map(b => b.c);

    const ema20 = computeEMA(stackClose, 20);
    const ema50 = computeEMA(stackClose, 50);
    const ema200 = computeEMA(stackClose, 200);
    const cci = computeCCI(bars, 200, cciSource);

    const trades = [];
    let pos = null; // { side: 'LONG'|'SHORT', entryPrice, entryTime, entryIdx, mae, mfe }
    let equity = 0;
    let peak = 0;
    let maxDD = 0;
    let barHoldingSum = 0;

    for (let i = 201; i < bars.length; i++) {
        const b = bars[i];
        const cPrev = cci[i - 1];
        const cCurr = cci[i];
        if (cPrev == null || cCurr == null || ema200[i] == null) continue;

        if (pos) {
            const diff = pos.side === 'LONG' ? b.c - pos.entryPrice : pos.entryPrice - b.c;
            const fav = pos.side === 'LONG' ? b.h - pos.entryPrice : pos.entryPrice - b.l;
            const adv = pos.side === 'LONG' ? pos.entryPrice - b.l : b.h - pos.entryPrice;
            if (fav > pos.mfe) pos.mfe = fav;
            if (adv > pos.mae) pos.mae = adv;

            const exitLong = pos.side === 'LONG' && cPrev >= 100 && cCurr < 100;
            const exitShort = pos.side === 'SHORT' && cPrev <= -100 && cCurr > -100;

            if (exitLong || exitShort) {
                const pnl = pos.side === 'LONG' ? b.c - pos.entryPrice : pos.entryPrice - b.c;
                const holdBars = i - pos.entryIdx;
                barHoldingSum += holdBars;
                equity += pnl;
                if (equity > peak) peak = equity;
                const dd = peak - equity;
                if (dd > maxDD) maxDD = dd;

                trades.push({
                    side: pos.side,
                    entryTime: fmtDate(pos.entryTime) + ' ' + istHHMM(pos.entryTime),
                    exitTime: fmtDate(b.t) + ' ' + istHHMM(b.t),
                    entry: pos.entryPrice,
                    exit: b.c,
                    pnl,
                    mae: pos.mae,
                    mfe: pos.mfe,
                    holdDays: (b.t - pos.entryTime) / (86400 * 1000),
                });
                pos = null;
                continue;
            }
        }

        if (!pos) {
            const stackLong = stackClose[i] > ema20[i] && ema20[i] > ema50[i] && ema50[i] > ema200[i];
            const stackShort = stackClose[i] < ema20[i] && ema20[i] < ema50[i] && ema50[i] < ema200[i];
            const prevStackLong = stackClose[i - 1] > ema20[i - 1] && ema20[i - 1] > ema50[i - 1] && ema50[i - 1] > ema200[i - 1];
            const prevStackShort = stackClose[i - 1] < ema20[i - 1] && ema20[i - 1] < ema50[i - 1] && ema50[i - 1] < ema200[i - 1];

            let enterLong = stackLong && cPrev < 100 && cCurr > 100;
            let enterShort = stackShort && cPrev > -100 && cCurr < -100;

            // Optional variant: if stack completes AFTER CCI already > 100
            if (waitStackOrder === 'either') {
                enterLong = stackLong && cCurr > 100 && (!prevStackLong || cPrev <= 100);
                enterShort = stackShort && cCurr < -100 && (!prevStackShort || cPrev >= -100);
            }

            if ((enterLong || enterShort) && quietFilter) {
                // Locked quietStep rule (matches scripts/backtest_ha_ema_cci.js:383-387):
                // jump = |dCCI| < 25, thrust = distance past +-100 < 15, skip 09:15 & first bar of session
                const hhmm = istHHMM(b.t);
                const firstBarOfDay = fmtDate(b.t) !== fmtDate(bars[i - 1].t);
                const jump = Math.abs(cCurr - cPrev);
                const thrust = enterLong ? (cCurr - 100) : (-100 - cCurr);
                if (firstBarOfDay || hhmm === '09:15' || jump >= 25 || thrust < 0 || thrust >= 15) {
                    enterLong = false;
                    enterShort = false;
                }
            }

            if (enterLong) {
                pos = { side: 'LONG', entryPrice: b.c, entryTime: b.t, entryIdx: i, mae: 0, mfe: 0 };
            } else if (enterShort) {
                pos = { side: 'SHORT', entryPrice: b.c, entryTime: b.t, entryIdx: i, mae: 0, mfe: 0 };
            }
        }
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const netPts = grossWin - grossLoss;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const avgHoldDays = trades.length ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;
    const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);

    return {
        tradesCount: trades.length,
        wins: wins.length,
        losses: losses.length,
        wr,
        netPts,
        netRs1Lot: netPts * 65,
        pf,
        maxDD,
        maxDDRs1Lot: maxDD * 65,
        avgWin,
        avgLoss,
        avgHoldDays,
        top3: sorted.slice(0, 3),
        worst3: sorted.slice(-3).reverse(),
        openAtEnd: pos ? { side: pos.side, entryPrice: pos.entryPrice, entryTime: fmtDate(pos.entryTime) + ' ' + istHHMM(pos.entryTime), lastClose: bars[bars.length - 1].c } : null,
        trades,
    };
}

const reportOut = { generatedAt: new Date().toISOString(), timeframes: {} };

for (const tf of ['15m', '30m', '1h', '5m']) {
    const bars = loadBars(tf);
    reportOut.timeframes[tf] = {
        bars: bars.length,
        from: fmtDate(bars[0].t),
        to: fmtDate(bars[bars.length - 1].t),
        rows: [],
    };
    console.log(`\n========================================================================`);
    console.log(`TIMEFRAME: ${tf} | Bars: ${bars.length} | Span: ${fmtDate(bars[0].t)} -> ${fmtDate(bars[bars.length - 1].t)}`);
    console.log(`========================================================================`);
    const configs = [
        { label: 'Exact User (HA Stack + Close CCI, NO filter)', stackType: 'HA', cciSource: 'close', quietFilter: false, waitStackOrder: 'strictCross' },
        { label: 'Exact User (HA Stack + HLC3 CCI, NO filter)', stackType: 'HA', cciSource: 'hlc3', quietFilter: false, waitStackOrder: 'strictCross' },
        { label: 'Normal Candles (Raw Stack + Close CCI, NO filter)', stackType: 'RAW', cciSource: 'close', quietFilter: false, waitStackOrder: 'strictCross' },
        { label: 'Normal Candles (Raw Stack + HLC3 CCI, NO filter)', stackType: 'RAW', cciSource: 'hlc3', quietFilter: false, waitStackOrder: 'strictCross' },
        { label: 'Quiet-Filtered (HA Stack + Close CCI)', stackType: 'HA', cciSource: 'close', quietFilter: true, waitStackOrder: 'strictCross' },
        { label: 'Quiet-Filtered (Normal Stack + Close CCI)', stackType: 'RAW', cciSource: 'close', quietFilter: true, waitStackOrder: 'strictCross' },
        { label: 'Either-Order (HA Stack + Close CCI, NO filter)', stackType: 'HA', cciSource: 'close', quietFilter: false, waitStackOrder: 'either' },
    ];
    for (const c of configs) {
        const r = runBacktest(bars, c);
        reportOut.timeframes[tf].rows.push({
            label: c.label,
            trades: r.tradesCount,
            wins: r.wins,
            losses: r.losses,
            winRatePct: +r.wr.toFixed(1),
            netPts: +r.netPts.toFixed(1),
            netRs1Lot: Math.round(r.netRs1Lot),
            profitFactor: +r.pf.toFixed(2),
            maxDDPts: +r.maxDD.toFixed(1),
            avgHoldDays: +r.avgHoldDays.toFixed(1),
            avgWinPts: +r.avgWin.toFixed(1),
            avgLossPts: +r.avgLoss.toFixed(1),
            top3: r.top3,
        });
        console.log(
            `${c.label.padEnd(48)} | Tr=${String(r.tradesCount).padStart(3)} (${r.wins}W/${r.losses}L, ${r.wr.toFixed(1).padStart(4)}%) | Net=${r.netPts.toFixed(1).padStart(8)} pts (Rs ${Math.round(r.netRs1Lot).toLocaleString('en-IN').padStart(9)}) | PF=${r.pf.toFixed(2)} | MaxDD=${r.maxDD.toFixed(1).padStart(6)} pts | AvgHold=${r.avgHoldDays.toFixed(1)}d | AvgW/L=+${r.avgWin.toFixed(1)}/-${r.avgLoss.toFixed(1)}`
        );
    }

    if (tf === '15m') {
        console.log('\n--- Detailed breakdown for 15m Exact User (HA Stack + Close CCI, NO filter) vs Quiet-Filtered ---');
        for (const qf of [false, true]) {
            const res = runBacktest(bars, { stackType: 'HA', cciSource: 'close', quietFilter: qf, waitStackOrder: 'strictCross' });
            console.log(`\n[15m HA+Close CCI | QuietFilter=${qf}] Net: ${res.netPts.toFixed(1)} pts | Top 3 winners:`);
            for (const t of res.top3) console.log(`  ${t.side} ${t.entryTime}->${t.exitTime}: ${t.pnl.toFixed(1)} pts (${t.holdDays.toFixed(1)}d)`);
            if (res.openAtEnd) console.log(`  Open trade at end: ${JSON.stringify(res.openAtEnd)}`);
        }
    }
}

const outPath = path.join(__dirname, '..', 'docs', 'backtests', 'ha_ema_cci_futures_matrix_latest.json');
fs.writeFileSync(outPath, JSON.stringify(reportOut, null, 2));
console.log(`\nSaved matrix JSON -> ${outPath}`);
