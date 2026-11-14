module.exports = {
  apps: [
    {
      name: 'nov6-nifty-track1',
      script: './archive/nov6-close/bot.js',
      cwd: '.',
      env: {
        PORT: '3001',
        TELEGRAM_POLLING: 'false',
        NOV6_STATE_DIR: './archive/nov6-close',
        REDBAR_BOT_INSTRUMENTS: 'NIFTY',
        DHAN_AUTO_INSTRUMENTS: 'NIFTY',
        REDBAR_AUTO_TRADE: 'false',
        NOV6_CLOSED_15M: 'true',
        NOV6_EMA_FILTER: 'true',
        NOV6_FIRST_RED_GATE: 'true',
        NOV6_SANDWICH_GATE: 'true',
        // Live NIFTY Options auto-trading enabled on Track 1 (Nov 6 Closed with Nov 9–12 fixes)
        DHAN_AUTO_TRADE: 'true',
        TRADE_ENABLED: 'true',
        DHAN_NIFTY_LOTS: '2',
      },
    },
    {
      name: 'patrick-nifty-paper',
      script: './bots/patrick_futures_bot.js',
      cwd: '.',
      env: {
        PATRICK_SYMBOLS: 'NIFTY',
        PATRICK_TF: '15m',
        PATRICK_MODE: 'ALL',
        PATRICK_LOTS: '1',
        PATRICK_CAPITAL_RS: '200000',
        PATRICK_AUTO_TRADE: 'false',
        PATRICK_POLL_MS: '60000',
      },
    },
  ],
};
