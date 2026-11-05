'use strict';

/**
 * Red Bar Desk — visual trader sheet.
 * Engine mechanics: Dr. Devendra Pratap Singh (Red Bar DNA, POB 44–56, Setup 3 Rubber Band, Trikal 12:45).
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
    const actionable = o?.actionState === 'enter' && !a?.isFibMagnet && isEnter;

    // Trend alignment guard: do not alert counter-trend entries against stacked EMAs
    // (matches bot.js execution filter so UI and Telegram alerts stay in 100% sync)
    const emaFast = row.ema?.emaFast;
    const emaSlow = row.ema?.emaSlow;
    const isCounterTrend = (a?.side === 'SHORT' && emaFast != null && emaSlow != null && emaFast > emaSlow)
      || (a?.side === 'LONG' && emaFast != null && emaSlow != null && emaFast < emaSlow)
      || row.emaAgree === 'disagrees';
    if (isCounterTrend) {
      this._pendingEnterAlert = null;
      console.log(`[DeskAlerts] Blocked counter-trend ${a?.side} alert for ${inst.id || inst.symbol} (EMA disagrees)`);
      return;
    }

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
      setupKind: o?.setupKind || 'enter',
      title: a?.title || o?.setupKind,
      price: fmt(a?.entry ?? o?.price),
      stop: fmt(a?.stop ?? o?.invalidation),
      tp1: fmt(a?.tp1 ?? o?.tp1),
      dayKey: o?.asOfDay || '',
      triggerTs: o?.triggerTs || o?.playbook?.redSetup?.triggerTs || o?.t || Date.now(),
      queuedAt: Date.now(),
      emaFast,
      emaSlow,
    };
    this._pendingEnterAlert = payload;
    // Freeze levels for place/bot — live refresh was changing Entry/SL/TP mid-signal
    const freshMins = (String(inst.id || '').toUpperCase() === 'NIFTY' || payload.setupKind === 'pob_reject') ? 20 : 90;
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
    return 'https://real-follows-wav-seal.trycloudflare.com';
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
    // Sagar: NIFTY uses 15m first-red (locks morning Red Bar box by 09:45 IST); NG/Crude/metals use 30m; BTC uses 1H
    const instUpperId = String(instrument.id || '').toUpperCase();
    let firstRedTf = instrument.firstRedTf !== undefined
      ? instrument.firstRedTf
      : (instUpperId === 'NIFTY' ? '15m' : (instUpperId === 'BTC' ? null : '1h'));
    const firstRedBarMs = firstRedTf === '30m' ? 30 * 60000
      : firstRedTf === '15m' ? 15 * 60000
        : firstRedTf === '5m' ? 5 * 60000
          : 3600000;
    const firstRedMinBars = firstRedTf === '30m' ? 48 : 24;
    let firstRedLabel = !firstRedTf ? '' : (firstRedTf === '1h' ? '1H' : firstRedTf.toUpperCase());
    const limPivot = firstRedTf ? this._ohlcLimit(firstRedTf, c, instrument) : 0;
    const lim5m = this._ohlcLimit('5m', c, instrument);
    let raw;
    let rawPivot = null;
    let raw5m = null;
    let rawFib30m = null;
    let raw1m = null;
    let deskMeta = null;
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
      const needPivotFetch = !!firstRedTf && tf !== firstRedTf;
      const needFib30m = tf === '1h' && mwMins < 60 && firstRedTf !== '30m';
      const need1m = (typeof FibMagnet !== 'undefined');
      const workTf = c.workingTf || '15m';
      const needWorkTf = tf !== workTf;
      const pair = await Promise.allSettled([
        get(tf, lim),
        needPivotFetch ? get(firstRedTf, limPivot) : Promise.resolve(null),
        need5m ? get('5m', lim5m) : Promise.resolve(null),
        needFib30m ? get('30m', 500) : Promise.resolve(null),
        need1m ? get('1m', 50) : Promise.resolve(null),
        needWorkTf ? get(workTf, 500) : Promise.resolve(null),
      ]);
      if (pair[0].status !== 'fulfilled') throw pair[0].reason;
      raw = pair[0].value;
      deskMeta = (raw && raw.__deskMeta) || null;
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
      var rawWork = needWorkTf && pair[5]?.status === 'fulfilled' ? pair[5].value : null;
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
    const nowTs = Date.now();
    let firstRed1h = null;
    let bars1h = null;
    const barsWork = rawWork ? this._klinesToBars(rawWork) : bars30;
    const evalBars = (barsWork && barsWork.length >= 40) ? barsWork : bars30;
    const bars5m = tf === '5m' ? bars30 : this._klinesToBars(raw5m);
    if (firstRedTf) {
      try {
        bars1h = this._klinesToBars(rawPivot);
        const lastT = evalBars[evalBars.length - 1].t;
        const calDay = RedBarTrend.dayKey(lastT, readCfg.dayMode || 'ist');
        if (bars1h.length >= firstRedMinBars) {
          firstRed1h = RedBarTrend.firstRedBarOfSession(bars1h, calDay, {
            ...readCfg,
            asOfTs: nowTs,
            barMs: firstRedBarMs,
          });
        }
        // Fallback: if primary TF (e.g. 1H or 30m) has no closed Red Bar yet on a strong morning trend,
        // fall back to 15m working bars (or 5m on NSE) so you don't miss Trade 1 / Trade 2
        if (!firstRed1h && evalBars && evalBars.length >= 24 && firstRedTf !== '15m') {
          const fb15 = RedBarTrend.firstRedBarOfSession(evalBars, calDay, {
            ...readCfg,
            asOfTs: nowTs,
            barMs: 15 * 60000,
          });
          if (fb15) {
            firstRed1h = fb15;
            firstRedTf = '15m';
            firstRedLabel = '15M';
            readCfg.firstRedTf = '15m';
            readCfg.firstRedLabel = '15M';
          }
        }
        if (!firstRed1h && instUpperId === 'NIFTY' && bars5m && bars5m.length >= 24) {
          const fb5 = RedBarTrend.firstRedBarOfSession(bars5m, calDay, {
            ...readCfg,
            asOfTs: nowTs,
            barMs: 5 * 60000,
          });
          if (fb5) {
            firstRed1h = fb5;
            firstRedTf = '5m';
            firstRedLabel = '5M';
            readCfg.firstRedTf = '5m';
            readCfg.firstRedLabel = '5M';
          }
        }
      } catch (e) {
        console.warn(`[RangeEmaUI] ${firstRedLabel} first-red parse failed:`, e.message || e);
      }
    }

    const barsFib = rawFib30m ? this._klinesToBars(rawFib30m) : null;
    const readout = RedBarTrend.read(evalBars, {
      ...readCfg,
      asOfTs: nowTs,
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
          instrumentId: instrument.id,
        });
      }
    } catch (e) {
      console.warn('[RangeEmaUI] FibMagnet/Tell evaluate failed:', e.message || e);
    }

    const action = this._actionPlan(readout, emaAgree, instrument, fibMagnet);
    // Yahoo fallback for MCX INR (e.g. NG) must not keep ₹ / MCX scale labeling.
    const feedCurrency = deskMeta?.currency || instrument.currency || null;
    const feedWarning = deskMeta?.warning || null;
    const feedSource = deskMeta?.feedSource || instrument.feed || null;
    const feedPriceDecimals = deskMeta?.priceDecimals != null
      ? deskMeta.priceDecimals
      : instrument.priceDecimals;

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
      feedCurrency,
      feedWarning,
      feedSource,
      feedPriceDecimals,
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
    const pobInfo = frFib?.pob || null;
    const pobStr = pobInfo
      ? `POB (Point of Balance 44–56: ${this._fmt(pobInfo.low)}–${this._fmt(pobInfo.high)}, Fair Value ${this._fmt(pobInfo.mid)})`
      : (frFib ? `POB 44–56 (${this._fmt(frFib.f44)}–${this._fmt(frFib.f56)})` : '');
    const xTrapStr = o.isXCandleTrap ? ' ⚠️ Candle 1 is the "X Candle" (retail trap) — wait for POB retest or 1H sweep.' : '';
    const pivotStep = o.firstRed1h
      ? (frFib
        ? `${pivL}→M5 ladder: mark ${pivL} first-red HIGH/LOW (liquidity) ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)} + ${pobStr}.${xTrapStr} Trade 2: sweep H/L → 5m close back through (+ median).`
        : `${pivL}→M5: mark ${pivL} first-red H/L ${this._fmt(o.firstRed1h.high)} / ${this._fmt(o.firstRed1h.low)} as liquidity, then enter on 5m close-through.`)
      : `Waiting for the first ${pivL} red — mark that bar’s HIGH/LOW (liquidity) + POB (44–56), then drop to 5m.`;
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
    // Don't blank Trade 1 / POB / Setup 3 overlays just because price sits inside mark Fibs.
    if (
      (o.phase === 'first_candle' || o.phase === 'inside_or')
      && o.setupKind !== 'session_sweep'
      && o.setupKind !== 'trade1_departure'
      && o.setupKind !== 'pob_reject'
      && o.setupKind !== 'pob_reject_watch'
      && o.setupKind !== 'setup3_rubber_band'
      && o.setupKind !== 'setup3_primed'
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

    // 1. ENTER: Trade 1 / Trade 2 / Sweep / Dr. Dev POB SHORT / Dr. Dev Trikal 12:45
    if (isActionable) {
      if (emaAgree === 'disagrees') {
        const setupName = o.setupKind === 'trade1_departure' ? 'Trade 1 Departure'
          : o.setupKind === 'trade2_confirmed' ? 'Trade 2 Retest'
          : o.setupKind || 'Setup';
        return {
          side: 'WAIT',
          cls: 'wait',
          title: `⚠️ Counter-Trend ${biasDir} Filtered (${setupName})`,
          subtitle: `Dr. Dev Macro Trend Filter: EMAs disagree with this ${biasDir}. Bot skips setup to avoid fakeout wicks.`,
          steps: [
            `Trend Alignment Guard: 15m EMAs are stacked against ${biasDir}. Fighting momentum leads to whipsaws.`,
            `Wait for EMAs to align with the move or for a valid departure in the true trend direction.`,
            pivotStep,
            ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
          ],
          entry: null,
          stop: o.invalidation,
          tp1: o.tp1,
          tp2: o.tp2,
          tp3: o.tp3,
          exit: o.bookZone,
          rr: o.rr,
        };
      }
      const isPob = o.setupKind === 'pob_reject';
      const is1245Rev = o.setupKind === 'afternoon_1245_reversal';
      const is1245Break = o.setupKind === 'afternoon_1245_breakout';
      const is1245Retest = o.setupKind === 'afternoon_1245_retest';
      const setupLabel = o.setupKind === 'session_sweep'
        ? `Red Bar · Session Sweep · Futures ${biasDir}`
        : o.setupKind === 'trade2_confirmed'
          ? `Red Bar · Trade 2 · Futures ${biasDir} (H1 sweep → M5 close-through)`
          : isPob
            ? `Dr. Dev POB · Futures SHORT (session 5m X → 44–56 reject)`
            : is1245Rev
              ? `Dr. Dev Trikal 12:45 · Reversal ${biasDir} (12:45 auction trap)`
              : is1245Retest
                ? `Dr. Dev Trikal 12:45 · Retest & Bounce ${biasDir} (Morning Shelf Confirmed)`
                : is1245Break
                  ? `Dr. Dev Trikal 12:45 · Breakout ${biasDir} (Morning H/L Expansion)`
                  : `Dr. Dev Red Bar · Trade 1 · Futures ${biasDir} (Left First Red)`;
      const t2Note = o.setupKind === 'trade2_confirmed'
        ? (biasDir === 'SHORT' ? ' (1H high swept → 5m closed below high & median — sells only)' : ' (1H low swept → 5m closed above low & median — buys only)')
        : '';
      const pob = o.playbook?.pobReject || o.pobReject;
      const entryPx = isPob && pob?.triggerPrice != null ? pob.triggerPrice : o.price;
      const pobNote = isPob
        ? ` Fill@POB 0.44 (${this._fmt(entryPx)}) · SL@0.56 · TP1 Anchor ${(pob?.xCandle?.sessionLabel || '')} low · TP2 2R.`
        : '';
      return {
        side: biasDir,
        cls: biasDir === 'LONG' ? 'long' : 'short',
        title: setupLabel,
        subtitle: isPob
          ? `POB ENTER · ${o.actionReason || 'fill@0.44 · SL@0.56 · TP1 Anchor · TP2 2R'}${emaNote}.`
          : `Red Bar ENTER · ${o.actionReason || (useLadder ? 'H1→M5 · SL 5m swing · 50% @ 1:1 → BE → 1:2 → 1:3' : 'SL 5m swing · 50% @ 1:1 + runner')}${emaNote}.`,
        steps: [
          isPob
            ? `${hint}: SHORT at POB 0.44 ${this._fmt(entryPx)} after session X-Candle reject${pob?.xCandle?.sessionLabel ? ` (${pob.xCandle.sessionLabel})` : ''}.`
            : `${hint}: Enter Futures ${biasDir} near ${this._fmt(o.price)}${t2Note}.`,
          `1️⃣ Stop-Loss First (${isPob ? 'POB 0.56 / reject wick' : stopTag}): ${this._fmt(o.invalidation)}${stopPctStr}.${stopWarn}`,
          isPob
            ? `2️⃣ TP1 Anchor low ${this._fmt(o.tp1)} → BE · 3️⃣ TP2 / 2R ${this._fmt(o.tp2)} — no overnight hold.`
            : sagarExitStep,
          pivotStep,
          ...(liqStep ? [liqStep] : clockStep ? [clockStep] : []),
        ],
        entry: entryPx,
        stop: o.invalidation,
        tp1: o.tp1,
        tp2: o.tp2,
        tp3: o.tp3,
        exit: o.bookZone,
        rr: o.rr,
        rrLadder: isPob ? true : useLadder,
      };
    }

    // 2. Directional Bias / Watch ONLY (not an entry trigger yet — do not FOMO mid-trend)
    if (biasDir) {
      const magDown = o.playbook?.magnetBelow;
      const magUp = o.playbook?.magnetAbove;
      const magStep = (magDown || magUp)
        ? `Mark-window Fibs (targets only): ${magDown ? `↓ ${magDown.label} ${this._fmt(magDown.price)}` : ''}${magDown && magUp ? ' · ' : ''}${magUp ? `↑ ${magUp.label} ${this._fmt(magUp.price)}` : ''} — not an ENTER.`
        : null;
      const fmStep = (fibMagnet && (fibMagnet.state === 'PULL_ACTIVE' || fibMagnet.state === 'PULL_WATCH' || fibMagnet.state === 'ENTER'))
        ? `🧲 Equilibrium Magnet: Price stretched ${fibMagnet.distPct.toFixed(2)}% · Equilibrium pull destination @ ${this._fmt(fibMagnet.tp)} (Target only — wait for DNA trigger).`
        : null;
      const s3 = o.playbook?.setup3 || o.setup3;
      const pr = o.playbook?.pobReject || o.pobReject;
      const s3Step = (o.setupKind === 'setup3_primed' || o.setupKind === 'setup3_rubber_band') && s3
        ? `Dr. Dev Setup 3 overlay: ${s3.detachedCount || '≥4'}× 30m bars detached from 5 EMA · Barricade ${this._fmt(s3.barricade)} · Magnet TP ${this._fmt(s3.targetPrice || s3.ema5)} · SL wick ${this._fmt(s3.stopLoss)} — chart guide only (not Telegram ENTER).`
        : null;
      const pobStep = o.setupKind === 'pob_reject_watch' && pr
        ? `Dr. Dev POB watch: ${pr.label || 'session 5m X → retest 44–56 → SHORT reject'} · POB ${this._fmt(pr.pobLo)}–${this._fmt(pr.pobHi)} · fill@0.44 · SL@0.56 · TP1 Anchor.`
        : null;
      const watchTitle = o.setupKind === 'pob_reject_watch'
        ? `Dr. Dev POB Watch · ${pr?.label || 'Asia/London/NY or NSE: retest 44–56 → SHORT reject'}`
        : o.setupKind === 'lunch_decay'
          ? `Lunch Decay Zone (11:30–12:30 IST) · Avoid entries · Wait Dr. Dev Trikal 12:45`
          : o.setupKind === 'afternoon_1245_watch'
            ? `Dr. Dev Trikal 12:45 Watch · London 30m Anchor Marked · Awaiting Breakout / Reversal`
            : o.setupKind === 'setup3_rubber_band'
          ? `Dr. Dev Setup 3 Watch · Barricade broken (${biasDir}) · overlay only — not ENTER`
          : o.setupKind === 'setup3_primed'
            ? `Dr. Dev Setup 3 Watch · Rubber Band Primed (${s3?.detachedCount || 4} bars detached) · Barricade ${this._fmt(s3?.barricade)}`
            : o.setupKind === 'trade2_watch'
              ? `Dr. Dev Red Bar Watch · Trade 2 H1→M5 — need sweep of 1H H/L then 5m close-through (${biasDir})`
              : o.setupKind === 'fib_pullback'
                ? `Dr. Dev Red Bar Bias: ${biasDir} · Near mark-window Fibs / POB (targets) — not ENTER`
                : o.setupKind === 'pivot_reversal'
                  ? `Bias Conflict · Crossed 1H Red vs Fibs (Stay Flat)`
                  : `Dr. Dev Red Bar Bias: ${biasDir} · Waiting Trade 1 / Trade 2 / Sweep / POB`;
      const watchExit = useLadder
        ? `If Trade 2 prints — 1️⃣ Stop (${stopTag}): ${this._fmt(o.invalidation)}${stopPctStr} · 2️⃣ 50% @ 1:1 ${tp1Str} → SL→BE · 3️⃣ Trail 1:2 ${tp2Str} · 4️⃣ TP 1:3 ${tp3Str}.${stopWarn}`
        : `If ENTER prints — Trade 1 / Trade 2 / sweep / POB reject · 1️⃣ Stop (${stopTag}): ${this._fmt(o.invalidation)}${stopPctStr} · 2️⃣ book plan.${stopWarn}`;
      return {
        side: 'WATCH',
        cls: 'wait',
        title: watchTitle,
        subtitle: `${o.actionReason || 'Bias only — Telegram on Trade 1 / Trade 2 / sweep / POB ENTER'}${emaNote}.`,
        steps: [
          `WATCH ≠ signal. Bias is ${biasDir}. ENTER needs Trade 1, Trade 2, session sweep, or Dr. Dev POB reject.`,
          ...(pobStep ? [pobStep] : []),
          ...(magStep ? [magStep] : []),
          ...(fmStep ? [fmStep] : []),
          ...(s3Step ? [s3Step] : []),
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

    // 3. Fib Magnet Equilibrium Context (Radar / Destination Tell ONLY — Not an ENTER trigger)
    if (fibMagnet && (fibMagnet.state === 'PULL_ACTIVE' || fibMagnet.state === 'PULL_WATCH' || fibMagnet.state === 'ENTER')) {
      const isPullActive = fibMagnet.state === 'PULL_ACTIVE' || fibMagnet.state === 'ENTER';
      return {
        side: 'WATCH',
        isFibMagnet: true,
        magnetState: fibMagnet.state,
        cls: 'wait',
        title: `Context Radar · Equilibrium Magnet Destination (${fibMagnet.side})`,
        subtitle: `Price is stretched ${fibMagnet.distPct.toFixed(2)}% outside Mark Box · Destination Target: ${this._fmt(fibMagnet.tp)} · ${isPullActive ? '1m rebound observed' : 'Awaiting lower-timeframe stabilization'}`,
        steps: [
          `🧲 Equilibrium Magnet: In 729 days of BTC data, 69.2% of sessions revisit the 02:30 IST Mark Box after a ≥0.5% stretch.`,
          `🎯 Destination Target: Single target to box edge @ ${this._fmt(fibMagnet.tp)} (optional f50 median @ ${this._fmt(fibMagnet.tpAlt || fibMagnet.tp)}). Single destination target only.`,
          `⚠️ Red Bar DNA Rule: Equilibrium magnet is a destination tell, NOT a validated entry signal. Telegram alerts and Binance execution are gated strictly to validated Trade 1 / Trade 2 Red Bar DNA.`,
          pivotStep,
        ].filter(Boolean),
        entry: null,
        stop: null,
        tp1: fibMagnet.tp,
        tp2: fibMagnet.tpAlt || fibMagnet.tp,
        tp3: null,
        exit: fibMagnet.tp,
        rr: null,
        actionReason: 'Equilibrium Magnet Destination (Context tell only — wait for Red Bar DNA to enter)',
      };
    }

    return {
      side: 'WAIT',
      cls: 'wait',
      title: 'No clear bias · Stay Flat',
      subtitle: 'Waiting for Trade 1 leave, Trade 2 (5m vs median), or session sweep.',
      steps: [
        'ENTER: Trade 1 / Trade 2 / session sweep / Dr. Dev POB SHORT (Asia 05:30 · London 13:00–13:30 · NY 19:00–20:00 · NIFTY 09:15) · fill@0.44 · SL@0.56 · TP1 Anchor · TP2 2R. Setup 3 = overlay. Renko filters wick noise. Leverage 5–10×.',
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
          ${inst.label} on <strong>${tf}</strong>: <strong>Dr. Devendra Pratap Singh</strong> Red Bar DNA · Trade 1 / Trade 2 / sweep · <strong>POB ENTER</strong> (44–56) · Trikal 12:45 · Setup 3 Rubber Band overlay · Renko · leverage 5–10×.
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('rbGuideModal')?.classList.contains('open')) {
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
    const doZoom = (factor) => {
      if (!this._chart) return;
      this._chart.$rbUserZoomed = true;
      try { this._chart.zoom?.(factor); } catch (_) {}
    };
    document.getElementById('rbZoomIn')?.addEventListener('click', () => doZoom(1.35));
    document.getElementById('rbZoomOut')?.addEventListener('click', () => doZoom(0.75));
    const resetChartFit = () => {
      this.state.chartPanOffset = 0;
      this._forceResetZoom = true;
      const ch = this._chart;
      if (ch) {
        ch.$rbUserZoomed = false;
        if (ch.scales?.y) {
          delete ch.scales.y.options.min;
          delete ch.scales.y.options.max;
        }
        try { ch.resetZoom?.(); } catch (_) {}
      }
      const row = (this.state.rows || [])[0];
      if (row && !row.error) this._paintChart(row, this.cfg());
    };
    document.getElementById('rbZoomReset')?.addEventListener('click', resetChartFit);
    document.getElementById('rbFloatReset')?.addEventListener('click', resetChartFit);

    const panPrice = (dir) => {
      const ch = this._chart;
      if (!ch) return;
      const yScale = ch.scales?.y;
      if (!yScale) return;
      ch.$rbUserZoomed = true;
      const span = (yScale.max - yScale.min);
      const delta = span * 0.15 * dir;
      // dir = +1 means shift view UP (increase min & max), dir = -1 means shift DOWN
      yScale.options.min = (yScale.min ?? yScale.start) + delta;
      yScale.options.max = (yScale.max ?? yScale.end) + delta;
      try { ch.update('none'); } catch (_) {}
    };
    document.getElementById('rbFloatPanUp')?.addEventListener('click', () => panPrice(1));
    document.getElementById('rbFloatPanDown')?.addEventListener('click', () => panPrice(-1));
    document.getElementById('rbPanUp')?.addEventListener('click', () => panPrice(1));
    document.getElementById('rbPanDown')?.addEventListener('click', () => panPrice(-1));
    document.getElementById('rbFloatZoomIn')?.addEventListener('click', () => doZoom(1.35));
    document.getElementById('rbFloatZoomOut')?.addEventListener('click', () => doZoom(0.75));
    const panBy = (dir) => {
      const ch = this._chart;
      let panned = false;
      if (ch && typeof ch.pan === 'function') {
        const xScale = ch.scales?.x;
        const isZoomed = ch.$rbUserZoomed || (ch.isZoomedOrPanned ? ch.isZoomedOrPanned() : (xScale && (xScale.min > 0.5 || xScale.max < (ch.$rbBars?.length - 1.5))));
        if (isZoomed && xScale) {
          try {
            const prevMin = xScale.min;
            ch.pan({ x: dir * 80 }, undefined, 'default');
            if (Math.abs(xScale.min - prevMin) > 0.1) {
              ch.$rbUserZoomed = true;
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
    document.getElementById('rbFloatPanLeft')?.addEventListener('click', () => panBy(1));
    document.getElementById('rbFloatPanRight')?.addEventListener('click', () => panBy(-1));

    // Movable / Dockable Floating D-Pad (defaults to bottom-left so latest candles on the right are unobstructed)
    const dpad = document.getElementById('rbFloatingDpad');
    const dpadGrip = document.getElementById('rbDpadGrip');
    const dpadDockBtn = document.getElementById('rbDpadDockToggle');
    if (dpad) {
      try {
        const savedCustom = localStorage.getItem('trendrunner_dpad_pos');
        if (savedCustom) {
          const pos = JSON.parse(savedCustom);
          if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
            dpad.classList.remove('is-left');
            dpad.style.left = `${pos.left}px`;
            dpad.style.top = `${pos.top}px`;
            dpad.style.right = 'auto';
            dpad.style.bottom = 'auto';
          }
        }
      } catch (_) {}

      const toggleDockSide = (e) => {
        if (e) e.stopPropagation();
        dpad.style.left = '';
        dpad.style.top = '';
        dpad.style.right = '';
        dpad.style.bottom = '';
        try { localStorage.removeItem('trendrunner_dpad_pos'); } catch (_) {}
        const nowLeft = dpad.classList.toggle('is-left');
        try { localStorage.setItem('trendrunner_dpad_side', nowLeft ? 'left' : 'right'); } catch (_) {}
      };
      dpadDockBtn?.addEventListener('click', toggleDockSide);
      dpadGrip?.addEventListener('dblclick', toggleDockSide);

      if (dpadGrip) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        const onPointerDown = (ev) => {
          if (ev.target === dpadDockBtn) return;
          const box = dpad.parentElement;
          if (!box) return;
          dragging = true;
          const pt = ev.touches ? ev.touches[0] : ev;
          startX = pt.clientX;
          startY = pt.clientY;
          const boxRect = box.getBoundingClientRect();
          const dpadRect = dpad.getBoundingClientRect();
          origLeft = dpadRect.left - boxRect.left;
          origTop = dpadRect.top - boxRect.top;
          dpad.classList.add('is-dragging');
          if (ev.cancelable) ev.preventDefault();
        };

        const onPointerMove = (ev) => {
          if (!dragging) return;
          const box = dpad.parentElement;
          if (!box) return;
          const pt = ev.touches ? ev.touches[0] : ev;
          const dx = pt.clientX - startX;
          const dy = pt.clientY - startY;
          const maxLeft = Math.max(0, box.clientWidth - dpad.offsetWidth - 6);
          const maxTop = Math.max(0, box.clientHeight - dpad.offsetHeight - 6);
          const nextLeft = Math.max(6, Math.min(maxLeft, Math.round(origLeft + dx)));
          const nextTop = Math.max(6, Math.min(maxTop, Math.round(origTop + dy)));
          dpad.classList.remove('is-left');
          dpad.style.left = `${nextLeft}px`;
          dpad.style.top = `${nextTop}px`;
          dpad.style.right = 'auto';
          dpad.style.bottom = 'auto';
          if (ev.cancelable) ev.preventDefault();
        };

        const onPointerUp = () => {
          if (!dragging) return;
          dragging = false;
          dpad.classList.remove('is-dragging');
          const leftPx = parseFloat(dpad.style.left);
          const topPx = parseFloat(dpad.style.top);
          if (Number.isFinite(leftPx) && Number.isFinite(topPx)) {
            try {
              localStorage.setItem('trendrunner_dpad_pos', JSON.stringify({ left: leftPx, top: topPx }));
            } catch (_) {}
          }
        };

        dpadGrip.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        dpadGrip.addEventListener('touchstart', onPointerDown, { passive: false });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
      }
    }

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
    const feedWarnHtml = r.feedWarning
      ? `<div class="range-desk-error" style="margin-bottom:10px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;">${r.feedWarning}</div>`
      : '';
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

    // Dynamic session times tracking US/London Daylight Saving Time (DST)
    const nyOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 9, 30);
    const lonOpenMins = this._getSessionOpenMins(nowMs, 'Europe/London', 8, 0);
    const lonCloseMins = this._getSessionOpenMins(nowMs, 'Europe/London', 16, 30);

    const fmtHm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
    const nyOpenStr = fmtHm(nyOpenMins);
    const nyEndStr = fmtHm(nyOpenMins + 60);
    const lonOpenStr = fmtHm(lonOpenMins);
    const lonCloseStr = fmtHm(lonCloseMins);

    const isMark = (curMins >= 150 && curMins < 210);
    const isAsia = (curMins >= 330 && curMins < lonOpenMins);
    const isNy = (curMins >= nyOpenMins && curMins < nyOpenMins + 60);
    const isLon = (curMins >= lonOpenMins && curMins < nyOpenMins);
    // Match FibMagnet london_close_fix: 60m before London 16:30 → 30m after (DST-aware)
    const lonCloseStart = lonCloseMins - 60;
    const lonCloseEnd = lonCloseMins + 30;
    const isLonClose = (curMins >= lonCloseStart && curMins <= lonCloseEnd);
    // US equity cash close / CME settle only (01:15–02:30 IST) — NOT the whole evening
    const isUsClose = (curMins >= 75 && curMins < 150);

    const instUpper = String(r.instrument?.id || '').toUpperCase();
    const isNiftyInst = instUpper === 'NIFTY';
    const isXauInst = instUpper === 'XAU';
    const isNgInst = instUpper === 'NG';
    const isNsePrime = isNiftyInst && curMins >= 555 && curMins < 735;
    const isNseHunt = isNiftyInst && curMins >= 735 && curMins <= 795;
    const isNseAfternoon = isNiftyInst && curMins > 795 && curMins < 915;
    const isNseMark = isNiftyInst && curMins >= 915 && curMins <= 945;

    const isXauMark = isXauInst && curMins >= 90 && curMins < 150; // 01:30–02:30 IST
    const comexOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 8, 30);
    const comexOpenStr = fmtHm(comexOpenMins);
    const isComexOpen = isXauInst && curMins >= comexOpenMins && curMins < comexOpenMins + 90;

    const nymexOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 9, 0);
    const nymexOpenStr = fmtHm(nymexOpenMins);
    const isMcxDay = isNgInst && curMins >= 540 && curMins < 1020; // 09:00–17:00 IST
    const isMcxEve = isNgInst && curMins >= 1020 && curMins < nymexOpenMins; // 17:00–NYMEX
    const isNymex = isNgInst && curMins >= nymexOpenMins && curMins < 1380; // NYMEX–23:00 IST
    const isNgMark = isNgInst && curMins >= 1380 && curMins <= 1410; // 23:00–23:30 IST

    const activeSessionName = isNiftyInst
      ? (isNsePrime ? 'NSE Prime POB & Trade 1 (09:15–12:15 IST)'
        : isNseHunt ? '12:45 PM Liquidity Hunt (12:15–13:15 IST)'
        : isNseAfternoon ? 'NSE Afternoon Session (13:15–15:15 IST)'
        : isNseMark ? 'NSE Close Mark Window (15:15–15:45 IST)'
        : 'NSE Closed (Opens 09:15 IST)')
      : isNgInst
        ? (isMcxDay ? 'MCX Morning Session · POB & 30m Trade 1 (09:00–17:00 IST)'
          : isMcxEve ? `MCX Evening Open · Trikal POB (17:00–${nymexOpenStr} IST)`
          : isNymex ? `US NYMEX Open · Prime Energy Session (${nymexOpenStr}–23:00 IST)`
          : isNgMark ? 'MCX Close Mark Window (23:00–23:30 IST)'
          : 'MCX Closed · Globex Overnight (MCX Opens 09:00 IST)')
      : isXauInst
        ? (isXauMark ? 'Gold Daily Mark Window (01:30–02:30 IST)'
          : isComexOpen ? `COMEX / US Bullion Open (${comexOpenStr}–${nyEndStr} IST)`
          : isAsia ? `Asia Bullion Session (05:30–${lonOpenStr} IST)`
          : isLon ? `London Bullion / LBMA (${lonOpenStr}–${comexOpenStr} IST)`
          : isLonClose ? `London Close / LBMA Fix (${fmtHm(lonCloseStart)}–${fmtHm(lonCloseEnd)} IST)`
          : 'Off-prime Bullion Hours')
      : isMark ? 'Daily Mark Window (02:30–03:30 IST)'
      : isNy ? `New York Open (${nyOpenStr}–${nyEndStr} IST)`
      : isAsia ? `Asia Session (05:30–${lonOpenStr} IST)`
      : isLon ? `London Session (${lonOpenStr}–${nyOpenStr} IST)`
      : isLonClose ? `London Close / 4 PM Fix (${fmtHm(lonCloseStart)}–${fmtHm(lonCloseEnd)} IST)`
      : isUsClose ? 'US Cash Close & CME Settle (01:15–02:30 IST)'
      : 'Off-prime / dead hours';

    // Trigger level text for Stepper
    const firstRedTag = o.firstRedLabel || (r.instrument?.firstRedTf === '30m' ? '30m' : '1H');
    const activePob = o.pobReject || o.playbook?.pobReject;
    const trigLevelStr = (activePob?.pobLo != null && (o.setupKind === 'pob_reject' || o.setupKind === 'pob_reject_watch'))
      ? `POB 44–56: ${this._fmt(activePob.pobLo)}–${this._fmt(activePob.pobHi)}`
      : o.firstRed1h
        ? `${firstRedTag} Red ${this._fmt(o.firstRed1h.low)}–${this._fmt(o.firstRed1h.high)}`
        : o.playbook?.magnetBelow
          ? `Fib ↓ ${this._fmt(o.playbook.magnetBelow.price)}`
          : o.playbook?.magnetAbove
            ? `Fib ↑ ${this._fmt(o.playbook.magnetAbove.price)}`
            : 'Testing Equilibrium';

    const prime = this._getPrimeWindowStatus(nowMs, r.instrument?.id);

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
          <div class="rb-zoom-group" role="group" aria-label="Desk rules">
            <button type="button" class="rb-zoom-btn" id="rbOpenGuide" style="border-color:#38bdf8;color:#38bdf8;display:inline-flex;align-items:center;gap:4px;" title="Open Desk Rules & FAQ">📖 Rules &amp; FAQ</button>
          </div>
        </div>

        <!-- Live Session & Prime Window Beacon -->
        <div class="rb-prime-beacon-strip">
          <div class="rb-beacon-left">
            <span style="display:flex; align-items:center;"><span class="rb-live-pulse-dot"></span> <strong style="color:#f8fafc;">${activeSessionName}</strong></span>
            <span style="color:#64748b;">·</span>
            <span style="color:#94a3b8;">⏱️ Candle close: <strong style="color:#cbd5e1;">${nextBarStr}</strong></span>
          </div>
          <div class="rb-beacon-right">
            ${prime.active ? `
              <span class="rb-prime-pill active" title="${prime.active.rule}">
                <strong>Prime Window:</strong> ${prime.active.name} (${prime.active.remStr} left · ${prime.active.winRate})
              </span>
            ` : prime.next?.isApproaching ? `
              <span class="rb-prime-pill alert" title="${prime.next.rule}">
                <strong>Window in ${prime.next.waitMins}m:</strong> ${prime.next.name} (${prime.next.startStrIst} IST${!prime.isUserIst ? ` / ${prime.next.localStart} ${prime.userTzName}` : ''})
              </span>
            ` : `
              <span class="rb-prime-pill next" title="${prime.next.rule}">
                <strong>Next Window:</strong> ${prime.next.name} in <strong>${prime.next.waitStr}</strong> (${prime.next.startStrIst} IST${!prime.isUserIst ? ` / ${prime.next.localStart} ${prime.userTzName}` : ''})
              </span>
            `}
            ${r.sessionTell ? `<span style="font-weight:600; color:${r.sessionTell.type === 'bullish' ? '#4ade80' : r.sessionTell.type === 'bearish' ? '#f87171' : '#7dd3fc'}; font-size:11px; background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px;">${r.sessionTell.badge}</span>` : ''}
            ${o.equinox && o.equinox.seasonActive && inst.id === 'NIFTY' ? `
              <span class="rb-prime-pill" style="background:${o.equinox.territory === 'positive' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}; border-color:${o.equinox.territory === 'positive' ? '#22c55e' : '#ef4444'}; color:${o.equinox.territory === 'positive' ? '#4ade80' : '#f87171'};" title="Dr. Dev Equinox Baseline: ${o.equinox.baseline} · ${o.equinox.territory === 'positive' ? 'Positive Territory: Calls only, Puts forbidden' : 'Negative Territory: Puts only, Calls forbidden'}">
                🌐 <strong>Equinox:</strong> ${o.equinox.territory.toUpperCase()} (${o.equinox.allowedSide.replace('_', ' ')})
              </span>
            ` : ''}
            ${o.afternoon1245?.morning?.locked ? `
              <span class="rb-prime-pill" style="background:rgba(245,158,11,0.15); border-color:#f59e0b; color:#fbbf24;" title="Morning Range (09:15–12:30 IST): Low ${this._fmt(o.afternoon1245.morning.morningLow)} · Mid ${this._fmt(o.afternoon1245.morning.morningMid)} · High ${this._fmt(o.afternoon1245.morning.morningHigh)}">
                🌅 <strong>Morning Range:</strong> ${this._fmt(o.afternoon1245.morning.morningLow)} – ${this._fmt(o.afternoon1245.morning.morningHigh)}
              </span>
            ` : ''}
            ${o.squeeze5m?.isSqueezing ? `
              <span class="rb-prime-pill alert" title="5m Squeeze Compression: Range ${this._fmt(o.squeeze5m.squeezeLow)}–${this._fmt(o.squeeze5m.squeezeHigh)} · Target: ${this._fmt(o.squeeze5m.projectedTargetUp)} / ${this._fmt(o.squeeze5m.projectedTargetDown)}">
                ⚡ <strong>5m Squeeze:</strong> ${this._fmt(o.squeeze5m.squeezeLow)}–${this._fmt(o.squeeze5m.squeezeHigh)}
              </span>
            ` : ''}
          </div>
        </div>

        <div class="rb-chart-legend">
          <span class="lg price">Candles (${this.activeTf()})</span>
          ${this.activeTf() === '30m' ? '<span class="lg ema5" style="color:#c084fc;"><i style="display:inline-block;width:10px;height:2px;background:#c084fc;vertical-align:middle;margin-right:4px;"></i>EMA 5 (Rubber Band)</span>' : ''}
          <span class="lg ema10">EMA ${c.emaFast || 10}</span>
          <span class="lg ema30">EMA ${c.emaSlow || 30}</span>
          <span class="lg band">${this._isFibStyle(r) ? `POB 44–56 (Point of Balance) · Fib 0/1${r.instrument?.markLabel ? ` · ${r.instrument.markLabel}` : ''}` : 'Day ranges'}</span>
          <span class="lg stop">${o.firstRedLabel || '1H'} first red H/L</span>
          <span class="lg sess-london rb-lg-desk">Session opens</span>
          <span class="lg rb-lg-desk" style="border-left:3px solid #22c55e; color:#94a3b8; padding-left:4px;">Prev Fib Box</span>
          <span id="rbCandleInfo" style="margin-left:auto; font-weight:600; font-size:11.5px; color:#cbd5e1;"></span>
        </div>
        <p class="rb-zoom-hint">Floating 4-way D-Pad (▲▼◀▶ + − ↺ · drag ⠿ or click ⇄ to move) · Mouse wheel &amp; touch pinch supported</p>
        <div class="rb-chart-box">
          <canvas id="redBarChart" aria-label="Red Bar chart"></canvas>
          <div class="rb-floating-dpad${localStorage.getItem('trendrunner_dpad_side') !== 'right' ? ' is-left' : ''}" id="rbFloatingDpad" aria-label="Chart navigation">
            <div class="rb-dpad-grip" id="rbDpadGrip" title="Drag to move D-Pad anywhere on chart · Double-click or tap ⇄ to snap Left/Right">
              <span class="rb-dpad-dots">⠿</span>
              <button type="button" class="rb-dpad-dock-btn" id="rbDpadDockToggle" title="Move D-Pad Left / Right">⇄</button>
            </div>
            <div class="rb-dpad-row">
              <button type="button" class="rb-dpad-btn rb-dpad-zoom" id="rbFloatZoomIn" title="Zoom in (+)">+</button>
              <button type="button" class="rb-dpad-btn rb-dpad-up" id="rbFloatPanUp" title="Pan price up (▲)">▲</button>
              <button type="button" class="rb-dpad-btn rb-dpad-zoom" id="rbFloatZoomOut" title="Zoom out (−)">−</button>
            </div>
            <div class="rb-dpad-mid">
              <button type="button" class="rb-dpad-btn rb-dpad-left" id="rbFloatPanLeft" title="Pan time earlier (◀)">◀</button>
              <button type="button" class="rb-dpad-btn rb-dpad-fit" id="rbFloatReset" title="Fit / Reset (↺)">↺</button>
              <button type="button" class="rb-dpad-btn rb-dpad-right" id="rbFloatPanRight" title="Pan time later (▶)">▶</button>
            </div>
            <button type="button" class="rb-dpad-btn rb-dpad-down" id="rbFloatPanDown" title="Pan price down (▼)">▼</button>
          </div>
        </div>
      </div>
    `;

    // 2. Action & Status HUD
    const isEnter = a.side === 'LONG' || a.side === 'SHORT';
    const freshMins = (String(r.instrument?.id || '').toUpperCase() === 'NIFTY' || o.setupKind === 'pob_reject') ? 20 : 90;
    const snap = this.state.enterSnapshot;
    const snapAgeMin = snap?.at ? (Date.now() - snap.at) / 60000 : 0;
    const reasonStale = /stale|do not chase|window closed|already \d/i.test(String(o.actionReason || ''));
    const snapStale = snap && snapAgeMin > freshMins;
    const showEnter = isEnter && !reasonStale && !a.isFibMagnet;
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

    const escTxt = (s) => String(s || '').replace(/[<>&]/g, '');
    const watchHeadline = escTxt(a.title || '');
    const watchDetail = escTxt(a.subtitle || o.actionReason || '');
    const isSetup3Watch = o.setupKind === 'setup3_primed' || o.setupKind === 'setup3_rubber_band';
    const isPobWatch = o.setupKind === 'pob_reject_watch';
    const is1245Watch = o.setupKind === 'afternoon_1245_watch' || o.setupKind === 'lunch_decay';
    const is1245Enter = (o.setupKind === 'afternoon_1245_reversal' || o.setupKind === 'afternoon_1245_breakout' || o.setupKind === 'afternoon_1245_retest') && showEnter;
    const isPobEnter = o.setupKind === 'pob_reject' && showEnter;
    const statusBanner = a.isFibMagnet
      ? `<div class="rb-signal-banner wait" style="background:rgba(56,189,248,0.10); border:1px solid rgba(56,189,248,0.35); color:#7dd3fc;">🧲 CONTEXT RADAR · Equilibrium pull towards Mark Fib @ ${this._fmt(a.tp1)} (Context tell only — wait for Red Bar DNA / POB to ENTER)</div>`
      : (showEnter
        ? `<div class="rb-signal-banner enter">${is1245Enter ? '🕒 12:45 AFTERNOON ENTER' : isPobEnter ? '⚖️ POB ENTER' : 'LIVE ENTER'} · ${a.side} — fresh window (~${freshMins}m). Levels ${useSnap ? 'frozen at first alert' : 'live'}.</div>`
        : (isEnter || reasonStale || snapStale)
          ? `<div class="rb-signal-banner watch">STALE — ENTER already fired; do <em>not</em> chase. ${escTxt(o.actionReason) || 'Wait for the next Trade 1 / 2 / sweep / POB.'}</div>`
        : a.side === 'WATCH'
          ? `<div class="rb-signal-banner watch">${
              isPobWatch
                ? `⚖️ ${watchHeadline || 'Dr. Dev POB — awaiting retest / reject'}`
                : is1245Watch
                  ? `🕒 ${watchHeadline || 'Dr. Dev Trikal 12:45 — watching London Open anchor'}`
                  : isSetup3Watch
                    ? `🧲 ${watchHeadline || 'Dr. Dev Setup 3 Watch — rubber band overlay (not ENTER)'}`
                    : `👀 ${watchHeadline || `WATCHING — Bias ${trendWord}; waiting for confirmed trigger`}`
            }${watchDetail ? `<div style="margin-top:4px;font-size:11.5px;font-weight:500;opacity:0.92;">${watchDetail}</div>` : ''}</div>`
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
      // Stepper (Magnet-aware when in Equilibrium Context, standard 4-step for Red Bar DNA)
      const stepperInner = a.isFibMagnet ? `
        <div class="rb-step done">
          <div class="rb-step-icon">🧲</div>
          <div class="rb-step-body">
            <div class="rb-step-name">1. Equilibrium Pull</div>
            <div class="rb-step-val" style="color:#38bdf8;">${r.fibMagnet?.distPct ? r.fibMagnet.distPct.toFixed(2) + '% Stretch' : 'Stretched'}</div>
          </div>
        </div>
        <div class="rb-step done">
          <div class="rb-step-icon">🎯</div>
          <div class="rb-step-body">
            <div class="rb-step-name">2. Single Target</div>
            <div class="rb-step-val">${this._fmt(a.tp1)}</div>
          </div>
        </div>
        <div class="rb-step active">
          <div class="rb-step-icon">⏳</div>
          <div class="rb-step-body">
            <div class="rb-step-name">3. DNA Trigger</div>
            <div class="rb-step-val">Awaiting Trade 1 / 2</div>
          </div>
        </div>
        <div class="rb-step pending">
          <div class="rb-step-icon">🔒</div>
          <div class="rb-step-body">
            <div class="rb-step-name">4. Execution Gated</div>
            <div class="rb-step-val">DNA Required to Enter</div>
          </div>
        </div>
      ` : isPobWatch ? `
        <div class="rb-step done">
          <div class="rb-step-icon">🕯️</div>
          <div class="rb-step-body">
            <div class="rb-step-name">1. X-Candle</div>
            <div class="rb-step-val">${(o.playbook?.pobReject || o.pobReject)?.xCandle?.sessionLabel || '5m first red @ session open'}</div>
          </div>
        </div>
        <div class="rb-step ${['await_retest', 'watching'].includes((o.playbook?.pobReject || o.pobReject)?.status) ? 'active' : 'done'}">
          <div class="rb-step-icon">⚖️</div>
          <div class="rb-step-body">
            <div class="rb-step-name">2. POB Retest (44–56)</div>
            <div class="rb-step-val">${this._fmt((o.playbook?.pobReject || o.pobReject)?.pobLo)}–${this._fmt((o.playbook?.pobReject || o.pobReject)?.pobHi)}</div>
          </div>
        </div>
        <div class="rb-step active">
          <div class="rb-step-icon">⏳</div>
          <div class="rb-step-body">
            <div class="rb-step-name">3. SHORT Reject</div>
            <div class="rb-step-val">Wait close &lt; 0.44 · stand down if &gt; 0.56</div>
          </div>
        </div>
        <div class="rb-step pending">
          <div class="rb-step-icon">🎯</div>
          <div class="rb-step-body">
            <div class="rb-step-name">4. ENTER</div>
            <div class="rb-step-val">fill@0.44 · SL@0.56 · TP1 Anchor</div>
          </div>
        </div>
      ` : isSetup3Watch ? `
        <div class="rb-step done">
          <div class="rb-step-icon">🧲</div>
          <div class="rb-step-body">
            <div class="rb-step-name">1. 30m Detach</div>
            <div class="rb-step-val">${(o.setup3 || o.playbook?.setup3)?.detachedCount || '≥4'} bars</div>
          </div>
        </div>
        <div class="rb-step ${o.setupKind === 'setup3_rubber_band' ? 'done' : 'active'}">
          <div class="rb-step-icon">🚧</div>
          <div class="rb-step-body">
            <div class="rb-step-name">2. Barricade</div>
            <div class="rb-step-val">${this._fmt((o.setup3 || o.playbook?.setup3)?.barricade)}</div>
          </div>
        </div>
        <div class="rb-step ${o.setupKind === 'setup3_rubber_band' ? 'active' : 'pending'}">
          <div class="rb-step-icon">🎯</div>
          <div class="rb-step-body">
            <div class="rb-step-name">3. 30m 5 EMA Target</div>
            <div class="rb-step-val">${this._fmt((o.setup3 || o.playbook?.setup3)?.ema5)}</div>
          </div>
        </div>
        <div class="rb-step pending">
          <div class="rb-step-icon">🔒</div>
          <div class="rb-step-body">
            <div class="rb-step-name">4. DNA Gate</div>
            <div class="rb-step-val">Overlay only · not ENTER</div>
          </div>
        </div>
      ` : (is1245Watch || o.setupKind === 'afternoon_1245_reversal' || o.setupKind === 'afternoon_1245_breakout' || o.setupKind === 'afternoon_1245_retest') ? `
        <div class="rb-step done">
          <div class="rb-step-icon">🌅</div>
          <div class="rb-step-body">
            <div class="rb-step-name">1. Morning Range (09:15–12:30)</div>
            <div class="rb-step-val">${this._fmt(o.afternoon1245?.morning?.morningLow)} – ${this._fmt(o.afternoon1245?.morning?.morningHigh)}</div>
          </div>
        </div>
        <div class="rb-step ${o.afternoon1245?.bar1245 ? 'done' : 'active'}">
          <div class="rb-step-icon">🕒</div>
          <div class="rb-step-body">
            <div class="rb-step-name">2. 12:45 London Candle</div>
            <div class="rb-step-val">${o.afternoon1245?.bar1245 ? `${o.afternoon1245.bar1245.color.toUpperCase()} (${this._fmt(o.afternoon1245.bar1245.low)}–${this._fmt(o.afternoon1245.bar1245.high)})` : 'Awaiting 12:45 IST'}</div>
          </div>
        </div>
        <div class="rb-step ${showEnter ? 'done' : 'active'}">
          <div class="rb-step-icon">⚡</div>
          <div class="rb-step-body">
            <div class="rb-step-name">3. Reversal / Breakout</div>
            <div class="rb-step-val">${showEnter ? o.setupKind.replace('afternoon_1245_', '').toUpperCase() : 'Watching 5m confirmation'}</div>
          </div>
        </div>
        <div class="rb-step ${showEnter ? 'active' : 'pending'}">
          <div class="rb-step-icon">🎯</div>
          <div class="rb-step-body">
            <div class="rb-step-name">4. London Momentum</div>
            <div class="rb-step-val">Target 1:3+ R:R (cutoff 15:05)</div>
          </div>
        </div>
      ` : `
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
      `;

      actionContentHtml = `
        ${statusBanner}
        ${tellHtml}
        <div class="rb-stepper-wrap">
          <div class="rb-stepper">
            ${stepperInner}
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
          <span style="font-weight:600; color:#cbd5e1;">${isNiftyInst ? '🇮🇳 NSE Intraday Liquidity Rhythm' : '24H Global Liquidity Rhythm'}</span>
          <span><span class="rb-live-pulse-dot"></span> Active: <strong style="color:#f8fafc;">${activeSessionName}</strong></span>
        </div>
        <div class="rb-timeline-track">
          ${isNiftyInst ? `
          <div class="rb-session-seg ${isNsePrime ? 'active' : ''} is-prime" title="09:15 IST 5m X-Candle POB &amp; 1H Trade 1 Window">
            <span class="seg-time">09:15</span>
            <span class="seg-name">NSE POB</span>
          </div>
          <div class="rb-session-seg ${isNseHunt ? 'active' : ''} is-prime" title="Dr. Dev 12:45 PM Institutional Liquidity Hunt (12:15–13:15 IST)">
            <span class="seg-time">12:45</span>
            <span class="seg-name">Liq Hunt</span>
          </div>
          <div class="rb-session-seg ${isNseAfternoon ? 'active' : ''}" title="NSE Afternoon Trend &amp; Setup 3 Window (13:15–15:15 IST)">
            <span class="seg-time">13:15</span>
            <span class="seg-name">Afternoon</span>
          </div>
          <div class="rb-session-seg ${isNseMark ? 'active' : ''}" title="NSE Closing Range Mark Window (15:15–15:45 IST)">
            <span class="seg-time">15:15</span>
            <span class="seg-name">Close Fib</span>
          </div>
          ` : isNgInst ? `
          <div class="rb-session-seg ${isMcxDay ? 'active' : ''} is-prime" title="MCX Morning Open · 09:00 IST 5m X-Candle POB &amp; 30m First Red">
            <span class="seg-time">09:00</span>
            <span class="seg-name">MCX Day</span>
          </div>
          <div class="rb-session-seg ${isMcxEve ? 'active' : ''} is-prime" title="Dr. Dev 17:00 IST MCX Evening / European Energy Open POB">
            <span class="seg-time">17:00</span>
            <span class="seg-name">MCX Eve</span>
          </div>
          <div class="rb-session-seg ${isNymex ? 'active' : ''} is-prime" title="US NYMEX Pit Open (${nymexOpenStr} IST) · Highest NatGas Volatility">
            <span class="seg-time">${nymexOpenStr}</span>
            <span class="seg-name">NYMEX</span>
          </div>
          <div class="rb-session-seg ${isNgMark ? 'active' : ''}" title="MCX Closing Range Mark Window (23:00–23:30 IST)">
            <span class="seg-time">23:00</span>
            <span class="seg-name">Close Fib</span>
          </div>
          ` : isXauInst ? `
          <div class="rb-session-seg ${isXauMark ? 'active' : ''}" title="Gold Daily Mark Window (01:30–02:30 IST)">
            <span class="seg-time">01:30</span>
            <span class="seg-name">Mark</span>
          </div>
          <div class="rb-session-seg ${isAsia ? 'active' : ''} is-prime" title="Asia / Tokyo Bullion Open (05:30 IST)">
            <span class="seg-time">05:30</span>
            <span class="seg-name">Asia</span>
          </div>
          <div class="rb-session-seg ${isLon ? 'active' : ''} is-prime" title="London Bullion / LBMA Open (${lonOpenStr} IST)">
            <span class="seg-time">${lonOpenStr}</span>
            <span class="seg-name">London</span>
          </div>
          <div class="rb-session-seg ${isComexOpen || isNy ? 'active' : ''} is-prime" title="US COMEX / NY Bullion Open (${comexOpenStr} IST)">
            <span class="seg-time">${comexOpenStr}</span>
            <span class="seg-name">COMEX/NY</span>
          </div>
          <div class="rb-session-seg ${isLonClose ? 'active' : ''}" title="LBMA / London Close Fix · ${fmtHm(lonCloseStart)}–${fmtHm(lonCloseEnd)} IST">
            <span class="seg-time">${fmtHm(lonCloseStart)}</span>
            <span class="seg-name">LBMA Fix</span>
          </div>
          ` : `
          <div class="rb-session-seg ${isMark ? 'active' : ''}">
            <span class="seg-time">02:30</span>
            <span class="seg-name">Mark</span>
          </div>
          <div class="rb-session-seg ${isAsia ? 'active' : ''} is-prime">
            <span class="seg-time">05:30</span>
            <span class="seg-name">Asia</span>
          </div>
          <div class="rb-session-seg ${isLon ? 'active' : ''} is-prime">
            <span class="seg-time">${lonOpenStr}</span>
            <span class="seg-name">London</span>
          </div>
          <div class="rb-session-seg ${isNy ? 'active' : ''} is-prime">
            <span class="seg-time">${nyOpenStr}</span>
            <span class="seg-name">NY Open</span>
          </div>
          <div class="rb-session-seg ${isLonClose ? 'active' : ''}" title="London 4 PM Fix · ${fmtHm(lonCloseStart)}–${fmtHm(lonCloseEnd)} IST">
            <span class="seg-time">${fmtHm(lonCloseStart)}</span>
            <span class="seg-name">Lon Close</span>
          </div>
          <div class="rb-session-seg ${isUsClose ? 'active' : ''}" title="US equity close / CME settle · 01:15–02:30 IST">
            <span class="seg-time">01:15</span>
            <span class="seg-name">US Close</span>
          </div>
          `}
        </div>

        <!-- Prime Execution Windows Reference Matrix -->
        <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <span style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">3 Prime Timing Windows (Session Extreme &amp; Discovery Windows)</span>
            <span style="font-size: 10.5px; color: #64748b;">${prime.isUserIst ? 'Times in IST' : `Times in IST &amp; your ${prime.userTzName} timezone`}</span>
          </div>
          <div class="rb-prime-windows-grid">
            ${prime.allWindows.map(w => `
              <div class="rb-prime-win-card ${w.isCurrent ? 'active' : ''}">
                <div class="win-card-top">
                  <span>${w.name}</span>
                  ${w.badge ? `<span class="win-best-badge">${w.badge}</span>` : ''}
                </div>
                <div class="win-card-times">
                  <strong>${w.startStrIst}–${w.endStrIst} IST</strong>
                  ${!w.isUserIst ? `<span class="win-local-time">(${w.localStart}–${w.localEnd} ${w.userTzName})</span>` : ''}
                </div>
                <div class="win-card-edge">${w.winRate}</div>
                <div style="font-size: 10px; color: #94a3b8; line-height: 1.35; margin: 2px 0;">${w.rule}</div>
                <div class="win-card-status">${w.statusBadge}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // 4. Key Levels Matrix (3-Column clean grid)
    const markTag = isNiftyInst ? '15:15 Mark Fib' : isNgInst ? '23:00 Mark Fib' : isXauInst ? '01:30 Mark Fib' : '02:30 Mark Fib';
    const sess1Tag = isNgInst ? 'MCX Day H/L' : isNiftyInst ? 'NSE Morning H/L' : 'Asia H/L';
    const sess2Tag = isNgInst ? 'MCX Eve H/L' : isNiftyInst ? 'NSE Midday H/L' : 'London H/L';
    const sess3Tag = isNgInst ? 'NYMEX H/L' : isXauInst ? 'COMEX/NY H/L' : isNiftyInst ? 'NSE Session H/L' : 'NY H/L';
    const levelsMatrixHtml = `
      <div class="rb-levels-matrix">
        <div class="rb-levels-col">
          <div class="col-title">📌 Session Extremes</div>
          <div class="level-row"><span>${sess1Tag}:</span> <strong>${this._fmt(o.refs?.asiaHigh)} / ${this._fmt(o.refs?.asiaLow)}</strong></div>
          <div class="level-row"><span>${sess2Tag}:</span> <strong>${this._fmt(o.refs?.londonHigh)} / ${this._fmt(o.refs?.londonLow)}</strong></div>
          <div class="level-row"><span>${sess3Tag}:</span> <strong>${this._fmt(o.refs?.nyHigh)} / ${this._fmt(o.refs?.nyLow)}</strong></div>
        </div>
        <div class="rb-levels-col">
          <div class="col-title">🧲 Equilibrium Anchors</div>
          <div class="level-row"><span>${markTag}:</span> <strong>${this._fmt(o.currentBand?.high)} / ${this._fmt(o.currentBand?.low)}</strong></div>
          <div class="level-row"><span>Mark POB (44–56%):</span> <strong>${o.currentBand?.pob ? `${this._fmt(o.currentBand.pob.low)} – ${this._fmt(o.currentBand.pob.high)}` : (o.currentBand?.f44 != null ? `${this._fmt(Math.min(o.currentBand.f44, o.currentBand.f56))} – ${this._fmt(Math.max(o.currentBand.f44, o.currentBand.f56))}` : '—')}</strong></div>
          <div class="level-row"><span>Mark Median (50%):</span> <strong>${this._fmt(o.currentBand?.f50 ?? o.currentBand?.mid)}</strong></div>
          <div class="level-row"><span>${firstRedTag} First Red:</span> <strong>${this._fmt(o.firstRed1h?.high)} / ${this._fmt(o.firstRed1h?.low)}</strong></div>
        </div>
        <div class="rb-levels-col">
          <div class="col-title">🎯 Macro Targets &amp; Swings</div>
          <div class="level-row"><span>Prior Day (PDH/PDL):</span> <strong>${this._fmt(o.refs?.priorDayHigh)} / ${this._fmt(o.refs?.priorDayLow)}</strong></div>
          <div class="level-row"><span>5m Swing H/L:</span> <strong>${this._fmt(o.refs?.prevSwingHigh)} / ${this._fmt(o.refs?.prevSwingLow)}</strong></div>
          ${activePob?.pobLo != null ? `<div class="level-row"><span>5m Scalp POB (${activePob.xCandle?.sessionLabel || '5m'}):</span> <strong>${this._fmt(activePob.pobLo)} – ${this._fmt(activePob.pobHi)}</strong></div>` : `<div class="level-row"><span>Dr. Dev CPR:</span> <strong>${this._fmt((o.cpr || o.playbook?.cpr)?.pivot)}</strong></div>`}
          <div class="level-row"><span>EMA 10 / 30:</span> <strong>${r.emaAgree || 'Agree'}</strong></div>
        </div>
      </div>
    `;

    return `
      ${feedWarnHtml}
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

  /** Dynamic conversion of local market time to IST minute-of-day with DST tracking. */
  _getSessionOpenMins(ts = Date.now(), timeZone = 'America/New_York', targetHour = 9, targetMinute = 30) {
    try {
      const d = new Date(ts);
      const dIso = new Date(d.toLocaleString('en-US', { timeZone }));
      const dUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
      const diffHours = (dUtc - dIso) / (3600 * 1000);
      const istMins = targetHour * 60 + targetMinute + Math.round(diffHours * 60) + (5 * 60 + 30);
      return ((istMins % 1440) + 1440) % 1440;
    } catch (_) {
      return (targetHour * 60 + targetMinute);
    }
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
        const bodyW = Math.max(3.5, Math.min(slot * 0.78, 18));

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

        // Fib Magnet Equilibrium Pull candle badge (Context Tell)
        if (chart.$rbFibMagnet && (chart.$rbFibMagnet.state === 'PULL_ACTIVE' || chart.$rbFibMagnet.state === 'ENTER') && chart.$rbTimes && chart.$rbTimes.length) {
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
              const text = isBuy ? '🧲 FIB PULL ↑' : '🧲 FIB PULL ↓';
              const tw = ctx.measureText(text).width;
              ctx.fillStyle = 'rgba(14, 165, 233, 0.90)';
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
                const yOff = (chart.$rbFibMagnet && (chart.$rbFibMagnet.state === 'PULL_ACTIVE' || chart.$rbFibMagnet.state === 'ENTER')) ? 34 : 18;
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

  /**
   * Most recent prior Fib box (Yesterday's locked 02:30 IST Mark Box):
   * 1. Ultra-transparent ghost corridor (4% opacity) with subtle dashed lines across into today's trend.
   * 2. Left-side margin badges with green dot (High), cyan dot (Mid), red dot (Low) + exact price.
   */
  _priorFibPlugin() {
    return {
      id: 'rbPriorFib',
      beforeDatasetsDraw(chart) {
        // Fib lines ONLY appear when hovering or pinned on mobile/desktop!
        const pf = chart.$rbHoveredPriorFib || chart.$rbPinnedPriorFib;
        if (!pf) return;
        const yScale = chart.scales.y;
        const xScale = chart.scales.x;
        const area = chart.chartArea;
        if (!yScale || !xScale || !area) return;
        const ctx = chart.ctx;

        const yHi = yScale.getPixelForValue(pf.high);
        const yLo = yScale.getPixelForValue(pf.low);
        const yMid = pf.mid != null ? yScale.getPixelForValue(pf.mid) : null;
        if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) return;

        // Extend forward across into today's trend line
        const xStart = Math.max(area.left, (pf.band?.i1 != null ? xScale.getPixelForValue(pf.band.i1) : area.left));
        const xEnd = area.right;
        if (xEnd <= xStart) return;

        const hoveredLevel = chart.$rbHoveredLevel;

        ctx.save();
        // 1. Ghost corridor fill (reveals smoothly at 7% opacity when hovered)
        const top = Math.min(yHi, yLo);
        const h = Math.max(2, Math.abs(yLo - yHi));
        ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
        ctx.fillRect(xStart, top, xEnd - xStart, h);

        // 2. High line (Green)
        const isHiHovered = hoveredLevel === 'high';
        ctx.strokeStyle = isHiHovered ? 'rgba(74, 222, 128, 0.95)' : 'rgba(34, 197, 94, 0.50)';
        ctx.lineWidth = isHiHovered ? 1.75 : 1;
        ctx.setLineDash(isHiHovered ? [6, 3] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(xStart, yHi);
        ctx.lineTo(xEnd, yHi);
        ctx.stroke();

        // 3. Median line (Cyan)
        if (yMid != null && Number.isFinite(yMid)) {
          const isMidHovered = hoveredLevel === 'mid';
          ctx.strokeStyle = isMidHovered ? 'rgba(56, 189, 248, 0.95)' : 'rgba(56, 189, 248, 0.50)';
          ctx.lineWidth = isMidHovered ? 1.75 : 1;
          ctx.setLineDash(isMidHovered ? [6, 3] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(xStart, yMid);
          ctx.lineTo(xEnd, yMid);
          ctx.stroke();
        }

        // 4. Low line (Red)
        const isLoHovered = hoveredLevel === 'low';
        ctx.strokeStyle = isLoHovered ? 'rgba(248, 113, 113, 0.95)' : 'rgba(239, 68, 68, 0.50)';
        ctx.lineWidth = isLoHovered ? 1.75 : 1;
        ctx.setLineDash(isLoHovered ? [6, 3] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(xStart, yLo);
        ctx.lineTo(xEnd, yLo);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.restore();
      },

      afterDraw(chart) {
        // Left-margin pills: only show when hovering or pinned, never permanently pollute the chart margin
        const pf = chart.$rbHoveredPriorFib || chart.$rbPinnedPriorFib;
        if (!pf) return;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const ctx = chart.ctx;
        const compact = !!chart.$rbCompact;
        const d = chart.$rbDecimals ?? 2;
        const isHovered = !!(chart.$rbHoveredPriorFib || chart.$rbPinnedPriorFib);
        const isPinned = !!chart.$rbPinnedPriorFib && chart.$rbPinnedPriorFib === pf;
        const hoveredLevel = chart.$rbHoveredLevel;

        const items = [
          { key: 'high', val: pf.high, prefix: 'H', dotCol: '#22c55e', textCol: '#4ade80' },
          ...(pf.mid != null ? [{ key: 'mid', val: pf.mid, prefix: 'Mid', dotCol: '#38bdf8', textCol: '#7dd3fc' }] : []),
          { key: 'low', val: pf.low, prefix: 'L', dotCol: '#ef4444', textCol: '#f87171' },
        ];

        ctx.save();
        ctx.font = compact
          ? 'bold 9px Outfit, system-ui, sans-serif'
          : 'bold 9.5px Outfit, system-ui, sans-serif';

        const placedY = [];
        const minGap = compact ? 15 : 17;

        for (const item of items) {
          if (item.val == null || !Number.isFinite(item.val)) continue;
          let y = yScale.getPixelForValue(item.val);
          if (!Number.isFinite(y)) continue;
          if (y < area.top + 6 || y > area.bottom - 6) continue;

          for (let g = 0; g < 6; g++) {
            let hit = false;
            for (const py of placedY) {
              if (Math.abs(y - py) < minGap) {
                y += (y >= py ? minGap : -minGap);
                hit = true;
                break;
              }
            }
            if (!hit) break;
            y = Math.max(area.top + 8, Math.min(area.bottom - 8, y));
          }
          placedY.push(y);

          const isItemActive = isHovered && (hoveredLevel === item.key || hoveredLevel === 'box');
          const priceStr = Number(item.val).toFixed(d);
          const dayTag = (!compact && item.prefix === 'H' && pf.dayLabel) ? ` · ${pf.dayLabel}` : '';
          const pinTag = (isPinned && item.prefix === 'H') ? ' 📌' : '';
          const label = `${item.prefix} ${priceStr}${dayTag}${pinTag}`;
          const tw = ctx.measureText(label).width;
          const boxW = tw + 16;
          const boxH = compact ? 13 : 15;
          const boxX = area.left + (compact ? 3 : 5);
          const boxY = y - boxH / 2;

          // Subtle 0.55 opacity resting bookmark; bright 1.0 opacity when hovered/pinned!
          ctx.globalAlpha = isItemActive ? 1.0 : (isHovered ? 0.85 : 0.55);

          // Dark pill with subtle colored border
          ctx.fillStyle = isItemActive ? 'rgba(15, 23, 42, 0.98)' : 'rgba(15, 23, 42, 0.80)';
          ctx.strokeStyle = item.dotCol;
          ctx.lineWidth = isItemActive ? 1.5 : 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(boxX, boxY, boxW, boxH, 3);
          } else {
            ctx.rect(boxX, boxY, boxW, boxH);
          }
          ctx.fill();
          ctx.stroke();

          // Dot (Green for High, Cyan for Mid, Red for Low)
          ctx.fillStyle = item.dotCol;
          ctx.beginPath();
          ctx.arc(boxX + 6, y, isItemActive ? 3 : 2.5, 0, Math.PI * 2);
          ctx.fill();

          // Label text
          ctx.fillStyle = isItemActive ? '#ffffff' : item.textCol;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, boxX + 12, y);
        }

        ctx.restore();
      },
    };
  },

  /** Shaded First-Red Box (High, Median 0.50, and Low anchored from that Red Bar forward — matches Sagar's chart box). */
  _firstRed1hPlugin() {
    return {
      id: 'rbFirstRed1h',
      afterDatasetsDraw(chart) {
        if (chart.$rbShowFirstRed === false) return;
        const red = chart.$rbFirstRed1h;
        if (!red || red.isMarkWindow || red.high == null || red.low == null) return;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const compact = !!chart.$rbCompact;
        const d = chart.$rbDecimals ?? 2;

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

        const yHi = yScale.getPixelForValue(red.high);
        const yLo = yScale.getPixelForValue(red.low);
        const midVal = (red.high + red.low) / 2;
        const yMid = yScale.getPixelForValue(midVal);
        if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) return;

        const ctx = chart.ctx;
        ctx.save();

        // 1. Shaded Red Bar Box from x0 to right edge
        const boxTop = Math.max(area.top, Math.min(yHi, yLo));
        const boxBot = Math.min(area.bottom, Math.max(yHi, yLo));
        if (boxBot > boxTop) {
          ctx.fillStyle = 'rgba(244, 63, 94, 0.11)';
          ctx.fillRect(x0, boxTop, area.right - x0, boxBot - boxTop);
        }

        // 2. High, Median (0.50), and Low lines
        const rLbl = chart.$rbFirstRedLabel || 'Red';
        const fmtV = (v) => Number(v).toFixed(d === 0 ? 0 : (v % 1 === 0 ? 0 : d));
        const levels = [
          { v: red.high, y: yHi, style: 'rgba(244, 63, 94, 0.92)', w: 1.5, dash: [6, 3], txt: `🟥 ${rLbl} High ${fmtV(red.high)}`, pos: 'top' },
          { v: midVal, y: yMid, style: 'rgba(251, 191, 36, 0.78)', w: 1.15, dash: [3, 3], txt: `Mid ${fmtV(midVal)}`, pos: 'mid' },
          { v: red.low, y: yLo, style: 'rgba(244, 63, 94, 0.78)', w: 1.35, dash: [5, 3], txt: `🟥 ${rLbl} Low ${fmtV(red.low)}`, pos: 'bot' },
        ];
        ctx.font = compact
          ? 'bold 8px Outfit, system-ui, sans-serif'
          : 'bold 9px Outfit, system-ui, sans-serif';
        for (const lv of levels) {
          if (lv.v == null || !Number.isFinite(lv.y) || lv.y < area.top || lv.y > area.bottom) continue;
          ctx.strokeStyle = lv.style;
          ctx.lineWidth = lv.w;
          ctx.setLineDash(lv.dash);
          ctx.beginPath();
          ctx.moveTo(x0, lv.y);
          ctx.lineTo(area.right, lv.y);
          ctx.stroke();

          ctx.fillStyle = lv.style;
          ctx.textAlign = 'left';
          ctx.textBaseline = lv.pos === 'bot' ? 'top' : 'bottom';
          ctx.fillText(lv.txt, x0 + 6, lv.pos === 'bot' ? lv.y + 2 : lv.y - 2);
        }
        ctx.setLineDash([]);
        ctx.restore();
      },
    };
  },

  /**
   * Dr. Devendra Pratap Singh Setup 1: 5m Session X-Candle POB (0.44–0.56) corridor & Anchor Low (0.0) overlay.
   */
  _pobPlugin() {
    return {
      id: 'rbPobCorridor',
      afterDatasetsDraw(chart) {
        const pob = chart.$rbPobReject;
        if (!pob || (!pob.watching && !pob.triggered && pob.status !== 'await_retest')) return;
        if (pob.pobHi == null || pob.pobLo == null) return;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const ctx = chart.ctx;
        const compact = !!chart.$rbCompact;

        let x0 = area.left;
        const times = chart.$rbTimes;
        const xT = pob.xCandle?.t;
        if (xScale && Array.isArray(times) && times.length && xT != null && xT > times[0]) {
          const firstIdx = times.findIndex((t) => t >= xT - 15 * 60000);
          if (firstIdx >= 0) {
            const px = xScale.getPixelForValue(firstIdx);
            if (Number.isFinite(px)) x0 = Math.max(area.left, px);
          }
        }
        if (x0 >= area.right) return;

        const yHi = yScale.getPixelForValue(pob.pobHi);
        const yLo = yScale.getPixelForValue(pob.pobLo);
        if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) return;

        ctx.save();
        const top = Math.min(yHi, yLo);
        const h = Math.max(2, Math.abs(yLo - yHi));
        ctx.fillStyle = pob.triggered ? 'rgba(244, 63, 94, 0.14)' : 'rgba(168, 85, 247, 0.12)';
        ctx.fillRect(x0, top, area.right - x0, h);

        // POB 0.56 (SL ceiling) & POB 0.44 (entry edge)
        const lines = [
          { y: yHi, col: 'rgba(244, 63, 94, 0.85)', dash: [4, 3], txt: `POB 0.56 (SL) ${Number(pob.pobHi).toFixed(0)}` },
          { y: yLo, col: 'rgba(192, 132, 252, 0.90)', dash: [5, 3], txt: `POB 0.44 (Entry) ${Number(pob.pobLo).toFixed(0)}` },
        ];
        const anchorLow = pob.xCandle?.low ?? pob.xCandle?.l;
        if (anchorLow != null && Number.isFinite(anchorLow)) {
          lines.push({
            y: yScale.getPixelForValue(anchorLow),
            col: 'rgba(74, 222, 128, 0.80)',
            dash: [3, 3],
            txt: `X-Low (TP1) ${Number(anchorLow).toFixed(0)}`,
          });
        }
        ctx.font = compact
          ? 'bold 8px Outfit, system-ui, sans-serif'
          : 'bold 9px Outfit, system-ui, sans-serif';
        for (const ln of lines) {
          if (!Number.isFinite(ln.y) || ln.y < area.top || ln.y > area.bottom) continue;
          ctx.strokeStyle = ln.col;
          ctx.lineWidth = 1.25;
          ctx.setLineDash(ln.dash);
          ctx.beginPath();
          ctx.moveTo(x0, ln.y);
          ctx.lineTo(area.right, ln.y);
          ctx.stroke();
          ctx.fillStyle = ln.col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(ln.txt, x0 + 6, ln.y - 2);
        }
        ctx.setLineDash([]);
        ctx.restore();
      },
    };
  },

  /**
   * Dr. Devendra Pratap Singh Setup 3: 30m 5 EMA Rubber Band overlay (Barricade & 30m 5 EMA Target).
   */
  _setup3Plugin() {
    return {
      id: 'rbSetup3',
      afterDatasetsDraw(chart) {
        const s3 = chart.$rbSetup3;
        const hl = chart.$rbHoveredHorizLine;
        const hasS3 = !!(s3 && (s3.primed || s3.triggered));
        if (!hasS3 && !hl) return;
        const yScale = chart.scales.y;
        const area = chart.chartArea;
        if (!yScale || !area) return;
        const ctx = chart.ctx;
        const compact = !!chart.$rbCompact;
        const d = chart.$rbDecimals ?? 2;
        const hovId = hl?.id;

        ctx.save();
        ctx.font = compact
          ? 'bold 8.5px Outfit, system-ui, sans-serif'
          : 'bold 9.5px Outfit, system-ui, sans-serif';

        if (hasS3) {
          const yB = (s3.barricade != null && Number.isFinite(s3.barricade))
            ? yScale.getPixelForValue(s3.barricade)
            : null;
          const yEma = (s3.ema5 != null && Number.isFinite(s3.ema5))
            ? yScale.getPixelForValue(s3.ema5)
            : null;
          const closeTogether = (yB != null && yEma != null && Math.abs(yB - yEma) < 18);

          // 1. Barricade level line (Amber dotted) — label aligned on the RIGHT near live candles
          if (yB != null && Number.isFinite(yB) && yB >= area.top && yB <= area.bottom) {
            const isHov = hovId === 's3_barricade';
            ctx.strokeStyle = isHov ? 'rgba(251, 191, 36, 1)' : 'rgba(251, 191, 36, 0.85)';
            ctx.lineWidth = isHov ? 2.4 : 1.35;
            ctx.setLineDash(isHov ? [6, 3] : [4, 3]);
            ctx.beginPath();
            ctx.moveTo(area.left, yB);
            ctx.lineTo(area.right, yB);
            ctx.stroke();

            const labelB = `🚧 Barricade ${Number(s3.barricade).toFixed(d === 0 ? 0 : (s3.barricade % 1 === 0 ? 0 : d))}`;
            ctx.fillStyle = isHov ? '#fde68a' : 'rgba(251, 191, 36, 0.96)';
            ctx.textAlign = 'right';
            // If Barricade and 5 EMA lines are very close, place the upper label above its line and lower label below its line
            const putBelow = closeTogether && yB > yEma;
            ctx.textBaseline = putBelow ? 'top' : 'bottom';
            ctx.fillText(labelB, area.right - 8, putBelow ? yB + 3 : yB - 3);
          }

          // 2. 30m 5 EMA Target line (Cyan dashed) — label aligned on the RIGHT near live candles
          if (yEma != null && Number.isFinite(yEma) && yEma >= area.top && yEma <= area.bottom) {
            const isHov = hovId === 's3_ema5';
            ctx.strokeStyle = isHov ? 'rgba(56, 189, 248, 1)' : 'rgba(56, 189, 248, 0.85)';
            ctx.lineWidth = isHov ? 2.4 : 1.35;
            ctx.setLineDash(isHov ? [8, 3] : [6, 4]);
            ctx.beginPath();
            ctx.moveTo(area.left, yEma);
            ctx.lineTo(area.right, yEma);
            ctx.stroke();

            const labelEma = `🧲 30m 5 EMA Target ${Number(s3.ema5).toFixed(d === 0 ? 0 : (s3.ema5 % 1 === 0 ? 0 : d))}`;
            ctx.fillStyle = isHov ? '#bae6fd' : 'rgba(56, 189, 248, 0.96)';
            ctx.textAlign = 'right';
            const putBelow = closeTogether && yEma >= yB;
            ctx.textBaseline = putBelow ? 'top' : 'bottom';
            ctx.fillText(labelEma, area.right - 8, putBelow ? yEma + 3 : yEma - 3);
          }
        }

        // 3. If user is hovering ANY horizontal setup/level line, draw a crisp highlight line + floating badge at cursor
        if (hl && Number.isFinite(hl.value)) {
          const yH = yScale.getPixelForValue(hl.value);
          if (Number.isFinite(yH) && yH >= area.top - 2 && yH <= area.bottom + 2) {
            ctx.strokeStyle = hl.color || '#38bdf8';
            ctx.lineWidth = 2.2;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            ctx.moveTo(area.left, yH);
            ctx.lineTo(area.right, yH);
            ctx.stroke();
            ctx.setLineDash([]);

            const pillText = `${hl.title}: ${Number(hl.value).toFixed(d)} (${hl.diffStr})`;
            ctx.font = compact
              ? 'bold 9.5px Outfit, system-ui, sans-serif'
              : 'bold 10.5px Outfit, system-ui, sans-serif';
            const tw = ctx.measureText(pillText).width;
            const padX = 8;
            const boxW = tw + padX * 2;
            const boxH = compact ? 18 : 20;
            const rawX = Number.isFinite(hl.evX) ? hl.evX - boxW / 2 : (area.left + area.right - boxW) / 2;
            const boxX = Math.max(area.left + 6, Math.min(area.right - boxW - 6, rawX));
            const boxY = (yH - boxH - 6 >= area.top + 4) ? (yH - boxH - 6) : (yH + 6);

            ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
            ctx.strokeStyle = hl.color || '#38bdf8';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(boxX, boxY, boxW, boxH, 5);
            } else {
              ctx.rect(boxX, boxY, boxW, boxH);
            }
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(pillText, boxX + padX, boxY + boxH / 2);
          }
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

  _getPrimeWindowStatus(nowMs = Date.now(), instId = null) {
    const d = new Date(nowMs);
    const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes() + (d.getUTCSeconds() / 60);
    const istMins = (utcMins + 330) % 1440;

    const formatLocal = (istMinute) => {
      const utcMinute = (istMinute - 330 + 1440) % 1440;
      const ref = new Date(nowMs);
      ref.setUTCHours(Math.floor(utcMinute / 60), Math.round(utcMinute % 60), 0, 0);
      return ref.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    const isUserIst = (() => {
      try {
        return new Date().getTimezoneOffset() === -330;
      } catch (_) {
        return false;
      }
    })();

    const userTzName = (() => {
      try {
        const parts = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date(nowMs));
        const val = parts.find((p) => p.type === 'timeZoneName')?.value;
        if (val) return val;
        if (isUserIst) return 'IST';
        const offset = new Date().getTimezoneOffset();
        const h = -Math.floor(offset / 60);
        const m = Math.abs(offset % 60);
        return `GMT${h >= 0 ? '+' : ''}${h}${m ? ':' + m : ''}`;
      } catch (_) {
        return isUserIst ? 'IST' : 'Local';
      }
    })();

    const nyOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 9, 30);
    const lonOpenMins = this._getSessionOpenMins(nowMs, 'Europe/London', 8, 0);
    const fmtMins = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;

    const instUpper = String(instId || this.activeInstrument()?.id || '').toUpperCase();
    const isNifty = instUpper === 'NIFTY';
    const isXau = instUpper === 'XAU';
    const isNg = instUpper === 'NG';
    const comexOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 8, 30);
    const nymexOpenMins = this._getSessionOpenMins(nowMs, 'America/New_York', 9, 0);
    const windows = isNifty ? [
      {
        id: 'nse_open',
        name: 'NSE Open · 5m POB & Trade 1',
        code: 'NSE OPEN',
        startIstMins: 555,   // 09:15 IST
        endIstMins: 735,     // 12:15 IST
        startStrIst: '09:15',
        endStrIst: '12:15',
        winRate: '94.9% 2Y POB WR',
        headline: 'Dr. Dev 09:15 5m X-Candle POB & 1H Trade 1',
        rule: 'First 5m red @ 09:15 = X-Candle → retest POB 44–56 → SHORT reject (Fill@0.44, SL@0.56, TP1 Anchor Low) or 1H Trade 1 leave'
      },
      {
        id: 'nse_hunt',
        name: '12:45 PM Liquidity Hunt',
        code: '12:45 HUNT',
        startIstMins: 735,   // 12:15 IST
        endIstMins: 795,     // 13:15 IST
        startStrIst: '12:15',
        endStrIst: '13:15',
        winRate: 'Dr. Dev Stop Hunt',
        headline: 'Midday Institutional Liquidity Sweep',
        rule: 'Flatten morning POB scalps by 12:45 PM; institutions hunt morning High/Low before European desks open'
      },
      {
        id: 'nse_close',
        name: 'NSE Close Mark Window',
        code: 'CLOSE FIB',
        startIstMins: 915,   // 15:15 IST
        endIstMins: 945,     // 15:45 IST
        startStrIst: '15:15',
        endStrIst: '15:45',
        winRate: 'Fib 0–1 Anchor',
        headline: 'Closing Range Fib Anchor (15:15–15:45 IST)',
        rule: 'High/Low wicks of 15:15–15:45 IST lock the Fib 0, POB 44–56, and Fib 1 levels for the next NSE session'
      }
    ] : isNg ? [
      {
        id: 'mcx_open',
        name: 'MCX Morning Open · POB & 30m Red',
        code: 'MCX DAY',
        startIstMins: 540,   // 09:00 IST
        endIstMins: 720,     // 12:00 IST
        startStrIst: '09:00',
        endStrIst: '12:00',
        winRate: 'Trikal Morning Open',
        headline: 'MCX 09:00 5m X-Candle POB & 30m First Red',
        rule: 'First 5m red @ 09:00 = X-Candle → POB 44–56 retest SHORT, plus 30m First Red Trade 1 / Trade 2 anchor'
      },
      {
        id: 'mcx_eve',
        name: 'MCX Evening · 5 PM Energy Open',
        code: 'MCX EVE',
        startIstMins: 1020,  // 17:00 IST
        endIstMins: 1110,    // 18:30 IST
        startStrIst: '17:00',
        endStrIst: '18:30',
        winRate: 'Dr. Dev 5 PM Energy Slot',
        headline: 'European / MCX Evening Liquidity Injection',
        rule: 'Dr. Dev 5:00 PM IST commodity window: 5m X-Candle POB 44–56 & MCX Day High/Low liquidity sweep'
      },
      {
        id: 'nymex',
        name: 'US NYMEX Pit Open',
        code: 'NYMEX',
        startIstMins: nymexOpenMins,
        endIstMins: nymexOpenMins + 120,
        startStrIst: fmtMins(nymexOpenMins),
        endStrIst: fmtMins(nymexOpenMins + 120),
        winRate: 'Peak NatGas Volatility',
        headline: 'US NYMEX Open & 23:00–23:30 IST Close Fib',
        rule: 'NYMEX 09:00 ET pit open drives largest Natural Gas impulse; 23:00–23:30 IST locks next day Mark Fibs'
      }
    ] : isXau ? [
      {
        id: 'xau_asia',
        name: 'Asia Bullion Open',
        code: 'ASIA',
        startIstMins: 330,   // 05:30 IST
        endIstMins: 510,     // 08:30 IST
        startStrIst: '05:30',
        endStrIst: '08:30',
        winRate: 'Brahmastra Asia Open',
        headline: '01:30–02:30 Mark Fib + 05:30 POB & 30m Red',
        rule: 'After 01:30–02:30 IST Mark Fibs lock, watch 30m First Red Trade 1/2 & 05:30 IST 5m X-Candle POB 44–56'
      },
      {
        id: 'xau_london',
        name: 'London Bullion / LBMA Open',
        code: 'LONDON',
        startIstMins: lonOpenMins,
        endIstMins: lonOpenMins + 120,
        startStrIst: fmtMins(lonOpenMins),
        endStrIst: fmtMins(lonOpenMins + 120),
        winRate: 'Brahmastra LBMA Sweep',
        headline: 'London Bullion Liquidity Sweep & POB',
        rule: 'London sweeps Asia Bullion H/L; watch 5m X-Candle POB 44–56 & 30m First Red Trade 2 revisit'
      },
      {
        id: 'xau_comex',
        name: 'US COMEX / NY Bullion Open',
        code: 'COMEX',
        startIstMins: comexOpenMins,
        endIstMins: comexOpenMins + 150,
        startStrIst: fmtMins(comexOpenMins),
        endStrIst: fmtMins(comexOpenMins + 150),
        winRate: 'Peak Gold Volatility',
        headline: 'COMEX 08:30 ET & NY Cash Open Window',
        rule: 'Dr. Dev Brahmastra prime window: COMEX open hunts London H/L + 5m X-Candle POB 44–56 + 30m 5 EMA Rubber Band'
      }
    ] : [
      {
        id: 'asia',
        name: 'Asia Open / Daily Open',
        code: 'ASIA',
        startIstMins: 330,   // 05:30 IST
        endIstMins: 420,     // 07:00 IST
        startStrIst: '05:30',
        endStrIst: '07:00',
        winRate: '71.7% Session Extreme',
        headline: 'Daily Open Discovery Window',
        rule: '71.7% of days print Asia high/low in first 90m; 05:30 IST 5m X-Candle POB 44–56 & 1H Trade 1'
      },
      {
        id: 'london',
        name: 'London Open Window',
        code: 'LON',
        startIstMins: lonOpenMins,
        endIstMins: lonOpenMins + 75,
        startStrIst: fmtMins(lonOpenMins),
        endStrIst: fmtMins(lonOpenMins + 75),
        winRate: '62.7% Session Extreme',
        headline: 'European Opening Liquidity Window',
        rule: '62.7% of days print London high/low in first 45m; sweeps Asia H/L + London 5m X-Candle POB 44–56'
      },
      {
        id: 'ny',
        name: 'New York Open Window',
        code: 'NY',
        startIstMins: nyOpenMins,
        endIstMins: nyOpenMins + 75,
        startStrIst: fmtMins(nyOpenMins),
        endStrIst: fmtMins(nyOpenMins + 75),
        winRate: '56.0% Session Extreme',
        headline: 'US Cash Open Window',
        rule: '56.0% of days print NY high/low in first 45m; NY 5m X-Candle POB 44–56 (86.2% 2Y WR) & 1H Trade 2'
      }
    ];

    let active = null;
    for (const w of windows) {
      if (istMins >= w.startIstMins && istMins <= w.endIstMins) {
        const remMins = Math.round(w.endIstMins - istMins);
        const remH = Math.floor(remMins / 60);
        const remM = remMins % 60;
        const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;
        active = {
          ...w,
          remMins,
          remStr,
          localStart: formatLocal(w.startIstMins),
          localEnd: formatLocal(w.endIstMins),
          userTzName
        };
        break;
      }
    }

    let next = null;
    let minWait = Infinity;
    for (const w of windows) {
      let waitMins = w.startIstMins - istMins;
      if (waitMins < 0) waitMins += 1440;
      if (waitMins < minWait) {
        minWait = waitMins;
        const waitHours = Math.floor(waitMins / 60);
        const waitRemMins = Math.round(waitMins % 60);
        const waitStr = waitHours > 0 ? `${waitHours}h ${waitRemMins}m` : `${waitRemMins}m`;
        next = {
          ...w,
          waitMins: Math.round(waitMins),
          waitHours,
          waitRemMins,
          waitStr,
          isApproaching: waitMins <= 45,
          localStart: formatLocal(w.startIstMins),
          localEnd: formatLocal(w.endIstMins),
          userTzName
        };
      }
    }

    const allWindows = windows.map((w) => {
      const localStart = formatLocal(w.startIstMins);
      const localEnd = formatLocal(w.endIstMins);
      const isCurrent = active?.id === w.id;
      let rawWaitMins = w.startIstMins - istMins;
      if (rawWaitMins < 0) rawWaitMins += 1440;
      const waitMins = Math.round(rawWaitMins);
      const waitHours = Math.floor(waitMins / 60);
      const waitRemMins = waitMins % 60;
      const waitStr = waitHours > 0 ? `in ${waitHours}h ${waitRemMins}m` : (waitMins <= 0 ? 'starting now' : `in ${waitMins}m`);
      const waitDisplayStr = waitMins <= 0 ? 'starting now' : `in ${waitMins}m`;
      return {
        ...w,
        localStart,
        localEnd,
        userTzName,
        isUserIst,
        isCurrent,
        waitMins,
        waitStr: isCurrent ? `ACTIVE NOW (${active.remStr} left)` : waitStr,
        statusBadge: isCurrent
          ? `<span style="background:#22c55e;color:#022c22;font-weight:700;font-size:10px;padding:2px 6px;border-radius:4px;">🔥 ACTIVE NOW</span>`
          : waitMins <= 45
            ? `<span style="background:#f59e0b;color:#451a03;font-weight:700;font-size:10px;padding:2px 6px;border-radius:4px;">⚠️ ${waitDisplayStr}</span>`
            : `<span style="background:rgba(255,255,255,0.06);color:#94a3b8;font-size:10.5px;padding:2px 6px;border-radius:4px;">${waitStr}</span>`
      };
    });

    return { active, next, allWindows, userTzName, isUserIst };
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
    // Crisp TradingView/Binance-style candle density; ◀ ▶ buttons and pinch allow smooth scrub
    const wantDesktop = (c.chartBars && c.chartBars[tf]) || 100;
    const wantMobile = (c.chartBarsMobile && c.chartBarsMobile[tf])
      || ({ '5m': 56, '15m': 48, '30m': 48, '1h': 42 }[tf] || 48);
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

    const priceNow = Number(o.price);
    const action = row.action || this._actionPlan(o, row.emaAgree);

    // Identify trend-targeted prior Fib box (where price is heading to touch and reverse/TP)
    const todayDayKey = sortedBandDays.length ? sortedBandDays[sortedBandDays.length - 1] : null;
    const todayBand = (todayDayKey ? byDay.get(todayDayKey) : null) || o.currentBand || null;
    const todayHi = todayBand ? Number(todayBand.f1 ?? todayBand.high) : null;
    const todayLo = todayBand ? Number(todayBand.f0 ?? todayBand.low) : null;
    const todayMid = todayBand ? Number(todayBand.f50 ?? todayBand.mid ?? ((todayHi != null && todayLo != null) ? (todayHi + todayLo) / 2 : null)) : null;

    const dPrice = row.feedPriceDecimals != null ? row.feedPriceDecimals : (inst.priceDecimals ?? 2);
    const feedCur = String(row.feedCurrency || inst.currency || '').toUpperCase();
    const curSign = (feedCur === 'INR' || (feedCur !== 'USD' && (String(inst.id || '').toUpperCase() === 'NIFTY' || String(inst.id || '').toUpperCase() === 'NG')))
      ? '₹'
      : '$';
    const getFibSummaryHtml = (pinnedOrHovered) => {
      const pf = pinnedOrHovered;
      if (pf) {
        const dayStr = pf.dayLabel ? ` (${pf.dayLabel})` : '';
        return ` · <span style="color:#64748b;">Prev Fib${dayStr}:</span> <span style="color:#4ade80;">H ${curSign}${Number(pf.high).toFixed(dPrice)}</span> <span style="color:#38bdf8;">Mid ${curSign}${Number(pf.mid).toFixed(dPrice)}</span> <span style="color:#f87171;">L ${curSign}${Number(pf.low).toFixed(dPrice)}</span>`;
      }
      if (todayBand && todayHi != null && todayLo != null) {
        const pLo = todayBand.f44 != null ? Number(todayBand.f44).toFixed(dPrice) : null;
        const pHi = todayBand.f56 != null ? Number(todayBand.f56).toFixed(dPrice) : null;
        const pobStr = (pLo && pHi) ? ` <span style="color:#a78bfa;" title="Point of Balance 44–56%">POB ${curSign}${pLo}–${curSign}${pHi}</span>` : '';
        const midStr = todayMid != null ? ` <span style="color:#38bdf8;">Mid ${curSign}${Number(todayMid).toFixed(dPrice)}</span>` : '';
        return ` · <span style="color:#64748b;">Today's Fib:</span> <span style="color:#4ade80;">H ${curSign}${Number(todayHi).toFixed(dPrice)}</span>${pobStr}${midStr} <span style="color:#f87171;">L ${curSign}${Number(todayLo).toFixed(dPrice)}</span>`;
      }
      return '';
    };

    let priorFibInfo = null;
    let priorCandidates = [];
    if (sortedBandDays.length >= 2) {
      // Determine trend direction
      // If price is above today's band, trend is heading UP
      // If price is below today's band, trend is heading DOWN
      // If inside today's band, use bias / action side / EMA agree
      let trendDir = 'UP';
      if (todayHi != null && priceNow > todayHi) {
        trendDir = 'UP';
      } else if (todayLo != null && priceNow < todayLo) {
        trendDir = 'DOWN';
      } else {
        const isBull = (row.bias === 'BULLISH' || o.trend === 'BULLISH' || action?.side === 'LONG' || (todayMid != null && priceNow >= todayMid));
        trendDir = isBull ? 'UP' : 'DOWN';
      }

      // Collect all completed prior days
      for (let i = 0; i < sortedBandDays.length - 1; i++) {
        const dayKey = sortedBandDays[i];
        const b = byDay.get(dayKey);
        if (!b) continue;
        const pHi = Number(b.f1 ?? b.high);
        const pLo = Number(b.f0 ?? b.low);
        const pMid = b.f50 != null ? Number(b.f50) : (b.mid != null ? Number(b.mid) : ((pHi + pLo) / 2));
        if (!Number.isFinite(pHi) || !Number.isFinite(pLo)) continue;
        const dayParts = String(dayKey).split('-');
        const dayLabel = dayParts.length === 3
          ? `${parseInt(dayParts[2], 10)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(dayParts[1], 10) - 1] || ''}`
          : dayKey;
        const mappedPrior = dayBands.find((db) => db.day === dayKey) || b;
        priorCandidates.push({
          dayKey,
          dayLabel,
          band: mappedPrior,
          high: pHi,
          low: pLo,
          mid: pMid,
          f44: b.f44,
          f56: b.f56,
          recencyIndex: i, // higher = more recent
          trendDir: (pHi >= priceNow ? 'UP' : 'DOWN'),
        });
      }

      let selected = null;
      if (priorCandidates.length > 0) {
        if (trendDir === 'UP') {
          // Look for overhead prior Fib boxes (where high or mid is >= priceNow)
          const overhead = priorCandidates.filter((c) => c.high >= priceNow || (c.mid != null && c.mid >= priceNow));
          if (overhead.length > 0) {
            // Find the lowest overhead box (the immediate ceiling target price will touch first)
            // If two are close (within 0.4%), prefer the more recent one
            overhead.sort((a, b) => {
              const aEntry = Math.max(0, a.low - priceNow);
              const bEntry = Math.max(0, b.low - priceNow);
              if (Math.abs(aEntry - bEntry) / priceNow < 0.004) {
                return b.recencyIndex - a.recencyIndex; // prefer more recent
              }
              return aEntry - bEntry;
            });
            selected = overhead[0];
          }
        } else {
          // Look for underhead prior Fib boxes (where low or mid is <= priceNow)
          const underhead = priorCandidates.filter((c) => c.low <= priceNow || (c.mid != null && c.mid <= priceNow));
          if (underhead.length > 0) {
            // Find the highest underhead box (the immediate floor target price will touch first)
            // If two are close (within 0.4%), prefer the more recent one
            underhead.sort((a, b) => {
              const aEntry = Math.max(0, priceNow - a.high);
              const bEntry = Math.max(0, priceNow - b.high);
              if (Math.abs(aEntry - bEntry) / priceNow < 0.004) {
                return b.recencyIndex - a.recencyIndex; // prefer more recent
              }
              return aEntry - bEntry;
            });
            selected = underhead[0];
          }
        }

        // Fallback if no directional candidate found:
        // Pick candidate with smallest distance to priceNow
        if (!selected) {
          priorCandidates.sort((a, b) => {
            const distA = Math.min(Math.abs(priceNow - a.high), Math.abs(priceNow - a.low), Math.abs(priceNow - (a.mid ?? a.high)));
            const distB = Math.min(Math.abs(priceNow - b.high), Math.abs(priceNow - b.low), Math.abs(priceNow - (b.mid ?? b.high)));
            return distA - distB;
          });
          selected = priorCandidates[0];
        }
      }

      if (selected) {
        const distHi = Math.abs(priceNow - selected.high) / priceNow * 100;
        const distLo = Math.abs(priceNow - selected.low) / priceNow * 100;
        const distMid = selected.mid != null ? Math.abs(priceNow - selected.mid) / priceNow * 100 : Infinity;
        const isInside = priceNow >= Math.min(selected.low, selected.high) && priceNow <= Math.max(selected.low, selected.high);
        const minDist = Math.min(distHi, distLo, distMid);
        const mappedPrior = dayBands.find((b) => b.day === selected.dayKey) || selected.band;
        priorFibInfo = {
          band: mappedPrior,
          dayKey: selected.dayKey,
          dayLabel: selected.dayLabel,
          high: selected.high,
          low: selected.low,
          mid: selected.mid,
          f44: selected.f44,
          f56: selected.f56,
          minDist,
          isInside,
          trendDir,
        };
      }
    }

    // Fit Y to recent visible candles + nearby active levels so far-away historical wicks
    // never crush today's candles into a flat horizontal ribbon (especially on mobile)
    const focusBars = bars.slice(-Math.min(bars.length, compact ? 36 : 72));
    const focusHi = Math.max(...focusBars.map((b) => b.h));
    const focusLo = Math.min(...focusBars.map((b) => b.l));
    const focusSpan = Math.max(focusHi - focusLo, priceNow * 0.0025);
    const maxLevelReach = Math.max(focusSpan * (compact ? 1.35 : 1.85), priceNow * (compact ? 0.009 : 0.015));

    const barHi = compact ? focusHi : Math.max(...bars.map((b) => b.h));
    const barLo = compact ? focusLo : Math.min(...bars.map((b) => b.l));
    const bandPrices = dayBands.flatMap((b) => (
      (b.style === 'sessionFib' || b.style === 'istFib0230')
        ? [b.f0, b.f44, b.f50, b.f56, b.f1]
        : [b.high, b.low, b.mid]
    ))
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number);
    const rawNearLevels = [
      o.currentBand?.high, o.currentBand?.low,
      o.invalidation, o.bookZone,
      o.firstRed1h?.high, o.firstRed1h?.low,
      o.refs?.priorDayHigh, o.refs?.priorDayLow,
      o.refs?.asiaHigh, o.refs?.asiaLow,
      o.refs?.londonHigh, o.refs?.londonLow,
      ...bandPrices,
    ].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
    // Only expand initial Y-scale for levels within reasonable reach of current price action
    // (levels further away are still drawn if you zoom out or pan ▲/▼)
    const nearLevels = rawNearLevels.filter((v) => v >= focusLo - maxLevelReach && v <= focusHi + maxLevelReach);
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
      ema5: '#c084fc',
      ema10: '#22d3ee',
      ema30: '#f97316',
      or: '#eab308',
      bandResist: '#a855f7',
      bandSupport: '#2dd4bf',
      stop: '#ef4444',
      exit: '#4ade80',
    };

    const trading = action?.side === 'LONG' || action?.side === 'SHORT';
    const stopPx = trading ? (action.stop ?? o.invalidation) : null;
    const exitPx = trading ? (action.exit ?? o.bookZone) : null;

    // On 30m chart, compute Dr. Dev's 5 EMA (Rubber Band Mean Reversion line)
    let ema5Slice = null;
    if (tf === '30m') {
      const fullCloses = isRenkoMode ? bars.map((b) => b.c) : row.bars.map((b) => b.c);
      const fullEma5 = this._emaSeries(fullCloses, 5);
      ema5Slice = isRenkoMode ? fullEma5 : fullEma5.slice(visStart, visStart + bars.length);
    }

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
      ...(ema5Slice ? [{
        label: 'EMA 5 (30m Rubber Band)',
        data: ema5Slice,
        borderColor: COL.ema5,
        borderWidth: 1.75,
        borderDash: [4, 2],
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 2,
      }] : []),
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
    // priceNow declared above
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

    if (action.isFibMagnet) {
      if (action.tp1 != null) {
        pushTag('🧲 FIB TARGET', action.tp1, '#38bdf8', 'rgba(8, 47, 73, 0.94)', { priority: true });
      }
    } else if (row.sessionTell?.targetPrice != null && Number.isFinite(row.sessionTell.targetPrice)) {
      const tagLabel = row.sessionTell.type === 'bullish' ? '🧲 FIB 0.0' : '🧲 FIB 1.0';
      pushTag(tagLabel, row.sessionTell.targetPrice, '#38bdf8', 'rgba(8, 47, 73, 0.94)', { rank: 2 });
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

    // Binance / Dhan-style Viewport Lock:
    // Preserve user's X and Y zoom/pan across background auto-refreshes on the same instrument + timeframe
    const viewKey = `${inst.id || priceLabel}:${tf}:${this.state.chartMode || 'candles'}`;
    let savedXMin = undefined;
    let savedXMax = undefined;
    let savedYMin = yLo - pad;
    let savedYMax = yHi + pad;
    let preservedUserZoom = false;
    let isSameView = false;

    if (this._forceResetZoom) {
      this._forceResetZoom = false;
    } else if (this._chart && this._chart.$rbViewKey === viewKey) {
      isSameView = true;
      const prevX = this._chart.scales?.x;
      const prevY = this._chart.scales?.y;
      const prevN = this._chart.$rbBars?.length || n;
      const wasZoomed = !!(
        this._chart.$rbUserZoomed
        || (this._chart.isZoomedOrPanned && this._chart.isZoomedOrPanned())
        || (prevX && (prevX.min > 0.5 || prevX.max < prevN - 1.5))
      );
      if (wasZoomed && prevX && Number.isFinite(prevX.min) && Number.isFinite(prevX.max)) {
        preservedUserZoom = true;
        const visCount = Math.max(8, prevX.max - prevX.min);
        const atRightEdge = (prevN - 1 - prevX.max) <= 1.5;
        if (atRightEdge) {
          // User was zoomed in at the live right edge — keep the exact bar count anchored to latest candle
          savedXMax = n - 1;
          savedXMin = Math.max(0, Math.round(n - 1 - visCount));
        } else {
          // User panned back in history — keep the same timestamp window locked
          const prevTimes = this._chart.$rbTimes || [];
          const prevStartTs = prevTimes[Math.max(0, Math.round(prevX.min))];
          let matchedIdx = prevStartTs != null ? times.findIndex((t) => t >= prevStartTs) : -1;
          if (matchedIdx < 0) matchedIdx = Math.max(0, Math.min(n - 1, Math.round(prevX.min)));
          savedXMin = matchedIdx;
          savedXMax = Math.min(n - 1, Math.round(matchedIdx + visCount));
        }
        if (prevY && Number.isFinite(prevY.min) && Number.isFinite(prevY.max)) {
          savedYMin = prevY.min;
          savedYMax = prevY.max;
        }
      }
    }

    this.destroyChart();
    this._chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      plugins: [
        this._bandZonesPlugin(),
        this._priorFibPlugin(),
        this._firstRed1hPlugin(),
        this._pobPlugin(),
        this._setup3Plugin(),
        this._candlePlugin(),
        this._sessionPlugin(),
        this._levelTagsPlugin(),
      ],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: (compact || isSameView) ? 0 : 280 },
        interaction: { mode: 'index', intersect: false },
        events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
        onClick: (event, activeElements) => {
          const elInfo = document.getElementById('rbCandleInfo');
          const d = inst.priceDecimals ?? 2;
          const yScale = this._chart?.scales?.y;
          const area = this._chart?.chartArea;

          let evX = event.x;
          let evY = event.y;
          if ((evY == null || evX == null) && event.native) {
            const t = event.native.touches?.[0] || event.native.changedTouches?.[0];
            if (t && event.native.target) {
              const rect = event.native.target.getBoundingClientRect();
              evX = t.clientX - rect.left;
              evY = t.clientY - rect.top;
            } else {
              evX = event.native.offsetX;
              evY = event.native.offsetY;
            }
          }

          // Check if tap was in empty space near a prior Fib or on a pill
          let tappedCand = null;
          let tappedLevel = 'box';
          if (yScale && area && evY != null && evX != null) {
            const candidates = this._chart?.$rbPriorCandidates || (priorFibInfo ? [priorFibInfo] : []);
            for (const cand of candidates) {
              const yHi = yScale.getPixelForValue(cand.high);
              const yLo = yScale.getPixelForValue(cand.low);
              const yMid = cand.mid != null ? yScale.getPixelForValue(cand.mid) : null;
              if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) continue;
              const topY = Math.min(yHi, yLo);
              const botY = Math.max(yHi, yLo);
              const padY = compact ? 28 : 22;

              if (evY >= topY - padY && evY <= botY + padY) {
                tappedCand = cand;
                const dHi = Math.abs(evY - yHi);
                const dMid = yMid != null ? Math.abs(evY - yMid) : Infinity;
                const dLo = Math.abs(evY - yLo);
                const minLineDist = Math.min(dHi, dMid, dLo);
                if (minLineDist <= (compact ? 24 : 16)) {
                  if (dHi <= minLineDist) tappedLevel = 'high';
                  else if (dMid <= minLineDist) tappedLevel = 'mid';
                  else tappedLevel = 'low';
                } else {
                  tappedLevel = 'box';
                }
                break;
              }
            }
          }

          if (tappedCand) {
            // If already pinned to this candidate & level, toggle off
            if (this._chart.$rbPinnedPriorFib === tappedCand && (!tappedLevel || this._chart.$rbHoveredLevel === tappedLevel)) {
              this._chart.$rbPinnedPriorFib = null;
              this._chart.$rbHoveredPriorFib = null;
              this._chart.$rbHoveredLevel = null;
              this._chart.$rbHoveredKey = null;
              try { this._chart.draw(); } catch (_) { try { this._chart.update('none'); } catch (_) {} }
              if (elInfo && bars && bars.length) {
                const last = bars[bars.length - 1];
                const chg = ((last.c - last.o) / last.o) * 100;
                const arrow = chg >= 0 ? '▲' : '▼';
                const sign = chg >= 0 ? '+' : '';
                const col = chg >= 0 ? '#4ade80' : '#f87171';
                const dayStr = priorFibInfo?.dayLabel ? ` (${priorFibInfo.dayLabel})` : '';
                const pfSummary = priorFibInfo ? ` · <span style="color:#64748b;">Prev Fib${dayStr}:</span> <span style="color:#4ade80;">H $${Number(priorFibInfo.high).toFixed(d)}</span> <span style="color:#38bdf8;">Mid $${Number(priorFibInfo.mid).toFixed(d)}</span> <span style="color:#f87171;">L $${Number(priorFibInfo.low).toFixed(d)}</span>` : '';
                elInfo.innerHTML = `<span style="color:#94a3b8;">Live:</span> <strong style="color:${col};">$${Number(last.c).toFixed(d)} (${arrow} ${sign}${chg.toFixed(2)}%)</strong> <span style="color:#64748b;">H: $${Number(last.h).toFixed(d)} · L: $${Number(last.l).toFixed(d)}</span>${pfSummary}`;
              }
              return;
            }

            // Lock/pin onto this prior Fib
            this._chart.$rbPinnedPriorFib = tappedCand;
            this._chart.$rbHoveredPriorFib = tappedCand;
            this._chart.$rbHoveredLevel = tappedLevel;
            this._chart.$rbHoveredKey = `${tappedCand.dayKey}:${tappedLevel}`;
            try { this._chart.draw(); } catch (_) { try { this._chart.update('none'); } catch (_) {} }

            if (elInfo) {
              const dayStr = tappedCand.dayLabel ? ` (${tappedCand.dayLabel})` : '';
              let priceTxt = '';
              if (tappedLevel === 'high') {
                const diffPct = ((tappedCand.high - priceNow) / priceNow * 100);
                priceTxt = `<strong style="color:#4ade80;background:rgba(34,197,94,0.18);padding:1px 6px;border-radius:4px;">🎯 Prev Fib${dayStr} High: $${Number(tappedCand.high).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (tappedLevel === 'mid') {
                const diffPct = ((tappedCand.mid - priceNow) / priceNow * 100);
                priceTxt = `<strong style="color:#38bdf8;background:rgba(56,189,248,0.18);padding:1px 6px;border-radius:4px;">🎯 Prev Fib${dayStr} Median: $${Number(tappedCand.mid).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (tappedLevel === 'low') {
                const diffPct = ((tappedCand.low - priceNow) / priceNow * 100);
                priceTxt = `<strong style="color:#f87171;background:rgba(239,68,68,0.18);padding:1px 6px;border-radius:4px;">🎯 Prev Fib${dayStr} Low: $${Number(tappedCand.low).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else {
                priceTxt = `<strong style="color:#38bdf8;background:rgba(56,189,248,0.18);padding:1px 6px;border-radius:4px;">🎯 Prev Fib Box${dayStr}: $${Number(tappedCand.low).toFixed(d)} – $${Number(tappedCand.high).toFixed(d)}</strong>`;
              }
              const role = tappedCand.trendDir === 'UP' ? 'Overhead Target' : 'Underhead Target';
              elInfo.innerHTML = `${priceTxt} <span style="color:#94a3b8;font-size:10px;">(${role} · Tap to clear)</span>`;
            }
            return;
          }

          // Tapped elsewhere (on candles or outside) -> unpin
          if (this._chart.$rbPinnedPriorFib) {
            this._chart.$rbPinnedPriorFib = null;
            this._chart.$rbHoveredPriorFib = null;
            this._chart.$rbHoveredLevel = null;
            this._chart.$rbHoveredKey = null;
            try { this._chart.draw(); } catch (_) { try { this._chart.update('none'); } catch (_) {} }
          }
        },
        onHover: (event, activeElements) => {
          const elInfo = document.getElementById('rbCandleInfo');
          if (!elInfo) return;
          const d = inst.priceDecimals ?? 2;
          let evX = event.x;
          let evY = event.y;
          if ((evY == null || evX == null) && event.native) {
            const t = event.native.touches?.[0] || event.native.changedTouches?.[0];
            if (t && event.native.target) {
              const rect = event.native.target.getBoundingClientRect();
              evX = t.clientX - rect.left;
              evY = t.clientY - rect.top;
            } else {
              evX = event.native.offsetX;
              evY = event.native.offsetY;
            }
          }
          const yScale = this._chart?.scales?.y;
          const area = this._chart?.chartArea;

          let matchedCand = null;
          let matchedLevel = null;
          let hoverFibStr = null;

          if (yScale && area && evY != null && evX != null && evX >= area.left - 12 && evX <= area.right + 12) {
            // Check all prior Fib candidates (ordered nearest to cursor Y first so overlapping Fibs can both be hovered)
            const rawCandidates = this._chart?.$rbPriorCandidates || (priorFibInfo ? [priorFibInfo] : []);
            const candidates = [...rawCandidates].sort((a, b) => {
              const ayHi = yScale.getPixelForValue(a.high);
              const ayLo = yScale.getPixelForValue(a.low);
              const ayMid = a.mid != null ? yScale.getPixelForValue(a.mid) : (ayHi + ayLo) / 2;
              const byHi = yScale.getPixelForValue(b.high);
              const byLo = yScale.getPixelForValue(b.low);
              const byMid = b.mid != null ? yScale.getPixelForValue(b.mid) : (byHi + byLo) / 2;
              const aDist = Math.min(Math.abs(evY - ayHi), Math.abs(evY - ayMid), Math.abs(evY - ayLo));
              const bDist = Math.min(Math.abs(evY - byHi), Math.abs(evY - byMid), Math.abs(evY - byLo));
              if (Math.abs(aDist - bDist) > 1.5) return aDist - bDist;
              return (b.recencyIndex ?? 0) - (a.recencyIndex ?? 0);
            });
            for (const cand of candidates) {
              const yHi = yScale.getPixelForValue(cand.high);
              const yLo = yScale.getPixelForValue(cand.low);
              const yMid = cand.mid != null ? yScale.getPixelForValue(cand.mid) : null;
              if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) continue;

              const topY = Math.min(yHi, yLo);
              const botY = Math.max(yHi, yLo);
              const padY = compact ? 26 : 22;

              const dHi = Math.abs(evY - yHi);
              const dMid = yMid != null ? Math.abs(evY - yMid) : Infinity;
              const dLo = Math.abs(evY - yLo);
              const minLineDist = Math.min(dHi, dMid, dLo);

              // Only match if cursor is genuinely near one of the Fib lines
              if (minLineDist <= (compact ? 16 : 12)) {
                matchedCand = cand;
                const dayStr = cand.dayLabel ? ` (${cand.dayLabel})` : '';
                if (dHi <= minLineDist) {
                  matchedLevel = 'high';
                  const diffPct = ((cand.high - priceNow) / priceNow * 100);
                  hoverFibStr = `<strong style="color:#4ade80;background:rgba(34,197,94,0.18);padding:1px 6px;border-radius:4px;">🎯 Hovering Prev Fib${dayStr} High: ${curSign}${Number(cand.high).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
                } else if (dMid <= minLineDist) {
                  matchedLevel = 'mid';
                  const diffPct = ((cand.mid - priceNow) / priceNow * 100);
                  hoverFibStr = `<strong style="color:#38bdf8;background:rgba(56,189,248,0.18);padding:1px 6px;border-radius:4px;">🎯 Hovering Prev Fib${dayStr} Median: ${curSign}${Number(cand.mid).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
                } else {
                  matchedLevel = 'low';
                  const diffPct = ((cand.low - priceNow) / priceNow * 100);
                  hoverFibStr = `<strong style="color:#f87171;background:rgba(239,68,68,0.18);padding:1px 6px;border-radius:4px;">🎯 Hovering Prev Fib${dayStr} Low: ${curSign}${Number(cand.low).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
                }
                break;
              }
            }

            // Also check Today's current band if no prior Fib matched
            if (!matchedCand && todayBand && evY != null) {
              const tHi = todayBand.f1 ?? todayBand.high;
              const t56 = todayBand.f56;
              const tMid = todayBand.f50 ?? todayBand.mid;
              const t44 = todayBand.f44;
              const tLo = todayBand.f0 ?? todayBand.low;
              if (tHi != null && Math.abs(evY - yScale.getPixelForValue(tHi)) <= 12) {
                const diffPct = ((tHi - priceNow) / priceNow * 100);
                hoverFibStr = `<strong style="color:#4ade80;background:rgba(34,197,94,0.18);padding:1px 6px;border-radius:4px;">🎯 Today's Fib High (1.0): ${curSign}${Number(tHi).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (t56 != null && Math.abs(evY - yScale.getPixelForValue(t56)) <= 12) {
                const diffPct = ((t56 - priceNow) / priceNow * 100);
                hoverFibStr = `<strong style="color:#a78bfa;background:rgba(167,139,250,0.18);padding:1px 6px;border-radius:4px;">🎯 Today's POB 0.56: ${curSign}${Number(t56).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (tMid != null && Math.abs(evY - yScale.getPixelForValue(tMid)) <= 12) {
                const diffPct = ((tMid - priceNow) / priceNow * 100);
                hoverFibStr = `<strong style="color:#38bdf8;background:rgba(56,189,248,0.18);padding:1px 6px;border-radius:4px;">🎯 Today's Fib Median (0.50): ${curSign}${Number(tMid).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (t44 != null && Math.abs(evY - yScale.getPixelForValue(t44)) <= 12) {
                const diffPct = ((t44 - priceNow) / priceNow * 100);
                hoverFibStr = `<strong style="color:#a78bfa;background:rgba(167,139,250,0.18);padding:1px 6px;border-radius:4px;">🎯 Today's POB 0.44: ${curSign}${Number(t44).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              } else if (tLo != null && Math.abs(evY - yScale.getPixelForValue(tLo)) <= 12) {
                const diffPct = ((tLo - priceNow) / priceNow * 100);
                hoverFibStr = `<strong style="color:#f87171;background:rgba(239,68,68,0.18);padding:1px 6px;border-radius:4px;">🎯 Today's Fib Low (0.0): ${curSign}${Number(tLo).toFixed(d)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)</strong>`;
              }
            }
          }

          // Check active horizontal setup & level lines (Barricade, 30m 5 EMA Target, 1H First Red H/L, POB 0.44/0.56, and Y-axis level tags)
          let matchedHoriz = null;
          if (yScale && area && evY != null && evX != null && evX >= area.left - 12 && evX <= area.right + 12) {
            const horizLines = [];
            const s3 = this._chart?.$rbSetup3;
            if (s3 && (s3.primed || s3.triggered)) {
              if (s3.barricade != null && Number.isFinite(s3.barricade)) {
                horizLines.push({
                  id: 's3_barricade',
                  title: '🚧 Barricade (Setup 3 Trigger)',
                  value: Number(s3.barricade),
                  color: '#fbbf24',
                  bg: 'rgba(251, 191, 36, 0.18)',
                  role: '5m close across Barricade triggers Rubber Band pullback toward 30m 5 EMA',
                });
              }
              if (s3.ema5 != null && Number.isFinite(s3.ema5)) {
                horizLines.push({
                  id: 's3_ema5',
                  title: '🧲 30m 5 EMA Target (Rubber Band)',
                  value: Number(s3.ema5),
                  color: '#38bdf8',
                  bg: 'rgba(56, 189, 248, 0.18)',
                  role: 'Mean-reversion magnet after 4+ detached 30m candles',
                });
              }
            }
            if (todayBand) {
              const tb0 = todayBand.f0 ?? todayBand.low;
              const tb1 = todayBand.f1 ?? todayBand.high;
              const tbMid = todayBand.f50 ?? todayBand.mid;
              if (tb0 != null && Number.isFinite(tb0)) {
                horizLines.push({
                  id: 'today_fib_0',
                  title: '🧲 Today Fib 0.0 (Anchor Low)',
                  value: Number(tb0),
                  color: '#38bdf8',
                  bg: 'rgba(56, 189, 248, 0.18)',
                  role: 'Equilibrium Magnet Pull Target & Support Boundary',
                });
              }
              if (tbMid != null && Number.isFinite(tbMid)) {
                horizLines.push({
                  id: 'today_fib_mid',
                  title: '🎯 Today Fib 0.50 (Median)',
                  value: Number(tbMid),
                  color: '#38bdf8',
                  bg: 'rgba(56, 189, 248, 0.18)',
                  role: 'Equilibrium Median Line',
                });
              }
              if (tb1 != null && Number.isFinite(tb1)) {
                horizLines.push({
                  id: 'today_fib_1',
                  title: '🧲 Today Fib 1.0 (Anchor High)',
                  value: Number(tb1),
                  color: '#f43f5e',
                  bg: 'rgba(244, 63, 94, 0.18)',
                  role: 'Equilibrium Magnet Pull Target & Resistance Boundary',
                });
              }
            }
            const fr = this._chart?.$rbFirstRed1h;
            if (fr && this._chart?.$rbShowFirstRed !== false) {
              const rLbl = o.firstRedLabel || '1H';
              if (fr.high != null && Number.isFinite(fr.high)) {
                horizLines.push({
                  id: 'fr_high',
                  title: `🟥 ${rLbl} First Red High`,
                  value: Number(fr.high),
                  color: '#f43f5e',
                  bg: 'rgba(244, 63, 94, 0.18)',
                  role: 'Trade 1 Breakout Long above High / Trade 2 Short Resistance',
                });
              }
              if (fr.low != null && Number.isFinite(fr.low)) {
                horizLines.push({
                  id: 'fr_low',
                  title: `🟥 ${rLbl} First Red Low`,
                  value: Number(fr.low),
                  color: '#fb7185',
                  bg: 'rgba(244, 63, 94, 0.16)',
                  role: 'Trade 1 Breakdown Short below Low / Trade 2 Long Support',
                });
              }
            }
            const pob = this._chart?.$rbPobReject;
            if (pob && (pob.watching || pob.triggered || pob.status === 'await_retest')) {
              if (pob.pobHi != null && Number.isFinite(pob.pobHi)) {
                horizLines.push({
                  id: 'pob_hi',
                  title: '🛑 POB 0.56 (Stop Loss Ceiling)',
                  value: Number(pob.pobHi),
                  color: '#f43f5e',
                  bg: 'rgba(244, 63, 94, 0.18)',
                  role: '5m close above 0.56 invalidates X-Candle POB Short',
                });
              }
              if (pob.pobLo != null && Number.isFinite(pob.pobLo)) {
                horizLines.push({
                  id: 'pob_lo',
                  title: '🎯 POB 0.44 (Short Entry Edge)',
                  value: Number(pob.pobLo),
                  color: '#c084fc',
                  bg: 'rgba(192, 132, 252, 0.18)',
                  role: 'Retest of 0.44–0.56 + 5m close below 0.44 triggers POB Short',
                });
              }
              const xLo = pob.xCandle?.low ?? pob.xCandle?.l;
              if (xLo != null && Number.isFinite(xLo)) {
                horizLines.push({
                  id: 'pob_xlo',
                  title: '✅ X-Candle Low (POB TP1)',
                  value: Number(xLo),
                  color: '#4ade80',
                  bg: 'rgba(74, 222, 128, 0.18)',
                  role: 'First take-profit target (Fib 0.0 Anchor Low)',
                });
              }
            }
            const lTags = this._chart?.$rbLevelTags || [];
            for (const lt of lTags) {
              if (lt && lt.value != null && Number.isFinite(lt.value)) {
                horizLines.push({
                  id: `tag_${lt.name}`,
                  title: `📌 ${lt.name}`,
                  value: Number(lt.value),
                  color: lt.color || '#38bdf8',
                  bg: 'rgba(56, 189, 248, 0.16)',
                  role: 'Key Session / Swing Reference Level',
                });
              }
            }

            const hitTol = compact ? 16 : 11;
            let bestDist = Infinity;
            for (const hl of horizLines) {
              const py = yScale.getPixelForValue(hl.value);
              if (!Number.isFinite(py)) continue;
              const dist = Math.abs(evY - py);
              if (dist <= hitTol && dist < bestDist) {
                bestDist = dist;
                const diffPts = hl.value - priceNow;
                const diffPct = priceNow ? (diffPts / priceNow) * 100 : 0;
                const sign = diffPts >= 0 ? '+' : '';
                matchedHoriz = {
                  ...hl,
                  evX,
                  diffStr: `${sign}${diffPts.toFixed(d)} pts / ${sign}${diffPct.toFixed(2)}%`,
                };
              }
            }
          }

          const prevHorizId = this._chart?.$rbHoveredHorizLine?.id || null;
          const nextHorizId = matchedHoriz?.id || null;
          if (this._chart && (prevHorizId !== nextHorizId || (matchedHoriz && Math.abs((this._chart.$rbHoveredHorizLine?.evX || 0) - evX) > 6))) {
            this._chart.$rbHoveredHorizLine = matchedHoriz;
            try {
              this._chart.draw();
            } catch (_) {
              try { this._chart.update('none'); } catch (_) {}
            }
          }

          if (matchedHoriz) {
            elInfo.innerHTML = `<strong style="color:${matchedHoriz.color};background:${matchedHoriz.bg};padding:1px 6px;border-radius:4px;">${matchedHoriz.title}: ${curSign}${Number(matchedHoriz.value).toFixed(d)} (${matchedHoriz.diffStr})</strong> <span style="color:#94a3b8;font-size:11px;">— ${matchedHoriz.role}</span>`;
            return;
          }

          // If not currently pinned, update hovered state
          if (!this._chart.$rbPinnedPriorFib) {
            const newKey = matchedCand ? `${matchedCand.dayKey}:${matchedLevel}` : null;
            const prevKey = this._chart.$rbHoveredKey || null;
            if (newKey !== prevKey) {
              this._chart.$rbHoveredKey = newKey;
              this._chart.$rbHoveredPriorFib = matchedCand || null;
              this._chart.$rbHoveredLevel = matchedLevel || null;
              try {
                this._chart.draw();
              } catch (_) {
                try { this._chart.update('none'); } catch (_) {}
              }
            }
          }

          if (hoverFibStr) {
            const role = matchedCand ? (matchedCand.trendDir === 'UP' ? 'Overhead Reversal / TP Target' : 'Underhead Support / SL Target') : 'Current Range Level';
            elInfo.innerHTML = `${hoverFibStr} <span style="color:#94a3b8;font-size:11px;">(${role})</span>`;
            return;
          }

          const activePf = this._chart?.$rbPinnedPriorFib || this._chart?.$rbHoveredPriorFib;
          const pfSummary = getFibSummaryHtml(activePf);

          if (activeElements && activeElements.length) {
            const idx = activeElements[0].index;
            const b = bars[idx];
            if (b) {
              const chg = ((b.c - b.o) / b.o) * 100;
              const arrow = chg >= 0 ? '▲' : '▼';
              const sign = chg >= 0 ? '+' : '';
              const col = chg >= 0 ? '#4ade80' : '#f87171';
              const t = times[idx] ? new Date(times[idx]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
              elInfo.innerHTML = `<span style="color:#94a3b8;">${t}</span> <strong style="color:${col};">${curSign}${Number(b.c).toFixed(d)} (${arrow} ${sign}${chg.toFixed(2)}%)</strong> <span style="color:#64748b;">H: ${curSign}${Number(b.h).toFixed(d)} · L: ${curSign}${Number(b.l).toFixed(d)}</span>${pfSummary}`;
              return;
            }
          }
          if (bars && bars.length) {
            const last = bars[bars.length - 1];
            const chg = ((last.c - last.o) / last.o) * 100;
            const arrow = chg >= 0 ? '▲' : '▼';
            const sign = chg >= 0 ? '+' : '';
            const col = chg >= 0 ? '#4ade80' : '#f87171';
            elInfo.innerHTML = `<span style="color:#94a3b8;">Live:</span> <strong style="color:${col};">${curSign}${Number(last.c).toFixed(d)} (${arrow} ${sign}${chg.toFixed(2)}%)</strong> <span style="color:#64748b;">H: ${curSign}${Number(last.h).toFixed(d)} · L: ${curSign}${Number(last.l).toFixed(d)}</span>${pfSummary}`;
          }
        },
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
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            borderColor: 'rgba(255, 255, 255, 0.12)',
            borderWidth: 1,
            titleFont: { family: 'Outfit', size: 12, weight: '700' },
            bodyFont: { family: 'Outfit', size: 11 },
            padding: 10,
            displayColors: false,
            caretPadding: 8,
            filter(item) {
              if (self._chart?.$rbHoveredHorizLine) return false;
              return item.dataset.label === priceLabel;
            },
            callbacks: {
              title(items) {
                const i = items[0]?.dataIndex;
                if (i == null || !times[i]) return items[0]?.label || '';
                const d = new Date(times[i]);
                const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                const tzAbbr = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
                  ? (new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '')
                  : '';
                return `📅 ${dateStr} · ${timeStr}${tzAbbr ? ` ${tzAbbr}` : ''}`;
              },
              label(ctx) {
                const b = bars[ctx.dataIndex];
                if (!b) return '';
                const d = inst.priceDecimals ?? 2;
                const changePct = ((b.c - b.o) / b.o) * 100;
                const sign = changePct >= 0 ? '+' : '';
                const arrow = changePct >= 0 ? '▲' : '▼';
                return [
                  `💵 Price: ${curSign}${Number(b.c).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} (${arrow} ${sign}${changePct.toFixed(2)}%)`,
                  `📈 High:   ${curSign}${Number(b.h).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`,
                  `📉 Low:    ${curSign}${Number(b.l).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`,
                  `🚪 Open:   ${curSign}${Number(b.o).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`,
                ];
              },
            },
          },
          zoom: {
            limits: {
              x: { min: 'original', max: 'original', minRange: 12 },
              y: { min: 0, max: 500000, minRange: Math.max(barSpan * 0.06, 30) },
            },
            // Smooth two-axis drag-pan on touch and desktop
            pan: {
              enabled: true,
              mode: 'xy',
              threshold: 6,
              modifierKey: null,
              onPanComplete({ chart }) {
                chart.$rbUserZoomed = true;
                try { chart.update('none'); } catch (_) {}
              },
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
                chart.$rbUserZoomed = true;
                try { chart.update('none'); } catch (_) {}
              },
              onPanComplete({ chart }) {
                chart.$rbUserZoomed = true;
                try { chart.update('none'); } catch (_) {}
              },
            },
          },
        },
        scales: {
          x: {
            type: 'category',
            offset: true,
            ...(savedXMin != null ? { min: savedXMin } : {}),
            ...(savedXMax != null ? { max: savedXMax } : {}),
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
            min: savedYMin,
            max: savedYMax,
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
    this._chart.$rbViewKey = viewKey;
    this._chart.$rbUserZoomed = preservedUserZoom;
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
    this._chart.$rbFirstRedLabel = o.firstRedLabel || '1H';
    this._chart.$rbFirstRedFibs = o.firstRedFibs || o.playbook?.redSetup?.fibs || null;
    this._chart.$rbShowFirstRed = showPivot;
    this._chart.$rbPobReject = o.pobReject || o.playbook?.pobReject || null;
    this._chart.$rbSetup3 = o.setup3 || o.playbook?.setup3 || null;
    this._chart.$rbLevelTags = levelTags;
    this._chart.$rbCompact = compact;
    this._chart.$rbUI = this;
    this._chart.$rbFibMagnet = row.fibMagnet || null;
    this._chart.$rbSessionTell = row.sessionTell || null;
    this._chart.$rbPriorCandidates = priorCandidates;
    this._chart.$rbPriorFib = priorFibInfo;
    this._chart.$rbHoveredPriorFib = null;
    this._chart.$rbPinnedPriorFib = null;
    this._chart.$rbHoveredLevel = null;
    this._chart.$rbHoveredKey = null;
    this._chart.$rbDecimals = inst.priceDecimals ?? 2;

    const elInitInfo = document.getElementById('rbCandleInfo');
    if (elInitInfo && bars && bars.length) {
      const last = bars[bars.length - 1];
      const d = inst.priceDecimals ?? 2;
      const chg = ((last.c - last.o) / last.o) * 100;
      const arrow = chg >= 0 ? '▲' : '▼';
      const sign = chg >= 0 ? '+' : '';
      const col = chg >= 0 ? '#4ade80' : '#f87171';
      const activePf = this._chart?.$rbPinnedPriorFib || this._chart?.$rbHoveredPriorFib;
      const pfSummary = getFibSummaryHtml(activePf);
      elInitInfo.innerHTML = `<span style="color:#94a3b8;">Live:</span> <strong style="color:${col};">${curSign}${Number(last.c).toFixed(d)} (${arrow} ${sign}${chg.toFixed(2)}%)</strong> <span style="color:#64748b;">H: ${curSign}${Number(last.h).toFixed(d)} · L: ${curSign}${Number(last.l).toFixed(d)}</span>${pfSummary}`;
    }

    // Smoothly clear hovered prior Fib lines when mouse leaves the canvas (unless pinned)
    canvas.onmouseleave = () => {
      if (this._chart && !this._chart.$rbPinnedPriorFib) {
        if (this._chart.$rbHoveredPriorFib || this._chart.$rbHoveredHorizLine) {
          this._chart.$rbHoveredKey = null;
          this._chart.$rbHoveredPriorFib = null;
          this._chart.$rbHoveredLevel = null;
          this._chart.$rbHoveredHorizLine = null;
          try {
            this._chart.draw();
          } catch (_) {
            try { this._chart.update('none'); } catch (_) {}
          }
        }
        if (elInitInfo && bars && bars.length) {
          const last = bars[bars.length - 1];
          const d = inst.priceDecimals ?? 2;
          const chg = ((last.c - last.o) / last.o) * 100;
          const arrow = chg >= 0 ? '▲' : '▼';
          const sign = chg >= 0 ? '+' : '';
          const col = chg >= 0 ? '#4ade80' : '#f87171';
          const pfSummary = getFibSummaryHtml(this._chart?.$rbPinnedPriorFib);
          elInitInfo.innerHTML = `<span style="color:#94a3b8;">Live:</span> <strong style="color:${col};">${curSign}${Number(last.c).toFixed(d)} (${arrow} ${sign}${chg.toFixed(2)}%)</strong> <span style="color:#64748b;">H: ${curSign}${Number(last.h).toFixed(d)} · L: ${curSign}${Number(last.l).toFixed(d)}</span>${pfSummary}`;
        }
      }
    };
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
