'use strict';

const fs = require('fs');
const path = require('path');

function loadBars(tf) {
    const p = path.join(__dirname, '..', '.cache_desk', `NIFTY_${tf}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const bars = Array.isArray(raw) ? raw : (raw.bars || raw.candles || []);
    return bars
        .map(b => ({ t: Number(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c) }))
        .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c))
        .sort((a, b) => a.t - b.t);
}

function fmtDate(ms) {
    return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function istHHMM(ms) {
    const d = new Date(ms + 5.5 * 3600 * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function computeATR(bars, period = 14) {
    const out = new Array(bars.length).fill(null);
    const tr = new Array(bars.length).fill(0);
    for (let i = 0; i < bars.length; i++) {
        if (i === 0) tr[i] = bars[i].h - bars[i].l;
        else tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
        if (i === period - 1) {
            let s = 0;
            for (let j = 0; j < period; j++) s += tr[j];
            out[i] = s / period;
        } else if (i >= period) {
            out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
        }
    }
    return out;
}

// Count distinct swing touches on top & bottom band inside a rolling window
function analyzeBox(bars, startIdx, endIdx, tol) {
    let hi = -Infinity, lo = Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
        if (bars[i].h > hi) hi = bars[i].h;
        if (bars[i].l < lo) lo = bars[i].l;
    }
    const height = hi - lo;
    if (height <= 0) return null;

    // Distinct visits to upper zone (>= hi - tol) and lower zone (<= lo + tol)
    // Require returning into the middle 60% between touches so one flat cluster isn't counted twice
    let topTouches = 0, botTouches = 0;
    let stateTop = true, stateBot = true;
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

function summarize(name, trades) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const net = gw - gl;
    let eq = 0, pk = 0, dd = 0;
    for (const t of trades) {
        eq += t.pnl;
        if (eq > pk) pk = eq;
        if (pk - eq > dd) dd = pk - eq;
    }
    const pf = gl > 0 ? gw / gl : Infinity;
    const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
    const avgHold = trades.length ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;
    const avgRR = trades.length ? trades.reduce((s, t) => s + t.rMult, 0) / trades.length : 0;
    console.log(
        `${name.padEnd(46)} | Tr=${String(trades.length).padStart(3)} (${String(wins.length).padStart(2)}W/${String(losses.length).padStart(2)}L, ${wr.toFixed(1).padStart(4)}%) | Net=${net.toFixed(1).padStart(8)} pts (Rs ${Math.round(net * 65).toLocaleString('en-IN').padStart(9)}) | PF=${pf.toFixed(2)} | MaxDD=${dd.toFixed(1).padStart(6)} pts | AvgR=${avgRR.toFixed(2)} | Hold=${avgHold.toFixed(1)}d`
    );
}

function runPatrickSwing(bars, tf, mode) {
    // mode: 'ALL' | 'FAILED_RECLAIM' | 'CONFIRMED_BREAKOUT' | 'WIDE_FADE'
    const atr = computeATR(bars, 14);
    const lookback = tf === '15m' ? 18 : tf === '30m' ? 14 : 10; // ~4.5-10h consolidation box (Patrick: half-day to full-day)
    const impLook = tf === '15m' ? 16 : 12;

    const trades = [];
    let pos = null;
    let sweepPending = null; // { side: 'LONG'|'SHORT', boxHi, boxLo, sweepExt, expiresAt }
    let cooldownUntil = 0;

    for (let i = lookback + impLook + 5; i < bars.length; i++) {
        const b = bars[i];
        const curAtr = atr[i];
        if (!curAtr) continue;

        // Manage open futures swing position (multi-day hold)
        if (pos) {
            let closed = false;
            const risk = pos.risk;
            // Check intrabar SL first (conservative!)
            if (pos.side === 'LONG') {
                if (b.l <= pos.sl) {
                    const exitPx = Math.min(b.o, pos.sl);
                    pos.realizedPts += (exitPx - pos.entry) * pos.remFrac;
                    closed = true;
                } else {
                    // Partial scaling at 1.5R (bank 1/3) and 3.0R (bank 1/3), let 1/3 run with structural trail
                    if (!pos.tp1Hit && b.h >= pos.entry + 1.5 * risk) {
                        pos.tp1Hit = true;
                        pos.realizedPts += (1.5 * risk) * (1 / 3);
                        pos.remFrac -= 1 / 3;
                        pos.sl = Math.max(pos.sl, pos.entry); // move to BE
                    }
                    if (!pos.tp2Hit && b.h >= pos.entry + 3.0 * risk) {
                        pos.tp2Hit = true;
                        pos.realizedPts += (3.0 * risk) * (1 / 3);
                        pos.remFrac -= 1 / 3;
                        pos.sl = Math.max(pos.sl, pos.entry + 1.5 * risk);
                    }
                    // Final target for range trades or measured move cap (5R max or trail 10-bar low after 3R)
                    if (pos.tp2Hit && b.h >= pos.entry + 5.5 * risk) {
                        pos.realizedPts += (5.5 * risk) * pos.remFrac;
                        closed = true;
                    } else if (pos.tp1Hit) {
                        // Trail runner under 12-bar swing low once past +2.5R
                        if (b.h >= pos.entry + 2.5 * risk) {
                            let trLow = Infinity;
                            for (let k = i - 10; k < i; k++) if (bars[k].l < trLow) trLow = bars[k].l;
                            pos.sl = Math.max(pos.sl, trLow);
                        }
                    }
                }
            } else {
                if (b.h >= pos.sl) {
                    const exitPx = Math.max(b.o, pos.sl);
                    pos.realizedPts += (pos.entry - exitPx) * pos.remFrac;
                    closed = true;
                } else {
                    if (!pos.tp1Hit && b.l <= pos.entry - 1.5 * risk) {
                        pos.tp1Hit = true;
                        pos.realizedPts += (1.5 * risk) * (1 / 3);
                        pos.remFrac -= 1 / 3;
                        pos.sl = Math.min(pos.sl, pos.entry);
                    }
                    if (!pos.tp2Hit && b.l <= pos.entry - 3.0 * risk) {
                        pos.tp2Hit = true;
                        pos.realizedPts += (3.0 * risk) * (1 / 3);
                        pos.remFrac -= 1 / 3;
                        pos.sl = Math.min(pos.sl, pos.entry - 1.5 * risk);
                    }
                    if (pos.tp2Hit && b.l <= pos.entry - 5.5 * risk) {
                        pos.realizedPts += (5.5 * risk) * pos.remFrac;
                        closed = true;
                    } else if (pos.tp1Hit && b.l <= pos.entry - 2.5 * risk) {
                        let trHigh = -Infinity;
                        for (let k = i - 10; k < i; k++) if (bars[k].h > trHigh) trHigh = bars[k].h;
                        pos.sl = Math.min(pos.sl, trHigh);
                    }
                }
            }

            if (closed) {
                trades.push({
                    side: pos.side,
                    kind: pos.kind,
                    entryTime: fmtDate(pos.entryTime) + ' ' + istHHMM(pos.entryTime),
                    exitTime: fmtDate(b.t) + ' ' + istHHMM(b.t),
                    pnl: pos.realizedPts - 2, // deduct 2 pts NIFTY futures slippage/charges per round turn
                    rMult: pos.realizedPts / pos.risk,
                    holdDays: (b.t - pos.entryTime) / (86400 * 1000),
                });
                pos = null;
                cooldownUntil = i + 3;
            }
            continue;
        }

        if (i < cooldownUntil) continue;

        // 1) Check pending Failed-Breakout Reclaim (wb_030 left box red circles!)
        if (sweepPending) {
            if (i > sweepPending.expiresAt) {
                sweepPending = null;
            } else if (sweepPending.side === 'LONG') {
                sweepPending.sweepExt = Math.min(sweepPending.sweepExt, b.l);
                // Reclaims cleanly back inside the box (bullish close > boxLo)
                if (b.c > sweepPending.boxLo && b.c > b.o) {
                    const sl = sweepPending.sweepExt - curAtr * 0.2;
                    const risk = b.c - sl;
                    if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                        pos = {
                            side: 'LONG',
                            kind: sweepPending.isWide ? 'WIDE_RECLAIM' : 'TIGHT_RECLAIM',
                            entry: b.c,
                            sl,
                            risk,
                            entryTime: b.t,
                            tp1Hit: false,
                            tp2Hit: false,
                            remFrac: 1.0,
                            realizedPts: 0,
                        };
                        sweepPending = null;
                        continue;
                    }
                }
            } else {
                sweepPending.sweepExt = Math.max(sweepPending.sweepExt, b.h);
                if (b.c < sweepPending.boxHi && b.c < b.o) {
                    const sl = sweepPending.sweepExt + curAtr * 0.2;
                    const risk = sl - b.c;
                    if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                        pos = {
                            side: 'SHORT',
                            kind: sweepPending.isWide ? 'WIDE_RECLAIM' : 'TIGHT_RECLAIM',
                            entry: b.c,
                            sl,
                            risk,
                            entryTime: b.t,
                            tp1Hit: false,
                            tp2Hit: false,
                            remFrac: 1.0,
                            realizedPts: 0,
                        };
                        sweepPending = null;
                        continue;
                    }
                }
            }
        }

        // 2) Detect valid 3-touch box ending at i-1
        const boxStart = i - lookback;
        const boxEnd = i - 1;
        const box = analyzeBox(bars, boxStart, boxEnd, curAtr * 0.35);
        if (!box) continue;

        // Require >= 3 touches on BOTH sides OR >= 3 on broken/faded boundary + >= 2 on opposite
        const valid3Touch = (box.topTouches >= 3 && box.botTouches >= 2) || (box.botTouches >= 3 && box.topTouches >= 2);
        if (!valid3Touch) continue;

        // Check prior impulse direction into box (forming P vs b shape)
        let impHi = -Infinity, impLo = Infinity;
        for (let k = boxStart - impLook; k < boxStart; k++) {
            if (bars[k].h > impHi) impHi = bars[k].h;
            if (bars[k].l < impLo) impLo = bars[k].l;
        }
        const priorImpSize = impHi - impLo;
        const boxRatio = box.height / b.c;
        const isTight = box.height <= 3.2 * curAtr && boxRatio <= 0.0085 && priorImpSize >= box.height * 1.4;
        const isWide = !isTight && box.height >= 2.8 * curAtr && boxRatio <= 0.022;

        // Track sweep for Failed Breakout Reclaim (allowed in tight P/b OR wide fade)
        if ((mode === 'ALL' || mode === 'FAILED_RECLAIM' || (mode === 'WIDE_FADE' && isWide))) {
            if (b.l < box.lo - curAtr * 0.15 && b.c >= box.lo - curAtr * 0.4) {
                // Bullish pin bar immediate reclaim OR set 3-bar reclaim watch
                if (b.c > box.lo) {
                    const sl = b.l - curAtr * 0.2;
                    const risk = b.c - sl;
                    if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                        pos = { side: 'LONG', kind: isWide ? 'WIDE_FADE' : 'TIGHT_RECLAIM', entry: b.c, sl, risk, entryTime: b.t, tp1Hit: false, tp2Hit: false, remFrac: 1.0, realizedPts: 0 };
                        continue;
                    }
                } else {
                    sweepPending = { side: 'LONG', boxHi: box.hi, boxLo: box.lo, sweepExt: b.l, expiresAt: i + 3, isWide };
                }
            } else if (b.h > box.hi + curAtr * 0.15 && b.c <= box.hi + curAtr * 0.4) {
                if (b.c < box.hi) {
                    const sl = b.h + curAtr * 0.2;
                    const risk = sl - b.c;
                    if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                        pos = { side: 'SHORT', kind: isWide ? 'WIDE_FADE' : 'TIGHT_RECLAIM', entry: b.c, sl, risk, entryTime: b.t, tp1Hit: false, tp2Hit: false, remFrac: 1.0, realizedPts: 0 };
                        continue;
                    }
                } else {
                    sweepPending = { side: 'SHORT', boxHi: box.hi, boxLo: box.lo, sweepExt: b.h, expiresAt: i + 3, isWide };
                }
            }
        }

        // Confirmed Tight-Box Breakout (P breaks UP, b breaks DOWN)
        if ((mode === 'ALL' || mode === 'CONFIRMED_BREAKOUT') && isTight) {
            const pShape = (bars[boxStart - 1].c - impLo) > (impHi - bars[boxStart - 1].c); // rallied UP into tight box
            const bShape = !pShape;

            if (pShape && b.c > box.hi + curAtr * 0.15 && b.c > b.o) {
                const sl = Math.max(box.lo - curAtr * 0.2, b.c - Math.max(box.height, curAtr * 1.4));
                const risk = b.c - sl;
                if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                    pos = { side: 'LONG', kind: 'P_BREAKOUT', entry: b.c, sl, risk, entryTime: b.t, tp1Hit: false, tp2Hit: false, remFrac: 1.0, realizedPts: 0 };
                }
            } else if (bShape && b.c < box.lo - curAtr * 0.15 && b.c < b.o) {
                const sl = Math.min(box.hi + curAtr * 0.2, b.c + Math.max(box.height, curAtr * 1.4));
                const risk = sl - b.c;
                if (risk >= curAtr * 0.4 && risk <= b.c * 0.012) {
                    pos = { side: 'SHORT', kind: 'B_BREAKDOWN', entry: b.c, sl, risk, entryTime: b.t, tp1Hit: false, tp2Hit: false, remFrac: 1.0, realizedPts: 0 };
                }
            }
        }
    }

    return trades;
}

for (const tf of ['15m', '30m', '1h']) {
    const bars = loadBars(tf);
    console.log(`\n========================================================================`);
    console.log(`PATRICK NILL FUTURES SWING (${tf}) | Bars: ${bars.length} | ${fmtDate(bars[0].t)} -> ${fmtDate(bars[bars.length - 1].t)} (-2 pts slippage included)`);
    console.log(`========================================================================`);
    for (const mode of ['ALL', 'FAILED_RECLAIM', 'CONFIRMED_BREAKOUT', 'WIDE_FADE']) {
        const trades = runPatrickSwing(bars, tf, mode);
        summarize(`Mode: ${mode}`, trades);
    }
    const allTrades = runPatrickSwing(bars, tf, 'ALL');
    const byKind = {};
    for (const t of allTrades) {
        if (!byKind[t.kind]) byKind[t.kind] = [];
        byKind[t.kind].push(t);
    }
    console.log('--- Setup Breakdown (ALL combined) ---');
    for (const [k, list] of Object.entries(byKind)) summarize(`  ${k}`, list);
}
