require('dotenv').config();
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('Token:', token ? token.substring(0, 10) + '...' : 'MISSING');
console.log('Chat ID:', chatId || 'MISSING');

fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chatId,
    text: '✅ Connection test successful! Bot is alive and ready to scan.'
  })
})
.then(r => r.json())
.then(j => {
  console.log('Response:', JSON.stringify(j, null, 2));
  if (j.ok) {
    console.log('SUCCESS: Message sent to Telegram!');
  } else {
    console.log('FAILED:', j.description);
  }
})
.catch(e => console.error('Network ERROR:', e.message));
