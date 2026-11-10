require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createDhanClient } = require('../js/dhan_client.js');
const { createDhanNiftyTrade } = require('../js/dhan_nifty_trade.js');

(async () => {
  try {
    const dhan = createDhanClient();
    console.log('=== Checking Funds ===');
    const funds = await dhan.getFundLimits();
    console.log('Available cash:', funds.data ? funds.data.availabelBalance : funds);

    console.log('\n=== Checking Crude Oil Option Expiry ===');
    try {
      const exp = await dhan.getOptionExpiryList({ underlyingScrip: 573422, underlyingSeg: 'MCX_COMM' });
      console.log('Crude Expiries:', exp.data || exp);
    } catch (e) {
      console.log('Expiry fetch failed:', e.message);
    }

    console.log('\n=== Testing Dhan NG Option Chain Pick ===');
    try {
      const ngTrader = createDhanNiftyTrade({ instrumentId: 'NG' });
      const pickedNg = await ngTrader.pickOptionContract({ side: 'BUY', spot: 300 });
      console.log('Picked NG Contract:', pickedNg);
    } catch (e) {
      console.log('NG Pick error:', e.message);
    }

    console.log('\n=== Testing Dhan Crude Option Chain Pick ===');
    try {
      const trader = createDhanNiftyTrade({ instrumentId: 'CRUDEOIL' });
      // Suppose spot is 6000 (or current futures price ~6000-8000)
      const picked = await trader.pickOptionContract({ side: 'BUY', spot: 6000 });
      console.log('Picked Crude Contract:', picked);
    } catch (e) {
      console.log('Pick error:', e.message);
    }

  } catch (err) {
    console.error('Fatal error:', err.message);
  }
})();
