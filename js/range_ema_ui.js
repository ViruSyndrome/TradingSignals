'use strict';

/**
 * Red Bar Desk — visual trader sheet.
 * Chart + LONG / SHORT / WAIT action strip + levels.
 * EMA is overlay only.
 */
const RangeEmaUI = {
  _timer: null,
  _busy: false,
  _chart: null,
  state: { rows: [], updatedAt: null, error: null, tf: null },

  cfg() {
    return (typeof CONFIG !== 'undefined' && CONFIG.rangeEma) ? CONFIG.rangeEma : {};
  },

  activeTf() {
    const c = this.cfg();
    const allowed = c.timeframes || ['5m', '30m', '1h'];
    const tf = this.state.tf || c.workingTf || '30m';
    return allowed.includes(tf) ? tf : '30m';
  },

  setTf(tf) {
    const c = this.cfg();
    const allowed = c.timeframes || ['5m', '30m', '1h'];
    if (!allowed.includes(tf) || tf === this.activeTf()) return;
    this.state.tf = tf;
    try { localStorage.setItem('trendrunner_rb_tf', tf); } catch (_) {}
    this.refresh();
  },

  init() {
    const c = this.cfg();
    if (!c.enabled) return;
    try {
      const saved = localStorage.getItem('trendrunner_rb_tf');
      if (saved && (c.timeframes || []).includes(saved)) this.state.tf = saved;
    } catch (_) {}
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

  async _buildRow(symbol, c) {
    const tf = this.activeTf();
    const lim = this._ohlcLimit(tf, c);
    const raw = await API.getCryptoOHLC(symbol, tf, lim);
    const bars30 = this._klinesToBars(raw);
    if (bars30.length < 40) {
      return { symbol, error: `Not enough ${tf} data`, tf };
    }

    const readout = RedBarTrend.read(bars30, {
      lookbackDays: c.lookbackDays || 90,
      touchPct: c.touchPct ?? 0.15,
      dayMode: c.dayMode || 'utc',
    });

    const ema = this._emaOverlay(bars30, c.emaFast || 10, c.emaSlow || 30);

    let emaAgree = 'n/a';
    if (readout && ema.cross !== 'none') {
      const emaBull = ema.cross === 'bull_cross' || ema.cross === 'stacked_bull';
      const emaBear = ema.cross === 'bear_cross' || ema.cross === 'stacked_bear';
      if (readout.trend === 'bullish') emaAgree = emaBull ? 'agrees' : emaBear ? 'disagrees' : 'n/a';
      else if (readout.trend === 'bearish') emaAgree = emaBear ? 'agrees' : emaBull ? 'disagrees' : 'n/a';
      else emaAgree = 'neutral_trend';
    }

    const action = this._actionPlan(readout, emaAgree);

    return { symbol, tf, bars: bars30, readout, ema, emaAgree, action };
  },

  /** What the trader should do — plain language + levels */
  _actionPlan(o, emaAgree) {
    if (!o) {
      return { side: 'WAIT', title: 'No data', steps: [], cls: 'wait' };
    }
    if (o.phase === 'first_candle' || o.phase === 'inside_or') {
      return {
        side: 'WAIT',
        cls: 'wait',
        title: 'Do not trade yet',
        subtitle: 'Inside today’s opening range (or first candle still forming).',
        steps: [
          `Mark OR high ${this._fmt(o.refs.orHigh)} and OR low ${this._fmt(o.refs.orLow)} on your chart.`,
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
          'Futures: open LONG (or spot buy) near current price / band support hold.',
          `Stop / invalidation near ${this._fmt(o.invalidation)} (opening-range low or band).`,
          `Take profit / book near ${this._fmt(o.bookZone)} (red-bar high or next resistance).`,
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
          'Futures: open SHORT near current price / band resistance rejection.',
          `Stop / invalidation near ${this._fmt(o.invalidation)} (opening-range high or band).`,
          `Take profit / book near ${this._fmt(o.bookZone)} (red-bar low or next support).`,
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
      subtitle: 'No opening-range break yet.',
      steps: ['Watch prior-day bands as magnets; wait for OR break.'],
      entry: null,
      stop: null,
      exit: null,
    };
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

  _flat(n, len) {
    return new Array(len).fill(n);
  },

  destroyChart() {
    if (this._chart) {
      try {
        this._chart.destroy();
      } catch (_) {}
      this._chart = null;
    }
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

    if (this.state.error && !this.state.rows.length) {
      host.innerHTML = `<div class="range-desk-error">Red Bar Desk: ${this.state.error}</div>`;
      return;
    }

    const row = (this.state.rows || [])[0];
    const when = this.state.updatedAt
      ? new Date(this.state.updatedAt).toLocaleTimeString()
      : '—';

    if (!row) {
      host.innerHTML = `<div class="range-desk-error">Loading BTC chart…</div>`;
      return;
    }

    const tf = this.activeTf();
    host.innerHTML = `
      <div class="section-heading">
        <h1>🟥 Red Bar Desk</h1>
        <p class="section-sub">
          Visual BTC map on <strong>${tf}</strong>: price, EMA 10/30, opening range, prior-day magnets, red-bar exit refs.
          <span class="range-desk-meta">Updated ${when}</span>
        </p>
      </div>
      ${this._deskHtml(row, c)}
    `;

    this._bindChartControls();
    const focus = document.querySelector('.topbar-focus-label');
    if (focus) focus.textContent = `BTC · ${tf} Red Bar`;
    requestAnimationFrame(() => this._paintChart(row, c));
  },

  _bindChartControls() {
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
  },

  _deskHtml(r, c) {
    if (r.error) {
      return `<div class="range-desk-error">${r.error}</div>`;
    }
    const o = r.readout;
    const a = r.action || this._actionPlan(o, r.emaAgree);
    const trendCls =
      o.trend === 'bullish' ? 'pos' : o.trend === 'bearish' ? 'neg' : '';

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
          <div class="rb-zoom-group" role="group" aria-label="Chart zoom">
            <button type="button" class="rb-zoom-btn" id="rbZoomOut" title="Zoom out">−</button>
            <button type="button" class="rb-zoom-btn" id="rbZoomIn" title="Zoom in">+</button>
            <button type="button" class="rb-zoom-btn" id="rbZoomReset" title="Reset zoom">Reset</button>
          </div>
        </div>
        <div class="rb-chart-legend">
          <span class="lg price">Candles</span>
          <span class="lg ema10">EMA ${c.emaFast || 10}</span>
          <span class="lg ema30">EMA ${c.emaSlow || 30}</span>
          <span class="lg or">Opening range</span>
          <span class="lg band">Prior-day S/R</span>
          <span class="lg red">Red-bar refs</span>
          <span class="lg stop">Stop</span>
          <span class="lg tp">Exit</span>
          <span class="lg sess-asia">Asia</span>
          <span class="lg sess-london">London</span>
          <span class="lg sess-ny">US</span>
        </div>
        <p class="rb-zoom-hint">Scroll / pinch to zoom · drag to pan · buttons above</p>
        <div class="rb-chart-box">
          <canvas id="redBarChart" aria-label="BTC Red Bar chart"></canvas>
        </div>
      </div>

      <div class="rb-meta-row">
        <div class="range-trend-banner ${trendCls}">
          <span class="range-trend-label">Predicted trend</span>
          <strong>${o.trend === 'bullish' ? 'BULLISH' : o.trend === 'bearish' ? 'BEARISH' : 'NEUTRAL'}</strong>
        </div>
        <p class="range-narrative">${o.narrative}</p>
      </div>

      <div class="range-chips">
        <span class="range-chip">OR bias: ${o.orBias}</span>
        <span class="range-chip">Phase: ${String(o.phase).replace(/_/g, ' ')}</span>
        <span class="range-chip">EMA: ${String((r.ema && r.ema.cross) || '').replace(/_/g, ' ')}</span>
        <span class="range-chip ${r.emaAgree === 'agrees' ? 'pos' : r.emaAgree === 'disagrees' ? 'neg' : ''}">EMA ${r.emaAgree}</span>
        <span class="range-chip">${o.bandCountPrior} prior-day bands</span>
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
   * X-axis step in bars: 5m → every 30m; 30m/1h → every 1h.
   * If that would draw too many labels, step up in whole hours.
   */
  _xTickStep(tf, n, coarse) {
    const bph = this._barsPerHour(tf);
    const hoursPerTick = tf === '5m' ? 0.5 : 1;
    let step = Math.max(1, Math.round(bph * hoursPerTick));
    const maxLabels = coarse ? 8 : 14;
    while (n / step > maxLabels + 1) {
      step += bph; // add one hour of bars
    }
    return step;
  },

  _fmtAxisTick(ts, prevTs) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const dayChanged = !prevTs || new Date(prevTs).toDateString() !== d.toDateString();
    if (dayChanged) {
      const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return [day, time];
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

        ctx.save();
        for (const m of markers) {
          const idx = self._nearestBarIndex(times, m.ts);
          if (idx < 0) continue;
          const x = xScale.getPixelForValue(idx);
          if (!Number.isFinite(x) || x < area.left - 2 || x > area.right + 2) continue;

          ctx.strokeStyle = m.color;
          ctx.globalAlpha = m.kind === 'open' ? 0.85 : 0.45;
          ctx.lineWidth = m.kind === 'open' ? 1.5 : 1;
          ctx.setLineDash(m.kind === 'open' ? [] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.globalAlpha = 0.95;
          ctx.fillStyle = m.color;
          ctx.font = '600 9px Outfit, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const tag = m.kind === 'open' ? `${m.label}▲` : `${m.label}▼`;
          ctx.textBaseline = 'top';
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

  _paintChart(row, c) {
    const canvas = document.getElementById('redBarChart');
    if (!canvas || typeof Chart === 'undefined' || !row.bars) return;

    const tf = row.tf || this.activeTf();
    const want = (c.chartBars && c.chartBars[tf]) || 120;
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
    const yHi = Math.max(...bars.map((b) => b.h));
    const yLo = Math.min(...bars.map((b) => b.l));
    const pad = (yHi - yLo) * 0.04 || 1;
    const coarse = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches;
    const xStep = this._xTickStep(tf, n, coarse);
    const self = this;
    const sessionMarks = (c.showSessionMarkers !== false)
      ? this._sessionMarkersInRange(times[0], times[n - 1], c.sessions || [])
      : [];

    // Distinct palette (avoid overlapping blues/reds/greens across layers)
    const COL = {
      ema10: '#22d3ee',       // cyan — thin
      ema30: '#f97316',       // orange — thick
      or: '#eab308',          // gold
      bandResist: '#a855f7',  // purple
      bandSupport: '#2dd4bf', // teal
      redRef: '#e879f9',      // fuchsia (not stop-red)
      stop: '#ef4444',        // hard red
      exit: '#4ade80',        // hard green
    };

    const mkLine = (val, label, color, dash, width = 1.5) => ({
      label,
      data: this._flat(val, n),
      borderColor: color,
      borderWidth: width,
      borderDash: dash || [],
      pointRadius: 0,
      fill: false,
      tension: 0,
      order: 2,
    });

    // Invisible close series: hit-testing + tooltip OHLC (candles drawn by plugin)
    const datasets = [
      {
        label: 'BTC',
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

    if (o.refs?.orHigh != null) datasets.push(mkLine(o.refs.orHigh, 'OR high', COL.or, [6, 4], 1.5));
    if (o.refs?.orLow != null) datasets.push(mkLine(o.refs.orLow, 'OR low', COL.or, [6, 4], 1.25));
    if (o.refs?.bandResist != null) datasets.push(mkLine(o.refs.bandResist, 'Band resist', COL.bandResist, [3, 3], 1.5));
    if (o.refs?.bandSupport != null) datasets.push(mkLine(o.refs.bandSupport, 'Band support', COL.bandSupport, [3, 3], 1.5));
    if (o.refs?.redHigh != null) datasets.push(mkLine(o.refs.redHigh, 'Red high', COL.redRef, [8, 4], 1.5));
    if (o.refs?.redLow != null) datasets.push(mkLine(o.refs.redLow, 'Red low', COL.redRef, [8, 4], 1.25));
    if (o.invalidation != null) datasets.push(mkLine(o.invalidation, 'Stop', COL.stop, [], 2.25));
    if (o.bookZone != null) datasets.push(mkLine(o.bookZone, 'Exit', COL.exit, [], 2.25));

    this.destroyChart();
    this._chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      plugins: [this._candlePlugin(), this._sessionPlugin()],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 280 },
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 14, bottom: 4 } },
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
              return l === 'BTC' || l.startsWith('EMA') || l === 'Stop' || l === 'Exit';
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
                if (ctx.dataset.label === 'BTC') {
                  const b = bars[ctx.dataIndex];
                  if (!b) return 'BTC';
                  return [
                    `O  ${Number(b.o).toFixed(2)}`,
                    `H  ${Number(b.h).toFixed(2)}`,
                    `L  ${Number(b.l).toFixed(2)}`,
                    `C  ${Number(b.c).toFixed(2)}`,
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
              x: { min: 'original', max: 'original' },
              y: { min: 'original', max: 'original' },
            },
            pan: { enabled: true, mode: 'x', threshold: coarse ? 10 : 6 },
            zoom: {
              wheel: { enabled: !coarse, speed: 0.12 },
              pinch: { enabled: true },
              drag: {
                enabled: !coarse,
                backgroundColor: 'rgba(124, 106, 245, 0.18)',
                borderColor: 'rgba(124, 106, 245, 0.45)',
                borderWidth: 1,
              },
              mode: 'x',
            },
          },
        },
        scales: {
          x: {
            type: 'category',
            offset: true,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: {
              color: 'rgba(255,255,255,0.55)',
              font: { size: 10, family: 'Outfit' },
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              callback(value, index) {
                if (index % xStep !== 0 && index !== n - 1) return '';
                const prev = index >= xStep ? times[index - xStep] : null;
                return self._fmtAxisTick(times[index], prev);
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
              font: { size: 10, family: 'Outfit' },
              callback: (v) => Number(v).toFixed(0),
            },
          },
        },
      },
    });
    this._chart.$rbBars = bars;
    this._chart.$rbTimes = times;
    this._chart.$rbSessionMarks = sessionMarks;
    this._chart.$rbUI = this;
    // Flex layout settles after paint — force Chart.js to fill the box
    requestAnimationFrame(() => {
      try { this._chart?.resize?.(); } catch (_) {}
    });
  },
};

if (typeof window !== 'undefined') window.RangeEmaUI = RangeEmaUI;
