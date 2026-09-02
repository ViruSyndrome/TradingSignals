exports.handler = async function handler() {
  const rssUrl = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
  try {
    const response = await fetch(rssUrl, { headers: { 'user-agent': 'TrendRunner/1.0' } });
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    const xml = await response.text();
    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(match => {
      const item = match[0];
      const value = tag => {
        const found = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return found ? found[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
      };
      return { title: value('title'), link: value('link'), pubDate: value('pubDate') };
    }).filter(item => item.title && item.link && item.pubDate).slice(0, 20);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
      body: JSON.stringify({ items }),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'News feed unavailable' }),
    };
  }
};
