const KALSHI_API = 'https://trading-api.kalshi.com/trade-api/v2';
const POLY_API = 'https://data-api.polymarket.com';

async function fetchKalshiMarkets() {
  const categories = ['Politics', 'Economics', 'Tech & Science', 'Crypto'];
  const markets = [];

  for (const cat of categories) {
    try {
      const url = `${KALSHI_API}/markets?status=open&limit=50&series_ticker=`;
      const r = await fetch(`${KALSHI_API}/markets?status=open&limit=100`, {
        headers: { 'User-Agent': 'polymarket-tracker/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.markets) markets.push(...data.markets);
      break;
    } catch { continue; }
  }

  return markets
    .filter(m => m.status === 'open' && m.yes_bid !== undefined)
    .map(m => ({
      ticker: m.ticker,
      title: m.title || m.event_ticker,
      subtitle: m.subtitle || '',
      category: m.category || '',
      yes_price: parseFloat(m.yes_bid) || parseFloat(m.last_price) || 0,
      no_price: parseFloat(m.no_bid) || 0,
      volume: m.volume || 0,
      platform: 'kalshi',
    }));
}

async function fetchPolymarketEvents() {
  try {
    const lb = await fetch(`${POLY_API}/v1/leaderboard?window=1w&rankType=pnl&limit=20`, {
      headers: { 'User-Agent': 'polymarket-tracker/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!lb.ok) return [];
    const traders = await lb.json();

    const positionSets = await Promise.all(
      traders.slice(0, 10).map(async t => {
        try {
          const r = await fetch(`${POLY_API}/positions?user=${t.proxyWallet}&limit=100&sortBy=CURRENT&sortDirection=DESC`, {
            headers: { 'User-Agent': 'polymarket-tracker/2.0' },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) return [];
          return r.json();
        } catch { return []; }
      })
    );

    const seen = new Map();
    for (const positions of positionSets) {
      for (const p of positions) {
        if (!p.title || p.currentValue < 1) continue;
        const key = `${p.title}|||${p.outcome}`;
        if (!seen.has(key)) {
          seen.set(key, {
            title: p.title,
            outcome: p.outcome,
            slug: p.slug,
            yes_price: p.outcome === 'Yes' ? p.curPrice : 1 - p.curPrice,
            platform: 'polymarket',
          });
        }
      }
    }
    return Array.from(seen.values());
  } catch { return []; }
}

function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 2));
  if (!wordsA.size || !wordsB.size) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function matchMarkets(kalshiMarkets, polyMarkets) {
  const matches = [];

  for (const k of kalshiMarkets) {
    let bestMatch = null;
    let bestScore = 0;

    for (const p of polyMarkets) {
      const score = similarityScore(k.title + ' ' + k.subtitle, p.title);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestMatch = p;
      }
    }

    if (bestMatch && k.yes_price > 0 && bestMatch.yes_price > 0) {
      const spread = Math.abs(k.yes_price - bestMatch.yes_price);
      if (spread >= 0.03) {
        const buyPlatform = k.yes_price < bestMatch.yes_price ? 'kalshi' : 'polymarket';
        const sellPlatform = buyPlatform === 'kalshi' ? 'polymarket' : 'kalshi';
        matches.push({
          kalshi: {
            ticker: k.ticker,
            title: k.title,
            subtitle: k.subtitle,
            yes_price: Math.round(k.yes_price * 100) / 100,
            volume: k.volume,
          },
          polymarket: {
            title: bestMatch.title,
            outcome: bestMatch.outcome,
            slug: bestMatch.slug,
            yes_price: Math.round(bestMatch.yes_price * 100) / 100,
          },
          spread: Math.round(spread * 100),
          matchScore: Math.round(bestScore * 100),
          direction: `Buy ${buyPlatform}, sell ${sellPlatform}`,
          buyPlatform,
          category: k.category,
        });
      }
    }
  }

  return matches.sort((a, b) => b.spread - a.spread);
}

export default async function handler(req, res) {
  try {
    const [kalshi, poly] = await Promise.all([
      fetchKalshiMarkets(),
      fetchPolymarketEvents(),
    ]);

    const opportunities = matchMarkets(kalshi, poly);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      opportunities,
      stats: {
        kalshiMarkets: kalshi.length,
        polyMarkets: poly.length,
        matched: opportunities.length,
        avgSpread: opportunities.length
          ? Math.round(opportunities.reduce((a, o) => a + o.spread, 0) / opportunities.length)
          : 0,
        maxSpread: opportunities.length ? opportunities[0].spread : 0,
      },
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
