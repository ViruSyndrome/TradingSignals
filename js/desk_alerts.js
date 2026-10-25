'use strict';

/**
 * Red Bar Desk — local OS / PWA notifications for ENTER only.
 * Server email / ntfy cover the case when the tab is fully closed.
 */
const DeskAlerts = {
  STORAGE_KEY: 'trendrunner_rb_alerts',
  SENT_KEY: 'trendrunner_rb_alert_sent',
  TTL_MS: 4 * 60 * 60 * 1000, // 4h per setup key

  enabled() {
    try {
      const v = localStorage.getItem(this.STORAGE_KEY);
      if (v == null) return true; // default on once permission granted
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
      const p = await Notification.requestPermission();
      return p;
    } catch (_) {
      return Notification.permission;
    }
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

  /** Red Bar ENTER setups only — ignore anything else. */
  ACTIONABLE: ['trade1_departure', 'trade2_confirmed', 'session_sweep'],

  _botBaseUrl() {
    try {
      const ls = localStorage.getItem('trade_bot_url');
      if (ls) return String(ls).replace(/\/$/, '');
    } catch (_) {}
    if (typeof CONFIG !== 'undefined') {
      const u = CONFIG.alerts?.botBaseUrl || CONFIG.trade?.botBaseUrl || CONFIG.market?.proxyBaseUrl || '';
      if (u) return String(u).replace(/\/$/, '');
    }
    return '';
  },

  /** Push ENTER to Render so Telegram matches the desk (not WhatsApp — we only support Telegram). */
  async relayTelegram(payload) {
    const base = this._botBaseUrl();
    if (!base) {
      console.warn('[DeskAlerts] No bot URL — set Settings → Bot URL (your Render https://….onrender.com) for Telegram relay');
      return false;
    }
    const headers = { 'Content-Type': 'application/json' };
    try {
      const secret = localStorage.getItem('trade_api_secret') || '';
      if (secret) headers['X-TrendRunner-Alert-Secret'] = secret;
    } catch (_) {}
    try {
      const res = await fetch(`${base}/api/alerts/redbar`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn('[DeskAlerts] Telegram relay failed:', res.status, data.error || '');
        return false;
      }
      if (data.deduped) console.info('[DeskAlerts] Telegram already sent for this setup');
      else console.info('[DeskAlerts] Telegram relay OK');
      return true;
    } catch (e) {
      console.warn('[DeskAlerts] Telegram relay error:', e.message || e);
      return false;
    }
  },

  /**
   * Fire once per instrument+side+setup+day when action flips to ENTER.
   * PWA banner (if permitted) + Telegram relay to Render.
   */
  async maybeNotifyEnter(payload) {
    if (!this.enabled()) return false;
    if (!payload || (payload.side !== 'LONG' && payload.side !== 'SHORT')) return false;
    const kind = payload.setupKind || '';
    const ok = (typeof RedBarTrend !== 'undefined' && Array.isArray(RedBarTrend.ACTIONABLE_SETUPS))
      ? RedBarTrend.ACTIONABLE_SETUPS.includes(kind)
      : this.ACTIONABLE.includes(kind);
    if (!ok) return false;

    const key = `RB_${payload.instrumentId}|${payload.side}|${payload.setupKind}|${payload.dayKey || ''}`;
    let map = this._prune(this._sentMap());
    if (map[key]) return false;

    // Mark first so parallel refresh cannot double-fire
    map[key] = Date.now();
    this._saveSent(map);

    const title = `${payload.side} · ${payload.label || payload.symbol}`;
    const body = [
      payload.title || payload.setupKind,
      payload.price != null ? `Entry ~ ${payload.price}` : null,
      payload.stop != null ? `Stop ${payload.stop}` : null,
    ].filter(Boolean).join(' · ');

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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
      } catch (e) {
        console.warn('[DeskAlerts] PWA notify failed', e);
      }
    }

    // Always attempt Telegram when desk sees ENTER (even if PWA permission denied)
    await this.relayTelegram(payload);
    return true;
  },

  /** Clear dedupe when desk leaves ENTER so a fresh setup can alert again. */
  clearInstrument(instrumentId) {
    if (!instrumentId) return;
    const prefix = `RB_${instrumentId}|`;
    const map = this._sentMap();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (k.startsWith(prefix)) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) this._saveSent(map);
  },
};

if (typeof window !== 'undefined') window.DeskAlerts = DeskAlerts;
if (typeof module !== 'undefined' && module.exports) module.exports = DeskAlerts;
