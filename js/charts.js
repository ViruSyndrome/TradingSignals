'use strict';

/**
 * charts.js — Chart.js wrapper for the trading dashboard.
 * Renders: price + MA + Bollinger Bands | RSI | MACD
 * Requires Chart.js loaded before this script.
 */
const Charts = {

  _instances: {},   // chartId → Chart instance

  // ─── Colour palette ──────────────────────────────────────────────────────────
  C: {
    price:    '#7c6af5',
    ema9:     '#ff5e00',
    ema21:    '#f5a623',
    sma50:    '#50e3c2',
    sma200:   '#a78bfa',
    bbUpper:  'rgba(255,100,100,0.6)',
    bbLower:  'rgba(100,220,130,0.6)',
    bbFill:   'rgba(120,100,255,0.06)',
    rsi:      '#e879f9',
    rsiOB:    'rgba(255,80,80,0.25)',
    rsiOS:    'rgba(80,255,160,0.25)',
    macdLine: '#60a5fa',
    macdSig:  '#f87171',
    macdPos:  'rgba(34,197,94,0.7)',
    macdNeg:  'rgba(239,68,68,0.7)',
    grid:     'rgba(255,255,255,0.06)',
    tick:     'rgba(255,255,255,0.45)',
  },

  // ─── Shared defaults ─────────────────────────────────────────────────────────
  _baseOptions(showXLabels = true) {
    return {
      animation: { duration: 400 },
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: this.C.tick, font: { size: 11, family: 'Outfit' }, boxWidth: 14, padding: 12 },
        },
        tooltip: {
          backgroundColor: 'rgba(12,16,36,0.95)',
          borderColor: 'rgba(124,106,245,0.4)',
          borderWidth: 1,
          titleColor: '#fff',
          bodyColor: 'rgba(255,255,255,0.75)',
          titleFont: { family: 'Outfit', weight: '600' },
          bodyFont: { family: 'Outfit', size: 12 },
          padding: 10,
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) label += ': ';
              if (context.parsed.y !== null) {
                const val = context.parsed.y;
                if (Math.abs(val) < 0.0001) label += val.toFixed(8);
                else if (Math.abs(val) < 1) label += val.toFixed(4);
                else label += val.toFixed(2);
              }
              return label;
            }
          }
        },
      },
      scales: {
        x: {
          display: showXLabels,
          grid:   { color: this.C.grid },
          ticks:  { color: this.C.tick, font: { size: 10, family: 'Outfit' }, maxTicksLimit: 8 },
        },
        y: {
          position: 'right',
          grid:   { color: this.C.grid },
          ticks:  { 
            color: this.C.tick, 
            font: { size: 10, family: 'Outfit' },
            callback: function(value) {
              if (Math.abs(value) < 0.0001) return value.toFixed(8);
              if (Math.abs(value) < 1) return value.toFixed(4);
              return value.toFixed(2);
            }
          },
        },
      },
    };
  },

  // ─── Format timestamps for labels ────────────────────────────────────────────
  _labels(timestamps) {
    return timestamps.map(ts => {
      const d = new Date(ts);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    });
  },

  // ─── Helper: align arrays so all have same length as reference ──────────────
  _align(reference, arr) {
    if (!arr || arr.length === 0) return new Array(reference.length).fill(null);
    if (arr.length === reference.length) return arr;
    // Pad front with nulls
    const diff = reference.length - arr.length;
    if (diff > 0) return [...new Array(diff).fill(null), ...arr];
    return arr.slice(-reference.length);
  },

  // ── Destroy existing chart safely ────────────────────────────────────────────
  _destroy(id) {
    if (this._instances[id]) {
      this._instances[id].destroy();
      delete this._instances[id];
    }
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // PRICE + MA + BOLLINGER CHART
  // ══════════════════════════════════════════════════════════════════════════════
  renderPrice(canvasId, closes, timestamps, signalArrays) {
    this._destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx || closes.length === 0) return;

    const labels  = this._labels(timestamps);
    const { ema9, ema21, sma50, sma200, bb } = signalArrays; console.log('ema9 data length:', ema9 ? ema9.length : 0); console.log('closes length:', closes.length);

    const datasets = [
      // Price area
      {
        label: 'Price',
        data:  closes,
        borderColor:     this.C.price,
        backgroundColor: 'rgba(124,106,245,0.12)',
        borderWidth:     2,
        pointRadius:     0,
        fill:            true,
        tension:         0.3,
        order:           1,
      },
      // EMA 9
      {
        label: '9 EMA',
        data:  this._align(closes, ema9),
        borderColor:     this.C.ema9,
        borderWidth:     1.5,
        borderDash:      [3, 3],
        pointRadius:     0,
        fill:            false,
        tension:         0.3,
        order:           2,
      },
      // EMA 21
      {
        label: '21 EMA',
        data:  this._align(closes, ema21),
        borderColor:     this.C.ema21,
        borderWidth:     1.5,
        borderDash:      [5, 3],
        pointRadius:     0,
        fill:            false,
        tension:         0.3,
        order:           3,
      },
      // SMA 50
      {
        label: '50 SMA',
        data:  this._align(closes, sma50),
        borderColor:     this.C.sma50,
        borderWidth:     1.5,
        borderDash:      [8, 4],
        pointRadius:     0,
        fill:            false,
        tension:         0.3,
        order:           4,
      },
      // SMA 200
      {
        label: '200 SMA',
        data:  this._align(closes, sma200 ?? []),
        borderColor:     this.C.sma200,
        borderWidth:     1.5,
        borderDash:      [12, 6],
        pointRadius:     0,
        fill:            false,
        tension:         0.3,
        order:           5,
      },
      // Bollinger Upper
      {
        label: 'BB Upper',
        data:  this._align(closes, bb?.upper ?? []),
        borderColor:     this.C.bbUpper,
        borderWidth:     1,
        borderDash:      [3, 3],
        pointRadius:     0,
        fill:            '+1',
        backgroundColor: this.C.bbFill,
        tension:         0.3,
        order:           4,
      },
      // Bollinger Lower
      {
        label: 'BB Lower',
        data:  this._align(closes, bb?.lower ?? []),
        borderColor:     this.C.bbLower,
        borderWidth:     1,
        borderDash:      [3, 3],
        pointRadius:     0,
        fill:            false,
        tension:         0.3,
        order:           5,
      },
    ];

    const opts = this._baseOptions(false);
    opts.plugins.legend.display = true;

    this._instances[canvasId] = new Chart(ctx, { type: 'line', data: { labels, datasets }, options: opts });
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // RSI CHART
  // ══════════════════════════════════════════════════════════════════════════════
  renderRSI(canvasId, rsiArr, timestamps) {
    this._destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx || rsiArr.length === 0) return;

    const labels = this._labels(timestamps);
    const aligned = this._align(timestamps, rsiArr);

    const opts = this._baseOptions(false);
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    opts.plugins.legend.display = false;

    // Overbought / oversold annotation via inline plugin
    const obLine = {
      id: 'rsiZones',
      beforeDraw(chart) {
        const { ctx: c, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
        const ob = y.getPixelForValue(70);
        const os = y.getPixelForValue(30);
        c.save();
        c.fillStyle = 'rgba(255,80,80,0.08)';
        c.fillRect(left, top, right - left, ob - top);
        c.fillStyle = 'rgba(80,220,130,0.08)';
        c.fillRect(left, os, right - left, bottom - os);
        c.strokeStyle = 'rgba(255,80,80,0.4)';
        c.lineWidth = 1;
        c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(left, ob); c.lineTo(right, ob); c.stroke();
        c.strokeStyle = 'rgba(80,220,130,0.4)';
        c.beginPath(); c.moveTo(left, os); c.lineTo(right, os); c.stroke();
        c.restore();
      },
    };

    this._instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'RSI (14)',
          data:  aligned,
          borderColor:     this.C.rsi,
          backgroundColor: 'transparent',
          borderWidth:     1.5,
          pointRadius:     0,
          tension:         0.3,
          fill:            false,
        }],
      },
      options: opts,
      plugins: [obLine],
    });
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // MACD CHART
  // ══════════════════════════════════════════════════════════════════════════════
  renderMACD(canvasId, macdData, timestamps) {
    this._destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx || !macdData?.macdLine?.length) return;

    const labels   = this._labels(timestamps);
    const macdLine = this._align(timestamps, macdData.macdLine);
    const sigLine  = this._align(timestamps, macdData.signalLine);
    const hist     = this._align(timestamps, macdData.histogram);

    // Histogram colour: green positive, red negative
    const histColors = hist.map(v => v === null ? 'transparent' : v >= 0 ? this.C.macdPos : this.C.macdNeg);

    const opts = this._baseOptions(true);
    opts.plugins.legend.display = false;

    this._instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type:            'line',
            label:           'MACD',
            data:            macdLine,
            borderColor:     this.C.macdLine,
            borderWidth:     1.5,
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
            order:           1,
          },
          {
            type:            'line',
            label:           'Signal',
            data:            sigLine,
            borderColor:     this.C.macdSig,
            borderWidth:     1.5,
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
            order:           2,
          },
          {
            type:            'bar',
            label:           'Histogram',
            data:            hist,
            backgroundColor: histColors,
            barPercentage:   0.9,
            categoryPercentage: 1,
            order:           3,
          },
        ],
      },
      options: opts,
    });
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // MINI SPARKLINE for cards
  // ══════════════════════════════════════════════════════════════════════════════
  renderSparkline(canvasId, closes, isPositive) {
    this._destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx || closes.length === 0) return;

    // Take last 30 points for sparkline
    const data   = closes.slice(-30);
    const color  = isPositive ? '#22c55e' : '#ef4444';
    const fillColor = isPositive ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';

    this._instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(() => ''),
        datasets: [{
          data:            data,
          borderColor:     color,
          backgroundColor: fillColor,
          borderWidth:     1.5,
          pointRadius:     0,
          fill:            true,
          tension:         0.4,
        }],
      },
      options: {
        animation:  { duration: 0 },
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false },
        },
      },
    });
  },

  // ─── Destroy all charts ──────────────────────────────────────────────────────
  destroyAll() {
    Object.keys(this._instances).forEach(id => this._destroy(id));
  },
};
