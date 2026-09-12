'use strict';

/**
 * dashboard.js — Main application controller.
 * Orchestrates: data loading → indicator calculation → signal generation → UI rendering.
 */
const Dashboard = {

  state: {
    allAssets:     [],       // all fetched+processed assets
    filtered:      [],       // currently displayed subset
    activeCategory:'all',
    activeSignalFilter: null, // 'STRONG_BUY', 'SELL', etc.
    selectedAsset: null,     // for the detail modal
    loading:       true,
    lastUpdate:    null,
    refreshTimer:  null,
    countdownTimer: null,
    refreshDueAt: null,
    updatedAssetIds: new Set(),
    notifGranted:  false,
    watchlist:     (() => { try { const v = JSON.parse(localStorage.getItem('trading_watchlist')); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    invested:      (() => { try { const v = JSON.parse(localStorage.getItem('trading_invested')); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    holdingsMeta:  (() => {
      try {
        const v = JSON.parse(localStorage.getItem('trading_holdings_meta'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch { return {}; }
    })(),
    moonshotReviewUntil: (() => { try { const v = JSON.parse(localStorage.getItem('trading_moonshot_review_until')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })(),
    fearGreed:     null,
    marketRegime: 'unknown',
    scalps:        [],       // results from the 5m Scalper (volatile alt pullbacks)
  },

  // ─── Signal History ─────────────────────────────────────────────────────────
  SIGNAL_HISTORY_KEY: 'signal_history_v1',
  HOLDINGS_META_KEY: 'trading_holdings_meta',
  ALERT_OUTCOMES_KEY: 'trading_alert_outcomes_v1',
  FOLLOWED_KEY: 'trading_followed_v1',
  MOONSHOT_REVIEW_MS: 4 * 60 * 60 * 1000, // 4 hours to reduce clutter
  _previousSignals: new Map(),
  _previousScalps: new Map(),

  _getAlertOutcomes() {
    try {
      const raw = localStorage.getItem(this.ALERT_OUTCOMES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  },

  _saveAlertOutcomes(list) {
    try {
      localStorage.setItem(this.ALERT_OUTCOMES_KEY, JSON.stringify((list || []).slice(0, 300)));
    } catch (e) { /* quota */ }
  },

  /** Log live STRONG_BUY (core) alerts for 3d/7d outcome tracking. */
  _captureAlertOutcomes() {
    const now = Date.now();
    let journal = this._getAlertOutcomes();
    let changed = false;

    for (const d of this.state.allAssets) {
      const sig = d.signalResult?.signal;
      const tier = d.signalResult?.winnerTier;
      if (sig !== 'STRONG_BUY' || tier !== 'core') continue;
      if (d.signalResult?.regimeBlocked || d.signalResult?.greedBlocked || d.signalResult?.coreOnlyFiltered) continue;
      if (!Number.isFinite(d.price) || d.price <= 0) continue;

      const symbol = String(d.asset?.symbol || d.asset?.id || '').toUpperCase().replace(/USDT$/, '');
      const id = d.asset?.id;
      // Avoid duplicate open alerts for same coin within 24h
      const recent = journal.find(e =>
        e.status === 'OPEN' &&
        e.symbol === symbol &&
        (now - Date.parse(e.alertedAt)) < 24 * 3600 * 1000
      );
      if (recent) continue;

      const stop = d.signalResult?.stopSuggest;
      journal.unshift({
        id: `${symbol}-${now}`,
        symbol,
        assetId: id,
        alertedAt: new Date(now).toISOString(),
        entryPrice: d.price,
        stopPrice: stop?.stopPrice ?? null,
        takeProfitPrice: stop?.takeProfitPrice ?? null,
        takeProfitPct: stop?.takeProfitPct ?? CONFIG.exits?.takeProfitPct ?? 10,
        holdLimitDays: stop?.holdLimitDays ?? CONFIG.exits?.holdLimitDays ?? 7,
        score: d.signalResult?.score ?? null,
        confidence: d.signalResult?.confidence ?? null,
        status: 'OPEN',
        outcomes: { threeDay: null, sevenDay: null },
        exitReason: null,
        lastPrice: d.price,
        lastCheckedAt: new Date(now).toISOString(),
      });
      changed = true;
    }

    if (changed) this._saveAlertOutcomes(journal);
  },

  async _updateAlertOutcomes() {
    let journal = this._getAlertOutcomes();
    const open = journal.filter(e => e.status === 'OPEN');
    if (!open.length) return;

    try {
      const symbols = [...new Set(open.map(e => `${e.symbol}USDT`))];
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
      const tickers = await res.json();
      const prices = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.symbol.replace('USDT', ''), Number(t.price)]));
      const now = Date.now();

      journal = journal.map(entry => {
        if (entry.status !== 'OPEN') return entry;
        const current = prices.get(entry.symbol);
        if (!Number.isFinite(current)) return entry;

        const ageMs = now - Date.parse(entry.alertedAt);
        const ageDays = ageMs / 86400000;
        const returnPct = ((current - entry.entryPrice) / entry.entryPrice) * 100;
        const outcomes = { ...entry.outcomes };
        if (ageDays >= 3 && outcomes.threeDay === null) outcomes.threeDay = +returnPct.toFixed(2);
        if (ageDays >= 7 && outcomes.sevenDay === null) outcomes.sevenDay = +returnPct.toFixed(2);

        let status = entry.status;
        let exitReason = entry.exitReason;
        if (entry.stopPrice && current <= entry.stopPrice) {
          status = 'STOPPED';
          exitReason = 'STOP_LOSS';
        } else if (entry.takeProfitPrice && current >= entry.takeProfitPrice) {
          status = 'TARGET';
          exitReason = 'TAKE_PROFIT';
        } else if (ageDays >= (entry.holdLimitDays || 7)) {
          status = 'EXPIRED';
          exitReason = 'HOLD_LIMIT';
          if (outcomes.sevenDay === null) outcomes.sevenDay = +returnPct.toFixed(2);
        }

        return {
          ...entry,
          lastPrice: current,
          lastCheckedAt: new Date(now).toISOString(),
          outcomes,
          status,
          exitReason,
          returnPct: +returnPct.toFixed(2),
        };
      });

      this._saveAlertOutcomes(journal);
    } catch (e) {
      console.warn('[Alerts] Outcome update failed:', e.message);
    }
  },

  _alertOutcomesHTML() {
    const journal = this._getAlertOutcomes().slice(0, 40);
    if (!journal.length) {
      return `<div class="alert-outcomes-panel"><h3>📈 Alert outcomes</h3><p class="no-data">No STRONG_BUY core alerts logged yet. They appear automatically when a live core Strong Buy fires.</p></div>`;
    }
    const rows = journal.map(e => {
      const age = this._formatTimeHeld(e.alertedAt);
      const ret = Number.isFinite(e.returnPct) ? `${e.returnPct >= 0 ? '+' : ''}${e.returnPct.toFixed(2)}%` : '—';
      const cls = Number.isFinite(e.returnPct) ? (e.returnPct >= 0 ? 'pos' : 'neg') : 'flat';
      const d3 = e.outcomes?.threeDay != null ? `${e.outcomes.threeDay >= 0 ? '+' : ''}${e.outcomes.threeDay}%` : '—';
      const d7 = e.outcomes?.sevenDay != null ? `${e.outcomes.sevenDay >= 0 ? '+' : ''}${e.outcomes.sevenDay}%` : '—';
      return `<div class="alert-outcome-row">
        <strong>${e.symbol}</strong>
        <span>${e.status}</span>
        <span>Entry $${this._fmt(e.entryPrice)}</span>
        <span class="${cls}">Now ${ret}</span>
        <span>3d ${d3}</span>
        <span>7d ${d7}</span>
        <span class="muted">Held ${age}${e.exitReason ? ' · ' + e.exitReason : ''}</span>
      </div>`;
    }).join('');
    return `<div class="alert-outcomes-panel"><h3>📈 Alert outcomes (core STRONG_BUY)</h3>${rows}</div>`;
  },

  _persistHoldingsMeta() {
    try {
      localStorage.setItem(this.HOLDINGS_META_KEY, JSON.stringify(this.state.holdingsMeta || {}));
    } catch (e) { /* quota — ignore */ }
  },

  _resolveAssetPrice(id) {
    const base = String(id || '').toUpperCase().replace('_4H', '').replace('_5M', '');
    const live = this.state.allAssets.find(a =>
      String(a.asset?.id || '').toUpperCase().replace('_4H', '').replace('_5M', '') === base
    );
    return Number.isFinite(live?.price) ? live.price : null;
  },

  _baseHoldingsId(id) {
    let base = String(id || '').toUpperCase().replace('_4H', '').replace('_5M', '');
    if (base && !base.endsWith('USDT')) base += 'USDT';
    return base;
  },

  /** Migrate legacy {entryPrice,lockedAt} → lots[] and keep summary fields for cloud sync. */
  _normalizeLots(meta) {
    if (!meta || typeof meta !== 'object') return [];
    if (Array.isArray(meta.lots) && meta.lots.length) {
      return meta.lots.map((lot, i) => ({
        id: lot.id || `lot_${i}_${Date.parse(lot.lockedAt || '') || i}`,
        entryPrice: Number(lot.entryPrice) || null,
        lockedAt: lot.lockedAt || new Date().toISOString(),
        qty: Number.isFinite(Number(lot.qty)) && Number(lot.qty) > 0 ? Number(lot.qty) : 1,
        note: lot.note || '',
        estimated: lot.estimated === true,
      }));
    }
    if (meta.entryPrice > 0 || meta.lockedAt) {
      return [{
        id: 'lot_legacy',
        entryPrice: Number(meta.entryPrice) || null,
        lockedAt: meta.lockedAt || new Date().toISOString(),
        qty: Number.isFinite(Number(meta.qty)) && Number(meta.qty) > 0 ? Number(meta.qty) : 1,
        note: meta.note || '',
        estimated: meta.estimated === true,
      }];
    }
    return [];
  },

  _aggregateLots(lots) {
    const valid = (lots || []).filter(l => Number.isFinite(l.entryPrice) && l.entryPrice > 0);
    const totalQty = valid.reduce((s, l) => s + (l.qty || 1), 0) || 0;
    const cost = valid.reduce((s, l) => s + l.entryPrice * (l.qty || 1), 0);
    const avgEntry = totalQty > 0 ? cost / totalQty : null;
    const times = (lots || []).map(l => Date.parse(l.lockedAt)).filter(Number.isFinite);
    const earliest = times.length ? new Date(Math.min(...times)).toISOString() : null;
    return { avgEntry, totalQty, earliest, estimated: (lots || []).length > 0 && (lots || []).every(l => l.estimated) };
  },

  _writeHoldingsLots(base, lots) {
    if (!this.state.holdingsMeta || typeof this.state.holdingsMeta !== 'object') this.state.holdingsMeta = {};
    if (!lots.length) {
      delete this.state.holdingsMeta[base];
      this._persistHoldingsMeta();
      return;
    }
    const agg = this._aggregateLots(lots);
    this.state.holdingsMeta[base] = {
      lots,
      entryPrice: agg.avgEntry,
      lockedAt: agg.earliest,
      qty: agg.totalQty,
      estimated: agg.estimated || undefined,
    };
    this._persistHoldingsMeta();
  },

  _setHoldingsMetaEntry(id, entryPrice, opts = {}) {
    const base = this._baseHoldingsId(id);
    if (!base) return;
    if (!this.state.holdingsMeta || typeof this.state.holdingsMeta !== 'object') this.state.holdingsMeta = {};

    let lots = this._normalizeLots(this.state.holdingsMeta[base]);
    const hasReal = lots.some(l => l.entryPrice > 0 && !l.estimated);
    if (hasReal && !opts.force && !opts.addLot) return;

    const price = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : this._resolveAssetPrice(base);
    const lot = {
      id: `lot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      entryPrice: Number.isFinite(price) && price > 0 ? price : null,
      lockedAt: opts.lockedAt || new Date().toISOString(),
      qty: Number.isFinite(Number(opts.qty)) && Number(opts.qty) > 0 ? Number(opts.qty) : 1,
      note: opts.note || '',
      estimated: opts.estimated === true,
    };

    if (opts.addLot && lots.length) {
      lots = [...lots, lot];
    } else if (opts.force || !lots.length) {
      lots = [lot];
    } else {
      return;
    }
    this._writeHoldingsLots(base, lots);
  },

  _addOrUpdateHoldingsLot(id, { lotId, entryPrice, lockedAt, qty, note } = {}) {
    const base = this._baseHoldingsId(id);
    let lots = this._normalizeLots(this.state.holdingsMeta?.[base]);
    const price = Number(entryPrice);
    if (!Number.isFinite(price) || price <= 0) {
      this._showToast('Enter a valid Binance entry price', 'warning');
      return false;
    }
    const at = lockedAt ? new Date(lockedAt).toISOString() : new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) {
      this._showToast('Enter a valid entry date/time', 'warning');
      return false;
    }
    const q = Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1;

    if (lotId) {
      lots = lots.map(l => l.id === lotId ? { ...l, entryPrice: price, lockedAt: at, qty: q, note: note || '', estimated: false } : l);
    } else {
      lots.push({
        id: `lot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        entryPrice: price,
        lockedAt: at,
        qty: q,
        note: note || '',
        estimated: false,
      });
    }
    if (!this.state.invested.includes(base)) this.state.invested.push(base);
    this._writeHoldingsLots(base, lots);
    try {
      localStorage.setItem('trading_invested', JSON.stringify(this.state.invested));
      if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
    } catch (e) {}
    this._showToast(`${base.replace('USDT','')}: entry saved (${lots.length} lot${lots.length > 1 ? 's' : ''})`, 'success');
    this._render();
    return true;
  },

  _removeHoldingsLot(id, lotId) {
    const base = this._baseHoldingsId(id);
    let lots = this._normalizeLots(this.state.holdingsMeta?.[base]).filter(l => l.id !== lotId);
    if (!lots.length) {
      this.state.invested = this.state.invested.filter(x => x !== base);
      this._writeHoldingsLots(base, []);
      try {
        localStorage.setItem('trading_invested', JSON.stringify(this.state.invested));
        if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
      } catch (e) {}
      this._showToast(`Holding unlocked: ${base.replace('USDT','')}`, 'info');
    } else {
      this._writeHoldingsLots(base, lots);
      try {
        if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
      } catch (e) {}
      this._showToast('Entry lot removed', 'info');
    }
    this._render();
  },

  _removeHoldingsMetaEntry(id) {
    const base = this._baseHoldingsId(id);
    if (!this.state.holdingsMeta?.[base]) return;
    delete this.state.holdingsMeta[base];
    this._persistHoldingsMeta();
  },

  _backfillHoldingsMeta() {
    if (!Array.isArray(this.state.invested)) return;
    let changed = false;
    for (const id of this.state.invested) {
      const base = this._baseHoldingsId(id);
      const lots = this._normalizeLots(this.state.holdingsMeta?.[base]);
      if (lots.some(l => l.entryPrice > 0)) {
        // Ensure migrated shape is persisted
        if (!this.state.holdingsMeta?.[base]?.lots) {
          this._writeHoldingsLots(base, lots);
          changed = true;
        }
        continue;
      }
      const price = this._resolveAssetPrice(base);
      this._writeHoldingsLots(base, [{
        id: 'lot_backfill',
        entryPrice: Number.isFinite(price) && price > 0 ? price : null,
        lockedAt: lots[0]?.lockedAt || new Date().toISOString(),
        qty: 1,
        estimated: true,
        note: '',
      }]);
      changed = true;
    }
    for (const key of Object.keys(this.state.holdingsMeta || {})) {
      if (!this.state.invested.includes(key)) {
        delete this.state.holdingsMeta[key];
        changed = true;
      }
    }
    if (changed) this._persistHoldingsMeta();
  },

  _formatTimeHeld(lockedAt) {
    const start = Date.parse(lockedAt);
    if (!Number.isFinite(start)) return '—';
    const ms = Math.max(0, Date.now() - start);
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH ? `${days}d ${remH}h` : `${days}d`;
  },

  _toDatetimeLocalValue(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _holdingsPnLHTML(normalizedId, currentPrice) {
    const base = this._baseHoldingsId(normalizedId);
    const lots = this._normalizeLots(this.state.holdingsMeta?.[base]);
    if (!lots.length) {
      return `<div class="holdings-pnl muted">Paper PnL pending — set your Binance entry below</div>${this._holdingsEditorHTML(base, currentPrice, [])}`;
    }
    const agg = this._aggregateLots(lots);
    const entry = agg.avgEntry;
    const held = this._formatTimeHeld(agg.earliest);
    const estimated = agg.estimated;
    const entryStr = Number.isFinite(entry) && entry > 0 ? `$${this._fmt(entry)}` : '—';
    const qtyStr = agg.totalQty !== 1 ? ` · qty ${agg.totalQty}` : '';
    let pnlBlock = `<span class="pnl-badge">PnL —</span>`;
    if (Number.isFinite(entry) && entry > 0 && Number.isFinite(currentPrice)) {
      const pnlPct = ((currentPrice - entry) / entry) * 100;
      const pnlValue = (currentPrice - entry) * (agg.totalQty || 1);
      const cls = estimated ? 'flat' : (pnlPct >= 0 ? 'pos' : 'neg');
      const pctStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
      const valStr = `${pnlValue >= 0 ? '+' : '-'}$${this._fmt(Math.abs(pnlValue))}`;
      pnlBlock = `<span class="pnl-badge ${cls}" title="Paper PnL vs your Binance entries">${estimated ? 'Est. ' : ''}${pctStr} · ${valStr}</span>`;
    }
    return `<div class="holdings-pnl${estimated ? ' estimated' : ''}">
      <span title="Average entry across lots">Entry ${entryStr}${estimated ? ' ≈' : ''}${qtyStr}${lots.length > 1 ? ` · ${lots.length} lots` : ''}</span>
      <span title="Since earliest lot">Held ${held}</span>
      ${pnlBlock}
    </div>${this._holdingsEditorHTML(base, currentPrice, lots)}`;
  },

  _holdingsEditorHTML(base, currentPrice, lots) {
    const lotRows = (lots || []).map(l => {
      const px = Number.isFinite(l.entryPrice) ? l.entryPrice : '';
      return `<div class="holdings-lot-row" data-lot-id="${l.id}">
        <input type="number" step="any" min="0" class="hold-lot-price" value="${px}" placeholder="Entry $" title="Exact Binance fill price" />
        <input type="datetime-local" class="hold-lot-time" value="${this._toDatetimeLocalValue(l.lockedAt)}" title="Exact Binance fill time" />
        <input type="number" step="any" min="0" class="hold-lot-qty" value="${l.qty || 1}" placeholder="Qty" title="Quantity (optional, defaults 1)" />
        <button type="button" class="hold-lot-save" data-action="save-lot" data-hold-id="${base}" data-lot-id="${l.id}">Save</button>
        <button type="button" class="hold-lot-del" data-action="del-lot" data-hold-id="${base}" data-lot-id="${l.id}" title="Remove this entry lot">✕</button>
      </div>`;
    }).join('');
    const live = Number.isFinite(currentPrice) ? currentPrice : '';
    return `<div class="holdings-editor" data-hold-id="${base}">
      <div class="holdings-editor-title">Binance entries <span class="muted">(edit price · date/time · add lots)</span></div>
      ${lotRows || '<p class="muted" style="margin:4px 0;font-size:12px;">No lots yet — add your fill below.</p>'}
      <div class="holdings-lot-row holdings-lot-new">
        <input type="number" step="any" min="0" class="hold-lot-price" value="${live}" placeholder="Entry $" title="Exact Binance fill price" />
        <input type="datetime-local" class="hold-lot-time" value="${this._toDatetimeLocalValue(new Date().toISOString())}" title="Exact Binance fill time" />
        <input type="number" step="any" min="0" class="hold-lot-qty" value="1" placeholder="Qty" />
        <button type="button" class="hold-lot-save" data-action="add-lot" data-hold-id="${base}">+ Lot</button>
      </div>
    </div>`;
  },

  // ─── Followed suggestions ledger (personal hit/miss tracker) ───────────────
  _getFollowed() {
    try {
      const raw = localStorage.getItem(this.FOLLOWED_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  },

  _saveFollowed(list) {
    try {
      localStorage.setItem(this.FOLLOWED_KEY, JSON.stringify((list || []).slice(0, 400)));
    } catch (e) {}
    if (window.Auth?.user) {
      window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, {
        force: true,
        followed: list,
      });
    }
  },

  _markSuggestionFollowed(symbol, opts = {}) {
    const sym = String(symbol || '').toUpperCase().replace('USDT', '').replace('_4H', '').replace('_5M', '');
    if (!sym) return;
    const base = `${sym}USDT`;
    const price = Number(opts.entryPrice) > 0 ? Number(opts.entryPrice) : this._resolveAssetPrice(base);
    const enteredAt = opts.enteredAt || new Date().toISOString();
    const list = this._getFollowed();
    const row = {
      id: `fol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      symbol: sym,
      signal: opts.signal || 'BUY',
      entryPrice: price,
      enteredAt,
      qty: Number(opts.qty) > 0 ? Number(opts.qty) : 1,
      status: 'OPEN',
      source: opts.source || 'manual',
      note: opts.note || '',
    };
    list.unshift(row);
    this._saveFollowed(list);

    // Mirror into Holdings so live PnL can be corrected to the Binance fill
    if (opts.addHolding !== false) {
      const had = this.state.invested.includes(base);
      if (!had) this.state.invested.push(base);
      this._setHoldingsMetaEntry(base, price, {
        force: !had,
        addLot: had,
        lockedAt: enteredAt,
        qty: row.qty,
      });
      try {
        localStorage.setItem('trading_invested', JSON.stringify(this.state.invested));
        if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
      } catch (e) {}
    }

    this._showToast(`Followed ${sym} @ $${this._fmt(price)} — tracked in Suggestions + Holdings`, 'success');
    if (this.state.activeCategory === 'history' || this.state.activeCategory === 'holdings') this._render();
    else this._renderAssetGrid();
  },

  _closeFollowed(id, exitPrice, reason = 'MANUAL') {
    const list = this._getFollowed().map(e => {
      if (e.id !== id || e.status !== 'OPEN') return e;
      const exit = Number(exitPrice);
      const ret = Number.isFinite(exit) && e.entryPrice > 0 ? ((exit - e.entryPrice) / e.entryPrice) * 100 : e.returnPct;
      return {
        ...e,
        status: Number.isFinite(ret) && ret >= 0 ? 'WIN' : 'LOSS',
        exitPrice: Number.isFinite(exit) ? exit : e.lastPrice,
        exitedAt: new Date().toISOString(),
        exitReason: reason,
        returnPct: Number.isFinite(ret) ? +ret.toFixed(2) : null,
      };
    });
    this._saveFollowed(list);
    this._renderAssetGrid();
  },

  async _refreshFollowedMarks() {
    const list = this._getFollowed();
    const open = list.filter(e => e.status === 'OPEN');
    if (!open.length) return;
    try {
      const symbols = [...new Set(open.map(e => `${e.symbol}USDT`))];
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
      const tickers = await res.json();
      const prices = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.symbol.replace('USDT', ''), Number(t.price)]));
      const next = list.map(e => {
        if (e.status !== 'OPEN') return e;
        const current = prices.get(e.symbol);
        if (!Number.isFinite(current) || !(e.entryPrice > 0)) return e;
        return { ...e, lastPrice: current, returnPct: +(((current - e.entryPrice) / e.entryPrice) * 100).toFixed(2) };
      });
      this._saveFollowed(next);
    } catch (e) {
      console.warn('[Followed] refresh failed', e.message);
    }
  },

  _followedHTML() {
    const list = this._getFollowed();
    const closed = list.filter(e => e.status === 'WIN' || e.status === 'LOSS');
    const wins = closed.filter(e => e.status === 'WIN').length;
    const losses = closed.filter(e => e.status === 'LOSS').length;
    const openN = list.filter(e => e.status === 'OPEN').length;
    const avg = closed.length
      ? closed.reduce((s, e) => s + (Number(e.returnPct) || 0), 0) / closed.length
      : null;
    const stats = `<div class="followed-stats">
      <span><strong>${wins}</strong> wins</span>
      <span><strong>${losses}</strong> losses</span>
      <span><strong>${openN}</strong> open</span>
      <span>Closed avg ${avg == null ? '—' : `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`}</span>
    </div>`;
    if (!list.length) {
      return `<div class="followed-panel"><h3>✅ Suggestions you followed</h3>${stats}<p class="no-data">When you take a tool BUY/S.BUY, tap <strong>I followed this</strong> on the card (or here). Edit the exact Binance fill in Holdings so PnL matches your exchange.</p></div>`;
    }
    const rows = list.slice(0, 50).map(e => {
      const ret = Number.isFinite(e.returnPct) ? `${e.returnPct >= 0 ? '+' : ''}${e.returnPct.toFixed(2)}%` : '—';
      const cls = Number.isFinite(e.returnPct) ? (e.returnPct >= 0 ? 'pos' : 'neg') : 'flat';
      const when = e.enteredAt ? new Date(e.enteredAt).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
      const closeBtn = e.status === 'OPEN'
        ? `<button type="button" class="followed-close-btn" data-action="close-followed" data-fol-id="${e.id}" data-symbol="${e.symbol}">Close</button>`
        : `<span class="muted">${e.status}</span>`;
      return `<div class="followed-row">
        <strong>${e.symbol}</strong>
        <span>${e.signal}</span>
        <span>@ $${this._fmt(e.entryPrice)}</span>
        <span class="${cls}">${ret}</span>
        <span class="muted">${when}</span>
        ${closeBtn}
      </div>`;
    }).join('');
    return `<div class="followed-panel"><h3>✅ Suggestions you followed</h3>${stats}${rows}</div>`;
  },

  _logoMarkHTML(symbol, { scannerType = '', scannerChip = '', sizeClass = '' } = {}) {
    const logoSymbol = String(symbol || '').toLowerCase().replace(/usdt$/, '');
    const label = String(symbol || '').replace(/USDT$/i, '').slice(0, 3);
    const localSvg = `assets/coin-logos/${logoSymbol}.svg`;
    const localPng = `assets/coin-logos/${logoSymbol}.png`;
    const remoteA = `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${logoSymbol}.png`;
    const remoteB = `https://assets.coincap.io/assets/icons/${logoSymbol}@2x.png`;
    const onerr = `onerror="(function(img){const s=[img.dataset.f1,img.dataset.f2,img.dataset.f3];const i=Number(img.dataset.fi||0);if(i<s.length&&s[i]){img.dataset.fi=i+1;img.src=s[i];}else{img.style.display='none';if(img.nextElementSibling)img.nextElementSibling.style.display='flex';}})(this)"`;
    return `<span class="asset-icon asset-visual ${sizeClass} ${scannerType ? `scanner-visual ${scannerType}-visual` : ''}"><img class="coin-logo" src="${localSvg}" alt="${logoSymbol} logo" loading="lazy" data-f1="${localPng}" data-f2="${remoteA}" data-f3="${remoteB}" data-fi="0" ${onerr}><span class="coin-logo-fallback">${label}</span>${scannerChip}</span>`;
  },

  _exitPolicy() {
    const exits = CONFIG.exits || {};
    return {
      takeProfitPct: exits.takeProfitPct ?? 10,
      holdLimitDays: exits.holdLimitDays ?? CONFIG.activeParams?.holdLimit ?? 7,
      stopAtrMult: exits.stopAtrMult ?? 2,
      partialPct: exits.partialPct ?? 50,
      runnerTrailAtrMult: exits.runnerTrailAtrMult ?? 2,
      moveStopToBreakevenAfterPartial: exits.moveStopToBreakevenAfterPartial !== false,
      feePerSide: exits.feePerSide ?? 0.001,
      slippagePerSide: exits.slippagePerSide ?? 0.001,
    };
  },
  
  _getSignalHistory() {
    try {
      const raw = localStorage.getItem(this.SIGNAL_HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      return Array.isArray(history) ? history : [];
    } catch (e) { return []; }
  },

  /** Keep a real timeline (not one-row-per-coin). Drop only exact duplicate spam. */
  _saveSignalHistory(history) {
    const list = Array.isArray(history) ? [...history] : [];
    const cleaned = [];
    for (const h of list) {
      const prev = cleaned[cleaned.length - 1];
      // Skip back-to-back identical transitions for the same id
      if (prev && prev.id === h.id && prev.from === h.from && prev.to === h.to) continue;
      cleaned.push(h);
    }
    const trimmed = cleaned.slice(0, 300);
    this.state.latestSignalHistory = trimmed;
    try {
      localStorage.setItem(this.SIGNAL_HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('Failed to save signal history', e);
    }
    return trimmed;
  },

  _appendSignalEvent(entry) {
    if (!entry?.id || !entry.to) return;
    const history = this._getSignalHistory();
    history.unshift({
      time: entry.time || new Date().toISOString(),
      id: entry.id,
      name: entry.name || entry.id,
      symbol: entry.symbol || entry.id,
      icon: entry.icon || '',
      from: entry.from || 'NEUTRAL',
      to: entry.to,
      score: entry.score ?? 0,
      price: entry.price ?? null,
      kind: entry.kind || null,
    });
    this._saveSignalHistory(history);
  },

  _trackSignalChanges() {
    const history = this._getSignalHistory();
    const now = new Date().toISOString();
    let changed = false;

    for (const asset of this.state.allAssets) {
      const id = asset.asset?.id;
      if (!id) continue;
      // Scalps are logged by _trackScalpChanges (appear/expire) + loadAll refresh below via same map
      const newSignal = asset.signalResult?.signal ?? 'NEUTRAL';
      const oldSignal = this._previousSignals.get(id);

      if (oldSignal && oldSignal !== newSignal) {
        const isScalp = asset.category === 'scalper' || asset.asset?.isScalp || String(id).includes('_5M');
        history.unshift({
          time: now,
          id,
          name: asset.asset?.name || id,
          symbol: isScalp ? `${asset.asset?.symbol || id} (5m)` : (asset.asset?.symbol || id),
          icon: isScalp ? '⚡' : (asset.asset?.icon || ''),
          from: oldSignal,
          to: newSignal,
          score: asset.signalResult?.score ?? 0,
          price: asset.price,
          kind: isScalp ? 'scalp' : (asset.asset?.isMoonshot || String(id).includes('_4H') ? 'moonshot' : 'daily'),
        });
        changed = true;
      }
      this._previousSignals.set(id, newSignal);
    }
    if (changed || history !== this.state.latestSignalHistory) this._saveSignalHistory(history);
  },

  _trackScalpChanges(setups) {
    const history = this._getSignalHistory();
    const now = new Date().toISOString();
    const currentSetupIds = new Set();
    let changed = false;

    for (const s of setups || []) {
      const id = s.asset?.id;
      if (!id) continue;
      currentSetupIds.add(id);
      const oldSignal = this._previousScalps.get(id);
      const newSignal = s.signalResult?.signal ?? 'BUY';

      if (!oldSignal || oldSignal !== newSignal) {
        history.unshift({
          time: now,
          id,
          name: s.asset?.name || id,
          symbol: `${s.asset?.symbol || id} (5m)`,
          icon: '⚡',
          from: oldSignal || 'NEUTRAL',
          to: newSignal,
          score: s.signalResult?.score ?? 0,
          price: s.price,
          kind: 'scalp',
        });
        this._previousScalps.set(id, newSignal);
        this._previousSignals.set(id, newSignal);
        changed = true;
      }
    }

    for (const [id, oldSignal] of [...this._previousScalps.entries()]) {
      if (currentSetupIds.has(id)) continue;
      history.unshift({
        time: now,
        id,
        name: String(id).replace(/_5M$/, '').replace(/USDT$/, ''),
        symbol: `${String(id).replace(/_5M$/, '').replace(/USDT$/, '')} (5m)`,
        icon: '⚡',
        from: oldSignal,
        to: 'EXPIRED',
        score: 0,
        price: 0,
        kind: 'scalp',
      });
      this._previousScalps.delete(id);
      this._previousSignals.delete(id);
      changed = true;
    }

    if (changed) this._saveSignalHistory(history);
  },

  // ─── Boot ────────────────────────────────────────────────────────────────────
  // ─── New listings research (announcements + newly seen spot pairs) ─────────
  async refreshListings({ silent = false } = {}) {
    const status = document.getElementById('listingsStatus');
    const annEl = document.getElementById('listingsAnnouncements');
    const pairsEl = document.getElementById('listingsNewPairs');
    if (!annEl || !pairsEl) return;

    if (!silent && status) status.textContent = 'Loading Binance listing feed…';

    const cfg = CONFIG.listings || {};
    const snapKey = cfg.snapshotKey || 'trading_listings_symbols_v1';
    const artKey = cfg.seenArticlesKey || 'trading_listings_articles_v1';

    let articles = null;
    try {
      articles = await API.getListingAnnouncements({ pageSize: 12 });
    } catch (e) {
      articles = null;
    }

    if (articles && articles.length) {
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem(artKey) || '{}') || {}; } catch { seen = {}; }
      const rows = articles.map(a => {
        const isNew = !seen[a.id];
        return `<a class="listings-row${isNew ? ' listings-row-new' : ''}" href="${a.url}" target="_blank" rel="noopener noreferrer">
          <span class="listings-title">${isNew ? '🆕 ' : ''}${this._esc(a.title)}</span>
        </a>`;
      }).join('');
      annEl.innerHTML = `<h3>Listing announcements</h3>${rows}`;
      const nextSeen = { ...seen };
      articles.forEach(a => { nextSeen[a.id] = Date.now(); });
      try { localStorage.setItem(artKey, JSON.stringify(nextSeen)); } catch (e) {}
    } else {
      annEl.innerHTML = `<h3>Listing announcements</h3>
        <p class="no-data">Live CMS feed blocked in this browser (CORS) or temporarily unavailable.
        Use the official links above — the Telegram bot can still alert when <code>LISTINGS_ALERTS</code> is on.</p>`;
    }

    const symbols = await API.getSpotUsdtSymbols();
    if (symbols && symbols.length) {
      let prev = [];
      try { prev = JSON.parse(localStorage.getItem(snapKey) || '[]') || []; } catch { prev = []; }
      const prevSet = new Set(prev);
      const firstRun = prev.length === 0;
      const fresh = firstRun ? [] : symbols.filter(s => !prevSet.has(s));
      try { localStorage.setItem(snapKey, JSON.stringify(symbols)); } catch (e) {}

      if (firstRun) {
        pairsEl.innerHTML = `<h3>Newly seen spot pairs</h3>
          <p class="no-data">Baseline saved (${symbols.length} USDT spot pairs). New pairs that appear after this refresh will show here.</p>`;
      } else if (!fresh.length) {
        pairsEl.innerHTML = `<h3>Newly seen spot pairs</h3>
          <p class="no-data">No new USDT spot pairs since last snapshot (${symbols.length} tracked).</p>`;
      } else {
        pairsEl.innerHTML = `<h3>Newly seen spot pairs</h3>
          <div class="listings-chips">${fresh.slice(0, 40).map(s => {
            const base = s.replace(/USDT$/, '');
            return `<a class="listings-chip" href="https://www.binance.com/en/trade/${base}_USDT" target="_blank" rel="noopener noreferrer">${base}</a>`;
          }).join('')}</div>
          <p class="edu-tip" style="margin-top:12px">💡 Before buying: place OCO (TP + stop) or a trailing stop immediately. Your missed trail on a +80% rip is exactly why.</p>`;
      }
    } else {
      pairsEl.innerHTML = `<h3>Newly seen spot pairs</h3><p class="no-data">Could not load exchangeInfo (Binance rate-limit / IP). Try Refresh later.</p>`;
    }

    if (status) status.textContent = silent ? 'Auto-refreshed' : 'Updated';
  },

  _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  async init() {
    this.state.loading = true; // Set to true immediately so global boot loader stays up
    this.state.latestSignalHistory = this._getSignalHistory();
    // Holdings always use one base entry per coin (ZENUSDT, never ZENUSDT_4H)
    this.state.invested = [...new Set(this.state.invested.map(id => String(id).toUpperCase().replace('_4H', '').replace('_5M', '')))];
    try { localStorage.setItem('trading_invested', JSON.stringify(this.state.invested)); } catch (e) {}
    this._backfillHoldingsMeta();
    // Clean, upgrade, and deduplicate the user's saved watchlist
    // IMPORTANT: Strip out any corrupted scalper IDs (e.g. NILUSDT_5MUSDT) that got accidentally saved
    let cleanWatchlist = this.state.watchlist
      .filter(id => !String(id).includes('_5M') && !String(id).includes('_5MUSDT')) // remove scalper garbage
      .map(id => {
        let normId = id.toUpperCase();
        if (!normId.endsWith('USDT') && !normId.includes('_4H')) normId += 'USDT';
        // If it's not a core coin and doesn't have _4H yet, upgrade it to the new _4H system
        if (!normId.includes('_4H') && !CONFIG.assets.crypto.some(a => a.id === normId && !a.grafted)) {
          normId += '_4H';
        }
        return normId;
      })
      .filter(id => {
        // Strip out duplicated moonshots if the base coin is already tracked as a core coin
        if (id.endsWith('_4H')) {
          const baseSymbol = id.replace('USDT_4H', '').replace('_4H', '');
          const isCore = CONFIG.assets.crypto.some(a => a.symbol === baseSymbol && !a.grafted);
          if (isCore) return false;
        }
        return true;
      });
    this.state.watchlist = [...new Set(cleanWatchlist)]; // Remove duplicates
    // Persist the cleaned watchlist immediately to prevent re-corruption
    try { localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist)); } catch(e) {}

    // Inject dynamic watchlist assets (e.g. starred Moonshots) into CONFIG permanently
    this.state.watchlist.forEach(normId => {
      if (!CONFIG.assets.crypto.some(a => a.id === normId)) {
        CONFIG.assets.crypto.push({
          id: normId,
          symbol: normId.replace('USDT_4H', '').replace('USDT', ''),
          name: normId.replace('USDT_4H', '').replace('USDT', ''),
          currency: 'USD',
          icon: '🚀',
          grafted: true,
          isMoonshot: true
        });
      }
    });

    this._bindUI();
    this._hideEmptyCategoryTabs();
    this._initTooltips();
    // Mobile hamburger menu from Topbar
    const hamburger = document.getElementById('sidebarToggle');
    const sidebar = document.querySelector('.sidebar');
    const mobileCloseBtn = document.getElementById('mobileCloseBtn');
    const overlay = document.getElementById('sidebarOverlay');
    
    if (hamburger && sidebar && overlay) {
      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('active');
      });
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
      });
      if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', () => {
          sidebar.classList.remove('open');
          overlay.classList.remove('active');
        });
      }
      // Close sidebar when a nav link is clicked on mobile
      sidebar.querySelectorAll('a, button').forEach(el => {
        el.addEventListener('click', () => {
          if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
          }
        });
      });
    }

    this._initNewsTape();
      // Paint instantly from last-known snapshot while the live fetch runs.
      if (this._restoreSnapshot()) this._render();
      
      await this._fetchFearGreed();  // sentiment feeds the signal engine — fetch first
      await this.loadAll(true);
      this._scheduleRefresh();

    // Auto-scan moonshots in the background every 5 minutes (300,000 ms)
    this.state.moonshotTimer = setInterval(() => this._autoScanMoonshots(), 5 * 60 * 1000);
    // Kick off an initial background scan 5 seconds after the app loads
    setTimeout(() => this._autoScanMoonshots(), 5000);

    this._bindHoldingsFollowedActions();

    // New listings research panel (no auto-buy)
    if (CONFIG.listings?.enabled !== false) {
      setTimeout(() => this.refreshListings(), 8000);
      const pollMs = CONFIG.listings?.pollMs || (5 * 60 * 1000);
      this.state.listingsTimer = setInterval(() => this.refreshListings({ silent: true }), pollMs);
    }

    // 5m Scalper — pullback scanner (config-gated)
    if (CONFIG.scalper?.enabled !== false) {
      const scalpEvery = CONFIG.scalper?.scanIntervalMs ?? (2 * 60 * 1000);
      const scalpDelay = CONFIG.scalper?.initialDelayMs ?? 12000;
      this.state.scalpTimer = setInterval(() => this._autoScanScalps(), scalpEvery);
      setTimeout(() => this._autoScanScalps(), scalpDelay);
    }
  },

  // Hide filter tabs for asset categories that are empty in CONFIG.
  _hideEmptyCategoryTabs() {
    const map = {
      crypto:      CONFIG.assets.crypto,
    };
    document.querySelectorAll('.filter-tab').forEach(tab => {
      const cat = tab.dataset.cat;
      if (cat && cat !== 'all' && cat !== 'watchlist' && cat !== 'holdings' && cat !== 'history' && cat !== 'oversold' && cat !== 'highconf' && cat !== 'trending' && cat !== 'scalper' && (!map[cat] || map[cat].length === 0)) {
        tab.style.display = 'none';
      }
    });
  },

  // ─── Custom Tooltips ────────────────────────────────────────────────────────
  _initTooltips() {
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    document.body.appendChild(tooltip);

    let activeEl = null;

    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[title], [data-title]');
      if (!el) return;

      const text = el.getAttribute('title') || el.getAttribute('data-title');
      if (!text) return;

      if (el.hasAttribute('title')) {
        el.setAttribute('data-title', text);
        el.removeAttribute('title');
      }

      activeEl = el;
      tooltip.textContent = text;
      tooltip.classList.add('visible');
    });

    document.addEventListener('mousemove', (e) => {
      if (!activeEl) return;
      // Position tooltip near cursor, offset slightly
      let x = e.clientX + 15;
      let y = e.clientY + 20;

      // Prevent overflow off right edge
      if (x + tooltip.offsetWidth > window.innerWidth - 10) {
        x = e.clientX - tooltip.offsetWidth - 10;
        // flip arrow if we want, but simple for now
      }
      // Prevent overflow off bottom
      if (y + tooltip.offsetHeight > window.innerHeight - 10) {
        y = e.clientY - tooltip.offsetHeight - 15;
      }

      // Clamp to left and top edges
      if (x < 10) x = 10;
      if (y < 10) y = 10;

      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });

    document.addEventListener('mouseout', (e) => {
      if (activeEl && (!e.relatedTarget || !activeEl.contains(e.relatedTarget))) {
        tooltip.classList.remove('visible');
        activeEl = null;
      }
    });

    // Dismiss tooltip immediately on scroll or touch (critical for mobile)
    const dismissTooltip = () => { tooltip.classList.remove('visible'); activeEl = null; };
    window.addEventListener('scroll', dismissTooltip, true);   // capture phase catches all scrollable containers
    document.addEventListener('touchstart', dismissTooltip);
    document.addEventListener('click', dismissTooltip);
    
    // Re-bind dynamically created elements by listening on body (which we do)
  },

  // ─── Load all asset data ─────────────────────────────────────────────────────
  async loadAll(silent = false) {
    if (this.state.loading) {
      console.warn('[Dashboard] loadAll called but already loading, skipping concurrent fetch.');
      return;
    }
    this.state.loading = true;
    this._updateLiveStatus();
    if (!silent) this._setLoading(true);
    try {
      const crypto = await API.getAllCrypto();

      const all = [
        ...(crypto || [])
          .filter(d => {
            if (!d.closes || d.closes.length < 30) return false;
            const badTokens = ['SNDKBUSDT', 'SPCXBUSDT', 'EULUSDT'];
            if (badTokens.includes(d.asset?.id)) return false;
            return true;
          })
          .map(d => ({ ...d, category: 'crypto' })),
      ];

      // Signals now receive OHLCV + sentiment + symbol + marketRegime
      const fg = this._fgValue();
      
      let marketRegime = 'flat';
      const btc = all.find(a => (a.asset?.symbol === 'BTCUSDT' || a.asset?.id === 'BTCUSDT') && a.closes?.length >= 50);
      if (btc) {
        const btcSma50 = Indicators.last(Indicators.sma(btc.closes, 50));
        const btcEma9 = Indicators.last(Indicators.ema(btc.closes, 9));
        const btcEma21 = Indicators.last(Indicators.ema(btc.closes, 21));
        const btcPrice = btc.closes[btc.closes.length - 1];
        if (btcSma50) {
          marketRegime = btcPrice > btcSma50 && btcEma9 > btcEma21 ? 'bull' : btcPrice < btcSma50 && btcEma9 < btcEma21 ? 'bear' : 'flat';
        }
      }
      this.state.marketRegime = marketRegime;

      const previousPrices = new Map(this.state.allAssets.map(a => [a.asset?.id, a.price]));
      this.state.allAssets = all.map(d => {
        let signalResult = null;
        let prevSignalResult = null;
        if (d.closes?.length > 1) {
          const opts = { highs: d.highs, lows: d.lows, closes4H: d.closes4H, volumes: d.volumes, fearGreed: fg, symbol: d.asset?.symbol || d.asset?.id, marketRegime, marketCap: d.marketCap, tvl: d.tvl };
          signalResult = d.asset?.isMoonshot ? Signals.generateBreakout(d.closes, opts) : Signals.generate(d.closes, opts);
          
          const prevOpts = {
            highs: d.highs.slice(0, -1),
            lows: d.lows.slice(0, -1),
            closes4H: d.closes4H ? d.closes4H.slice(0, -1) : [],
            volumes: d.volumes.slice(0, -1),
            fearGreed: fg, symbol: opts.symbol, marketRegime, marketCap: opts.marketCap, tvl: opts.tvl
          };
          prevSignalResult = d.asset?.isMoonshot ? Signals.generateBreakout(d.closes.slice(0, -1), prevOpts) : Signals.generate(d.closes.slice(0, -1), prevOpts);
        }
        return { ...d, signalResult, prevSignalResult };
      });

      // Scalps live only in state.scalps (never graft into CONFIG — that duplicated coins on All).
      // Drop any leftover _5M / isScalp rows from the main feed, then re-attach refreshed scalps.
      this.state.allAssets = this.state.allAssets.filter(a =>
        a.category !== 'scalper'
        && !a.asset?.isScalp
        && !String(a.asset?.id || '').includes('_5M')
      );

      if (this.state.scalps && this.state.scalps.length > 0) {
        const liveScalps = await Promise.all(this.state.scalps.map(async scalp => {
          const baseId = String(scalp.asset?.id || '').replace(/_5M$/,''); // e.g. PEPEUSDT_5M -> PEPEUSDT
          const liveData = all.find(a =>
            String(a.asset?.id || '').replace(/_4H$/,'').replace(/_5M$/,'') === baseId
            || a.asset?.id === baseId
          );
          let updatedScalp = { ...scalp, category: 'scalper' };
          if (updatedScalp.asset) {
            updatedScalp.asset = { ...updatedScalp.asset, isScalp: true };
          }

          if (liveData) {
            updatedScalp.price = liveData.price;
            updatedScalp.change24h = liveData.change24h;
            updatedScalp.change4h = liveData.change4h;
          }

          try {
            const [klines5m, klines4h] = await Promise.all([
              API._fetch(`https://api.binance.com/api/v3/klines?symbol=${baseId}&interval=5m&limit=100`, 5000, 0),
              API._fetch(`https://api.binance.com/api/v3/klines?symbol=${baseId}&interval=4h&limit=100`, 5000, 0),
            ]);

            if (Array.isArray(klines4h) && klines4h.length >= 2) {
              const closes4H = klines4h.map(k => parseFloat(k[4]));
              updatedScalp.closes4H = closes4H;
              const prev4 = closes4H[closes4H.length - 2];
              const last4 = closes4H[closes4H.length - 1];
              if (prev4 > 0) updatedScalp.change4h = ((last4 - prev4) / prev4) * 100;
            }

            if (Array.isArray(klines5m) && klines5m.length >= 50) {
              const closes = klines5m.map(k => parseFloat(k[4]));
              const highs = klines5m.map(k => parseFloat(k[2]));
              const lows = klines5m.map(k => parseFloat(k[3]));
              const volumes = klines5m.map(k => parseFloat(k[5]));
              const timestamps = klines5m.map(k => k[0]);

              if (liveData && liveData.price != null) {
                const lastIdx = closes.length - 1;
                closes[lastIdx] = liveData.price;
                if (liveData.price > highs[lastIdx]) highs[lastIdx] = liveData.price;
                if (liveData.price < lows[lastIdx]) lows[lastIdx] = liveData.price;
              }

              const regime = this.state.marketRegime || 'flat';
              const result = Signals.generateScalp(closes, { highs, lows, volumes, marketRegime: regime });
              const prevResult = Signals.generateScalp(closes.slice(0, -1), {
                highs: highs.slice(0, -1), lows: lows.slice(0, -1), volumes: volumes.slice(0, -1), marketRegime: regime
              });
              updatedScalp.closes = closes;
              updatedScalp.closes1D = closes; // left sparkline canvas id ends in _1d but shows 5m for scalps
              updatedScalp.highs = highs;
              updatedScalp.lows = lows;
              updatedScalp.timestamps = timestamps;
              updatedScalp.signalResult = result;
              updatedScalp.prevSignalResult = prevResult;
              updatedScalp.change5m = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
            }
          } catch (e) {
            console.warn(`[Dashboard] Failed to refresh scalp klines for ${baseId}:`, e.message);
          }
          return updatedScalp;
        }));

        // Dedupe by scalp id, keep BUY/STRONG_BUY only for the tab
        const byId = new Map();
        for (const s of liveScalps) {
          const id = s.asset?.id;
          if (!id) continue;
          const sig = s.signalResult?.signal;
          if (sig !== 'BUY' && sig !== 'STRONG_BUY') continue;
          byId.set(id, s);
        }
        this.state.scalps = [...byId.values()];
        this.state.allAssets.push(...this.state.scalps);
      }

      if (this._previousSignals.size === 0) {
        this.state.allAssets.forEach(a => {
          this._previousSignals.set(a.asset?.id, a.signalResult?.signal ?? 'NEUTRAL');
        });
      } else {
        this._trackSignalChanges();
      }

      this.state.updatedAssetIds = new Set(this.state.allAssets
        .filter(a => !previousPrices.size || (previousPrices.has(a.asset?.id) && previousPrices.get(a.asset.id) !== a.price))
        .map(a => a.asset.id));

      const anyOk = this.state.allAssets.some(a => a.price != null);
      this.state.dataStale = !anyOk;

      this.state.lastUpdate = new Date();
      this.state.refreshDueAt = Date.now() + CONFIG.refresh.intervalMs;
      this.state.loading = false; // Always clear the internal loading flag
      if (!silent) this._setLoading(false); // Only clear UI spinner if not silent
      this._cleanStaleMoonshots(); // Instantly remove any moonshots that dropped below BUY
      this._cleanStaleScalps(); // Instantly remove any scalps that dropped below STRONG_BUY
      this._backfillHoldingsMeta();
      this._persistSnapshot();
      this._captureAlertOutcomes();
      this._render();
      this._autoResolvePaperPositions();
      this._updateMoonshotJournal();
      this._updateAlertOutcomes();
      this._refreshFollowedMarks();
      this._refreshOpenModal();
      if (!silent) this._showToast(anyOk ? 'Data refreshed ✓' : 'Fetch failed — showing last known data', anyOk ? 'success' : 'warning');
    } catch (err) {
      console.error('[Dashboard] loadAll error:', err);
      this.state.dataStale = true;
      this.state.loading = false;
      this.state.refreshDueAt = Date.now() + CONFIG.refresh.intervalMs;
      if (!silent) this._setLoading(false);
      this._render(); // Force a render to clear the skeleton and show error state
      if (!silent) this._showToast('Some data failed to load — check internet connection', 'warning');
    }
  },

  // ─── Snapshot persistence (instant paint on next load) ───────────────────────
  SNAPSHOT_KEY: 'trading_snapshot_v1',
  _persistSnapshot() {
    try {
      // Strip heavy indicator arrays and EXCLUDE scalper items (category=scalper) before saving
      const slim = this.state.allAssets
        .filter(a => a.category !== 'scalper') // never save scalper items to localStorage
        .map(a => ({
          asset: a.asset, category: a.category,
          price: a.price, change24h: a.change24h, change4h: a.change4h, 
          closes: a.closes?.slice(-100),
          closes1D: a.closes1D, closes4H: a.closes4H,
          highs: a.highs?.slice(-100), lows: a.lows?.slice(-100), 
          volumes: a.volumes?.slice(-100), timestamps: a.timestamps?.slice(-100),
          fetchedAt: a.fetchedAt, error: a.error,
          signalResult: a.signalResult
        }));
      localStorage.setItem(this.SNAPSHOT_KEY, JSON.stringify({ ts: Date.now(), assets: slim }));
    } catch (e) { /* quota — ignore */ }
  },
  _restoreSnapshot() {
    try {
      const raw = localStorage.getItem(this.SNAPSHOT_KEY);
      if (!raw) return false;
      const { ts, assets } = JSON.parse(raw);
      if (!Array.isArray(assets) || !assets.length) return false;
      // Filter out any scalper garbage that may have been saved by older code versions
      const cleanAssets = assets.filter(a => a.category !== 'scalper' && !String(a.asset?.id || '').includes('_5M'));
      const fg = this._fgValue();
      const btc = cleanAssets.find(a => (a.asset?.symbol === 'BTCUSDT' || a.asset?.id === 'BTCUSDT') && a.closes?.length >= 50);
      if (btc) {
        const btcSma50 = Indicators.last(Indicators.sma(btc.closes, 50));
        const btcPrice = btc.closes[btc.closes.length - 1];
        this.state.marketRegime = btcSma50 ? (btcPrice > btcSma50 ? 'bull' : 'bear') : 'flat';
      }
      this.state.allAssets = cleanAssets.map(d => {
          // Use the saved signalResult instead of recalculating on truncated arrays
          const signalResult = d.signalResult || { signal: 'NEUTRAL', score: 0 };
          // Populate previous signals so the first live fetch can detect and log changes!
          this._previousSignals.set(d.asset?.id, signalResult.signal);
          return { ...d, signalResult };
        });
      this.state.lastUpdate = new Date(ts);
      this.state.dataStale = true;
      this.state.updatedAssetIds = new Set(this.state.allAssets.map(a => a.asset.id));
      return true;
    } catch (e) { return false; }
  },

  // ─── Background Auto-Scanner ────────────────────────────────────────────────
  async _autoScanMoonshots() {
    const statusEl = document.getElementById('moonshotScanStatus');
    try {
      console.log('[Moonshots] Background scan starting...');
      if (statusEl) statusEl.innerHTML = '<span class="live-dot" style="background:var(--accent)"></span> Scanning Market...';
      
      // Run the scanner silently (no progress callback needed)
      const setups = await Scanner.scanMarket();
      
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      if (!setups || setups.length === 0) {
        console.log('[Moonshots] Background scan complete: 0 new setups found.');
        if (statusEl) statusEl.innerHTML = `🚀 ${timeStr} (0 new found)`;
        return;
      }
      
      // Graft into CONFIG for Moonshots section scoring — NEVER auto-star.
      // Watch ⭐ is user-only; auto-star made a background list look like a personal watchlist.
      let newlyAdded = false;
      this.state.moonshots = setups;
      setups.forEach(s => {
        const id = s.asset.id;
        this._holdMoonshotForReview(id);
        if (!CONFIG.assets.crypto.some(a => a.id === id)) {
          CONFIG.assets.crypto.push({
            id: id,
            symbol: s.asset.symbol,
            name: s.asset.name,
            currency: 'USD',
            icon: '🚀',
            grafted: true,
            isMoonshot: true
          });
          newlyAdded = true;
        }
      });

      if (newlyAdded) {
        this.loadAll(true);
        console.log(`[Moonshots] Background scan found ${setups.length} setups (shown in Moonshots — not auto-watched).`);
        if (statusEl) statusEl.innerHTML = `🚀 ${timeStr} (<b style="color:var(--pos)">+${setups.length} new!</b>)`;
      } else {
        this._renderMoonshotGrid();
        console.log('[Moonshots] Background scan complete: already tracking these setups.');
        if (statusEl) statusEl.innerHTML = `🚀 ${timeStr} (${setups.length} tracked)`;
      }
    } catch (err) {
      console.error('[Moonshots] Auto-scan failed:', err);
      if (statusEl) statusEl.innerHTML = `🚀 Auto-Scan Failed`;
    }
  },

  _cleanStaleMoonshots() {
    let removedAny = false;
    for (let i = CONFIG.assets.crypto.length - 1; i >= 0; i--) {
      const asset = CONFIG.assets.crypto[i];
      if (asset.grafted && asset.isMoonshot) {
        const baseId = asset.id.replace('_4H', '').replace('_5M', '');
        if (this.state.invested.includes(baseId)) continue;
        if (this._isMoonshotInReview(asset.id)) continue;
        
        const d = this.state.allAssets.find(a => a.asset.id === asset.id);
        const sig = d?.signalResult?.signal ?? 'NEUTRAL';
        
        // Remove faded grafts — but never yank a coin the user explicitly Watched ⭐
        if (sig !== 'BUY' && sig !== 'STRONG_BUY') {
          if (this.state.watchlist.includes(asset.id)) continue;
          console.log(`[Moonshots] Auto-cleaning stale moonshot: ${asset.id} (Signal: ${sig})`);
          CONFIG.assets.crypto.splice(i, 1);
          if (this.state.allAssets) {
            this.state.allAssets = this.state.allAssets.filter(a => a.asset.id !== asset.id);
          }
          removedAny = true;
        }
      }
    }
    return removedAny;
  },

  _holdMoonshotForReview(id) {
    this.state.moonshotReviewUntil[id] = Date.now() + this.MOONSHOT_REVIEW_MS;
    try { localStorage.setItem('trading_moonshot_review_until', JSON.stringify(this.state.moonshotReviewUntil)); } catch (e) {}
  },

  _isMoonshotInReview(id) {
    const until = Number(this.state.moonshotReviewUntil[id]) || 0;
    if (until > Date.now()) return true;
    if (until) {
      delete this.state.moonshotReviewUntil[id];
      try { localStorage.setItem('trading_moonshot_review_until', JSON.stringify(this.state.moonshotReviewUntil)); } catch (e) {}
    }
    return false;
  },

  _cleanStaleScalps() {
    // Remove legacy grafts that used to duplicate coins on All / tape
    for (let i = CONFIG.assets.crypto.length - 1; i >= 0; i--) {
      const asset = CONFIG.assets.crypto[i];
      if (asset?.isScalp || String(asset?.id || '').includes('_5M')) {
        CONFIG.assets.crypto.splice(i, 1);
      }
    }

    if (!Array.isArray(this.state.scalps)) return false;
    const before = this.state.scalps.length;
    this.state.scalps = this.state.scalps.filter(s => {
      const sig = s.signalResult?.signal;
      return sig === 'BUY' || sig === 'STRONG_BUY';
    });
    if (this.state.allAssets) {
      this.state.allAssets = this.state.allAssets.filter(a => {
        if (a.category !== 'scalper' && !a.asset?.isScalp && !String(a.asset?.id || '').includes('_5M')) return true;
        const sig = a.signalResult?.signal;
        return sig === 'BUY' || sig === 'STRONG_BUY';
      });
    }
    return this.state.scalps.length !== before;
  },

  async _autoScanScalps() {
    try {
      console.log('[Scalper] Background scan starting...');
      let setups = await Scanner.scanScalps();
      
      if (!setups) setups = [];
      
      if (setups.length === 0) {
        console.log('[Scalper] Background scan complete: 0 setups found.');
      }
      
      this._trackScalpChanges(setups);
      
      // Keep scalps out of CONFIG — only state.scalps + Scalps filter tab
      this.state.scalps = setups;
      this._cleanStaleScalps();

      if (this.state.activeCategory === 'scalper') {
        this.loadAll(true);
      } else if (this.state.activeCategory === 'history') {
        this._renderAssetGrid();
      } else {
        this._render();
      }
    } catch (e) {
      console.error('Scalper auto-scan failed:', e);
    }
  },

  // ─── Refresh timer ───────────────────────────────────────────────────────────
  _scheduleRefresh() {
    clearInterval(this.state.refreshTimer);
    clearInterval(this.state.countdownTimer);
    this.state.refreshDueAt = Date.now() + CONFIG.refresh.intervalMs;
    this.state.refreshTimer = setInterval(() => this.loadAll(true), CONFIG.refresh.intervalMs);
    this.state.countdownTimer = setInterval(() => this._updateLiveStatus(), 1000);
    this._updateLiveStatus();
  },

  // ─── Main render ───────────────────────────────────────────────────────────
  _render() {
    // Only hide the global boot loader when we are completely done loading live data
    if (!this.state.loading) {
      const globalLoader = document.getElementById('trendrunner-loader');
      if (globalLoader) globalLoader.style.display = 'none';
    }
    
    this._renderSummaryBar();
    this._renderTopOpportunities();
    this._renderAssetGrid();
    this._renderMoonshotGrid();
    this._renderLiveTape();
    this._updateLastUpdated();
    this._updateLiveStatus();
  },

  _renderLiveTape() {
    const el = document.getElementById('liveTapeTrack');
    if (!el || !this.state.allAssets.length) return;
    const seenSymbols = new Set();
    const uniqueAssets = this.state.allAssets.filter(a => {
      if (a.price == null) return false;
      if (a.category === 'scalper' || a.asset?.isScalp || String(a.asset?.id || '').includes('_5M')) return false;
      const baseSymbol = String(a.asset.id || a.asset.symbol).replace('_4H', '').replace('_5M', '').replace('USDT', '');
      if (seenSymbols.has(baseSymbol)) return false;
      seenSymbols.add(baseSymbol);
      return true;
    });

    const items = uniqueAssets
      .sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0))
      .slice(0, 12)
      .map(a => `<span class="tape-item"><strong>${a.asset.symbol}</strong><span>${a.asset.currency === 'INR' ? '₹' : '$'}${this._fmt(a.price, a.asset)}</span><em class="${a.change24h >= 0 ? 'pos' : 'neg'}">${a.change24h >= 0 ? '+' : ''}${(a.change24h || 0).toFixed(2)}%</em></span>`)
      .join('');
    el.innerHTML = items + items;
    el.classList.toggle('moving', items.length > 0);
  },

  async _initNewsTape() {
    const el = document.getElementById('newsTapeTrack');
    if (!el) return;
    const NEWS_CACHE_KEY = 'trendrunner_news_cache_v1';
    const renderItems = items => {
      const itemsStr = items.map(item => `<span class="tape-item"><a href="${item.link}" target="_blank" rel="noopener noreferrer" class="news-link">${item.title}</a> <em class="news-time">[${new Date(item.pubDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}]</em></span>`).join('');
      el.innerHTML = itemsStr + itemsStr;
      el.classList.add('moving');
    };
    const renderCached = () => {
      try {
        const cached = JSON.parse(localStorage.getItem(NEWS_CACHE_KEY) || 'null');
        if (Array.isArray(cached?.items) && cached.items.length) {
          renderItems(cached.items);
          return true;
        }
      } catch (e) {}
      return false;
    };
    const fetchFromFallback = async () => {
      const rssUrl = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(rssUrl)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(proxyUrl, { signal: controller.signal, cache: 'no-store' });
        const xml = await response.text();
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        return [...doc.querySelectorAll('item')].map(item => ({
          title: item.querySelector('title')?.textContent?.trim(),
          link: item.querySelector('link')?.textContent?.trim(),
          pubDate: item.querySelector('pubDate')?.textContent?.trim(),
        })).filter(item => item.title && item.link && item.pubDate);
      } finally {
        clearTimeout(timeout);
      }
    };
    const fetchNews = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const url = `https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F&_=${Date.now()}`;
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`News endpoint HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data.items)) throw new Error('News provider returned no items');
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const validItems = data.items.filter(item => new Date(item.pubDate) > twentyFourHoursAgo);
        
        if (validItems.length === 0) {
          el.innerHTML = '<span class="tape-item news-tape-empty">No new stories in the last 24 hours · market pulse remains live</span>';
          el.classList.remove('moving');
          return;
        }

        const normalized = validItems.slice(0, 12).map(item => ({ title: item.title, link: item.link, pubDate: item.pubDate }));
        localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: normalized }));
        renderItems(normalized);
      } catch (e) {
        console.error('News Tape Error:', e);
        try {
          const fallbackItems = await fetchFromFallback();
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const validItems = fallbackItems.filter(item => new Date(item.pubDate) > twentyFourHoursAgo).slice(0, 12);
          if (validItems.length) {
            localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: validItems }));
            renderItems(validItems);
            return;
          }
        } catch (fallbackError) {
          console.error('News fallback error:', fallbackError);
        }
        if (!renderCached()) {
          el.innerHTML = '<span class="tape-item news-tape-empty">News feed unavailable · market pulse remains live</span>';
          el.classList.remove('moving');
        }
      }
    };
    renderCached();
    fetchNews();
    setInterval(fetchNews, 15 * 60 * 1000); // 15 mins
  },

  _updateLiveStatus() {
    const text = document.getElementById('liveStatusText');
    const dot = document.querySelector('#liveStatus .live-dot');
    if (!text) return;
    if (this.state.loading) {
      text.textContent = 'Updating';
      dot?.classList.add('live-loading');
      return;
    }
    dot?.classList.remove('live-loading');
    if (this.state.dataStale) {
      text.textContent = 'Stale data';
      return;
    }
    const seconds = Math.max(0, Math.ceil((this.state.refreshDueAt - Date.now()) / 1000));
    text.textContent = `Live · ${seconds}s`;
    const freshness = document.querySelector('.freshness-item .summary-value');
    if (freshness) freshness.textContent = this._freshnessText();
  },

  // ─── Summary bar at top ──────────────────────────────────────────────────────
  _renderSummaryBar() {
    const el = document.getElementById('summaryBar');
    if (!el) return;

    const counts = { STRONG_BUY: 0, BUY: 0, NEUTRAL: 0, SELL: 0, STRONG_SELL: 0 };
    const scalpCounts = { STRONG_BUY: 0, BUY: 0, NEUTRAL: 0, SELL: 0, STRONG_SELL: 0 };
    this.state.allAssets.forEach(a => {
      const s = a.signalResult?.signal;
      if (!s || counts[s] === undefined) return;
      counts[s]++;
      if (a.category === 'scalper' || a.asset?.isScalp || String(a.asset?.id || '').includes('_5M')) {
        scalpCounts[s]++;
      }
    });

    // Total Tracked = main list only (scalps live on their own tab)
    const total = this.state.allAssets.filter(a =>
      a.category !== 'scalper' && !a.asset?.isScalp && !String(a.asset?.id || '').includes('_5M')
    ).length;
    const bullPct = total > 0 ? Math.round(((counts.STRONG_BUY + counts.BUY) / total) * 100) : 0;
    const sentiment = bullPct >= 60 ? '🟢 Bullish' : bullPct <= 40 ? '🔴 Bearish' : '🟡 Mixed';

    const isActive = (sig) => this.state.activeSignalFilter === sig ? 'active' : '';

    const staleBanner = this.state.dataStale
      ? `<div class="summary-item stale-banner" title="The last live fetch failed. Numbers below are from your last successful load.">
           <span class="summary-value" style="color:#f5a623">⚠️ Stale</span>
           <span class="summary-label">Data may be outdated</span>
            </div>
          `
      : '';

    el.innerHTML = `
      ${staleBanner}
      <div class="summary-item" title="Overall market direction based on how many assets are bullish vs bearish. Green = most assets trending up, Red = most trending down.">
        <span class="summary-value">${sentiment}</span>
        <span class="summary-label">Market Sentiment</span>
      </div>
      <div class="summary-item filterable ${isActive('STRONG_BUY')}" data-signal="STRONG_BUY" title="Strong Buys across daily/moonshot and 5m scalps. Click to show them (scalps included when this filter is on).${scalpCounts.STRONG_BUY ? ' ' + scalpCounts.STRONG_BUY + ' are 5m scalps.' : ''}">
        <span class="summary-count strong-buy">${counts.STRONG_BUY}</span>
        <span class="summary-label">Strong Buy${scalpCounts.STRONG_BUY ? ` · ${scalpCounts.STRONG_BUY}⚡` : ''}</span>
      </div>
      <div class="summary-item filterable ${isActive('BUY')}" data-signal="BUY" title="Buys across daily/moonshot and 5m scalps. Click to show them.${scalpCounts.BUY ? ' ' + scalpCounts.BUY + ' are 5m scalps.' : ''}">
        <span class="summary-count buy">${counts.BUY}</span>
        <span class="summary-label">Buy${scalpCounts.BUY ? ` · ${scalpCounts.BUY}⚡` : ''}</span>
      </div>
      <div class="summary-item filterable ${isActive('NEUTRAL')}" data-signal="NEUTRAL" title="No clear direction — indicators are mixed. Best to wait on the sidelines until a clearer signal forms. Click to filter.">
        <span class="summary-count neutral">${counts.NEUTRAL}</span>
        <span class="summary-label">Hold</span>
      </div>
      <div class="summary-item filterable ${isActive('SELL')}" data-signal="SELL" title="Assets leaning bearish — conditions favor sellers. If you own this, consider tightening your stop-loss. Click to filter.">
        <span class="summary-count sell">${counts.SELL}</span>
        <span class="summary-label">Sell</span>
      </div>
      <div class="summary-item filterable ${isActive('STRONG_SELL')}" data-signal="STRONG_SELL" title="High-conviction bearish setups where trend and momentum align to the downside. Click to filter.">
        <span class="summary-count strong-sell">${counts.STRONG_SELL}</span>
        <span class="summary-label">Strong Sell</span>
      </div>
      <div class="summary-item filterable" data-signal="ALL">
        <span class="summary-value">${total}</span>
        <span class="summary-label">Total Tracked</span>
      </div>
      ${this.state.fearGreed ? `
      <div class="summary-item fear-greed-item" title="Crypto Fear & Greed Index: Measures overall market sentiment from news, social media, and volatility. 0 = Extreme Fear (good time to buy), 100 = Extreme Greed (market may crash). Updated daily.">
        <span class="summary-value" style="color:${this._fgColor(this.state.fearGreed.value)}">${this.state.fearGreed.value_classification}</span>
        <span class="summary-label">Fear & Greed: ${this.state.fearGreed.value}/100</span>
      </div>` : ''}
      <div class="summary-item regime-item" title="BTC market regime. When bear hard-gate is on, altcoin buys are blocked.">
        <span class="summary-value">${this.state.marketRegime === 'bull' ? '🟢 Bull' : this.state.marketRegime === 'bear' ? '🔴 Bear' : '🟡 Flat'}</span>
        <span class="summary-label">BTC Regime · Alts ${this.state.marketRegime === 'bear' && CONFIG.signals?.bearRegimeBlockBuys ? 'Blocked' : this.state.marketRegime === 'bear' ? 'Restricted' : 'Open'}</span>
      </div>
      <div class="summary-item" title="Live policy: core winners only for actionable buys. Probation setups stay visible as research.">
        <span class="summary-value" style="color:#34d399">${CONFIG.signals?.coreOnlyBuys ? '🎯 Core-only live' : '🧪 All winners'}</span>
        <span class="summary-label">${(CONFIG.assets?.coreWinners || []).length} core · ${(CONFIG.assets?.probationWinners || []).length} probation research</span>
      </div>
      <div class="summary-item" title="Live exits: bank ${this._exitPolicy().partialPct}% at +${this._exitPolicy().takeProfitPct}% OCO; trail the rest (${this._exitPolicy().runnerTrailAtrMult}×ATR). Max hold ${this._exitPolicy().holdLimitDays}d.">
        <span class="summary-value" style="color:#29b6f6">⚙️ ${this._exitPolicy().partialPct}/${100 - this._exitPolicy().partialPct} · bank +${this._exitPolicy().takeProfitPct}% · trail ${this._exitPolicy().runnerTrailAtrMult}×ATR · ${this._exitPolicy().holdLimitDays}d</span>
        <span class="summary-label">Strategy (EMA ${CONFIG.activeParams.emaFast}/${CONFIG.activeParams.emaSlow})</span>
      </div>
      ${this._lastBacktestBadgeHTML()}
      <div class="summary-item freshness-item" title="Age of the latest successful market-data refresh.">
        <span class="summary-value">${this._freshnessText()}</span>
        <span class="summary-label">Signal Freshness</span>
      </div>
    `;
  },

  _lastBacktestBadgeHTML() {
    const lb = CONFIG.lastBacktest;
    if (!lb?.runAt) return '';
    const when = new Date(lb.runAt);
    const dateStr = Number.isFinite(when.getTime())
      ? when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const wr = Number.isFinite(lb.winnersWinRate) ? `${lb.winnersWinRate}% WR` : '—';
    const avg = Number.isFinite(lb.winnersAvgReturn)
      ? `${lb.winnersAvgReturn >= 0 ? '+' : ''}${lb.winnersAvgReturn}% avg`
      : '';
    const sample = Number.isFinite(lb.winnersTrades) ? `${lb.winnersTrades} trades` : '';
    const core = Number.isFinite(lb.coreCount) ? lb.coreCount : '—';
    const prob = Number.isFinite(lb.probationCount) ? lb.probationCount : '—';
    return `<div class="summary-item last-backtest-badge" title="Latest scheduled backtest across core + probation winners (accumulated). Past results are research, not a guarantee.">
      <span class="summary-value" style="color:#a78bfa">📊 ${wr}${avg ? ' · ' + avg : ''}</span>
      <span class="summary-label">Backtest ${dateStr} · ${core} core / ${prob} probation${sample ? ' · ' + sample : ''}</span>
    </div>`;
  },

  _freshnessText() {
    if (!this.state.lastUpdate) return 'Waiting';
    const age = Math.max(0, Math.floor((Date.now() - this.state.lastUpdate.getTime()) / 1000));
    if (this.state.dataStale) return 'Stale';
    return age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
  },

  _autoResolvePaperPositions() {
    if (!window.Portfolio) return;
    const positions = [...Portfolio.getState().positions];
    positions.forEach(pos => {
      const live = this.state.allAssets.find(a => a.asset.id === pos.assetId);
      const price = live?.price;
      if (!Number.isFinite(price)) return;
      let reason = null;
      if (pos.stopPrice && price <= pos.stopPrice) reason = 'STOP LOSS';
      else if (pos.takeProfitPrice && price >= pos.takeProfitPrice) reason = 'TAKE PROFIT';
      if (!reason) return;
      const result = Portfolio.sell(pos.tradeId, price, reason);
      if (result.success) this._showToast(`${pos.symbol}: ${reason} recorded (${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)})`, result.pnl >= 0 ? 'success' : 'warning');
    });
    this._renderPortfolio();
  },

  async _updateMoonshotJournal() {
    const key = 'trading_moonshot_journal_v1';
    let journal;
    try { journal = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return; }
    const open = journal.filter(entry => entry.status === 'OPEN_PAPER_TEST');
    if (!open.length) return;
    try {
      const symbols = JSON.stringify([...new Set(open.map(entry => `${entry.symbol}USDT`))]);
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`);
      const tickers = await res.json();
      const prices = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.symbol.replace('USDT', ''), Number(t.price)]));
      const now = Date.now();
      journal = journal.map(entry => {
        if (entry.status !== 'OPEN_PAPER_TEST') return entry;
        const current = prices.get(entry.symbol);
        if (!Number.isFinite(current)) return entry;
        const ageHours = (now - new Date(entry.scannedAt).getTime()) / 3600000;
        const returnPct = ((current - entry.entryPrice) / entry.entryPrice) * 100;
        const outcomes = { ...entry.outcomes };
        if (ageHours >= 1 && outcomes.oneHour === null) outcomes.oneHour = +returnPct.toFixed(2);
        if (ageHours >= 4 && outcomes.fourHour === null) outcomes.fourHour = +returnPct.toFixed(2);
        if (ageHours >= 24 && outcomes.oneDay === null) outcomes.oneDay = +returnPct.toFixed(2);
        if (ageHours >= 168 && outcomes.sevenDay === null) outcomes.sevenDay = +returnPct.toFixed(2);
        let status = entry.status;
        if (entry.stopPrice && current <= entry.stopPrice) status = 'STOPPED_OUT';
        else if (entry.takeProfitPrice && current >= entry.takeProfitPrice) status = 'TARGET_REACHED';
        else if (ageHours >= 168) status = 'COMPLETE';
        return { ...entry, currentPrice: current, lastCheckedAt: new Date(now).toISOString(), outcomes, status };
      });
      localStorage.setItem(key, JSON.stringify(journal.slice(0, 500)));
    } catch (e) {
      console.warn('[Moonshots] Journal update failed:', e.message);
    }
  },

  // ─── Fear & Greed color helper ────────────────────────────────────────────────
  _fgColor(val) {
    if (val <= 25) return '#ef4444';  // Extreme Fear - red
    if (val <= 45) return '#f97316';  // Fear - orange
    if (val <= 55) return '#eab308';  // Neutral - yellow
    if (val <= 75) return '#22c55e';  // Greed - green
    return '#10b981';                  // Extreme Greed - bright green
  },

  // ─── Fetch Fear & Greed Index ──────────────────────────────────────────────────
  // Numeric F&G value for the signal engine (API returns it as a string).
  _fgValue() {
    const v = Number(this.state.fearGreed?.value);
    return isFinite(v) ? v : undefined;
  },

  async _fetchFearGreed() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: controller.signal });
      clearTimeout(timeoutId);
      const json = await res.json();
      if (json.data && json.data[0]) {
        this.state.fearGreed = json.data[0];
        this._renderSummaryBar();
      }
    } catch (e) {
      console.warn('Fear & Greed fetch failed or timed out:', e.message);
    }
  },

  // ─── Top 4 opportunities ──────────────────────────────────────────────────
  _renderTopOpportunities() {
    const el = document.getElementById('topOpportunities');
    if (!el) return;
    if (!this.state.allAssets || !this.state.allAssets.length) {
      el.innerHTML = '<div class="muted">No data available</div>';
      return;
    }

    // Rank by Absolute Math Score and Confidence, but ONLY show actual BUY signals
    const valid = [...this.state.allAssets].filter(a => {
      if (a.category === 'scalper' || a.asset?.isScalp || String(a.asset?.id || '').includes('_5M')) return false;
      const s = a.signalResult?.signal;
      return a.closes?.length > 0 && (s === 'BUY' || s === 'STRONG_BUY');
    });
    
    this._sortAssets(valid);
    const ranked = valid.slice(0, 4);

    if (ranked.length === 0) {
      el.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted); background: var(--surface-2); border-radius: 8px;">
          <div style="font-size: 2rem; margin-bottom: 1rem;">🛡️</div>
          <h3 style="margin-bottom: 0.5rem;">No Strong Setups Found</h3>
          <p>The market is currently hostile or choppy. The algorithm is protecting your capital.<br>Cash (USDT) is the safest position right now.</p>
        </div>
      `;
      return;
    }

    el.innerHTML = ranked.map(a => this._assetCardHTML(a, true)).join('');
    this._attachCardListeners(el);
    // Draw sparklines
    ranked.forEach(a => {
      const isPos24 = (a.change24h ?? 0) >= 0;
      const isPos4 = (a.change4h ?? 0) >= 0;
      if (a.closes1D?.length > 0) {
        Charts.renderSparkline(`spark_top_${a.asset.id}_1d`, a.closes1D, isPos24);
      }
      if (a.closes4H?.length > 0) {
        Charts.renderSparkline(`spark_top_${a.asset.id}_4h`, a.closes4H, isPos4);
      }
    });

    // Alert on strong signals across ALL assets, not just the top 4.
    this.state.allAssets.forEach(a => {
      const s = a.signalResult?.signal;
      if (s === 'STRONG_BUY' || s === 'STRONG_SELL') {
        this._maybeNotify(a);
      }
    });
  },

  // ─── Main asset grid (filtered by category) ─────────────────────────────────
  _renderAssetGrid() {
    const el = document.getElementById('assetGrid');
    if (!el) return;

    // Populate datalist with all unique symbols for autocomplete
    const datalist = document.getElementById('coinSuggestions');
    if (datalist) {
      const symbols = Array.from(new Set(this.state.allAssets.map(a => a.asset.symbol)));
      datalist.innerHTML = symbols.map(sym => `<option value="${sym}">`).join('');
    }

    const cat = this.state.activeCategory;
    let assets = [...this.state.allAssets];

    if (this.state.searchQuery) {
      const q = this.state.searchQuery.trim();
      assets = assets.filter(a => 
        a.asset.symbol.toLowerCase().includes(q) || 
        (a.asset.name && a.asset.name.toLowerCase().includes(q))
      );
    }

    if (cat === 'all') {
      // Hide scalps from the main feed — unless a summary signal filter is on (so S.BUY click finds 5m scalps)
      if (!this.state.activeSignalFilter) {
        assets = assets.filter(a => a.category !== 'scalper' && !a.asset?.isScalp && !String(a.asset?.id || '').includes('_5M'));
      }
    } else if (cat === 'watchlist') {
      assets = assets.filter(a => this.state.watchlist.includes(a.asset.id));
    } else if (cat === 'holdings') {
      const holdingsByCoin = new Map();
      assets
        .filter(a => this.state.invested.includes(a.asset.id.replace('_4H', '').replace('_5M', '')))
        .forEach(assetData => {
          const coinId = assetData.asset.id.replace('_4H', '').replace('_5M', '');
          const existing = holdingsByCoin.get(coinId);
          if (!existing || (assetData.asset.isMoonshot && !existing.asset.isMoonshot)) {
            holdingsByCoin.set(coinId, assetData);
          }
        });
      assets = Array.from(holdingsByCoin.values());
    } else if (cat === 'oversold') {
      // Just check for deeply oversold RSI (<= 35). 
      // We removed the 'macroBullish' requirement because an asset dropping hard enough to hit 30 RSI will almost always break its 50 SMA.
      assets = assets.filter(a => {
        const rsi = a.signalResult?.indicators?.rsi?.value;
        return rsi && rsi <= 35;
      }).sort((a, b) => a.signalResult.indicators.rsi.value - b.signalResult.indicators.rsi.value);
    } else if (cat === 'highconf') {
      const gate = CONFIG.signals?.strongConfidenceGate ?? CONFIG.refresh?.strongConfidenceGate ?? 100;
      assets = assets.filter(a => {
        const conf = a.signalResult?.confidence ?? 0;
        const score = a.signalResult?.score ?? 0;
        return conf >= gate && score > 0;
      });
    } else if (cat === 'scalper') {
      assets = assets.filter(a => a.category === 'scalper');
    } else if (cat === 'trending') {
      assets = assets.filter(a => a.change4h > 0).sort((a, b) => b.change4h - a.change4h);
    } else if (cat === 'history') {
      const history = this._getSignalHistory();
      if (history.length === 0) {
        el.innerHTML = `${this._followedHTML()}${this._alertOutcomesHTML()}<p class="no-data">No signal changes recorded yet. Changes will appear here after the next refresh cycle.</p>`;
      } else {
        el.innerHTML = `${this._followedHTML()}${this._alertOutcomesHTML()}<div class="signal-history-list">${history.map(h => {
          const time = new Date(h.time);
          const timeStr = time.toLocaleDateString('en-IN', {day:'2-digit', month:'short'}) + ' ' + time.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'});
          const fromLevel = Signals.level(h.from);
          const toLevel = Signals.level(h.to);
          const priceStr = h.price ? '$' + (h.price < 1 ? h.price.toFixed(4) : h.price.toFixed(2)) : '';
          const baseId = String(h.id || '').toUpperCase().replace(/_(?:4H|5M)$/, '');
          const baseSymbol = baseId.endsWith('USDT') ? baseId.slice(0, -4) : baseId;
          const binanceId = `${baseSymbol}_USDT`;
          const idUp = String(h.id || '').toUpperCase();
          const scannerType = h.kind === 'scalp' || idUp.endsWith('_5M')
            ? 'scalper'
            : (h.kind === 'moonshot' || idUp.endsWith('_4H') ? 'moonshot' : '');
          const scannerChip = scannerType === 'moonshot'
            ? '<span class="scanner-chip moonshot-chip">MOON</span>'
            : (scannerType === 'scalper' ? '<span class="scanner-chip scalper-chip">SCALP</span>' : '');
          const historyIcon = `<span class="sh-visual ${scannerType ? `scanner-visual ${scannerType}-visual` : ''}">${this._logoMarkHTML(baseSymbol, { scannerType, scannerChip })}</span>`;
          const toShort = h.to === 'EXPIRED' ? 'OUT' : toLevel.short;
          const toCls = h.to === 'EXPIRED' ? 'neutral' : toLevel.cls;
          return `<a href="https://www.binance.com/en/trade/${binanceId}?type=spot&ref=TRENDRUNNER" target="_blank" rel="noopener noreferrer" class="signal-history-entry" style="text-decoration:none; color:inherit;">
            ${historyIcon}
            <span class="sh-name">${h.name} <small>${h.symbol}</small></span>
            <span class="signal-badge signal-${fromLevel.cls}" style="font-size:11px;padding:2px 6px;">${fromLevel.short}</span>
            <span class="sh-arrow">→</span>
            <span class="signal-badge signal-${toCls}" style="font-size:11px;padding:2px 6px;">${toShort}</span>
            <span class="sh-price">${priceStr}</span>
            <span class="sh-time">${timeStr}</span>
            </a>`;
        }).join('')}</div>`;
      }
      return;
    } else if (cat !== 'all') {
      assets = assets.filter(a => a.category === cat);
    }

    if (this.state.activeSignalFilter) {
      assets = assets.filter(a => a.signalResult?.signal === this.state.activeSignalFilter);
    }

    this.state.filtered = assets;

    if (cat === 'scalper' && assets.length === 0 && !this.state.activeSignalFilter) {
      el.innerHTML = `<div class="moonshot-empty-state"><div class="moonshot-empty-icon">⚡</div><p class="moonshot-empty-title">No active 5m scalps</p><p class="moonshot-empty-sub">Scanner looks for <strong>EMA pullbacks after an impulse</strong> on liquid alts. Empty is normal in chop — wait for <strong>5m CONFIRM</strong>, small size, tight stop, bank at 2R.</p></div>`;
      return;
    }

    // Sort by validated winner tier first, then trade quality, then confidence.
    // Skip this sort if we're on the 'trending' tab, which has its own percentage-based sort.
    if (cat !== 'trending') {
      this._sortAssets(assets);
    }

    if (assets.length === 0) {
      const sig = this.state.activeSignalFilter;
      let msg = 'No assets match this filter currently.';
      if (sig) {
        const scalpN = this.state.allAssets.filter(a =>
          (a.category === 'scalper' || a.asset?.isScalp) && a.signalResult?.signal === sig
        ).length;
        if (scalpN > 0 && cat !== 'all') {
          msg = `No matches on this tab. ${scalpN}× ${sig.replace('_', ' ')} are on <strong>⚡ 5m Scalps</strong> — click Strong Buy again from All, or open that tab.`;
        } else {
          msg = `No ${sig.replace('_', ' ')} setups right now.`;
        }
      }
      el.innerHTML = this.state.loading
        ? '<p class="no-data">No data yet — loading…</p>'
        : `<p class="no-data">${msg}</p>`;
      return;
    }

    el.innerHTML = assets.map(a => this._assetCardHTML(a, false)).join('');
    this._attachCardListeners(el);

    this._initSparklines(assets);
  },

  _renderMoonshotGrid() {
    const grid = document.getElementById('moonshotGrid');
    if (!grid) return;

    // Prefer latest scan results (manual or auto); else grafted moonshots from live feed
    let moonshots = Array.isArray(this.state.moonshots) ? [...this.state.moonshots] : [];
    if (!moonshots.length) {
      moonshots = this.state.allAssets.filter(a => a.asset?.isMoonshot);
    } else {
      // Refresh prices/signals from live feed when available
      moonshots = moonshots.map(s => {
        const live = this.state.allAssets.find(a => a.asset?.id === s.asset?.id);
        return live || s;
      });
    }

    if (moonshots.length === 0) {
      grid.innerHTML = '<p class="no-data">No explosive setups found right now. Wait for the background scanner or run a manual scan.</p>';
      return;
    }

    this._sortAssets(moonshots);
    grid.innerHTML = moonshots.map(s => this._assetCardHTML(s, false, true)).join('');
    this._attachCardListeners(grid);
    this._initSparklines(moonshots, true);
  },

  _initSparklines(assets, isMoonshot = false) {
    assets.forEach(a => {
      const isScalp = a.category === 'scalper' || a.asset?.isScalp || String(a.asset?.id || '').includes('_5M');
      const prefix = isMoonshot ? 'spark_moonshot_' : 'spark_';
      // Scalp cards: left canvas is 5m (closes / closes1D alias), right is 4H
      const seriesLeft = isScalp ? (a.closes || a.closes1D) : a.closes1D;
      const seriesRight = a.closes4H;
      const isPosLeft = isScalp ? ((a.change5m ?? a.change24h ?? 0) >= 0) : ((a.change24h ?? 0) >= 0);
      const isPosRight = (a.change4h ?? 0) >= 0;

      if (seriesLeft?.length > 0) {
        Charts.renderSparkline(`${prefix}${a.asset.id}_1d`, seriesLeft, isPosLeft);
      }
      if (seriesRight?.length > 0) {
        Charts.renderSparkline(`${prefix}${a.asset.id}_4h`, seriesRight, isPosRight);
      }
    });
  },

  _sortAssets(assets) {
    assets.sort((a, b) => {
      const tierDiff = this._winnerTierRank(a.signalResult?.winnerTier) - this._winnerTierRank(b.signalResult?.winnerTier);
      if (tierDiff !== 0) return tierDiff;

      const signalRank = { STRONG_BUY: 0, BUY: 1, NEUTRAL: 2, SELL: 3, STRONG_SELL: 4 };
      const signalDiff = (signalRank[a.signalResult?.signal] ?? 5) - (signalRank[b.signalResult?.signal] ?? 5);
      if (signalDiff !== 0) return signalDiff;

      const confDiff = (b.signalResult?.confidence ?? 0) - (a.signalResult?.confidence ?? 0);
      if (confDiff !== 0) return confDiff;

      const qa = this._tradeQuality(a.signalResult).rank;
      const qb = this._tradeQuality(b.signalResult).rank;
      if (qa !== qb) return qa - qb;
      return (b.signalResult?.score ?? 0) - (a.signalResult?.score ?? 0);
    });
  },


  // ─── Generate asset card HTML ────────────────────────────────────────────────
  _assetCardHTML(d, isTop = false, isMoonshot = false) {
    const { asset, price, change24h, closes, signalResult, category, error } = d;
    const sig = signalResult?.signal ?? 'NEUTRAL';
    const level = Signals.level(sig);
    const conf = signalResult?.confidence ?? 0;
    const score = signalResult?.score ?? 0;
    const rawScore = signalResult?.rawScore ?? score;
    const rsi = signalResult?.indicators?.rsi?.value ?? '–';
    const winnerTier = signalResult?.winnerTier ?? 'none';
    
    let momentumIcon = '';
    let momentumTitle = '';
    if (d.prevSignalResult) {
      const prevSig = d.prevSignalResult.signal ?? 'NEUTRAL';
      if (prevSig !== sig) {
        const rank = { STRONG_BUY: 4, BUY: 3, NEUTRAL: 2, SELL: 1, STRONG_SELL: 0 };
        const fromRank = rank[prevSig] ?? 2;
        const toRank = rank[sig] ?? 2;
        if (toRank > fromRank) {
          momentumIcon = ' ↗️';
          momentumTitle = ` (Upgraded from ${prevSig} since last candle)`;
        } else if (toRank < fromRank) {
          momentumIcon = ' ↘️';
          momentumTitle = ` (Downgraded from ${prevSig} since last candle)`;
        }
      }
    }
    
    let sparkId1D = `spark_${asset.id}_1d`;
    let sparkId4H = `spark_${asset.id}_4h`;
    if (isTop) {
      sparkId1D = `spark_top_${asset.id}_1d`;
      sparkId4H = `spark_top_${asset.id}_4h`;
    } else if (isMoonshot) {
      sparkId1D = `spark_moonshot_${asset.id}_1d`;
      sparkId4H = `spark_moonshot_${asset.id}_4h`;
    }

    const priceStr = price !== null
      ? (asset.currency === 'INR' ? '₹' : '$') + this._fmt(price, asset)
      : 'N/A';

    const chg24Str  = change24h !== null ? (change24h >= 0 ? '+' : '') + change24h.toFixed(2) + '%' : '–';
    const chg24Cls  = change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg';

    const change4h = d.change4h;
    const chg4Str = change4h != null ? (change4h >= 0 ? '+' : '') + change4h.toFixed(2) + '%' : '–';
    const chg4Cls = change4h == null ? 'flat' : change4h >= 0 ? 'pos' : 'neg';

    // Normalize asset ID for invested check (strip _4H/_5M since all locks store base USDT ID)
    const normalizedId = asset.id.replace('_4H', '').replace('_5M', '');
    const isStarred = this.state.watchlist.includes(asset.id);
    const isLocked = this.state.invested.includes(normalizedId);
    const quality = this._tradeQuality(signalResult);
    const catBadge = { crypto: '₿ Crypto', stocks: '🇮🇳 Stock', commodities: '🪙 Commodity', forex: '💱 Forex' }[category] ?? category;
    const winnerBadge = this._winnerTierBadge(winnerTier);
    const researchChip = signalResult?.coreOnlyFiltered
      ? `<span class="research-chip" title="Probation setup — research/paper only while core-only mode is on">Research</span>`
      : (signalResult?.regimeBlocked || signalResult?.greedBlocked)
        ? `<span class="research-chip blocked-chip" title="${signalResult.regimeBlocked ? 'Blocked: BTC bear regime' : 'Blocked: Extreme Greed'}">Blocked</span>`
        : '';
    const timingSignal = signalResult?.indicators?.timing4H?.signal
      || signalResult?.indicators?.breakout?.entryTiming
      || signalResult?.indicators?.scalp?.entryTiming
      || null;
    const timingDesc = signalResult?.indicators?.timing4H?.description
      || signalResult?.indicators?.breakout?.entryTimingDesc
      || signalResult?.indicators?.scalp?.entryTimingDesc
      || '';
    const isScalpCard = !!(asset.isScalp || d.category === 'scalper' || String(asset.id || '').includes('_5M'));
    const isMoonCard = !!(asset.isMoonshot || String(asset.id || '').includes('_4H'));
    let timingChip = '';
    if (timingSignal === 'CONFIRM') {
      const confLabel = isScalpCard ? '5m CONFIRM' : '4H CONFIRM';
      timingChip = `<span class="timing-chip timing-confirm" title="${timingDesc || 'Timing supports entry'}">${confLabel}</span>`;
    } else if (timingSignal === 'WAIT') {
      const waitLabel = isScalpCard
        ? '5m WAIT · retest'
        : (isMoonCard ? '4H WAIT · retest' : '4H WAIT · dip');
      timingChip = `<span class="timing-chip timing-wait" title="${timingDesc || 'Wait for a cooler entry — do not chase'}">${waitLabel}</span>`;
    }
    const updateClass = this.state.updatedAssetIds.has(asset.id) ? ' value-updated' : '';
    const scannerType = asset.isMoonshot ? 'moonshot' : asset.isScalp ? 'scalper' : '';
    const scannerChip = scannerType
      ? `<span class="scanner-chip ${scannerType}-chip">${scannerType === 'moonshot' ? 'MOON' : 'SCALP'}</span>`
      : '';
    const assetMark = this._logoMarkHTML(asset.symbol || normalizedId, { scannerType, scannerChip });

    let fundChip = '';
    if (d.tvl && d.tvl > 0) {
      const fundData = signalResult?.indicators?.fundamental || signalResult?.indicators?.tvl;
      const fundScore = fundData?.score ?? 0;
      const tvlStr = d.tvl > 1e9 ? `$${(d.tvl/1e9).toFixed(1)}B` : d.tvl > 1e6 ? `$${(d.tvl/1e6).toFixed(1)}M` : `$${d.tvl.toFixed(0)}`;
      fundChip = `
        <div class="ind-chip" title="DefiLlama Fundamentals: Total Value Locked is ${tvlStr}. ${fundData?.description || ''}">
          <span class="ind-label">TVL</span>
          <span class="ind-val ${fundScore > 0 ? 'pos' : fundScore < 0 ? 'neg' : ''}">${tvlStr}</span>
        </div>
      `;
    } else {
      fundChip = `
        <div class="ind-chip" style="opacity: 0.5" title="No DefiLlama 'Locked Value' data available for this asset (usually because it is a Layer-1 like Bitcoin).">
          <span class="ind-label">TVL</span>
          <span class="ind-val">N/A</span>
        </div>
      `;
    }

    let quickTargets = '';
    if ((sig === 'BUY' || sig === 'STRONG_BUY') && signalResult?.stopSuggest) {
      const tp = signalResult.stopSuggest.takeProfitPrice;
      const sl = signalResult.stopSuggest.stopPrice;
      const slStr = sl < 1 ? sl.toFixed(4) : sl.toFixed(2);
      const riskPct = signalResult.stopSuggest.distancePct;
      const rewardPct = signalResult.stopSuggest.takeProfitPct;
      const rewardRisk = riskPct > 0 && rewardPct ? (rewardPct / riskPct).toFixed(1) : '–';
      const suggestedSize = riskPct > 0 ? (10000 / (riskPct / 100)).toFixed(0) : '–';
      
      if (tp) {
        const tpStr = tp < 1 ? tp.toFixed(4) : tp.toFixed(2);
        quickTargets = `
          <div class="quick-targets">
            <div class="qt-tp" title="Take Profit Target">🎯 $${tpStr}</div>
            <div class="qt-sl" title="Stop Loss Limit">🛑 $${slStr}</div>
            <div class="qt-meta">${rewardRisk}R · 1% risk on $10k: $${suggestedSize}</div>
          </div>
        `;
      } else {
        quickTargets = `
          <div class="quick-targets">
            <div class="qt-tp" title="Trailing Stop (No Limit)">🎯 Let it ride</div>
            <div class="qt-sl" title="Trailing Delta for Binance">🛑 Delta: -${signalResult.stopSuggest.distancePct}%</div>
          </div>
        `;
      }
    }

    return `
      <div class="asset-card signal-border-${level.cls} winner-tier-${winnerTier} ${this.state.updatedAssetIds.has(asset.id) ? 'data-updated' : ''}" data-asset-id="${asset.id}" data-category="${category}" role="button" tabindex="0" aria-label="${asset.name} signal card">
        <div class="card-header">
          <div class="card-title-row">
            ${assetMark}
            <div class="asset-meta">
              <div class="asset-name">${asset.name}</div>
              <a href="https://www.binance.com/en/trade/${asset.symbol}_USDT?type=spot&ref=TRENDRUNNER" target="_blank" class="asset-symbol" style="text-decoration:none; color:var(--text-secondary); pointer-events: auto;" title="Trade on Binance">${asset.symbol}USDT ↗</a>
              <div class="card-badges">
                <span class="cat-badge-inline">${catBadge}</span>
                ${winnerBadge}
                ${researchChip}
                ${timingChip}
              </div>
            </div>
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
            ${d.category === 'scalper' ? '' : `
              <div style="display:flex; gap: 4px;">
                <button class="lock-btn ${isLocked ? 'active' : ''}" data-lock-id="${asset.id}" title="${isLocked ? 'HOLDING — you bought this. Paper PnL tracked. Click to unlock.' : 'HOLDING — tap after you buy. Tracks entry price + PnL. Not the same as Watch ⭐.'}" style="background:none; border:none; cursor:pointer; font-size:16px; opacity:${isLocked ? 1 : 0.25}; transition:0.2s; padding: 0;" aria-label="Toggle holding">🔒</button>
                <button class="star-btn ${isStarred ? 'active' : ''}" data-star-id="${asset.id}" title="${isStarred ? 'WATCH — idea saved. Not a position. Click to unstar.' : 'WATCH — save idea to revisit. Does not mean you bought it (use 🔒 for that).'}" style="background:none; border:none; cursor:pointer; font-size:18px; opacity:${isStarred ? 1 : 0.3}; transition:0.2s; padding: 0;" aria-label="Toggle watch">⭐</button>
              </div>
            `}
            <div class="signal-badge signal-${level.cls} ${sig === 'STRONG_BUY' || sig === 'STRONG_SELL' ? 'pulse' : ''}" title="Signal: ${level.label}. This is the combined verdict from 4 technical indicators (RSI, MACD, Moving Averages, Bollinger Bands).${momentumTitle}">
              <span>${level.icon}</span> ${level.short}${momentumIcon}
            </div>
          </div>
        </div>

        <div class="card-price-row">
          <div class="price-main${updateClass}" title="Current live price from Binance, refreshed every 30 seconds.">${priceStr}</div>
          <div class="price-changes">
            <div class="price-change ${chg24Cls}${updateClass}" title="Price change in the last 24 hours.">1D: ${chg24Str}</div>
            <div class="price-change ${chg4Cls}${updateClass}" title="Price change over the last 4-hour candle.">4H: ${chg4Str}</div>
            ${d.category === 'scalper' 
              ? `<div class="price-change ${(d.change5m || 0) >= 0 ? 'pos' : 'neg'}${updateClass}" title="Price change over the last 5-minute candle.">5m: ${(d.change5m || 0) > 0 ? '+' : ''}${(d.change5m || 0).toFixed(2)}%</div>` 
              : ''
            }
          </div>
        </div>
        ${this.state.activeCategory === 'holdings' && isLocked ? this._holdingsPnLHTML(normalizedId, price) : ''}
        ${quickTargets}

        <div class="sparklines-container${updateClass}">
          <div class="sparkline-col" title="${d.category === 'scalper' ? '5-Minute Chart' : '1-Day Chart'}">
            <div class="spark-label">${d.category === 'scalper' ? '5M Trend (Scalp)' : '1D Trend'}</div>
            <canvas id="${sparkId1D}" height="40"></canvas>
          </div>
          <div class="sparkline-col" title="4-Hour Chart (Intraday Trend)">
            <div class="spark-label">4H Trend</div>
            <canvas id="${sparkId4H}" height="40"></canvas>
          </div>
        </div>

        <div class="card-indicators${updateClass}">
          <div class="ind-chip" title="RSI (Relative Strength Index): Measures if the asset is oversold or overbought. Below 30 = oversold (good to buy), Above 70 = overbought (consider selling). Range: 0–100.">
            <span class="ind-label">RSI</span>
            <span class="ind-val">${rsi}</span>
          </div>
          <div class="ind-chip" title="Composite Score: Weighted blend of trend, momentum, volatility and volume. Positive = bullish bias, negative = bearish bias.${rawScore !== score ? ' Raw score before TVL adjustment: ' + (rawScore > 0 ? '+' : '') + rawScore : ''}">
            <span class="ind-label">${asset.isScalp || String(asset.id||'').includes('_5M') ? 'Scalp' : (asset.isMoonshot || asset.id.includes('_4H') ? 'Breakout' : 'Score')}</span>
            <span class="ind-val">${rawScore !== score ? '<span style="opacity:0.5;font-size:0.85em">' + (rawScore > 0 ? '+' : '') + rawScore + ' →</span> ' : ''}${score > 0 ? '+' : ''}${score}</span>
          </div>
          <div class="ind-chip" title="Confidence: % of directional indicators that agree with the current signal direction. Higher is better.">
            <span class="ind-label">Confidence</span>
            <span class="ind-val">${conf}%</span>
          </div>
          ${fundChip}
        </div>

        <div class="confidence-bar-wrap" title="Visual confidence meter. The fuller the bar, the more indicators agree.">
          <div class="confidence-bar">
            <div class="confidence-fill signal-bg-${level.cls}" style="width:${conf}%"></div>
          </div>
        </div>

        ${error ? `<div class="card-error">⚠️ ${error}</div>` : ''}
        ${this._stopLevelsHTML(signalResult, asset)}
        <div class="trade-quality-badge quality-${quality.cls}" title="${quality.tip}">${quality.icon} ${quality.label}</div>
        ${(sig === 'BUY' || sig === 'STRONG_BUY') && d.category !== 'scalper' ? `<button type="button" class="follow-suggestion-btn" data-action="follow-suggestion" data-symbol="${asset.symbol}" data-signal="${sig}" data-price="${price ?? ''}">✅ I followed this</button>` : ''}
        <div class="card-footer">Click for full analysis →</div>
      </div>
    `;
  },

  // ─── Render stop-loss / take-profit levels for actionable signals ──────────
  _stopLevelsHTML(signalResult, asset) {
    const s = signalResult?.stopSuggest;
    if (!s || !['BUY', 'STRONG_BUY'].includes(signalResult?.signal)) return '';
    const policy = this._exitPolicy();
    const partial = s.partialPct ?? policy.partialPct ?? 50;
    const cur = (v) => (asset.currency === 'INR' ? '₹' : '$') + this._fmt(v, asset);
    const bankPct = s.bankTakeProfitPct ?? s.takeProfitPct ?? policy.takeProfitPct;
    const trailPct = s.runnerTrailPct ?? ((policy.runnerTrailAtrMult || 2) * (s.distancePct / (policy.stopAtrMult || 2)));
    return `
      <div class="stop-levels" title="50/50 exit plan: bank half at fixed TP, trail the rest so runners can extend past +10%.">
        <div class="stop-levels-row">
          <span class="stop-chip stop-chip-sl">🛑 Stop (100%): ${cur(s.stopPrice)} (-${s.distancePct}%)</span>
          <span class="stop-chip stop-chip-tp">🏦 Bank ${partial}%: ${cur(s.takeProfitPrice)} (+${bankPct}%)</span>
        </div>
        <div class="stop-levels-row" style="margin-top:6px">
          <span class="stop-chip stop-chip-tp" style="opacity:0.95">🏃 Runner ${100 - partial}%: trail ~${Number(trailPct).toFixed(2)}% ATR · BE after bank</span>
        </div>
      </div>
    `;
  },

  // ─── Trade Quality Tier Calculator ────────────────────────────────────────────
  _tradeQuality(signalResult) {
    const score = signalResult?.score ?? 0;
    const confidence = signalResult?.confidence ?? 0;
    const winnerTier = signalResult?.winnerTier ?? 'none';
    const conviction = signalResult?.conviction ?? 'none';
    if (winnerTier === 'core' && score >= 1.5) {
      return {
        label: conviction === 'strong' ? 'Core Conviction' : confidence >= 60 ? 'Core Setup' : 'Core Watch',
        icon: conviction === 'strong' ? '🏆' : '✅',
        cls: 'core',
        rank: confidence >= 60 ? 1 : 2,
        tip: 'Validated core winner. This is the best live slice to focus on.'
      };
    }
    if (winnerTier === 'probation' && score >= 1.5 && confidence >= 60) {
      return { label: 'Probation Setup', icon: '🧪', cls: 'probation', rank: 3, tip: 'Profitable lately, but less robust than the core winners.' };
    }
    if (score >= 2.5 && confidence < 60)  return { label: 'Risky Momentum', icon: '⚠️', cls: 'risky', rank: 4, tip: 'High score but indicators disagree. Could be a fake-out.' };
    if (score >= 1.5 && confidence >= 60)  return { label: 'Mild Buy', icon: '🤔', cls: 'mild', rank: 5, tip: 'Indicators agree but the asset is outside the validated winners focus.' };
    return { label: 'Weak / Avoid', icon: '❌', cls: 'avoid', rank: 6, tip: 'Low score or bearish. Not a good entry point right now.' };
  },

  _winnerTierRank(tier) {
    if (tier === 'core') return 0;
    if (tier === 'probation') return 1;
    return 2;
  },

  _winnerTierBadge(tier) {
    if (tier === 'core') {
      return '<span class="winner-tier-badge winner-tier-core" title="Core winner: survived rolling out-of-sample validation.">🏆 Core Winner</span>';
    }
    if (tier === 'probation') {
      return '<span class="winner-tier-badge winner-tier-probation" title="Probation winner: profitable lately, but less robust than the core set.">🧪 Probation</span>';
    }
    return '';
  },

  // ─── Number formatter ────────────────────────────────────────────────────────
  _fmt(price, asset) {
    if (price === null || price === undefined) return 'N/A';
    if (price >= 1000)   return price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    if (price >= 1)      return price.toFixed(2);
    if (price >= 0.01)   return price.toFixed(4);
    return price.toFixed(6);
  },

    _toggleInvested(originalId) {
    // Locks always store the base daily pair, even from a 4H Moonshot card
      const sourceId = originalId.toUpperCase();
      let id = sourceId.replace('_4H', '').replace('_5M', '');
    if (!id.endsWith('USDT')) id += 'USDT';

    if (this.state.invested.includes(id)) {
      this.state.invested = this.state.invested.filter(x => x !== id);
      this._removeHoldingsMetaEntry(id);
    } else {
      this.state.invested.push(id);
      // Fresh lock always records a real entry (replaces any estimated migration row)
      this._setHoldingsMetaEntry(id, this._resolveAssetPrice(id), { force: true });

      // If we are locking a Moonshot coin that isn't tracked yet in the main dashboard, graft it in!
      const hasEquivalentAsset = CONFIG.assets.crypto.some(a =>
        a.id.replace('_4H', '').replace('_5M', '') === id
      );
      if (!hasEquivalentAsset) {
        CONFIG.assets.crypto.push({
          id: id,
          symbol: id.replace('USDT', ''),
          name: id.replace('USDT', ''),
          currency: 'USD',
          icon: '💎'
        });
        // Trigger a background load to instantly fetch its history for the main dash
        setTimeout(() => this.loadAll(true), 10);
      }
    }
    
    try {
      localStorage.setItem('trading_invested', JSON.stringify(this.state.invested));
      if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
    } catch(e) { console.warn('Failed to save lock status', e); }

    const isLocked = this.state.invested.includes(id);
    this._showToast(
      isLocked ? `Holding locked: ${id.replace('USDT','')} — paper PnL on (bought tracker)` : `Holding unlocked: ${id.replace('USDT','')}`,
      isLocked ? 'success' : 'info'
    );
    // Update both the base ID and the 4H ID buttons in the UI
    document.querySelectorAll(`.lock-btn[data-lock-id="${id}"], .lock-btn[data-lock-id="${id}_4H"]`).forEach(btn => {
      if (isLocked) {
        btn.classList.add('active');
        btn.style.opacity = '1';
      } else {
        btn.classList.remove('active');
        btn.style.opacity = '0.25';
      }
    });
    
    // Refresh the asset grid so Holdings tab immediately shows the newly locked coin
    this._render();
  },

  _toggleWatchlist(id) {
    // Normalize old IDs (e.g. 'eden' -> 'EDENUSDT') just in case
    // If it's a 4H Moonshot, it already ends in _4H so we leave it alone
    if (!id.toUpperCase().endsWith('USDT') && !id.toUpperCase().includes('_4H')) {
      id = id.toUpperCase() + 'USDT';
    } else {
      id = id.toUpperCase();
    }

    if (this.state.watchlist.includes(id)) {
      this.state.watchlist = this.state.watchlist.filter(x => x !== id);
      
      // If we are un-starring a grafted Moonshot, remove it completely from tracking
      const cfgIdx = CONFIG.assets.crypto.findIndex(a => a.id === id);
      if (cfgIdx !== -1 && CONFIG.assets.crypto[cfgIdx].grafted) {
        CONFIG.assets.crypto.splice(cfgIdx, 1); // Stop fetching it
        this.state.allAssets = this.state.allAssets.filter(a => a.asset.id !== id); // Remove from current UI state
      }
    } else {
      this.state.watchlist.push(id);
      
      // If we are starring a Moonshot coin that isn't tracked yet, graft it in!
      if (!CONFIG.assets.crypto.some(a => a.id === id)) {
        CONFIG.assets.crypto.push({
          id: id,
          symbol: id.replace('USDT_4H', '').replace('USDT', ''),
          name: id.replace('USDT_4H', '').replace('USDT', ''),
          currency: 'USD',
          icon: '🚀',
          grafted: true, // Flag it so we know it can be deleted later
          isMoonshot: true // Ensures it gets scored by the Breakout engine on the main dash
        });
        // Trigger a background load to instantly fetch its history for the main dash
        setTimeout(() => this.loadAll(true), 10);
      }
    }
    try {
      localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist));
      if (window.Auth) window.Auth.syncToCloud(this.state.invested, this.state.watchlist, this.state.holdingsMeta, { force: true });
    } catch(e) { console.warn('Failed to save watchlist', e); }
    
    // Instantly update the visual star state on any visible cards (especially Moonshots)
    const isNowStarred = this.state.watchlist.includes(id);
    this._showToast(
      isNowStarred ? `Watch: ${id.replace(/USDT_4H|USDT/g,'')} saved (idea only — not a buy)` : `Removed from Watch`,
      isNowStarred ? 'success' : 'info'
    );
    document.querySelectorAll(`.star-btn[data-star-id="${id}"]`).forEach(btn => {
      if (isNowStarred) {
        btn.classList.add('active');
        btn.style.opacity = '1';
        btn.innerHTML = '⭐';
      } else {
        btn.classList.remove('active');
        btn.style.opacity = '0.3';
        btn.innerHTML = '⭐';
      }
    });

    this._renderTopOpportunities();
    this._renderAssetGrid();
  },

  // ─── Card click → open detail modal ─────────────────────────────────────────
  _attachCardListeners(container) {
    container.querySelectorAll('.lock-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-lock-id') || btn.dataset.lockId;
        this._toggleInvested(id);
      });
    });
    container.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-star-id') || btn.dataset.starId;
        this._toggleWatchlist(id);
      });
    });
    container.querySelectorAll('.follow-suggestion-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const symbol = btn.getAttribute('data-symbol');
        const signal = btn.getAttribute('data-signal');
        const price = Number(btn.getAttribute('data-price'));
        this._markSuggestionFollowed(symbol, { signal, entryPrice: price, source: 'card' });
      });
    });
    container.querySelectorAll('.holdings-editor, .follow-suggestion-btn').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
    });
    container.querySelectorAll('.asset-card').forEach(card => {
      card.onclick     = (e) => {
        if (e.target.closest('.holdings-editor, .follow-suggestion-btn, .lock-btn, .star-btn')) return;
        this._openModal(card.dataset.assetId);
      };
      card.onkeydown   = e => { if (e.key === 'Enter' || e.key === ' ') this._openModal(card.dataset.assetId); };
    });
  },

  _bindHoldingsFollowedActions() {
    if (this._holdingsActionsBound) return;
    this._holdingsActionsBound = true;
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (!action) return;

      if (action === 'save-lot' || action === 'add-lot') {
        e.preventDefault();
        e.stopPropagation();
        const row = btn.closest('.holdings-lot-row');
        const holdId = btn.getAttribute('data-hold-id');
        const price = Number(row?.querySelector('.hold-lot-price')?.value);
        const lockedAt = row?.querySelector('.hold-lot-time')?.value;
        const qty = Number(row?.querySelector('.hold-lot-qty')?.value);
        this._addOrUpdateHoldingsLot(holdId, {
          lotId: action === 'save-lot' ? btn.getAttribute('data-lot-id') : null,
          entryPrice: price,
          lockedAt,
          qty,
        });
        return;
      }
      if (action === 'del-lot') {
        e.preventDefault();
        e.stopPropagation();
        this._removeHoldingsLot(btn.getAttribute('data-hold-id'), btn.getAttribute('data-lot-id'));
        return;
      }
      if (action === 'close-followed') {
        e.preventDefault();
        e.stopPropagation();
        const sym = btn.getAttribute('data-symbol');
        const price = this._resolveAssetPrice(`${sym}USDT`);
        this._closeFollowed(btn.getAttribute('data-fol-id'), price, 'MANUAL');
        return;
      }
      if (action === 'follow-suggestion') {
        // handled on cards too; allow history/panel buttons later
      }
    });
  },

  // ─── Detail modal ────────────────────────────────────────────────────────────
  _openModal(id) {
    const d = this.state.allAssets.find(a => a.asset.id === id) || (this.state.moonshots && this.state.moonshots.find(a => a.asset.id === id));
    if (!d) return;
    this.state.selectedAsset = d;

    const modal   = document.getElementById('assetModal');
    const content = document.getElementById('modalContent');
    if (!modal || !content) return;

    const { asset, price, change24h, signalResult, category, closes, timestamps } = d;
    const sig   = signalResult?.signal ?? 'NEUTRAL';
    const level = Signals.level(sig);
    const ind   = signalResult?.indicators ?? {};
    const rec   = signalResult?.recommendation ?? '';
    const arrays = signalResult?.arrays ?? {};
    const winnerTier = signalResult?.winnerTier ?? 'none';
    const tierBadge = this._winnerTierBadge(winnerTier);
    const ocoHTML = this._ocoHTML(d);

    const priceStr = price !== null ? (asset.currency === 'INR' ? '₹' : '$') + this._fmt(price, asset) : 'N/A';
    const chgStr   = change24h !== null ? (change24h >= 0 ? '+' : '') + change24h.toFixed(2) + '%' : '–';
    const modalScannerType = asset.isMoonshot ? 'moonshot' : asset.isScalp ? 'scalper' : '';
    const modalScannerChip = modalScannerType
      ? `<span class="scanner-chip ${modalScannerType}-chip">${modalScannerType === 'moonshot' ? 'MOON' : 'SCALP'}</span>`
      : '';
    const modalAssetMark = this._logoMarkHTML(asset.symbol || asset.id, { scannerType: modalScannerType, scannerChip: modalScannerChip, sizeClass: 'lg' });

    const tradeSymbol = String(asset.symbol || '').replace(/USDT$/i, '') || String(asset.id || '').replace(/USDT.*$/i, '');
    const binanceTradeUrl = `https://www.binance.com/en/trade/${tradeSymbol}_USDT?type=spot&ref=TRENDRUNNER`;

    content.innerHTML = `
      <div class="modal-header">
        <div class="modal-title-row">
          ${modalAssetMark}
          <div>
            <h2>${asset.name} <span class="modal-symbol">${asset.symbol}</span></h2>
            <div class="modal-meta">${{ crypto: '₿ Crypto', stocks: '🇮🇳 NSE Stock', commodities: '🪙 Commodity', forex: '💱 Forex' }[category] ?? category} ${tierBadge}</div>
          </div>
          <div class="signal-badge signal-${level.cls} lg ${['STRONG_BUY','STRONG_SELL'].includes(sig) ? 'pulse' : ''}">
            ${level.icon} ${level.label}
          </div>
        </div>
        <div class="modal-prices">
          <div class="modal-price">${priceStr}</div>
          <div class="price-change ${change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg'} lg">${chgStr} (24h)</div>
          <a href="${binanceTradeUrl}" target="_blank" rel="noopener noreferrer" class="modal-trade-btn" title="Open this pair on Binance">Trade ${tradeSymbol}USDT on Binance ↗</a>
        </div>
        ${ocoHTML}
      </div>

      <div class="modal-recommendation">
        <p>${rec}</p>
      </div>

      <div class="modal-indicator-grid">
        ${this._indicatorCards(ind)}
      </div>

      <div class="modal-charts">
        <h3>📊 Price Chart (90 days)</h3>
        <div class="chart-wrap" style="height:220px">
          <canvas id="modalPriceChart"></canvas>
        </div>
        <div class="chart-row">
          <div>
            <h3>📉 RSI (14)</h3>
            <div class="chart-wrap" style="height:120px">
              <canvas id="modalRsiChart"></canvas>
            </div>
          </div>
          <div>
            <h3>〽️ MACD</h3>
            <div class="chart-wrap" style="height:120px">
              <canvas id="modalMacdChart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-education">
        <h3>📚 How to read this</h3>
        ${this._educationHTML(ind)}
      </div>
    `;

    modal.classList.add('open');
    document.body.classList.add('modal-open');

    // Render charts after DOM update
    requestAnimationFrame(() => {
      if (closes?.length && timestamps?.length) {
        Charts.renderPrice('modalPriceChart', closes, timestamps, arrays);
        Charts.renderRSI('modalRsiChart', arrays.rsi ?? [], timestamps);
        Charts.renderMACD('modalMacdChart', arrays.macd ?? {}, timestamps);
      }
    });
  },

  _indicatorCards(ind) {
    const cards = [
      { key: 'rsi', title: 'RSI (14)', icon: '📊', extra: val => `<div class="rsi-gauge" style="--rsi:${Math.min(100, val.value)}%"><div class="rsi-thumb"></div></div>` },
      { key: 'macd', title: 'MACD', icon: '〽️', extra: () => '' },
      { key: 'movingAvg', title: 'Moving Averages', icon: '📈', extra: () => '' },
      { key: 'bollinger', title: 'Bollinger Bands', icon: '🎯', extra: () => '' },
      { key: 'volume', title: 'Volume', icon: '📶', extra: () => '' },
    ];

    return cards.filter(c => ind[c.key]).map(c => {
      const val = ind[c.key];
      const level = Signals.level(val.signal);
      let detailHTML = '';
      if (c.key === 'rsi') detailHTML = `<div class="ind-detail-value">RSI = <strong>${val.value}</strong></div>`;
      if (c.key === 'macd') detailHTML = `<div class="ind-detail-value">MACD: <strong>${val.value}</strong> | Signal: <strong>${val.signalValue}</strong></div>`;
      if (c.key === 'movingAvg') {
        const smaShortLabel = val.sma50Period && val.sma50Period !== 50 ? `${val.sma50Period} SMA*` : '50 SMA';
        detailHTML = `
          <div class="ind-detail-value" style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
            <div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:6px; border-left: 3px solid var(--accent);">
              <div style="font-size:11px; color:var(--accent); text-transform:uppercase; margin-bottom:4px; font-weight:600;">⚡ Day Trend (EMA)</div>
              9 EMA: <strong>${val.ema9}</strong> | 21 EMA: <strong>${val.ema21}</strong>
            </div>
            <div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:6px; border-left: 3px solid var(--text-muted);">
              <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px; font-weight:600;">📊 Macro Trend (SMA)</div>
              ${smaShortLabel}: <strong>${val.sma50 ?? '—'}</strong> | 200 SMA: <strong>${val.sma200 ?? '—'}</strong>
            </div>
            ${val.sma50Period && val.sma50Period !== 50 ? '<div style="font-size:11px; color:var(--text-muted)">* Not enough history for full 50-day SMA.</div>' : ''}
          </div>
        `;
      }
      if (c.key === 'bollinger') detailHTML = `<div class="ind-detail-value">%B: <strong>${val.percentB}%</strong> | Upper: ${val.upper} | Lower: ${val.lower}</div>`;
      if (c.key === 'volume') detailHTML = `<div class="ind-detail-value">Latest: <strong>${val.last.toLocaleString()}</strong> | 20-day avg: <strong>${val.avg20.toLocaleString()}</strong> | Ratio: <strong>${val.ratio}×</strong></div>`;

      return `
        <div class="ind-card">
          <div class="ind-card-header">
            <span>${c.icon} ${c.title}</span>
            <span class="signal-badge signal-${level.cls} sm">${level.icon} ${level.short}</span>
          </div>
          ${detailHTML}
          ${c.extra(val)}
          <p class="ind-desc">${val.description}</p>
        </div>
      `;
    }).join('');
  },

  _educationHTML(ind) {
    const tips = [
      { title: 'RSI (Relative Strength Index)', icon: '📊', text: 'Measures momentum on a 0–100 scale. Below 30 = oversold (potential buy). Above 70 = overbought (potential sell). Most effective in ranging markets.' },
      { title: 'MACD', icon: '〽️', text: 'Shows trend direction & momentum. When the MACD line crosses ABOVE the signal line → bullish. Crosses BELOW → bearish. Crossovers are the key signal.' },
      { title: 'Dual Moving Averages (EMA & SMA)', icon: '📈', text: 'Macro Trend (50 & 200 SMA): Price above 50 SMA = healthy market to buy. Day Trend (9 & 21 EMA): Fast moving, when 9 EMA crosses ABOVE 21 EMA = exact time to buy.' },
      { title: 'Bollinger Bands', icon: '🎯', text: 'Price near the lower band often bounces up (buy). Price near the upper band often falls (sell). A squeeze (bands narrowing) forecasts a big move coming.' },
      { title: 'Confidence Score', icon: '🎯', text: 'Percentage of indicators that agree with the final signal direction. Higher confidence = stronger setup. Low confidence = conflicting signals — be cautious.' },
      { title: 'Risk Management', icon: '🛡️', text: 'NEVER risk more than 1–2% of your total capital on a single trade. Always set a stop-loss before entering. Even the best signals fail sometimes.' },
    ];
    return `<div class="edu-grid">${tips.map(t => `<div class="edu-card"><div class="edu-icon">${t.icon}</div><h4>${t.title}</h4><p>${t.text}</p></div>`).join('')}</div>`;
  },

  // ─── Close modal ─────────────────────────────────────────────────────────────
  _closeModal() {
    const modal = document.getElementById('assetModal');
    if (modal) modal.classList.remove('open');
    document.body.classList.remove('modal-open');
    this.state.selectedAsset = null;
    Charts._destroy('modalPriceChart');
    Charts._destroy('modalRsiChart');
    Charts._destroy('modalMacdChart');
  },

  // Lightweight update of price/change/recommendation while the modal is open.
  // Avoids re-rendering charts so the user's scroll position isn't jumped.
  _refreshOpenModal() {
    const sel = this.state.selectedAsset;
    const modal = document.getElementById('assetModal');
    if (!sel || !modal || !modal.classList.contains('open')) return;
    const fresh = this.state.allAssets.find(a => a.asset.id === sel.asset.id);
    if (!fresh) return;
    this.state.selectedAsset = fresh;

    const priceEl = modal.querySelector('.modal-price');
    if (priceEl) {
      priceEl.textContent = fresh.price != null
        ? (fresh.asset.currency === 'INR' ? '₹' : '$') + this._fmt(fresh.price, fresh.asset)
        : 'N/A';
    }
    const chgEl = modal.querySelector('.modal-prices .price-change');
    if (chgEl) {
      const c = fresh.change24h;
      chgEl.className = 'price-change ' + (c == null ? 'flat' : c >= 0 ? 'pos' : 'neg') + ' lg';
      chgEl.textContent = (c != null ? (c >= 0 ? '+' : '') + c.toFixed(2) + '%' : '–') + ' (24h)';
    }
    const recEl = modal.querySelector('.modal-recommendation p');
    if (recEl) recEl.textContent = fresh.signalResult?.recommendation ?? '';
  },

  // ─── Category filter tabs ────────────────────────────────────────────────────
  _setCategory(cat) {
    this.state.activeCategory = cat;
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.cat === cat);
    });
    this._renderAssetGrid();
  },

  // ─── Loading state ────────────────────────────────────────────────────────────
  _setLoading(on) {
    this.state.loading = on;
    const el = document.getElementById('loadingOverlay');
    if (el) el.classList.toggle('hidden', !on);
  },

  _updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (el && this.state.lastUpdate) {
      el.textContent = 'Updated ' + this.state.lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  },


  // ─── Browser notifications ───────────────────────────────────────────────────
  // Chrome blocks Notification.requestPermission() outside a user gesture, so
  // we only prompt once the user interacts (refresh, nav, filter, etc.).
  _requestNotifPermission() {
    if (!('Notification' in window)) return;
    this.state.notifGranted = Notification.permission === 'granted';
    if (Notification.permission !== 'default') return;
    Notification.requestPermission().then(p => {
      this.state.notifGranted = p === 'granted';
    });
  },

  _maybeNotify(d) {
    if (!this.state.notifGranted) return;
    const sig = d.signalResult?.signal;
    const winnerTier = d.signalResult?.winnerTier ?? 'none';
    if ((sig === 'BUY' || sig === 'STRONG_BUY') && winnerTier !== 'core') return;
    if (sig !== 'STRONG_BUY' && sig !== 'STRONG_SELL' && sig !== 'BUY') return;
    const key = `notif_${d.asset.id}_${d.signalResult?.signal}`;
    const NOTIF_TTL_MS = 3600000; // 1h
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const sentAt = parseInt(raw, 10);
        if (!isNaN(sentAt) && Date.now() - sentAt < NOTIF_TTL_MS) return;
      }
    } catch (e) { /* ignore */ }
    const level = Signals.level(d.signalResult.signal);
    new Notification(`${level.icon} ${d.asset.name}: ${level.label}`, {
      body: d.signalResult.recommendation.slice(0, 100) + '…',
      silent: true
    });
    try { localStorage.setItem(key, Date.now().toString()); } catch (e) { /* ignore */ }
  },

  // ─── Toast notifications ─────────────────────────────────────────────────────
  _showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  },

  // ─── Bind all static UI events ───────────────────────────────────────────────
  _bindUI() {
    // Ask for notification permission once, on the first real user gesture.
    const askOnce = () => {
      this._requestNotifPermission();
      document.removeEventListener('click', askOnce, true);
      document.removeEventListener('keydown', askOnce, true);
    };
    document.addEventListener('click', askOnce, true);
    document.addEventListener('keydown', askOnce, true);

    // Category filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.onclick = () => this._setCategory(tab.dataset.cat);
    });

    // Summary Signal Filtering
    document.getElementById('summaryBar')?.addEventListener('click', e => {
        const item = e.target.closest('.filterable');
        if (!item) return;
        const sig = item.dataset.signal;

        if (sig === 'ALL' || this.state.activeSignalFilter === sig) {
          this.state.activeSignalFilter = null;
          // Stay on current tab when clearing
        } else {
          this.state.activeSignalFilter = sig;

          // Always jump to All so S.BUY/BUY counts that include 5m scalps are visible
          // (All normally hides scalps; with a signal filter they are included.)
          const jumpCats = new Set(['history', 'holdings', 'watchlist', 'oversold', 'highconf', 'trending', 'scalper']);
          if (jumpCats.has(this.state.activeCategory) || this.state.activeCategory !== 'all') {
            this.state.activeCategory = 'all';
            document.querySelectorAll('.filter-tab').forEach(tab => {
              tab.classList.toggle('active', tab.dataset.cat === 'all');
            });
          }

          const scalpN = this.state.allAssets.filter(a =>
            (a.category === 'scalper' || a.asset?.isScalp || String(a.asset?.id || '').includes('_5M'))
            && a.signalResult?.signal === sig
          ).length;
          const totalN = this.state.allAssets.filter(a => a.signalResult?.signal === sig).length;
          if (scalpN > 0) {
            this._showToast(
              totalN === scalpN
                ? `${scalpN}× ${sig.replace('_', ' ')} are 5m scalps — showing them below (SCALP chip)`
                : `Filter: ${sig.replace('_', ' ')} (includes ${scalpN}× 5m scalp)`,
              'info'
            );
          }

          document.getElementById('assetGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        this._renderSummaryBar();
        this._renderAssetGrid();
      });

    // Asset Search
    document.getElementById('assetSearchInput')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      this.state.searchQuery = q;
      
      const isSearching = !!q;
      
      // Hide other sections for a clean search experience
      const summaryBar = document.getElementById('summaryBar');
      const liveTape = document.querySelector('.live-tape');
      const topOppBlock = document.getElementById('topOpportunities')?.closest('.section-block');
      
      if (summaryBar) summaryBar.style.display = isSearching ? 'none' : 'flex';
      if (liveTape) liveTape.style.display = isSearching ? 'none' : 'flex';
      if (topOppBlock) topOppBlock.style.display = isSearching ? 'none' : 'block';

      if (isSearching && this.state.activeCategory !== 'all') {
        this._setCategory('all');
      } else {
        this._renderAssetGrid();
      }
    });

    // Modal close
    document.getElementById('modalClose')?.addEventListener('click', () => this._closeModal());
    document.getElementById('assetModal')?.addEventListener('click', e => {
      if (e.target.id === 'assetModal') this._closeModal();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this._closeModal(); });

    // Manual refresh only (pull-to-refresh removed — too easy to trigger and burns Binance weight)
    document.getElementById('refreshBtn')?.addEventListener('click', () => this._forceRefresh());

    // Sidebar nav
    document.querySelectorAll('.nav-link').forEach(link => {
      link.onclick = e => {
        e.preventDefault();
        const section = link.dataset.section;
        document.querySelectorAll('.main-section').forEach(s => s.classList.toggle('active', s.id === section));
        document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l === link));
      };
    });

    document.getElementById('refreshListingsBtn')?.addEventListener('click', () => this.refreshListings());

    // Moonshots
    document.getElementById('scanMoonshotsBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('scanMoonshotsBtn');
      const progress = document.getElementById('scanProgress');
      const grid = document.getElementById('moonshotGrid');
      
      btn.disabled = true;
      grid.innerHTML = '';
      
      try {
        const setups = await Scanner.scanMarket(msg => {
          progress.textContent = msg;
        });
        
        progress.textContent = `Found ${setups.length} experimental setups. Paper-test before trading.`;
        
        if (setups.length === 0) {
          grid.innerHTML = '<p class="no-data">No explosive setups found right now. Try again later.</p>';
        } else {
          this.state.moonshots = setups;
          this._sortAssets(setups);
          // If we have a massive amount of volatile setups, pack them tightly
          
          
          grid.innerHTML = setups.map(s => this._assetCardHTML(s, false, true)).join('');
          this._attachCardListeners(grid);
          this._initSparklines(setups, true);
        }
      } catch (err) {
        progress.textContent = `Scan failed: ${err.message || err}`;
        console.error(err);
      } finally {
        btn.disabled = false;
      }
    });

  },

  _ocoHTML(d) {
    const s = d.signalResult?.stopSuggest;
    if (!s || !['BUY', 'STRONG_BUY'].includes(d.signalResult?.signal)) {
      return '<div class="oco-panel oco-muted">No exit plan: wait for a Buy / Strong Buy with a valid stop and bank target.</div>';
    }
    const policy = this._exitPolicy();
    const price = d.price;
    const valid = price > s.stopPrice && s.stopPrice > 0 && s.takeProfitPrice > price;
    const staleMinutes = d.fetchedAt ? (Date.now() - new Date(d.fetchedAt).getTime()) / 60000 : Infinity;
    const stale = !Number.isFinite(staleMinutes) || staleMinutes > 15;
    const statusClass = !valid || stale ? 'oco-warning' : 'oco-ready';
    const status = !valid ? 'Invalid price relationship' : stale ? 'Refresh before placing: levels are stale' : 'Exit plan ready';
    const symbol = d.asset.symbol;
    const rules = d.rules || {};
    const ruleText = rules.minNotional ? `Binance min: $${rules.minNotional}. Qty step: ${rules.stepSize}.` : 'Binance will enforce pair minimums.';

    // Specialized Scalper Plan (100% All-in, All-out)
    if (d.category === 'scalper' || d.asset?.isScalp || String(d.asset?.id||'').includes('_5M')) {
      const tpPct = Number(s.takeProfitPct).toFixed(2);
      const riskPct = Number(s.distancePct).toFixed(2);
      const rr = s.riskMultiple ? Number(s.riskMultiple).toFixed(1) : (tpPct / riskPct).toFixed(1);
      return `
        <div class="oco-panel">
          <div class="oco-title">Scalp Exit Plan — ${symbol}</div>
          <div class="oco-status oco-ready" style="background:rgba(14, 165, 233, 0.15);color:#38bdf8;border:1px solid #0ea5e9;margin-top:10px;">⚡ High Velocity: 100% TP at ${rr}R</div>
          <div class="oco-status ${statusClass}">${status}</div>
          <div class="oco-grid">
            <span>Take Profit <strong>${this._fmt(s.takeProfitPrice, d.asset)}</strong> (+${tpPct}%)</span>
            <span>Stop Loss <strong>${this._fmt(s.stopPrice, d.asset)}</strong> (-${riskPct}%)</span>
            <span>R:R Ratio <strong>${rr}:1</strong></span>
            <span>Time Stop <strong>${s.holdBarsHint ? `~${Math.round(s.holdBarsHint * 5)} mins` : '1 Hour'}</strong></span>
          </div>
          <ol class="oco-steps" style="margin:12px 0 8px;padding-left:18px;color:var(--text-muted);font-size:13px;line-height:1.45">
            <li><strong>Buy</strong> position size.</li>
            <li><strong>Place OCO:</strong> set limit sell at Take Profit and stop-limit at Stop Loss.</li>
            <li>No trailing. If trade stalls and takes too long to move, exit at market price.</li>
          </ol>
          <small>${ruleText}</small>
        </div>
      `;
    }

    // Specialized Breakout/Moonshot Plan
    if (d.asset?.isMoonshot || String(d.asset?.id||'').includes('_4H')) {
      const tpPct = Number(s.takeProfitPct).toFixed(2);
      const riskPct = Number(s.distancePct).toFixed(2);
      const rr = s.riskMultiple ? Number(s.riskMultiple).toFixed(1) : (tpPct / riskPct).toFixed(1);
      return `
        <div class="oco-panel">
          <div class="oco-title">Breakout Exit Plan — ${symbol}</div>
          <div class="oco-status oco-ready" style="background:rgba(14, 165, 233, 0.15);color:#38bdf8;border:1px solid #0ea5e9;margin-top:10px;">🚀 Asymmetric Breakout: Fixed TP</div>
          <div class="oco-status ${statusClass}">${status}</div>
          <div class="oco-grid">
            <span>Take Profit <strong>${this._fmt(s.takeProfitPrice, d.asset)}</strong> (+${tpPct}%)</span>
            <span>Stop Loss <strong>${this._fmt(s.stopPrice, d.asset)}</strong> (-${riskPct}%)</span>
            <span>R:R Ratio <strong>${rr}:1</strong></span>
            <span>Hold Limit <strong>~3 Days</strong></span>
          </div>
          <ol class="oco-steps" style="margin:12px 0 8px;padding-left:18px;color:var(--text-muted);font-size:13px;line-height:1.45">
            <li><strong>Buy</strong> breakout position.</li>
            <li><strong>Place full OCO</strong> (Limit = TP, Stop = Stop Loss).</li>
            <li>Alternatively, manually trail stop <em>only after</em> it pushes deep into profit.</li>
          </ol>
          <small>Moonshots are highly volatile. Respect the hard stop loss. ${ruleText}</small>
        </div>
      `;
    }

    // Default 1D Swing Plan (50/50 OCO with trailing runner)
    const partial = s.partialPct ?? policy.partialPct ?? 50;
    const runnerPct = 100 - partial;
    const bankPct = s.bankTakeProfitPct ?? s.takeProfitPct ?? policy.takeProfitPct;
    const trailPct = s.runnerTrailPct != null ? Number(s.runnerTrailPct).toFixed(2) : '—';
    const riskPct = Number(s.distancePct) || 0;
    const rewardPct = Number(bankPct) || 0;
    const rewardRisk = riskPct > 0 && rewardPct > 0 ? (rewardPct / riskPct).toFixed(1) : '—';
    const beNote = (s.moveStopToBreakevenAfterPartial ?? policy.moveStopToBreakevenAfterPartial)
      ? 'After the bank leg fills, move the runner stop to breakeven (entry).'
      : 'Keep the runner protective stop active.';

    return `
      <div class="oco-panel">
        <div class="oco-title">Swing Exit Plan — ${symbol}</div>
        <div class="oco-status oco-ready" style="background:rgba(14, 165, 233, 0.15);color:#38bdf8;border:1px solid #0ea5e9;margin-top:10px;">⚖️ Sell ${partial}% at Target • Trail remaining ${runnerPct}%</div>
        <div class="oco-status ${statusClass}">${status}</div>
        <div class="oco-grid">
          <span>Binance "Price" (Target) <strong>${this._fmt(s.takeProfitPrice, d.asset)}</strong> (+${bankPct}%)</span>
          <span>Binance "Stop" <strong>${this._fmt(s.stopPrice, d.asset)}</strong> (-${s.distancePct}%)</span>
          <span>Binance "Limit" <strong>${this._fmt(s.stopPrice * 0.998, d.asset)}</strong></span>
          <span>Trailing Stop Delta <strong>~${trailPct}%</strong></span>
        </div>
        <ol class="oco-steps" style="margin:12px 0 8px;padding-left:18px;color:var(--text-muted);font-size:13px;line-height:1.45">
          <li><strong>Buy</strong> your position on Binance spot.</li>
          <li><strong>Sell 1st Half:</strong> Use Binance <strong>OCO</strong>. Enter the exact Price, Stop, and Limit from above. Set amount to ${partial}%.</li>
          <li><strong>Sell 2nd Half:</strong> Use Binance <strong>Trailing Stop</strong>. Activation Price = blank. Trailing Delta = ${trailPct}%.</li>
          <li><strong>Time Limit:</strong> If nothing hits in <strong>${policy.holdLimitDays} days</strong>, sell everything at market price.</li>
        </ol>
        <small>${ruleText}</small>
      </div>
    `;
  },

  _forceRefresh() {
    if (this.state.loading) {
      console.warn('Dashboard is already loading, ignoring refresh click.');
      return;
    }
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('trading_cache_')) localStorage.removeItem(key);
    });
    return this.loadAll(false);
  },

};

// ── Boot on DOM ready ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Dashboard.init();

  // Browser SPA Anti-Scroll Bug Fix:
  // Prevent Chrome from aggressively scrolling the overflow:hidden body or main-content
  // when navigating back to the tab with a focused element off-screen.
  window.addEventListener('scroll', () => {
    if (window.scrollY > 0 || window.scrollX > 0) window.scrollTo(0, 0);
  }, { passive: true });
  
  // Wake-up from tab suspension (Mobile/Android fix)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // If the loading lock has been stuck for more than 30 seconds due to a suspended network fetch, break it.
      const now = Date.now();
      if (Dashboard.state.loading && Dashboard.state.refreshDueAt && now > Dashboard.state.refreshDueAt + 30000) {
        console.warn('Dashboard was stuck in loading state from a suspended tab. Forcing lock release.');
        Dashboard.state.loading = false;
        Dashboard._setLoading(false);
      }
      // If the data is stale, trigger a background refresh immediately upon waking up
      if (!Dashboard.state.loading && now > Dashboard.state.refreshDueAt) {
        Dashboard.loadAll(true);
      }
    }
  });

  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.addEventListener('scroll', function() {
      if (this.scrollTop > 0) this.scrollTop = 0;
      if (this.scrollLeft > 0) this.scrollLeft = 0;
    }, { passive: true });
  }
});
