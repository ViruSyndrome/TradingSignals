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
        if (this.user) {
          this.logout();
        } else {
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
        await supabaseClient.auth.signInWithOAuth({ provider: 'google' });
      });
    }

    if (githubBtn) {
      githubBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signInWithOAuth({ provider: 'github' });
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
    const authBtnText = document.getElementById('authBtnText');
    const authBtn = document.getElementById('authBtn');
    if (!authBtnText || !authBtn) return;

    if (this.user) {
      authBtnText.textContent = 'Sign Out';
      authBtn.style.background = 'rgba(231, 76, 60, 0.1)';
      authBtn.style.borderColor = 'rgba(231, 76, 60, 0.5)';
      authBtn.style.color = '#e74c3c';
    } else {
      authBtnText.textContent = 'Sign In / Register';
      authBtn.style.background = 'rgba(0, 242, 254, 0.1)';
      authBtn.style.borderColor = 'var(--accent)';
      authBtn.style.color = 'var(--text-main)';
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
