'use strict';

/**
 * portfolio.js — Paper trading portfolio manager using localStorage.
 */
const Portfolio = {
  key: 'trading_paper_portfolio',

  _state: {
    balance: 10000,
    positions: [], // { tradeId, assetId, symbol, name, buyPrice, amount, cost, date }
    history: []    // { tradeId, assetId, symbol, name, buyPrice, sellPrice, amount, pnl, pnlPct, date }
  },

  init() {
    try {
      const stored = localStorage.getItem(this.key);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Schema validation: ensure all required fields exist
        this._state = {
          balance: typeof parsed.balance === 'number' ? parsed.balance : 10000,
          positions: Array.isArray(parsed.positions) ? parsed.positions : [],
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch(e) {
      console.error('Failed to load portfolio, resetting to defaults:', e);
      this._state = { balance: 10000, positions: [], history: [] };
    }
  },

  _save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this._state));
    } catch(e) {
      console.error('Failed to save portfolio:', e);
    }
  },

  getState() {
    return this._state;
  },

  /**
   * Buy an asset
   */
  buy(asset, price, cost) {
    if (cost <= 0 || cost > this._state.balance) {
      return { success: false, error: 'Invalid or insufficient balance' };
    }

    const amount = cost / price;
    this._state.balance -= cost;

    this._state.positions.push({
      tradeId: Date.now().toString(),
      assetId: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      buyPrice: price,
      amount: amount,
      cost: cost,
      date: new Date().toISOString()
    });

    this._save();
    return { success: true };
  },

  /**
   * Sell an open position
   */
  sell(tradeId, currentPrice) {
    const posIndex = this._state.positions.findIndex(p => p.tradeId === tradeId);
    if (posIndex === -1) return { success: false, error: 'Position not found' };

    const pos = this._state.positions[posIndex];
    const revenue = pos.amount * currentPrice;
    const pnl = revenue - pos.cost;
    const pnlPct = (pnl / pos.cost) * 100;

    this._state.balance += revenue;

    this._state.history.unshift({
      tradeId: pos.tradeId,
      assetId: pos.assetId,
      symbol: pos.symbol,
      name: pos.name,
      buyPrice: pos.buyPrice,
      sellPrice: currentPrice,
      amount: pos.amount,
      pnl: pnl,
      pnlPct: pnlPct,
      date: new Date().toISOString()
    });

    if (this._state.history.length > 50) this._state.history.pop();

    this._state.positions.splice(posIndex, 1);
    this._save();
    
    return { success: true, pnl };
  },

  reset() {
    this._state = { balance: 10000, positions: [], history: [] };
    this._save();
  }
};

window.Portfolio = Portfolio;
