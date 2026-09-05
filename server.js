'use strict';

const { fork } = require('child_process');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.type('text').send('TrendRunner bot is running.'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Health server listening on port ${port}`);
  startWorker();
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
