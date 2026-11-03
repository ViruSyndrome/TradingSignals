// Replays today's NIFTY 5m/15m bars bar-by-bar through RedBarTrend.readAt and prints state changes.
require('dotenv').config();
const CONFIG = require('./js/config.js');
const Indicators = require('./js/indicators.js');
const RedBarTrend = require('./js/redbar_trend.js');
if (typeof global.localStorage === 'undefined') {
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
}
const { API } = require('./js/api.js');
global.CONFIG = CONFIG; global.Indicators = Indicators; global.RedBarTrend = RedBarTrend;

const ist = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(11, 16);

(async () => {
  const rb = CONFIG.rangeEma;
  const inst = rb.instruments.find((i) => i.id === 'NIFTY');
  const work = await API.getDeskOHLC(inst, rb.workingTf || '15m', 500);
  const b5 = await API.getDeskOHLC(inst, '5m', 500);
  const b15 = await API.getDeskOHLC(inst, '15m', 220);
  const norm = (r) => (r && r[0] && typeof r[0].t === 'number') ? r : (r || []).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  const w = norm(work), f5 = norm(b5), f15 = norm(b15);
  const day = RedBarTrend.dayKey(f5[f5.length - 1].t, 'ist');
  let last = '';
  for (let i = 0; i < f5.length; i++) {
    const t = f5[i].t;
    if (RedBarTrend.dayKey(t, 'ist') !== day) continue;
    const asOf = t + 5 * 60000; // bar closed
    const wi = w.filter((b) => b.t + 15 * 60000 <= asOf);
    if (wi.length < 40) continue;
    const s15 = f15.filter((b) => b.t + 15 * 60000 <= asOf);
    const s5 = f5.slice(0, i + 1);
    const fr = RedBarTrend.firstRedBarOfSession(s15, day, { ...rb, ...inst, asOfTs: asOf, barMs: 15 * 60000 });
    const r = RedBarTrend.readAt(wi, wi.length - 1, { ...rb, ...inst, asOfTs: asOf, firstRed1h: fr, bars1h: s15, bars5m: s5 });
    if (!r) continue;
    if (process.env.DETAIL) {
      const h = ist(t);
      if (h >= process.env.DETAIL) console.log(`${h} px=${s5[i].c.toFixed(1)} ${r.actionState} ${r.trend} ${r.setupKind} stop=${r.invalidation ? (+r.invalidation).toFixed(1) : '-'} why=${String(r.actionReason || '').slice(0, 110)}`);
    }
    const key = `${r.actionState}|${r.trend}|${r.setupKind}`;
    if (key !== last) {
      last = key;
      console.log(`${ist(t)} IST px=${s5[i].c.toFixed(1)} ${String(r.actionState).toUpperCase()} ${r.trend} ${r.setupKind} stop=${r.invalidation ? (+r.invalidation).toFixed(1) : '-'} tp1=${r.tp1 ? (+r.tp1).toFixed(1) : '-'} redBox=${fr ? fr.low.toFixed(0) + '-' + fr.high.toFixed(0) : 'none'}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
