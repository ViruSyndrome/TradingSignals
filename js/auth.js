const SUPABASE_URL = 'https://ogoljnujatnlttrpjpxr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_G2op6O8Ia-f6f27PRCE9YA_ZwtRUi5U'; 

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storage: window.localStorage,
  },
});

const Auth = {
  user: null,
  isLoginMode: true,
  FOLLOWED_KEY: 'trading_followed_v1',
  PORTFOLIO_REV_KEY: 'trading_portfolio_rev',
  _portfolioTableOk: null,
  _syncFromInFlight: null,
  _lastSyncFromAt: 0,
  /** True after first successful syncFromCloud for this session — blocks empty overwrites. */
  _portfolioHydrated: false,

  async init() {
    this._consumeAuthRedirectErrors();

    const { data: { session }, error: sessionErr } = await supabaseClient.auth.getSession();
    if (sessionErr) console.warn('[Auth] getSession:', sessionErr.message);
    this.user = session?.user || null;
    this._updateUI();
    if (this.user) {
      this.syncFromCloud();
      this._cleanAuthParamsFromUrl();
    }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      this._updateUI();
      if (event === 'SIGNED_IN') {
        this._closeAuthModal();
        this._cleanAuthParamsFromUrl();
        this.syncFromCloud();
        window.Dashboard?._showToast?.('Signed in — holdings syncing', 'success');
      }
      if (event === 'SIGNED_OUT') {
        this._portfolioHydrated = false;
        window.Dashboard?._showToast?.('Signed out', 'info');
      }
    });

    this._bindEvents();
  },

  /** Canonical redirect matching PWA start_url (./index.html) + Supabase allowlist. */
  _redirectTo() {
    try {
      const u = new URL('index.html', window.location.href);
      u.search = '';
      u.hash = '';
      return u.href;
    } catch {
      return `${window.location.origin}/index.html`;
    }
  },

  _openAuthModal() {
    const authModal = document.getElementById('authModal');
    if (!authModal) return;
    // Critical: never leave style.display='none' from older buggy close paths
    authModal.style.removeProperty('display');
    authModal.classList.add('open');
    this.isLoginMode = true;
    this._renderModalState();
  },

  _closeAuthModal() {
    const authModal = document.getElementById('authModal');
    if (!authModal) return;
    authModal.classList.remove('open');
    authModal.style.removeProperty('display');
  },

  _consumeAuthRedirectErrors() {
    try {
      const params = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
      const err = params.get('error_description') || params.get('error')
        || hashParams.get('error_description') || hashParams.get('error');
      if (err) {
        console.error('[Auth] OAuth redirect error:', err);
        setTimeout(() => {
          window.Dashboard?._showToast?.(decodeURIComponent(err), 'warning');
          this._openAuthModal();
          const errEl = document.getElementById('authError');
          if (errEl) {
            errEl.style.color = 'var(--c-red)';
            errEl.textContent = decodeURIComponent(err);
            errEl.style.display = 'block';
          }
        }, 400);
        this._cleanAuthParamsFromUrl();
      }
    } catch (e) { /* ignore */ }
  },

  _cleanAuthParamsFromUrl() {
    try {
      const u = new URL(window.location.href);
      const authKeys = ['code', 'state', 'error', 'error_description', 'error_code'];
      let changed = false;
      for (const k of authKeys) {
        if (u.searchParams.has(k)) {
          u.searchParams.delete(k);
          changed = true;
        }
      }
      if (u.hash && /access_token|error|refresh_token|type=/.test(u.hash)) {
        u.hash = '';
        changed = true;
      }
      if (changed) {
        window.history.replaceState({}, document.title, u.pathname + (u.search || '') + (u.hash || ''));
      }
    } catch (e) { /* ignore */ }
  },

  _bindEvents() {
    const authBtn = document.getElementById('authBtn');
    const authModal = document.getElementById('authModal');
    const closeBtn = document.getElementById('closeAuthModal');
    const toggleBtn = document.getElementById('authToggleBtn');
    const submitBtn = document.getElementById('authSubmitBtn');

    if (authBtn) {
      authBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.user) {
          if (confirm('Are you sure you want to sign out?')) this.logout();
        } else {
          this._openAuthModal();
        }
      });
    }

    if (closeBtn) closeBtn.addEventListener('click', () => this._closeAuthModal());
    if (authModal) {
      authModal.addEventListener('click', (e) => {
        if (e.target === authModal) this._closeAuthModal();
      });
    }

    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.isLoginMode = !this.isLoginMode;
        this._renderModalState();
      });
    }

    if (submitBtn) submitBtn.addEventListener('click', () => this.handleAuthSubmit());
    const pw = document.getElementById('authPassword');
    if (pw) {
      pw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleAuthSubmit();
        }
      });
    }
    const googleBtn = document.getElementById('authGoogleBtn');
    const githubBtn = document.getElementById('authGithubBtn');
    const redirectTo = this._redirectTo();

    if (googleBtn) {
      googleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('authError');
        if (errEl) errEl.style.display = 'none';
        
        try {
          const originalText = googleBtn.innerHTML;
          googleBtn.innerHTML = '<span style="font-size:12px;">Connecting to Auth Server...</span>';
          
          // Timeout wrapper in case ISP is throttling/blocking Supabase OAuth
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Auth server timeout. Your ISP may be blocking Supabase. Please try a VPN or a different network.')), 15000)
          );
          
          const authPromise = supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo, skipBrowserRedirect: false },
          });

          const { error } = await Promise.race([authPromise, timeoutPromise]);
          if (error) throw error;
        } catch (err) {
          if (errEl) {
            errEl.style.color = 'var(--c-red)';
            errEl.innerText = err.message;
            errEl.style.display = 'block';
          }
          googleBtn.innerHTML = '<img src="https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg" alt="Google"> Continue with Google';
          console.error('[Auth] Google login error:', err);
        }
      });
    }

    if (githubBtn) {
      githubBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('authError');
        try {
          const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'github',
            options: { redirectTo, skipBrowserRedirect: false },
          });
          if (error) throw error;
        } catch (err) {
          if (errEl) {
            errEl.style.color = 'var(--c-red)';
            errEl.textContent = err.message || 'GitHub sign-in failed';
            errEl.style.display = 'block';
          }
        }
      });
    }
  },

  _renderModalState() {
    const title = document.getElementById('authModalTitle');
    const submitBtn = document.getElementById('authSubmitBtn');
    const toggleText = document.getElementById('authToggleText');
    const toggleBtn = document.getElementById('authToggleBtn');
    const err = document.getElementById('authError');
    
    err.style.display = 'none';

    if (this.isLoginMode) {
      title.textContent = 'Sign In';
      submitBtn.textContent = 'Sign In';
      toggleText.textContent = "Don't have an account?";
      toggleBtn.textContent = "Register here";
    } else {
      title.textContent = 'Create Account';
      submitBtn.textContent = 'Register';
      toggleText.textContent = "Already have an account?";
      toggleBtn.textContent = "Sign in here";
    }
  },

  _updateUI() {
    try {
      const authBtn = document.getElementById('authBtn');
      if (!authBtn) return;
      
      if (this.user) {
        let avatar = 'https://www.svgrepo.com/show/5125/avatar.svg';
        let name = 'Trader';
        
        if (this.user.user_metadata) {
          avatar = this.user.user_metadata.avatar_url || avatar;
          name = this.user.user_metadata.full_name || name;
        } else if (this.user.email) {
          name = this.user.email.split('@')[0];
        }
        
        authBtn.innerHTML = `
          <div style="display:flex; align-items:center; width:100%; gap: 10px;">
            <img src="${avatar}" style="width:28px; height:28px; border-radius:50%; object-fit:cover; border: 1px solid var(--accent);">
            <div style="display:flex; flex-direction:column; align-items:flex-start; overflow:hidden;">
              <span style="font-size:13px; font-weight:600; color:var(--text-main); white-space:nowrap; text-overflow:ellipsis; max-width:80px; overflow:hidden;">${name}</span>
              <span style="font-size:10px; color:var(--text-muted);">Sign Out</span>
            </div>
            <svg style="margin-left:auto; width:16px; height:16px; color:var(--text-muted);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
          </div>
        `;
        
        authBtn.style.padding = '8px 12px';
        authBtn.style.background = 'rgba(255, 255, 255, 0.03)';
        authBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        authBtn.style.color = 'var(--text-main)';
      } else {
        authBtn.innerHTML = '<svg style="margin-right:8px; width:18px; height:18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg> <span id="authBtnText">Sign In / Register</span>';
        authBtn.style.padding = '';
        authBtn.style.background = 'rgba(0, 242, 254, 0.1)';
        authBtn.style.borderColor = 'var(--accent)';
        authBtn.style.color = 'var(--text-main)';
      }
    } catch (e) {
      const authBtn = document.getElementById('authBtn');
      if (authBtn) {
        authBtn.innerHTML = "Error: " + e.message.substring(0, 15);
      }
    }
  },

  async handleAuthSubmit() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const errEl = document.getElementById('authError');
    const submitBtn = document.getElementById('authSubmitBtn');

    if (!email || !password) {
      errEl.textContent = 'Please enter both email and password.';
      errEl.style.display = 'block';
      return;
    }

    errEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    try {
      if (this.isLoginMode) {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        errEl.style.color = 'var(--c-green)';
        errEl.textContent = 'Success! You are now logged in.';
        errEl.style.display = 'block';
      }
      
      setTimeout(() => this._closeAuthModal(), this.isLoginMode ? 400 : 1200);

    } catch (error) {
      errEl.style.color = 'var(--c-red)';
      errEl.textContent = error.message;
      errEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = this.isLoginMode ? 'Sign In' : 'Register';
    }
  },

  async logout() {
    await supabaseClient.auth.signOut();
  },

  _readLocalJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  },

  _normId(id) {
    return String(id).toUpperCase().replace('_4H', '').replace('_5M', '');
  },

  /** Bump whenever the user stars/unstars/locks/unlocks so deletes can win across devices. */
  touchPortfolioRev(ts = Date.now()) {
    const n = Number(ts) || Date.now();
    try { localStorage.setItem(this.PORTFOLIO_REV_KEY, String(n)); } catch (_) {}
    return n;
  },

  getPortfolioRev() {
    try {
      const n = parseInt(localStorage.getItem(this.PORTFOLIO_REV_KEY) || '0', 10);
      return Number.isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  },

  _prunedMetaForInvested(meta, invested) {
    const src = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
    const out = {};
    for (const id of (invested || [])) {
      const base = this._normId(id);
      if (src[base]) out[base] = src[base];
    }
    return out;
  },

  _applyPortfolioLocal(invested, watchlist, holdingsMeta, followed) {
    const inv = Array.isArray(invested) ? invested : [];
    const watch = Array.isArray(watchlist) ? watchlist : [];
    const meta = this._prunedMetaForInvested(holdingsMeta, inv);
    const fol = Array.isArray(followed) ? followed : [];
    if (window.Dashboard?.state) {
      window.Dashboard.state.invested = inv;
      window.Dashboard.state.watchlist = watch;
      window.Dashboard.state.holdingsMeta = meta;
      window.Dashboard._persistHoldingsMeta?.();
      window.Dashboard._backfillHoldingsMeta?.();
    }
    try {
      localStorage.setItem('trading_invested', JSON.stringify(inv));
      localStorage.setItem('trading_watchlist', JSON.stringify(watch));
      localStorage.setItem('trading_holdings_meta', JSON.stringify(meta));
      localStorage.setItem(this.FOLLOWED_KEY, JSON.stringify(fol));
    } catch (e) { /* quota */ }
  },

  _unionIds(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const id = this._normId(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  },

  _unionMeta(...metas) {
    let merged = {};
    for (const meta of metas) {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      merged = this._mergeHoldingsMeta(merged, meta);
    }
    return merged;
  },

  _mergeFollowed(localList = [], cloudList = []) {
    const byId = new Map();
    const push = (row) => {
      if (!row || typeof row !== 'object' || !row.id) return;
      const prev = byId.get(row.id);
      if (!prev) {
        byId.set(row.id, row);
        return;
      }
      // Prefer closed rows; else newer enteredAt / exitedAt
      const prevClosed = prev.status && prev.status !== 'OPEN';
      const nextClosed = row.status && row.status !== 'OPEN';
      if (nextClosed && !prevClosed) {
        byId.set(row.id, row);
        return;
      }
      if (prevClosed && !nextClosed) return;
      const prevTs = Date.parse(prev.exitedAt || prev.enteredAt || '') || 0;
      const nextTs = Date.parse(row.exitedAt || row.enteredAt || '') || 0;
      if (nextTs >= prevTs) byId.set(row.id, row);
    };
    (Array.isArray(localList) ? localList : []).forEach(push);
    (Array.isArray(cloudList) ? cloudList : []).forEach(push);
    return [...byId.values()]
      .sort((a, b) => (Date.parse(b.enteredAt || '') || 0) - (Date.parse(a.enteredAt || '') || 0))
      .slice(0, 400);
  },

  _localFollowed() {
    return this._readLocalJson(this.FOLLOWED_KEY, []);
  },

  /** Table-first portfolio read. Returns null if table missing / RLS not set up yet. */
  async _readPortfolioTable(userId) {
    try {
      const { data, error } = await supabaseClient
        .from('user_portfolios')
        .select('invested, watchlist, holdings_meta, followed, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        // 42P01 / PGRST205 = relation missing — fall back to metadata quietly
        console.warn('☁️ Portfolio table unavailable, using metadata:', error.message);
        this._portfolioTableOk = false;
        return null;
      }
      this._portfolioTableOk = true;
      if (!data) return { invested: [], watchlist: [], holdings_meta: {}, followed: [], empty: true, updated_at: null };
      return {
        invested: Array.isArray(data.invested) ? data.invested : [],
        watchlist: Array.isArray(data.watchlist) ? data.watchlist : [],
        holdings_meta: data.holdings_meta && typeof data.holdings_meta === 'object' ? data.holdings_meta : {},
        followed: Array.isArray(data.followed) ? data.followed : [],
        updated_at: data.updated_at || null,
        empty: false,
      };
    } catch (e) {
      this._portfolioTableOk = false;
      console.warn('☁️ Portfolio table read failed:', e.message);
      return null;
    }
  },

  async _writePortfolioTable(userId, payload) {
    if (this._portfolioTableOk === false) return false;
    try {
      const { error } = await supabaseClient.from('user_portfolios').upsert({
        user_id: userId,
        invested: payload.invested,
        watchlist: payload.watchlist,
        holdings_meta: payload.holdingsMeta,
        followed: payload.followed,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) {
        console.warn('☁️ Portfolio table write failed:', error.message);
        this._portfolioTableOk = false;
        return false;
      }
      this._portfolioTableOk = true;
      return true;
    } catch (e) {
      console.warn('☁️ Portfolio table write exception:', e.message);
      this._portfolioTableOk = false;
      return false;
    }
  },

  async syncToCloud(invested, watchlist, holdingsMeta, { force = false, followed, skipRevTouch = false, internal = false } = {}) {
    if (!this.user) return false;
    // New / other device: wait until we have pulled account state once.
    if (!this._portfolioHydrated && !internal) {
      window.Dashboard && (window.Dashboard._pendingCloudSync = true);
      console.warn('☁️ Defer push until portfolio hydrated from account');
      return false;
    }

    try {
      if (force && !skipRevTouch) this.touchPortfolioRev();

      const localMeta = this._unionMeta(
        holdingsMeta,
        window.Dashboard?.state?.holdingsMeta,
        this._readLocalJson('trading_holdings_meta', {})
      );
      // IMPORTANT: [] is not nullish — never prefer empty state over localStorage.
      const localInvested = Array.isArray(invested)
        ? invested
        : this._unionIds(window.Dashboard?.state?.invested, this._readLocalJson('trading_invested', []));
      const localWatchlist = Array.isArray(watchlist)
        ? watchlist
        : this._unionIds(window.Dashboard?.state?.watchlist, this._readLocalJson('trading_watchlist', []));
      const localFollowed = Array.isArray(followed)
        ? followed
        : (window.Dashboard?._getFollowed?.() || this._localFollowed());

      const { data: userData, error: getErr } = await supabaseClient.auth.getUser();
      if (getErr) throw getErr;
      const userId = userData?.user?.id;
      if (!userId) return false;

      const tableRow = await this._readPortfolioTable(userId);
      const meta = userData?.user?.user_metadata || {};
      const cloudInvested = this._unionIds(
        tableRow?.invested,
        Array.isArray(meta.trading_invested) ? meta.trading_invested : []
      );
      const cloudMetaRaw = this._unionMeta(
        tableRow?.holdings_meta,
        meta.trading_holdings_meta
      );
      const cloudFollowed = this._mergeFollowed(
        [],
        Array.isArray(tableRow?.followed) ? tableRow.followed
          : (Array.isArray(meta.trading_followed) ? meta.trading_followed : [])
      );

      // Never wipe cloud holdings with an empty local push unless user explicitly unlocked (force)
      // AND we already hydrated from cloud this session.
      if (!force && localInvested.length === 0 && cloudInvested.length > 0) {
        console.warn('☁️ Skip empty holdings push (would wipe cloud). Waiting for merge/pull.');
        return false;
      }
      if (force && localInvested.length === 0 && cloudInvested.length > 0 && !this._portfolioHydrated) {
        console.warn('☁️ Skip empty force-push before hydrate');
        window.Dashboard && (window.Dashboard._pendingCloudSync = true);
        return false;
      }

      // On forced user edits, local lists are authoritative (allows unstar/unlock to propagate).
      // Meta: still keep richer lot details from cloud for coins you still hold.
      const mergedMeta = force
        ? this._mergeHoldingsMeta(localMeta, this._prunedMetaForInvested(cloudMetaRaw, localInvested))
        : this._mergeHoldingsMeta(localMeta, cloudMetaRaw);
      const prunedMeta = this._prunedMetaForInvested(mergedMeta, localInvested);
      const mergedFollowed = this._mergeFollowed(localFollowed, cloudFollowed);

      if (window.Dashboard?.state) {
        window.Dashboard.state.holdingsMeta = prunedMeta;
        window.Dashboard._persistHoldingsMeta?.();
      }
      try {
        localStorage.setItem(this.FOLLOWED_KEY, JSON.stringify(mergedFollowed));
      } catch (e) { /* quota */ }

      const payload = {
        invested: localInvested,
        watchlist: localWatchlist,
        holdingsMeta: prunedMeta,
        followed: mergedFollowed,
      };

      // Prefer durable table; keep metadata as secondary backup (size-limited).
      const tableOk = await this._writePortfolioTable(userId, payload);
      const { error } = await supabaseClient.auth.updateUser({
        data: {
          trading_invested: localInvested,
          trading_watchlist: localWatchlist,
          trading_holdings_meta: prunedMeta,
          trading_followed: mergedFollowed.slice(0, 80), // metadata size guard
        }
      });
      if (error && !tableOk) {
        console.error('Failed to sync to cloud:', error);
        window.Dashboard?._showToast?.('Cloud sync failed — saved locally only', 'warning');
        return false;
      }
      // Align local rev with server clock after successful write.
      if (force && !skipRevTouch) this.touchPortfolioRev(Date.now());
      this._lastSyncFromAt = Date.now();
      console.log('☁️ Synced portfolio', { tableOk, holdings: localInvested.length, watch: localWatchlist.length, followed: mergedFollowed.length });
      return true;
    } catch (err) {
      console.error('Failed to sync to cloud:', err);
      window.Dashboard?._showToast?.('Cloud sync failed — saved locally only', 'warning');
      return false;
    }
  },

  _metaQuality(entry) {
    if (!entry || typeof entry !== 'object') return -1;
    const lots = Array.isArray(entry.lots) ? entry.lots : null;
    if (lots && lots.length) {
      const real = lots.some(l => l.entryPrice > 0 && l.estimated !== true);
      const any = lots.some(l => l.entryPrice > 0);
      if (real) return 3;
      if (any) return 2;
      return 0;
    }
    const hasPrice = entry.entryPrice > 0;
    const estimated = entry.estimated === true;
    if (hasPrice && !estimated) return 3;
    if (hasPrice && estimated) return 2;
    if (hasPrice) return 1;
    return 0;
  },

  _pickBetterMeta(a, b) {
    const qa = this._metaQuality(a);
    const qb = this._metaQuality(b);
    if (qa !== qb) return qa > qb ? a : b;
    const aTs = Date.parse(a?.lockedAt || '') || Infinity;
    const bTs = Date.parse(b?.lockedAt || '') || Infinity;
    // Same quality: earliest real lock wins; for estimated rows prefer newer price stamp
    if (a?.estimated && b?.estimated) return aTs >= bTs ? a : b;
    return aTs <= bTs ? a : b;
  },

  _mergeHoldingsMeta(localMeta = {}, cloudMeta = {}) {
    const merged = { ...(localMeta && typeof localMeta === 'object' && !Array.isArray(localMeta) ? localMeta : {}) };
    if (!cloudMeta || typeof cloudMeta !== 'object' || Array.isArray(cloudMeta)) return merged;

    for (const [id, cloudEntry] of Object.entries(cloudMeta)) {
      if (!cloudEntry || typeof cloudEntry !== 'object') continue;
      const localEntry = merged[id];
      if (!localEntry) {
        merged[id] = cloudEntry;
        continue;
      }
      merged[id] = this._pickBetterMeta(localEntry, cloudEntry);
    }
    return merged;
  },

  async syncFromCloud({ silent = false } = {}) {
    if (!this.user) return false;
    // Coalesce parallel pulls (login + visibility).
    if (this._syncFromInFlight) return this._syncFromInFlight;

    this._syncFromInFlight = (async () => {
    try {
      const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
      if (userErr) throw userErr;
      if (!user) return false;

      const metadata = user.user_metadata || {};
      const tableRow = await this._readPortfolioTable(user.id);
      // Prefer durable table lists when present; metadata is backup only.
      const useTable = !!(tableRow && tableRow.empty === false);
      const cloudInvested = useTable
        ? this._unionIds(tableRow.invested)
        : this._unionIds(
            tableRow?.invested,
            Array.isArray(metadata.trading_invested) ? metadata.trading_invested : []
          );
      const cloudWatchlist = useTable
        ? this._unionIds(tableRow.watchlist)
        : this._unionIds(
            tableRow?.watchlist,
            Array.isArray(metadata.trading_watchlist) ? metadata.trading_watchlist : []
          );
      const cloudHoldingsMeta = useTable
        ? (tableRow.holdings_meta || {})
        : this._unionMeta(tableRow?.holdings_meta, metadata.trading_holdings_meta);
      const cloudFollowed = this._mergeFollowed(
        [],
        Array.isArray(tableRow?.followed) ? tableRow.followed
          : (Array.isArray(metadata.trading_followed) ? metadata.trading_followed : [])
      );

      const localInvested = this._unionIds(
        window.Dashboard?.state?.invested,
        this._readLocalJson('trading_invested', [])
      );
      const localWatchlist = this._unionIds(
        window.Dashboard?.state?.watchlist,
        this._readLocalJson('trading_watchlist', [])
      );
      const localMeta = this._unionMeta(
        window.Dashboard?.state?.holdingsMeta,
        this._readLocalJson('trading_holdings_meta', {})
      );
      const localFollowed = window.Dashboard?._getFollowed?.() || this._localFollowed();

      const cloudTs = tableRow?.updated_at ? (Date.parse(tableRow.updated_at) || 0) : 0;
      const localTs = this.getPortfolioRev();
      const cloudEmpty = cloudInvested.length === 0 && cloudWatchlist.length === 0;
      const localEmpty = localInvested.length === 0 && localWatchlist.length === 0;
      const SKEW_MS = 750;

      // Last-write-wins, but never let a fresh/empty device clobber a non-empty account.
      let winner = 'cloud';
      if (localEmpty && !cloudEmpty) {
        winner = 'cloud';
      } else if (cloudEmpty && !localEmpty) {
        winner = 'local';
      } else if (cloudTs > localTs + SKEW_MS) {
        winner = 'cloud';
      } else if (localTs > cloudTs + SKEW_MS) {
        winner = 'local';
      } else if (useTable) {
        winner = 'cloud';
      } else {
        winner = localEmpty ? 'cloud' : 'local';
      }

      let nextInvested;
      let nextWatchlist;
      let nextMeta;
      let nextFollowed = this._mergeFollowed(localFollowed, cloudFollowed);
      let pushed = false;
      let ok = true;

      if (winner === 'cloud') {
        nextInvested = cloudInvested;
        nextWatchlist = cloudWatchlist;
        nextMeta = this._prunedMetaForInvested(
          this._mergeHoldingsMeta(cloudHoldingsMeta, {}),
          nextInvested
        );
        this._applyPortfolioLocal(nextInvested, nextWatchlist, nextMeta, nextFollowed);
        if (cloudTs) this.touchPortfolioRev(cloudTs);
        // Mirror authoritative cloud → metadata backup when table is source
        if (useTable) {
          ok = await this.syncToCloud(nextInvested, nextWatchlist, nextMeta, {
            force: true,
            followed: nextFollowed,
            skipRevTouch: true,
            internal: true,
          });
          pushed = true;
        }
      } else {
        nextInvested = localInvested;
        nextWatchlist = localWatchlist;
        nextMeta = this._prunedMetaForInvested(localMeta, nextInvested);
        this._applyPortfolioLocal(nextInvested, nextWatchlist, nextMeta, nextFollowed);
        if (!localTs) this.touchPortfolioRev();
        ok = await this.syncToCloud(nextInvested, nextWatchlist, nextMeta, {
          force: true,
          followed: nextFollowed,
          internal: true,
        });
        pushed = true;
      }

      this._lastSyncFromAt = Date.now();
      this._portfolioHydrated = true;
      if (window.Dashboard?._pendingCloudSync) {
        window.Dashboard._pendingCloudSync = false;
        // Flush edits that happened while we were still pulling.
        try { window.Dashboard._syncPortfolioCloud?.(); } catch (_) {}
      }

      if (!silent) {
        const via = this._portfolioTableOk ? 'table' : 'metadata';
        const msg = nextInvested.length === 0 && nextWatchlist.length === 0
          ? 'Synced — Watch & Holdings empty on account'
          : !ok
            ? `Sync issue — local Watch/Holdings kept (${nextInvested.length} locked)`
            : winner === 'cloud'
              ? `Synced from account (${nextWatchlist.length} watch · ${nextInvested.length} holdings)`
              : `Saved to account (${nextWatchlist.length} watch · ${nextInvested.length} holdings · ${via})`;
        window.Dashboard?._showToast?.(msg, ok ? 'success' : 'warning');
      }
      console.log('☁️ Sync complete', { winner, cloudTs, localTs, nextInvested, nextWatchlist, ok, pushed });

      if (window.Dashboard?._render) {
        window.Dashboard._render();
      } else if (window.Dashboard?.state?.allAssets?.length) {
        window.Dashboard.loadAll(true);
      }
      return ok;
    } catch (err) {
      console.error('Failed to pull from cloud:', err);
      // Allow local pushes if pull fails so the user isn't stuck offline forever.
      this._portfolioHydrated = true;
      if (!silent) {
        window.Dashboard?._showToast?.('Holdings sync failed — try Sign Out / Sign In again', 'warning');
      }
      return false;
    } finally {
      this._syncFromInFlight = null;
    }
    })();

    return this._syncFromInFlight;
  },

  /** Soft pull when returning to the app (other device may have changed stars/locks). */
  async pullIfStale(maxAgeMs = 8000) {
    if (!this.user) return false;
    if (Date.now() - (this._lastSyncFromAt || 0) < maxAgeMs) return false;
    return this.syncFromCloud({ silent: true });
  },
};

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
