'use strict';

/**
 * indicators.js — Pure technical analysis calculations
 * No external dependencies. All inputs are plain number arrays.
 * null values in arrays indicate missing/unavailable data points.
 */
const Indicators = {

  // ─── Simple Moving Average ──────────────────────────────────────────────────
  sma(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let sum = 0, count = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (closes[j] !== null && !isNaN(closes[j])) { sum += closes[j]; count++; }
      }
      if (count === period) out[i] = sum / period;
    }
    return out;
  },

  // ─── Exponential Moving Average ─────────────────────────────────────────────
  ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let startIdx = -1;

    // Find first run of `period` non-null values for seed SMA
    for (let i = 0; i <= values.length - period; i++) {
      let allValid = true, sum = 0;
      for (let j = i; j < i + period; j++) {
        if (values[j] === null || isNaN(values[j])) { allValid = false; break; }
        sum += values[j];
      }
      if (allValid) { out[i + period - 1] = sum / period; startIdx = i + period - 1; break; }
    }
    if (startIdx === -1) return out;

    let lastValidEma = out[startIdx];
    for (let i = startIdx + 1; i < values.length; i++) {
      if (values[i] === null || isNaN(values[i])) {
        out[i] = null;
        continue;
      }
      out[i] = values[i] * k + lastValidEma * (1 - k);
      lastValidEma = out[i];
    }
    return out;
  },

  // ─── Relative Strength Index (Wilder's smoothing) ───────────────────────────
  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    const clean = closes.filter(v => v !== null && !isNaN(v));
    if (clean.length < period + 1) return out;

    // Work on a clean slice then map back
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = clean[i] - clean[i - 1];
      if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;

    const rsiClean = new Array(clean.length).fill(null);
    rsiClean[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < clean.length; i++) {
      const d = clean[i] - clean[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? Math.abs(d) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsiClean[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    // Map clean RSI back to original array positions
    let ci = 0;
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] !== null && !isNaN(closes[i])) {
        out[i] = rsiClean[ci] ?? null;
        ci++;
      }
    }
    return out;
  },

  // ─── MACD (Moving Average Convergence Divergence) ────────────────────────────
  macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast   = this.ema(closes, fast);
    const emaSlow   = this.ema(closes, slow);
    const macdLine  = closes.map((_, i) =>
      emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
    );
    const signalLine  = this.ema(macdLine, signal);
    const histogram   = macdLine.map((v, i) =>
      v !== null && signalLine[i] !== null ? v - signalLine[i] : null
    );
    return { macdLine, signalLine, histogram };
  },

  // ─── Bollinger Bands ────────────────────────────────────────────────────────
  bollingerBands(closes, period = 20, mult = 2) {
    const middle   = this.sma(closes, period);
    const upper    = new Array(closes.length).fill(null);
    const lower    = new Array(closes.length).fill(null);
    const percentB = new Array(closes.length).fill(null);

    for (let i = period - 1; i < closes.length; i++) {
      if (middle[i] === null) continue;
      const slice = closes.slice(i - period + 1, i + 1).filter(v => v !== null);
      if (slice.length < period) continue;
      const variance = slice.reduce((s, v) => s + Math.pow(v - middle[i], 2), 0) / period;
      const sd = Math.sqrt(variance);
      upper[i]    = middle[i] + mult * sd;
      lower[i]    = middle[i] - mult * sd;
      const bandWidth = upper[i] - lower[i];
      percentB[i] = bandWidth > 0 ? (closes[i] - lower[i]) / bandWidth : 0.5;
    }
    return { upper, middle, lower, percentB };
  },

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Return the most recent non-null value from an array */
  last(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return arr[i];
    }
    return null;
  },

  /**
   * Detect a MACD crossover within the last `lookback` bars.
   * Returns 'bullish' | 'bearish' | null
   */
  macdCrossover(macdLine, signalLine, lookback = 5) {
    const len = macdLine.length;
    let result = null;
    for (let i = Math.max(1, len - lookback); i < len; i++) {
      const m = macdLine[i],   mp = macdLine[i - 1];
      const s = signalLine[i], sp = signalLine[i - 1];
      if (m === null || mp === null || s === null || sp === null) continue;
      if (mp < sp && m >= s) result = 'bullish';   // crossed above
      if (mp > sp && m <= s) result = 'bearish';   // crossed below
    }
    return result;
  },

  /** Percentage change between two values */
  pct(from, to) {
    if (!from || from === 0) return 0;
    return ((to - from) / Math.abs(from)) * 100;
  },

  /** Standard deviation of an array */
  stdDev(arr) {
    const valid = arr.filter(v => v !== null && !isNaN(v));
    if (valid.length < 2) return 0;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    return Math.sqrt(valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length);
  },

  /**
   * Average True Range (Wilder). Returns full ATR series or null-filled if inputs mismatch.
   * TR = max(high-low, |high-prevClose|, |low-prevClose|)
   */
  atr(highs, lows, closes, period = 14) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    if (!highs || !lows || highs.length !== n || lows.length !== n || n < period + 1) return out;

    const tr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const h = highs[i], l = lows[i], pc = closes[i - 1];
      if (h == null || l == null || pc == null) continue;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    let sum = 0, count = 0;
    for (let i = 1; i <= period; i++) {
      if (tr[i] != null) { sum += tr[i]; count++; }
    }
    if (count < period) return out;
    out[period] = sum / period;

    for (let i = period + 1; i < n; i++) {
      if (tr[i] == null || out[i - 1] == null) { out[i] = out[i - 1]; continue; }
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
  },

  /** Simple mean of last `period` non-null values */
  avgLast(arr, period) {
    let sum = 0, count = 0;
    for (let i = arr.length - 1; i >= 0 && count < period; i--) {
      const v = arr[i];
      if (v != null && !isNaN(v)) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  },
};
