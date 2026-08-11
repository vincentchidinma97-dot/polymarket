import { fetchLeaderboard, fetchPositions } from '../polymarket.js';

export async function updateOpenPrices(portfolio, watchlist) {
  if (!portfolio.open.length) return portfolio;

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

    for (const op of portfolio.open) {
      const [title, outcome] = op.key.split('|||');
      const match = allPos.find(p => p.title === title && p.outcome === outcome);
      if (match) {
        op.currentPrice = match.curPrice;
        if (!op.highWaterMark || match.curPrice > op.highWaterMark) op.highWaterMark = match.curPrice;
      } else if (!op.currentPrice) {
        op.currentPrice = op.entry;
      }
    }
  } catch {}
  return portfolio;
}
