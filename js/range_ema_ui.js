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
    alertsOn: true,
    /** Frozen levels from first ENTER of this setup (levels drift on refresh — place from snapshot). */
    enterSnapshot: null,
    futuresStatus: null,
    lastBotTrade: null,
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
      feed: 'binanceFutures',
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
    this.state.chartPanOffset = 0;
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
    this.state.chartPanOffset = 0;
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
    this.state.chartPanOffset = 0;
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
      if (typeof DeskAlerts !== 'undefined') {
        // Default ON — users should not have to hunt for Telegram ENTER
        if (localStorage.getItem(DeskAlerts.STORAGE_KEY) == null) {
          DeskAlerts.setEnabled(true);
        }
        this.state.alertsOn = DeskAlerts.enabled();
        DeskAlerts.ensureBotUrl();
        // Wake Render so the first ENTER does not die on a cold start
        const botBase = DeskAlerts._botBaseUrl?.() || DeskAlerts.DEFAULT_BOT_URL;
        if (botBase) {
          fetch(`${botBase}/health`, { cache: 'no-store' }).catch(() => {});
        }
      }
    } catch (_) {}
    // Paint shell immediately so we never sit on the static "Loading…" HTML
    this.state.loading = true;
    this.render();
    this.refresh();
    clearInterval(this._timer);
    // 30s desk refresh matches worker scan — open-tab Telegram relay catches brief ENTER
    this._timer = setInterval(() => this.refresh(), 30 * 1000);
  },

  async _toggleAlerts() {
    if (typeof DeskAlerts === 'undefined') {
      this._showDeskToast('Alerts module missing — hard refresh');
      return;
    }
    if (!this.state.alertsOn) {
      const perm = await DeskAlerts.requestPermission();
      if (perm === 'denied' || perm === 'unsupported') {
        this._showDeskToast(
          perm === 'unsupported'
            ? 'This browser does not support notifications'
            : 'Notifications blocked — enable them in browser site settings'
        );
        return;
      }
      DeskAlerts.setEnabled(true);
      this.state.alertsOn = true;
      this._showDeskToast('Red Bar ENTER alerts on — Trade 1 / Trade 2 / sweep only');
    } else {
      DeskAlerts.setEnabled(false);
      this.state.alertsOn = false;
      this._showDeskToast('ENTER alerts off');
    }
    this.render();
  },

  _showDeskToast(msg) {
    if (typeof Dashboard !== 'undefined' && Dashboard._showToast) {
      Dashboard._showToast(msg, 'info');
      return;
    }
    try { console.info('[DeskAlerts]', msg); } catch (_) {}
  },

  _notifyIfEnter(row) {
    if (typeof DeskAlerts === 'undefined' || !row || row.error) return;
    const a = row.action;
    const o = row.readout;
    const inst = row.instrument || this.activeInstrument() || {};
    const isEnter = a?.side === 'LONG' || a?.side === 'SHORT';
    const actionable = (o?.actionState === 'enter' || (a?.isFibMagnet && a?.magnetState === 'ENTER')) && isEnter;

    // WATCH / bias is NOT an ENTER — do not Telegram.
    // But keep retrying the last real ENTER for a few minutes (brief Trade 2
    // windows + Render cold start used to miss Telegram after flip back to WATCH).
    if (!actionable) {
      const pending = this._pendingEnterAlert;
      if (pending && Date.now() - (pending.queuedAt || 0) < 10 * 60 * 1000) {
        Promise.resolve(DeskAlerts.maybeNotifyEnter(pending))
          .catch((e) => console.warn('[RangeEmaUI] pending TG retry failed', e));
      }
      return;
    }

    const fmt = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return null;
      const d = inst.priceDecimals ?? 2;
      return Number(n).toFixed(d);
    };
    const payload = {
      instrumentId: inst.id || inst.symbol,
      label: inst.label || inst.symbol,
      symbol: inst.symbol,
      side: a.side,
      setupKind: a?.isFibMagnet ? 'fib_magnet_reversion' : (o?.setupKind || 'enter'),
      title: a?.title || o?.setupKind,
      price: fmt(a?.entry ?? o?.price),
      stop: fmt(a?.stop ?? o?.invalidation),
      tp1: fmt(a?.tp1 ?? o?.tp1),
      dayKey: o?.asOfDay || '',
      triggerTs: a?.isFibMagnet ? (row.fibMagnet?.candleTime || Date.now()) : (o?.triggerTs || o?.playbook?.redSetup?.triggerTs || o?.t || Date.now()),
      queuedAt: Date.now(),
    };
    this._pendingEnterAlert = payload;
    // Freeze levels for place/bot — live refresh was changing Entry/SL/TP mid-signal
    const freshMins = String(inst.id || '').toUpperCase() === 'NIFTY' ? 20 : 90;
    const snapKey = `${payload.dayKey}|${payload.side}|${payload.setupKind}|${payload.triggerTs}`;
    const prevSnap = this.state.enterSnapshot;
    const prevStale = prevSnap?.at ? ((Date.now() - prevSnap.at) / 60000 > freshMins) : false;
    if (!prevSnap || prevSnap.key !== snapKey || prevStale) {
      const entry = Number(a.entry ?? o.price);
      const stop = Number(o.invalidation);
      const oneR = Math.abs(entry - stop);
      const tpA = Number(o.tp1);
      const tpB = Number(o.tp3) || (a.side === 'LONG' ? entry + 3 * oneR : entry - 3 * oneR);
      this.state.enterSnapshot = {
        key: snapKey,
        at: Date.now(),
        side: a.side,
        symbol: inst.symbol || 'BTCUSDT',
        entry,
        stop,
        tpA,
        tpB,
        leverage: o.sizing?.recLeverage || 3,
        setupKind: o.setupKind,
      };
    }
    Promise.resolve(DeskAlerts.maybeNotifyEnter(payload))
      .catch((e) => console.warn('[RangeEmaUI] notify failed', e));
  },

  _tradeBotUrl() {
    try {
      const ls = localStorage.getItem('trade_bot_url');
      if (ls && String(ls).trim()) return String(ls).trim().replace(/\/$/, '');
    } catch (_) {}
    if (typeof DeskAlerts !== 'undefined') return DeskAlerts._botBaseUrl?.() || DeskAlerts.DEFAULT_BOT_URL;
    return 'https://precision-helmet-belfast-republic.trycloudflare.com';
  },

  _tradeSecret() {
    try { return localStorage.getItem('trade_api_secret') || ''; } catch (_) { return ''; }
  },

  async _futuresFetch(path, { method = 'GET', body = null } = {}) {
    const base = this._tradeBotUrl();
    const secret = this._tradeSecret();
    if (!secret) throw new Error('Set Trade secret in Settings (gear) first');
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-TrendRunner-Trade-Secret': secret,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  async _placeTwoLegFromSnapshot() {
    const snap = this.state.enterSnapshot;
    if (!snap || !(snap.entry > 0)) {
      this._showDeskToast('No frozen ENTER levels — wait for LIVE ENTER');
      return;
    }
    try {
      this._showDeskToast('Placing two-leg on Binance Futures…');
      const st = await this._futuresFetch('/api/trade/futures/status');
      const marginUsdt = Number(st.marginUsdt) || 25;
      const result = await this._futuresFetch('/api/trade/futures/two-leg', {
        method: 'POST',
        body: {
          symbol: snap.symbol,
          side: snap.side,
          marginUsdt,
          leverage: snap.leverage || 3,
          entry: snap.entry,
          stopPrice: snap.stop,
          tpA: snap.tpA,
          tpB: snap.tpB,
        },
      });
      this.state.lastBotTrade = { at: Date.now(), result, snap };
      if (result.ok) {
        this._showDeskToast(`Binance: opened ${snap.side} qty ${result.qty} · SL + TP A/B resting`);
      } else if (result.entry && !result.stopOrder) {
        // Market filled but algos failed — try protect endpoint once
        try {
          const fixed = await this._futuresFetch('/api/trade/futures/protect', {
            method: 'POST',
            body: {
              symbol: snap.symbol,
              side: snap.side,
              stopPrice: snap.stop,
              tpA: snap.tpA,
              tpB: snap.tpB,
              quantity: result.qty,
            },
          });
          if (fixed.ok) {
            this._showDeskToast(`Binance: entry filled — protective SL/TP attached`);
          } else {
            this._showDeskToast(fixed.error || 'Entry filled but SL missing — set stop on Binance NOW');
          }
        } catch (pe) {
          this._showDeskToast(pe.message || 'Entry filled but SL missing — set stop on Binance NOW');
        }
      } else {
        this._showDeskToast(result.error || result.warnings?.join('; ') || 'Partial — check Binance');
      }
      this.render();
    } catch (e) {
      this._showDeskToast(e.message || 'Place failed');
    }
  },

  async _refreshFuturesPositions() {
    try {
      const data = await this._futuresFetch('/api/trade/futures/positions?symbol=BTCUSDT');
      this.state.futuresStatus = data;
      const nPos = (data.positions || []).length;
      const nOrd = (data.openOrders || []).length;
      this._showDeskToast(
        nPos || nOrd
          ? `Binance: ${nPos} open position(s), ${nOrd} open order(s) — see Futures Positions`
          : 'Binance: no open BTCUSDT futures position'
      );
      this.render();
    } catch (e) {
      this._showDeskToast(e.message || 'Could not read positions');
    }
  },

  _friendlyErr(e) {
    const name = e?.name || '';
    const msg = e?.message || String(e || 'Unknown error');
    if (name === 'AbortError' || /abort/i.test(msg) || /timed?\s*out/i.test(msg)) {
      return 'Feed timed out — hard-refresh once, then tap Nifty again';
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return 'Nifty network blocked — hard-refresh (or clear site data) so the new Yahoo proxy loads';
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
      const flaky = (err) => /abort|timed?\s*out|failed to fetch|network|load failed|unreachable|not enough|empty klines|short history/i.test(String(err || ''));
      // Yahoo hops through Supabase — give Nifty more headroom than Binance
      const ceiling = inst?.feed === 'yahoo' ? 45000 : 28000;
      const retryMs = inst?.feed === 'yahoo' ? 35000 : 22000;
      let row = await withTimeout(this._buildRow(inst, c), ceiling, `${inst?.label || 'Desk'} feed`);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (gen !== this._refreshGen) return;
        if (!row?.error || !flaky(row.error)) break;
        try {
          if (typeof API !== 'undefined') {
            API.clearBinanceBan?.();
            API.clearMarketCache?.();
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 400));
        if (gen !== this._refreshGen) return;
        row = await withTimeout(
          (typeof API !== 'undefined' && API.withBypassCache)
            ? API.withBypassCache(() => this._buildRow(inst, c))
            : this._buildRow(inst, c),
          retryMs,
          `${inst?.label || 'Desk'} retry`
        );
      }
      if (gen !== this._refreshGen) return;
      // If Yahoo 5m failed, fall back to 15m once so the desk recovers
      if (row?.error && inst?.feed === 'yahoo' && this.activeTf() === '5m') {
        this.state.tf = '15m';
        try { localStorage.setItem('trendrunner_rb_tf_v2', '15m'); } catch (_) {}
        row = await withTimeout(this._buildRow(inst, c), retryMs, 'Nifty 15m fallback');
      }
      if (gen !== this._refreshGen) return;
      this.state.rows = [row];
      this.state.updatedAt = Date.now();
      this.state.error = row?.error || null;
      this._notifyIfEnter(row);
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
      ? { id: inst, symbol: inst, feed: 'binanceFutures', dayMode: c.dayMode || 'utc' }
      : (inst || this.activeInstrument());
    const tf = this.activeTf();
    const lim = this._ohlcLimit(tf, c, instrument);
    // Sagar: BTC uses 1H first-red; NG/Crude/metals use 30m (instrument.firstRedTf)
    const firstRedTf = instrument.firstRedTf || '1h';
    const firstRedBarMs = firstRedTf === '30m' ? 30 * 60000
      : firstRedTf === '15m' ? 15 * 60000
        : firstRedTf === '5m' ? 5 * 60000
          : 3600000;
    const firstRedMinBars = firstRedTf === '30m' ? 48 : 24;
    const firstRedLabel = firstRedTf === '1h' ? '1H' : firstRedTf.toUpperCase();
    const limPivot = this._ohlcLimit(firstRedTf, c, instrument);
    const lim5m = this._ohlcLimit('5m', c, instrument);
    let raw;
    let rawPivot = null;
    let raw5m = null;
    let rawFib30m = null;
    let raw1m = null;
    try {
      const get = (iv, n) => (typeof API.getDeskOHLC === 'function'
        ? API.getDeskOHLC(instrument, iv, n)
        : API.getCryptoOHLC(instrument.symbol, iv, n));
      // Parallel work-TF + first-red pivot TF + 5m (Trade 2 confirm vs median) + 30m Fib source when viewing 1h
      const mw = instrument.markWindow || c.markWindow || null;
      const mwMins = mw
        ? (((mw.endHour * 60 + (mw.endMinute || 0)) - (mw.startHour * 60 + (mw.startMinute || 0)) + 1440) % 1440) || 60
        : 60;
      const need5m = tf !== '5m';
      const needPivotFetch = tf !== firstRedTf;
      const needFib30m = tf === '1h' && mwMins < 60 && firstRedTf !== '30m';
      const need1m = (typeof FibMagnet !== 'undefined');
      const pair = await Promise.allSettled([
        get(tf, lim),
        needPivotFetch ? get(firstRedTf, limPivot) : Promise.resolve(null),
        need5m ? get('5m', lim5m) : Promise.resolve(null),
        needFib30m ? get('30m', 500) : Promise.resolve(null),
        need1m ? get('1m', 50) : Promise.resolve(null),
      ]);
      if (pair[0].status !== 'fulfilled') throw pair[0].reason;
      raw = pair[0].value;
      if (needPivotFetch) {
        if (pair[1].status === 'fulfilled') rawPivot = pair[1].value;
        else console.warn(`[RangeEmaUI] ${firstRedLabel} first-red fetch failed:`, pair[1].reason?.message || pair[1].reason);
      } else {
        rawPivot = raw;
      }
      if (need5m) {
        if (pair[2].status === 'fulfilled') raw5m = pair[2].value;
        else console.warn('[RangeEmaUI] 5m Trade-2 fetch failed:', pair[2].reason?.message || pair[2].reason);
      }
      if (needFib30m && pair[3].status === 'fulfilled') {
        rawFib30m = pair[3].value;
      } else if (tf === '1h' && firstRedTf === '30m') {
        rawFib30m = rawPivot;
      }
      if (need1m && pair[4]?.status === 'fulfilled') {
        raw1m = pair[4].value;
      }
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
        error: `Not enough ${tf} data for ${instrument.label || instrument.symbol} (${bars30.length} bars) — retrying feed…`,
        tf,
      };
    }

    const readCfg = {
      id: instrument.id,
      instrumentId: instrument.id,
      lookbackDays: c.lookbackDays || 90,
      touchPct: c.touchPct ?? 0.15,
      dayMode: instrument.dayMode || c.dayMode || 'utc',
      chartBandDays: c.chartBandDays || 7,
      bandStyle: instrument.bandStyle || c.bandStyle || 'dayHl',
      markWindow: instrument.markWindow || c.markWindow || null,
      orAnchor: instrument.orAnchor || c.orAnchor || null,
      fibLevels: instrument.fibLevels || c.fibLevels || [0, 0.44, 0.5, 0.56, 1],
      sessions: instrument.sessions || c.sessions || [],
      firstRedTf,
      firstRedLabel,
    };

    // Sagar pivot: first CLOSED red on pivot TF AFTER the calendar day’s first candle
    // (never the open bar itself). Calendar IST day — not mark-window session day.
    let firstRed1h = null;
    let bars1h = null;
    try {
      bars1h = this._klinesToBars(rawPivot);
      if (bars1h.length >= firstRedMinBars) {
        const lastT = bars30[bars30.length - 1].t;
        const calDay = RedBarTrend.dayKey(lastT, readCfg.dayMode || 'ist');
        firstRed1h = RedBarTrend.firstRedBarOfSession(bars1h, calDay, {
          ...readCfg,
          asOfTs: Date.now(),
          barMs: firstRedBarMs,
        });
      }
    } catch (e) {
      console.warn(`[RangeEmaUI] ${firstRedLabel} first-red parse failed:`, e.message || e);
    }

    const bars5m = tf === '5m' ? bars30 : this._klinesToBars(raw5m);
    const barsFib = rawFib30m ? this._klinesToBars(rawFib30m) : null;
    const readout = RedBarTrend.read(bars30, {
      ...readCfg,
      firstRed1h,
      bars1h,
      bars5m: bars5m && bars5m.length ? bars5m : null,
      barsFib: barsFib && barsFib.length ? barsFib : null,
    });
    if (readout) {
      readout.firstRed1h = firstRed1h;
      readout.firstRedTf = firstRedTf;
      readout.firstRedLabel = firstRedLabel;
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

    const bars1m = raw1m ? this._klinesToBars(raw1m) : null;
    let fibMagnet = null;
    let sessionTell = null;
    try {
      if (typeof FibMagnet !== 'undefined') {
        if (readout?.currentBand) {
          fibMagnet = FibMagnet.evaluate({
            bars: bars30,
            sessionBand: readout.currentBand,
            bars1m,
          });
        }
        sessionTell = FibMagnet.detectSessionTell({
          bars: bars30,
          sessionBand: readout?.currentBand,
          refs: readout?.refs,
        });
      }
    } catch (e) {
      console.warn('[RangeEmaUI] FibMagnet/Tell evaluate failed:', e.message || e);
    }

    const action = this._actionPlan(readout, emaAgree, instrument, fibMagnet);

    return {
      symbol: instrument.symbol,
      instrument,
      tf,
      bars: bars30,
      bars1m,
      fibMagnet,
      sessionTell,
      readout,
      ema,
      emaAgree,
      action,
    };
  },

  /** Sagar playbook → plain language + levels (fib mark + 1H first red + session clock + futures R:R). */
  _actionPlan(o, emaAgree, instrument, fibMagnet) {
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
    const frFib = o.firstRedFibs || red.fibs || null;
    const pivL = o.firstRedLabel || (this.activeInstrument()?.firstRedTf === '30m' ? '30M' : '1H');
    const pivotStep = o.firstRed1h
      ? (frFib
        ? `${pivL}→M5 ladder: mark ${pivL} first-red HIGH/LOW (liquidity) ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)} + median ${this._fmt(frFib.f50)} (Fib 44/56: ${this._fmt(frFib.f44)} / ${this._fmt(frFib.f56)}). Trade 2: sweep H/L → 5m close back through (+ median).`
        : `${pivL}→M5: mark ${pivL} first-red H/L ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)} as liquidity, then enter on 5m close-through.`)
      : `Waiting for the first ${pivL} red — mark that bar’s HIGH/LOW (liquidity) + median, then drop to 5m.`;
    const pdh = o.refs?.priorDayHigh;
    const pdl = o.refs?.priorDayLow;
    const rrStr = o.rr != null ? `1:${o.rr.toFixed(2)}` : '—';
    const stopPctStr = o.stopPct != null ? ` (${o.stopPct.toFixed(2)}%)` : '';
    const tp1Str = o.tp1 != null ? this._fmt(o.tp1) : '—';
    const tp2Str = o.tp2 != null ? this._fmt(o.tp2) : '—';
    const tp3Str = o.tp3 != null ? this._fmt(o.tp3) : '—';
    const oneRPctStr = o.stopPct != null ? ` (+${o.stopPct.toFixed(2)}%)` : '';
    const trade2Live = o.setupKind === 'trade2_confirmed' || o.setupKind === 'trade2_watch';
    const useLadder = !!(o.rrLadder || trade2Live);
    const sagarExitStep = useLadder
      ? `2️⃣ 50% TP at 1:1: ${tp1Str}${oneRPctStr} → move SL to Breakeven · 3️⃣ Trail at 1:2: ${tp2Str} · 4️⃣ Take profit at 1:3: ${tp3Str}.`
      : `2️⃣ 50% TP at 1:1: ${tp1Str}${oneRPctStr} (bank 50% & SL→BE) · 3️⃣ Runner stretch: ${this._fmt(o.bookZone)} / 1:3 ${tp3Str}.`;
    // Don't blank Trade 1 departure just because price sits inside mark Fibs.
    if (
      (o.phase === 'first_candle' || o.phase === 'inside_or')
      && o.setupKind !== 'session_sweep'
      && o.setupKind !== 'trade1_departure'
      && !trade2Live
    ) {
      const fibHi = o.currentBand?.high ?? o.refs?.orHigh;
      const fibLo = o.currentBand?.low ?? o.refs?.orLow;
      return {
        side: 'WAIT',
        cls: 'wait',
        title: o.phase === 'first_candle' ? 'Do not trade yet (Mark window forming)' : 'Inside mark-window Fibs (targets only)',
        subtitle: 'Mark-window Fibs = targets. Trade 2 = H1→M5: sweep 1H first-red H/L liquidity, then 5m close back through (+ median).',
        steps: [
          `Fib High (1) / Fib Low (0): ${this._fmt(fibHi)} / ${this._fmt(fibLo)} — context / targets only.`,
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
    const stopTag = o.invalidationReason
      || (trade2Live
        ? (biasDir === 'LONG' ? '5m swing low' : '5m swing high')
        : (biasDir === 'LONG' ? 'recent swing low' : 'recent swing high'));
    const stopWarn = o.stopStructural === false
      ? ` ⚠️ Stop is a ${stopTag} (not a tight local swing — watch size).`
      : '';

    // 1. Red Bar ENTER only: Trade 1 / Trade 2 / Session Sweep
    if (isActionable) {
      const setupLabel = o.setupKind === 'session_sweep'
        ? `Red Bar · Session Sweep · Futures ${biasDir}`
        : o.setupKind === 'trade2_confirmed'
          ? `Red Bar · Trade 2 · Futures ${biasDir} (H1 sweep → M5 close-through)`
          : `Red Bar · Trade 1 · Futures ${biasDir} (Left 1H Red)`;
      return {
        side: biasDir,
        cls: biasDir === 'LONG' ? 'long' : 'short',
        title: setupLabel,
        subtitle: `Red Bar ENTER · ${o.actionReason || (useLadder ? 'H1→M5 · SL 5m swing · 50% @ 1:1 → BE → 1:2 → 1:3' : 'SL 5m swing · 50% @ 1:1 + runner')}${emaNote}.`,
        steps: [
          `${hint}: Enter Futures ${biasDir} near ${this._fmt(o.price)}${o.setupKind === 'trade2_confirmed' ? (biasDir === 'SHORT' ? ' (1H high swept → 5m closed below high & median — sells only)' : ' (1H low swept → 5m closed above low & median — buys only)') : ''}.`,
          `1️⃣ Stop-Loss First (${stopTag}): ${this._fmt(o.invalidation)}${stopPctStr}.${stopWarn}`,
          sagarExitStep,
          pivotStep,
          ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
        ],
        entry: o.price,
        stop: o.invalidation,
        tp1: o.tp1,
        tp2: o.tp2,
        tp3: o.tp3,
        exit: o.bookZone,
        rr: o.rr,
        rrLadder: useLadder,
      };
    }

    // 2. Fib Magnet Reversion ENTER (Tweezer + 1m EMA Confirmed)
    if (fibMagnet && fibMagnet.state === 'ENTER') {
      const rrStr = fibMagnet.rr != null ? `1:${fibMagnet.rr.toFixed(2)}` : '—';
      const slPctStr = (fibMagnet.entry && fibMagnet.stop)
        ? ` (${(Math.abs(fibMagnet.entry - fibMagnet.stop) / fibMagnet.entry * 100).toFixed(2)}%)`
        : '';
      return {
        side: fibMagnet.side,
        isFibMagnet: true,
        magnetState: 'ENTER',
        cls: fibMagnet.side === 'LONG' ? 'long' : 'short',
        title: fibMagnet.title,
        subtitle: `Fib Magnet Reversion · Stretched ${fibMagnet.distPct.toFixed(2)}% · 1m EMA Confirmed ✅ · R:R ${fibMagnet.rr.toFixed(2)}`,
        steps: [
          `${hint}: Enter Futures ${fibMagnet.side} near ${this._fmt(fibMagnet.entry)} (15m Tweezer ${fibMagnet.side === 'LONG' ? 'Bottom' : 'Top'} at ${this._fmt(fibMagnet.swingExtreme)}).`,
          `1️⃣ Stop-Loss: ${this._fmt(fibMagnet.stop)}${slPctStr} (Structural swing extreme + 0.2% buffer).`,
          `2️⃣ Take Profit (Fib Magnet): ${this._fmt(fibMagnet.tp)} (Target: return to 02:30 IST Fib box).`,
          `3️⃣ Micro-Trigger: ${fibMagnet.emaCheck?.status === 'bull_stacked' || fibMagnet.emaCheck?.recentBullCross ? '1m EMA 10 crossed above EMA 20 (Bullish Confirmation ✅)' : '1m EMA 10 crossed below EMA 20 (Bearish Confirmation ✅)'}.`,
          `4️⃣ Risk/Reward: ${rrStr} · Sizing ready for Binance Futures two-leg order.`,
        ],
        entry: fibMagnet.entry,
        stop: fibMagnet.stop,
        tp1: fibMagnet.tp,
        tp2: fibMagnet.tpAlt || fibMagnet.tp,
        tp3: fibMagnet.tp,
        exit: fibMagnet.tp,
        rr: fibMagnet.rr,
        stopPct: Math.abs(fibMagnet.entry - fibMagnet.stop) / fibMagnet.entry * 100,
        invalidationReason: 'Swing extreme buffer',
        actionReason: 'Fib Magnet Reversion with 1m EMA confirmation',
      };
    }

    // 3. Fib Magnet WATCH (Tweezer formed, awaiting 1m EMA cross)
    if (fibMagnet && fibMagnet.state === 'WATCH_1M') {
      const rrStr = fibMagnet.rr != null ? `1:${fibMagnet.rr.toFixed(2)}` : '—';
      const slPctStr = (fibMagnet.entry && fibMagnet.stop)
        ? ` (${(Math.abs(fibMagnet.entry - fibMagnet.stop) / fibMagnet.entry * 100).toFixed(2)}%)`
        : '';
      return {
        side: 'WATCH',
        isFibMagnet: true,
        magnetState: 'WATCH_1M',
        cls: 'wait',
        title: fibMagnet.title,
        subtitle: `Tweezer rejection at ${this._fmt(fibMagnet.swingExtreme)} · Awaiting 1m EMA cross before ENTER.`,
        steps: [
          `15m Tweezer formed: ${fibMagnet.side} setup ready, but 1m EMA has not crossed yet.`,
          `Wait for 1m EMA 10 to cross ${fibMagnet.side === 'LONG' ? 'above' : 'below'} EMA 20 to confirm momentum flip.`,
          `Target: Fib Magnet @ ${this._fmt(fibMagnet.tp)} · Planned Stop: ${this._fmt(fibMagnet.stop)}${slPctStr}.`,
        ],
        entry: fibMagnet.entry,
        stop: fibMagnet.stop,
        tp1: fibMagnet.tp,
        tp2: fibMagnet.tpAlt || fibMagnet.tp,
        tp3: fibMagnet.tp,
        exit: fibMagnet.tp,
        rr: fibMagnet.rr,
        stopPct: Math.abs(fibMagnet.entry - fibMagnet.stop) / fibMagnet.entry * 100,
        invalidationReason: 'Swing extreme buffer',
        actionReason: 'Awaiting 1m EMA cross',
      };
    }

    // 4. Directional Bias / Watch ONLY (not an entry trigger yet — do not FOMO mid-trend)
    if (biasDir) {
      const magDown = o.playbook?.magnetBelow;
      const magUp = o.playbook?.magnetAbove;
      const magStep = (magDown || magUp)
        ? `Mark-window Fibs (targets only): ${magDown ? `↓ ${magDown.label} ${this._fmt(magDown.price)}` : ''}${magDown && magUp ? ' · ' : ''}${magUp ? `↑ ${magUp.label} ${this._fmt(magUp.price)}` : ''} — not an ENTER.`
        : null;
      const watchTitle = o.setupKind === 'trade2_watch'
        ? `Red Bar Watch · Trade 2 H1→M5 — need sweep of 1H H/L then 5m close-through (${biasDir})`
        : o.setupKind === 'fib_pullback'
          ? `Red Bar Bias: ${biasDir} · Near mark-window Fibs (targets) — not ENTER`
          : o.setupKind === 'pivot_reversal'
            ? `Bias Conflict · Crossed 1H Red vs Fibs (Stay Flat)`
            : `Red Bar Bias: ${biasDir} · Waiting Trade 1 / Trade 2 / Sweep`;
      const watchExit = useLadder
        ? `If Trade 2 prints — 1️⃣ Stop (${stopTag}): ${this._fmt(o.invalidation)}${stopPctStr} · 2️⃣ 50% @ 1:1 ${tp1Str} → SL→BE · 3️⃣ Trail 1:2 ${tp2Str} · 4️⃣ TP 1:3 ${tp3Str}.${stopWarn}`
        : `If a Red Bar trigger prints — 1️⃣ Stop (${stopTag}): ${this._fmt(o.invalidation)}${stopPctStr} · 2️⃣ 50% TP (1:1): ${tp1Str}${oneRPctStr} · 3️⃣ Runner (Stretch ${this._fmt(o.bookZone)} · ${rrStr}).${stopWarn}`;
      return {
        side: 'WATCH',
        cls: 'wait',
        title: watchTitle,
        subtitle: `${o.actionReason || 'Bias only — no Telegram until ENTER (setup + 5m swing SL)'}${emaNote}.`,
        steps: [
          `WATCH ≠ signal. Bias is ${biasDir}. ENTER + Telegram need Trade 1 / Trade 2 / sweep with SL locked to a 5m swing.`,
          ...(magStep ? [magStep] : []),
          watchExit,
          pivotStep,
          ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
        ],
        tp1: o.tp1,
        tp2: o.tp2,
        tp3: o.tp3,
        entry: o.price,
        stop: o.invalidation,
        exit: o.bookZone,
        rr: o.rr,
        rrLadder: useLadder,
      };
    }

    return {
      side: 'WAIT',
      cls: 'wait',
      title: 'No clear bias · Stay Flat',
      subtitle: 'Waiting for Trade 1 departure, Trade 2 (5m vs median), or session sweep.',
      steps: [
        'Mark-window Fibs = targets. Ladder H1→M5: mark 1H first-red HIGH/LOW + median; Trade 2 = sweep → 5m close back through.',
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
    const instBtns = this.instruments().map((x) => {
      const active = x.id === inst.id;
      const cls = `rb-inst-btn${active ? ' active' : ''}${active && loading ? ' is-loading' : ''}`;
      return `<button type="button" class="${cls}" data-rb-inst="${x.id}"${loading && active ? ' aria-busy="true"' : ''}>${x.label}${active && loading ? ' …' : ''}</button>`;
    }).join('');
    const alertsOn = this.state.alertsOn !== false;
    const alertBtn = `<button type="button" class="rb-inst-btn rb-alert-btn${alertsOn ? ' active' : ''}" id="rbAlertsToggle" title="Telegram + banner on Red Bar ENTER. Worker keeps scanning when this tab is closed." aria-pressed="${alertsOn ? 'true' : 'false'}">${alertsOn ? 'Alerts ON' : 'Alerts OFF'}</button>`;
    return instBtns + alertBtn;
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
          ${inst.label} on <strong>${tf}</strong>: Red Bar · ladder <strong>H1→M5</strong> · 1H first-red H/L liquidity + median · Trade 2 = sweep → 5m close-through · ENTER only with SL on 5m swing · 1:1→BE→1:2→1:3.
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
    document.getElementById('rbAlertsToggle')?.addEventListener('click', () => {
      this._toggleAlerts();
    });
    document.getElementById('rbPlaceTwoLeg')?.addEventListener('click', () => {
      this._placeTwoLegFromSnapshot();
    });
    document.getElementById('rbCheckBinance')?.addEventListener('click', () => {
      this._refreshFuturesPositions();
    });
    document.getElementById('rbOpenGuide')?.addEventListener('click', () => {
      document.getElementById('rbGuideModal')?.classList.add('open');
      document.body.classList.add('modal-open');
    });
    document.getElementById('closeGuideModal')?.addEventListener('click', () => {
      document.getElementById('rbGuideModal')?.classList.remove('open');
      document.body.classList.remove('modal-open');
    });
    document.getElementById('rbGuideModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'rbGuideModal') {
        document.getElementById('rbGuideModal')?.classList.remove('open');
        document.body.classList.remove('modal-open');
      }
    });
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
      this.state.chartPanOffset = 0;
      try { this._chart?.resetZoom?.(); } catch (_) {}
      const row = (this.state.rows || [])[0];
      if (row && !row.error) this._paintChart(row, this.cfg());
    });
    const panBy = (dir) => {
      const ch = this._chart;
      let panned = false;
      if (ch && typeof ch.pan === 'function') {
        const xScale = ch.scales?.x;
        const isZoomed = ch.isZoomedOrPanned ? ch.isZoomedOrPanned() : (xScale && (xScale.min > 0.5 || xScale.max < (ch.$rbBars?.length - 1.5)));
        if (isZoomed && xScale) {
          try {
            const prevMin = xScale.min;
            ch.pan({ x: dir * 80 }, undefined, 'default');
            if (Math.abs(xScale.min - prevMin) > 0.1) {
              panned = true;
            }
          } catch (_) {}
        }
      }
      if (!panned) {
        const row = (this.state.rows || [])[0];
        if (!row || !row.bars || !row.bars.length) return;
        const count = ch?.$rbBars?.length || 60;
        const shift = Math.max(10, Math.round(count * 0.25));
        const curOffset = this.state.chartPanOffset || 0;
        const maxOffset = Math.max(0, row.bars.length - count);
        let nextOffset = curOffset + (dir * shift);
        nextOffset = Math.max(0, Math.min(maxOffset, nextOffset));
        if (nextOffset !== curOffset) {
          this.state.chartPanOffset = nextOffset;
          this._paintChart(row, this.cfg());
        }
      }
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
    const ladder = !!(a.rrLadder || o.rrLadder || o.setupKind === 'trade2_confirmed' || o.setupKind === 'trade2_watch');
    const stopSub = o.stopPct != null ? `<small class="rb-level-sub">-${o.stopPct.toFixed(2)}% (${o.invalidationReason || (ladder ? '5m swing' : 'recent swing')})</small>` : '';
    const tp1Sub = o.stopPct != null ? `<small class="rb-level-sub">+${o.stopPct.toFixed(2)}% · Bank 50% &amp; SL→BE</small>` : '';
    const tp2Sub = '<small class="rb-level-sub">Trail remaining after 1:1</small>';
    const runnerSub = ladder
      ? `<small class="rb-level-sub">Full TP · 3R from swing stop</small>`
      : (a.exit != null
        ? `<small class="rb-level-sub">Stretch ${this._fmt(a.exit)} · 1:3 ${this._fmt(a.tp3 ?? o.tp3)}</small>`
        : '<small class="rb-level-sub">Runner stretch</small>');

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

    // Time & Session Computations
    const tfStr = this.activeTf() || '15m';
    const tfMins = tfStr === '5m' ? 5 : tfStr === '30m' ? 30 : tfStr === '1h' ? 60 : 15;
    const nowMs = Date.now();
    const barMs = tfMins * 60000;
    const remSec = Math.max(1, Math.ceil((barMs - (nowMs % barMs)) / 1000));
    const remM = Math.floor(remSec / 60);
    const remS = remSec % 60;
    const nextBarStr = `${remM}m ${String(remS).padStart(2, '0')}s`;

    const invDate = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const curMins = invDate.getHours() * 60 + invDate.getMinutes();
    const isMark = (curMins >= 150 && curMins < 210);
    const isAsia = (curMins >= 330 && curMins < 750);
    const isLon = (curMins >= 750 && curMins < 1110);
    const isNy = (curMins >= 1110 && curMins < 1170);
    const isLonClose = (curMins >= 1170 && curMins <= 1290);
    const isUsClose = (curMins > 1290 || curMins < 150);

    const activeSessionName = isMark ? 'Daily Mark Window (02:30–03:30 IST)'
      : isAsia ? 'Asia Session (05:30–12:30 IST)'
      : isLon ? 'London Session (12:30–18:30 IST)'
      : isNy ? 'New York Open (18:30–19:30 IST)'
      : isLonClose ? 'London Close / 4 PM Fix (19:30–21:30 IST)'
      : 'US Cash Close & CME Settle (21:30–02:30 IST)';

    // Trigger level text for Stepper
    const trigLevelStr = o.firstRed1h
      ? `1H Red ${this._fmt(o.firstRed1h.low)}–${this._fmt(o.firstRed1h.high)}`
      : o.playbook?.magnetBelow
        ? `Fib ↓ ${this._fmt(o.playbook.magnetBelow.price)}`
        : o.playbook?.magnetAbove
          ? `Fib ↑ ${this._fmt(o.playbook.magnetAbove.price)}`
          : 'Testing Equilibrium';

    // 1. Chart Wrap (TOP PRIORITY)
    const chartHtml = `
      <div class="rb-chart-wrap glass">
        <div class="rb-chart-toolbar">
          <div class="rb-chart-mode-group" role="group" aria-label="Chart style" style="display:flex;gap:4px;margin-right:8px;">
            <button type="button" class="rb-tf-btn${this.state.chartMode !== 'renko' ? ' active' : ''}" data-rb-chart-mode="candles" title="Standard Candlesticks">🕯️ Candles</button>
            <button type="button" class="rb-tf-btn${this.state.chartMode === 'renko' ? ' active' : ''}" data-rb-chart-mode="renko" title="Optional chart view only — not a Red Bar signal">🧱 Renko View</button>
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
            <button type="button" class="rb-zoom-btn" id="rbOpenGuide" style="border-color:#38bdf8;color:#38bdf8;display:inline-flex;align-items:center;gap:4px;" title="Open Desk Rules & FAQ">📖 Rules &amp; FAQ</button>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin: 0 4px 6px; padding: 6px 12px; background: rgba(15,23,42,0.55); border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); font-size: 11.5px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="display:flex; align-items:center;"><span class="rb-live-pulse-dot"></span> <strong style="color:#f8fafc;">${activeSessionName}</strong></span>
            <span style="color:#64748b;">·</span>
            <span style="color:#94a3b8;">⏱️ Candle close in ${nextBarStr}</span>
          </div>
          <div>
            ${r.sessionTell ? `<span style="font-weight:600; color:${r.sessionTell.type === 'bullish' ? '#4ade80' : r.sessionTell.type === 'bearish' ? '#f87171' : '#7dd3fc'}; font-size:11px; background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px;">${r.sessionTell.badge} (${r.sessionTell.predictedDir})</span>` : ''}
          </div>
        </div>

        <div class="rb-chart-legend">
          <span class="lg price">Candles (${this.activeTf()})</span>
          <span class="lg ema10">EMA ${c.emaFast || 10}</span>
          <span class="lg ema30">EMA ${c.emaSlow || 30}</span>
          <span class="lg band">${this._isFibStyle(r) ? `Fib 0·44·50·56·1${r.instrument?.markLabel ? ` · ${r.instrument.markLabel}` : ''}` : 'Day ranges'}</span>
          <span class="lg stop">${o.firstRedLabel || '1H'} first red H/L</span>
          <span class="lg sess-london rb-lg-desk">Session opens</span>
        </div>
        <p class="rb-zoom-hint">${this.isPhoneLayout() ? 'Pinch to zoom · ◀ ▶ to scrub · Fit resets' : 'Pinch / wheel to zoom · drag to pan · Fit resets'}</p>
        <div class="rb-chart-box">
          <canvas id="redBarChart" aria-label="Red Bar chart"></canvas>
        </div>
      </div>
    `;

    // 2. Action & Status HUD
    const isEnter = a.side === 'LONG' || a.side === 'SHORT';
    const freshMins = String(r.instrument?.id || '').toUpperCase() === 'NIFTY' ? 20 : 90;
    const snap = this.state.enterSnapshot;
    const snapAgeMin = snap?.at ? (Date.now() - snap.at) / 60000 : 0;
    const reasonStale = /stale|do not chase|window closed|already \d/i.test(String(o.actionReason || ''));
    const snapStale = snap && snapAgeMin > freshMins;
    const showEnter = isEnter && !reasonStale;
    const useSnap = showEnter && snap && snap.side === a.side && !snapStale;
    const eN = useSnap ? snap.entry : a.entry;
    const sN = useSnap ? snap.stop : a.stop;
    const tpA = useSnap ? snap.tpA : (a.tp1 ?? o.tp1);
    const tpB = useSnap ? snap.tpB : (a.tp3 ?? o.tp3 ?? a.exit ?? o.bookZone);

    let tellHtml = '';
    if (r.sessionTell) {
      const st = r.sessionTell;
      const isBull = st.type === 'bullish';
      const isBear = st.type === 'bearish';
      const tellBorder = isBull ? '#22c55e' : isBear ? '#ef4444' : '#38bdf8';
      const tellBg = isBull ? 'rgba(34,197,94,0.08)' : isBear ? 'rgba(239,68,68,0.08)' : 'rgba(56,189,248,0.08)';
      const badgeBg = isBull ? 'rgba(34,197,94,0.2)' : isBear ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.2)';
      const badgeColor = isBull ? '#4ade80' : isBear ? '#f87171' : '#7dd3fc';

      tellHtml = `
        <div class="rb-session-tell-card" style="margin: 8px 0; padding: 10px 14px; border-radius: 8px; border: 1px solid ${tellBorder}; background: ${tellBg};">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
            <div style="display:flex; align-items:center; gap: 8px;">
              <span style="font-weight:700; font-size:11.5px; padding:2px 8px; border-radius:4px; background:${badgeBg}; color:${badgeColor};">${st.badge}</span>
              <span style="font-size:11.5px; color:#94a3b8;">${st.session}</span>
            </div>
            <span style="font-size:11px; font-weight:600; color:#cbd5e1; background:rgba(255,255,255,0.07); padding:2px 6px; border-radius:4px;">🎯 ${st.confidence}</span>
          </div>
          <div style="font-size:12.5px; font-weight:600; color:#f8fafc; margin-bottom:3px;">
            Predicted Next Move: <span style="color:${badgeColor}; font-weight:700;">${st.predictedDir}</span> — ${st.headline}
          </div>
          <div style="font-size:11.5px; color:#cbd5e1; line-height:1.45;">
            ${st.detail}
          </div>
        </div>
      `;
    }

    const statusBanner = a.isFibMagnet
      ? (showEnter
          ? `<div class="rb-signal-banner enter" style="background:linear-gradient(90deg, rgba(56,189,248,0.25), rgba(34,197,94,0.25)); border:1px solid #38bdf8; color:#e0f2fe;">🧲 LIVE ENTER · Fib Magnet ${a.side} — 1m EMA Confirmed ✅ (Target: Fib ${a.side === 'LONG' ? 'f0' : 'f1'} @ ${this._fmt(a.tp1)})</div>`
          : `<div class="rb-signal-banner watch" style="background:rgba(234,179,8,0.18); border:1px solid #eab308; color:#fef08a;">🧲 WATCH · Fib Magnet Tweezer formed — awaiting 1m EMA cross before ENTER</div>`)
      : (showEnter
        ? `<div class="rb-signal-banner enter">LIVE ENTER · ${a.side} — fresh window (~${freshMins}m). Levels ${useSnap ? 'frozen at first alert' : 'live'}.</div>`
        : (isEnter || reasonStale || snapStale)
          ? `<div class="rb-signal-banner watch">STALE — ENTER already fired; do <em>not</em> chase. ${o.actionReason ? String(o.actionReason).replace(/[<>&]/g, '') : 'Wait for the next Trade 1 / 2 / sweep.'}</div>`
        : a.side === 'WATCH'
          ? `<div class="rb-signal-banner watch">👀 WATCHING (Setup Developing) — Bias is ${trendWord}; waiting for confirmed trigger. Do NOT enter yet.</div>`
          : `<div class="rb-signal-banner wait">⏳ WAITING (Market in Equilibrium) — No active entry setup. Stay in cash.</div>`);

    const pos = this.state.futuresStatus;
    const posAmt = pos?.positions?.[0] ? Math.abs(parseFloat(pos.positions[0].positionAmt) || 0) : 0;
    const posLine = pos
      ? (posAmt > 0
        ? `<div class="rb-binance-status on">Binance: position open (${posAmt} BTC) · ${(pos.openOrders || []).length} resting order(s)</div>`
        : `<div class="rb-binance-status">Binance: no open BTCUSDT position right now</div>`)
      : '';

    let actionContentHtml = '';
    if (showEnter) {
      const botBtns = `
        <div class="rb-bot-actions">
          <button type="button" class="rb-inst-btn active" id="rbPlaceTwoLeg">Place two-leg on Binance</button>
          <button type="button" class="rb-inst-btn" id="rbCheckBinance">Check Binance positions</button>
          <a class="rb-inst-btn" href="https://www.binance.com/en/futures/BTCUSDT" target="_blank" rel="noopener">Open Binance Futures ↗</a>
        </div>
        <p class="rb-manage-plan-note">Notification = alert that ENTER fired (PWA banner and/or Telegram). It does <em>not</em> mean an order is filled unless auto-trade is on or you pressed Place.</p>`;

      actionContentHtml = `
        ${statusBanner}
        ${tellHtml}
        ${posLine}
        <div class="rb-manage-plan">
          <div class="rb-manage-plan-title">One ENTER · set-and-forget two legs</div>
          <p class="rb-manage-plan-note">${useSnap ? 'Frozen at first ENTER (ignores later level drift).' : 'Same entry + stop. Leg A books 50% @ 1:1 · Leg B runner @ 1:3.'}</p>
          <div class="rb-action-levels">
            <div><span>Entry</span><strong>${this._fmt(eN)}</strong><small class="rb-level-sub">${useSnap ? 'Frozen' : (ladder ? 'H1→M5' : 'Live')}</small></div>
            <div><span>Stop (both legs)</span><strong class="neg-text">${this._fmt(sN)}</strong>${stopSub}</div>
            <div><span>TP A · 50% @ 1:1</span><strong class="pos-text">${this._fmt(tpA)}</strong>${tp1Sub}</div>
            <div><span>TP B · 50% @ 1:3</span><strong class="pos-text">${this._fmt(tpB)}</strong>${runnerSub}</div>
          </div>
          ${botBtns}
        </div>
        ${futuresBarHtml}
      `;
    } else {
      // Compact Stepper for WATCH / WAIT
      actionContentHtml = `
        ${statusBanner}
        ${tellHtml}
        <div class="rb-stepper-wrap">
          <div class="rb-stepper">
            <div class="rb-step done">
              <div class="rb-step-icon">✓</div>
              <div class="rb-step-body">
                <div class="rb-step-name">1. Direction Bias</div>
                <div class="rb-step-val ${trendCls}">${trendWord}</div>
              </div>
            </div>
            <div class="rb-step active">
              <div class="rb-step-icon">⚡</div>
              <div class="rb-step-body">
                <div class="rb-step-name">2. Target Level</div>
                <div class="rb-step-val">${trigLevelStr}</div>
              </div>
            </div>
            <div class="rb-step pending">
              <div class="rb-step-icon">⏳</div>
              <div class="rb-step-body">
                <div class="rb-step-name">3. Candle Confirm</div>
                <div class="rb-step-val">Waiting 5m Close</div>
              </div>
            </div>
            <div class="rb-step pending">
              <div class="rb-step-icon">🎯</div>
              <div class="rb-step-body">
                <div class="rb-step-name">4. Two-Leg Execution</div>
                <div class="rb-step-val">1:1 BE → 1:3 Runner</div>
              </div>
            </div>
          </div>
        </div>
        <details style="margin-top:4px;">
          <summary style="font-size:11px; color:#64748b; cursor:pointer; padding:2px 0;">Inspect Setup Steps &amp; Levels ▼</summary>
          <div style="font-size:11.5px; color:#94a3b8; padding:6px 0;">
            <ul class="rb-action-steps" style="margin:4px 0 0;">${steps}</ul>
          </div>
        </details>
      `;
    }

    // 3. 24-Hour Session Timeline Card
    const timelineHtml = `
      <div class="rb-session-timeline-card">
        <div class="rb-timeline-header">
          <span style="font-weight:600; color:#cbd5e1;">🕒 24H Global Liquidity Rhythm</span>
          <span><span class="rb-live-pulse-dot"></span> Active: <strong style="color:#f8fafc;">${activeSessionName}</strong></span>
        </div>
        <div class="rb-timeline-track">
          <div class="rb-session-seg ${isMark ? 'active' : ''}">
            <span class="seg-time">02:30</span>
            <span class="seg-name">Mark</span>
          </div>
          <div class="rb-session-seg ${isAsia ? 'active' : ''}">
            <span class="seg-time">05:30</span>
            <span class="seg-name">Asia</span>
          </div>
          <div class="rb-session-seg ${isLon ? 'active' : ''}">
            <span class="seg-time">12:30</span>
            <span class="seg-name">London</span>
          </div>
          <div class="rb-session-seg ${isNy ? 'active' : ''}">
            <span class="seg-time">18:30</span>
            <span class="seg-name">NY Open</span>
          </div>
          <div class="rb-session-seg ${isLonClose ? 'active' : ''}">
            <span class="seg-time">19:30</span>
            <span class="seg-name">Lon Close</span>
          </div>
          <div class="rb-session-seg ${isUsClose ? 'active' : ''}">
            <span class="seg-time">01:30</span>
            <span class="seg-name">US Close</span>
          </div>
        </div>
      </div>
    `;

    // 4. Key Levels Matrix (3-Column clean grid)
    const levelsMatrixHtml = `
      <div class="rb-levels-matrix">
        <div class="rb-levels-col">
          <div class="col-title">📌 Session Extremes</div>
          <div class="level-row"><span>Asia H/L:</span> <strong>${this._fmt(o.refs?.asiaHigh)} / ${this._fmt(o.refs?.asiaLow)}</strong></div>
          <div class="level-row"><span>London H/L:</span> <strong>${this._fmt(o.refs?.londonHigh)} / ${this._fmt(o.refs?.londonLow)}</strong></div>
          <div class="level-row"><span>NY H/L:</span> <strong>${this._fmt(o.refs?.nyHigh)} / ${this._fmt(o.refs?.nyLow)}</strong></div>
        </div>
        <div class="rb-levels-col">
          <div class="col-title">🧲 Equilibrium Anchors</div>
          <div class="level-row"><span>02:30 Mark Fib:</span> <strong>${this._fmt(o.currentBand?.high)} / ${this._fmt(o.currentBand?.low)}</strong></div>
          <div class="level-row"><span>1H First Red:</span> <strong>${this._fmt(o.firstRed1h?.high)} / ${this._fmt(o.firstRed1h?.low)}</strong></div>
          <div class="level-row"><span>Dr. Dev CPR:</span> <strong>${this._fmt((o.cpr || o.playbook?.cpr)?.pivot)}</strong></div>
        </div>
        <div class="rb-levels-col">
          <div class="col-title">🎯 Macro Targets &amp; Swings</div>
          <div class="level-row"><span>Prior Day (PDH/PDL):</span> <strong>${this._fmt(o.refs?.priorDayHigh)} / ${this._fmt(o.refs?.priorDayLow)}</strong></div>
          <div class="level-row"><span>5m Swing H/L:</span> <strong>${this._fmt(o.refs?.prevSwingHigh)} / ${this._fmt(o.refs?.prevSwingLow)}</strong></div>
          <div class="level-row"><span>EMA 10 / 30:</span> <strong>${r.emaAgree || 'Agree'}</strong></div>
        </div>
      </div>
    `;

    return `
      ${chartHtml}
      <div class="rb-action ${a.cls}" style="margin: 8px 0;">
        ${actionContentHtml}
      </div>
      ${timelineHtml}
      ${levelsMatrixHtml}
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
        // Session opens (solid + label) and closes (thin dashed)
        const list = markers;
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
        const area = chart.chartArea;
        if (!xScale || !yScale || !area) return;
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

        // Fib Magnet Reversion candle badge
        if (chart.$rbFibMagnet && chart.$rbFibMagnet.state === 'ENTER' && chart.$rbTimes && chart.$rbTimes.length) {
          const fm = chart.$rbFibMagnet;
          let matchIdx = -1;
          if (fm.candleTime) {
            matchIdx = chart.$rbTimes.findIndex((t) => Math.abs(t - fm.candleTime) < 30000);
          }
          const targetIdx = matchIdx >= 0 ? matchIdx : n - 1;
          const pxX = xScale.getPixelForValue(targetIdx);
          const isBuy = fm.side === 'LONG';
          const targetBar = bars[targetIdx] || bars[n - 1];
          if (targetBar && Number.isFinite(pxX)) {
            const yEdge = isBuy ? yScale.getPixelForValue(targetBar.l) : yScale.getPixelForValue(targetBar.h);
            if (Number.isFinite(yEdge)) {
              const badgeY = isBuy ? Math.min(area.bottom - 12, yEdge + 18) : Math.max(area.top + 12, yEdge - 18);
              ctx.save();
              ctx.font = 'bold 9px Outfit, system-ui, sans-serif';
              const text = isBuy ? '🧲 MAGNET BUY' : '🧲 MAGNET SELL';
              const tw = ctx.measureText(text).width;
              ctx.fillStyle = isBuy ? 'rgba(34, 197, 94, 0.95)' : 'rgba(239, 68, 68, 0.95)';
              ctx.beginPath();
              if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(pxX - tw / 2 - 5, badgeY - 8, tw + 10, 16, 3);
              } else {
                ctx.rect(pxX - tw / 2 - 5, badgeY - 8, tw + 10, 16);
              }
              ctx.fill();
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(text, pxX, badgeY);
              ctx.restore();
            }
          }
        }

        // Session Tell Badge (Liquidity Sweeps & Session Tells)
        if (chart.$rbSessionTell && chart.$rbSessionTell.badge && chart.$rbTimes && chart.$rbTimes.length) {
          const st = chart.$rbSessionTell;
          if (st.id && (st.id.includes('sweep') || st.id.includes('magnet') || st.id.includes('pump') || st.id.includes('dump'))) {
            let matchIdx = -1;
            if (st.candleTime) {
              matchIdx = chart.$rbTimes.findIndex((t) => Math.abs(t - st.candleTime) < 30000);
            }
            const targetIdx = matchIdx >= 0 ? matchIdx : n - 1;
            const pxX = xScale.getPixelForValue(targetIdx);
            const isBull = st.type === 'bullish';
            const isBear = st.type === 'bearish';
            const targetBar = bars[targetIdx] || bars[n - 1];
            if (targetBar && Number.isFinite(pxX)) {
              const yEdge = isBull ? yScale.getPixelForValue(targetBar.l) : yScale.getPixelForValue(targetBar.h);
              if (Number.isFinite(yEdge)) {
                const yOff = (chart.$rbFibMagnet && chart.$rbFibMagnet.state === 'ENTER') ? 34 : 18;
                const badgeY = isBull ? Math.min(area.bottom - 12, yEdge + yOff) : Math.max(area.top + 12, yEdge - yOff);
                ctx.save();
                ctx.font = 'bold 9px Outfit, system-ui, sans-serif';
                const text = st.badge;
                const tw = ctx.measureText(text).width;
                ctx.fillStyle = isBull ? 'rgba(16, 185, 129, 0.95)' : isBear ? 'rgba(239, 68, 68, 0.95)' : 'rgba(14, 165, 233, 0.95)';
                ctx.beginPath();
                if (typeof ctx.roundRect === 'function') {
                  ctx.roundRect(pxX - tw / 2 - 5, badgeY - 8, tw + 10, 16, 3);
                } else {
                  ctx.rect(pxX - tw / 2 - 5, badgeY - 8, tw + 10, 16);
                }
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, pxX, badgeY);
                ctx.restore();
              }
            }
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
        const barStep = (lastIdx != null && lastIdx > 0)
          ? Math.abs(xScale.getPixelForValue(1) - xScale.getPixelForValue(0))
          : 10;
        const padX = Number.isFinite(barStep) ? Math.max(3, Math.min(10, barStep * 0.42)) : 4;

        ctx.save();
        for (let i = 0; i < n; i++) {
          const b = bands[i];
          if (b.high == null || b.low == null || b.i0 == null) continue;
          const i1 = b.i1 != null
            ? b.i1
            : (bands[i + 1]?.i0 != null ? bands[i + 1].i0 : lastIdx);
          if (i1 == null) continue;

          let x0 = xScale.getPixelForValue(b.i0);
          let x1 = (i === n - 1 && lastIdx != null && i1 >= lastIdx)
            ? area.right
            : xScale.getPixelForValue(i1);
          if (![x0, x1].every(Number.isFinite)) continue;
          if (b.iMarkStart != null) x0 -= padX;
          if (i < n - 1 && bands[i + 1]?.iMarkStart != null) x1 -= padX;
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
            ctx.setLineDash(b.locked === false ? [4, 4] : []);
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
            ctx.setLineDash([]);
            // Bracket the anchor mark-window candle(s) (02:30–03:30 IST) at the left edge
            // so you can see the exact candle(s) whose High & Low wicks define the Fib box.
            if (b.iMarkEnd != null && b.iMarkStart != null && b.iMarkEnd >= b.iMarkStart) {
              const xm0 = Math.max(area.left, xScale.getPixelForValue(b.iMarkStart) - padX);
              const xm1 = Math.min(area.right, xScale.getPixelForValue(b.iMarkEnd) + padX);
              const yHi = yScale.getPixelForValue(b.f1 ?? b.high);
              const yLo = yScale.getPixelForValue(b.f0 ?? b.low);
              if ([xm0, xm1, yHi, yLo].every(Number.isFinite) && xm1 > xm0) {
                const topY = Math.min(yHi, yLo);
                const boxH = Math.max(2, Math.abs(yLo - yHi));
                const boxW = Math.max(6, xm1 - xm0);
                ctx.save();
                ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
                ctx.lineWidth = 1.4;
                ctx.setLineDash([3, 2]);
                ctx.strokeRect(xm0, topY, boxW, boxH);
                ctx.restore();
              }
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

  /** Clean 1H first-red High & Low lines only (anchored from that 1H red bar forward; no 44/MED/56 clutter). */
  _firstRed1hPlugin() {
    return {
      id: 'rbFirstRed1h',
      afterDatasetsDraw(chart) {
        if (chart.$rbShowFirstRed === false) return;
        const red = chart.$rbFirstRed1h;
        if (!red || red.high == null) return;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;

        let x0 = area.left;
        const times = chart.$rbTimes;
        if (xScale && Array.isArray(times) && times.length && red.t != null) {
          if (red.t > times[0]) {
            const firstIdx = times.findIndex((t) => t >= red.t - 1000);
            if (firstIdx >= 0) {
              const px = xScale.getPixelForValue(firstIdx);
              if (Number.isFinite(px)) x0 = Math.max(area.left, px);
            }
          }
        }
        if (x0 >= area.right) return;

        const levels = [
          { v: red.high, style: 'rgba(244, 63, 94, 0.85)', w: 1.4, dash: [6, 4] },
          { v: red.low, style: 'rgba(244, 63, 94, 0.55)', w: 1.2, dash: [4, 4] },
        ];
        const ctx = chart.ctx;
        ctx.save();
        for (const lv of levels) {
          if (lv.v == null || !Number.isFinite(lv.v)) continue;
          const y = yScale.getPixelForValue(lv.v);
          if (!Number.isFinite(y) || y < area.top || y > area.bottom) continue;
          ctx.strokeStyle = lv.style;
          ctx.lineWidth = lv.w;
          ctx.setLineDash(lv.dash);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(area.right, y);
          ctx.stroke();
        }
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
            ? ({ STOP: 'STP', '1:1 TP': '1:1', '1:2': '1:2', '1:3 TP': '1:3', EXIT: 'TP', '1H RED': '1R', MED: 'Med', '5m HI': '5↑', '5m LO': '5↓', 'SWG HI': 'SwH', 'SWG LO': 'SwL', PDH: 'PDH', PDL: 'PDL', 'ASIA HI': 'A↑', 'ASIA LO': 'A↓', 'LON HI': 'L↑', 'LON LO': 'L↓', 'NY HI': 'NY↑', 'NY LO': 'NY↓', R: 'R', S: 'S' }[t.name] || t.name)
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
    // Generous context on phones; ◀ ▶ buttons and pinch allow smooth scrub
    const wantDesktop = (c.chartBars && c.chartBars[tf]) || 120;
    const wantMobile = (c.chartBarsMobile && c.chartBarsMobile[tf])
      || ({ '5m': 140, '15m': 120, '30m': 100, '1h': 84 }[tf] || 100);
    const want = compact ? wantMobile : wantDesktop;
    const o = row.readout;
    const isRenkoMode = this.state.chartMode === 'renko';
    let bars;
    let emaF;
    let emaS;
    let visStart = 0;

    const panOffset = Math.max(0, this.state.chartPanOffset || 0);

    // Renko View is chart-only (not a strategy); brick size still used as spike ruler in entryGate
    if (isRenkoMode && typeof RedBarTrend !== 'undefined' && RedBarTrend.buildRenkoSeries) {
      const bSize = o.renko?.brickSize || (row.bars[row.bars.length - 1].c * 0.0018);
      const allBricks = RedBarTrend.buildRenkoSeries(row.bars, bSize);
      const showN = Math.min(want, Math.max(1, allBricks.length));
      const endIdx = Math.max(showN, allBricks.length - panOffset);
      const startIdx = Math.max(0, endIdx - showN);
      visStart = startIdx;
      const renkoSlice = allBricks.length ? allBricks.slice(startIdx, endIdx) : [];
      if (!renkoSlice.length) {
        // Fall back to candles if no bricks printed yet
        const eIdx = Math.max(want, row.bars.length - panOffset);
        const sIdx = Math.max(0, eIdx - want);
        visStart = sIdx;
        bars = row.bars.slice(sIdx, eIdx);
        emaF = (row.ema.emaF || []).slice(sIdx, eIdx);
        emaS = (row.ema.emaS || []).slice(sIdx, eIdx);
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
        emaF = fullEmaF.slice(startIdx, endIdx);
        emaS = fullEmaS.slice(startIdx, endIdx);
      }
    } else {
      const showN = Math.min(want, row.bars.length);
      const endIdx = Math.max(showN, row.bars.length - panOffset);
      const startIdx = Math.max(0, endIdx - showN);
      visStart = startIdx;
      bars = row.bars.slice(startIdx, endIdx);
      emaF = (row.ema.emaF || []).slice(startIdx, endIdx);
      emaS = (row.ema.emaS || []).slice(startIdx, endIdx);
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
      if (!isRenkoMode && b.index != null && b.index >= 0) {
        // index is absolute in full series; map into visible window
        const abs = b.index;
        const local = abs - visStart;
        if (local >= 0 && local < bars.length) return local;
      }
      const targetT = b.t0 != null ? b.t0 : b.openT;
      if (targetT != null && times.length) {
        if (targetT <= times[0]) return 0;
        const idx = this._nearestBarIndex(times, targetT);
        if (idx >= 0) return idx;
        const firstAfter = times.findIndex((t) => t >= targetT - 1000);
        if (firstAfter >= 0) return firstAfter;
      }
      const span = daySpans.get(b.day);
      return span ? span.i0 : null;
    };
    const resolveMarkEndIndex = (b, i0) => {
      if (!isRenkoMode && b.i1Mark != null && b.i1Mark >= 0) {
        const local = b.i1Mark - visStart;
        if (local >= 0 && local < bars.length) return Math.max(i0, local);
      }
      const endT = b.endT != null ? b.endT : b.openT;
      if (endT != null && times.length) {
        if (endT < times[0]) return null;
        const idx = this._nearestBarIndex(times, endT);
        if (idx >= 0) return Math.max(i0, idx);
      }
      return null;
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
      const nextDay = sortedBandDays[bi + 1];
      const nextB = nextDay ? byDay.get(nextDay) : null;
      const nextStartT = nextB ? (nextB.t0 ?? nextB.openT) : null;
      if (nextStartT != null && times.length && nextStartT <= times[0]) {
        // Entire band finished before the visible chart window starts
        return null;
      }
      const i0 = resolveBandIndex(b);
      if (i0 == null) return null;
      let i1 = bars.length - 1;
      if (nextB) {
        const n0 = resolveBandIndex(nextB);
        if (n0 != null && n0 > i0) i1 = n0;
      }
      const startT = b.t0 ?? b.openT;
      const iMarkStart = (startT != null && times.length && startT < times[0]) ? null : i0;
      const iMarkEnd = iMarkStart != null ? resolveMarkEndIndex(b, iMarkStart) : null;
      return { ...b, i0, i1, iMarkStart, iMarkEnd };
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
    // Show 1H first-red H/L + Fib 44/50/56 whenever the day's pivot is marked
    const showPivot = !!(o.firstRed1h?.high != null
      && (redId === 'trade2_revisit' || redId === 'at_pivot' || redId === 'trade1_away' || redId === 'marked'));

    // Time-of-day & state-aware Y-axis tags (max 3 tags so the right axis stays clean):
    // 1) When an actionable trade is live (LONG/SHORT), show ONLY the trade's STOP, 1:1 TP, and EXIT.
    // 2) When in WATCH/WAIT, show ONLY the levels relevant to the current session clock & bias:
    //    - Stop-side swing (5m for Trade 2; else working-TF SWG LO/HI)
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

    if (action.isFibMagnet && (action.side === 'LONG' || action.side === 'SHORT')) {
      pushTag('🧲 SL', action.stop, COL.stop, 'rgba(60, 10, 10, 0.94)', { priority: true });
      pushTag('🧲 FIB TP', action.tp1, '#38bdf8', 'rgba(8, 47, 73, 0.94)', { priority: true });
    } else if (trading) {
      pushTag('STOP', stopPx, COL.stop, 'rgba(60, 10, 10, 0.94)', { priority: true });
      const tp1Px = action.tp1 ?? o.tp1;
      if (tp1Px != null) {
        pushTag('1:1 TP', tp1Px, '#38bdf8', 'rgba(8, 47, 73, 0.94)', { priority: true });
      }
      const useLadderTags = !!(action.rrLadder || o.rrLadder || o.setupKind === 'trade2_confirmed');
      if (useLadderTags) {
        const tp2Px = action.tp2 ?? o.tp2;
        const tp3Px = action.tp3 ?? o.tp3;
        if (tp2Px != null) pushTag('1:2', tp2Px, '#a78bfa', 'rgba(40, 20, 70, 0.92)', { rank: 2 });
        if (tp3Px != null) pushTag('1:3 TP', tp3Px, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
      } else if (action.side === 'LONG' && ahead(exitPx, 'above')) {
        pushTag('EXIT', exitPx, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
      } else if (action.side === 'SHORT' && ahead(exitPx, 'below')) {
        pushTag('EXIT', exitPx, COL.exit, 'rgba(10, 40, 20, 0.94)', { priority: true });
      }
    } else {
      const clockId = o.playbook?.clock?.id || 'pre_london';
      // 1. Always show the relevant 15m swing stop side (or 1H RED when at/revisiting pivot)
      if (showPivot && o.firstRed1h?.high != null) {
        pushTag(`${o.firstRedLabel || '1H'} RED`, o.firstRed1h.high, '#f43f5e', 'rgba(60, 10, 20, 0.94)', { priority: true });
      } else if (o.trend === 'bullish') {
        pushTag(o.refs?.swingStopTf === '5m' ? '5m LO' : 'SWG LO', o.refs?.prevSwingLow, '#fb923c', 'rgba(55, 28, 10, 0.88)', { priority: true });
      } else if (o.trend === 'bearish') {
        pushTag(o.refs?.swingStopTf === '5m' ? '5m HI' : 'SWG HI', o.refs?.prevSwingHigh, '#fb923c', 'rgba(55, 28, 10, 0.88)', { priority: true });
      } else {
        pickNearer(
          o.refs?.swingStopTf === '5m' ? '5m HI' : 'SWG HI',
          o.refs?.prevSwingHigh,
          o.refs?.swingStopTf === '5m' ? '5m LO' : 'SWG LO',
          o.refs?.prevSwingLow,
          '#fb923c',
          'rgba(55, 28, 10, 0.88)',
        );
      }

      // 2. Session-specific liquidity pool for the current clock window (rank 2 = hunted pool, rank 3 = PDH/PDL)
      if (clockId === 'pre_london') {
        if (o.firstRed1h?.high != null) {
          pushTag(`${o.firstRedLabel || '1H'} RED`, o.firstRed1h.high, '#f43f5e', 'rgba(60, 10, 20, 0.94)', { rank: 2 });
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
              enabled: true,
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
    this._chart.$rbFirstRedFibs = o.firstRedFibs || o.playbook?.redSetup?.fibs || null;
    this._chart.$rbShowFirstRed = showPivot;
    this._chart.$rbLevelTags = levelTags;
    this._chart.$rbCompact = compact;
    this._chart.$rbUI = this;
    this._chart.$rbFibMagnet = row.fibMagnet || null;
    this._chart.$rbSessionTell = row.sessionTell || null;
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
