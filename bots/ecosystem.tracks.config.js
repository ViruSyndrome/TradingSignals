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
        // Flip DHAN_AUTO_TRADE=true and TRADE_ENABLED=true when ready for live options test (2+ lots recommended for 1:1 50% bank)
        DHAN_AUTO_TRADE: 'false',
        TRADE_ENABLED: 'false',
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
