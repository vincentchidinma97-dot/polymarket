import { redis, KEYS } from '../../lib/redis.js';
import { PAPER_STARTING_BALANCE, MIN_RUN_INTERVAL_MS } from '../../lib/constants.js';
import { runAutoTrade } from '../../lib/engine/auto-trade.js';
import { runAutoClose } from '../../lib/engine/auto-close.js';
import { updateOpenPrices } from '../../lib/engine/price-update.js';
import { scoutInsiders } from '../../lib/engine/scout.js';

function defaultPortfolio() {
  return {
    balance: PAPER_STARTING_BALANCE, open: [], closed: [],
    autoTrade: true, mirrorWatchlist: true, autoClose: true,
    minConsensus: 6, created: Date.now(),
  };
}

export default async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const isDashboard = req.query.source === 'dashboard';

  if (!isVercelCron && !isDashboard && (!cronSecret || authHeader !== `Bearer ${cronSecret}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const lastRun = await redis.get(KEYS.LAST_RUN);
  if (lastRun && Date.now() - lastRun < MIN_RUN_INTERVAL_MS) {
    return res.status(200).json({ skipped: true, reason: 'too_soon', nextRunIn: Math.ceil((MIN_RUN_INTERVAL_MS - (Date.now() - lastRun)) / 1000) });
  }

  let portfolio = await redis.get(KEYS.PORTFOLIO) || defaultPortfolio();
  let watchlist = await redis.get(KEYS.WATCHLIST) || {};
  let consensusSnapshot = await redis.get(KEYS.CONSENSUS_SNAPSHOT) || {};

  let placed = 0, watchlistPlaced = 0, consensusExits = 0, closedCount = 0, closeReasons = {}, scouted = 0;

  try {
    if (portfolio.autoTrade) {
      const tradeResult = await runAutoTrade(portfolio, watchlist, consensusSnapshot);
      portfolio = tradeResult.portfolio;
      watchlist = tradeResult.watchlist;
      consensusSnapshot = tradeResult.consensusSnapshot;
      placed = tradeResult.placed;
      watchlistPlaced = tradeResult.watchlistPlaced;
      consensusExits = tradeResult.consensusExits;
    }

    portfolio = await updateOpenPrices(portfolio, watchlist);

    if (portfolio.autoClose) {
      const closeResult = runAutoClose(portfolio);
      portfolio = closeResult.portfolio;
      closedCount = closeResult.closed;
      closeReasons = closeResult.reasons;
    }

    const runCount = await redis.incr(KEYS.RUN_COUNT);
    if (runCount % 6 === 0) {
      const scoutResult = await scoutInsiders(watchlist);
      watchlist = scoutResult.watchlist;
      scouted = scoutResult.added;
    }
  } catch (e) {
    console.error('Cron trade error:', e.message);
  }

  const logEntry = {
    ts: Date.now(),
    placed, watchlistPlaced, consensusExits, closed: closedCount, closeReasons, scouted,
    openCount: portfolio.open.length,
    balance: Math.round(portfolio.balance * 100) / 100,
  };

  const pipe = redis.pipeline();
  pipe.set(KEYS.PORTFOLIO, portfolio);
  pipe.set(KEYS.WATCHLIST, watchlist);
  pipe.set(KEYS.CONSENSUS_SNAPSHOT, consensusSnapshot);
  pipe.set(KEYS.LAST_RUN, Date.now());
  pipe.lpush(KEYS.RUN_LOG, JSON.stringify(logEntry));
  pipe.ltrim(KEYS.RUN_LOG, 0, 49);
  await pipe.exec();

  return res.status(200).json({ success: true, ...logEntry });
}
