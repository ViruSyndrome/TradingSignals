#!/usr/bin/env node
/**
 * Download missing coin logos into assets/coin-logos/
 * Sources: spothq/cryptocurrency-icons (GitHub raw), then CoinCap icons.
 *
 * Usage: node scripts/fetch-coin-logos.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('../js/config.js');

const OUT = path.join(__dirname, '..', 'assets', 'coin-logos');
const symbols = new Set(
  (CONFIG.assets?.crypto || []).map(a => String(a.symbol || '').toLowerCase()).filter(Boolean)
);

async function tryFetch(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 80) return null;
  return buf;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0, skip = 0, miss = 0;
  for (const sym of [...symbols].sort()) {
    const svg = path.join(OUT, `${sym}.svg`);
    const png = path.join(OUT, `${sym}.png`);
    if (fs.existsSync(svg) || fs.existsSync(png)) {
      skip++;
      continue;
    }
    const sources = [
      `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color/${sym}.svg`,
      `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${sym}.png`,
      `https://assets.coincap.io/assets/icons/${sym}@2x.png`,
    ];
    let saved = false;
    for (const url of sources) {
      try {
        const buf = await tryFetch(url);
        if (!buf) continue;
        const dest = url.endsWith('.svg') ? svg : png;
        fs.writeFileSync(dest, buf);
        console.log(`✓ ${sym} ← ${url}`);
        ok++;
        saved = true;
        break;
      } catch (e) {
        /* try next */
      }
    }
    if (!saved) {
      console.log(`✗ ${sym} — no logo found`);
      miss++;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`\nDone. Saved ${ok}, already present ${skip}, missing ${miss}.`);
  console.log('Attribution: see assets/coin-logos/README.md');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
