'use strict';

const { fork } = require('child_process');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.type('text').send('TrendRunner bot is running.'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Health server listening on port ${port}`);
  startWorker();
  // Self-ping only helps while the process is already awake.
  // Free Render still sleeps without an EXTERNAL pinger (UptimeRobot / cron) hitting /health.
  const publicUrl = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').replace(/\/$/, '');
  if (publicUrl) {
    const everyMs = Number(process.env.KEEP_ALIVE_MS) || 4 * 60 * 1000;
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, everyMs);
    console.log(`[KeepAlive] Self-ping ${publicUrl}/health every ${everyMs / 1000}s (does not prevent free-tier sleep alone)`);
  } else {
    console.warn('[KeepAlive] Set RENDER_EXTERNAL_URL or KEEP_ALIVE_URL, and use an external monitor to hit /health every ~5m, or overnight Telegram ENTERs will be missed when Render sleeps.');
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
