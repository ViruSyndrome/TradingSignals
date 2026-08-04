'use strict';

/**
 * signals.js — Composite signal generation from technical indicators.
 * Scores each indicator, combines them, and outputs a Buy/Sell/Hold signal
 * with a confidence percentage and a plain-English recommendation.
 */
const Signals = {

  LEVELS: {
    STRONG_BUY:  { label: 'Strong Buy',  short: 'S.BUY',  cls: 'strong-buy',  icon: '🚀', minScore:  2.5 },
    BUY:         { label: 'Buy',          short: 'BUY',    cls: 'buy',          icon: '📈', minScore:  1.5 },
    NEUTRAL:     { label: 'Hold / Watch', short: 'HOLD',   cls: 'neutral',      icon: '⏸️',  minScore: -1.5 },
    SELL:        { label: 'Sell',         short: 'SELL',   cls: 'sell',         icon: '📉', minScore: -2.5 },
    STRONG_SELL: { label: 'Strong Sell', short: 'S.SELL', cls: 'strong-sell',  icon: '🔻', minScore: -Infinity },
  },

  // ─── Main entry point ──────────────────────────────────────────────────────
  // opts: { highs, lows, volumes, fearGreed, symbol, ignoreWinnersFilter }
  // fearGreed: 0-100 market sentiment; symbol: enables the backtested-winners filter.
  generate(closes, opts = {}) {
    const EMPTY = (reason = 'Insufficient data') => ({
      signal: 'NEUTRAL', confidence: 0, score: 0, indicators: {},
      recommendation: reason, arrays: {}, calculatedAt: new Date().toISOString(),
    });

    if (!closes || closes.length < 30) return EMPTY();
    const valid = closes.filter(v => v !== null && !isNaN(v));
    if (valid.length < 30) return EMPTY();

    const { highs, lows, volumes, fearGreed, symbol, ignoreWinnersFilter } = opts;

    // ── Calculate indicator arrays ────────────────────────────────
    const rsiArr  = Indicators.rsi(closes, 14);
    const sma50Period = closes.length >= 50 ? 50 : Math.max(10, Math.floor(closes.length / 2));
    const sma50   = Indicators.sma(closes, sma50Period);
    const sma200  = closes.length >= 200 ? Indicators.sma(closes, 200) : null;
    const ema9    = Indicators.ema(closes, 9);
    const ema21   = Indicators.ema(closes, 21);
    const macdData= Indicators.macd(closes);
    const bbData  = Indicators.bollingerBands(closes);
    const atrArr  = (highs && lows) ? Indicators.atr(highs, lows, closes, 14) : null;

    // ── Get current (latest) values ─────────────────────────────────────────
    const price     = Indicators.last(closes);
    const rsi       = Indicators.last(rsiArr);
    const macdLine  = Indicators.last(macdData.macdLine);
    const macdSig   = Indicators.last(macdData.signalLine);
    const macdHist  = Indicators.last(macdData.histogram);
    const curSma50  = Indicators.last(sma50);
    const curSma200 = sma200 ? Indicators.last(sma200) : null;
    const curEma9   = Indicators.last(ema9);
    const curEma21  = Indicators.last(ema21);
    const bbUpper   = Indicators.last(bbData.upper);
    const bbLower   = Indicators.last(bbData.lower);
    const bbMiddle  = Indicators.last(bbData.middle);
    const bbPctB    = Indicators.last(bbData.percentB);
    const crossover = Indicators.macdCrossover(macdData.macdLine, macdData.signalLine);

    let score = 0;
    const indDetails = {};

    // Trend regime: price vs long SMA decides whether oversold = dip-buy or falling knife.
    const trendRef  = curSma200 !== null && curSma200 !== undefined ? curSma200 : curSma50;
    const inUptrend = trendRef !== null && trendRef !== undefined ? price > trendRef : true;

    // ── 1. RSI scoring (max ±1.5, trend-aware) ──────────────────────────────
    // Oversold only earns buy points in an uptrend (pullback). In a downtrend,
    // oversold is a falling knife and earns nothing.
    if (rsi !== null) {
      let s = 0, sig = 'NEUTRAL', desc = '';
      if (inUptrend) {
        if      (rsi < 30)  { s =  1.5; sig = 'BUY';     desc = 'Oversold pullback within an uptrend — classic dip-buy zone'; }
        else if (rsi < 40)  { s =  1.0; sig = 'BUY';     desc = 'Cooling dip in an uptrend — favourable entry'; }
        else if (rsi <= 65) { s =  0.0; sig = 'NEUTRAL'; desc = 'Neutral momentum within an uptrend'; }
        else if (rsi <= 80) { s = -0.5; sig = 'NEUTRAL'; desc = 'Hot but uptrends can stay overbought — caution, not panic'; }
        else                { s = -1.0; sig = 'SELL';    desc = 'Extremely overbought even for an uptrend — pullback likely'; }
      } else {
        if      (rsi < 30)  { s =  0.0; sig = 'NEUTRAL'; desc = '⚠️ Oversold in a DOWNTREND — falling knife, no buy points awarded'; }
        else if (rsi < 40)  { s =  0.0; sig = 'NEUTRAL'; desc = 'Weak momentum in a downtrend — no edge'; }
        else if (rsi <= 60) { s = -0.5; sig = 'NEUTRAL'; desc = 'Downtrend with neutral RSI — trend still points down'; }
        else if (rsi <= 70) { s = -1.0; sig = 'SELL';    desc = 'Bear-market rally losing steam — common exit zone'; }
        else                { s = -1.5; sig = 'SELL';    desc = 'Overbought inside a downtrend — high reversal risk'; }
      }
      score += s;
      indDetails.rsi = { value: +rsi.toFixed(1), inUptrend, signal: sig, description: desc, score: s };
    }

    // ── 2. MACD scoring (max ±2) ────────────────────────────────────────────
    if (macdLine !== null && macdSig !== null) {
      let s = 0, sig = 'NEUTRAL', desc = '';
      if      (crossover === 'bullish')             { s =  2.0; sig = 'STRONG_BUY';  desc = '🔔 Bullish crossover! MACD just crossed above signal line'; }
      else if (crossover === 'bearish')             { s = -2.0; sig = 'STRONG_SELL'; desc = '🔔 Bearish crossover! MACD just crossed below signal line'; }
      else if (macdLine > 0 && macdLine > macdSig) { s =  1.0; sig = 'BUY';         desc = 'MACD above zero and above signal — uptrend momentum confirmed'; }
      else if (macdLine > 0 && macdLine < macdSig) { s =  0.0; sig = 'NEUTRAL';     desc = 'MACD positive but losing steam — momentum fading'; }
      else if (macdLine < 0 && macdLine > macdSig) { s =  0.0; sig = 'NEUTRAL';     desc = 'MACD negative but recovering — early recovery signs'; }
      else                                          { s = -1.0; sig = 'SELL';        desc = 'MACD below zero and below signal — downtrend momentum'; }
      score += s;
      indDetails.macd = {
        value: +macdLine.toFixed(8), signalValue: +macdSig.toFixed(8),
        histogram: +(macdHist || 0).toFixed(8), crossover,
        signal: sig, description: desc, score: s,
      };
    }

    // ── 3. Dual Moving Average (SMA & EMA) scoring (max ±2, heaviest weight) ──
    // Trend-following is the primary edge in crypto — weighted above RSI.
    if (price !== null && curEma9 !== null && curEma21 !== null) {
      let s = 0, sig = 'NEUTRAL', desc = '';
      
      const macroBullish = curSma50 !== null ? price > curSma50 : true;
      const microBullish = curEma9 > curEma21;

      if (macroBullish && microBullish) { 
        s = 2.0; sig = 'BUY'; desc = 'Bullish Day Trend (9 EMA > 21) & Bullish Macro Trend (Price > 50 SMA)'; 
      }
      else if (!macroBullish && !microBullish) { 
        s = -2.0; sig = 'SELL'; desc = 'Bearish Day Trend (9 EMA < 21) & Bearish Macro Trend (Price < 50 SMA)'; 
      }
      else if (macroBullish && !microBullish) { 
        s = -0.5; sig = 'NEUTRAL'; desc = 'Macro Bullish but short-term Day Trend is Bearish (Wait for 9 EMA crossover)'; 
      }
      else if (!macroBullish && microBullish) { 
        s = 0.5; sig = 'NEUTRAL'; desc = 'Day Trend Bullish but Macro Trend is Bearish (High risk counter-trend)'; 
      }

      score += s;
      indDetails.movingAvg = {
        price: +price.toFixed(8), 
        sma50: +(curSma50 || 0).toFixed(8), sma200: curSma200 ? +curSma200.toFixed(8) : null,
        sma50Period,
        ema9: +curEma9.toFixed(8), ema21: +curEma21.toFixed(8),
        macroBullish, microBullish,
        signal: sig, description: desc, score: s,
      };
    }

    // ── 4. Bollinger Bands scoring (max ±1) ──────────────────────────────────
    // Lower-band touches only earn buy points in an uptrend. In a downtrend,
    // hugging the lower band is normal falling-knife behaviour.
    if (bbPctB !== null) {
      let s = 0, sig = 'NEUTRAL', desc = '';
      if (inUptrend) {
        if      (bbPctB < 0.2)   { s =  1.0; sig = 'BUY';     desc = 'Dip to lower Bollinger Band within an uptrend — support bounce zone'; }
        else if (bbPctB > 0.95)  { s = -0.5; sig = 'NEUTRAL'; desc = 'Riding the upper band — strong but stretched'; }
        else                      { s =  0.0; sig = 'NEUTRAL'; desc = `Price within Bollinger range (${(bbPctB * 100).toFixed(0)}% of band width)`; }
      } else {
        if      (bbPctB < 0.2)   { s =  0.0; sig = 'NEUTRAL'; desc = '⚠️ Hugging lower band in a downtrend — knife behaviour, no buy points'; }
        else if (bbPctB > 0.8)   { s = -1.0; sig = 'SELL';    desc = 'Rally to upper band inside a downtrend — likely resistance rejection'; }
        else                      { s =  0.0; sig = 'NEUTRAL'; desc = `Price within Bollinger range (${(bbPctB * 100).toFixed(0)}% of band width)`; }
      }
      score += s;
      indDetails.bollinger = {
        upper: +(bbUpper || 0).toFixed(8), middle: +(bbMiddle || 0).toFixed(8), lower: +(bbLower || 0).toFixed(8),
        percentB: +(bbPctB * 100).toFixed(1), inUptrend,
        signal: sig, description: desc, score: s,
      };
    }

    // ── 5. Volume confirmation nudge (max ±0.5) ─────────────────────────────
    // Rising volume in the direction of the score confirms it; weak volume weakens it.
    if (volumes && volumes.length >= 20 && score !== 0) {
      const lastVol = volumes[volumes.length - 1];
      const avg20   = Indicators.avgLast(volumes.slice(0, -1), 20);
      if (lastVol != null && avg20 && avg20 > 0) {
        const ratio = lastVol / avg20;
        let s = 0, desc = '';
        if      (ratio >= 1.5) { s = score > 0 ?  0.5 : -0.5; desc = `Volume ${ratio.toFixed(1)}× the 20-day avg confirms the move.`; }
        else if (ratio <= 0.5) { s = score > 0 ? -0.3 :  0.3; desc = `Volume only ${ratio.toFixed(1)}× the 20-day avg — weak conviction.`; }
        else                   { desc = `Volume roughly average (${ratio.toFixed(1)}× 20-day avg).`; }
        score += s;
        indDetails.volume = {
          last: lastVol, avg20: +avg20.toFixed(2), ratio: +ratio.toFixed(2),
          signal: s > 0 ? 'BUY' : s < 0 ? 'SELL' : 'NEUTRAL',
          description: desc, score: s,
        };
      }
    }

    // ── 6. Fear & Greed sentiment gate (dampener, max −1.0) ─────────────
    // Extreme greed = crowded trade, late entry risk. Extreme fear = market-wide
    // crash where individual buy signals are unreliable. Both dampen buys only.
    if (typeof fearGreed === 'number' && isFinite(fearGreed) && score > 0) {
      let s = 0, desc = '';
      if      (fearGreed >= 75) { s = -1.0; desc = `Market in Extreme Greed (${fearGreed}) — crowded trade, buy signals discounted`; }
      else if (fearGreed <= 20) { s = -0.5; desc = `Market in Extreme Fear (${fearGreed}) — broad sell-off, buy signals less reliable`; }
      else                      { desc = `Market sentiment ${fearGreed}/100 — no adjustment`; }
      if (s !== 0 || desc) {
        score += s;
        indDetails.sentiment = {
          value: fearGreed,
          signal: s < 0 ? 'SELL' : 'NEUTRAL',
          description: desc, score: s,
        };
      }
    }

    // ── Confidence: % of sub-indicators agreeing with direction ──────────────
    const dir = score > 0.5 ? 'bull' : score < -0.5 ? 'bear' : 'flat';
    const indArr = Object.values(indDetails);
    const agree = indArr.filter(ind => {
      if (dir === 'bull') return ['BUY', 'STRONG_BUY'].includes(ind.signal);
      if (dir === 'bear') return ['SELL', 'STRONG_SELL'].includes(ind.signal);
      return ind.signal === 'NEUTRAL';
    }).length;
    const confidence = indArr.length > 0 ? Math.round((agree / indArr.length) * 100) : 0;

    // ── Determine composite signal via LEVELS.minScore ──────────────────────
    // Strong signals also require a confidence gate so a single dominant indicator
    // cannot fire a Strong Buy/Sell on its own.
    const CONF_GATE = (typeof CONFIG !== 'undefined' && CONFIG.refresh?.strongConfidenceGate) || 60;
    const L = this.LEVELS;
    let signal;
    if      (score >= L.STRONG_BUY.minScore  && confidence >= CONF_GATE) signal = 'STRONG_BUY';
    else if (score >= L.BUY.minScore)                                    signal = 'BUY';
    else if (score >= L.NEUTRAL.minScore)                                signal = 'NEUTRAL';
    else if (score >  L.SELL.minScore || confidence < CONF_GATE)         signal = 'SELL';
    else                                                                  signal = 'STRONG_SELL';

    // ── Proven-winners filter (config-driven, re-validate via backtest.js) ───
    // Buy signals on assets that historically lose money with this engine are
    // downgraded to NEUTRAL. Backtests can bypass via opts.ignoreWinnersFilter.
    let winnersFiltered = false;
    if (!ignoreWinnersFilter && symbol &&
        typeof CONFIG !== 'undefined' && CONFIG.signals?.winnersOnlyBuys &&
        Array.isArray(CONFIG.assets?.provenWinners) &&
        ['BUY', 'STRONG_BUY'].includes(signal)) {
      const base = String(symbol).toUpperCase().replace(/USDT$/, '');
      if (!CONFIG.assets.provenWinners.includes(base)) {
        signal = 'NEUTRAL';
        winnersFiltered = true;
      }
    }

    // ── ATR-based stop-loss suggestion ──────────────────────────────────────
    const curAtr = atrArr ? Indicators.last(atrArr) : null;
    let stopSuggest = null;
    if (curAtr && price) {
      const bullish = ['BUY', 'STRONG_BUY'].includes(signal);
      const bearish = ['SELL', 'STRONG_SELL'].includes(signal);
      if (bullish || bearish) {
        const mult = 2; // 2×ATR is a standard swing-trading stop
        stopSuggest = {
          atr: +curAtr.toFixed(8),
          stopPrice: +(bullish ? price - mult * curAtr : price + mult * curAtr).toFixed(8),
          distancePct: +((mult * curAtr / price) * 100).toFixed(2),
          side: bullish ? 'long' : 'short',
        };
      }
    }

    // ── Plain-English recommendation ─────────────────────────────────────────
    let recommendation = this._recommend(signal, score, indDetails, stopSuggest);
    if (winnersFiltered) {
      recommendation = '⚠️ Buy signal suppressed — this asset has a losing track record in backtests with this engine. ' + recommendation;
    }

    return {
      signal,
      confidence,
      score: +score.toFixed(2),
      indicators: indDetails,
      recommendation,
      stopSuggest,
      winnersFiltered,
      arrays: { rsi: rsiArr, macd: macdData, ema9, ema21, sma50, sma200, bb: bbData, atr: atrArr, closes },
      calculatedAt: new Date().toISOString(),
    };
  },

  // ─── Recommendation text ───────────────────────────────────────────────────
  _recommend(signal, score, ind, stop) {
    const rsi  = ind.rsi?.value;
    const cross = ind.macd?.crossover;
    const ma   = ind.movingAvg;
    const bb   = ind.bollinger;

    let text = [];
    switch (signal) {
      case 'STRONG_BUY':
        text.push('🚀 Strong buying conditions detected.');
        if (rsi && rsi < 35) text.push(`RSI at ${rsi} signals deeply oversold levels.`);
        if (cross === 'bullish') text.push('A MACD bullish crossover just fired — a classic entry trigger.');
        if (ma?.macroBullish && ma?.microBullish) text.push('Dual Bullish Alignment: 9 EMA > 21 EMA (Day Trend) and Price > 50 SMA (Macro Trend).');
        text.push('Consider entering with a defined stop-loss below nearest support. Risk only 1-2% of capital.');
        break;
      case 'BUY':
        text.push('📈 Favorable conditions to accumulate.');
        if (bb?.percentB < 0.2) text.push('Price is hugging the lower Bollinger Band, suggesting a potential bounce.');
        if (ma?.microBullish && !ma?.macroBullish) text.push('Note: Day trend is bullish (9 EMA > 21 EMA), but Macro Trend is bearish. Proceed with caution.');
        text.push('Look for confirmation on lower timeframes before entering a full position.');
        break;
      case 'NEUTRAL':
        text.push('⏸️ Mixed signals — no clear directional edge.');
        text.push('Sit on the sidelines or hold existing positions. Avoid new entries until a clearer setup forms.');
        text.push('Watch for a breakout above resistance or a breakdown below support.');
        break;
      case 'SELL':
        text.push('📉 Conditions lean bearish — consider reducing exposure.');
        if (rsi && rsi > 60) text.push(`RSI at ${rsi} suggests the asset may be running out of steam.`);
        if (ma && !ma.macroBullish) text.push('Price has broken below the 50-day moving average — a warning sign.');
        text.push('If holding a long position, consider tightening your stop-loss.');
        break;
      case 'STRONG_SELL':
        text.push('🔻 Strong selling conditions. High risk for longs.');
        if (rsi && rsi > 70) text.push(`RSI at ${rsi} is in extreme overbought territory.`);
        if (cross === 'bearish') text.push('A MACD bearish crossover confirms selling pressure.');
        text.push('⚠️ Do NOT average down against this signal. Protect your capital first.');
        break;
    }
    if (stop) {
      text.push(`🛡️ Suggested ${stop.side === 'long' ? 'stop-loss' : 'stop-out'}: ${stop.stopPrice} (2×ATR = ${stop.distancePct}% away).`);
    }
    return text.join(' ');
  },

  /** Return the LEVEL object for a given signal key */
  level(signalKey) {
    return this.LEVELS[signalKey] || this.LEVELS.NEUTRAL;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Signals;
