export default async function handler(req, res) {
  const { q } = req.query;
  if (!q || q.length > 200) return res.status(400).json({ error: 'missing or too long query' });

  const encoded = encodeURIComponent(q);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'polymarket-tracker/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(r.status).json({ error: `google news ${r.status}` });

    const xml = await r.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
      const block = match[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';

      const clean = title
        .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      items.push({
        title: clean,
        link: link.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, ''),
        pubDate,
        source: source.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, ''),
        ts: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0,
      });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ query: q, count: items.length, items });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
