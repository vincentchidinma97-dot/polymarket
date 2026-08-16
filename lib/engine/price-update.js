import { fetchLeaderboard, fetchPositions } from '../polymarket.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export async function fetchGammaBySlug(slugs) {
  const out = new Map();
  for (let i = 0; i < slugs.length; i += 20) {
    const chunk = slugs.slice(i, i + 20);
    try {
      const qs = chunk.map(s => `slug=${encodeURIComponent(s)}`).join('&');
      const r = await fetch(`${GAMMA_API}/markets?${qs}&limit=${chunk.length}`, {
        headers: { 'User-Agent': 'polymarket-tracker/2.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      for (const m of await r.json()) out.set(m.slug, m);
    } catch {}
  }
  return out;
}

function gammaOutcomePrice(market, outcome) {
  try {
    const outcomes = JSON.parse(market.outcomes);
    const prices = JSON.parse(market.outcomePrices);
    let idx = outcomes.findIndex(o => o === outcome);
    if (idx < 0) idx = outcomes.findIndex(o => o.toLowerCase() === String(outcome).toLowerCase());
    if (idx < 0) return null;
    const p = parseFloat(prices[idx]);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

export async function updateOpenPrices(portfolio, watchlist) {
  if (!portfolio.open.length) return portfolio;

  // Primary source: direct market lookup by slug. This also detects
  // resolved markets so positions can be settled instead of freezing at entry.
  const withSlug = portfolio.open.filter(op => op.slug);
  if (withSlug.length) {
    const markets = await fetchGammaBySlug([...new Set(withSlug.map(op => op.slug))]);
    for (const op of withSlug) {
      const m = markets.get(op.slug);
      if (!m) continue;
      const price = gammaOutcomePrice(m, op.outcome);
      if (price === null) continue;
      op.currentPrice = price;
      if (!op.highWaterMark || price > op.highWaterMark) op.highWaterMark = price;
      if (m.closed === true || m.closed === 'True' || m.closed === 'true') op.resolved = true;
    }
  }

  // Fallback for positions without a slug: scan traders who might hold them.
  const noSlug = portfolio.open.filter(op => !op.slug);
  if (noSlug.length) {
    try {
      const lb = await fetchLeaderboard('1w', 'pnl', 10);
      const allPos = [];
      for (const u of lb.slice(0, 3)) {
        try {
          const pos = await fetchPositions(u.proxyWallet, 200);
          allPos.push(...pos);
        } catch {}
      }

      const wlWallets = Object.keys(watchlist || {}).slice(0, 5);
      for (const w of wlWallets) {
        try {
          const pos = await fetchPositions(w, 100);
          allPos.push(...pos);
        } catch {}
      }

      for (const op of noSlug) {
        const [title, outcome] = op.key.split('|||');
        const match = allPos.find(p => p.title === title && p.outcome === outcome);
        if (match) {
          op.currentPrice = match.curPrice;
          if (!op.slug && match.slug) op.slug = match.slug;
          if (!op.highWaterMark || match.curPrice > op.highWaterMark) op.highWaterMark = match.curPrice;
        } else if (!op.currentPrice) {
          op.currentPrice = op.entry;
        }
      }
    } catch {}
  }
  return portfolio;
}
