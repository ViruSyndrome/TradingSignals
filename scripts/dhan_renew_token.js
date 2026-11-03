/**
 * Renew / mint a Dhan 24h access token.
 *
 *   # While current token still valid:
 *   node scripts/dhan_renew_token.js
 *
 *   # Fresh mint via TOTP (set DHAN_PIN + pass code):
 *   node scripts/dhan_renew_token.js --totp 123456
 *
 * Prints new token to stdout once — paste into .env DHAN_ACCESS_TOKEN=...
 */
'use strict';
require('dotenv').config();
const { createDhanClient, isDhanConfigured, generateAccessTokenViaTotp, env } = require('../js/dhan_client.js');

(async () => {
  const totpArg = process.argv.find((a) => a.startsWith('--totp'));
  const totp = totpArg
    ? (totpArg.includes('=') ? totpArg.split('=')[1] : process.argv[process.argv.indexOf('--totp') + 1])
    : null;

  if (totp) {
    const data = await generateAccessTokenViaTotp({
      dhanClientId: env('DHAN_CLIENT_ID'),
      pin: env('DHAN_PIN'),
      totp,
    });
    console.log('New accessToken (24h):');
    console.log(data.accessToken);
    console.log('expiryTime:', data.expiryTime);
    return;
  }

  if (!isDhanConfigured()) {
    console.error('Need DHAN_CLIENT_ID + DHAN_ACCESS_TOKEN (or use --totp with DHAN_PIN)');
    process.exit(1);
  }
  const dhan = createDhanClient();
  const data = await dhan.renewToken();
  const token = data.accessToken || data.token || data;
  console.log('Renewed accessToken (24h):');
  console.log(typeof token === 'string' ? token : JSON.stringify(data, null, 2));
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
