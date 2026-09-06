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

  async syncToCloud(invested, watchlist) {
    if (!this.user) return; 

    try {
      await supabaseClient.auth.updateUser({
        data: {
          trading_invested: invested,
          trading_watchlist: watchlist
        }
      });
      console.log('☁️ Successfully synced locked coins to Supabase Cloud');
    } catch (err) {
      console.error('Failed to sync to cloud:', err);
    }
  },

  async syncFromCloud() {
    if (!this.user) return;

    try {
      const metadata = this.user.user_metadata || {};
      let cloudInvested = metadata.trading_invested;
      let cloudWatchlist = metadata.trading_watchlist;
      let changed = false;

      if (Array.isArray(cloudInvested) && window.Dashboard) {
        const currentInvested = window.Dashboard.state.invested || [];
        const mergedInvested = [...new Set([...currentInvested, ...cloudInvested])];
        if (mergedInvested.length > currentInvested.length) {
          window.Dashboard.state.invested = mergedInvested;
          localStorage.setItem('trading_invested', JSON.stringify(mergedInvested));
          changed = true;
        }
      }

      if (Array.isArray(cloudWatchlist) && window.Dashboard) {
        const currentWatchlist = window.Dashboard.state.watchlist || [];
        const mergedWatchlist = [...new Set([...currentWatchlist, ...cloudWatchlist])];
        if (mergedWatchlist.length > currentWatchlist.length) {
          window.Dashboard.state.watchlist = mergedWatchlist;
          localStorage.setItem('trading_watchlist', JSON.stringify(mergedWatchlist));
          changed = true;
        }
      }

      if (changed && window.Dashboard) {
        window.Dashboard.loadAll(true);
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
