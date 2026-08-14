import { MAX_POSITIONS, TIER_STRONG } from '../constants.js';
import { fetchLeaderboard, fetchPositions, fetchTrades } from '../polymarket.js';
import { positionSize, tradeLabel } from './position-size.js';
import { detectConsensusExits } from './consensus-exit.js';

// Game-winner and player-prop markets resolve within hours; between two
// 15-minute runs a market can go 65c -> 6c, gapping straight through the
// stop-loss. The engine structurally can't manage them — never auto-trade them.
const FAST_GAME_RE = /\bvs\.?\s|\bO\/U\b|\(BO\d\)|Game \d|Map \d|Spread:|Exact Score|Home Runs/i;

function displayName(u) {
  if (!u.userName || /^0x[0-9a-fA-F]{40}/.test(u.userName))
    return u.proxyWallet.slice(0, 6) + '…' + u.proxyWallet.slice(-4);
  return u.userName;
}

export async function runAutoTrade(portfolio, watchlist, consensusSnapshot) {
  if (!portfolio.autoTrade || portfolio.balance < 10)
    return { portfolio, watchlist, consensusSnapshot, placed: 0, watchlistPlaced: 0, consensusExits: 0 };

  let placed = 0, watchlistPlaced = 0, consensusExits = 0;
  const minC = portfolio.minConsensus || TIER_STRONG;

  try {
    const lb = await fetchLeaderboard('1w', 'pnl', 50);
    const profitable = lb.filter(u => u.pnl > 0);

    const allPositions = await Promise.all(profitable.map(async u => {
      try {
        const pos = await fetchPositions(u.proxyWallet, 200, 'CURRENT', 'DESC');
        return pos.filter(p => p.currentValue > 1).map(p => ({ ...p, traderWallet: u.proxyWallet }));
      } catch { return []; }
    }));

    const consensus = {};
    for (const positions of allPositions) {
      for (const p of positions) {
        const key = `${p.title}|||${p.outcome}`;
        if (!consensus[key]) consensus[key] = { title: p.title, outcome: p.outcome, slug: p.slug, traders: new Set(), curPrice: p.curPrice, entries: [] };
        consensus[key].traders.add(p.traderWallet);
        consensus[key].entries.push(p.avgPrice);
        consensus[key].curPrice = p.curPrice;
      }
    }

    const consensusCounts = {};
    for (const [key, c] of Object.entries(consensus)) consensusCounts[key] = c.traders.size;

    const exiting = detectConsensusExits(portfolio, consensusSnapshot, consensusCounts);
    for (const pos of exiting) {
      const idx = portfolio.open.indexOf(pos);
      if (idx === -1) continue;
      const cur = pos.currentPrice || pos.entry;
      const val = pos.shares * cur;
      const pnl = val - pos.cost;
      portfolio.balance += val;
      portfolio.closed.push({ ...pos, closedAt: Date.now(), exitPrice: cur, pnl, value: val, closeReason: 'consensus-exit' });
      portfolio.open.splice(idx, 1);
      consensusExits++;
    }

    // Update snapshot for next run
    const newSnapshot = consensusCounts;

    if (portfolio.open.length < MAX_POSITIONS) {
      const sorted = Object.values(consensus)
        .filter(c => c.traders.size >= minC)
        .sort((a, b) => b.traders.size - a.traders.size);

      for (const c of sorted) {
        if (portfolio.open.length >= MAX_POSITIONS) break;
        if (FAST_GAME_RE.test(c.title)) continue;
        const count = c.traders.size;
        const avgEntry = c.entries.reduce((a, b) => a + b, 0) / c.entries.length;
        const gap = avgEntry > 0 ? Math.abs(c.curPrice - avgEntry) / avgEntry : 1;
        if (gap > 0.25) continue;

        const tradeKey = `${c.title}|||${c.outcome}`;
        if (portfolio.open.some(o => o.key === tradeKey)) continue;
        if (portfolio.closed.some(o => o.key === tradeKey && Date.now() - o.closedAt < 86400000)) continue;

        const size = positionSize(portfolio.balance, portfolio.open, 'consensus', count);
        if (size < 5 || size > portfolio.balance) continue;

        const shares = size / c.curPrice;
        portfolio.open.push({
          key: tradeKey, title: c.title, outcome: c.outcome, slug: c.slug,
          entry: c.curPrice, shares, cost: size,
          strength: tradeLabel(count, 'consensus'),
          traders: count, source: 'consensus', openedAt: Date.now(), highWaterMark: c.curPrice,
        });
        portfolio.balance -= size;
        placed++;
        if (placed >= 3) break;
      }
    }

    if (portfolio.mirrorWatchlist && portfolio.open.length < MAX_POSITIONS) {
      const wallets = Object.keys(watchlist || {});
      if (wallets.length) {
        const watchResults = await Promise.all(wallets.slice(0, 15).map(async wallet => {
          try {
            const [positions, trades] = await Promise.all([
              fetchPositions(wallet, 100, 'CURRENT', 'DESC'),
              fetchTrades(wallet, 20, true),
            ]);
            const open = positions.filter(p => p.currentValue > 1);
            const recentBuys = trades.filter(t => t.side === 'BUY' && (Date.now() / 1000 - t.timestamp) < 7200);
            return { wallet, name: (watchlist[wallet] || {}).name, open, recentBuys };
          } catch { return { wallet, name: (watchlist[wallet] || {}).name, open: [], recentBuys: [] }; }
        }));

        for (const wr of watchResults) {
          if (portfolio.open.length >= MAX_POSITIONS) break;
          for (const buy of wr.recentBuys) {
            if (portfolio.open.length >= MAX_POSITIONS) break;
            if (FAST_GAME_RE.test(buy.title)) continue;
            const tradeKey = `${buy.title}|||${buy.outcome}`;
            if (portfolio.open.some(o => o.key === tradeKey)) continue;
            if (portfolio.closed.some(o => o.key === tradeKey && Date.now() - o.closedAt < 86400000)) continue;

            const size = positionSize(portfolio.balance, portfolio.open, 'watchlist', 1);
            if (size < 5 || size > portfolio.balance) continue;

            const shares = size / buy.price;
            portfolio.open.push({
              key: tradeKey, title: buy.title, outcome: buy.outcome, slug: buy.slug,
              entry: buy.price, shares, cost: size,
              strength: 'watchlist', traders: 1,
              source: 'watchlist', sourceTrader: wr.name,
              openedAt: Date.now(), highWaterMark: buy.price,
            });
            portfolio.balance -= size;
            watchlistPlaced++;
            if (watchlistPlaced >= 3) break;
          }
        }

        for (const wr of watchResults) {
          if (portfolio.open.length >= MAX_POSITIONS) break;
          for (const pos of wr.open.filter(p => p.currentValue > 500)) {
            if (portfolio.open.length >= MAX_POSITIONS) break;
            if (FAST_GAME_RE.test(pos.title)) continue;
            const tradeKey = `${pos.title}|||${pos.outcome}`;
            if (portfolio.open.some(o => o.key === tradeKey)) continue;
            if (portfolio.closed.some(o => o.key === tradeKey && Date.now() - o.closedAt < 86400000)) continue;

            const gap = pos.avgPrice > 0 ? Math.abs(pos.curPrice - pos.avgPrice) / pos.avgPrice : 1;
            if (gap > 0.15) continue;

            const size = positionSize(portfolio.balance, portfolio.open, 'watchlist', 1);
            if (size < 5 || size > portfolio.balance) continue;

            const shares = size / pos.curPrice;
            portfolio.open.push({
              key: tradeKey, title: pos.title, outcome: pos.outcome, slug: pos.slug,
              entry: pos.curPrice, shares, cost: size,
              strength: 'watchlist', traders: 1,
              source: 'watchlist', sourceTrader: wr.name,
              openedAt: Date.now(), highWaterMark: pos.curPrice,
            });
            portfolio.balance -= size;
            watchlistPlaced++;
            if (watchlistPlaced >= 5) break;
          }
        }
      }
    }

    return { portfolio, watchlist, consensusSnapshot: newSnapshot, placed, watchlistPlaced, consensusExits };
  } catch (e) {
    return { portfolio, watchlist, consensusSnapshot, placed, watchlistPlaced, consensusExits, error: e.message };
  }
}
