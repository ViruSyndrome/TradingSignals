@echo off
echo ========================================================
echo Trading Signals - Weekly Backtest Automation
echo ========================================================
echo.

cd /d "%~dp0"

echo [1] Running full backtester...
node backtest.js

echo.
echo [2] Committing database updates...
git add js/backtest_database.json js/config.js
git commit -m "chore: weekly backtest database update"

echo.
echo [3] Pushing to GitHub...
git push

echo.
echo ========================================================
echo Done! The live dashboard will now use the latest winners.
echo ========================================================
