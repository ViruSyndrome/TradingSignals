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
    fearGreed:     null,
    marketRegime: 'unknown',
    scalps:        [],       // results from the 5m Meme Scalper
  },

  // ─── Signal History ─────────────────────────────────────────────────────────
  SIGNAL_HISTORY_KEY: 'signal_history_v1',
  _previousSignals: new Map(),
  _previousScalps: new Map(),
  
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
    // Deduplicate to keep only the most recent event per asset, so arrows don't vanish due to spam
    const uniqueHistory = [];
    const seenIds = new Set();
    for (const h of history) {
      if (!seenIds.has(h.id)) {
        seenIds.add(h.id);
        uniqueHistory.push(h);
      }
    }
    
    // Keep last 300 unique entries (plenty for all tracked assets)
    const trimmed = uniqueHistory.slice(0, 300);
    this.state.latestSignalHistory = trimmed;
    try {
      localStorage.setItem(this.SIGNAL_HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('Failed to save signal history to localStorage', e);
    }
  },

  _trackScalpChanges(setups) {
    const history = this._getSignalHistory();
    const now = new Date().toISOString();
    const currentSetupIds = new Set();
    
    // Check for new or changed scalps
    for (const s of setups) {
      const id = s.asset?.id;
      if (!id) continue;
      currentSetupIds.add(id);
      
      const oldSignal = this._previousScalps.get(id);
      const newSignal = s.signalResult?.signal ?? 'BUY';
      
      if (!oldSignal || oldSignal !== newSignal) {
        history.unshift({
          time: now,
          id: id,
          name: s.asset?.name || id,
          symbol: (s.asset?.symbol || id) + ' (5m)',
          icon: '⚡',
          from: oldSignal || 'NEUTRAL',
          to: newSignal,
          score: s.signalResult?.score ?? 0,
          price: s.price,
        });
        this._previousScalps.set(id, newSignal);
      }
    }

    // Check for expired scalps
    for (const [id, oldSignal] of this._previousScalps.entries()) {
      if (!currentSetupIds.has(id)) {
        history.unshift({
          time: now,
          id: id,
          name: id,
          symbol: id.replace('_5M', '').replace('_4H', '') + ' (5m)',
          icon: '⚡',
          from: oldSignal,
          to: 'EXPIRED',
          score: 0,
          price: 0,
        });
        this._previousScalps.delete(id);
      }
    }

    // Deduplicate to keep only the most recent event per asset
    const uniqueHistory = [];
    const seenIds = new Set();
    for (const h of history) {
      if (!seenIds.has(h.id)) {
        seenIds.add(h.id);
        uniqueHistory.push(h);
      }
    }

    // Keep last 300 unique entries
    const trimmed = uniqueHistory.slice(0, 300);
    this.state.latestSignalHistory = trimmed;
    try {
      localStorage.setItem(this.SIGNAL_HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('Failed to save scalp history', e);
    }
  },
  
  _getSignalHistory() {
    try {
      const raw = localStorage.getItem(this.SIGNAL_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  },

  // ─── Boot ────────────────────────────────────────────────────────────────────
  async init() {
    this.state.latestSignalHistory = this._getSignalHistory();
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
    this._startClock();
    // Paint instantly from last-known snapshot while the live fetch runs.
    if (this._restoreSnapshot()) this._render();
    await this._fetchFearGreed();  // sentiment feeds the signal engine — fetch first
    await this.loadAll(true);
    this._scheduleRefresh();

    // Auto-scan moonshots in the background every 5 minutes (300,000 ms)
    this.state.moonshotTimer = setInterval(() => this._autoScanMoonshots(), 5 * 60 * 1000);
    // Kick off an initial background scan 5 seconds after the app loads
    setTimeout(() => this._autoScanMoonshots(), 5000);

    // Auto-scan meme scalps every 5 minutes, OFFSET by 2.5 min to avoid rate limits
    this.state.scalperTimer = setInterval(() => this._autoScanScalps(), 5 * 60 * 1000);
    setTimeout(() => this._autoScanScalps(), 150000); // 2.5 minutes after load
  },

  // Hide filter tabs for asset categories that are empty in CONFIG.
  _hideEmptyCategoryTabs() {
    const map = {
      crypto:      CONFIG.assets.crypto,
    };
    document.querySelectorAll('.filter-tab').forEach(tab => {
      const cat = tab.dataset.cat;
      if (cat && cat !== 'all' && cat !== 'watchlist' && cat !== 'oversold' && cat !== 'highconf' && cat !== 'trending' && cat !== 'scalper' && (!map[cat] || map[cat].length === 0)) {
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

      // Inject active scalps from background scanner
      if (this.state.scalps && this.state.scalps.length > 0) {
        const liveScalps = await Promise.all(this.state.scalps.map(async scalp => {
          const baseId = scalp.asset?.id.replace('_5M', 'USDT');
          const liveData = all.find(a => a.asset?.id === baseId);
          let updatedScalp = { ...scalp };
          
          if (liveData) {
            updatedScalp.price = liveData.price;
            updatedScalp.change24h = liveData.change24h;
            updatedScalp.change4h = liveData.change4h;
          }
          
          // Fast-fetch fresh 5m klines to keep 5m change and signal accurate every 30s
          try {
            const klines = await API._fetch(`https://api.binance.com/api/v3/klines?symbol=${baseId}&interval=5m&limit=100`, 5000, 0);
            if (Array.isArray(klines) && klines.length >= 50) {
              const closes = klines.map(k => parseFloat(k[4]));
              const highs = klines.map(k => parseFloat(k[2]));
              const lows = klines.map(k => parseFloat(k[3]));
              const volumes = klines.map(k => parseFloat(k[5]));
              const timestamps = klines.map(k => k[0]);
              
              if (liveData && liveData.price != null) {
                const lastIdx = closes.length - 1;
                closes[lastIdx] = liveData.price;
                if (liveData.price > highs[lastIdx]) highs[lastIdx] = liveData.price;
                if (liveData.price < lows[lastIdx]) lows[lastIdx] = liveData.price;
              }

              const result = Signals.generateScalp(closes, { highs, lows, volumes });
              const prevResult = Signals.generateScalp(closes.slice(0, -1), { highs: highs.slice(0, -1), lows: lows.slice(0, -1), volumes: volumes.slice(0, -1) });
              updatedScalp.closes = closes;
              updatedScalp.highs = highs;
              updatedScalp.lows = lows;
              updatedScalp.timestamps = timestamps;
              updatedScalp.signalResult = result;
              updatedScalp.prevSignalResult = prevResult;
              updatedScalp.change5m = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
            }
          } catch (e) {
            console.warn(`[Dashboard] Failed to refresh 5m klines for ${baseId}:`, e.message);
          }
          return updatedScalp;
        }));
        
        this.state.scalps = liveScalps;
        this.state.allAssets.push(...liveScalps);
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
        try { localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist)); } catch(e) {}
        this.loadAll(true); // Re-render the dashboard to show the new coins (which also runs cleanup at the end)
        console.log(`[Moonshots] Background scan found ${setups.length} setups and added new ones to the dashboard!`);
        if (statusEl) statusEl.innerHTML = `🚀 ${timeStr} (<b style="color:var(--pos)">+${setups.length} new!</b>)`;
      } else {
        console.log('[Moonshots] Background scan complete: No new setups (already tracking existing ones).');
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
        if (this.state.invested.includes(asset.id)) continue;
        
        const d = this.state.allAssets.find(a => a.asset.id === asset.id);
        const sig = d?.signalResult?.signal ?? 'NEUTRAL';
        
        // Remove if it loses BUY/STRONG_BUY status
        if (sig !== 'BUY' && sig !== 'STRONG_BUY') {
          console.log(`[Moonshots] Auto-cleaning stale moonshot: ${asset.id} (Signal: ${sig})`);
          this.state.watchlist = this.state.watchlist.filter(id => id !== asset.id);
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

  _cleanStaleScalps() {
    let removedAny = false;
    for (let i = CONFIG.assets.crypto.length - 1; i >= 0; i--) {
      const asset = CONFIG.assets.crypto[i];
      if (asset.grafted && asset.isScalp) {
        if (this.state.invested.includes(asset.id)) continue;
        
        const d = this.state.allAssets.find(a => a.asset.id === asset.id);
        const sig = d?.signalResult?.signal ?? 'NEUTRAL';
        
        if (sig !== 'STRONG_BUY') {
          console.log(`[Scalper] Auto-cleaning stale scalp: ${asset.id} (Signal: ${sig})`);
          this.state.watchlist = this.state.watchlist.filter(id => id !== asset.id);
          CONFIG.assets.crypto.splice(i, 1);
          if (this.state.allAssets) {
            this.state.allAssets = this.state.allAssets.filter(a => a.asset.id !== asset.id);
          }
          removedAny = true;
        }
      }
    }
    if (removedAny && this.state.scalps) {
      this.state.scalps = this.state.scalps.filter(s => {
        const d = this.state.allAssets.find(a => a.asset.id === s.asset?.id);
        return d && d.signalResult?.signal === 'STRONG_BUY';
      });
    }
    return removedAny;
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
      
      this.state.scalps = setups;
      
      // Graft scalps into CONFIG so they get live 1D and 4H updates in loadAll()
      for (const s of setups) {
        const id = s.asset?.id;
        if (id && !CONFIG.assets.crypto.some(a => a.id === id)) {
          CONFIG.assets.crypto.push({
            id: id,
            symbol: s.asset?.symbol,
            name: s.asset?.name,
            currency: 'USD',
            icon: '⚡',
            grafted: true,
            isScalp: true
          });
        }
      }

      // If we are currently on the scalper tab, trigger a re-render

      if (this.state.activeCategory === 'scalper') {
        this.loadAll(true);
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

  // ─── Main render ─────────────────────────────────────────────────────────────
  _render() {
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

  async _initNewsTape() {
    const el = document.getElementById('newsTapeTrack');
    if (!el) return;
    const fetchNews = async () => {
      try {
        const res = await fetch('https://api.rss2json.com/v1/api.json?rss_url=https://www.coindesk.com/arc/outboundfeeds/rss/');
        const data = await res.json();
        if (!data.items) return;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const validItems = data.items.filter(item => new Date(item.pubDate) > twentyFourHoursAgo);
        
        if (validItems.length === 0) {
          el.innerHTML = '<span class="tape-item" style="color:var(--text-muted);">Waiting for new breaking stories today...</span>';
          el.classList.remove('moving');
          return;
        }

        const itemsStr = validItems.map(item => `<span class="tape-item"><a href="${item.link}" target="_blank" style="color: var(--text-main); text-decoration: none; font-weight: 500;">${item.title}</a> <em style="color: var(--text-muted); font-size: 10px; font-weight: normal; margin-left: 6px;">[${new Date(item.pubDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}]</em></span>`).join('');
        el.innerHTML = itemsStr + itemsStr;
        el.classList.add('moving');
      } catch (e) {
        console.error('News Tape Error:', e);
      }
    };
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
      <div class="summary-item" title="Custom 9/21 Trend Strategy - Built to catch early momentum and hold as long as the trend is green.">
        <span class="summary-value" style="color:#29b6f6">⚙️ Trend Runner | RSI=${CONFIG.activeParams.rsiPeriod}</span>
        <span class="summary-label">Custom Strategy (EMA ${CONFIG.activeParams.emaFast}/${CONFIG.activeParams.emaSlow})</span>
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
    } else if (cat === 'scalper') {
      assets = assets.filter(a => a.category === 'scalper');
    } else if (cat === 'trending') {
      // 4h positive trend, sorted by highest change
      assets = assets.filter(a => a.change4h > 0).sort((a, b) => b.change4h - a.change4h);
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
    // Skip this sort if we're on the 'trending' tab, which has its own percentage-based sort.
    if (cat !== 'trending') {
      this._sortAssets(assets);
    }

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

  _renderMoonshotGrid() {
    const grid = document.getElementById('moonshotGrid');
    if (!grid) return;
    
    // Check if the user has manually scanned setups first
    if (this.state.moonshots && this.state.moonshots.length > 0) return;

    // Otherwise, pull any background-scanned moonshots directly from the live feed
    const backgroundMoonshots = this.state.allAssets.filter(a => a.asset?.isMoonshot);
    
    if (backgroundMoonshots.length === 0) {
      grid.innerHTML = '<p class="no-data">No explosive setups found right now. Wait for the background scanner or run a manual scan.</p>';
      return;
    }

    this._sortAssets(backgroundMoonshots);
    if (backgroundMoonshots.length > 12) grid.classList.add('dense-grid');
    else grid.classList.remove('dense-grid');
    
    // Moonshot cards are formatted slightly differently (show signal score, hide stars)
    grid.innerHTML = backgroundMoonshots.map(s => this._assetCardHTML(s, false, true)).join('');
    this._attachCardListeners(grid);
    this._initSparklines(backgroundMoonshots, true);
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

    const isStarred = this.state.watchlist.includes(asset.id);
    const isLocked = this.state.invested.includes(asset.id);
    const quality = this._tradeQuality(signalResult);
    const catBadge = { crypto: '₿ Crypto', stocks: '🇮🇳 Stock', commodities: '🪙 Commodity', forex: '💱 Forex' }[category] ?? category;
    const winnerBadge = this._winnerTierBadge(winnerTier);
    const updateClass = this.state.updatedAssetIds.has(asset.id) ? ' value-updated' : '';

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
            <span class="asset-icon">${asset.icon}</span>
            <div class="asset-meta">
              <div class="asset-name">${asset.name}</div>
              <a href="https://www.binance.com/en/trade/${asset.symbol}_USDT?type=spot&ref=1264948110" target="_blank" class="asset-symbol" style="text-decoration:none; color:var(--text-secondary); pointer-events: auto;" title="Trade on Binance">${asset.symbol}USDT ↗</a>
              <div class="card-badges">
                <span class="cat-badge-inline">${catBadge}</span>
                ${winnerBadge}
              </div>
            </div>
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
            ${d.category === 'scalper' ? '' : `
              <div style="display:flex; gap: 4px;">
                <button class="lock-btn ${isLocked ? 'active' : ''}" data-lock-id="${asset.id}" title="${isLocked ? 'Locked (Invested). Will not be auto-removed.' : 'Lock this coin (I have invested). Prevents auto-cleanup.'}" style="background:none; border:none; cursor:pointer; font-size:16px; opacity:${isLocked ? 1 : 0.25}; transition:0.2s; padding: 0;">🔒</button>
                <button class="star-btn ${isStarred ? 'active' : ''}" data-star-id="${asset.id}" title="Toggle Watchlist" style="background:none; border:none; cursor:pointer; font-size:18px; opacity:${isStarred ? 1 : 0.3}; transition:0.2s; padding: 0;">⭐</button>
              </div>
            `}
            <div class="signal-badge signal-${level.cls} ${sig === 'STRONG_BUY' || sig === 'STRONG_SELL' ? 'pulse' : ''}" title="Signal: ${level.label}. This is the combined verdict from 4 technical indicators (RSI, MACD, Moving Averages, Bollinger Bands).${momentumTitle}">
              <span>${level.icon}</span> ${level.short}${momentumIcon}
            </div>
          </div>
        </div>

        <div class="card-price-row">
          <div class="price-main${updateClass}" title="Current live price from Binance, refreshed every 60 seconds.">${priceStr}</div>
          <div class="price-changes">
            <div class="price-change ${chg24Cls}${updateClass}" title="Price change in the last 24 hours.">1D: ${chg24Str}</div>
            <div class="price-change ${chg4Cls}${updateClass}" title="Price change over the last 4-hour candle.">4H: ${chg4Str}</div>
            ${d.category === 'scalper' 
              ? `<div class="price-change ${(d.change5m || 0) >= 0 ? 'pos' : 'neg'}${updateClass}" title="Price change over the last 5-minute candle.">5m: ${(d.change5m || 0) > 0 ? '+' : ''}${(d.change5m || 0).toFixed(2)}%</div>` 
              : ''
            }
          </div>
        </div>
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
            <span class="ind-label">${asset.isMoonshot || asset.id.includes('_4H') ? 'Breakout' : 'Score'}</span>
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

  _toggleInvested(id) {
    if (!id.toUpperCase().endsWith('USDT') && !id.toUpperCase().includes('_4H')) {
      id = id.toUpperCase() + 'USDT';
    } else {
      id = id.toUpperCase();
    }

    if (this.state.invested.includes(id)) {
      this.state.invested = this.state.invested.filter(x => x !== id);
    } else {
      this.state.invested.push(id);
    }
    try { localStorage.setItem('trading_invested', JSON.stringify(this.state.invested)); } catch(e) { console.warn('Failed to save lock status', e); }

    const isLocked = this.state.invested.includes(id);
    document.querySelectorAll(`.lock-btn[data-lock-id="${id}"]`).forEach(btn => {
      if (isLocked) {
        btn.classList.add('active');
        btn.style.opacity = '1';
        btn.title = 'Locked (Invested). Will not be auto-removed.';
      } else {
        btn.classList.remove('active');
        btn.style.opacity = '0.25';
        btn.title = "Lock this coin (I've invested). Prevents auto-cleanup.";
      }
    });
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
    try { localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist)); } catch(e) { console.warn('Failed to save watchlist', e); }
    
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
    container.querySelectorAll('.lock-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-lock-id') || btn.dataset.lockId;
        console.log('[Lock] Clicked:', id);
        this._toggleInvested(id);
      });
    });
    container.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-star-id') || btn.dataset.starId;
        console.log('[Star] Clicked:', id);
        this._toggleWatchlist(id);
      });
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
        </div>
        <div class="modal-prices">
          <div class="modal-price">${priceStr}</div>
          <div class="price-change ${change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg'} lg">${chgStr} (24h)</div>
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
        this.state.activeSignalFilter = null; // reset filter
      } else {
        this.state.activeSignalFilter = sig;
        // Auto-scroll to the asset grid ONLY when actively selecting a new filter
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
      };
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
document.addEventListener('DOMContentLoaded', () => {
  Dashboard.init();

  // Browser SPA Anti-Scroll Bug Fix:
  // Prevent Chrome from aggressively scrolling the overflow:hidden body or main-content
  // when navigating back to the tab with a focused element off-screen.
  window.addEventListener('scroll', () => {
    if (window.scrollY > 0 || window.scrollX > 0) window.scrollTo(0, 0);
  }, { passive: true });
  
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.addEventListener('scroll', function() {
      if (this.scrollTop > 0) this.scrollTop = 0;
      if (this.scrollLeft > 0) this.scrollLeft = 0;
    }, { passive: true });
  }
});
