'use strict';

/**
 * Red Bar Desk — PWA banner + Telegram relay on ENTER.
 * PWA and Telegram use separate dedupe keys so a desktop-only ping can still
 * retry Telegram on the next refresh.
 */
const DeskAlerts = {
  STORAGE_KEY: 'trendrunner_rb_alerts',
  SENT_KEY: 'trendrunner_rb_alert_sent',
  TTL_MS: 4 * 60 * 60 * 1000,

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
      const u = CONFIG.alerts?.botBaseUrl || CONFIG.trade?.botBaseUrl || CONFIG.market?.proxyBaseUrl || '';
      if (u) return String(u).replace(/\/$/, '');
    }
    return '';
  },

  async relayTelegram(payload) {
    const base = this._botBaseUrl();
    if (!base) {
      console.warn('[DeskAlerts] No bot URL for Telegram relay');
      return false;
    }
    try {
      const res = await fetch(`${base}/api/alerts/redbar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn('[DeskAlerts] Telegram relay failed:', res.status, data.error || '');
        return false;
      }
      console.info(data.deduped ? '[DeskAlerts] Telegram deduped' : '[DeskAlerts] Telegram relay OK');
      return true;
    } catch (e) {
      console.warn('[DeskAlerts] Telegram relay error:', e.message || e);
      return false;
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
      }
    } else if (!pwaDone) {
      // No PWA permission — still mark so we don't loop; Telegram can proceed
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
