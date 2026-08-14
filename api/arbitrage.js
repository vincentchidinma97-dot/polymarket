const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

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

function yearsOf(t) {
  return new Set((t.match(/\b20\d{2}\b/g) || []));
}

function setsIntersect(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function setContained(small, large) {
  for (const x of small) if (!large.has(x)) return false;
  return true;
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

const WIN_RE = /\bwin\b|\bwinner\b/i;
const RUN_RE = /\brun for\b|\brun in\b|\bcandidate\b/i;

// Everything the pair checks need, computed once per market instead of once
// per pair — the loop below is O(K×P) over thousands of markets.
function marketFeatures(text) {
  return {
    text,
    words: new Set(normalizeTitle(text).split(' ').filter(w => w.length > 2)),
    years: yearsOf(text),
    nouns: properNouns(text),
    negated: NEGATION.test(text),
    win: WIN_RE.test(text),
    run: RUN_RE.test(text),
  };
}

function featuresCompatible(a, b) {
  if (a.years.size && b.years.size && !setsIntersect(a.years, b.years)) return false;
  // "run for" vs "win" are different questions even when every other word matches
  if ((a.win && !b.win && b.run) || (b.win && !a.win && a.run)) return false;
  if (a.nouns.size !== 0 || b.nouns.size !== 0) {
    if (!a.nouns.size || !b.nouns.size) return false;
    const [small, large] = a.nouns.size <= b.nouns.size ? [a.nouns, b.nouns] : [b.nouns, a.nouns];
    if (!setContained(small, large)) return false;
  }
  return true;
}

function wordOverlapScore(a, b) {
  if (!a.words.size || !b.words.size) return 0;
  let overlap = 0;
  for (const w of a.words) if (b.words.has(w)) overlap++;
  return overlap / Math.max(a.words.size, b.words.size);
}

function matchMarkets(kalshiMarkets, polyMarkets) {
  const matches = [];
  const polyFeats = polyMarkets.map(p => ({ p, f: marketFeatures(p.title) }));

  for (const k of kalshiMarkets) {
    const kf = marketFeatures(k.title + ' ' + k.subtitle);
    let bestMatch = null;
    let bestScore = 0;

    let bestFeat = null;
    for (const { p, f } of polyFeats) {
      if (!featuresCompatible(kf, f)) continue;
      const score = wordOverlapScore(kf, f);
      if (score > bestScore && score >= 0.65) {
        bestScore = score;
        bestMatch = p;
        bestFeat = f;
      }
    }

    if (bestMatch && k.yes_price > 0 && bestMatch.yes_price > 0) {
      // One side phrased as a negation means YES on one platform ≈ NO on the other
      const inverted = kf.negated !== bestFeat.negated;
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
