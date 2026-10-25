'use strict';

require('dotenv').config();
const { fork } = require('child_process');
const express = require('express');

const app = express();
app.use(express.json({ limit: '16kb' }));

const ALLOWED_ORIGINS = new Set([
  'https://trendrunner.app',
  'https://www.trendrunner.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'null',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || !origin) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TrendRunner-Alert-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.type('text').send('TrendRunner bot is running.'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', alerts: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) }));

const ACTIONABLE = new Set(['trade1_departure', 'trade2_confirmed', 'session_sweep']);
const recentRelay = new Map(); // alertKey -> ts
const RELAY_TTL_MS = 4 * 60 * 60 * 1000;

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Desk → Telegram relay. Fires when the open PWA sees ENTER so brief Trade 1/2
 * windows are not missed by the 1–2m worker scan.
 * POST /api/alerts/redbar
 */
app.post('/api/alerts/redbar', async (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return res.status(503).json({ ok: false, error: 'Telegram not configured on Render' });
  }

  // Only ALERT_RELAY_SECRET gates this route — do NOT reuse TRADE_API_SECRET
  // (that blocked Telegram when the desk had no trade secret saved).
  const secret = (process.env.ALERT_RELAY_SECRET || '').trim();
  if (secret) {
    const got = req.headers['x-trendrunner-alert-secret'] || req.body?.secret || '';
    if (got !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const body = req.body || {};
  const side = String(body.side || '').toUpperCase();
  const setupKind = String(body.setupKind || '');
  const instrumentId = String(body.instrumentId || body.label || 'BTC');
  const dayKey = String(body.dayKey || '');
  if (side !== 'LONG' && side !== 'SHORT') {
    return res.status(400).json({ ok: false, error: 'side must be LONG or SHORT' });
  }
  if (!ACTIONABLE.has(setupKind)) {
    return res.status(400).json({ ok: false, error: 'setupKind not Red Bar actionable' });
  }

  const alertKey = `RB_${instrumentId}|${side}|${setupKind}|${dayKey}`;
  const now = Date.now();
  for (const [k, t] of recentRelay) {
    if (now - t > RELAY_TTL_MS) recentRelay.delete(k);
  }
  if (recentRelay.has(alertKey)) {
    return res.json({ ok: true, deduped: true });
  }

  const label = body.label || instrumentId;
  const emoji = side === 'LONG' ? '🟢' : '🔴';
  const title = body.title || setupKind;
  const price = body.price != null ? body.price : '—';
  const stop = body.stop != null ? body.stop : '—';
  const tp1 = body.tp1 != null ? body.tp1 : '—';
  const deskUrl = (process.env.DESK_URL || 'https://trendrunner.app').replace(/\/$/, '');
  const text =
    `${emoji} <b>Red Bar ${escHtml(label)} ${side}</b> · ${escHtml(title)} (${escHtml(setupKind)})\n` +
    `Entry <b>$${escHtml(price)}</b> · Stop <b>$${escHtml(stop)}</b> · 1:1 <b>$${escHtml(tp1)}</b>\n` +
    `<a href="${deskUrl}">Desk</a>`;

  try {
    const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const tgJson = await tg.json().catch(() => ({}));
    if (!tg.ok || tgJson.ok === false) {
      console.error('[AlertRelay] Telegram failed:', tg.status, JSON.stringify(tgJson).slice(0, 200));
      return res.status(502).json({ ok: false, error: 'Telegram send failed' });
    }
    recentRelay.set(alertKey, now);
    console.log(`[AlertRelay] Telegram sent ${alertKey}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[AlertRelay] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Health + alert relay listening on port ${port}`);
  startWorker();
  const publicUrl = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').replace(/\/$/, '');
  if (publicUrl) {
    const everyMs = Number(process.env.KEEP_ALIVE_MS) || 4 * 60 * 1000;
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, everyMs);
    console.log(`[KeepAlive] Self-ping ${publicUrl}/health every ${everyMs / 1000}s`);
  } else {
    console.warn('[KeepAlive] Set RENDER_EXTERNAL_URL so free Render stays awake (plus GitHub RENDER_HEALTH_URL secret).');
  }
});

function startWorker() {
  const worker = fork('./bot.js', [], {
    env: { ...process.env, BOT_WORKER_ONLY: 'true' },
  });

  worker.on('exit', (code, signal) => {
    console.error(`[Worker] Scanner exited (code: ${code}, signal: ${signal || 'none'}). Restarting in 60 seconds.`);
    setTimeout(startWorker, 60_000);
  });

  worker.on('error', error => {
    console.error(`[Worker] Scanner failed to start: ${error.message}`);
  });
}
