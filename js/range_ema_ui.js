'use strict';

/**
 * Red Bar Desk — visual trader sheet.
 * Chart + LONG / SHORT / WAIT action strip + levels.
 * EMA is overlay only.
 */
const RangeEmaUI = {
  _timer: null,
  _refreshGen: 0,
  _chart: null,
  _chartRo: null,
  state: {
    rows: [],
    updatedAt: null,
    error: null,
    tf: null,
    instrumentId: null,
    loading: false,
  },

  cfg() {
    return (typeof CONFIG !== 'undefined' && CONFIG.rangeEma) ? CONFIG.rangeEma : {};
  },

  /**
   * True on phones even when Chrome "Desktop site" inflates CSS width (~980px).
   * Uses device-width + touch + visualViewport so layout/chart density stay mobile.
   */
  isPhoneLayout() {
    if (typeof window === 'undefined') return false;
    try {
      if (window.matchMedia('(max-device-width: 900px)').matches) return true;
      if (window.matchMedia('(pointer: coarse) and (hover: none) and (max-width: 1100px)').matches) {
        return true;
      }
    } catch (_) {}
    const vw = window.visualViewport?.width || window.innerWidth || 0;
    return vw > 0 && vw < 720;
  },

  /** Sync html.is-phone for CSS (sidebar drawer, chart height) under desktop-site. */
  syncPhoneClass() {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('is-phone', this.isPhoneLayout());
  },

  instruments() {
    const c = this.cfg();
    if (Array.isArray(c.instruments) && c.instruments.length) return c.instruments;
    return [{
      id: 'BTC',
      label: 'BTC',
      symbol: (c.symbols && c.symbols[0]) || 'BTCUSDT',
      feed: 'binanceSpot',
      dayMode: c.dayMode || 'utc',
      priceDecimals: 2,
      tradeHint: 'Binance USDⓈ-M · BTCUSDT',
      showSessionMarkers: c.showSessionMarkers !== false,
      sessions: c.sessions || [],
    }];
  },

  activeInstrument() {
    const list = this.instruments();
    const id = this.state.instrumentId || this.cfg().defaultInstrument || list[0]?.id;
    return list.find((x) => x.id === id) || list[0];
  },

  setInstrument(id) {
    const list = this.instruments();
    if (!list.some((x) => x.id === id) || id === this.activeInstrument()?.id) return;
    this.state.instrumentId = id;
    try { localStorage.setItem('trendrunner_rb_instrument', id); } catch (_) {}
    // Immediate feedback — never wait on a stuck prior fetch
    this.state.loading = true;
    this.state.error = null;
    this.render();
    this.refresh();
  },

  activeTf() {
    const c = this.cfg();
    const inst = this.activeInstrument() || {};
    const allowed = inst.timeframes || c.timeframes || ['5m', '30m', '1h'];
    const tf = this.state.tf || c.workingTf || '30m';
    return allowed.includes(tf) ? tf : allowed[0];
  },

  setTf(tf) {
    const c = this.cfg();
    const inst = this.activeInstrument() || {};
    const allowed = inst.timeframes || c.timeframes || ['5m', '30m', '1h'];
    if (!allowed.includes(tf) || tf === this.activeTf()) return;
    this.state.tf = tf;
    try { localStorage.setItem('trendrunner_rb_tf', tf); } catch (_) {}
    // Drop old TF row so we don't paint 30m fibs on a 5m switch (or vice versa)
    this.state.rows = [];
    this.state.loading = true;
    this.state.error = null;
    this.render();
    this.refresh();
  },

  init() {
    const c = this.cfg();
    if (!c.enabled) return;
    this.syncPhoneClass();
    if (!this._phoneListen) {
      this._phoneListen = true;
      const sync = () => {
        this.syncPhoneClass();
      };
      window.addEventListener('resize', sync, { passive: true });
      window.addEventListener('orientationchange', sync, { passive: true });
      window.visualViewport?.addEventListener('resize', sync, { passive: true });
    }
    try {
      const savedTf = localStorage.getItem('trendrunner_rb_tf');
      const allowed = c.timeframes || ['5m', '30m', '1h'];
      if (savedTf && allowed.includes(savedTf)) this.state.tf = savedTf;
      const savedInst = localStorage.getItem('trendrunner_rb_instrument');
      if (savedInst && this.instruments().some((x) => x.id === savedInst)) {
        this.state.instrumentId = savedInst;
      } else {
        this.state.instrumentId = c.defaultInstrument || this.instruments()[0]?.id;
      }
    } catch (_) {}
    this.refresh();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.refresh(), 60 * 1000);
  },

  _friendlyErr(e) {
    const name = e?.name || '';
    const msg = e?.message || String(e || 'Unknown error');
    if (name === 'AbortError' || /abort/i.test(msg) || /timed?\s*out/i.test(msg)) {
      return 'Feed timed out — retrying… tap the tab again if it stays blank';
    }
    return msg;
  },

  async refresh() {
    const c = this.cfg();
    if (!c.enabled) return;
    if (typeof API === 'undefined' || typeof RedBarTrend === 'undefined') {
      this.state.error = 'Red Bar engine not loaded';
      this.state.loading = false;
      this.render();
      return;
    }
    // New generation invalidates in-flight work so tab clicks are never ignored
    const gen = ++this._refreshGen;
    const inst = this.activeInstrument();
    this.state.loading = true;
    this.state.error = null;

    try {
      const flaky = (err) => /abort|timed?\s*out|failed to fetch|network|load failed/i.test(String(err || ''));
      let row = await this._buildRow(inst, c);
      // Silent retries — keep spinner; don't flash "Failed to fetch" before success
      for (let attempt = 0; attempt < 2; attempt++) {
        if (gen !== this._refreshGen) return;
        if (!row?.error || !flaky(row.error)) break;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        if (gen !== this._refreshGen) return;
        row = await this._buildRow(inst, c);
      }
      if (gen !== this._refreshGen) return;
      this.state.rows = [row];
      this.state.updatedAt = Date.now();
      this.state.error = row?.error || null;
    } catch (e) {
      if (gen !== this._refreshGen) return;
      this.state.error = this._friendlyErr(e);
      this.state.rows = [];
    } finally {
      if (gen === this._refreshGen) {
        this.state.loading = false;
        this.render();
      }
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

  _emaSeries(closes, period) {
    if (typeof RangeEmaEngine !== 'undefined') {
      return RangeEmaEngine.ema(closes, period);
    }
    return new Array(closes.length).fill(null);
  },

  _emaOverlay(bars, fast, slow) {
    const closes = bars.map((b) => b.c);
    const emaF = this._emaSeries(closes, fast);
    const emaS = this._emaSeries(closes, slow);
    const i = bars.length - 1;
    let cross = 'none';
    if (emaF[i] != null && emaS[i] != null && emaF[i - 1] != null && emaS[i - 1] != null) {
      const prevUp = emaF[i - 1] > emaS[i - 1];
      const nowUp = emaF[i] > emaS[i];
      if (!prevUp && nowUp) cross = 'bull_cross';
      else if (prevUp && !nowUp) cross = 'bear_cross';
      else cross = nowUp ? 'stacked_bull' : 'stacked_bear';
    }
    return { cross, emaFast: emaF[i], emaSlow: emaS[i], emaF, emaS };
  },

  _ohlcLimit(tf, c) {
    const map = c.ohlcLimit || {};
    return map[tf] || 1000;
  },

  async _buildRow(inst, c) {
    const instrument = typeof inst === 'string'
      ? { id: inst, symbol: inst, feed: 'binanceSpot', dayMode: c.dayMode || 'utc' }
      : (inst || this.activeInstrument());
    const tf = this.activeTf();
    const lim = this._ohlcLimit(tf, c);
    let raw;
    try {
      raw = typeof API.getDeskOHLC === 'function'
        ? await API.getDeskOHLC(instrument, tf, lim)
        : await API.getCryptoOHLC(instrument.symbol, tf, lim);
    } catch (e) {
      return {
        symbol: instrument.symbol,
        instrument,
        error: this._friendlyErr(e) || `Failed to load ${instrument.label || instrument.symbol}`,
        tf,
      };
    }
    const bars30 = this._klinesToBars(raw);
    if (bars30.length < 40) {
      return {
        symbol: instrument.symbol,
        instrument,
        error: `Not enough ${tf} data for ${instrument.label || instrument.symbol}`,
        tf,
      };
    }

    const readCfg = {
      lookbackDays: c.lookbackDays || 90,
      touchPct: c.touchPct ?? 0.15,
      dayMode: instrument.dayMode || c.dayMode || 'utc',
      chartBandDays: c.chartBandDays || 7,
      bandStyle: instrument.bandStyle || c.bandStyle || 'dayHl',
      markWindow: instrument.markWindow || c.markWindow || null,
      orAnchor: instrument.orAnchor || c.orAnchor || null,
      fibLevels: instrument.fibLevels || c.fibLevels || [0, 0.44, 0.5, 0.56, 1],
    };

    // Always compute Sagar's magnet: first red bar of the session day on 1H
    let firstRed1h = null;
    try {
      const raw1h = typeof API.getDeskOHLC === 'function'
        ? await API.getDeskOHLC(instrument, '1h', 180)
        : await API.getCryptoOHLC(instrument.symbol, '1h', 180);
      const bars1h = this._klinesToBars(raw1h);
      if (bars1h.length >= 24) {
        const asOf = RedBarTrend.asOfDayFor(bars30[bars30.length - 1].t, readCfg);
        firstRed1h = RedBarTrend.firstRedBarOfSession(bars1h, asOf, readCfg);
      }
    } catch (e) {
      console.warn('[RangeEmaUI] 1H first-red fetch failed:', e.message || e);
    }

    const readout = RedBarTrend.read(bars30, { ...readCfg, firstRed1h });
    if (readout) {
      readout.firstRed1h = firstRed1h;
      if (readout.refs) {
        readout.refs.firstRed1hHigh = firstRed1h ? firstRed1h.high : null;
        readout.refs.firstRed1hLow = firstRed1h ? firstRed1h.low : null;
      }
    }

    const ema = this._emaOverlay(bars30, c.emaFast || 10, c.emaSlow || 30);

    let emaAgree = 'n/a';
    if (readout && ema.cross !== 'none') {
      const emaBull = ema.cross === 'bull_cross' || ema.cross === 'stacked_bull';
      const emaBear = ema.cross === 'bear_cross' || ema.cross === 'stacked_bear';
      if (readout.trend === 'bullish') emaAgree = emaBull ? 'agrees' : emaBear ? 'disagrees' : 'n/a';
      else if (readout.trend === 'bearish') emaAgree = emaBear ? 'agrees' : emaBull ? 'disagrees' : 'n/a';
      else emaAgree = 'neutral_trend';
    }

    const action = this._actionPlan(readout, emaAgree, instrument);

    return {
      symbol: instrument.symbol,
      instrument,
      tf,
      bars: bars30,
      readout,
      ema,
      emaAgree,
      action,
    };
  },

  /** What the trader should do — plain language + levels */
  _actionPlan(o, emaAgree, instrument) {
    const inst = instrument || this.activeInstrument() || {};
    const hint = inst.tradeHint || 'Place the order on your exchange / broker';
    if (!o) {
      return { side: 'WAIT', title: 'No data', steps: [], cls: 'wait' };
    }
    if (o.phase === 'first_candle' || o.phase === 'inside_or') {
      const fibHi = o.currentBand?.high ?? o.refs?.orHigh;
      const fibLo = o.currentBand?.low ?? o.refs?.orLow;
      return {
        side: 'WAIT',
        cls: 'wait',
        title: 'Do not trade yet',
        subtitle: 'Inside today’s mark-window fib box (or window still forming).',
        steps: [
          `Fib 0 / Fib 1 from the mark window: ${this._fmt(fibHi)} / ${this._fmt(fibLo)}.`,
          'Only act after a clear break and hold outside that box.',
        ],
        entry: null,
        stop: null,
        exit: null,
      };
    }
    if (o.trend === 'bullish') {
      return {
        side: 'LONG',
        cls: 'long',
        title: 'Bias: BUY / go long',
        subtitle: `Red Bar trend bullish${emaAgree === 'agrees' ? ' · EMA agrees' : emaAgree === 'disagrees' ? ' · EMA disagrees — be smaller or skip' : ''}.`,
        steps: [
          `${hint}: open LONG near current price / band support hold.`,
          `Stop / invalidation near ${this._fmt(o.invalidation)} (fib low or band).`,
          `Take profit / book near ${this._fmt(o.bookZone)} (prior swing high — Y-axis EXIT marker).`,
          ...(o.firstRed1h
            ? [`1H first red high ${this._fmt(o.firstRed1h.high)} — price often revisits before next move.`]
            : []),
        ],
        entry: o.price,
        stop: o.invalidation,
        exit: o.bookZone,
      };
    }
    if (o.trend === 'bearish') {
      return {
        side: 'SHORT',
        cls: 'short',
        title: 'Bias: SELL / go short',
        subtitle: `Red Bar trend bearish${emaAgree === 'agrees' ? ' · EMA agrees' : emaAgree === 'disagrees' ? ' · EMA disagrees — be smaller or skip' : ''}.`,
        steps: [
          `${hint}: open SHORT near current price / band resistance rejection.`,
          `Stop / invalidation near ${this._fmt(o.invalidation)} (fib high or band).`,
          `Take profit / book near ${this._fmt(o.bookZone)} (nearest prior swing low / support).`,
          ...(o.firstRed1h
            ? [`1H first red high ${this._fmt(o.firstRed1h.high)} — price often revisits before next move.`]
            : []),
        ],
        entry: o.price,
        stop: o.invalidation,
        exit: o.bookZone,
      };
    }
    return {
      side: 'WAIT',
      cls: 'wait',
      title: 'No clear bias',
      subtitle: 'No fib-box break yet.',
      steps: ['Watch prior-session fibs as magnets; wait for a break of today’s Fib 0 / Fib 1.'],
      entry: null,
      stop: null,
      exit: null,
    };
  },

  _fmt(n, d) {
    if (n == null || Number.isNaN(n)) return '—';
    const decimals = d != null ? d : (this.activeInstrument()?.priceDecimals ?? 2);
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  },

  _pct(from, to) {
    if (from == null || to == null || !from) return '';
    const p = ((to - from) / from) * 100;
    return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  },

  _flat(n, len) {
    return new Array(len).fill(n);
  },

  destroyChart() {
    if (this._chartRo) {
      try { this._chartRo.disconnect(); } catch (_) {}
      this._chartRo = null;
    }
    if (this._chart) {
      try {
        this._chart.destroy();
      } catch (_) {}
      this._chart = null;
    }
  },

  _tabsHtml(inst) {
    const loading = !!this.state.loading;
    return this.instruments().map((x) => {
      const active = x.id === inst.id;
      const cls = `rb-inst-btn${active ? ' active' : ''}${active && loading ? ' is-loading' : ''}`;
      return `<button type="button" class="${cls}" data-rb-inst="${x.id}"${loading && active ? ' aria-busy="true"' : ''}>${x.label}${active && loading ? ' …' : ''}</button>`;
    }).join('');
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
    this.destroyChart();

    const inst = this.activeInstrument() || { label: 'BTC', id: 'BTC' };
    const tf = this.activeTf();
    const tabs = this._tabsHtml(inst);
    const when = this.state.updatedAt
      ? new Date(this.state.updatedAt).toLocaleTimeString()
      : '—';
    const row = (this.state.rows || [])[0];
    // Must match instrument AND timeframe — 02:30 fibs are per-candle on that TF
    const rowMatches = row
      && (row.instrument?.id === inst.id || row.symbol === inst.symbol)
      && row.tf === tf;
    const focus = document.querySelector('.topbar-focus-label');
    if (focus) {
      focus.textContent = this.state.loading
        ? `Loading ${inst.label}…`
        : `${inst.label} · ${tf} Red Bar`;
    }

    // Hard error with nothing to show
    if (this.state.error && !rowMatches && !this.state.loading) {
      host.innerHTML = `
        <div class="section-heading">
          <h1>🟥 Red Bar Desk</h1>
        </div>
        <div class="rb-inst-tabs" role="tablist" aria-label="Instrument">${tabs}</div>
        <div class="range-desk-error">${this.state.error}</div>
      `;
      this._bindChartControls();
      return;
    }

    // Switching instruments / first load — keep tabs, show spinner (never paint wrong symbol)
    if (this.state.loading && !rowMatches) {
      host.innerHTML = `
        <div class="section-heading">
          <h1>🟥 Red Bar Desk</h1>
          <p class="section-sub">Loading <strong>${inst.label}</strong> on ${tf}…</p>
        </div>
        <div class="rb-inst-tabs" role="tablist" aria-label="Instrument">${tabs}</div>
        <div class="rb-loading" role="status">
          <div class="rb-loading-spin" aria-hidden="true"></div>
          <p>Fetching ${inst.label} candles…</p>
        </div>
      `;
      this._bindChartControls();
      return;
    }

    if (!row) {
      host.innerHTML = `
        <div class="rb-inst-tabs" role="tablist" aria-label="Instrument">${tabs}</div>
        <div class="range-desk-error">Loading ${inst.label} chart…</div>
      `;
      this._bindChartControls();
      return;
    }

    host.innerHTML = `
      <div class="section-heading">
        <h1>🟥 Red Bar Desk</h1>
        <p class="section-sub">
          ${inst.label} on <strong>${tf}</strong>: candles, EMA 10/30, session fibs; Stop/Exit when in a trade.
          <span class="range-desk-meta">${inst.tradeHint || ''} · Updated ${when}${this.state.loading ? ' · refreshing…' : ''}</span>
        </p>
      </div>
      <div class="rb-inst-tabs" role="tablist" aria-label="Instrument">${tabs}</div>
      ${this._deskHtml(row, c)}
    `;

    this._bindChartControls();
    if (!row.error) requestAnimationFrame(() => this._paintChart(row, c));
  },

  _bindChartControls() {
    document.querySelectorAll('[data-rb-inst]').forEach((btn) => {
      btn.addEventListener('click', () => this.setInstrument(btn.getAttribute('data-rb-inst')));
    });
    document.querySelectorAll('[data-rb-tf]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTf(btn.getAttribute('data-rb-tf')));
    });
    document.getElementById('rbZoomIn')?.addEventListener('click', () => {
      try { this._chart?.zoom?.(1.35); } catch (_) {}
    });
    document.getElementById('rbZoomOut')?.addEventListener('click', () => {
      try { this._chart?.zoom?.(0.75); } catch (_) {}
    });
    document.getElementById('rbZoomReset')?.addEventListener('click', () => {
      try { this._chart?.resetZoom?.(); } catch (_) {}
    });
    const panBy = (dir) => {
      const ch = this._chart;
      if (!ch) return;
      try {
        if (typeof ch.pan === 'function') ch.pan({ x: dir * 80 }, undefined, 'default');
      } catch (_) {}
    };
    document.getElementById('rbPanLeft')?.addEventListener('click', () => panBy(1));
    document.getElementById('rbPanRight')?.addEventListener('click', () => panBy(-1));
  },

  _deskHtml(r, c) {
    if (r.error) {
      return `<div class="range-desk-error">${r.error}</div>`;
    }
    const o = r.readout;
    const a = r.action || this._actionPlan(o, r.emaAgree, r.instrument);
    const trendCls =
      o.trend === 'bullish' ? 'pos' : o.trend === 'bearish' ? 'neg' : '';
    const trendWord = o.trend === 'bullish' ? 'BULLISH' : o.trend === 'bearish' ? 'BEARISH' : 'NEUTRAL';

    const steps = (a.steps || []).map((s) => `<li>${s}</li>`).join('');

    return `
      <div class="rb-action ${a.cls}">
        <div class="rb-action-side">${a.side}</div>
        <div class="rb-action-body">
          <div class="rb-action-title">${a.title}</div>
          <div class="rb-action-sub">${a.subtitle || ''}</div>
          <ul class="rb-action-steps">${steps}</ul>
          <div class="rb-action-levels">
            <div><span>Entry lean</span><strong>${this._fmt(a.entry)}</strong></div>
            <div><span>Stop</span><strong class="neg-text">${this._fmt(a.stop)}</strong></div>
            <div><span>Exit / book</span><strong class="pos-text">${this._fmt(a.exit)}</strong></div>
          </div>
        </div>
      </div>

      <div class="rb-chart-wrap glass">
        <div class="rb-chart-toolbar">
          <div class="rb-tf-group" role="group" aria-label="Chart timeframe">
            ${(c.timeframes || ['5m', '30m', '1h']).map((t) =>
              `<button type="button" class="rb-tf-btn${t === this.activeTf() ? ' active' : ''}" data-rb-tf="${t}">${t}</button>`
            ).join('')}
          </div>
          <div class="rb-zoom-group" role="group" aria-label="Chart zoom and pan">
            <button type="button" class="rb-zoom-btn" id="rbPanLeft" title="Pan left (earlier)">◀</button>
            <button type="button" class="rb-zoom-btn" id="rbPanRight" title="Pan right (later)">▶</button>
            <button type="button" class="rb-zoom-btn" id="rbZoomOut" title="Zoom out">−</button>
            <button type="button" class="rb-zoom-btn" id="rbZoomIn" title="Zoom in">+</button>
            <button type="button" class="rb-zoom-btn" id="rbZoomReset" title="Fit all / reset">Fit</button>
          </div>
        </div>
        <div class="rb-chart-legend">
          <span class="lg price">Candles</span>
          <span class="lg ema10">EMA ${c.emaFast || 10}</span>
          <span class="lg ema30">EMA ${c.emaSlow || 30}</span>
          <span class="lg band">${this._isFibStyle(r) ? `Fib 0·44·50·56·1${r.instrument?.markLabel ? ` · ${r.instrument.markLabel}` : ''}` : 'Day ranges'}</span>
          <span class="lg stop">1H first red</span>
          <span class="lg stop rb-lg-desk">Stop</span>
          <span class="lg tp rb-lg-desk">Exit</span>
          <span class="lg sess-asia rb-lg-desk">Asia</span>
          <span class="lg sess-london rb-lg-desk">London</span>
          <span class="lg sess-ny rb-lg-desk">US</span>
        </div>
        <p class="rb-zoom-hint">Pinch to zoom · drag to pan · Fit resets</p>
        <div class="rb-chart-box">
          <canvas id="redBarChart" aria-label="Red Bar chart"></canvas>
        </div>
      </div>

      <div class="rb-meta-row">
        <div class="range-trend-banner ${trendCls}">
          <span class="range-trend-label">Predicted trend</span>
          <strong>${trendWord}</strong>
        </div>
        <p class="range-narrative">${o.narrative}</p>
      </div>

      <div class="range-chips">
        <span class="range-chip">Fib bias: ${o.orBias}</span>
        <span class="range-chip">Phase: ${String(o.phase).replace(/_/g, ' ')}</span>
        <span class="range-chip">EMA: ${String((r.ema && r.ema.cross) || '').replace(/_/g, ' ')}</span>
        <span class="range-chip ${r.emaAgree === 'agrees' ? 'pos' : r.emaAgree === 'disagrees' ? 'neg' : ''}">EMA ${r.emaAgree}</span>
        <span class="range-chip">${this._isFibStyle(r) ? ((r.instrument && r.instrument.markLabel) || 'session fibs') : 'day-ranges'} · ${(o.recentBands || []).length} on chart · ${o.bandCountPrior} prior</span>
        ${o.firstRed1h
          ? `<span class="range-chip">1H first red high ${this._fmt(o.firstRed1h.high)}</span>`
          : ''}
      </div>

      <p class="range-desk-footnote">
        Green box = look long · Red box = look short · Grey = wait.
        You still place the order on the exchange after checking the chart.
      </p>
    `;
  },

  /** Bars per clock-hour on this timeframe */
  _barsPerHour(tf) {
    if (tf === '5m') return 12;
    if (tf === '30m') return 2;
    if (tf === '1h') return 1;
    return 2;
  },

  /**
   * X-axis step for the *visible* bar window (updates on zoom/pan).
   * Fixed full-series steps made labels vanish when the zoom window
   * didn't land on those indices.
   */
  _xTickStepForRange(visibleCount, compact) {
    const maxLabels = compact ? 5 : 8;
    const v = Math.max(1, visibleCount | 0);
    return Math.max(1, Math.ceil(v / maxLabels));
  },

  _fmtAxisTick(ts, prevTs, compact) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const dayChanged = !prevTs || new Date(prevTs).toDateString() !== d.toDateString();
    if (dayChanged) {
      const day = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      // Single line on phones — multi-line ticks collide on a narrow canvas
      return compact ? `${day}` : `${day} ${time}`;
    }
    return time;
  },

  /** UTC ms when `hour:minute` occurs in `timeZone` on calendar `dayStr` (YYYY-MM-DD in that zone). */
  _zonedClockToUtc(dayStr, timeZone, hour, minute) {
    const targetHm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const base = Date.parse(`${dayStr}T12:00:00Z`);
    let lo = base - 36 * 3600 * 1000;
    let hi = base + 36 * 3600 * 1000;
    const fmtDay = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const fmtHm = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    while (hi - lo > 30 * 1000) {
      const mid = Math.floor((lo + hi) / 2);
      const d = new Date(mid);
      const day = fmtDay.format(d);
      const hm = fmtHm.format(d);
      if (day < dayStr || (day === dayStr && hm < targetHm)) lo = mid;
      else hi = mid;
    }
    return hi;
  },

  _zonedDayStr(ts, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  },

  /** Collect open/close markers that fall inside [t0, t1]. */
  _sessionMarkersInRange(t0, t1, sessions) {
    const out = [];
    if (!sessions || !sessions.length || t1 <= t0) return out;
    const pad = 48 * 3600 * 1000;
    for (const s of sessions) {
      const tz = s.timeZone || 'UTC';
      const [oH, oM] = s.open || [0, 0];
      const [cH, cM] = s.close || [0, 0];
      // Walk calendar days covering the visible window (in that zone)
      const days = new Set();
      for (let t = t0 - pad; t <= t1 + pad; t += 12 * 3600 * 1000) {
        days.add(this._zonedDayStr(t, tz));
      }
      days.add(this._zonedDayStr(t0, tz));
      days.add(this._zonedDayStr(t1, tz));
      for (const day of days) {
        const openTs = this._zonedClockToUtc(day, tz, oH, oM);
        const closeTs = this._zonedClockToUtc(day, tz, cH, cM);
        if (openTs >= t0 && openTs <= t1) {
          out.push({ ts: openTs, kind: 'open', label: s.label, color: s.color || '#94a3b8' });
        }
        if (closeTs >= t0 && closeTs <= t1) {
          out.push({ ts: closeTs, kind: 'close', label: s.label, color: s.color || '#94a3b8' });
        }
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  },

  _nearestBarIndex(times, ts) {
    if (!times.length) return -1;
    let best = 0;
    let bestDist = Math.abs(times[0] - ts);
    for (let i = 1; i < times.length; i++) {
      const d = Math.abs(times[i] - ts);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    // Ignore if farther than ~1.25 bars from a sample (avoids edge ghosts)
    const barMs = times.length > 1 ? Math.abs(times[1] - times[0]) : 30 * 60 * 1000;
    if (bestDist > barMs * 1.25) return -1;
    return best;
  },

  _sessionPlugin() {
    return {
      id: 'rbSessions',
      afterDraw(chart) {
        const markers = chart.$rbSessionMarks;
        const times = chart.$rbTimes;
        if (!markers || !markers.length || !times || !times.length) return;
        const xScale = chart.scales.x;
        const area = chart.chartArea;
        if (!xScale || !area) return;
        const ctx = chart.ctx;
        const self = chart.$rbUI;
        if (!self) return;

        const plotW = area.right - area.left;
        const compact = !!chart.$rbCompact;
        // Opens only when cramped; skips close ticks that double the barcode
        const list = compact
          ? markers.filter((m) => m.kind === 'open')
          : markers;
        const minLineGap = compact ? 10 : 6;
        const minLabelGap = compact ? 42 : 28;
        const showLabels = plotW >= (compact ? 280 : 200);
        let lastLineX = -Infinity;
        let lastLabelX = -Infinity;

        ctx.save();
        for (const m of list) {
          const idx = self._nearestBarIndex(times, m.ts);
          if (idx < 0) continue;
          const x = xScale.getPixelForValue(idx);
          if (!Number.isFinite(x) || x < area.left - 2 || x > area.right + 2) continue;
          if (x - lastLineX < minLineGap) continue;
          lastLineX = x;

          ctx.strokeStyle = m.color;
          ctx.globalAlpha = compact
            ? (m.kind === 'open' ? 0.55 : 0.3)
            : (m.kind === 'open' ? 0.85 : 0.45);
          ctx.lineWidth = m.kind === 'open' ? (compact ? 1 : 1.5) : 1;
          ctx.setLineDash(m.kind === 'open' ? [] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          if (!showLabels || m.kind !== 'open') continue;
          if (x - lastLabelX < minLabelGap) continue;
          lastLabelX = x;

          ctx.globalAlpha = 0.9;
          ctx.fillStyle = m.color;
          ctx.font = compact
            ? '600 8px Outfit, system-ui, sans-serif'
            : '600 9px Outfit, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          // Short tag — full "London▲" piles into neighbours on 30m
          const tag = compact ? String(m.label || '').slice(0, 1) : `${m.label}`;
          ctx.fillText(tag, x, area.top + 2);
        }
        ctx.restore();
      },
    };
  },

  /** Draw OHLC candles on top of the line chart (EMA + levels stay as lines). */
  _candlePlugin() {
    return {
      id: 'rbCandles',
      afterDatasetsDraw(chart) {
        const bars = chart.$rbBars;
        if (!bars || !bars.length) return;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        if (!xScale || !yScale) return;
        const ctx = chart.ctx;
        const n = bars.length;
        const slot = n > 1
          ? Math.abs(xScale.getPixelForValue(1) - xScale.getPixelForValue(0))
          : 8;
        const bodyW = Math.max(2, Math.min(slot * 0.62, 14));

        ctx.save();
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const x = xScale.getPixelForValue(i);
          if (!Number.isFinite(x)) continue;
          const yO = yScale.getPixelForValue(b.o);
          const yC = yScale.getPixelForValue(b.c);
          const yH = yScale.getPixelForValue(b.h);
          const yL = yScale.getPixelForValue(b.l);
          const up = b.c >= b.o;
          const color = up ? '#22c55e' : '#ef4444';

          ctx.strokeStyle = color;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(x, yH);
          ctx.lineTo(x, yL);
          ctx.stroke();

          const top = Math.min(yO, yC);
          const h = Math.max(1, Math.abs(yC - yO));
          ctx.fillStyle = color;
          ctx.fillRect(x - bodyW / 2, top, bodyW, h);
        }
        ctx.restore();
      },
    };
  },

  /**
   * Magnets:
   * - dayHl: box over that calendar day (legacy)
   * - sessionFib: Fib 0/0.44/0.5/0.56/1 on mark-window H/L, extend right
   *   (orange 0–0.44, green 0.44–0.56, grey 0.56–1 — matches TV)
   */
  _isFibStyle(rowOrStyle) {
    const s = typeof rowOrStyle === 'string'
      ? rowOrStyle
      : (rowOrStyle?.readout?.bandStyle || rowOrStyle?.instrument?.bandStyle || rowOrStyle?.bandStyle);
    return s === 'sessionFib' || s === 'istFib0230';
  },

  _bandZonesPlugin() {
    return {
      id: 'rbBandZones',
      beforeDatasetsDraw(chart) {
        const bands = chart.$rbDayBands;
        if (!bands || !bands.length) return;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!xScale || !yScale || !area) return;
        const ctx = chart.ctx;
        const n = bands.length;
        const lastIdx = chart.$rbBars ? chart.$rbBars.length - 1 : null;

        ctx.save();
        for (let i = 0; i < n; i++) {
          const b = bands[i];
          if (b.high == null || b.low == null || b.i0 == null) continue;
          const i1 = b.i1 != null
            ? b.i1
            : (bands[i + 1]?.i0 != null ? bands[i + 1].i0 : lastIdx);
          if (i1 == null) continue;

          let x0 = xScale.getPixelForValue(b.i0);
          let x1 = xScale.getPixelForValue(i1);
          if (![x0, x1].every(Number.isFinite)) continue;
          if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
          if (x1 < area.left || x0 > area.right) continue;
          x0 = Math.max(x0, area.left);
          x1 = Math.min(x1, area.right);
          if (x1 <= x0) continue;

          const isFib = (b.style === 'sessionFib' || b.style === 'istFib0230') && b.f44 != null;
          const age = 0.4 + ((i + 1) / n) * 0.55;
          ctx.globalAlpha = age;

          if (isFib) {
            const zones = [
              { lo: b.f0, hi: b.f44, fill: 'rgba(249, 115, 22, 0.22)' },   // orange
              { lo: b.f44, hi: b.f56, fill: 'rgba(74, 222, 128, 0.20)' },  // green mid
              { lo: b.f56, hi: b.f1, fill: 'rgba(148, 163, 184, 0.22)' },  // grey
            ];
            for (const z of zones) {
              if (z.lo == null || z.hi == null) continue;
              const yA = yScale.getPixelForValue(z.hi);
              const yB = yScale.getPixelForValue(z.lo);
              if (![yA, yB].every(Number.isFinite)) continue;
              const top = Math.min(yA, yB);
              const h = Math.max(1, Math.abs(yB - yA));
              ctx.fillStyle = z.fill;
              ctx.fillRect(x0, top, x1 - x0, h);
            }
            const lines = [
              { v: b.f1, c: 'rgba(148, 163, 184, 0.95)' },
              { v: b.f56, c: 'rgba(74, 222, 128, 0.85)' },
              { v: b.f50, c: 'rgba(56, 189, 248, 0.9)' },
              { v: b.f44, c: 'rgba(74, 222, 128, 0.85)' },
              { v: b.f0, c: 'rgba(249, 115, 22, 0.95)' },
            ];
            ctx.setLineDash([]);
            for (const ln of lines) {
              if (ln.v == null) continue;
              const y = yScale.getPixelForValue(ln.v);
              if (!Number.isFinite(y)) continue;
              ctx.strokeStyle = ln.c;
              ctx.lineWidth = ln.v === b.f50 ? 1.25 : 1;
              ctx.beginPath();
              ctx.moveTo(x0, y);
              ctx.lineTo(x1, y);
              ctx.stroke();
            }
          } else {
            const palette = [
              { fill: 'rgba(168, 85, 247, 0.22)', stroke: 'rgba(168, 85, 247, 0.85)', mid: 'rgba(196, 181, 253, 0.7)' },
              { fill: 'rgba(249, 115, 22, 0.20)', stroke: 'rgba(249, 115, 22, 0.85)', mid: 'rgba(253, 186, 116, 0.7)' },
            ];
            const col = palette[i % 2];
            const yHi = yScale.getPixelForValue(b.high);
            const yLo = yScale.getPixelForValue(b.low);
            if (![yHi, yLo].every(Number.isFinite)) continue;
            const top = Math.min(yHi, yLo);
            const h = Math.max(2, Math.abs(yLo - yHi));
            ctx.fillStyle = col.fill;
            ctx.fillRect(x0, top, x1 - x0, h);
            ctx.strokeStyle = col.stroke;
            ctx.lineWidth = 1.35;
            ctx.strokeRect(x0, top, x1 - x0, h);
            if (b.mid != null) {
              const yM = yScale.getPixelForValue(b.mid);
              if (Number.isFinite(yM)) {
                ctx.strokeStyle = col.mid;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(x0, yM);
                ctx.lineTo(x1, yM);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            }
          }
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      },
    };
  },

  /** Full-width dashed line at first 1H red high (session-day magnet). */
  _firstRed1hPlugin() {
    return {
      id: 'rbFirstRed1h',
      afterDatasetsDraw(chart) {
        const red = chart.$rbFirstRed1h;
        if (!red || red.high == null) return;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const y = yScale.getPixelForValue(red.high);
        if (!Number.isFinite(y) || y < area.top || y > area.bottom) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      },
    };
  },

  /**
   * Price markers on the RIGHT Y-axis (TradingView-style) — replaces chart-wide dotted levels.
   */
  _levelTagsPlugin() {
    return {
      id: 'rbLevelTags',
      afterDraw(chart) {
        const tags = chart.$rbLevelTags;
        if (!tags || !tags.length) return;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const ctx = chart.ctx;
        const placed = [];
        const compact = !!chart.$rbCompact;
        const minGap = compact ? 16 : 14;
        const axisX = area.right;

        ctx.save();
        ctx.font = compact
          ? '600 9px Outfit, system-ui, sans-serif'
          : '600 10px Outfit, system-ui, sans-serif';
        for (const t of tags) {
          if (t.value == null || !Number.isFinite(t.value)) continue;
          let y = yScale.getPixelForValue(t.value);
          if (!Number.isFinite(y)) continue;
          if (y < area.top - 2 || y > area.bottom + 2) continue;
          y = Math.max(area.top + 8, Math.min(area.bottom - 8, y));
          for (let guard = 0; guard < 8; guard++) {
            let hit = false;
            for (const py of placed) {
              if (Math.abs(y - py) < minGap) {
                y += (y >= py ? minGap : -minGap);
                hit = true;
                break;
              }
            }
            if (!hit) break;
            y = Math.max(area.top + 8, Math.min(area.bottom - 8, y));
          }
          placed.push(y);

          const price = Number(t.value).toFixed(0);
          // Compact: "X 82295" not "EXIT 82295" — fits the right gutter
          const shortName = compact
            ? ({ STOP: 'STP', EXIT: 'TP', '1H RED': '1R', R: 'R', S: 'S' }[t.name] || t.name)
            : t.name;
          const label = `${shortName} ${price}`;
          const padX = compact ? 4 : 5;
          const tw = ctx.measureText(label).width;
          const boxW = tw + padX * 2;
          const boxH = compact ? 13 : 15;
          const x = axisX + 2;

          // Short tick into the plot so the eye can find the level without a full line
          ctx.strokeStyle = t.color || '#e2e8f0';
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(axisX - 10, y);
          ctx.lineTo(axisX, y);
          ctx.stroke();
          ctx.globalAlpha = 1;

          ctx.fillStyle = t.bg || 'rgba(15, 23, 42, 0.92)';
          ctx.strokeStyle = t.color || '#e2e8f0';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x, y - boxH / 2, boxW, boxH, 3);
          } else {
            ctx.rect(x, y - boxH / 2, boxW, boxH);
          }
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = t.color || '#e2e8f0';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x + padX, y);
        }
        ctx.restore();
      },
    };
  },

  _nearPrice(a, b, eps = 0.5) {
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) <= eps;
  },

  _paintChart(row, c) {
    const canvas = document.getElementById('redBarChart');
    if (!canvas || typeof Chart === 'undefined' || !row.bars) return;

    this.syncPhoneClass();
    const compact = this.isPhoneLayout();
    const inst = row.instrument || this.activeInstrument() || { label: 'BTC', dayMode: 'utc' };
    const priceLabel = inst.label || 'Price';
    const tf = row.tf || this.activeTf();
    // Mobile: fewer bars so candles have width (240 bars on a 360px phone = needles)
    const wantDesktop = (c.chartBars && c.chartBars[tf]) || 120;
    const wantMobile = (c.chartBarsMobile && c.chartBarsMobile[tf])
      || ({ '5m': 96, '30m': 72, '1h': 56 }[tf] || 72);
    const want = compact ? wantMobile : wantDesktop;
    const showN = Math.min(want, row.bars.length);
    const bars = row.bars.slice(-showN);
    const offset = row.bars.length - showN;
    const o = row.readout;
    const emaF = (row.ema.emaF || []).slice(offset);
    const emaS = (row.ema.emaS || []).slice(offset);
    const n = bars.length;
    const times = bars.map((b) => b.t);

    const labels = times.map((t, i) => {
      const d = new Date(t);
      const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      if (i === 0 || new Date(times[i - 1]).toDateString() !== d.toDateString()) {
        const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `${day} ${time}`;
      }
      return time;
    });
    const closes = bars.map((b) => b.c);
    // Map each prior-day band onto bar indices in the visible window (for day-scoped boxes)
    const dayMode = inst.dayMode || c.dayMode || 'utc';
    const fibMode = this._isFibStyle(o.bandStyle || inst.bandStyle);
    const markWin = inst.markWindow || (typeof RedBarTrend !== 'undefined'
      ? RedBarTrend.getMarkWindow({ markWindow: inst.markWindow, orAnchor: inst.orAnchor, bandStyle: inst.bandStyle })
      : null);
    const daySpans = new Map();
    for (let i = 0; i < times.length; i++) {
      const day = (typeof RedBarTrend !== 'undefined')
        ? (fibMode && markWin
          ? RedBarTrend.sessionDayKey(times[i], markWin)
          : RedBarTrend.dayKey(times[i], dayMode))
        : new Date(times[i]).toISOString().slice(0, 10);
      if (!daySpans.has(day)) daySpans.set(day, { i0: i, i1: i });
      else daySpans.get(day).i1 = i;
    }
    const resolveBandIndex = (b) => {
      if (b.index != null && b.index >= 0) {
        // index is absolute in full series; map into visible window
        const abs = b.index;
        const visStart = row.bars.length - bars.length;
        const local = abs - visStart;
        if (local >= 0 && local < bars.length) return local;
      }
      if (b.openT != null) {
        const idx = this._nearestBarIndex(times, b.openT);
        if (idx >= 0) return idx;
      }
      const span = daySpans.get(b.day);
      return span ? span.i0 : null;
    };
    const rawBands = [
      ...(Array.isArray(o.recentBands) ? o.recentBands : []),
      ...(o.currentBand ? [o.currentBand] : []),
    ];
    // Dedupe by day (currentBand may already be in recent for edge cases)
    const byDay = new Map();
    for (const b of rawBands) {
      if (!b?.day) continue;
      byDay.set(b.day, b);
    }
    const sortedBandDays = [...byDay.keys()].sort();
    const dayBands = sortedBandDays.map((day, bi) => {
      const b = byDay.get(day);
      const i0 = resolveBandIndex(b);
      if (i0 == null) return null;
      const nextDay = sortedBandDays[bi + 1];
      let i1 = bars.length - 1;
      if (nextDay) {
        const n0 = resolveBandIndex(byDay.get(nextDay));
        if (n0 != null && n0 > i0) i1 = n0;
      }
      return { ...b, i0, i1 };
    }).filter(Boolean);
    // Fit Y to candles + magnet levels
    const barHi = Math.max(...bars.map((b) => b.h));
    const barLo = Math.min(...bars.map((b) => b.l));
    const bandPrices = dayBands.flatMap((b) => (
      (b.style === 'sessionFib' || b.style === 'istFib0230')
        ? [b.f0, b.f44, b.f50, b.f56, b.f1]
        : [b.high, b.low, b.mid]
    ))
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number);
    const nearLevels = [
      o.currentBand?.high, o.currentBand?.low,
      o.invalidation, o.bookZone,
      o.firstRed1h?.high, o.firstRed1h?.low,
      ...bandPrices,
    ].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
    const yHi = Math.max(barHi, ...nearLevels);
    const yLo = Math.min(barLo, ...nearLevels);
    const barSpan = (yHi - yLo) || 1;
    const pad = barSpan * 0.06 || 1;
    const self = this;
    const showSessions = inst.showSessionMarkers !== false && (inst.sessions || c.sessions);
    let sessionMarks = showSessions
      ? this._sessionMarkersInRange(times[0], times[n - 1], inst.sessions || c.sessions || [])
      : [];
    if (compact && sessionMarks.length) {
      // Opens only — closes double the vertical barcode on a phone
      sessionMarks = sessionMarks.filter((m) => m.kind === 'open');
    }

    // Distinct palette (avoid overlapping blues/reds/greens across layers)
    const COL = {
      ema10: '#22d3ee',
      ema30: '#f97316',
      or: '#eab308',
      bandResist: '#a855f7',
      bandSupport: '#2dd4bf',
      stop: '#ef4444',
      exit: '#4ade80',
    };

    const action = row.action || this._actionPlan(o, row.emaAgree);
    const trading = action.side === 'LONG' || action.side === 'SHORT';
    const stopPx = trading ? (action.stop ?? o.invalidation) : null;
    const exitPx = trading ? (action.exit ?? o.bookZone) : null;

    // Invisible close series: hit-testing + tooltip OHLC (candles drawn by plugin)
    const datasets = [
      {
        label: priceLabel,
        data: closes,
        borderColor: 'rgba(0,0,0,0)',
        backgroundColor: 'rgba(0,0,0,0)',
        borderWidth: 0,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        tension: 0,
        order: 1,
      },
      {
        label: `EMA ${c.emaFast || 10}`,
        data: emaF,
        borderColor: COL.ema10,
        borderWidth: 1.25,
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 3,
      },
      {
        label: `EMA ${c.emaSlow || 30}`,
        data: emaS,
        borderColor: COL.ema30,
        borderWidth: 2.75,
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 3,
      },
    ];

    // Levels = Y-axis markers only (no chart-wide dotted / solid rails)
    const levelTags = [];
    const pushTag = (name, value, color, bg, { priority = false } = {}) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      const v = Number(value);
      const hit = levelTags.findIndex((t) => this._nearPrice(t.value, v, 2));
      if (hit >= 0) {
        // Never let R/S eat STOP/EXIT — rename or skip
        if (priority) {
          levelTags[hit] = { name, value: v, color, bg };
        }
        return;
      }
      levelTags.push({ name, value: v, color, bg });
    };
    // STOP / EXIT first so they always win the Y-axis slot
    if (trading) {
      pushTag('STOP', stopPx, COL.stop, 'rgba(60, 10, 10, 0.94)', { priority: true });
      pushTag('EXIT', exitPx, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
    }
    // Sagar: first 1H red of the day — high is the revisit magnet
    pushTag('1H RED', o.firstRed1h?.high, '#f43f5e', 'rgba(60, 10, 20, 0.94)', { priority: true });
    pushTag('R', o.refs?.bandResist, COL.bandResist, 'rgba(46, 16, 80, 0.92)');
    pushTag('S', o.refs?.bandSupport, COL.bandSupport, 'rgba(8, 50, 48, 0.92)');

    this.destroyChart();
    this._chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      plugins: [
        this._bandZonesPlugin(),
        this._firstRed1hPlugin(),
        this._candlePlugin(),
        this._sessionPlugin(),
        this._levelTagsPlugin(),
      ],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: compact ? 0 : 280 },
        interaction: { mode: 'index', intersect: false },
        layout: {
          padding: {
            top: compact ? 12 : 14,
            bottom: 4,
            right: compact ? 58 : 72,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(12,16,36,0.92)',
            titleFont: { family: 'Outfit', size: 11 },
            bodyFont: { family: 'Outfit', size: 11 },
            padding: 8,
            displayColors: false,
            caretPadding: 8,
            filter(item) {
              const l = item.dataset.label || '';
              return l === priceLabel || l.startsWith('EMA');
            },
            callbacks: {
              title(items) {
                const i = items[0]?.dataIndex;
                if (i == null || !times[i]) return items[0]?.label || '';
                const d = new Date(times[i]);
                return d.toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                });
              },
              label(ctx) {
                if (ctx.dataset.label === priceLabel) {
                  const b = bars[ctx.dataIndex];
                  if (!b) return priceLabel;
                  const d = inst.priceDecimals ?? 2;
                  return [
                    `O  ${Number(b.o).toFixed(d)}`,
                    `H  ${Number(b.h).toFixed(d)}`,
                    `L  ${Number(b.l).toFixed(d)}`,
                    `C  ${Number(b.c).toFixed(d)}`,
                  ];
                }
                const v = ctx.parsed.y;
                if (v == null) return ctx.dataset.label;
                return `${ctx.dataset.label}  ${Number(v).toFixed(2)}`;
              },
            },
          },
          zoom: {
            limits: {
              x: { min: 'original', max: 'original', minRange: 12 },
              y: { min: 'original', max: 'original', minRange: Math.max(barSpan * 0.06, 30) },
            },
            // Sideways pan is the primary scrub when zoomed in (also works on touch)
            pan: {
              // On phones, prefer page scroll; use ◀ ▶ buttons to scrub
              enabled: !compact,
              mode: 'x',
              threshold: 6,
              modifierKey: null,
            },
            zoom: {
              wheel: { enabled: !compact, speed: 0.12 },
              pinch: { enabled: true },
              drag: {
                enabled: !compact,
                backgroundColor: 'rgba(124, 106, 245, 0.18)',
                borderColor: 'rgba(124, 106, 245, 0.45)',
                borderWidth: 1,
              },
              // Pinch/wheel zoom both axes so day-range gaps open up
              mode: 'xy',
              onZoomComplete({ chart }) {
                try { chart.update('none'); } catch (_) {}
              },
              onPanComplete({ chart }) {
                try { chart.update('none'); } catch (_) {}
              },
            },
          },
        },
        scales: {
          x: {
            type: 'category',
            offset: true,
            grid: {
              color: 'rgba(255,255,255,0.05)',
              display: !compact,
            },
            ticks: {
              color: 'rgba(255,255,255,0.55)',
              font: { size: compact ? 9 : 10, family: 'Outfit' },
              // We pick density from the zoomed window ourselves — autoSkip + a
              // fixed full-series step made labels disappear mid-zoom.
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              callback(value) {
                // Category scale: `value` is the data index (not the tick ordinal)
                const idx = typeof value === 'number'
                  ? Math.round(value)
                  : times.indexOf?.(value);
                if (!Number.isFinite(idx) || idx < 0 || !times[idx]) return undefined;

                const i0 = Number.isFinite(this.min)
                  ? Math.max(0, Math.ceil(this.min))
                  : 0;
                const i1 = Number.isFinite(this.max)
                  ? Math.min(n - 1, Math.floor(this.max))
                  : n - 1;
                if (idx < i0 || idx > i1) return undefined;

                const step = self._xTickStepForRange(i1 - i0 + 1, compact);
                const atEdge = idx === i0 || idx === i1;
                const aligned = ((idx - i0) % step) === 0;
                if (!atEdge && !aligned) return undefined;

                const prevIdx = idx - step;
                const prevTs = prevIdx >= i0 && prevIdx < idx
                  ? times[prevIdx]
                  : null;
                return self._fmtAxisTick(times[idx], prevTs, compact);
              },
            },
          },
          y: {
            position: 'right',
            min: yLo - pad,
            max: yHi + pad,
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: {
              color: 'rgba(255,255,255,0.45)',
              font: { size: compact ? 9 : 10, family: 'Outfit' },
              maxTicksLimit: compact ? 5 : 8,
              callback: (v) => Number(v).toFixed(0),
            },
          },
        },
      },
    });
    this._chart.$rbBars = bars;
    this._chart.$rbTimes = times;
    this._chart.$rbSessionMarks = sessionMarks;
    this._chart.$rbDayBands = compact && dayBands.length > 5
      ? dayBands.slice(-5)
      : dayBands;
    this._chart.$rbFirstRed1h = o.firstRed1h || null;
    this._chart.$rbLevelTags = levelTags;
    this._chart.$rbCompact = compact;
    this._chart.$rbUI = this;
    // Flex / phone layout often settles after first paint — boxes/plugins need a
    // second resize+update or they stay invisible until the user taps the chart.
    const settle = () => {
      try {
        this._chart?.resize?.();
        this._chart?.update?.('none');
      } catch (_) {}
    };
    requestAnimationFrame(() => {
      settle();
      requestAnimationFrame(settle);
    });
    const box = canvas.parentElement;
    if (box && typeof ResizeObserver !== 'undefined') {
      try { this._chartRo?.disconnect(); } catch (_) {}
      this._chartRo = new ResizeObserver(() => settle());
      this._chartRo.observe(box);
    }
  },
};

if (typeof window !== 'undefined') window.RangeEmaUI = RangeEmaUI;
