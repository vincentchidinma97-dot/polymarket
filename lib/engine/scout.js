import { fetchLeaderboard, fetchPositions } from '../polymarket.js';

function displayName(u) {
  if (!u.userName || /^0x[0-9a-fA-F]{40}/.test(u.userName))
    return u.proxyWallet.slice(0, 6) + '…' + u.proxyWallet.slice(-4);
  return u.userName;
}

export async function scoutInsiders(watchlist) {
  const wl = { ...watchlist };

  try {
    const lb = await fetchLeaderboard('1w', 'pnl', 50);
    const profitable = lb.filter(u => u.pnl > 0);

    const enriched = await Promise.all(profitable.map(async u => {
      try {
        const pos = await fetchPositions(u.proxyWallet, 200);
        return { ...u, totalPositions: pos.length };
      } catch { return { ...u, totalPositions: null }; }
    }));

    const candidates = enriched.filter(u =>
      u.totalPositions !== null && u.totalPositions < 100 &&
      u.vol > 0 && (u.pnl / u.vol) > 0.15
    ).sort((a, b) => (b.pnl / b.vol) - (a.pnl / a.vol));

    let added = 0;
    for (const u of candidates) {
      if (added >= 10) break;
      if (wl[u.proxyWallet]) continue;
      wl[u.proxyWallet] = { name: displayName(u), addedAt: Date.now(), lastPositionCount: null, scoutedBy: 'auto' };
      added++;
    }

    return { watchlist: wl, added };
  } catch {
    return { watchlist: wl, added: 0 };
  }
}
