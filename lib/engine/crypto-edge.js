const GAMMA_API = 'https://gamma-api.polymarket.com';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

const DERIBIT_API = 'https://www.deribit.com/api/v2';

const COINS = {
  bitcoin: { id: 'bitcoin', match: /\bbitcoin\b|\bbtc\b/i, dvol: 'btcdvol_usdc' },
  ethereum: { id: 'ethereum', match: /\bethereum\b|\beth\b/i, dvol: 'ethdvol_usdc' },
  solana: { id: 'solana', match: /\bsolana\b|\bsol\b/i },
  xrp: { id: 'ripple', match: /\bxrp\b/i },
  dogecoin: { id: 'dogecoin', match: /\bdogecoin\b|\bdoge\b/i },
};

// Deribit DVOL: options-implied 30-day annualized vol (index_price is in
// percentage points). Reacts to news the way trailing realized vol cannot.
// Caveat: 30-day constant maturity applied to 2-60 day expiries — an
// acceptable MVP approximation; the signal log's volSource field lets us
// compare calibration between implied and realized regimes.
async function fetchDvol(indexName) {
  try {
    const r = await fetch(`${DERIBIT_API}/public/get_index_price?index_name=${indexName}`, {
      headers: { 'User-Agent': 'polymarket-tracker/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const iv = parseFloat(data?.result?.index_price);
    return Number.isFinite(iv) && iv > 1 && iv < 500 ? iv / 100 : null;
  } catch { return null; }
}

// Standard normal CDF (Abramowitz & Stegun approximation)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Redis is optional here so the module still works without Upstash env vars
// (local dev, unit runs); without it every scan just pays the CoinGecko call.
let _redisPromise;
function getRedis() {
  if (!_redisPromise) {
    _redisPromise = import('../redis.js').then(m => m.redis).catch(() => null);
  }
  return _redisPromise;
}

const COIN_STATS_TTL_S = 1800; // spot/vol move slowly; 30 min is plenty

async function fetchCoinStats(coinKey) {
  const { id, dvol } = COINS[coinKey];
  const redis = await getRedis();
  const cacheKey = `pm:coinstats:${id}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && cached.spot) return cached;
    } catch {}
  }

  const r = await fetch(`${COINGECKO_API}/coins/${id}/market_chart?vs_currency=usd&days=90&interval=daily`, {
    headers: { 'User-Agent': 'polymarket-tracker/2.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const prices = (data.prices || []).map(p => p[1]);
  if (prices.length < 10) return null;
  const spot = prices[prices.length - 1];
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r2) => a + (r2 - mean) ** 2, 0) / (rets.length - 1);
  const realized = Math.sqrt(variance) * Math.sqrt(365); // annualized realized vol
  const iv = dvol ? await fetchDvol(dvol) : null;
  const stats = {
    spot,
    vol: iv ?? realized,
    realizedVol: Math.round(realized * 10000) / 10000,
    volSource: iv ? 'deribit' : 'realized',
  };

  if (redis) {
    try { await redis.set(cacheKey, stats, { ex: COIN_STATS_TTL_S }); } catch {}
  }
  return stats;
}

function coinFor(question) {
  for (const [key, c] of Object.entries(COINS)) if (c.match.test(question)) return key;
  return null;
}

function parseStrike(question) {
  const m = question.match(/\$([\d,]+(?:\.\d+)?)\s*([kKmM])?\b/);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  return base * mult;
}

// P(terminal price above strike) under driftless lognormal
function probAbove(spot, strike, vol, T) {
  if (T <= 0) return spot > strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - (vol * vol * T) / 2) / (vol * Math.sqrt(T));
  return normCdf(d2);
}

// Exact first-passage (one-touch) probability for driftless GBM
// (log-drift -sigma^2/2): P = P(S_T beyond B) + (S/B) * N(mirror term).
function probTouch(spot, strike, vol, T, up) {
  if (T <= 0) return 0;
  const sq = vol * Math.sqrt(T);
  const h = (vol * vol * T) / 2;
  const l = Math.log(spot / strike);
  if (up) return normCdf((l - h) / sq) + (spot / strike) * normCdf((l + h) / sq);
  return normCdf((h - l) / sq) + (spot / strike) * normCdf(-(l + h) / sq);
}

function modelProbability(kind, spot, strike, vol, T) {
  if (kind === 'above') return probAbove(spot, strike, vol, T);
  if (kind === 'reach') {
    if (strike <= spot) return 0.99;
    return Math.min(0.99, probTouch(spot, strike, vol, T, true));
  }
  if (kind === 'dip') {
    if (strike >= spot) return 0.99;
    return Math.min(0.99, probTouch(spot, strike, vol, T, false));
  }
  return null;
}

function classify(question) {
  if (/be above \$/i.test(question)) return 'above';
  if (/\b(?:reach|hit) \$/i.test(question)) return 'reach';
  if (/\bdip to \$/i.test(question)) return 'dip';
  return null; // between / less-than / up-or-down need different handling
}

async function fetchCryptoMarkets() {
  const markets = [];
  try {
    const r = await fetch(`${GAMMA_API}/events?closed=false&limit=100&order=volume24hr&ascending=false&tag_slug=crypto`, {
      headers: { 'User-Agent': 'polymarket-tracker/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return markets;
    for (const ev of await r.json()) {
      for (const m of ev.markets || []) {
        if (!m.question || !m.outcomePrices) continue;
        let prices;
        try { prices = JSON.parse(m.outcomePrices); } catch { continue; }
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (!Number.isFinite(yes)) continue;
        markets.push({ question: m.question, slug: m.slug, yes, no: Number.isFinite(no) ? no : 1 - yes, endDate: m.endDate, volume: parseFloat(m.volumeNum) || 0 });
      }
    }
  } catch {}
  return markets;
}

export async function scanCryptoEdges() {
  const markets = await fetchCryptoMarkets();

  const neededCoins = new Set();
  for (const m of markets) { const c = coinFor(m.question); if (c) neededCoins.add(c); }

  const coinStats = {};
  await Promise.all([...neededCoins].map(async c => { coinStats[c] = await fetchCoinStats(c); }));

  const opportunities = [];
  let scanned = 0;
  for (const m of markets) {
    const kind = classify(m.question);
    const coin = coinFor(m.question);
    const strike = parseStrike(m.question);
    const stats = coin && coinStats[coin];
    if (!kind || !coin || !strike || !stats) continue;
    if (m.yes <= 0.02 || m.yes >= 0.98) continue; // no payoff left to capture
    if (m.volume < 1000) continue; // untraded books report placeholder 50/50 prices

    const T = (new Date(m.endDate).getTime() - Date.now()) / (365 * 86400000);
    if (!Number.isFinite(T) || T <= 0 || T > 1) continue;
    scanned++;

    const model = modelProbability(kind, stats.spot, strike, stats.vol, T);
    if (model === null) continue;
    const edge = model - m.yes;
    if (Math.abs(edge) < 0.05) continue;

    opportunities.push({
      question: m.question,
      slug: m.slug,
      coin, kind, strike,
      endDate: m.endDate,
      yesRaw: m.yes, noRaw: m.no, edgeRaw: edge,
      market: Math.round(m.yes * 100) / 100,
      model: Math.round(model * 100) / 100,
      edge: Math.round(edge * 100),
      side: edge > 0 ? 'YES underpriced' : 'YES overpriced',
      spot: Math.round(stats.spot),
      vol: Math.round(stats.vol * 100) / 100,
      volSource: stats.volSource || 'realized',
      volume: Math.round(m.volume),
    });
  }

  opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  return {
    opportunities,
    stats: {
      cryptoMarkets: markets.length,
      scanned,
      flagged: opportunities.length,
      coins: Object.fromEntries(Object.entries(coinStats).filter(([, v]) => v).map(([k, v]) => [k, { spot: Math.round(v.spot), vol: Math.round(v.vol * 100), volSource: v.volSource || 'realized' }])),
    },
  };
}
