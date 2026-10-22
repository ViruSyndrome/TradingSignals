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
    chartMode: 'candles', // 'candles' | 'renko'
    instrumentId: null,
    loading: false,
    capital: 1000,
    riskPct: 1,
  },

  cfg() {
    return (typeof CONFIG !== 'undefined' && CONFIG.rangeEma) ? CONFIG.rangeEma : {};
  },

  /**
   * True on phones even when Chrome "Desktop site" inflates CSS width (~980px),
   * and in landscape where CSS width jumps past 900 (e.g. Pro Max ~932).
   */
  isPhoneLayout() {
    if (typeof window === 'undefined') return false;
    try {
      // Cover large-phone landscape (device-width can exceed 900)
      if (window.matchMedia('(max-device-width: 1180px)').matches) return true;
      // Short viewport = phone landscape even if width looks "desktop"
      if (window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches) {
        return true;
      }
      if (window.matchMedia('(pointer: coarse) and (hover: none) and (max-width: 1200px)').matches) {
        return true;
      }
    } catch (_) {}
    const vw = window.visualViewport?.width || window.innerWidth || 0;
    const vh = window.visualViewport?.height || window.innerHeight || 0;
    if (vw > 0 && vw < 720) return true;
    // Landscape phone: wide but short
    if (vw >= 720 && vh > 0 && vh <= 520 && vw <= 1000) return true;
    return false;
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
    const allowed = inst.timeframes || c.timeframes || ['5m', '15m', '30m', '1h'];
    const tf = this.state.tf || c.workingTf || '15m';
    return allowed.includes(tf) ? tf : allowed[0];
  },

  setChartMode(mode) {
    if (this.state.chartMode === mode) return;
    this.state.chartMode = mode;
    try { localStorage.setItem('trendrunner_rb_chart_mode', mode); } catch (_) {}
    const row = (this.state.rows || [])[0];
    if (row && !row.error) {
      this.destroyChart();
      this._paintChart(row, this.cfg());
    }
    document.querySelectorAll('[data-rb-chart-mode]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-rb-chart-mode') === mode);
    });
  },

  setTf(tf) {
    const c = this.cfg();
    const inst = this.activeInstrument() || {};
    const allowed = inst.timeframes || c.timeframes || ['5m', '15m', '30m', '1h'];
    if (!allowed.includes(tf) || tf === this.activeTf()) return;
    this.state.tf = tf;
    try { localStorage.setItem('trendrunner_rb_tf_v2', tf); } catch (_) {}
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
      let phoneWas = this.isPhoneLayout();
      const sync = () => {
        this.syncPhoneClass();
        const phoneNow = this.isPhoneLayout();
        // Re-paint when crossing phone/desktop (portrait↔landscape) so
        // chart padding / touch / height match the new viewport.
        if (phoneWas !== phoneNow) {
          phoneWas = phoneNow;
          try { this.render(); } catch (_) {}
        } else if (phoneNow && this._chart) {
          try {
            this._chart.resize?.();
            this._chart.update?.('none');
          } catch (_) {}
        }
      };
      window.addEventListener('resize', sync, { passive: true });
      window.addEventListener('orientationchange', () => {
        // iOS reports new size after a beat
        setTimeout(sync, 120);
      }, { passive: true });
      window.visualViewport?.addEventListener('resize', sync, { passive: true });
    }
    try {
      const savedInst = localStorage.getItem('trendrunner_rb_instrument');
      if (savedInst && this.instruments().some((x) => x.id === savedInst)) {
        this.state.instrumentId = savedInst;
      } else {
        this.state.instrumentId = c.defaultInstrument || this.instruments()[0]?.id;
      }
      const inst = this.activeInstrument() || {};
      const allowed = inst.timeframes || c.timeframes || ['5m', '15m', '30m', '1h'];
      const savedTf = localStorage.getItem('trendrunner_rb_tf_v2');
      // Default to 15m (Sagar: mark previous swing high/low on 15m chart)
      if (savedTf && allowed.includes(savedTf)) {
        if (inst.feed === 'yahoo' && savedTf === '5m') {
          this.state.tf = allowed.includes('15m') ? '15m' : allowed[0];
        } else {
          this.state.tf = savedTf;
        }
      } else {
        this.state.tf = allowed.includes('15m') ? '15m' : (c.workingTf || allowed[0]);
      }
      const savedCap = Number(localStorage.getItem('trendrunner_rb_capital'));
      if (Number.isFinite(savedCap) && savedCap > 0) this.state.capital = savedCap;
      const savedRisk = Number(localStorage.getItem('trendrunner_rb_risk_pct'));
      if (Number.isFinite(savedRisk) && savedRisk > 0 && savedRisk <= 25) this.state.riskPct = savedRisk;
    } catch (_) {}
    // Paint shell immediately so we never sit on the static "Loading…" HTML
    this.state.loading = true;
    this.render();
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
    this.render();

    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

    try {
      const flaky = (err) => /abort|timed?\s*out|failed to fetch|network|load failed/i.test(String(err || ''));
      // Hard ceiling so a hung Yahoo/CORS proxy can never leave the desk blank forever
      let row = await withTimeout(this._buildRow(inst, c), 22000, `${inst?.label || 'Desk'} feed`);
      for (let attempt = 0; attempt < 1; attempt++) {
        if (gen !== this._refreshGen) return;
        if (!row?.error || !flaky(row.error)) break;
        await new Promise((r) => setTimeout(r, 500));
        if (gen !== this._refreshGen) return;
        row = await withTimeout(this._buildRow(inst, c), 18000, `${inst?.label || 'Desk'} retry`);
      }
      if (gen !== this._refreshGen) return;
      // If Yahoo 5m failed, fall back to 30m once so the desk recovers
      if (row?.error && inst?.feed === 'yahoo' && this.activeTf() === '5m') {
        this.state.tf = '30m';
        try { localStorage.setItem('trendrunner_rb_tf', '30m'); } catch (_) {}
        row = await withTimeout(this._buildRow(inst, c), 18000, 'Nifty 30m fallback');
      }
      if (gen !== this._refreshGen) return;
      this.state.rows = [row];
      this.state.updatedAt = Date.now();
      this.state.error = row?.error || null;
    } catch (e) {
      if (gen !== this._refreshGen) return;
      this.state.error = this._friendlyErr(e);
      this.state.rows = [{
        symbol: inst?.symbol,
        instrument: inst,
        error: this.state.error,
        tf: this.activeTf(),
      }];
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

  _ohlcLimit(tf, c, instrument) {
    const instMap = instrument?.ohlcLimit || {};
    if (instMap[tf] != null) return instMap[tf];
    const map = c.ohlcLimit || {};
    return map[tf] || 1000;
  },

  async _buildRow(inst, c) {
    const instrument = typeof inst === 'string'
      ? { id: inst, symbol: inst, feed: 'binanceSpot', dayMode: c.dayMode || 'utc' }
      : (inst || this.activeInstrument());
    const tf = this.activeTf();
    const lim = this._ohlcLimit(tf, c, instrument);
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
      sessions: instrument.sessions || c.sessions || [],
    };

    // Sagar pivot: first CLOSED 1H red AFTER the calendar day’s first candle
    // (never the open bar itself). Calendar IST day — not mark-window session day.
    let firstRed1h = null;
    try {
      const raw1h = typeof API.getDeskOHLC === 'function'
        ? await API.getDeskOHLC(instrument, '1h', 180)
        : await API.getCryptoOHLC(instrument.symbol, '1h', 180);
      const bars1h = this._klinesToBars(raw1h);
      if (bars1h.length >= 24) {
        const lastT = bars30[bars30.length - 1].t;
        const calDay = RedBarTrend.dayKey(lastT, readCfg.dayMode || 'ist');
        firstRed1h = RedBarTrend.firstRedBarOfSession(bars1h, calDay, {
          ...readCfg,
          asOfTs: lastT,
          barMs: 3600000,
        });
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

  /** Sagar playbook → plain language + levels (fib mark + 1H first red + session clock + futures R:R). */
  _actionPlan(o, emaAgree, instrument) {
    const inst = instrument || this.activeInstrument() || {};
    const hint = inst.tradeHint || 'Place the futures order on your exchange / broker';
    if (!o) {
      return { side: 'WAIT', title: 'No data', steps: [], cls: 'wait' };
    }
    const pb = o.playbook || {};
    const red = pb.redSetup || {};
    const clock = pb.clock || {};
    const sweep = pb.sweep || null;
    const emaNote = emaAgree === 'agrees'
      ? ' · EMA agrees'
      : emaAgree === 'disagrees'
        ? ' · EMA disagrees — size down or wait for alignment'
        : '';
    const clockStep = clock.tip ? clock.tip : null;
    const liqStep = pb.liquidityTip && pb.liquidityTip !== clock.tip ? pb.liquidityTip : null;
    const pivotStep = o.firstRed1h
      ? `Pivot = 1H first red after day open ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)} (day’s first candle skipped).`
      : 'Waiting for the first 1H red after the day’s opening candle.';
    const pdh = o.refs?.priorDayHigh;
    const pdl = o.refs?.priorDayLow;
    const rrStr = o.rr != null ? `1:${o.rr.toFixed(2)}` : '—';
    const stopPctStr = o.stopPct != null ? ` (${o.stopPct.toFixed(2)}%)` : '';
    const targetPctStr = o.targetPct != null ? ` (+${o.targetPct.toFixed(2)}%)` : '';
    const tp1Str = o.tp1 != null ? this._fmt(o.tp1) : '—';
    const tp3Str = o.tp3 != null ? this._fmt(o.tp3) : '—';
    const oneRPctStr = o.stopPct != null ? ` (+${o.stopPct.toFixed(2)}%)` : '';
    const sagarExitStep = `2️⃣ 50% TP at 1:1: ${tp1Str}${oneRPctStr} (bank 50% & move stop to Breakeven) · 3️⃣ Trail remaining 50% until EMA 10/30 cross over (Stretch: ${this._fmt(o.bookZone)} / rare 1:3 ${tp3Str}).`;

    if ((o.phase === 'first_candle' || o.phase === 'inside_or') && o.setupKind !== 'session_sweep') {
      const fibHi = o.currentBand?.high ?? o.refs?.orHigh;
      const fibLo = o.currentBand?.low ?? o.refs?.orLow;
      return {
        side: 'WAIT',
        cls: 'wait',
        title: 'Do not trade yet (Inside Fib Box)',
        subtitle: 'Inside today’s mark-window fib box (or window still forming). Sideways accumulation zone.',
        steps: [
          `Fib 0 / Fib 1: ${this._fmt(fibHi)} / ${this._fmt(fibLo)} — wait for a clean break & hold outside the box.`,
          pivotStep,
          ...(clockStep ? [clockStep] : []),
        ],
        entry: null,
        stop: null,
        exit: null,
        rr: null,
      };
    }

    const biasDir = o.trend === 'bullish' ? 'LONG' : o.trend === 'bearish' ? 'SHORT' : null;
    const isActionable = o.actionState === 'enter' && (biasDir === 'LONG' || biasDir === 'SHORT');
    const stopTag = o.invalidationReason || (biasDir === 'LONG' ? 'swing low' : 'swing high');
    const stopWarn = o.stopStructural === false
      ? ` ⚠️ Stop is a ${stopTag} (not a tight local swing — watch size).`
      : '';
    const bookTag = o.bookReason || 'liquidity magnet';

    // 1. Actionable setups ONLY: Trade 1 fresh departure, Trade 2 decisive candle, or Session Sweep
    if (isActionable) {
      const setupLabel = o.setupKind === 'session_sweep'
        ? `Session Sweep Reversal · Futures ${biasDir}`
        : o.setupKind === 'session_continuation'
          ? `Session Continuation · Futures ${biasDir} (London/US bias confirm)`
          : o.setupKind === 'trade2_confirmed'
            ? `Trade 2 Confirmed · Futures ${biasDir} (${red.revisitRead ? red.revisitRead.replace('_', ' ') : '1H red revisit'})`
            : `Trade 1 Departure · Futures ${biasDir} (Left 1H Red)`;
      return {
        side: biasDir,
        cls: biasDir === 'LONG' ? 'long' : 'short',
        title: setupLabel,
        subtitle: `Actionable setup · ${o.actionReason || '15m Swing Stop set · 50% TP at 1:1 + trail 50% till EMA 10/30 cross'}${emaNote}.`,
        steps: [
          `${hint}: Enter Futures ${biasDir} near ${this._fmt(o.price)}.`,
          `1️⃣ Stop-Loss First (${stopTag} on 15m): ${this._fmt(o.invalidation)}${stopPctStr}.${stopWarn}`,
          sagarExitStep,
          pivotStep,
          ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
        ],
        entry: o.price,
        stop: o.invalidation,
        tp1: o.tp1,
        tp3: o.tp3,
        exit: o.bookZone,
        rr: o.rr,
      };
    }

    // 2. Directional Bias / Watch ONLY (not an entry trigger yet — do not FOMO mid-trend)
    if (biasDir) {
      const watchTitle = o.setupKind === 'trade2_watch'
        ? `Trade 2 Watch · Testing 1H Red Pivot (${biasDir} Bias)`
        : o.setupKind === 'fib_pullback'
          ? `Bias: ${biasDir} · In Fib Pullback (Watch for Trigger)`
          : o.setupKind === 'pivot_reversal'
            ? `Bias Conflict · Crossed 1H Red vs Fibs (Stay Flat / Watch)`
            : `Bias: ${biasDir} · Mid-Trend (Wait for Trade 2 Revisit or Sweep)`;
      return {
        side: 'WATCH',
        cls: 'wait',
        title: watchTitle,
        subtitle: `${o.actionReason || 'Bias only — wait for a fresh Trade 1, Trade 2 revisit, or session sweep before entering'}${emaNote}.`,
        steps: [
          `Do NOT enter mid-air: directional bias is ${biasDir}, but there is no fresh Trade 1 departure, decisive Trade 2 candle, or session sweep on this bar.`,
          `Reference levels if a trigger prints — 1️⃣ Stop (${stopTag} on 15m): ${this._fmt(o.invalidation)}${stopPctStr} · 2️⃣ 50% TP (1:1): ${tp1Str}${oneRPctStr} · 3️⃣ Runner Trail: EMA 10/30 cross (Magnet ${this._fmt(o.bookZone)} · ${rrStr}).${stopWarn}`,
          pivotStep,
          ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
        ],
        tp1: o.tp1,
        tp3: o.tp3,
        entry: o.price,
        stop: o.invalidation,
        exit: o.bookZone,
        rr: o.rr,
      };
    }

    return {
      side: 'WAIT',
      cls: 'wait',
      title: 'No clear bias · Stay Flat',
      subtitle: 'Waiting for Fib box break or 1H first-red pivot confirmation.',
      steps: [
        'Watch prior-session fibs; wait for a clean break of today’s Fib 0 / Fib 1.',
        pivotStep,
        `Prior-day H/L magnets: ${this._fmt(pdh)} / ${this._fmt(pdl)}.`,
        ...(clockStep ? [clockStep] : []),
      ],
      entry: null,
      stop: null,
      exit: null,
      rr: null,
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
          ${inst.label} on <strong>${tf}</strong>: session fibs · 1H first-red pivot · prior-day H/L · session clock.
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
    document.querySelectorAll('[data-rb-chart-mode]').forEach((btn) => {
      btn.addEventListener('click', () => this.setChartMode(btn.getAttribute('data-rb-chart-mode')));
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

    // Inline Futures Sizing controls
    const capIn = document.getElementById('rbFuturesCap');
    const riskIn = document.getElementById('rbFuturesRisk');
    const recalcInlineSizing = () => {
      const cap = Number(capIn?.value);
      const risk = Number(riskIn?.value);
      if (Number.isFinite(cap) && cap > 0) {
        this.state.capital = cap;
        try { localStorage.setItem('trendrunner_rb_capital', String(cap)); } catch (_) {}
      }
      if (Number.isFinite(risk) && risk > 0 && risk <= 25) {
        this.state.riskPct = risk;
        try { localStorage.setItem('trendrunner_rb_risk_pct', String(risk)); } catch (_) {}
      }
      const row = (this.state.rows || [])[0];
      const o = row?.readout;
      if (!o || !o.price || !o.invalidation || typeof RedBarTrend === 'undefined') return;
      const sz = RedBarTrend.futuresSizing({
        entry: o.price,
        stop: o.invalidation,
        exit: o.bookZone,
        capital: this.state.capital,
        riskPct: this.state.riskPct,
      });
      if (!sz) return;
      const elRisk = document.getElementById('rbSzRisk');
      const elNotional = document.getElementById('rbSzNotional');
      const elLev = document.getElementById('rbSzLev');
      const elLiq = document.getElementById('rbSzLiq');
      const sym = (row?.instrument?.id || 'BTC').replace(/USDT$/i, '');
      if (elRisk) elRisk.textContent = `-${sz.riskUsd.toFixed(2)} → +${sz.netProfitUsd.toFixed(2)} (1:1 half +${(sz.tp1HalfNetUsd || 0).toFixed(2)})`;
      if (elNotional) elNotional.textContent = `$${sz.notionalUsd.toFixed(0)} · ${sz.qty.toFixed(3)} ${sym}`;
      if (elLev) elLev.textContent = `${sz.recLeverage}× iso (max ${sz.maxSafeLeverage}×)`;
      if (elLiq) elLiq.textContent = this._fmt(sz.liqPrice);
    };
    capIn?.addEventListener('input', recalcInlineSizing);
    riskIn?.addEventListener('input', recalcInlineSizing);

    document.getElementById('rbSendToRiskCalc')?.addEventListener('click', () => {
      const row = (this.state.rows || [])[0];
      const o = row?.readout;
      if (!o || !o.price || !o.invalidation) return;
      const capEl = document.getElementById('totalCapital');
      const pctEl = document.getElementById('riskPct');
      const entEl = document.getElementById('entryPrice');
      const stpEl = document.getElementById('stopLossPrice');
      const tpEl = document.getElementById('targetPrice');
      if (capEl) capEl.value = String(this.state.capital || 1000);
      if (pctEl) pctEl.value = String(this.state.riskPct || 1);
      if (entEl) entEl.value = String(o.price);
      if (stpEl) stpEl.value = String(o.invalidation);
      if (tpEl && o.bookZone) tpEl.value = String(o.bookZone);
      const navBtn = document.querySelector('.nav-link[data-section="riskSection"]');
      if (navBtn) navBtn.click();
      document.getElementById('calcRisk')?.click();
    });
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
    const stopSub = o.stopPct != null ? `<small class="rb-level-sub">-${o.stopPct.toFixed(2)}% (${o.invalidationReason || '15m swing'})</small>` : '';
    const tp1Sub = o.stopPct != null ? `<small class="rb-level-sub">+${o.stopPct.toFixed(2)}% · Bank 50% &amp; SL→BE</small>` : '';
    const rrBadge = a.rr != null ? `${a.rr.toFixed(2)}R` : '—';
    const runnerSub = a.exit != null
      ? `<small class="rb-level-sub">Magnet ${this._fmt(a.exit)} (${rrBadge}) · 1:3 ${this._fmt(a.tp3 ?? o.tp3)}</small>`
      : '<small class="rb-level-sub">Trail 50% till EMA 10/30 cross</small>';

    let futuresBarHtml = '';
    if (a.side === 'LONG' || a.side === 'SHORT') {
      const sz = (typeof RedBarTrend !== 'undefined' && RedBarTrend.futuresSizing)
        ? RedBarTrend.futuresSizing({
          entry: a.entry,
          stop: a.stop,
          exit: a.exit,
          capital: this.state.capital || 1000,
          riskPct: this.state.riskPct || 1,
        })
        : o.sizing;
      if (sz) {
        const sym = (r.instrument?.id || 'BTC').replace(/USDT$/i, '');
        futuresBarHtml = `
          <div class="rb-futures-bar">
            <div class="rb-futures-inputs">
              <label>Wallet $
                <input type="number" id="rbFuturesCap" value="${this.state.capital || 1000}" min="10" step="50" />
              </label>
              <label>Risk %
                <input type="number" id="rbFuturesRisk" value="${this.state.riskPct || 1}" min="0.1" max="10" step="0.25" />
              </label>
            </div>
            <div class="rb-futures-metrics">
              <div><span>1R Risk / Net Profit</span><strong id="rbSzRisk">-${sz.riskUsd.toFixed(2)} → +${sz.netProfitUsd.toFixed(2)} (1:1 half +${(sz.tp1HalfNetUsd || 0).toFixed(2)})</strong></div>
              <div><span>Futures Size</span><strong id="rbSzNotional">$${sz.notionalUsd.toFixed(0)} · ${sz.qty.toFixed(3)} ${sym}</strong></div>
              <div><span>Safe Leverage</span><strong id="rbSzLev">${sz.recLeverage}× iso (max ${sz.maxSafeLeverage}×)</strong></div>
              <div><span>Est. Liq Price</span><strong id="rbSzLiq" class="neg-text">${this._fmt(sz.liqPrice)}</strong></div>
            </div>
            <button type="button" class="rb-futures-calc-btn" id="rbSendToRiskCalc" title="Open setup in Futures Risk Calculator">Risk Calc ↗</button>
          </div>
        `;
      }
    }

    return `
      <div class="rb-action ${a.cls}">
        <div class="rb-action-side">${a.side}</div>
        <div class="rb-action-body">
          <div class="rb-action-title">${a.title}</div>
          <div class="rb-action-sub">${a.subtitle || ''}</div>
          ${(() => {
            const tfStr = this.activeTf() || '15m';
            const tfMins = tfStr === '5m' ? 5 : tfStr === '30m' ? 30 : tfStr === '1h' ? 60 : 15;
            const nowMs = Date.now();
            const barMs = tfMins * 60000;
            const remSec = Math.max(1, Math.ceil((barMs - (nowMs % barMs)) / 1000));
            const remM = Math.floor(remSec / 60);
            const remS = remSec % 60;
            const nextBarStr = `Next ${tfStr} bar close in ${remM}m ${String(remS).padStart(2, '0')}s`;
            const liveClk = (typeof RedBarTrend !== 'undefined' && RedBarTrend.istClockPhase) ? RedBarTrend.istClockPhase(nowMs) : o.playbook?.clock;
            const trigParts = [];
            if (a.side === 'WATCH' || a.side === 'WAIT') {
              if (o.renko?.nextBrickLevel != null) trigParts.push(`Fresh Brick @ ${this._fmt(o.renko.nextBrickLevel)}`);
              if (o.firstRed1h) trigParts.push(`1H Red Zone ${this._fmt(o.firstRed1h.low)}–${this._fmt(o.firstRed1h.high)}`);
            }
            return `<div class="range-chips" style="margin: 0 0 8px;">
              ${o.renko ? `<span class="range-chip ${o.renko.dir === 1 ? 'pos' : o.renko.dir === -1 ? 'neg' : ''}">8.33% ATR Brick: ${this._fmt(o.renko.brickSize)} (${o.renko.brickPct.toFixed(2)}%) · Renko ${o.renko.dir === 1 ? 'BULL' : o.renko.dir === -1 ? 'BEAR' : 'FLAT'} (#${o.renko.bricksInRun}${o.renko.freshBrick ? ' · FRESH' : ' · wait fresh brick'}) · Flip ${this._fmt(o.renko.flipLevel)}</span>` : ''}
              <span class="range-chip">⏱️ ${nextBarStr}</span>
              ${liveClk?.nextWindow ? `<span class="range-chip">🕒 ${liveClk.nextWindow}</span>` : liveClk?.label ? `<span class="range-chip">🕒 ${liveClk.label}</span>` : ''}
              ${trigParts.length ? `<span class="range-chip">🎯 Auto-Trigger Watch: ${trigParts.join(' · ')}</span>` : ''}
            </div>`;
          })()}
          <ul class="rb-action-steps">${steps}</ul>
          <div class="rb-action-levels">
            <div><span>Entry Lean</span><strong>${this._fmt(a.entry)}</strong><small class="rb-level-sub">15m Execution</small></div>
            <div><span>1. Stop-Loss (1R)</span><strong class="neg-text">${this._fmt(a.stop)}</strong>${stopSub}</div>
            <div><span>2. 50% TP (1:1)</span><strong class="pos-text">${this._fmt(a.tp1 ?? o.tp1)}</strong>${tp1Sub}</div>
            <div><span>3. 50% Runner</span><strong class="pos-text">EMA 10/30 Cross</strong>${runnerSub}</div>
          </div>
          ${futuresBarHtml}
        </div>
      </div>

      <div class="rb-chart-wrap glass">
        <div class="rb-chart-toolbar">
          <div class="rb-chart-mode-group" role="group" aria-label="Chart style" style="display:flex;gap:4px;margin-right:8px;">
            <button type="button" class="rb-tf-btn${this.state.chartMode !== 'renko' ? ' active' : ''}" data-rb-chart-mode="candles" title="Standard Candlesticks">🕯️ Candles</button>
            <button type="button" class="rb-tf-btn${this.state.chartMode === 'renko' ? ' active' : ''}" data-rb-chart-mode="renko" title="Dr. Dev 8.33% ATR Renko Bricks">🧱 Renko View</button>
          </div>
          <div class="rb-tf-group" role="group" aria-label="Chart timeframe">
            ${(c.timeframes || ['5m', '15m', '30m', '1h']).map((t) =>
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
          <span class="lg price">Candles (${this.activeTf()})</span>
          <span class="lg ema10">EMA ${c.emaFast || 10}</span>
          <span class="lg ema30">EMA ${c.emaSlow || 30} (Runner Trail)</span>
          <span class="lg band">${this._isFibStyle(r) ? `Fib 0·44·50·56·1${r.instrument?.markLabel ? ` · ${r.instrument.markLabel}` : ''}` : 'Day ranges'}</span>
          <span class="lg stop">1H first red</span>
          <span class="lg stop rb-lg-desk">15m Swing SL</span>
          <span class="lg tp rb-lg-desk">1:1 (50% TP) &amp; Stretch</span>
          <span class="lg sess-asia rb-lg-desk">Asia H/L</span>
          <span class="lg sess-london rb-lg-desk">London H/L</span>
          <span class="lg sess-ny rb-lg-desk">NY H/L</span>
        </div>
        <p class="rb-zoom-hint">${this.isPhoneLayout() ? 'Pinch to zoom · ◀ ▶ to scrub · Fit resets' : 'Pinch / wheel to zoom · drag to pan · Fit resets'}</p>
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
        ${o.renko
          ? `<span class="range-chip ${o.renko.dir === 1 ? 'pos' : o.renko.dir === -1 ? 'neg' : ''}">8.33% ATR Brick: ${this._fmt(o.renko.brickSize)} (${o.renko.brickPct.toFixed(2)}%) · Renko ${o.renko.dir === 1 ? 'BULL' : o.renko.dir === -1 ? 'BEAR' : 'FLAT'} (#${o.renko.bricksInRun}) · Flip ${this._fmt(o.renko.flipLevel)}</span>`
          : ''}
        ${o.playbook?.clock
          ? `<span class="range-chip">${o.playbook.clock.label}</span>`
          : ''}
        ${o.playbook?.redSetup
          ? `<span class="range-chip ${o.playbook.redSetup.revisitWindow ? 'pos' : ''}">${o.playbook.redSetup.label}</span>`
          : ''}
        ${o.playbook?.sweep
          ? `<span class="range-chip pos">${o.playbook.sweep.label}</span>`
          : ''}
        <span class="range-chip">EMA: ${String((r.ema && r.ema.cross) || '').replace(/_/g, ' ')}</span>
        <span class="range-chip ${r.emaAgree === 'agrees' ? 'pos' : r.emaAgree === 'disagrees' ? 'neg' : ''}">EMA ${r.emaAgree}</span>
        ${(o.refs?.prevSwingHigh != null || o.refs?.prevSwingLow != null)
          ? `<span class="range-chip">15m Prev Swing H/L: ${this._fmt(o.refs.prevSwingHigh)} / ${this._fmt(o.refs.prevSwingLow)}</span>`
          : ''}
        ${(o.cpr || o.playbook?.cpr) ? `<span class="range-chip">Dr. Dev CPR: ${this._fmt((o.cpr || o.playbook.cpr).pivot)} (BC ${this._fmt((o.cpr || o.playbook.cpr).bc)} · TC ${this._fmt((o.cpr || o.playbook.cpr).tc)})</span>` : ''}
        ${o.refs?.priorDayHigh != null
          ? `<span class="range-chip">Prev Day (PDH/PDL): ${this._fmt(o.refs.priorDayHigh)} / ${this._fmt(o.refs.priorDayLow)}</span>`
          : ''}
        ${o.refs?.asiaHigh != null
          ? `<span class="range-chip">Asia H/L: ${this._fmt(o.refs.asiaHigh)} / ${this._fmt(o.refs.asiaLow)}</span>`
          : ''}
        ${o.refs?.londonHigh != null
          ? `<span class="range-chip">London H/L: ${this._fmt(o.refs.londonHigh)} / ${this._fmt(o.refs.londonLow)}</span>`
          : ''}
        ${o.refs?.nyHigh != null
          ? `<span class="range-chip">NY (US) H/L: ${this._fmt(o.refs.nyHigh)} / ${this._fmt(o.refs.nyLow)}</span>`
          : ''}
        ${o.firstRed1h
          ? `<span class="range-chip">1H first red ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)}</span>`
          : ''}
        ${o.playbook?.liquidityTip
          ? `<span class="range-chip">${o.playbook.liquidityTip}</span>`
          : ''}
      </div>

      <p class="range-desk-footnote">
        Futures Desk · Green = Actionable LONG · Red = Actionable SHORT · Grey = WATCH / WAIT (bias only — do not chase mid-trend).
        Only Trade 1 departure, decisive Trade 2 revisit, or Session Sweep trigger an entry.
      </p>
    `;
  },

  /** Bars per clock-hour on this timeframe */
  _barsPerHour(tf) {
    if (tf === '5m') return 12;
    if (tf === '15m') return 4;
    if (tf === '30m') return 2;
    if (tf === '1h') return 1;
    return 4;
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
    if (typeof RedBarTrend !== 'undefined' && typeof RedBarTrend.zonedClockToUtc === 'function') {
      return RedBarTrend.zonedClockToUtc(dayStr, timeZone, hour, minute);
    }
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
    if (typeof RedBarTrend !== 'undefined' && typeof RedBarTrend.zonedDay === 'function') {
      return RedBarTrend.zonedDay(ts, timeZone);
    }
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  },

  /**
   * Collect open/close markers in the visible candle window.
   * t0/t1 are first/last bar OPEN times — extend end by barMs so a session
   * open on the forming 1H candle (e.g. London 07:00:12 vs bar 07:00:00) is kept.
   */
  _sessionMarkersInRange(t0, t1, sessions, barMs = 30 * 60 * 1000) {
    const out = [];
    if (!sessions || !sessions.length || t1 <= t0) return out;
    const pad = 48 * 3600 * 1000;
    const winStart = t0;
    const winEnd = t1 + Math.max(barMs, 60 * 1000);
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
        if (openTs >= winStart && openTs < winEnd) {
          out.push({ ts: openTs, kind: 'open', label: s.label, color: s.color || '#94a3b8' });
        }
        if (closeTs >= winStart && closeTs < winEnd) {
          out.push({ ts: closeTs, kind: 'close', label: s.label, color: s.color || '#94a3b8' });
        }
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  },

  _barMs(times) {
    if (!times || times.length < 2) return 30 * 60 * 1000;
    // Median step — more stable than times[1]-times[0] when the window starts on a gap
    const steps = [];
    for (let i = 1; i < Math.min(times.length, 24); i++) {
      const d = times[i] - times[i - 1];
      if (d > 0) steps.push(d);
    }
    if (!steps.length) return 30 * 60 * 1000;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)];
  },

  /**
   * Map a session open/close timestamp onto a candle index.
   * Prefer the bar that CONTAINS the event (open <= ts < open+barMs) so 1H
   * still shows London/US even when the open isn't exactly on a candle open.
   */
  _nearestBarIndex(times, ts) {
    if (!times.length) return -1;
    const barMs = this._barMs(times);

    // 1) Bar that contains the event
    for (let i = 0; i < times.length; i++) {
      if (times[i] <= ts && ts < times[i] + barMs) return i;
    }

    // 2) Nearest open within ~one bar (covers edge / gap cases)
    let best = 0;
    let bestDist = Math.abs(times[0] - ts);
    for (let i = 1; i < times.length; i++) {
      const d = Math.abs(times[i] - ts);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    if (bestDist > barMs * 1.05) return -1;
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
          // Allow overlapping session labels on the last (forming) bar — don't skip London
          const onLastBar = idx >= times.length - 1;
          if (!onLastBar && x - lastLineX < minLineGap) continue;
          lastLineX = x;

          ctx.strokeStyle = m.color;
          ctx.globalAlpha = compact
            ? (m.kind === 'open' ? 0.7 : 0.35)
            : (m.kind === 'open' ? 0.9 : 0.5);
          ctx.lineWidth = m.kind === 'open' ? (compact ? 1.5 : 2) : 1;
          ctx.setLineDash(m.kind === 'open' ? [] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          if (!showLabels || m.kind !== 'open') continue;
          if (!onLastBar && x - lastLabelX < minLabelGap) continue;
          lastLabelX = x;

          ctx.globalAlpha = 0.95;
          ctx.fillStyle = m.color;
          ctx.font = compact
            ? '700 9px Outfit, system-ui, sans-serif'
            : '700 10px Outfit, system-ui, sans-serif';
          ctx.textAlign = onLastBar ? 'right' : 'center';
          ctx.textBaseline = 'top';
          const tag = compact ? String(m.label || '').slice(0, 1) : `${m.label}`;
          const tx = onLastBar ? Math.min(x, area.right - 4) : x;
          ctx.fillText(tag, tx, area.top + 2);
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
        const bodyW = Math.max(3, Math.min(slot * 0.72, 16));

        ctx.save();
        const isRenko = chart.$rbChartMode === 'renko';

        if (isRenko) {
          // Bars are already buildRenkoSeries bricks (same engine as the gate)
          for (let i = 0; i < n; i++) {
            const b = bars[i];
            const x = xScale.getPixelForValue(i);
            if (!Number.isFinite(x)) continue;
            const yO = yScale.getPixelForValue(b.o);
            const yC = yScale.getPixelForValue(b.c);
            const isUp = b.dir === 1 || b.c >= b.o;
            const color = isUp ? '#22c55e' : '#ef4444';
            const top = Math.min(yO, yC);
            const h = Math.max(4, Math.abs(yC - yO));

            ctx.fillStyle = color;
            ctx.fillRect(x - bodyW / 2, top, bodyW, h);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - bodyW / 2, top, bodyW, h);
          }
        } else {
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
        }
        ctx.restore();
      },
    };
  },

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

  /** Full-width dashed line at first 1H red high — only while pivot is active. */
  _firstRed1hPlugin() {
    return {
      id: 'rbFirstRed1h',
      afterDatasetsDraw(chart) {
        if (chart.$rbShowFirstRed === false) return;
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
          // Compact: short labels drawn INSIDE the plot (no dead right gutter)
          const shortName = compact
            ? ({ STOP: 'STP', '1:1 TP': '1:1', EXIT: 'TP', '1H RED': '1R', 'SWG HI': 'SwH', 'SWG LO': 'SwL', PDH: 'PDH', PDL: 'PDL', 'ASIA HI': 'A↑', 'ASIA LO': 'A↓', 'LON HI': 'L↑', 'LON LO': 'L↓', 'NY HI': 'NY↑', 'NY LO': 'NY↓', R: 'R', S: 'S' }[t.name] || t.name)
            : t.name;
          const label = `${shortName} ${price}`;
          const padX = compact ? 3 : 5;
          const tw = ctx.measureText(label).width;
          const boxW = tw + padX * 2;
          const boxH = compact ? 13 : 15;
          // Inside chart area, flush to the right scale — reclaim the old padding gutter
          const x = Math.max(area.left + 2, axisX - boxW - (compact ? 2 : 4));

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
      || ({ '5m': 96, '15m': 80, '30m': 72, '1h': 56 }[tf] || 80);
    const want = compact ? wantMobile : wantDesktop;
    const o = row.readout;
    const isRenkoMode = this.state.chartMode === 'renko';
    let bars;
    let emaF;
    let emaS;

    // Renko View uses the same buildRenkoSeries + brickSize as the ENTER gate chip
    if (isRenkoMode && typeof RedBarTrend !== 'undefined' && RedBarTrend.buildRenkoSeries) {
      const bSize = o.renko?.brickSize || (row.bars[row.bars.length - 1].c * 0.0018);
      const allBricks = RedBarTrend.buildRenkoSeries(row.bars, bSize);
      const showN = Math.min(want, Math.max(1, allBricks.length));
      const renkoSlice = allBricks.length ? allBricks.slice(-showN) : [];
      if (!renkoSlice.length) {
        // Fall back to candles if no bricks printed yet
        const offset = Math.max(0, row.bars.length - want);
        bars = row.bars.slice(offset);
        emaF = (row.ema.emaF || []).slice(offset);
        emaS = (row.ema.emaS || []).slice(offset);
      } else {
        bars = renkoSlice.map((b) => ({
          t: b.t,
          o: b.o,
          h: Math.max(b.o, b.c),
          l: Math.min(b.o, b.c),
          c: b.c,
          dir: b.dir,
        }));
        const renkoCloses = allBricks.map((b) => b.c);
        const kF = 2 / ((c.emaFast || 10) + 1);
        const kS = 2 / ((c.emaSlow || 30) + 1);
        const fullEmaF = [];
        const fullEmaS = [];
        let ef = renkoCloses[0];
        let es = renkoCloses[0];
        for (let i = 0; i < renkoCloses.length; i++) {
          ef = renkoCloses[i] * kF + ef * (1 - kF);
          es = renkoCloses[i] * kS + es * (1 - kS);
          fullEmaF.push(ef);
          fullEmaS.push(es);
        }
        emaF = fullEmaF.slice(-showN);
        emaS = fullEmaS.slice(-showN);
      }
    } else {
      const showN = Math.min(want, row.bars.length);
      const offset = row.bars.length - showN;
      bars = row.bars.slice(-showN);
      emaF = (row.ema.emaF || []).slice(offset);
      emaS = (row.ema.emaS || []).slice(offset);
    }

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
      o.refs?.priorDayHigh, o.refs?.priorDayLow,
      o.refs?.asiaHigh, o.refs?.asiaLow,
      o.refs?.londonHigh, o.refs?.londonLow,
      ...bandPrices,
    ].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
    const yHi = Math.max(barHi, ...nearLevels);
    const yLo = Math.min(barLo, ...nearLevels);
    const barSpan = (yHi - yLo) || 1;
    const pad = barSpan * 0.06 || 1;
    const self = this;
    const showSessions = inst.showSessionMarkers !== false && (inst.sessions || c.sessions);
    const barMs = this._barMs(times);
    let sessionMarks = showSessions
      ? this._sessionMarkersInRange(times[0], times[n - 1], inst.sessions || c.sessions || [], barMs)
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

    // Y-axis: keep it sparse. Chips carry PDH/PDL + Asia/London liquidity.
    // Axis only shows live trade levels + 1H RED at entry moments.
    const levelTags = [];
    const priceNow = Number(o.price);
    const pushTag = (name, value, color, bg, { priority = false, rank = 2 } = {}) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      const v = Number(value);
      const r = priority ? 1 : rank;
      const hit = levelTags.findIndex((t) => this._nearPrice(t.value, v, 2));
      if (hit >= 0) {
        if (priority || r < (levelTags[hit].rank ?? 2)) levelTags[hit] = { name, value: v, color, bg, rank: r };
        return;
      }
      levelTags.push({ name, value: v, color, bg, rank: r });
    };
    const ahead = (level, dir) => {
      if (level == null || !Number.isFinite(priceNow)) return false;
      const v = Number(level);
      if (dir === 'above') return v > priceNow;
      if (dir === 'below') return v < priceNow;
      return true;
    };

    const redId = o.playbook?.redSetup?.id;
    // Dashed pivot line + tag only when price is at/revisit the first-red entry
    const showPivot = !!(o.firstRed1h?.high != null
      && (redId === 'trade2_revisit' || redId === 'at_pivot'));

    // Time-of-day & state-aware Y-axis tags (max 3 tags so the right axis stays clean):
    // 1) When an actionable trade is live (LONG/SHORT), show ONLY the trade's STOP, 1:1 TP, and EXIT.
    // 2) When in WATCH/WAIT, show ONLY the levels relevant to the current session clock & bias:
    //    - Stop-side 15m Previous Swing (SWG LO for bull / SWG HI for bear)
    //    - Current session's hunted liquidity pool (Pre-London: 1H RED + PDH/PDL; London: nearest Asia H/L;
    //      US Open: nearest London H/L; After US: nearest NY H/L or PDH/PDL).
    const pickNearer = (hiName, hiVal, loName, loVal, color, bg, rank = 2) => {
      const hOk = hiVal != null && Number.isFinite(Number(hiVal));
      const lOk = loVal != null && Number.isFinite(Number(loVal));
      if (hOk && lOk) {
        const dHi = Math.abs(Number(hiVal) - priceNow);
        const dLo = Math.abs(Number(loVal) - priceNow);
        if (dHi <= dLo) pushTag(hiName, hiVal, color, bg, { rank });
        else pushTag(loName, loVal, color, bg, { rank });
      } else if (hOk) {
        pushTag(hiName, hiVal, color, bg, { rank });
      } else if (lOk) {
        pushTag(loName, loVal, color, bg, { rank });
      }
    };

    if (trading) {
      pushTag('STOP', stopPx, COL.stop, 'rgba(60, 10, 10, 0.94)', { priority: true });
      const tp1Px = action.tp1 ?? o.tp1;
      if (tp1Px != null) {
        pushTag('1:1 TP', tp1Px, '#38bdf8', 'rgba(8, 47, 73, 0.94)', { priority: true });
      }
      if (action.side === 'LONG' && ahead(exitPx, 'above')) {
        pushTag('EXIT', exitPx, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
      } else if (action.side === 'SHORT' && ahead(exitPx, 'below')) {
        pushTag('EXIT', exitPx, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
      }
    } else {
      const clockId = o.playbook?.clock?.id || 'pre_london';
      // 1. Always show the relevant 15m swing stop side (or 1H RED when at/revisiting pivot)
      if (showPivot && o.firstRed1h?.high != null) {
        pushTag('1H RED', o.firstRed1h.high, '#f43f5e', 'rgba(60, 10, 20, 0.94)', { priority: true });
      } else if (o.trend === 'bullish') {
        pushTag('SWG LO', o.refs?.prevSwingLow, '#fb923c', 'rgba(55, 28, 10, 0.88)', { priority: true });
      } else if (o.trend === 'bearish') {
        pushTag('SWG HI', o.refs?.prevSwingHigh, '#fb923c', 'rgba(55, 28, 10, 0.88)', { priority: true });
      } else {
        pickNearer('SWG HI', o.refs?.prevSwingHigh, 'SWG LO', o.refs?.prevSwingLow, '#fb923c', 'rgba(55, 28, 10, 0.88)');
      }

      // 2. Session-specific liquidity pool for the current clock window (rank 2 = hunted pool, rank 3 = PDH/PDL)
      if (clockId === 'pre_london') {
        if (o.firstRed1h?.high != null) {
          pushTag('1H RED', o.firstRed1h.high, '#f43f5e', 'rgba(60, 10, 20, 0.94)', { rank: 2 });
        }
        pickNearer('PDH', o.refs?.priorDayHigh, 'PDL', o.refs?.priorDayLow, '#fbbf24', 'rgba(55, 40, 10, 0.90)', 3);
      } else if (clockId === 'london') {
        // London hunts Asia High / Low
        pickNearer('ASIA HI', o.refs?.asiaHigh, 'ASIA LO', o.refs?.asiaLow, '#818cf8', 'rgba(25, 25, 60, 0.88)', 2);
        pickNearer('PDH', o.refs?.priorDayHigh, 'PDL', o.refs?.priorDayLow, '#fbbf24', 'rgba(55, 40, 10, 0.90)', 3);
      } else if (clockId === 'us_open') {
        // US Open hunts London High / Low (and untouched Asia)
        pickNearer('LON HI', o.refs?.londonHigh, 'LON LO', o.refs?.londonLow, '#f472b6', 'rgba(55, 18, 42, 0.88)', 2);
        if (o.playbook?.asiaUntouched) {
          pickNearer('ASIA HI', o.refs?.asiaHigh, 'ASIA LO', o.refs?.asiaLow, '#818cf8', 'rgba(25, 25, 60, 0.88)', 2);
        } else {
          pickNearer('PDH', o.refs?.priorDayHigh, 'PDL', o.refs?.priorDayLow, '#fbbf24', 'rgba(55, 40, 10, 0.90)', 3);
        }
      } else {
        // After US open: NY session H/L + nearest Prior Day H/L magnet
        pickNearer('NY HI', o.refs?.nyHigh, 'NY LO', o.refs?.nyLow, '#cbd5e1', 'rgba(30, 41, 59, 0.88)', 2);
        pickNearer('PDH', o.refs?.priorDayHigh, 'PDL', o.refs?.priorDayLow, '#fbbf24', 'rgba(55, 40, 10, 0.90)', 3);
      }
    }

    // Hard cap: keep at most 3 Y-axis tags, preserving fixed priority rank (1=STOP/SWG/1H RED, 2=hunted pool, 3=PDH/PDL) before distance
    if (levelTags.length > 3) {
      levelTags.sort((a, b) => ((a.rank ?? 2) - (b.rank ?? 2)) || (Math.abs(a.value - priceNow) - Math.abs(b.value - priceNow)));
      levelTags.length = 3;
    }

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
          // Tags draw inside the plot now — only a slim edge for the Y tick labels
          padding: {
            top: compact ? 10 : 14,
            bottom: compact ? 8 : 6,
            right: compact ? 6 : 8,
            left: compact ? 4 : 6,
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
            // Desktop: drag-pan. Phone: pinch to zoom; use ◀ ▶ for scrub (keeps page scroll).
            pan: {
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
              // Fewer plain price ticks — custom STOP/EXIT tags carry the action
              maxTicksLimit: compact ? 3 : 5,
              callback: (v) => Number(v).toFixed(0),
            },
          },
        },
      },
    });
    this._chart.$rbBars = bars;
    this._chart.$rbChartMode = this.state.chartMode || 'candles';
    if (this._chart.$rbChartMode === 'renko' && typeof RedBarTrend !== 'undefined' && RedBarTrend.buildRenkoSeries) {
      const bSize = o.renko?.brickSize || (closes[closes.length - 1] * 0.0018);
      const allBricks = RedBarTrend.buildRenkoSeries(row.bars, bSize);
      this._chart.$rbRenkoSeries = allBricks.slice(-bars.length);
    } else {
      this._chart.$rbRenkoSeries = null;
    }
    this._chart.$rbTimes = times;
    this._chart.$rbSessionMarks = sessionMarks;
    this._chart.$rbDayBands = compact && dayBands.length > 5
      ? dayBands.slice(-5)
      : dayBands;
    this._chart.$rbFirstRed1h = o.firstRed1h || null;
    this._chart.$rbShowFirstRed = showPivot;
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
