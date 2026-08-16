import { PAPER_STARTING_BALANCE } from './constants.js';

// Single source of truth for the portfolio shape and every setting default.
// Load sites merge stored state over this (`{ ...defaultPortfolio(), ...stored }`)
// so older portfolios pick up new settings without per-read-site fallbacks.
// Note: takeProfitPct/stopLossPct may legitimately be null (= off / hold to
// resolution) — a stored null must survive the merge, which spread preserves.
export function defaultPortfolio() {
  return {
    balance: PAPER_STARTING_BALANCE, open: [], closed: [],
    autoTrade: true, mirrorWatchlist: true, autoClose: true,
    cryptoTrade: true, cryptoTaFilter: true,
    minConsensus: 6,
    takeProfitPct: 0.25, stopLossPct: 0.20,
    created: Date.now(),
  };
}

export function normalizePortfolio(stored) {
  return { ...defaultPortfolio(), ...(stored || {}) };
}
