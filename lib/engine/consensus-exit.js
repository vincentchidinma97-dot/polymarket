import { CONSENSUS_EXIT_THRESHOLD } from '../constants.js';

export function detectConsensusExits(portfolio, previousSnapshot, currentConsensus) {
  const exits = [];
  for (const pos of portfolio.open) {
    if (pos.source !== 'consensus') continue;
    const prev = previousSnapshot[pos.key];
    const now = currentConsensus[pos.key];
    if (prev && prev >= CONSENSUS_EXIT_THRESHOLD) {
      const dropped = prev - (now || 0);
      if (dropped >= CONSENSUS_EXIT_THRESHOLD) {
        exits.push(pos);
      }
    }
  }
  return exits;
}
