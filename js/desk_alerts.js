'use strict';

/**
 * Red Bar Desk — PWA banner + Telegram relay on ENTER.
 * PWA / Telegram use separate dedupe keys.
 */
const DeskAlerts = {
  STORAGE_KEY: 'trendrunner_rb_alerts',
  SENT_KEY: 'trendrunner_rb_alert_sent',
  TTL_MS: 4 * 60 * 60 * 1000,
  // Hardcoded so Telegram works even if Settings / config cache is wrong
  DEFAULT_BOT_URL: 'https://tradingsignals-bjya.onrender.com',

  enabled() {
    try {
      const v = localStorage.getItem(this.STORAGE_KEY);
      if (v == null) return true;
      return v === '1' || v === 'true';
    } catch (_) {
      return false;
    }
  },

  setEnabled(on) {
    try { localStorage.setItem(this.STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
  },

  permission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  },

  async requestPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    try {
      return await Notification.requestPermission();
    } catch (_) {
      return Notification.permission;
    }
  },

  /** Call once on desk boot — writes Bot URL into localStorage so Settings is not required. */
  ensureBotUrl() {
    const url = this._botBaseUrl();
    if (!url) return '';
    try {
      const cur = localStorage.getItem('trade_bot_url');
      if (!cur || !String(cur).trim()) {
        localStorage.setItem('trade_bot_url', url);
      }
    } catch (_) {}
    return url;
  },

  _sentMap() {
    try {
      const raw = localStorage.getItem(this.SENT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  },

  _saveSent(map) {
    try { localStorage.setItem(this.SENT_KEY, JSON.stringify(map)); } catch (_) {}
  },

  _prune(map) {
    const now = Date.now();
    const out = {};
    for (const [k, t] of Object.entries(map || {})) {
      if (now - Number(t) < this.TTL_MS) out[k] = t;
    }
    return out;
  },

  ACTIONABLE: ['trade1_departure', 'trade2_confirmed', 'session_sweep'],

  _botBaseUrl() {
    try {
      const ls = localStorage.getItem('trade_bot_url');
      if (ls && String(ls).trim()) return String(ls).trim().replace(/\/$/, '');
    } catch (_) {}
    if (typeof CONFIG !== 'undefined') {
      const u = CONFIG.alerts?.botBaseUrl || CONFIG.trade?.botBaseUrl || '';
      if (u && String(u).trim()) return String(u).trim().replace(/\/$/, '');
    }
    return this.DEFAULT_BOT_URL;
  },

  _toast(msg, type) {
    try {
      if (typeof Dashboard !== 'undefined' && Dashboard._showToast) {
        Dashboard._showToast(msg, type || 'info');
      }
    } catch (_) {}
  },

  async relayTelegram(payload) {
    const base = this._botBaseUrl();
    if (!base) {
      this._toast('Telegram: no Bot URL', 'warning');
      return false;
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 45000) : null; // Render cold start
    try {
      const res = await fetch(`${base}/api/alerts/redbar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        signal: ctrl?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn('[DeskAlerts] Telegram relay failed:', res.status, data.error || '');
        this._toast(`Telegram failed (${res.status})`, 'warning');
        return false;
      }
      if (data.deduped) {
        console.info('[DeskAlerts] Telegram already delivered for this setup');
      } else {
        console.info('[DeskAlerts] Telegram relay OK');
        this._toast('Telegram ENTER sent', 'success');
      }
      return true;
    } catch (e) {
      console.warn('[DeskAlerts] Telegram relay error:', e.message || e);
      this._toast('Telegram unreachable — Render may be waking', 'warning');
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async maybeNotifyEnter(payload) {
    if (!this.enabled()) return false;
    if (!payload || (payload.side !== 'LONG' && payload.side !== 'SHORT')) return false;
    const kind = payload.setupKind || '';
    const ok = (typeof RedBarTrend !== 'undefined' && Array.isArray(RedBarTrend.ACTIONABLE_SETUPS))
      ? RedBarTrend.ACTIONABLE_SETUPS.includes(kind)
      : this.ACTIONABLE.includes(kind);
    if (!ok) return false;

    this.ensureBotUrl();

    const baseKey = `RB_${payload.instrumentId}|${payload.side}|${payload.setupKind}|${payload.dayKey || ''}`;
    const pwaKey = baseKey;
    const tgKey = `TG_${baseKey}`;
    let map = this._prune(this._sentMap());
    const pwaDone = Boolean(map[pwaKey]);
    const tgDone = Boolean(map[tgKey]);
    if (pwaDone && tgDone) return false;

    if (!pwaDone && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const title = `${payload.side} · ${payload.label || payload.symbol}`;
      const body = [
        payload.title || payload.setupKind,
        payload.price != null ? `Entry ~ ${payload.price}` : null,
        payload.stop != null ? `Stop ${payload.stop}` : null,
      ].filter(Boolean).join(' · ');
      const opts = {
        body,
        icon: new URL('icon-192.png', window.location.href).href,
        badge: new URL('icon-192.png', window.location.href).href,
        tag: `trendrunner-rb-${payload.instrumentId}-${payload.side}`,
        renotify: true,
        requireInteraction: true,
        data: { section: 'dashboardSection', instrumentId: payload.instrumentId },
      };
      try {
        if (navigator.serviceWorker?.ready) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, opts);
        } else {
          const n = new Notification(title, opts);
          n.onclick = () => {
            try { window.focus(); } catch (_) {}
            n.close();
          };
        }
        map[pwaKey] = Date.now();
        this._saveSent(map);
      } catch (e) {
        console.warn('[DeskAlerts] PWA notify failed', e);
        map[pwaKey] = Date.now();
        this._saveSent(map);
      }
    } else if (!pwaDone) {
      map[pwaKey] = Date.now();
      this._saveSent(map);
    }

    if (!tgDone) {
      const sent = await this.relayTelegram(payload);
      if (sent) {
        map = this._prune(this._sentMap());
        map[tgKey] = Date.now();
        this._saveSent(map);
      }
      // If send failed (cold start), leave tgKey unset so next refresh retries
    }
    return true;
  },

  clearInstrument(instrumentId) {
    if (!instrumentId) return;
    const prefixes = [`RB_${instrumentId}|`, `TG_RB_${instrumentId}|`];
    const map = this._sentMap();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (prefixes.some((p) => k.startsWith(p))) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) this._saveSent(map);
  },
};

if (typeof window !== 'undefined') window.DeskAlerts = DeskAlerts;
if (typeof module !== 'undefined' && module.exports) module.exports = DeskAlerts;
