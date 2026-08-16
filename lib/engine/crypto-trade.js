import { scanCryptoEdges } from './crypto-edge.js';
import { MAX_EXPOSURE_PCT, MAX_POSITIONS, PAPER_STARTING_BALANCE } from '../constants.js';

const MIN_EDGE = 0.10;          // model must disagree by 10c or more
const MAX_CRYPTO_POSITIONS = 4; // keep the experiment small
const MIN_DAYS_OUT = 2;         // same-day binaries whipsaw every stop mechanism
const MAX_DAYS_OUT = 60;        // fast feedback: only near-dated markets
const POSITION_CAP = 150;       // dollars per trade

export async function runCryptoTrade(portfolio, opportunities = null) {
  if (portfolio.cryptoTrade === false || portfolio.balance < 10) {
    return { portfolio, cryptoPlaced: 0 };
  }

  const openCrypto = portfolio.open.filter(p => p.source === 'crypto');
  if (openCrypto.length >= MAX_CRYPTO_POSITIONS) return { portfolio, cryptoPlaced: 0 };

  let cryptoPlaced = 0;
  try {
    if (!opportunities) ({ opportunities } = await scanCryptoEdges());

    for (const o of opportunities) {
      if (portfolio.open.length >= MAX_POSITIONS) break;
      if (portfolio.open.filter(p => p.source === 'crypto').length >= MAX_CRYPTO_POSITIONS) break;
      if (Math.abs(o.edgeRaw) < MIN_EDGE) continue;

      const daysOut = (new Date(o.endDate).getTime() - Date.now()) / 86400000;
      if (!Number.isFinite(daysOut) || daysOut < MIN_DAYS_OUT || daysOut > MAX_DAYS_OUT) continue;

      // Underpriced YES -> buy Yes; overpriced YES -> buy No
      const buyYes = o.edgeRaw > 0;
      const entry = buyYes ? o.yesRaw : o.noRaw;
      if (entry <= 0.10 || entry >= 0.95) continue; // tail bets are vol-misspecification traps

      // TA veto (Strategy toggle, default on): skip when the stance opposes
      // the bet's direction. 'against' already implies a strong stance — the
      // label threshold lives in computeTa. Neutral/unknown pass: the
      // vol-model edge decides alone.
      if (portfolio.cryptoTaFilter !== false && o.taAlignment === 'against') continue;

      const outcome = buyYes ? 'Yes' : 'No';
      const tradeKey = `${o.question}|||${outcome}`;
      if (portfolio.open.some(p => p.key === tradeKey)) continue;
      if (portfolio.open.some(p => p.slug === o.slug)) continue; // one bet per market
      if (portfolio.closed.some(p => p.key === tradeKey && Date.now() - p.closedAt < 86400000)) continue;

      const invested = portfolio.open.reduce((a, p) => a + p.cost, 0);
      const room = PAPER_STARTING_BALANCE * MAX_EXPOSURE_PCT - invested;
      const size = Math.min(portfolio.balance * 0.03, POSITION_CAP, room);
      if (size < 5) break;

      const shares = size / entry;
      portfolio.open.push({
        key: tradeKey, title: o.question, outcome, slug: o.slug,
        entry, shares, cost: size,
        strength: 'crypto', traders: 0, source: 'crypto',
        modelPrice: buyYes ? o.model : Math.round((1 - o.model) * 100) / 100,
        edge: buyYes ? o.edge : -o.edge, // stored relative to the side we hold
        taAlignment: o.taAlignment || 'neutral',

        openedAt: Date.now(), highWaterMark: entry,
      });
      portfolio.balance -= size;
      cryptoPlaced++;
      if (cryptoPlaced >= 2) break; // at most 2 new crypto bets per run
    }
  } catch {}

  return { portfolio, cryptoPlaced };
}
