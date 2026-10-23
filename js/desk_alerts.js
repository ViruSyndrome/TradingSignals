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

  /**
   * Fire once per instrument+side+setup+day when action flips to ENTER.
   * @param {{ instrumentId: string, label: string, symbol: string, side: string, setupKind: string, title: string, price: number|string, stop: number|string, dayKey: string }} payload
   */
  async maybeNotifyEnter(payload) {
    if (!this.enabled()) return false;
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission !== 'granted') return false;
    if (!payload || (payload.side !== 'LONG' && payload.side !== 'SHORT')) return false;

    const key = `RB_${payload.instrumentId}|${payload.side}|${payload.setupKind}|${payload.dayKey || ''}`;
    let map = this._prune(this._sentMap());
    if (map[key]) return false;

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
    } catch (e) {
      console.warn('[DeskAlerts] notify failed', e);
      return false;
    }

    map[key] = Date.now();
    this._saveSent(map);
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
