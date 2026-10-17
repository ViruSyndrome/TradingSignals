'use strict';

/**
 * Range / Red Bar Desk — trader sheet.
 * Primary: RedBarTrend (prior-day bands + opening range + red bar refs).
 * Secondary: EMA 10/30 overlay only (separate theory — confirmation chip, not the engine).
 */
const RangeEmaUI = {
  _timer: null,
  _busy: false,
  state: { rows: [], updatedAt: null, error: null },

  cfg() {
    return (typeof CONFIG !== 'undefined' && CONFIG.rangeEma) ? CONFIG.rangeEma : {};
  },

  init() {
    const c = this.cfg();
    if (!c.enabled) return;
    this.refresh();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.refresh(), 60 * 1000);
  },

  async refresh() {
    const c = this.cfg();
    if (!c.enabled || this._busy) return;
    if (typeof API === 'undefined' || typeof RedBarTrend === 'undefined') {
      this.state.error = 'Red Bar engine not loaded';
      this.render();
      return;
    }
    this._busy = true;
    try {
      const symbols = c.symbols || ['BTCUSDT'];
      const rows = [];
      for (const sym of symbols) {
        rows.push(await this._buildRow(sym, c));
      }
      this.state.rows = rows;
      this.state.updatedAt = Date.now();
      this.state.error = null;
    } catch (e) {
      this.state.error = e.message || String(e);
    } finally {
      this._busy = false;
      this.render();
    }
  },

  _klinesToBars(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((k) => ({
      t: +k[0],
      o: +k[1],
      h: +k[2],
      l: +k[3],
      c: +k[4],
    }));
  },

  _emaOverlay(bars, fast, slow) {
    if (typeof RangeEmaEngine === 'undefined' || !bars.length) {
      return { cross: 'n/a', emaFast: null, emaSlow: null };
    }
    const closes = bars.map((b) => b.c);
    const emaF = RangeEmaEngine.ema(closes, fast);
    const emaS = RangeEmaEngine.ema(closes, slow);
    const i = bars.length - 1;
    let cross = 'none';
    if (emaF[i] != null && emaS[i] != null && emaF[i - 1] != null && emaS[i - 1] != null) {
      const prevUp = emaF[i - 1] > emaS[i - 1];
      const nowUp = emaF[i] > emaS[i];
      if (!prevUp && nowUp) cross = 'bull_cross';
      else if (prevUp && !nowUp) cross = 'bear_cross';
      else cross = nowUp ? 'stacked_bull' : 'stacked_bear';
    }
    return { cross, emaFast: emaF[i], emaSlow: emaS[i] };
  },

  async _buildRow(symbol, c) {
    const lim30 = c.ohlcLimit30m || 1000;
    const raw30 = await API.getCryptoOHLC(symbol, c.workingTf || '30m', lim30);
    const bars30 = this._klinesToBars(raw30);
    if (bars30.length < 40) {
      return { symbol, error: 'Not enough 30m data' };
    }

    const readout = RedBarTrend.read(bars30, {
      lookbackDays: c.lookbackDays || 90,
      touchPct: c.touchPct ?? 0.15,
      dayMode: c.dayMode || 'utc',
    });

    const ema = this._emaOverlay(bars30, c.emaFast || 10, c.emaSlow || 30);

    // Optional: does EMA agree with Red Bar trend? (info only)
    let emaAgree = 'n/a';
    if (readout && ema.cross !== 'none' && ema.cross !== 'n/a') {
      const emaBull = ema.cross === 'bull_cross' || ema.cross === 'stacked_bull';
      const emaBear = ema.cross === 'bear_cross' || ema.cross === 'stacked_bear';
      if (readout.trend === 'bullish') emaAgree = emaBull ? 'agrees' : emaBear ? 'disagrees' : 'n/a';
      else if (readout.trend === 'bearish') emaAgree = emaBear ? 'agrees' : emaBull ? 'disagrees' : 'n/a';
      else emaAgree = 'neutral_trend';
    }

    return { symbol, readout, ema, emaAgree };
  },

  _fmt(n, d = 2) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  },

  _pct(from, to) {
    if (from == null || to == null || !from) return '';
    const p = ((to - from) / from) * 100;
    return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  },

  render() {
    const host = document.getElementById('rangeEmaDesk');
    if (!host) return;
    const c = this.cfg();
    if (!c.enabled) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    if (this.state.error && !this.state.rows.length) {
      host.innerHTML = `<div class="range-desk-error">Red Bar Desk: ${this.state.error}</div>`;
      return;
    }

    const cards = (this.state.rows || []).map((r) => this._cardHtml(r)).join('');
    const when = this.state.updatedAt
      ? new Date(this.state.updatedAt).toLocaleTimeString()
      : '—';

    host.innerHTML = `
      <div class="section-heading">
        <h1>🟥 Red Bar Desk</h1>
        <p class="section-sub">
          <strong>Trend prediction</strong> from prior-day range bars + today’s opening range + last red bar.
          EMA ${c.emaFast || 10}/${c.emaSlow || 30} is a <em>separate</em> overlay (agree/disagree only).
          You decide the trade on the chart.
          <span class="range-desk-meta">Updated ${when}</span>
        </p>
      </div>
      <div class="range-desk-grid">${cards || '<div class="range-desk-error">Loading…</div>'}</div>
      <p class="range-desk-footnote">Same Red Bar map works on Nifty, gold, oil, gas once that OHLC is wired. Crypto = Binance ${c.workingTf || '30m'}, day clock = ${c.dayMode || 'utc'}.</p>
    `;
  },

  _cardHtml(r) {
    if (r.error) {
      return `<div class="range-card glass"><h3>${r.symbol}</h3><p class="range-desk-error">${r.error}</p></div>`;
    }
    const o = r.readout;
    if (!o) {
      return `<div class="range-card glass"><h3>${r.symbol}</h3><p class="range-desk-error">No readout</p></div>`;
    }

    const trendCls =
      o.trend === 'bullish' ? 'pos' : o.trend === 'bearish' ? 'neg' : '';
    const trendWord =
      o.trend === 'bullish' ? 'BULLISH' : o.trend === 'bearish' ? 'BEARISH' : 'NEUTRAL';

    const bands =
      (o.activeBands || [])
        .map(
          (b) =>
            `<li><span class="band-day">${b.day}</span> ${this._fmt(b.low)} – ${this._fmt(b.high)} <em>mid ${this._fmt(b.mid)}</em></li>`
        )
        .join('') || '<li class="muted">Not inside a prior-day band right now</li>';

    const ema = r.ema || {};
    const agreeCls =
      r.emaAgree === 'agrees' ? 'pos' : r.emaAgree === 'disagrees' ? 'neg' : '';

    const base = r.symbol.replace('USDT', '');
    return `
      <article class="range-card glass">
        <header class="range-card-head">
          <h3>${base}</h3>
          <div class="range-price">${this._fmt(o.price)}</div>
        </header>

        <div class="range-trend-banner ${trendCls}">
          <span class="range-trend-label">Predicted trend</span>
          <strong>${trendWord}</strong>
        </div>
        <p class="range-narrative">${o.narrative}</p>

        <div class="range-chips">
          <span class="range-chip">OR bias: ${o.orBias}</span>
          <span class="range-chip">Phase: ${String(o.phase).replace(/_/g, ' ')}</span>
          <span class="range-chip">Bands: ${o.bandCountPrior} days</span>
        </div>

        <div class="range-magnets">
          <div><span class="lbl">Opening range high / low</span>
            <strong>${this._fmt(o.refs.orHigh)}</strong> / <strong>${this._fmt(o.refs.orLow)}</strong>
          </div>
          <div><span class="lbl">Next prior-day resistance</span>
            <strong>${this._fmt(o.refs.bandResist)}</strong> <em>${this._pct(o.price, o.refs.bandResist)}</em>
          </div>
          <div><span class="lbl">Next prior-day support</span>
            <strong>${this._fmt(o.refs.bandSupport)}</strong> <em>${this._pct(o.price, o.refs.bandSupport)}</em>
          </div>
          <div><span class="lbl">Last red bar high / low</span>
            <strong>${this._fmt(o.refs.redHigh)}</strong> / <strong>${this._fmt(o.refs.redLow)}</strong>
          </div>
          <div><span class="lbl">Invalidation lean</span><strong>${this._fmt(o.invalidation)}</strong></div>
          <div><span class="lbl">Book-profit reference</span><strong>${this._fmt(o.bookZone)}</strong></div>
        </div>

        <details class="range-band-details">
          <summary>Prior-day bands touching price (${(o.activeBands || []).length})</summary>
          <ul class="range-band-list">${bands}</ul>
        </details>

        <div class="range-ema-overlay">
          <div class="range-ema-title">EMA overlay <em>(separate theory)</em></div>
          <div class="range-ema-row">
            <span>EMA${this.cfg().emaFast || 10}: <strong>${this._fmt(ema.emaFast)}</strong></span>
            <span>EMA${this.cfg().emaSlow || 30}: <strong>${this._fmt(ema.emaSlow)}</strong></span>
          </div>
          <div class="range-chips">
            <span class="range-chip">${String(ema.cross || '').replace(/_/g, ' ')}</span>
            <span class="range-chip ${agreeCls}">vs Red Bar trend: ${r.emaAgree}</span>
          </div>
        </div>
      </article>`;
  },
};

if (typeof window !== 'undefined') window.RangeEmaUI = RangeEmaUI;
