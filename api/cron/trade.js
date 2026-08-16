import { redis, KEYS } from '../../lib/redis.js';
import { PAPER_STARTING_BALANCE, MIN_RUN_INTERVAL_MS } from '../../lib/constants.js';
import { runAutoTrade } from '../../lib/engine/auto-trade.js';
import { runCryptoTrade } from '../../lib/engine/crypto-trade.js';
import { scanCryptoEdges } from '../../lib/engine/crypto-edge.js';
import { updateSignalLog } from '../../lib/engine/signal-log.js';
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

  const queryKey = req.query.key;
  const hasValidAuth = authHeader === `Bearer ${cronSecret}` || queryKey === cronSecret;

  if (!isVercelCron && !isDashboard && (!cronSecret || !hasValidAuth)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const lastRun = await redis.get(KEYS.LAST_RUN);
  if (lastRun && Date.now() - lastRun < MIN_RUN_INTERVAL_MS) {
    return res.status(200).json({ skipped: true, reason: 'too_soon', nextRunIn: Math.ceil((MIN_RUN_INTERVAL_MS - (Date.now() - lastRun)) / 1000) });
  }

  // Atomic admission + write barrier: only one run at a time, and dashboard
  // mutations are rejected while the lock is held (see api/state.js).
  const gotLock = await redis.set(KEYS.ENGINE_LOCK, Date.now(), { nx: true, ex: 120 });
  if (!gotLock) {
    return res.status(200).json({ skipped: true, reason: 'already_running' });
  }

  let portfolio = await redis.get(KEYS.PORTFOLIO) || defaultPortfolio();
  let watchlist = await redis.get(KEYS.WATCHLIST) || {};
  let consensusSnapshot = await redis.get(KEYS.CONSENSUS_SNAPSHOT) || {};

  let placed = 0, watchlistPlaced = 0, consensusExits = 0, closedCount = 0, closeReasons = {}, scouted = 0, cryptoPlaced = 0;
  let fetchOk = null, tradersTotal = null;

  let signalsLogged = 0, signalsResolved = 0;

  // Scan is hoisted out of runCryptoTrade so signals get logged for
  // calibration even when the crypto book is full or trading is off.
  let scan = { opportunities: [] };
  try { scan = await scanCryptoEdges(); } catch {}

  try {
    if (portfolio.autoTrade) {
      const tradeResult = await runAutoTrade(portfolio, watchlist, consensusSnapshot);
      portfolio = tradeResult.portfolio;
      watchlist = tradeResult.watchlist;
      consensusSnapshot = tradeResult.consensusSnapshot;
      placed = tradeResult.placed;
      watchlistPlaced = tradeResult.watchlistPlaced;
      consensusExits = tradeResult.consensusExits;
      fetchOk = tradeResult.fetchOk ?? null;
      tradersTotal = tradeResult.tradersTotal ?? null;

      const cryptoResult = await runCryptoTrade(portfolio, scan.opportunities);
      portfolio = cryptoResult.portfolio;
      cryptoPlaced = cryptoResult.cryptoPlaced;
    }

    portfolio = await updateOpenPrices(portfolio, watchlist);

    if (portfolio.autoClose) {
      const closeResult = runAutoClose(portfolio);
      portfolio = closeResult.portfolio;
      closedCount = closeResult.closed;
      closeReasons = closeResult.reasons;
    }

    const sig = await updateSignalLog(scan.opportunities);
    signalsLogged = sig.logged;
    signalsResolved = sig.resolvedMarked;

    const runCount = await redis.incr(KEYS.RUN_COUNT);
    if (runCount % 6 === 0) {
      const scoutResult = await scoutInsiders(watchlist);
      watchlist = scoutResult.watchlist;
      scouted = scoutResult.added;
    }
  } catch (e) {
    console.error('Cron trade error:', e.message);
  }

  const round2 = n => Math.round(n * 100) / 100;
  const openValue = round2(portfolio.open.reduce((a, p) => a + p.shares * (p.currentPrice ?? p.entry), 0));

  const logEntry = {
    ts: Date.now(),
    placed, watchlistPlaced, consensusExits, cryptoPlaced, closed: closedCount, closeReasons, scouted,
    fetchOk, tradersTotal, signalsLogged, signalsResolved,
    openCount: portfolio.open.length,
    balance: round2(portfolio.balance),
    openValue,
    totalValue: round2(portfolio.balance + openValue),
  };

  const pipe = redis.pipeline();
  pipe.set(KEYS.PORTFOLIO, portfolio);
  pipe.set(KEYS.WATCHLIST, watchlist);
  pipe.set(KEYS.CONSENSUS_SNAPSHOT, consensusSnapshot);
  pipe.set(KEYS.LAST_RUN, Date.now());
  pipe.lpush(KEYS.RUN_LOG, JSON.stringify(logEntry));
  pipe.ltrim(KEYS.RUN_LOG, 0, 49);

  // Hourly mark-to-market point for the 30-day equity curve. The 55-min gate
  // also stops point spam from manual dashboard-triggered runs.
  try {
    const lastPoint = await redis.lindex(KEYS.EQUITY_LOG, 0);
    const lastTs = lastPoint ? (typeof lastPoint === 'string' ? JSON.parse(lastPoint) : lastPoint).ts : 0;
    if (!lastTs || Date.now() - lastTs > 55 * 60000) {
      pipe.lpush(KEYS.EQUITY_LOG, JSON.stringify({
        ts: Date.now(), balance: logEntry.balance, openValue, totalValue: logEntry.totalValue, openCount: portfolio.open.length,
      }));
      pipe.ltrim(KEYS.EQUITY_LOG, 0, 719);
    }
  } catch {}

  pipe.del(KEYS.ENGINE_LOCK);
  await pipe.exec();

  return res.status(200).json({ success: true, ...logEntry });
}
