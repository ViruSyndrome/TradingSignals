'use strict';
/**
 * Smoke-test Dhan credentials (never prints the access token).
 *
 *   node scripts/dhan_smoke.js
 */
require('dotenv').config();
const { createDhanClient, isDhanConfigured } = require('../js/dhan_client.js');

(async () => {
  if (!isDhanConfigured()) {
    console.error('Missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN in .env');
    process.exit(1);
  }
  const dhan = createDhanClient();
  console.log('Client ID configured:', Boolean(dhan.clientId), `(len=${String(dhan.clientId).length})`);
  try {
    const profile = await dhan.getProfile();
    console.log('Profile OK:', {
      dhanClientId: profile.dhanClientId,
      tokenValidity: profile.tokenValidity,
      activeSegment: profile.activeSegment,
      dataPlan: profile.dataPlan,
      dataValidity: profile.dataValidity,
      ddpi: profile.ddpi,
    });
    if (String(profile.dataPlan || '').toLowerCase() !== 'active') {
      console.log('Note: Data APIs not Active — live/historical candles need ₹499 Data plan. Trading APIs still work.');
    }
  } catch (e) {
    console.error('Profile failed:', e.message);
    process.exit(1);
  }
  try {
    const funds = await dhan.getFundLimits();
    const avail = funds?.availabelBalance ?? funds?.availableBalance ?? funds?.sodLimit;
    console.log('Funds OK (summary):', {
      available: avail,
      collateral: funds?.collateralAmount,
      keys: Object.keys(funds || {}).slice(0, 8),
    });
  } catch (e) {
    console.warn('Funds read failed (ok if empty account):', e.message);
  }
  console.log('Dhan smoke passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
