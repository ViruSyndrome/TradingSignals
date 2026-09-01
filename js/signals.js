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
    STRONG_SELL: { label: 'Strong Sell', short: 'S.SELL', cls: 'strong-sell',  icon: '🔻', minScore: -3.5 },
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

    // ── Get Dynamic Parameters ─────────────────────────────────────
    const params = (typeof CONFIG !== 'undefined' && CONFIG.activeParams) || {
      emaFast: 9, emaSlow: 21, rsiPeriod: 14
    };

    // ── Calculate indicator arrays ────────────────────────────────
    const rsiArr  = Indicators.rsi(closes, params.rsiPeriod);
    const sma50Period = closes.length >= 50 ? 50 : Math.max(10, Math.floor(closes.length / 2));
    const sma50   = Indicators.sma(closes, sma50Period);
    const sma200  = closes.length >= 200 ? Indicators.sma(closes, 200) : null;
    const emaFast = Indicators.ema(closes, params.emaFast);
    const emaSlow = Indicators.ema(closes, params.emaSlow);
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
    const curEmaFast = Indicators.last(emaFast);
    const curEmaSlow = Indicators.last(emaSlow);
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
    if (price !== null && curEmaFast !== null && curEmaSlow !== null) {
      let s = 0, sig = 'NEUTRAL', desc = '';
      
      const macroBullish = curSma50 !== null ? price > curSma50 : true;
      const microBullish = curEmaFast > curEmaSlow;

      if (macroBullish && microBullish) { 
        s = 2.0; sig = 'BUY'; desc = `Bullish Day Trend (${params.emaFast} EMA > ${params.emaSlow} EMA) & Bullish Macro Trend (Price > 50 SMA)`; 
      }
      else if (!macroBullish && !microBullish) { 
        s = -2.0; sig = 'SELL'; desc = `Bearish Day Trend (${params.emaFast} EMA < ${params.emaSlow} EMA) & Bearish Macro Trend (Price < 50 SMA)`; 
      }
      else if (macroBullish && !microBullish) { 
        s = -0.5; sig = 'NEUTRAL'; desc = `Macro Bullish but short-term Day Trend is Bearish (Wait for ${params.emaFast} EMA crossover)`; 
      }
      else if (!macroBullish && microBullish) { 
        s = 0.5; sig = 'NEUTRAL'; desc = 'Day Trend Bullish but Macro Trend is Bearish (High risk counter-trend)'; 
      }

      score += s;
      indDetails.movingAvg = {
        price: +price.toFixed(8), 
        sma50: +(curSma50 || 0).toFixed(8), sma200: curSma200 ? +curSma200.toFixed(8) : null,
        sma50Period,
        emaFast: +curEmaFast.toFixed(8), emaSlow: +curEmaSlow.toFixed(8),
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
      if (s !== 0) {
        score += s;
        indDetails.sentiment = {
          value: fearGreed,
          signal: s < 0 ? 'SELL' : 'NEUTRAL',
          description: desc, score: s,
        };
      }
    }

    // ── 7. Fundamental Analysis (DefiLlama TVL) ─────────────
    // Deep Value = >$1B TVL, Value = >$100M TVL, Speculative = <$10M TVL
    const rawScore = +score.toFixed(2); // Capture score BEFORE TVL adjustment
    if (opts.tvl && opts.tvl > 0) {
      const tvl = opts.tvl;
      const tvlStr = tvl > 1e9 ? `$${(tvl/1e9).toFixed(1)}B` : tvl > 1e6 ? `$${(tvl/1e6).toFixed(1)}M` : `$${tvl.toFixed(0)}`;
      let s = 0, sig = 'NEUTRAL', desc = `Locked Value: ${tvlStr}`;
      
      if (tvl >= 1e9) { s = 1.0; sig = 'BUY'; desc = `Deep Value: Over $1 Billion locked (${tvlStr})`; }
      else if (tvl >= 1e8) { s = 0.5; sig = 'BUY'; desc = `Value: Over $100 Million locked (${tvlStr})`; }
      else if (tvl < 1e7) { s = -0.5; sig = 'SELL'; desc = `Speculative: Low locked value (${tvlStr})`; }
      
      score += s;
      indDetails.fundamental = {
        value: tvl,
        signal: sig,
        description: desc, score: s,
      };
    }

    // ── 9. Intraday Timing Confirmation (4H RSI) ─────────────────────────
    // Uses the 4-hour RSI to confirm or warn about entry timing.
    if (opts.closes4H && opts.closes4H.length >= 20) {
      const rsi4H = Indicators.last(Indicators.rsi(opts.closes4H, 14));
      if (rsi4H !== null) {
        let timingScore = 0;
        let timingDesc = '';
        if (score > 0 && rsi4H < 40) {
          timingScore = 0.5;
          timingDesc = `4H RSI at ${Math.round(rsi4H)} confirms oversold entry window.`;
        } else if (score > 0 && rsi4H > 70) {
          timingScore = -0.5;
          timingDesc = `⏳ 4H RSI at ${Math.round(rsi4H)} is overbought — consider waiting for a pullback before entering.`;
        } else if (score < 0 && rsi4H > 70) {
          timingScore = -0.5;
          timingDesc = `4H RSI at ${Math.round(rsi4H)} confirms overbought exit window.`;
        }
        if (timingScore !== 0) {
          score += timingScore;
          indDetails.timing4H = {
            signal: timingScore > 0 ? 'CONFIRM' : 'WAIT',
            description: timingDesc,
            score: timingScore,
            rsi4H: Math.round(rsi4H),
          };
        }
      }
    }

    // ── 8. Market Regime (BTC) Gate (dampener, max −1.5) ─────────────
    if (opts.marketRegime === 'bear' && symbol !== 'BTC' && symbol !== 'BTCUSDT' && score > 0) {
      const s = -1.5;
      score += s;
      indDetails.regime = {
        signal: 'SELL',
        description: 'Market Regime is Bearish (BTC < 50 SMA). Altcoin breakouts are likely traps.',
        score: s
      };
    }

    // ── Confidence: % of sub-indicators agreeing with direction ──────────────
    const dir = score > 0.5 ? 'bull' : score < -0.5 ? 'bear' : 'flat';
    const indArr = Object.values(indDetails);
    const directionalIndicators = indArr.filter(ind => Math.abs(ind.score || 0) > 0.05);
    const confidencePool = directionalIndicators.length > 0 ? directionalIndicators : indArr;
    const agree = confidencePool.filter(ind => {
      if (dir === 'bull') return ['BUY', 'STRONG_BUY'].includes(ind.signal);
      if (dir === 'bear') return ['SELL', 'STRONG_SELL'].includes(ind.signal);
      return ind.signal === 'NEUTRAL';
    }).length;
    const confidence = confidencePool.length > 0 ? Math.round((agree / confidencePool.length) * 100) : 0;

    // ── Determine composite signal via base action + conviction ──────────────
    // Strong tiers are conviction badges on top of Buy/Sell, not separate
    // score buckets triggered by one dominant indicator.
    const CONF_GATE = (typeof CONFIG !== 'undefined' && CONFIG.refresh?.strongConfidenceGate) || 60;
    const WEAK_GATE = 30; // Require at least ~2 out of 6 indicators to agree for any Buy/Sell
    const L = this.LEVELS;
    const ma = indDetails.movingAvg;
    const macd = indDetails.macd;
    const bullishTrendAligned = !!(ma?.macroBullish && ma?.microBullish);
    const bearishTrendAligned = !!(ma && !ma.macroBullish && !ma.microBullish);
    const bullishMomentumConfirmed = ['BUY', 'STRONG_BUY'].includes(macd?.signal) &&
      (macd?.crossover === 'bullish' || ((macd?.value ?? 0) > (macd?.signalValue ?? 0)));
    const bearishMomentumConfirmed = ['SELL', 'STRONG_SELL'].includes(macd?.signal) &&
      (macd?.crossover === 'bearish' || ((macd?.value ?? 0) < (macd?.signalValue ?? 0)));
    
    let signal = 'NEUTRAL';
    if (score >= L.BUY.minScore && confidence >= WEAK_GATE) {
      signal = 'BUY';
      if (score >= L.STRONG_BUY.minScore && confidence >= CONF_GATE && bullishTrendAligned && bullishMomentumConfirmed) {
        signal = 'STRONG_BUY';
      }
    } else if (score <= L.SELL.minScore && confidence >= WEAK_GATE) {
      signal = 'SELL';
      if (score <= L.STRONG_SELL.minScore && confidence >= CONF_GATE && bearishTrendAligned && bearishMomentumConfirmed) {
        signal = 'STRONG_SELL';
      }
    }

    const conviction = signal === 'STRONG_BUY' || signal === 'STRONG_SELL'
      ? 'strong'
      : signal === 'BUY' || signal === 'SELL'
        ? 'standard'
        : 'none';

    // ── Proven-winners filter (config-driven, re-validate via backtest.js) ───
    // Buy signals on assets that historically lose money with this engine are
    // downgraded to NEUTRAL. Backtests can bypass via opts.ignoreWinnersFilter.
    let winnersFiltered = false;
    let coreOnlyFiltered = false;
    let winnerTier = 'none';
    if (!ignoreWinnersFilter && symbol &&
        typeof CONFIG !== 'undefined' && CONFIG.signals?.winnersOnlyBuys &&
        Array.isArray(CONFIG.assets?.provenWinners) &&
        ['BUY', 'STRONG_BUY'].includes(signal)) {
      const base = String(symbol).toUpperCase().replace(/USDT$/, '');
      if (Array.isArray(CONFIG.assets?.coreWinners) && CONFIG.assets.coreWinners.includes(base)) {
        winnerTier = 'core';
      } else if (Array.isArray(CONFIG.assets?.probationWinners) && CONFIG.assets.probationWinners.includes(base)) {
        winnerTier = 'probation';
      }
      if (!CONFIG.assets.provenWinners.includes(base)) {
        signal = 'NEUTRAL';
        winnersFiltered = true;
      } else if (CONFIG.signals?.coreOnlyBuys && winnerTier === 'probation') {
        signal = 'NEUTRAL';
        coreOnlyFiltered = true;
      }
    }

    // ── ATR-based stop-loss + take-profit suggestion ────────────────────────
    // Take-profit at 2R matches the backtest's exit model — the edge only
    // holds up if both legs are actually placed, not just the stop.
    const curAtr = atrArr ? Indicators.last(atrArr) : null;
    let stopSuggest = null;
    if (curAtr && price) {
      // Always generate an OCO bracket so the user can manually paper-trade even neutral/suppressed coins
      // By default, assume long unless the raw mathematical signal explicitly says SELL
      const isShort = ['SELL', 'STRONG_SELL'].includes(signal) || score < -2;
      const mult = 2; // 2×ATR is a standard swing-trading stop
      const risk = mult * curAtr;
      const stopPrice = !isShort ? price - risk : price + risk;
      const takeProfitPrice = !isShort ? price + 2 * risk : price - 2 * risk;
      
      stopSuggest = {
        atr: +curAtr.toFixed(8),
        stopPrice: +stopPrice.toFixed(8),
        takeProfitPrice: +takeProfitPrice.toFixed(8),
        distancePct: +((risk / price) * 100).toFixed(2),
        takeProfitPct: +((2 * risk / price) * 100).toFixed(2),
        side: !isShort ? 'long' : 'short',
      };
    }

    // ── Plain-English recommendation ─────────────────────────────────────────
    let recommendation = this._recommend(signal, score, indDetails, stopSuggest, params);
    if (winnersFiltered) {
      recommendation = '⚠️ Buy signal suppressed — this asset has a losing track record in backtests with this engine. ' + recommendation;
    } else if (coreOnlyFiltered) {
      recommendation = '🧪 Watchlist-only setup — this asset is on probation, so bullish signals are hidden until it proves robust enough to join the core winners. ' + recommendation;
    }

    return {
      signal,
      conviction,
      confidence,
      score: +score.toFixed(2),
      rawScore: typeof rawScore !== 'undefined' ? rawScore : +score.toFixed(2),
      indicators: indDetails,
      recommendation,
      stopSuggest,
      winnersFiltered,
      coreOnlyFiltered,
      winnerTier,
      arrays: { rsi: rsiArr, macd: macdData, emaFast, emaSlow, sma50, sma200, bb: bbData, atr: atrArr, closes },
      calculatedAt: new Date().toISOString(),
    };
  },

  // ─── Recommendation text ───────────────────────────────────────────────────
  _recommend(signal, score, ind, stop, params) {
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
        if (ma?.macroBullish && ma?.microBullish) text.push(`Dual Bullish Alignment: ${params.emaFast} EMA > ${params.emaSlow} EMA (Day Trend) and Price > 50 SMA (Macro Trend).`);
        text.push('Consider entering with a defined stop-loss below nearest support. Risk only 1-2% of capital.');
        break;
      case 'BUY':
        text.push('📈 Favorable conditions to accumulate.');
        if (bb?.percentB < 0.2) text.push('Price is hugging the lower Bollinger Band, suggesting a potential bounce.');
        if (ma?.macroBullish && ma?.microBullish) text.push(`Both short-term (${params.emaFast}/${params.emaSlow} EMA) and long-term (50 SMA) trends are bullish.`);
        if (ma?.microBullish && !ma?.macroBullish) text.push(`Note: Day trend is bullish (${params.emaFast} EMA > ${params.emaSlow} EMA), but Macro Trend is bearish. Proceed with caution.`);
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


  // ─── Dedicated Breakout Engine (Moonshots / High-Gain Runners) ─────────────
  // Looks for Bollinger Squeezes followed by volume surges and price breakouts.
  // Ignores standard mean-reversion metrics.
  generateBreakout(closes, opts = {}) {
    const EMPTY = (reason = 'Insufficient data') => ({
      signal: 'NEUTRAL', confidence: 0, score: 0, indicators: {},
      recommendation: reason, arrays: {}, calculatedAt: new Date().toISOString(),
    });

    if (!closes || closes.length < 30) return EMPTY();
    const { highs, lows, volumes, marketRegime } = opts;

    // ── Calculate required indicator arrays ───────────────────────
    const bbData = Indicators.bollingerBands(closes, 20, 2);
    const bbwArr = bbData.bandWidth; // Normalized BBW array
    const sma50Arr = Indicators.sma(closes, 50);
    const ema9Arr = Indicators.ema(closes, 9);
    const rsiArr = Indicators.rsi(closes, 14);
    
    // ── Current Values ───────────────────────────────────────────
    const price = Indicators.last(closes);
    const bbUpper = Indicators.last(bbData.upper);
    const previousBbUpper = bbData.upper.length >= 2 ? bbData.upper[bbData.upper.length - 2] : null;
    const bbLower = Indicators.last(bbData.lower);
    const bbw = Indicators.last(bbwArr);
    const ema9 = Indicators.last(ema9Arr);
    const rsiVal = Indicators.last(rsiArr);
    const lookbackStart = Math.max(0, closes.length - 21);
    const priorHighs = highs?.slice(lookbackStart, -1).filter(Number.isFinite) || [];
    const priorSwingHigh = priorHighs.length ? Math.max(...priorHighs) : null;
    const priorClose = closes.length >= 2 ? closes[closes.length - 2] : null;
    
    // Average BBW over last 20 days to detect compression
    const bbwAvg20 = Indicators.avgLast(bbwArr, 20);
    const prevBbw = bbwArr.length >= 2 ? bbwArr[bbwArr.length - 2] : null;
    // We check if it was squeezing BEFORE the breakout blew the bands open
    const isSqueezing = prevBbw !== null && bbwAvg20 !== null && prevBbw < bbwAvg20 * 0.8; 

    // Volume Surge Detection
    let isVolumeSurge = false;
    let volumeRatio = 1;
    if (volumes && volumes.length >= 20) {
      const currentVol = volumes[volumes.length - 1];
      const avgVol = Indicators.avgLast(volumes.slice(0, -2), 20);
      if (avgVol && avgVol > 0) {
        const curRatio = currentVol / avgVol;
        volumeRatio = curRatio;
        isVolumeSurge = volumeRatio >= 1.5; // 150% average volume
      }
    }

    let score = 0;
    let desc = [];
    
    // 1. Core Breakout logic (Price crossing above Upper Band)
    const breakoutBuffer = price > bbUpper ? (price - bbUpper) / bbUpper : 0;
    // We want the PREVIOUS close to be inside the bands, and the CURRENT close to break out above them.
    const isBreakingOut = price > bbUpper && breakoutBuffer >= 0.005 && (
      // Check current candle: prior close was inside bands
      (priorClose !== null && previousBbUpper !== null && priorClose <= previousBbUpper) ||
      // OR check 2nd-to-last candle (breakout happened 1 candle ago, still holding)
      (closes.length >= 3 && bbData.upper.length >= 3 &&
        closes[closes.length - 3] <= bbData.upper[bbData.upper.length - 3] &&
        closes[closes.length - 2] > bbData.upper[bbData.upper.length - 2])
    );
    if (isBreakingOut) {
      score += 2;
      desc.push("Closed above the upper Bollinger Band.");
      // Bonus for also exceeding prior swing high
      if (priorSwingHigh !== null && price > priorSwingHigh) {
        score += 0.5;
        desc.push("Also exceeded the prior 20-bar swing high.");
      }
    }
    
    // 2. Squeeze condition (Coiled Spring)
    if (isSqueezing && isBreakingOut) {
      score += 2;
      desc.push("Volatility Squeeze detected: Breakout is occurring after extreme consolidation.");
    }
    
    // 3. Volume Anomaly (Whale Buying)
    if (isVolumeSurge && isBreakingOut) {
      score += 1.5;
      desc.push(`Volume Anomaly: ${volumeRatio.toFixed(1)}x average volume confirming the move.`);
    }

    // 4. Trend Alignment (Don't buy falling knives)
    const healthyBreakoutCandle = priorClose !== null && price > priorClose;
    if (price > ema9 && healthyBreakoutCandle) {
      score += 0.5;
    } else {
      score -= 2;
      desc.push("Price is below 9 EMA. Breakout failed.");
    }

    // 5. Market Regime Filter (Protect against BTC dumps)
    if (marketRegime === 'bear' && opts.symbol !== 'BTC' && opts.symbol !== 'BTCUSDT') {
      score -= 3; // Huge penalty for breakout attempts during a market crash
      desc.push("Market Regime is Bearish (BTC < 50 SMA). Breakouts are likely fakeouts.");
    }

    const rawScore = +score.toFixed(2);
    let tvlData = undefined;
    if (opts.tvl && opts.tvl > 0) {
      const tvl = opts.tvl;
      const tvlStr = tvl > 1e9 ? `$${(tvl/1e9).toFixed(1)}B` : tvl > 1e6 ? `$${(tvl/1e6).toFixed(1)}M` : `$${tvl.toFixed(0)}`;
      let s = 0, sig = 'NEUTRAL', tDesc = `Locked Value: ${tvlStr}`;
      
      if (tvl >= 1e9) { s = 1.0; sig = 'BUY'; tDesc = `Deep Value: Over $1 Billion locked (${tvlStr})`; }
      else if (tvl >= 1e8) { s = 0.5; sig = 'BUY'; tDesc = `Value: Over $100 Million locked (${tvlStr})`; }
      else if (tvl < 1e7) { s = -0.5; sig = 'SELL'; tDesc = `Speculative: Low locked value (${tvlStr})`; }
      
      score += s;
      if (s !== 0) desc.push(tDesc);
      tvlData = { signal: sig, value: tvl, formatted: tvlStr, description: tDesc, score: s };
    }

    let signal = 'NEUTRAL';
    if (score >= 5.0) signal = 'STRONG_BUY';
    else if (score >= 3.0) signal = 'BUY';
    else if (score <= -2.0) signal = 'SELL';

    // Standard ATR-based Stop-Loss (safer than Chandelier which can invert on crashes)
    const chandExit = Indicators.chandelierExit(highs, lows, closes, 22, 3);
    let stopSuggest = null;
    const atrArr = Indicators.atr(highs, lows, closes, 14);
    const curAtr = Indicators.last(atrArr);
    
    if (curAtr && (signal.includes('BUY') || signal.includes('SELL'))) {
      const isLong = signal.includes('BUY');
      const mult = 2.5; // Slightly wider stop for highly volatile moonshots
      const risk = curAtr * mult;
      const stopPrice = isLong ? price - risk : price + risk;
      const takeProfitPrice = isLong ? price + risk * 2 : price - risk * 2;
      const distPct = ((risk / price) * 100).toFixed(2);
      
      stopSuggest = {
        stopPrice: +stopPrice.toFixed(8),
        takeProfitPrice: +takeProfitPrice.toFixed(8),
        distancePct: +distPct,
        takeProfitPct: +(((risk * 2) / price) * 100).toFixed(2),
        riskMultiple: 2,
        side: isLong ? 'long' : 'short'
      };
      desc.push(`Suggested Stop: ${stopPrice.toFixed(8)} (${distPct}% away) with a 2R partial-profit target.`);
    }

    return {
      signal,
      conviction: signal === 'STRONG_BUY' ? 'strong' : (signal === 'BUY' ? 'standard' : 'none'),
      confidence: score >= 5.0 ? 100 : (score >= 3.0 ? 75 : 0),
      score: +score.toFixed(2),
      rawScore: rawScore,
      indicators: {
        breakout: { isSqueezing, isBreakingOut, breakoutBuffer: +(breakoutBuffer * 100).toFixed(2), priorSwingHigh, healthyBreakoutCandle, volumeRatio, isVolumeSurge },
        rsi: { value: rsiVal !== null ? Math.round(rsiVal) : null },
        tvl: tvlData
      },
      recommendation: desc.join(' ') || 'No breakout setup detected.',
      stopSuggest,
      riskPlan: stopSuggest ? {
        riskMultiple: 2,
        suggestedAccountRiskPct: 1,
        maxConcurrentPositions: 2,
        stopPrice: stopSuggest.stopPrice,
        takeProfitPrice: stopSuggest.takeProfitPrice,
      } : null,
      winnersFiltered: false, // Moonshots bypass this
      coreOnlyFiltered: false,
      winnerTier: 'none',
      arrays: { closes, highs, lows, bb: bbData, chandelier: chandExit, rsi: rsiArr },
      calculatedAt: new Date().toISOString(),
    };
  },

  // ─── Scalper Engine (5-minute meme coins) ──────────────────────────────────
  generateScalp(closes, opts = {}) {
    const EMPTY = (reason = 'Insufficient data') => ({
      signal: 'NEUTRAL', confidence: 0, score: 0, indicators: {},
      recommendation: reason, arrays: {}, calculatedAt: new Date().toISOString(),
    });

    if (!closes || closes.length < 50) return EMPTY();
    const { highs, lows, volumes } = opts;

    const ema9Arr = Indicators.ema(closes, 9);
    const ema21Arr = Indicators.ema(closes, 21);
    const sma50Arr = Indicators.sma(closes, 50);
    const rsiArr = Indicators.rsi(closes, 14);
    const bbData = Indicators.bollingerBands(closes, 20, 2);

    const price = Indicators.last(closes);
    const ema9 = Indicators.last(ema9Arr);
    const ema21 = Indicators.last(ema21Arr);
    const sma50 = Indicators.last(sma50Arr);
    const rsiVal = Indicators.last(rsiArr);
    const bbUpper = Indicators.last(bbData.upper);

    let score = 0;
    let desc = [];

    // ── 1. Uptrend Structure (EMA stack must be bullish) ─────────────
    const uptrendAligned = ema9 > ema21 && price > sma50;
    if (uptrendAligned) {
      score += 1;
      desc.push("Uptrend intact: EMA9 > EMA21 and price above SMA50.");
    } else {
      score -= 3;
      desc.push("No uptrend structure — skipping.");
    }

    // ── 2. Pullback Detection (price near EMA support, not chasing) ──
    // Price should be within 0.5% of EMA9 or between EMA9 and EMA21
    const distFromEma9 = ema9 > 0 ? ((price - ema9) / ema9) * 100 : 999;
    const distFromEma21 = ema21 > 0 ? ((price - ema21) / ema21) * 100 : 999;

    if (distFromEma9 >= -0.3 && distFromEma9 <= 0.5) {
      // Touching or just above EMA9 — ideal shallow pullback
      score += 2.5;
      desc.push(`Price at EMA9 support (${distFromEma9.toFixed(2)}% away) — ideal shallow pullback entry.`);
    } else if (distFromEma9 > 0.5 && distFromEma9 <= 1.0 && distFromEma21 >= 0) {
      // Slightly above EMA9 but still reasonable
      score += 1.5;
      desc.push(`Price near EMA9 (${distFromEma9.toFixed(2)}% above) — acceptable entry window.`);
    } else if (distFromEma21 >= -0.3 && distFromEma21 <= 0.5 && distFromEma9 < 0) {
      // Deeper pullback to EMA21 — still valid if uptrend holds
      score += 2;
      desc.push(`Price at EMA21 support (${distFromEma21.toFixed(2)}% away) — deeper pullback entry.`);
    } else if (distFromEma9 > 1.0) {
      // Too far above EMAs — you're chasing
      score -= 2;
      desc.push(`Price is ${distFromEma9.toFixed(2)}% above EMA9 — too extended, don't chase.`);
    } else {
      score -= 1;
      desc.push("Price not near any EMA support level.");
    }

    // ── 3. RSI Cooling Check ──────────────────────────────────────────
    // We want RSI to have cooled down to a "room to run" zone, not overbought
    if (rsiVal >= 40 && rsiVal <= 60) {
      score += 1.5;
      desc.push(`RSI at ${Math.round(rsiVal)} — cooled and ready to bounce.`);
    } else if (rsiVal > 60 && rsiVal <= 70) {
      score += 0.5;
      desc.push(`RSI at ${Math.round(rsiVal)} — momentum present but watch for exhaustion.`);
    } else if (rsiVal > 70) {
      score -= 2;
      desc.push(`RSI at ${Math.round(rsiVal)} — OVERBOUGHT. High risk of immediate reversal.`);
    } else if (rsiVal < 40 && rsiVal >= 30) {
      score += 0.5;
      desc.push(`RSI at ${Math.round(rsiVal)} — oversold, potential bounce zone.`);
    }

    // ── 4. Recent Impulse Check (was this coin hot recently?) ─────────
    // Check if price touched or exceeded upper BB within last 5 candles
    const recentHighs = closes.slice(-6, -1);
    const recentBBUpper = bbData.upper.slice(-6, -1);
    let hadRecentImpulse = false;
    for (let i = 0; i < recentHighs.length; i++) {
      if (recentBBUpper[i] && recentHighs[i] >= recentBBUpper[i] * 0.995) {
        hadRecentImpulse = true;
        break;
      }
    }
    if (hadRecentImpulse) {
      score += 1;
      desc.push("Recent impulse detected — price touched upper BB within last 5 candles.");
    }

    // ── 5. Bullish Candle Confirmation ────────────────────────────────
    // Current candle should be green (close > open approximation using close vs prior close)
    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;
    const isBullishCandle = price > prevClose;
    if (isBullishCandle && uptrendAligned) {
      score += 0.5;
      desc.push("Current candle is bullish — bounce confirmation.");
    }

    // ── 6. Volume Check (settling, not surging) ──────────────────────
    let volumeRatio = 1;
    let isVolumeSurge = false;
    if (volumes && volumes.length >= 20) {
      const currentVol = volumes[volumes.length - 1];
      const avgVol = Indicators.avgLast(volumes.slice(0, -2), 20);
      if (avgVol && avgVol > 0) {
        volumeRatio = currentVol / avgVol;
        isVolumeSurge = volumeRatio >= 2.0;
        // We WANT volume to have settled (pullback on low volume = healthy)
        if (volumeRatio < 1.0) {
          score += 0.5;
          desc.push(`Volume settling (${volumeRatio.toFixed(1)}x avg) — healthy pullback.`);
        } else if (volumeRatio >= 1.0 && volumeRatio < 2.0) {
          // Normal volume, neutral
        } else {
          // Surge on pullback = panic selling, not ideal
          score -= 0.5;
          desc.push(`High volume on pullback (${volumeRatio.toFixed(1)}x avg) — may indicate selling pressure.`);
        }
      }
    }

    let signal = 'NEUTRAL';
    if (score >= 5.5) signal = 'STRONG_BUY';
    else if (score >= 4.0) signal = 'BUY';

    // Standard ATR-based Stop-Loss
    const chandExit = Indicators.chandelierExit(highs, lows, closes, 14, 1.5);
    let stopSuggest = null;
    const atrArr = Indicators.atr(highs, lows, closes, 14);
    const curAtr = Indicators.last(atrArr);

    if (curAtr && signal.includes('BUY')) {
      const mult = 1.5; // Tighter stop for scalps
      const risk = curAtr * mult;
      const stopPrice = price - risk;
      const takeProfitPrice = price + risk * 2.0; // 2R target for pullback trades
      const distPct = ((risk / price) * 100).toFixed(2);
      
      stopSuggest = {
        stopPrice: +stopPrice.toFixed(8),
        takeProfitPrice: +takeProfitPrice.toFixed(8),
        distancePct: +distPct,
        takeProfitPct: +(((risk * 2.0) / price) * 100).toFixed(2),
        riskMultiple: 2.0,
        side: 'long'
      };
      desc.push(`Scalp stop: ${stopPrice.toFixed(8)} (${distPct}% away) with 2R exit target.`);
    }

    return {
      signal,
      conviction: signal === 'STRONG_BUY' ? 'strong' : (signal === 'BUY' ? 'standard' : 'none'),
      confidence: score >= 5.5 ? 100 : (score >= 4.0 ? 75 : 0),
      score: +score.toFixed(2),
      indicators: {
        scalp: { volumeRatio, isVolumeSurge, hadRecentImpulse, distFromEma9: +distFromEma9.toFixed(2) },
        rsi: { value: rsiVal !== null ? Math.round(rsiVal) : null }
      },
      recommendation: desc.join(' ') || 'No scalp setup detected.',
      stopSuggest,
      arrays: { closes, highs, lows, chandelier: chandExit, rsi: rsiArr },
      calculatedAt: new Date().toISOString(),
    };
  },

  /** Return the LEVEL object for a given signal key */
  level(signalKey) {
    return this.LEVELS[signalKey] || this.LEVELS.NEUTRAL;
  },

  _version: '5.60',
};

if (typeof module !== 'undefined' && module.exports) module.exports = Signals;
