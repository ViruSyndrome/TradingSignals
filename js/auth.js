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
        await supabaseClient.auth.signInWithOAuth({ provider: 'google'});
      });
    }

    if (githubBtn) {
      githubBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signInWithOAuth({ provider: 'github'});
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

  async syncToCloud(invested, watchlist, holdingsMeta) {
    if (!this.user) return;

    try {
      const localMeta = holdingsMeta ?? window.Dashboard?.state?.holdingsMeta ?? {};
      const localInvested = Array.isArray(invested) ? invested : [];
      const localWatchlist = Array.isArray(watchlist) ? watchlist : [];

      // Fetch cloud meta so we can merge cost-basis without clobbering the other device.
      // Membership (invested/watchlist) stays local-wins so unlocks actually remove coins.
      const { data: userData, error: getErr } = await supabaseClient.auth.getUser();
      if (getErr) throw getErr;
      const cloudMetaRaw = userData?.user?.user_metadata?.trading_holdings_meta;

      const mergedMeta = this._mergeHoldingsMeta(localMeta, cloudMetaRaw);
      const prunedMeta = {};
      for (const id of localInvested) {
        const base = String(id).toUpperCase().replace('_4H', '').replace('_5M', '');
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
        return;
      }
      console.log('☁️ Successfully synced locked coins to Supabase Cloud');
    } catch (err) {
      console.error('Failed to sync to cloud:', err);
      window.Dashboard?._showToast?.('Cloud sync failed — saved locally only', 'warning');
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

  async syncFromCloud(retryCount = 0) {
    if (!this.user) return;

    // Race condition guard: Dashboard may still be loading on fresh page open.
    // Retry up to 5 times (every 1.5s) until data is actually loaded.
    if (!window.Dashboard || !window.Dashboard.state || !window.Dashboard.state.allAssets?.length) {
      if (retryCount < 5) {
        setTimeout(() => this.syncFromCloud(retryCount + 1), 1500);
      }
      return;
    }

    try {
      // Always fetch fresh metadata from Supabase (not stale cached user object)
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;

      const metadata = user.user_metadata || {};
      const cloudInvested = Array.isArray(metadata.trading_invested) ? metadata.trading_invested : [];
      const cloudWatchlist = Array.isArray(metadata.trading_watchlist) ? metadata.trading_watchlist : [];
      const cloudHoldingsMeta = metadata.trading_holdings_meta && typeof metadata.trading_holdings_meta === 'object'
        ? metadata.trading_holdings_meta
        : {};

      let changed = false;

      if (cloudInvested.length > 0) {
        const currentInvested = window.Dashboard.state.invested || [];
        const mergedInvested = [...new Set([...currentInvested, ...cloudInvested])];
        // Always apply — even if same length, ensures cloud data is in localStorage
        window.Dashboard.state.invested = mergedInvested;
        localStorage.setItem('trading_invested', JSON.stringify(mergedInvested));
        changed = true;
      }

      if (cloudWatchlist.length > 0) {
        const currentWatchlist = window.Dashboard.state.watchlist || [];
        const mergedWatchlist = [...new Set([...currentWatchlist, ...cloudWatchlist])];
        window.Dashboard.state.watchlist = mergedWatchlist;
        localStorage.setItem('trading_watchlist', JSON.stringify(mergedWatchlist));
        changed = true;
      }

      const mergedMeta = this._mergeHoldingsMeta(window.Dashboard.state.holdingsMeta, cloudHoldingsMeta);
      const metaChanged = JSON.stringify(mergedMeta) !== JSON.stringify(window.Dashboard.state.holdingsMeta || {});
      if (metaChanged || Object.keys(cloudHoldingsMeta).length > 0) {
        window.Dashboard.state.holdingsMeta = mergedMeta;
        window.Dashboard._persistHoldingsMeta?.();
        changed = true;
      }

      window.Dashboard._backfillHoldingsMeta?.();

      const finalInvested = window.Dashboard.state.invested || [];
      const finalWatchlist = window.Dashboard.state.watchlist || [];
      const finalMeta = window.Dashboard.state.holdingsMeta || {};

      // Login used to pull-only, so local-only locks never reached other devices.
      // After merge, push so this device's holdings/watchlist become the cloud union.
      const norm = (id) => String(id).toUpperCase().replace('_4H', '').replace('_5M', '');
      const cloudInvSet = new Set(cloudInvested.map(norm));
      const cloudWlSet = new Set(cloudWatchlist.map(norm));
      const uploadedLocalOnly =
        finalInvested.some((id) => !cloudInvSet.has(norm(id))) ||
        finalWatchlist.some((id) => !cloudWlSet.has(norm(id)));

      if (finalInvested.length || finalWatchlist.length || cloudInvested.length || cloudWatchlist.length) {
        await this.syncToCloud(finalInvested, finalWatchlist, finalMeta);
      }

      if (changed) {
        console.log('☁️ Cloud sync applied. Holdings:', finalInvested);
        window.Dashboard._showToast(
          uploadedLocalOnly
            ? `☁️ Holdings merged & saved to your account (${finalInvested.length} coins)`
            : `☁️ Holdings synced from cloud (${finalInvested.length} coins)`,
          'success'
        );
        window.Dashboard.loadAll(true);
      } else if (uploadedLocalOnly) {
        console.log('☁️ Uploaded local holdings to cloud:', finalInvested);
        window.Dashboard._showToast(
          `☁️ Saved this device's holdings to your account (${finalInvested.length} coins)`,
          'success'
        );
      }
    } catch (err) {
      console.error('Failed to pull from cloud:', err);
    }
  }
};

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
