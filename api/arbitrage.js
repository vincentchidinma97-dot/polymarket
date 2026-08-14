const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_API = 'https://data-api.polymarket.com';

async function fetchKalshiMarkets() {
  // The bare /markets listing is dominated by dead provisional combo markets,
  // so we go through /events with nested markets and keep only liquid ones.
  const markets = [];
  let cursor = '';

  for (let page = 0; page < 3; page++) {
    try {
      const url = `${KALSHI_API}/events?status=open&limit=200&with_nested_markets=true${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'polymarket-tracker/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) break;
      const data = await r.json();
      for (const ev of data.events || []) {
        for (const m of ev.markets || []) {
          const bid = parseFloat(m.yes_bid_dollars) || 0;
          const ask = parseFloat(m.yes_ask_dollars) || 0;
          const vol = parseFloat(m.volume_fp) || m.volume || 0;
          if (bid <= 0.02 || bid >= 0.98 || vol < 100) continue;
          markets.push({
            ticker: m.ticker,
            title: ev.title || m.title || m.event_ticker,
            subtitle: m.yes_sub_title || m.subtitle || '',
            category: ev.category || '',
            yes_price: ask > bid ? (bid + ask) / 2 : bid,
            no_price: parseFloat(m.no_bid_dollars) || 0,
            volume: vol,
            platform: 'kalshi',
          });
        }
      }
      cursor = data.cursor;
      if (!cursor) break;
    } catch { break; }
  }

  return markets;
}

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchPolymarketEvents() {
  // Top markets by volume from the Gamma API — the whole liquid universe,
  // not just what a handful of leaderboard traders happen to hold.
  const markets = [];
  try {
    const pages = await Promise.all([0, 1, 2, 3].map(async offset => {
      const r = await fetch(`${GAMMA_API}/markets?closed=false&limit=500&offset=${offset * 500}&order=volumeNum&ascending=false`, {
        headers: { 'User-Agent': 'polymarket-tracker/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return [];
      return r.json();
    }));

    for (const page of pages) {
      for (const m of page) {
        if (!m.question || !m.outcomePrices) continue;
        let outcomes, prices;
        try { outcomes = JSON.parse(m.outcomes); prices = JSON.parse(m.outcomePrices); } catch { continue; }
        const yesIdx = outcomes.findIndex(o => o === 'Yes');
        if (yesIdx < 0) continue; // only binary Yes/No markets compare cleanly
        const yes = parseFloat(prices[yesIdx]) || 0;
        if (yes <= 0.02 || yes >= 0.98) continue;
        markets.push({
          title: m.question,
          outcome: 'Yes',
          slug: m.slug,
          yes_price: yes,
          volume: parseFloat(m.volumeNum) || 0,
          platform: 'polymarket',
        });
      }
    }
  } catch {}
  return markets;
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

function yearsOf(t) {
  return new Set((t.match(/\b20\d{2}\b/g) || []));
}

function yearsCompatible(a, b) {
  const ya = yearsOf(a), yb = yearsOf(b);
  if (!ya.size || !yb.size) return true;
  for (const y of ya) if (yb.has(y)) return true;
  return false;
}

const NEGATION = /\bnot\b|\bwon't\b|\bwithout\b/i;

const NOUN_STOP = new Set(['will', 'who', 'what', 'when', 'which', 'before', 'after', 'the', 'next', 'first', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);

function properNouns(t) {
  const out = new Set();
  for (const w of (t.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || [])) {
    const lw = w.toLowerCase();
    if (!NOUN_STOP.has(lw)) out.add(lw);
  }
  return out;
}

function entitiesOverlap(a, b) {
  const na = properNouns(a), nb = properNouns(b);
  if (!na.size && !nb.size) return true;
  if (!na.size || !nb.size) return false;
  const [small, large] = na.size <= nb.size ? [na, nb] : [nb, na];
  for (const n of small) if (!large.has(n)) return false;
  return true;
}

function semanticsCompatible(a, b) {
  // "run for" vs "win" are different questions even when every other word matches
  const winA = /\bwin\b|\bwinner\b/i.test(a), runA = /\brun for\b|\brun in\b|\bcandidate\b/i.test(a);
  const winB = /\bwin\b|\bwinner\b/i.test(b), runB = /\brun for\b|\brun in\b|\bcandidate\b/i.test(b);
  if ((winA && !winB && runB) || (winB && !winA && runA)) return false;
  return true;
}

function matchMarkets(kalshiMarkets, polyMarkets) {
  const matches = [];

  for (const k of kalshiMarkets) {
    let bestMatch = null;
    let bestScore = 0;

    for (const p of polyMarkets) {
      const kText = k.title + ' ' + k.subtitle;
      if (!yearsCompatible(kText, p.title)) continue;
      if (!semanticsCompatible(kText, p.title)) continue;
      if (!entitiesOverlap(kText, p.title)) continue;
      const score = similarityScore(kText, p.title);
      if (score > bestScore && score >= 0.65) {
        bestScore = score;
        bestMatch = p;
      }
    }

    if (bestMatch && k.yes_price > 0 && bestMatch.yes_price > 0) {
      // One side phrased as a negation means YES on one platform ≈ NO on the other
      const kNeg = NEGATION.test(k.title + ' ' + k.subtitle), pNeg = NEGATION.test(bestMatch.title);
      const inverted = kNeg !== pNeg;
      const polyYes = inverted ? 1 - bestMatch.yes_price : bestMatch.yes_price;
      const spread = Math.abs(k.yes_price - polyYes);
      if (spread >= 0.03) {
        const buyPlatform = k.yes_price < polyYes ? 'kalshi' : 'polymarket';
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
          inverted,
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
