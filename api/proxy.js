const ALLOWED = {
  leaderboard: '/v1/leaderboard',
  trades: '/trades',
  positions: '/positions',
  activity: '/activity',
};

export default async function handler(req, res) {
  const { endpoint, ...params } = req.query;
  const upstream = ALLOWED[endpoint];
  if (!upstream) return res.status(400).json({ error: 'invalid endpoint' });

  const qs = new URLSearchParams(params).toString();
  const url = `https://data-api.polymarket.com${upstream}${qs ? '?' + qs : ''}`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'polymarket-tracker/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return res.status(r.status).json({ error: `upstream ${r.status}` });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
