const fs = require('fs');
let code = fs.readFileSync('js/dashboard.js', 'utf8');

code = code.replace(    notifGranted:  false,,     notifGranted:  false,\n    watchlist:     JSON.parse(localStorage.getItem('trading_watchlist') || '[]'),);

code = code.replace(    const cat = this.state.activeCategory;\n    let assets = cat === 'all'\n      ? this.state.allAssets\n      : this.state.allAssets.filter(a => a.category === cat);,     const cat = this.state.activeCategory;\n    let assets = this.state.allAssets;\n\n    if (cat === 'watchlist') {\n      assets = assets.filter(a => this.state.watchlist.includes(a.asset.id));\n    } else if (cat === 'oversold') {\n      assets = assets.filter(a => a.signalResult?.indicators?.rsi?.value < 30);\n    } else if (cat !== 'all') {\n      assets = assets.filter(a => a.category === cat);\n    });

code = code.replace(            <span class="cat-badge">\</span>\n          </div>\n          <div class="signal-badge,             <span class="cat-badge">\</span>\n            <button class="star-btn \" data-star-id="\" title="Toggle Watchlist" style="background:none; border:none; cursor:pointer; font-size:18px; margin-left:auto; opacity:\; transition:0.2s;">?</button>\n          </div>\n          <div class="signal-badge);

code = code.replace(    const chgCls  = change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg';\n    const catBadge,     const chgCls  = change24h == null ? 'flat' : change24h >= 0 ? 'pos' : 'neg';\n    const isStarred = this.state.watchlist.includes(asset.id);\n    const catBadge);

code = code.replace(  _attachCardListeners(container) {\n    container.querySelectorAll('.asset-card').forEach(card => {,   _toggleWatchlist(id) {\n    if (this.state.watchlist.includes(id)) {\n      this.state.watchlist = this.state.watchlist.filter(x => x !== id);\n    } else {\n      this.state.watchlist.push(id);\n    }\n    localStorage.setItem('trading_watchlist', JSON.stringify(this.state.watchlist));\n    this._renderAssetGrid();\n  },\n\n  _attachCardListeners(container) {\n    container.querySelectorAll('.star-btn').forEach(btn => {\n      btn.onclick = (e) => {\n        e.stopPropagation();\n        this._toggleWatchlist(btn.dataset.starId);\n      };\n    });\n    container.querySelectorAll('.asset-card').forEach(card => {);

code = code.replace(                <td><span class="pnl-badge \">\</span></td>\n                <td><button class="action-btn sell-btn",                 <td><span class="pnl-badge \">\</span></td>\n                <td><span class="pnl-badge" style="background:var(--bg-app); border: 1px solid var(--border); color: #fff;">\</span></td>\n                <td><button class="action-btn sell-btn");

fs.writeFileSync('js/dashboard.js', code);
