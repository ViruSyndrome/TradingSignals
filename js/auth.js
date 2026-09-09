const SUPABASE_URL = 'https://ogoljnujatnlttrpjpxr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_G2op6O8Ia-f6f27PRCE9YA_ZwtRUi5U'; 

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const Auth = {
  user: null,
  isLoginMode: true,

  async init() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    this.user = session?.user || null;
    this._updateUI();
    if (this.user) { this.syncFromCloud(); }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      this._updateUI();
      if (event === 'SIGNED_IN') {
        this.syncFromCloud();
      }
    });

    this._bindEvents();
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
        if (this.user) { if (confirm('Are you sure you want to sign out?')) { this.logout(); } } else {
          authModal.classList.add('open');
          this.isLoginMode = true;
          this._renderModalState();
        }
      });
    }

    if (closeBtn) closeBtn.addEventListener('click', () => { authModal.classList.remove('open'); });

    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.isLoginMode = !this.isLoginMode;
        this._renderModalState();
      });
    }

    if (submitBtn) submitBtn.addEventListener('click', () => this.handleAuthSubmit());
    const googleBtn = document.getElementById('authGoogleBtn');
    const githubBtn = document.getElementById('authGithubBtn');

    if (googleBtn) {
      googleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + (window.location.pathname || '/') } });
      });
    }

    if (githubBtn) {
      githubBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.origin + (window.location.pathname || '/') } });
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
      
      setTimeout(() => {
        document.getElementById('authModal').style.display = 'none';
      }, 1500);

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

  async syncToCloud(invested, watchlist, holdingsMeta, { force = false } = {}) {
    if (!this.user) return false;

    try {
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

      const { data: userData, error: getErr } = await supabaseClient.auth.getUser();
      if (getErr) throw getErr;
      const cloudMetaRaw = userData?.user?.user_metadata?.trading_holdings_meta;
      const cloudInvested = Array.isArray(userData?.user?.user_metadata?.trading_invested)
        ? userData.user.user_metadata.trading_invested
        : [];

      // Never wipe cloud holdings with an empty local push unless user explicitly unlocked (force).
      if (!force && localInvested.length === 0 && cloudInvested.length > 0) {
        console.warn('☁️ Skip empty holdings push (would wipe cloud). Waiting for merge/pull.');
        return false;
      }

      const mergedMeta = this._mergeHoldingsMeta(localMeta, cloudMetaRaw);
      const prunedMeta = {};
      for (const id of localInvested) {
        const base = this._normId(id);
        if (mergedMeta[base]) prunedMeta[base] = mergedMeta[base];
      }

      if (window.Dashboard?.state) {
        window.Dashboard.state.holdingsMeta = prunedMeta;
        window.Dashboard._persistHoldingsMeta?.();
      }

      const { error } = await supabaseClient.auth.updateUser({
        data: {
          trading_invested: localInvested,
          trading_watchlist: localWatchlist,
          trading_holdings_meta: prunedMeta
        }
      });
      if (error) {
        console.error('Failed to sync to cloud:', error);
        window.Dashboard?._showToast?.('Cloud sync failed — saved locally only', 'warning');
        return false;
      }
      console.log('☁️ Successfully synced locked coins to Supabase Cloud', localInvested);
      return true;
    } catch (err) {
      console.error('Failed to sync to cloud:', err);
      window.Dashboard?._showToast?.('Cloud sync failed — saved locally only', 'warning');
      return false;
    }
  },

  _metaQuality(entry) {
    if (!entry || typeof entry !== 'object') return -1;
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

  async syncFromCloud() {
    if (!this.user) return;

    try {
      // Do NOT wait for market assets — holdings live in localStorage and must sync on login.
      const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
      if (userErr) throw userErr;
      if (!user) return;

      const metadata = user.user_metadata || {};
      const cloudInvested = Array.isArray(metadata.trading_invested) ? metadata.trading_invested : [];
      const cloudWatchlist = Array.isArray(metadata.trading_watchlist) ? metadata.trading_watchlist : [];
      const cloudHoldingsMeta = metadata.trading_holdings_meta && typeof metadata.trading_holdings_meta === 'object'
        ? metadata.trading_holdings_meta
        : {};

      // Union Dashboard state + localStorage + cloud. Empty [] must not hide LS data.
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

      const mergedInvested = this._unionIds(localInvested, cloudInvested);
      const mergedWatchlist = this._unionIds(localWatchlist, cloudWatchlist);
      const mergedMeta = this._mergeHoldingsMeta(localMeta, cloudHoldingsMeta);

      if (window.Dashboard?.state) {
        window.Dashboard.state.invested = mergedInvested;
        window.Dashboard.state.watchlist = mergedWatchlist;
        window.Dashboard.state.holdingsMeta = mergedMeta;
        window.Dashboard._persistHoldingsMeta?.();
        window.Dashboard._backfillHoldingsMeta?.();
      }
      localStorage.setItem('trading_invested', JSON.stringify(mergedInvested));
      localStorage.setItem('trading_watchlist', JSON.stringify(mergedWatchlist));
      try { localStorage.setItem('trading_holdings_meta', JSON.stringify(mergedMeta)); } catch (e) { /* quota */ }

      const cloudInvSet = new Set(cloudInvested.map((id) => this._normId(id)));
      const uploadedLocalOnly = mergedInvested.some((id) => !cloudInvSet.has(this._normId(id)));

      let ok = true;
      if (mergedInvested.length > 0 || mergedWatchlist.length > 0 || cloudInvested.length === 0) {
        // force only when we are not wiping non-empty cloud with empty local
        const force = mergedInvested.length > 0 || cloudInvested.length === 0;
        ok = await this.syncToCloud(mergedInvested, mergedWatchlist, mergedMeta, { force });
      }

      const msg = mergedInvested.length === 0 && cloudInvested.length === 0
        ? 'No locked holdings to sync yet — lock a coin while signed in'
        : !ok
          ? `Holdings on this device: ${mergedInvested.length} — cloud save failed`
          : uploadedLocalOnly
            ? `Holdings saved to your account (${mergedInvested.length} coins)`
            : `Holdings synced (${mergedInvested.length} coins)`;
      // Toast even if Dashboard.init has not finished — write directly to container
      const container = document.getElementById('toastContainer');
      if (container) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${ok || mergedInvested.length === 0 ? 'success' : 'warning'}`;
        toast.textContent = msg;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 4500);
      } else {
        window.Dashboard?._showToast?.(msg, ok ? 'success' : 'warning');
      }
      console.log('☁️ Sync complete', { mergedInvested, uploadedLocalOnly, ok });

      if (window.Dashboard?.state?.allAssets?.length) {
        window.Dashboard.loadAll(true);
      } else {
        // Re-render when market data arrives
        let tries = 0;
        const wait = setInterval(() => {
          tries += 1;
          if (window.Dashboard?.state?.allAssets?.length) {
            clearInterval(wait);
            window.Dashboard.loadAll(true);
          } else if (tries >= 30) {
            clearInterval(wait);
          }
        }, 1000);
      }
    } catch (err) {
      console.error('Failed to pull from cloud:', err);
      window.Dashboard?._showToast?.('Holdings sync failed — try Sign Out / Sign In again', 'warning');
    }
  }
};

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
