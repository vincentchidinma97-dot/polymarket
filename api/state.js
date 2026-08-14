import { redis, KEYS } from '../lib/redis.js';
import { PAPER_STARTING_BALANCE } from '../lib/constants.js';

function defaultPortfolio() {
  return {
    balance: PAPER_STARTING_BALANCE, open: [], closed: [],
    autoTrade: true, mirrorWatchlist: true, autoClose: true,
    minConsensus: 6, created: Date.now(),
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const [portfolio, watchlist, lastRun, runLog] = await Promise.all([
      redis.get(KEYS.PORTFOLIO),
      redis.get(KEYS.WATCHLIST),
      redis.get(KEYS.LAST_RUN),
      redis.lrange(KEYS.RUN_LOG, 0, 9),
    ]);

    return res.status(200).json({
      portfolio: portfolio || defaultPortfolio(),
      watchlist: watchlist || {},
      lastRun: lastRun || null,
      runLog: (runLog || []).map(r => typeof r === 'string' ? JSON.parse(r) : r),
    });
  }

  if (req.method === 'PUT') {
    const { type, data } = req.body;

    // The cron engine read-modify-writes the portfolio over many seconds;
    // a concurrent mutation here would be silently overwritten by its final
    // write. Reject portfolio mutations while the engine lock is held.
    const MUTATES_PORTFOLIO = ['close_position', 'settings', 'reset', 'migrate'];
    if (MUTATES_PORTFOLIO.includes(type)) {
      const lock = await redis.get(KEYS.ENGINE_LOCK);
      if (lock) return res.status(409).json({ error: 'engine_running', busy: true });
    }

    if (type === 'close_position') {
      const portfolio = await redis.get(KEYS.PORTFOLIO);
      if (!portfolio) return res.status(404).json({ error: 'no portfolio' });
      // Prefer the stable key — indexes shift when the engine closes positions
      const idx = data.key ? portfolio.open.findIndex(p => p.key === data.key) : data.index;
      const pos = portfolio.open[idx];
      if (!pos) return res.status(400).json({ error: 'position not found' });
      const exitPrice = pos.currentPrice ?? pos.entry;
      const value = pos.shares * exitPrice;
      const pnl = value - pos.cost;
      portfolio.balance += value;
      portfolio.closed.push({ ...pos, closedAt: Date.now(), exitPrice, pnl, value, closeReason: 'manual' });
      portfolio.open.splice(idx, 1);
      await redis.set(KEYS.PORTFOLIO, portfolio);
      return res.status(200).json({ ok: true, pnl });
    }

    if (type === 'settings') {
      const portfolio = await redis.get(KEYS.PORTFOLIO) || defaultPortfolio();
      if (data.autoTrade !== undefined) portfolio.autoTrade = data.autoTrade;
      if (data.mirrorWatchlist !== undefined) portfolio.mirrorWatchlist = data.mirrorWatchlist;
      if (data.autoClose !== undefined) portfolio.autoClose = data.autoClose;
      if (data.cryptoTrade !== undefined) portfolio.cryptoTrade = data.cryptoTrade;
      if (data.minConsensus !== undefined) portfolio.minConsensus = parseInt(data.minConsensus);
      await redis.set(KEYS.PORTFOLIO, portfolio);
      return res.status(200).json({ ok: true });
    }

    if (type === 'watchlist') {
      await redis.set(KEYS.WATCHLIST, data);
      return res.status(200).json({ ok: true });
    }

    if (type === 'watchlist_toggle') {
      const watchlist = await redis.get(KEYS.WATCHLIST) || {};
      if (watchlist[data.wallet]) {
        delete watchlist[data.wallet];
      } else {
        watchlist[data.wallet] = { name: data.name, addedAt: Date.now(), lastPositionCount: null };
      }
      await redis.set(KEYS.WATCHLIST, watchlist);
      return res.status(200).json({ ok: true, watching: !!watchlist[data.wallet] });
    }

    if (type === 'reset') {
      const pipe = redis.pipeline();
      pipe.set(KEYS.PORTFOLIO, defaultPortfolio());
      pipe.del(KEYS.CONSENSUS_SNAPSHOT);
      pipe.del(KEYS.RUN_LOG);
      pipe.del(KEYS.LAST_RUN);
      pipe.del(KEYS.RUN_COUNT);
      await pipe.exec();
      return res.status(200).json({ ok: true });
    }

    if (type === 'migrate') {
      const existing = await redis.get(KEYS.PORTFOLIO);
      if (existing && existing.open && existing.open.length > 0) {
        return res.status(409).json({ error: 'server already has data', hasData: true });
      }
      const pipe = redis.pipeline();
      if (data.portfolio) pipe.set(KEYS.PORTFOLIO, data.portfolio);
      if (data.watchlist) pipe.set(KEYS.WATCHLIST, data.watchlist);
      await pipe.exec();
      return res.status(200).json({ ok: true, migrated: true });
    }

    return res.status(400).json({ error: 'invalid type' });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
