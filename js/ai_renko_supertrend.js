/**
 * Dr Devendra AI Renko Supertrend™ — Indicator & Strategy Engine
 *
 * Reverse-engineered from Dr Devendra's TradingView indicator ("Dr Devendra AI Renko Supertrend™")
 * across his channel videos and settings screenshot:
 *   - ATR Length:         14 (or 10 / 60 for Dual mode)
 *   - Base Factor:        3  (or 2)
 *   - Auto Brick Size:    true / false
 *   - Manual Brick Size:  33.33 / 16.66 / 8.33 (derived from 6H ATR(5) / 6 or / 12)
 *   - Choppy Filter (ADX): true / false
 *   - ADX Threshold:      15
 *
 * Outputs per bar (matching the 4 status-line plots on TradingView):
 *   1. supertrend:  Step-quantized Renko Supertrend trailing stop (green in bull, red in bear)
 *   2. smoothPrice: Smoothed Renko/price curve (inner black line forming the cloud boundary)
 *   3. renkoLevel:  Current quantized non-repainting Renko brick close level
 *   4. trend:       1 (Bullish / Green) or -1 (Bearish / Red)
 *   Plus: buySignal, sellSignal, adx, atr, brickSize
 */

'use strict';

/**
 * Compute Wilder's RMA (used by TradingView ta.atr and ta.adx)
 */
function calcRMA(values, length) {
    const out = new Array(values.length).fill(null);
    if (values.length === 0 || length <= 0) return out;
    const alpha = 1 / length;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null || Number.isNaN(v)) continue;
        if (count < length) {
            sum += v;
            count++;
            if (count === length) {
                out[i] = sum / length;
            }
        } else {
            out[i] = alpha * v + (1 - alpha) * out[i - 1];
        }
    }
    return out;
}

/**
 * Compute Standard EMA
 */
function calcEMA(values, length) {
    const out = new Array(values.length).fill(null);
    if (values.length === 0 || length <= 0) return out;
    const k = 2 / (length + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null || Number.isNaN(v)) continue;
        if (prev === null) {
            prev = v;
            out[i] = v;
        } else {
            prev = v * k + prev * (1 - k);
            out[i] = prev;
        }
    }
    return out;
}

/**
 * Compute ATR(length) using Wilder's RMA of True Range
 */
function calcATR(candles, length = 14) {
    const n = candles.length;
    const tr = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const c = candles[i];
        if (i === 0) {
            tr[i] = c.high - c.low;
        } else {
            const pc = candles[i - 1].close;
            tr[i] = Math.max(
                c.high - c.low,
                Math.abs(c.high - pc),
                Math.abs(c.low - pc)
            );
        }
    }
    return calcRMA(tr, length);
}

/**
 * Compute ADX(14) using Wilder's smoothing
 */
function calcADX(candles, length = 14) {
    const n = candles.length;
    const tr = new Array(n).fill(0);
    const plusDM = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);

    for (let i = 1; i < n; i++) {
        const upMove = candles[i].high - candles[i - 1].high;
        const downMove = candles[i - 1].low - candles[i].low;
        plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
        minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
        const pc = candles[i - 1].close;
        tr[i] = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - pc),
            Math.abs(candles[i].low - pc)
        );
    }
    if (n > 0) tr[0] = candles[0].high - candles[0].low;

    const smTR = calcRMA(tr, length);
    const smPlus = calcRMA(plusDM, length);
    const smMinus = calcRMA(minusDM, length);

    const dx = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (!smTR[i] || smTR[i] === 0) {
            dx[i] = 0;
            continue;
        }
        const pdi = (100 * smPlus[i]) / smTR[i];
        const mdi = (100 * smMinus[i]) / smTR[i];
        const denom = pdi + mdi;
        dx[i] = denom === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / denom;
    }
    return calcRMA(dx, length);
}

/**
 * Calculate Dr Devendra AI Renko Supertrend™
 *
 * @param {Array<{time?:number, open:number, high:number, low:number, close:number, volume?:number}>} candles
 * @param {Object} options
 * @param {number} [options.atrLength=14]         - ATR Length (default 14)
 * @param {number} [options.baseFactor=3]         - Base Factor / Multiplier (default 3)
 * @param {boolean} [options.autoBrickSize=false] - Auto Brick Size from ATR
 * @param {number} [options.manualBrickSize=33.33]- Manual Brick Size (e.g. 8.33, 16.66, 33.33)
 * @param {boolean} [options.choppyFilterAdx=false] - Enable Choppy Filter (ADX)
 * @param {number} [options.adxThreshold=15]      - ADX Threshold (default 15)
 * @param {number} [options.smoothLength=5]       - Smoothing length for inner price curve
 * @returns {Array<Object>}
 */
function calculateAIRenkoSupertrend(candles, options = {}) {
    const {
        atrLength = 14,
        baseFactor = 3,
        autoBrickSize = false,
        manualBrickSize = 33.33,
        brickPct = 0,
        choppyFilterAdx = false,
        adxThreshold = 15,
        smoothLength = 5
    } = options;

    const n = candles.length;
    if (n === 0) return [];

    const atrArr = calcATR(candles, atrLength);
    const adxArr = calcADX(candles, 14);
    const closes = candles.map(c => c.close);
    const emaClose = calcEMA(closes, smoothLength);

    const results = new Array(n);

    let renkoClose = null;
    let renkoOpen = null;
    let renkoDir = 0; // 1 = up brick, -1 = down brick

    let upperBand = null;
    let lowerBand = null;
    let trend = 1; // 1 = Bullish (Green), -1 = Bearish (Red)
    let supertrend = null;

    for (let i = 0; i < n; i++) {
        const c = candles[i];
        const atr = atrArr[i] != null ? atrArr[i] : (c.high - c.low || 1);
        const adx = adxArr[i] != null ? adxArr[i] : 20;

        // 1. Determine active Brick Size
        const brickSize = brickPct > 0
            ? Math.max(c.close * brickPct, 0.1)
            : autoBrickSize
                ? Math.max(atr * 0.5, c.close * 0.0005)
                : Math.max(manualBrickSize, 0.0001);

        // 2. Update Non-Repainting Synthetic Renko Brick state on candle close
        if (renkoClose === null) {
            renkoClose = Math.round(c.close / brickSize) * brickSize;
            renkoOpen = renkoClose - brickSize;
            renkoDir = 1;
        } else {
            if (renkoDir >= 0) {
                // Currently in upward brick progression
                if (c.close >= renkoClose + brickSize) {
                    const bricksUp = Math.floor((c.close - renkoClose) / brickSize);
                    renkoOpen = renkoClose + (bricksUp - 1) * brickSize;
                    renkoClose = renkoClose + bricksUp * brickSize;
                    renkoDir = 1;
                } else if (c.close <= renkoClose - 2 * brickSize) {
                    // 2-brick reversal downward
                    const bricksDown = Math.floor((renkoClose - c.close) / brickSize);
                    renkoOpen = renkoClose - (bricksDown - 1) * brickSize;
                    renkoClose = renkoClose - bricksDown * brickSize;
                    renkoDir = -1;
                }
            } else {
                // Currently in downward brick progression
                if (c.close <= renkoClose - brickSize) {
                    const bricksDown = Math.floor((renkoClose - c.close) / brickSize);
                    renkoOpen = renkoClose - (bricksDown - 1) * brickSize;
                    renkoClose = renkoClose - bricksDown * brickSize;
                    renkoDir = -1;
                } else if (c.close >= renkoClose + 2 * brickSize) {
                    // 2-brick reversal upward
                    const bricksUp = Math.floor((c.close - renkoClose) / brickSize);
                    renkoOpen = renkoClose + (bricksUp - 1) * brickSize;
                    renkoClose = renkoClose + bricksUp * brickSize;
                    renkoDir = 1;
                }
            }
        }

        // 3. Compute Renko-Quantized Volatility Bands
        // Base volatility distance uses Base Factor * ATR, quantized to Brick Size steps
        const rawBandDist = baseFactor * atr;
        const quantizedDist = Math.max(
            brickSize,
            Math.round(rawBandDist / brickSize) * brickSize
        );

        const basicUpper = renkoClose + quantizedDist;
        const basicLower = renkoClose - quantizedDist;

        if (upperBand === null || lowerBand === null) {
            upperBand = basicUpper;
            lowerBand = basicLower;
            trend = 1;
            supertrend = lowerBand;
        } else {
            const prevRenkoClose = results[i - 1].renkoLevel;
            upperBand = (basicUpper < upperBand || prevRenkoClose > upperBand)
                ? basicUpper
                : upperBand;
            lowerBand = (basicLower > lowerBand || prevRenkoClose < lowerBand)
                ? basicLower
                : lowerBand;
        }

        // 4. Determine Trend & Flip Logic (with optional ADX Choppy Filter)
        const prevTrend = trend;
        const adxPass = !choppyFilterAdx || adx >= adxThreshold;

        if (prevTrend === 1) {
            // In Uptrend: flips to Bearish (-1) only if both price & Renko brick break below lowerBand
            if (c.close < lowerBand && renkoDir === -1 && adxPass) {
                trend = -1;
                upperBand = basicUpper;
            }
        } else {
            // In Downtrend: flips to Bullish (1) only if both price & Renko brick break above upperBand
            if (c.close > upperBand && renkoDir === 1 && adxPass) {
                trend = 1;
                lowerBand = basicLower;
            }
        }

        supertrend = trend === 1 ? lowerBand : upperBand;

        // Smoothed price curve (Plot 2: black line inside the shaded cloud)
        const smoothPrice = emaClose[i] != null
            ? 0.5 * emaClose[i] + 0.5 * renkoClose
            : renkoClose;

        const buySignal = trend === 1 && prevTrend === -1 && i > 0;
        const sellSignal = trend === -1 && prevTrend === 1 && i > 0;

        results[i] = {
            time: c.time,
            close: c.close,
            supertrend,
            smoothPrice,
            renkoLevel: renkoClose,
            renkoOpen,
            renkoDir,
            trend,
            buySignal,
            sellSignal,
            atr,
            adx,
            brickSize
        };
    }

    return results;
}

/**
 * Calculate Dr Devendra's 6H / 14H Parent ATR(5) Brick Sizes automatically from candles
 * - Indian Equities/Indices (6h session): 1H brick = 6H_ATR(5) / 6, 30m brick = 6H_ATR(5) / 12
 * - MCX Commodities (14h session):        1H brick = 14H_ATR(5) / 14, 30m brick = 14H_ATR(5) / 28
 */
function calculateDrDevendraBrickSizes(candles, sessionHours = 6) {
    // Group candles by trading day to estimate Daily / Session True Range
    const dayMap = new Map();
    for (const c of candles) {
        const dt = new Date((c.time > 1e12 ? c.time : c.time * 1000) + 5.5 * 3600 * 1000);
        const dayKey = dt.toISOString().slice(0, 10);
        if (!dayMap.has(dayKey)) {
            dayMap.set(dayKey, { open: c.open, high: c.high, low: c.low, close: c.close });
        } else {
            const d = dayMap.get(dayKey);
            if (c.high > d.high) d.high = c.high;
            if (c.low < d.low) d.low = c.low;
            d.close = c.close;
        }
    }
    const days = Array.from(dayMap.values());
    const dayAtrArr = calcATR(days, 5);
    const latestAtr = dayAtrArr[dayAtrArr.length - 1] || (days[days.length - 1]?.high - days[days.length - 1]?.low) || 100;

    return {
        sessionAtr5: latestAtr,
        brick1H: +(latestAtr / sessionHours).toFixed(2),
        brick30m: +(latestAtr / (sessionHours * 2)).toFixed(2),
        brick15m: +(latestAtr / (sessionHours * 4)).toFixed(2)
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculateAIRenkoSupertrend,
        calculateDrDevendraBrickSizes,
        calcATR,
        calcADX,
        calcEMA,
        calcRMA
    };
}
if (typeof window !== 'undefined') {
    window.AIRenkoSupertrend = {
        calculateAIRenkoSupertrend,
        calculateDrDevendraBrickSizes,
        calcATR,
        calcADX,
        calcEMA,
        calcRMA
    };
}
