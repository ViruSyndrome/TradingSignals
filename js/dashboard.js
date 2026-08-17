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
    watchlist:     JSON.parse(localStorage.getItem('trading_watchlist') || '[]'),
    fearGreed:     null,
    marketRegime: 'unknown',
  },

  // ─── Signal History ─────────────────────────────────────────────────────────
  SIGNAL_HISTORY_KEY: 'signal_history_v1',
  _previousSignals: new Map(),
  
  _trackSignalChanges() {
    const history = this._getSignalHistory();
    const now = new Date().toISOString();
    
    for (const asset of this.state.allAssets) {
      const id = asset.asset?.id;
      const newSignal = asset.signalResult?.signal ?? 'NEUTRAL';
      const newScore = asset.signalResult?.score ?? 0;
      const oldSignal = this._previousSignals.get(id);
      
      if (oldSignal && oldSignal !== newSignal) {
        history.unshift({
          time: now,
          id: id,
          name: asset.asset?.name || id,
          symbol: asset.asset?.symbol || id,
          icon: asset.asset?.icon || '',
          from: oldSignal,
          to: newSignal,
          score: newScore,
          price: asset.price,
        });
      }
      this._previousSignals.set(id, newSignal);
    }
    
    // Keep last 100 entries
    const trimmed = history.slice(0, 100);
    try {
      localStorage.setItem(this.SIGNAL_HISTORY_KEY, JSON.stringify(trimmed));
    } catch(e) { /* quota */ }
  },
  
  _getSignalHistory() {
    try {
      const raw = localStorage.getItem(this.SIGNAL_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  },

  // ─── Boot ────────────────────────────────────────────────────────────────────
  async init() {
    if (window.Portfolio) Portfolio.init();
    
    // Clean, upgrade, and deduplicate the user's saved watchlist
    let cleanWatchlist = this.state.watchlist.map(id => {
      let normId = id.toUpperCase();
      if (!normId.endsWith('USDT') && !normId.includes('_4H')) normId += 'USDT';
      // If it's not a core coin and doesn't have _4H yet, upgrade it to the new _4H system
      if (!normId.includes('_4H') && !CONFIG.assets.crypto.some(a => a.id === normId && !a.grafted)) {
        normId += '_4H';
      }
      return normId;
    });
    this.state.watchlist = [...new Set(cleanWatchlist)]; // Remove duplicates

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
    
    // Mobile hamburger menu
    const hamburger = document.getElementById('hamburgerBtn');
    const sidebar = document.querySelector('.sidebar');
    if (hamburger && sidebar) {
      // Create overlay element
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
      
      hamburger.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
      });
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
      });
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

    this._startClock();
    this._updateMarketStatus();
    // Paint instantly from last-known snapshot while the live fetch runs.
    if (this._restoreSnapshot()) this._render();
    await this._fetchFearGreed();  // sentiment feeds the signal engine — fetch first
    await this.loadAll(true);
    this._scheduleRefresh();

    // Auto-scan moonshots in the background every 5 minutes (300,000 ms)
    this.state.moonshotTimer = setInterval(() => this._autoScanMoonshots(), 5 * 60 * 1000);
    // Kick off an initial background scan 5 seconds after the app loads
    setTimeout(() => this._autoScanMoonshots(), 5000);
  },

  // Hide filter tabs for asset categories that are empty in CONFIG.
  _hideEmptyCategoryTabs() {
    const map = {
      crypto:      CONFIG.assets.crypto,
    };
    document.querySelectorAll('.filter-tab').forEach(tab => {
      const cat = tab.dataset.cat;
      if (cat && cat !== 'all' && cat !== 'watchlist' && cat !== 'oversold' && cat !== 'highconf' && cat !== 'trending' && (!map[cat] || map[cat].length === 0)) {
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

      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });

    document.addEventListener('mouseout', (e) => {
      if (activeEl && (!e.relatedTarget || !activeEl.contains(e.relatedTarget))) {
        tooltip.classList.remove('visible');
        activeEl = null;
      }
    });
    
    // Re-bind dynamically created elements by listening on body (which we do)
  },

  // ─── Load all asset data ─────────────────────────────────────────────────────
  async loadAll(silent = false) {
    this.state.loading = true;
    this._updateLiveStatus();
    if (!silent) this._setLoading(true);
    try {
      const crypto = await API.getAllCrypto();

      const all = [
        ...(crypto || []).map(d => ({ ...d, category: 'crypto' })),
      ];

      // Signals now receive OHLCV + sentiment + symbol + marketRegime
      const fg = this._fgValue();
      
      let marketRegime = 'flat';
      const btc = all.find(a => (a.asset?.symbol === 'BTCUSDT' || a.asset?.id === 'BTCUSDT') && a.closes?.length >= 50);
      if (btc) {
        const sma50Arr = Indicators.sma(btc.closes, 50);
        const btcSma50 = Indicators.last(sma50Arr);
        const btcPrice = btc.closes[btc.closes.length - 1];
        if (btcSma50) marketRegime = btcPrice > btcSma50 ? 'bull' : 'bear';
      }
      this.state.marketRegime = marketRegime;

      const previousPrices = new Map(this.state.allAssets.map(a => [a.asset?.id, a.price]));
      this.state.allAssets = all.map(d => {
        let signalResult = null;
        if (d.closes?.length > 0) {
          const opts = { highs: d.highs, lows: d.lows, closes4H: d.closes4H, volumes: d.volumes, fearGreed: fg, symbol: d.asset?.symbol || d.asset?.id, marketRegime, marketCap: d.marketCap, tvl: d.tvl };
          signalResult = d.asset?.isMoonshot ? Signals.generateBreakout(d.closes, opts) : Signals.generate(d.closes, opts);
        }
        return { ...d, signalResult };
      });

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
      this._persistSnapshot();
      this._render();
      this._autoResolvePaperPositions();
      this._updateMoonshotJournal();
      this._refreshOpenModal();
      if (!silent) this._showToast(anyOk ? 'Data refreshed ✓' : 'Fetch failed — showing last known data', anyOk ? 'success' : 'warning');
    } catch (err) {
      console.error('[Dashboard] loadAll error:', err);
      this.state.dataStale = true;
      this.state.loading = false;
      this.state.refreshDueAt = Date.now() + CONFIG.refresh.intervalMs;
      if (!silent) this._setLoading(false);
      if (!silent) this._showToast('Some data failed to load — check internet connection', 'warning');
    }
  },

  // ─── Snapshot persistence (instant paint on next load) ───────────────────────
  SNAPSHOT_KEY: 'trading_snapshot_v1',
  _persistSnapshot() {
    try {
      // Strip heavy indicator arrays before saving to keep localStorage small.
      const slim = this.state.allAssets.map(a => ({
        asset: a.asset, category: a.category,
        price: a.price, change24h: a.change24h, change4h: a.change4h, closes: a.closes,
        closes1D: a.closes1D, closes4H: a.closes4H,
        highs: a.highs, lows: a.lows, volumes: a.volumes, timestamps: a.timestamps,
        fetchedAt: a.fetchedAt, error: a.error,
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
      const fg = this._fgValue();
      const btc = assets.find(a => (a.asset?.symbol === 'BTCUSDT' || a.asset?.id === 'BTCUSDT') && a.closes?.length >= 50);
      if (btc) {
        const btcSma50 = Indicators.last(Indicators.sma(btc.closes, 50));
        const btcPrice = btc.closes[btc.closes.length - 1];
        this.state.marketRegime = btcSma50 ? (btcPrice > btcSma50 ? 'bull' : 'bear') : 'flat';
      }
      this.state.allAssets = assets.map(d => {
        let signalResult = null;
        if (d.closes?.length > 0) {
          const opts = { highs: d.highs, lows: d.lows, closes4H: d.closes4H, volumes: d.volumes, fearGreed: fg, symbol: d.asset?.symbol || d.asset?.id, marketRegime: this.state.marketRegime, marketCap: d.marketCap, tvl: d.tvl };
          signalResult = d.asset?.isMoonshot ? Signals.generateBreakout(d.closes, opts) : Signals.generate(d.closes, opts);
        }
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
        console.log('[Moonshots] Background scan complete: 0 setups found.');
        if (statusEl) statusEl.innerHTML = `🚀 Last scan: ${timeStr} (0 found)`;
        return;
      }
      
      let newlyAdded = false;
      setups.forEach(s => {
        const id = s.asset.id;
        if (!this.state.watchlist.includes(id)) {
          this.state.watchlist.push(id);
          newlyAdded = true;
          
          // Inject into CONFIG immediately so the next loadAll() picks it up
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
          }
        }
      });
      
      if (newlyAdded) {
        this._saveWatchlist();
        this.loadAll(); // Re-render the dashboard to show the new coins
        console.log(`[Moonshots] Background scan found ${setups.length} setups and added new ones to the dashboard!`);
        if (statusEl) statusEl.innerHTML = `🚀 Last scan: ${timeStr} (<b style="color:var(--pos)">+${setups.length} found!</b>)`;
      } else {
        console.log('[Moonshots] Background scan complete: No new setups (already tracking existing ones).');
        if (statusEl) statusEl.innerHTML = `🚀 Last scan: ${timeStr} (${setups.length} found, already tracking)`;
      }
    } catch (err) {
      console.error('[Moonshots] Auto-scan failed:', err);
      if (statusEl) statusEl.innerHTML = `🚀 Auto-Scan Failed`;
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

  // ─── Main render ─────────────────────────────────────────────────────────────
  _render() {
    this._renderSummaryBar();
    this._renderTopOpportunities();
    this._renderAssetGrid();
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
      if (seenSymbols.has(a.asset.symbol)) return false;
      seenSymbols.add(a.asset.symbol);
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
    this.state.allAssets.forEach(a => {
      const s = a.signalResult?.signal;
      if (s && counts[s] !== undefined) counts[s]++;
    });

    const total = this.state.allAssets.length;
    const bullPct = total > 0 ? Math.round(((counts.STRONG_BUY + counts.BUY) / total) * 100) : 0;
    const sentiment = bullPct >= 60 ? '🟢 Bullish' : bullPct <= 40 ? '🔴 Bearish' : '🟡 Mixed';

    const isActive = (sig) => this.state.activeSignalFilter === sig ? 'active' : '';

    const staleBanner = this.state.dataStale
      ? `<div class="summary-item stale-banner" title="The last live fetch failed. Numbers below are from your last successful load.">
           <span class="summary-value" style="color:#f5a623">⚠️ Stale</span>
           <span class="summary-label">Data may be outdated</span>
         </div>`
      : '';

    el.innerHTML = `
      ${staleBanner}
      <div class="summary-item" title="Overall market direction based on how many assets are bullish vs bearish. Green = most assets trending up, Red = most trending down.">
        <span class="summary-value">${sentiment}</span>
        <span class="summary-label">Market Sentiment</span>
      </div>
      <div class="summary-item filterable ${isActive('STRONG_BUY')}" data-signal="STRONG_BUY" title="High-conviction bullish setups where trend and momentum align. This is intentionally rare. Click to filter.">
        <span class="summary-count strong-buy">${counts.STRONG_BUY}</span>
        <span class="summary-label">Strong Buy</span>
      </div>
      <div class="summary-item filterable ${isActive('BUY')}" data-signal="BUY" title="Bullish setups. In live usage, core winners are prioritized over probation and non-winner assets. Click to filter.">
        <span class="summary-count buy">${counts.BUY}</span>
        <span class="summary-label">Buy</span>
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
      <div class="summary-item regime-item" title="BTC market regime controls how aggressively altcoin Buy signals are trusted.">
        <span class="summary-value">${this.state.marketRegime === 'bull' ? '🟢 Bull' : this.state.marketRegime === 'bear' ? '🔴 Bear' : '🟡 Flat'}</span>
        <span class="summary-label">BTC Regime · Altcoins ${this.state.marketRegime === 'bear' ? 'Restricted' : 'Open'}</span>
      </div>
      <div class="summary-item freshness-item" title="Age of the latest successful market-data refresh.">
        <span class="summary-value">${this._freshnessText()}</span>
        <span class="summary-label">Signal Freshness</span>
      </div>
    `;
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
      const res = await fetch('https://api.alternative.me/fng/?limit=1');
      const json = await res.json();
      if (json.data && json.data[0]) {
        this.state.fearGreed = json.data[0];
        this._renderSummaryBar();
      }
    } catch (e) {
      console.warn('Fear & Greed fetch failed:', e.message);
    }
  },

  // ─── Top 4 opportunities ────────────────────────────────────────────────────
  _renderTopOpportunities() {
    const el = document.getElementById('topOpportunities');
    if (!el) return;

    // Rank by Absolute Math Score and Confidence, but ONLY show actual BUY signals
    const valid = [...this.state.allAssets].filter(a => {
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

    const cat = this.state.activeCategory;
    let assets = this.state.allAssets;

    if (cat === 'watchlist') {
      assets = assets.filter(a => this.state.watchlist.includes(a.asset.id));
    } else if (cat === 'oversold') {
      // Just check for deeply oversold RSI (<= 35). 
      // We removed the 'macroBullish' requirement because an asset dropping hard enough to hit 30 RSI will almost always break its 50 SMA.
      assets = assets.filter(a => {
        const rsi = a.signalResult?.indicators?.rsi?.value;
        return rsi && rsi <= 35;
      }).sort((a, b) => a.signalResult.indicators.rsi.value - b.signalResult.indicators.rsi.value);
    } else if (cat === 'highconf') {
      const gate = CONFIG.refresh?.strongConfidenceGate || 75;
      assets = assets.filter(a => {
        const conf = a.signalResult?.confidence ?? 0;
        const score = a.signalResult?.score ?? 0;
        return conf >= gate && score > 0;
      });
    } else if (cat === 'trending') {
      // 24h positive trend, sorted by highest change
      assets = assets.filter(a => a.change24h > 0).sort((a, b) => b.change24h - a.change24h);
    } else if (cat === 'history') {
      const history = this._getSignalHistory();
      if (history.length === 0) {
        el.innerHTML = '<p class="no-data">No signal changes recorded yet. Changes will appear here after the next refresh cycle.</p>';
      } else {
        el.innerHTML = `<div class="signal-history-list">${history.map(h => {
          const time = new Date(h.time);
          const timeStr = time.toLocaleDateString('en-IN', {day:'2-digit', month:'short'}) + ' ' + time.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'});
          const fromLevel = Signals.level(h.from);
          const toLevel = Signals.level(h.to);
          const priceStr = h.price ? '$' + (h.price < 1 ? h.price.toFixed(4) : h.price.toFixed(2)) : '';
          return `<div class="signal-history-entry">
            <span class="sh-icon">${h.icon}</span>
            <span class="sh-name">${h.name} <small>${h.symbol}</small></span>
            <span class="signal-badge signal-${fromLevel.cls}" style="font-size:11px;padding:2px 6px;">${fromLevel.short}</span>
            <span class="sh-arrow">→</span>
            <span class="signal-badge signal-${toLevel.cls}" style="font-size:11px;padding:2px 6px;">${toLevel.short}</span>
            <span class="sh-price">${priceStr}</span>
            <span class="sh-time">${timeStr}</span>
          </div>`;
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

    // Sort by validated winner tier first, then trade quality, then confidence.
    this._sortAssets(assets);

    if (assets.length === 0) {
      el.innerHTML = this.state.loading 
        ? '<p class="no-data">No data yet — loading…</p>'
        : '<p class="no-data">No assets match this filter currently.</p>';
      return;
    }

    el.innerHTML = assets.map(a => this._assetCardHTML(a, false)).join('');
    this._attachCardListeners(el);

    this._initSparklines(assets);
  },

  _initSparklines(assets, isMoonshot = false) {
    assets.forEach(a => {
      const isPos24 = (a.change24h ?? 0) >= 0;
      const isPos4 = (a.change4h ?? 0) >= 0;
      const prefix = isMoonshot ? 'spark_moonshot_' : 'spark_';
      
      if (a.closes1D?.length > 0) {
        Charts.renderSparkline(`${prefix}${a.asset.id}_1d`, a.closes1D, isPos24);
      }
      if (a.closes4H?.length > 0) {
        Charts.renderSparkline(`${prefix}${a.asset.id}_4h`, a.closes4H, isPos4);
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
    const rsi = signalResult?.indicators?.rsi?.value ?? '–';
    const winnerTier = signalResult?.winnerTier ?? 'none';
    
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

    const isStarred = this.state.watchlist.includes(asset.id);
    const quality = this._tradeQuality(signalResult);
    const catBadge = { crypto: '₿ Crypto', stocks: '🇮🇳 Stock', commodities: '🪙 Commodity', forex: '💱 Forex' }[category] ?? category;
    const winnerBadge = this._winnerTierBadge(winnerTier);
    const updateClass = this.state.updatedAssetIds.has(asset.id) ? ' value-updated' : '';

    let fundChip = '';
    if (d.tvl && d.tvl > 0) {
      const fundData = signalResult?.indicators?.fundamental;
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
            <span class="asset-icon">${asset.icon}</span>
            <div class="asset-meta">
              <div class="asset-name">${asset.name}</div>
              <div class="asset-symbol">${asset.symbol}</div>
              <div class="card-badges">
                <span class="cat-badge-inline">${catBadge}</span>
                ${winnerBadge}
              </div>
            </div>
            <button class="star-btn ${isStarred ? 'active' : ''}" data-star-id="${asset.id}" title="Toggle Watchlist" style="background:none; border:none; cursor:pointer; font-size:18px; margin-left:auto; opacity:${isStarred ? 1 : 0.3}; transition:0.2s;">⭐</button>
          </div>
          <div class="signal-badge signal-${level.cls} ${sig === 'STRONG_BUY' || sig === 'STRONG_SELL' ? 'pulse' : ''}" title="Signal: ${level.label}. This is the combined verdict from 4 technical indicators (RSI, MACD, Moving Averages, Bollinger Bands).">
            <span>${level.icon}</span> ${level.short}
          </div>
        </div>

        <div class="card-price-row">
          <div class="price-main${updateClass}" title="Current live price from Binance, refreshed every 60 seconds.">${priceStr}</div>
          <div class="price-changes">
            <div class="price-change ${chg24Cls}${updateClass}" title="Price change in the last 24 hours.">1D: ${chg24Str}</div>
            <div class="price-change ${chg4Cls}${updateClass}" title="Price change over the last 4-hour candle.">4H: ${chg4Str}</div>
          </div>
        </div>
        ${quickTargets}

        <div class="sparklines-container${updateClass}">
          <div class="sparkline-col" title="1-Day Chart (Macro Trend over 90 days)">
            <div class="spark-label">1D Trend</div>
            <canvas id="${sparkId1D}" height="40"></canvas>
          </div>
          <div class="sparkline-col" title="4-Hour Chart (Intraday Trend over 15 days)">
            <div class="spark-label">4H Trend</div>
            <canvas id="${sparkId4H}" height="40"></canvas>
          </div>
        </div>

        <div class="card-indicators${updateClass}">
          <div class="ind-chip" title="RSI (Relative Strength Index): Measures if the asset is oversold or overbought. Below 30 = oversold (good to buy), Above 70 = overbought (consider selling). Range: 0–100.">
            <span class="ind-label">RSI</span>
            <span class="ind-val">${rsi}</span>
          </div>
          <div class="ind-chip" title="Composite Score: Weighted blend of trend, momentum, volatility and volume. Positive = bullish bias, negative = bearish bias.">
            <span class="ind-label">${asset.isMoonshot || asset.id.includes('_4H') ? 'Breakout' : 'Score'}</span>
            <span class="ind-val">${score > 0 ? '+' : ''}${score}</span>
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
        <div class="card-footer">Click for full analysis →</div>
      </div>
    `;
  },

  // ─── Render stop-loss / take-profit levels for actionable signals ──────────
  _stopLevelsHTML(signalResult, asset) {
    const s = signalResult?.stopSuggest;
    if (!s || !['BUY', 'STRONG_BUY'].includes(signalResult?.signal)) return '';
    const cur = (v) => (asset.currency === 'INR' ? '₹' : '$') + this._fmt(v, asset);
    return `
      <div class="stop-levels" title="Place these as real orders on your exchange the moment you enter. Skipping the stop-loss is the #1 cause of large losses.">
        <div class="stop-levels-row">
          <span class="stop-chip stop-chip-sl">🛑 Stop: ${cur(s.stopPrice)} (-${s.distancePct}%)</span>
          <span class="stop-chip stop-chip-tp">🎯 Target: ${s.takeProfitPrice ? cur(s.takeProfitPrice) + ' (+' + s.takeProfitPct + '%)' : 'Trailing'}</span>
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
    localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist));
    
    // Instantly update the visual star state on any visible cards (especially Moonshots)
    const isNowStarred = this.state.watchlist.includes(id);
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
    container.querySelectorAll('.star-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation(); // prevent modal opening
        this._toggleWatchlist(btn.dataset.starId);
      };
    });
    container.querySelectorAll('.asset-card').forEach(card => {
      card.onclick     = () => this._openModal(card.dataset.assetId);
      card.onkeydown   = e => { if (e.key === 'Enter' || e.key === ' ') this._openModal(card.dataset.assetId); };
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

    content.innerHTML = `
      <div class="modal-header">
        <div class="modal-title-row">
          <span class="asset-icon lg">${asset.icon}</span>
          <div>
            <h2>${asset.name} <span class="modal-symbol">${asset.symbol}</span></h2>
            <div class="modal-meta">${{ crypto: '₿ Crypto', stocks: '🇮🇳 NSE Stock', commodities: '🪙 Commodity', forex: '💱 Forex' }[category] ?? category} ${tierBadge}</div>
          </div>
          <div class="signal-badge signal-${level.cls} lg ${['STRONG_BUY','STRONG_SELL'].includes(sig) ? 'pulse' : ''}">
            ${level.icon} ${level.label}
          </div>
          <button class="action-btn" id="modalPaperBuyBtn" data-asset="${asset.id}" style="background:var(--accent); color:#fff; border-radius:4px; padding:6px 12px; margin-left: auto;">Buy (Paper Trade)</button>
        </div>
        <div class="modal-prices">
          <div class="modal-price">${priceStr}</div>
          <div class="price-change ${change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg'} lg">${chgStr} (24h)</div>
        </div>
        <div class="modal-buy-row" style="display:flex; gap:8px; align-items:center; margin-top:8px; font-size:13px;">
          <label for="modalBuyAmount" style="color:var(--text-muted)">Paper-buy amount ($)</label>
          <input type="number" id="modalBuyAmount" min="10" step="10" value="1000"
            style="width:100px; padding:4px 8px; border-radius:4px; border:1px solid var(--border, #333); background:rgba(0,0,0,0.25); color:inherit;" />
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

  // ─── Clock ────────────────────────────────────────────────────────────────────
  _startClock() {
    const update = () => {
      const now = new Date();
      const el = document.getElementById('liveClock');
      if (el) el.textContent = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // EOD countdown to UTC midnight
      const eodEl = document.getElementById('eodClock');
      if (eodEl) {
        const nextMidnight = new Date(now);
        nextMidnight.setUTCHours(24, 0, 0, 0);
        let diffSecs = Math.floor((nextMidnight.getTime() - now.getTime()) / 1000);
        if (diffSecs < 0) diffSecs = 0;
        const h = Math.floor(diffSecs / 3600).toString().padStart(2, '0');
        const m = Math.floor((diffSecs % 3600) / 60).toString().padStart(2, '0');
        const s = (diffSecs % 60).toString().padStart(2, '0');
        eodEl.textContent = `${h}h ${m}m ${s}s`;
      }
    };
    update();
    setInterval(update, 1000);
  },

  _updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (el && this.state.lastUpdate) {
      el.textContent = 'Updated ' + this.state.lastUpdate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    }
  },

  _updateMarketStatus() {
    const status = API.getMarketStatus();
    const el = document.getElementById('marketStatus');
    if (!el) return;
    el.innerHTML = `
      <span class="mkt-dot ${status.nse.open ? 'green' : 'red'}"></span> ${status.nse.label}
      &nbsp;&nbsp;
      <span class="mkt-dot green"></span> ${status.crypto.label}
    `;
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
        this.state.activeSignalFilter = null; // reset filter
      } else {
        this.state.activeSignalFilter = sig;
        // Auto-scroll to the asset grid ONLY when actively selecting a new filter
        document.getElementById('assetGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      this._renderSummaryBar();
      this._renderAssetGrid();
    });

    // Modal close
    document.getElementById('modalClose')?.addEventListener('click', () => this._closeModal());
    document.getElementById('assetModal')?.addEventListener('click', e => {
      if (e.target.id === 'assetModal') this._closeModal();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this._closeModal(); });

    // Manual refresh button
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      // Actually bust the localStorage cache
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('trading_cache_')) localStorage.removeItem(key);
      });
      this.loadAll();
    });

    // Sidebar nav
    document.querySelectorAll('.nav-link').forEach(link => {
      link.onclick = e => {
        e.preventDefault();
        const section = link.dataset.section;
        document.querySelectorAll('.main-section').forEach(s => s.classList.toggle('active', s.id === section));
        document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l === link));
        if (section === 'portfolioSection') this._renderPortfolio();
      };
    });

    // Portfolio
    document.getElementById('resetPortfolioBtn')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset your Paper Trading account to $10,000?')) {
        Portfolio.reset();
        this._renderPortfolio();
      }
    });

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
          if (setups.length > 12) grid.classList.add('dense-grid');
          else grid.classList.remove('dense-grid');
          
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

    // Delegate portfolio sell buttons
    document.getElementById('openPositionsTable')?.addEventListener('click', e => {
      if (e.target.classList.contains('sell-btn')) {
        const tradeId = e.target.dataset.trade;
        const currentPrice = parseFloat(e.target.dataset.price);
        const res = Portfolio.sell(tradeId, currentPrice);
        if (res.success) {
          this._showToast(`Sold position. PnL: $${res.pnl.toFixed(2)}`, res.pnl >= 0 ? 'success' : 'warning');
          this._renderPortfolio();
        }
      }
    });

    // Delegate paper buy button in modal
    document.getElementById('assetModal')?.addEventListener('click', e => {
      if (e.target.id === 'modalPaperBuyBtn') {
        const assetId = e.target.dataset.asset;
        const liveAsset = this.state.allAssets.find(a => a.asset.id === assetId);
        if (!liveAsset || !liveAsset.price) {
          this._showToast('Price unavailable', 'warning');
          return;
        }

        const input = document.getElementById('modalBuyAmount');
        const cost = Math.max(10, parseFloat(input?.value) || 1000);
        const result = liveAsset.signalResult;
        const risk = result?.stopSuggest;
        const res = Portfolio.buy(liveAsset.asset, liveAsset.price, cost, {
          stopPrice: risk?.stopPrice,
          takeProfitPrice: risk?.takeProfitPrice,
          signal: result?.signal,
          winnerTier: result?.winnerTier,
        });
        if (res.success) {
          this._showToast(`Bought $${cost.toLocaleString()} of ${liveAsset.asset.symbol} (Paper Trade)`, 'success');
          this._closeModal();
          this._renderPortfolio();
        } else {
          this._showToast(res.error, 'error');
        }
      }
    });
  },

  // ─── Portfolio Render ────────────────────────────────────────────────────────
  _renderPortfolio() {
    if (!window.Portfolio) return;
    const state = Portfolio.getState();
    
    document.getElementById('portfolioBalance').textContent = '$' + state.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totalRisk = state.positions.reduce((sum, pos) => sum + (pos.riskAmount || 0), 0);
    const accountValue = state.balance + state.positions.reduce((sum, pos) => {
      const live = this.state.allAssets.find(a => a.asset.id === pos.assetId)?.price ?? pos.buyPrice;
      return sum + pos.amount * live;
    }, 0);
    const riskPct = accountValue > 0 ? (totalRisk / accountValue) * 100 : 0;
    const riskEl = document.getElementById('portfolioRiskSummary');
    if (riskEl) {
      riskEl.innerHTML = `<span>Open risk <strong>$${totalRisk.toFixed(2)}</strong> (${riskPct.toFixed(2)}%)</span><small>${riskPct > 2 ? 'Above 2% account-risk limit' : 'Within 2% account-risk limit'}</small>`;
      riskEl.className = `portfolio-risk-summary ${riskPct > 2 ? 'risk-warning' : 'risk-ok'}`;
    }

    const openTbody = document.querySelector('#openPositionsTable tbody');
    if (openTbody) {
      if (state.positions.length === 0) {
        openTbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted)">No open positions. Buy an asset from the dashboard to start!</td></tr>';
      } else {
        openTbody.innerHTML = state.positions.map(pos => {
          const liveAsset = this.state.allAssets.find(a => a.asset.id === pos.assetId);
          const currentPrice = liveAsset?.price ?? pos.buyPrice;
          const liveVal = pos.amount * currentPrice;
          const pnl = liveVal - pos.cost;
          const pnlCls = pnl >= 0 ? 'pos' : 'neg';
          const pnlStr = pnl >= 0 ? '+$' + pnl.toFixed(2) : '-$' + Math.abs(pnl).toFixed(2);
          
          return `
            <tr>
              <td><strong>${pos.name}</strong> <span style="font-size:12px; color:var(--text-muted)">${pos.symbol}</span></td>
              <td>$${pos.buyPrice.toFixed(4)}</td>
              <td>$${currentPrice.toFixed(4)}</td>
              <td>$${pos.cost.toFixed(2)}</td>
              <td><span class="pnl-badge ${pnlCls}">${pnlStr}</span></td>
              <td><span class="risk-levels">SL $${(pos.stopPrice ?? pos.buyPrice).toFixed(4)}<br>TP $${(pos.takeProfitPrice ?? pos.buyPrice).toFixed(4)}</span></td>
              <td><span class="pnl-badge" style="background:var(--bg-app); border: 1px solid var(--border); color: #fff;">${liveAsset?.signalResult?.signal ?? 'HOLD'}</span></td>
              <td><button class="action-btn sell-btn" data-trade="${pos.tradeId}" data-price="${currentPrice}" style="padding:4px 8px; font-size:12px; border:1px solid var(--accent); color:var(--accent); border-radius:4px">Close Position</button></td>
            </tr>
          `;
        }).join('');
      }
    }

    const histTbody = document.querySelector('#tradeHistoryTable tbody');
    if (histTbody) {
      if (state.history.length === 0) {
        histTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted)">No trade history yet.</td></tr>';
      } else {
        histTbody.innerHTML = state.history.map(h => {
          const pnlCls = h.pnl >= 0 ? 'pos' : 'neg';
          const pnlStr = h.pnl >= 0 ? '+$' + h.pnl.toFixed(2) : '-$' + Math.abs(h.pnl).toFixed(2);
          const date = new Date(h.date).toLocaleDateString('en-IN') + ' ' + new Date(h.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute:'2-digit' });
          return `
            <tr>
              <td><strong>${h.name}</strong></td>
              <td>$${h.buyPrice.toFixed(4)}</td>
              <td>$${h.sellPrice.toFixed(4)}</td>
              <td><span class="pnl-badge ${pnlCls}">${pnlStr} (${h.pnlPct.toFixed(2)}%)</span></td>
              <td style="font-size:12px; color:var(--text-muted)">${h.exitReason || 'MANUAL'}<br>${date}</td>
            </tr>
          `;
        }).join('');
      }
    }
  },

  _ocoHTML(d) {
    const s = d.signalResult?.stopSuggest;
    if (!s || !['BUY', 'STRONG_BUY'].includes(d.signalResult?.signal)) {
      return '<div class="oco-panel oco-muted">No OCO levels: wait for a core Buy setup with a valid stop and target.</div>';
    }
    const price = d.price;
    const valid = price > s.stopPrice && s.stopPrice > 0 && s.takeProfitPrice > price;
    const riskPct = Number(s.distancePct) || 0;
    const rewardPct = Number(s.takeProfitPct) || 0;
    const rewardRisk = riskPct > 0 && rewardPct > 0 ? (rewardPct / riskPct).toFixed(1) : '–';
    const staleMinutes = d.fetchedAt ? (Date.now() - new Date(d.fetchedAt).getTime()) / 60000 : Infinity;
    const stale = !Number.isFinite(staleMinutes) || staleMinutes > 15;
    const status = !valid ? 'Invalid price relationship' : stale ? 'Refresh before placing: levels are stale' : 'OCO levels ready to review';
    const statusClass = !valid || stale ? 'oco-warning' : 'oco-ready';
    const symbol = d.asset.symbol;
    const rules = d.rules || {};
    const ruleText = rules.minNotional ? `Binance minimum order value: $${rules.minNotional}. Quantity step: ${rules.stepSize}. Price tick: ${rules.tickSize}.` : 'Binance will enforce the pair minimum value and price/quantity precision.';
    return `
      <div class="oco-panel">
        <div class="oco-title">OCO order for ${symbol}</div>
        <div class="oco-status ${statusClass}">${status}</div>
        <div class="oco-grid">
          <span>Price / TP <strong>${this._fmt(s.takeProfitPrice, d.asset)}</strong></span>
          <span>Stop price <strong>${this._fmt(s.stopPrice, d.asset)}</strong></span>
          <span>Stop-limit <strong>${this._fmt(s.stopPrice * 0.998, d.asset)}</strong></span>
        </div>
        <small>Reward/risk: ${rewardRisk}R. Use these as a sell OCO on Binance. Enter your available ${symbol} amount. ${ruleText}</small>
      </div>
    `;
  },
};

// ── Boot on DOM ready ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => Dashboard.init());
