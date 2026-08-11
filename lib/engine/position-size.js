import {
  PAPER_STARTING_BALANCE, MAX_EXPOSURE_PCT,
  TIER_ELITE, TIER_STRONG,
} from '../constants.js';

export function positionSize(balance, openPositions, tier, traders) {
  const maxInvest = PAPER_STARTING_BALANCE * MAX_EXPOSURE_PCT;
  const invested = openPositions.reduce((a, p) => a + p.cost, 0);
  const room = maxInvest - invested;
  if (room < 10) return 0;

  let size;
  if (traders >= 20) size = Math.min(balance * 0.15, 800);
  else if (traders >= TIER_ELITE) size = Math.min(balance * 0.10, 600);
  else if (traders >= TIER_STRONG) size = Math.min(balance * 0.06, 400);
  else if (tier === 'watchlist') size = Math.min(balance * 0.03, 200);
  else size = Math.min(balance * 0.02, 100);

  return Math.min(size, room);
}

export function tradeLabel(traders, source) {
  if (source === 'watchlist') return 'watchlist';
  if (traders >= 20) return 'elite';
  if (traders >= TIER_ELITE) return 'high';
  return 'strong';
}
