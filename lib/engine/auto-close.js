import {
  TAKE_PROFIT_PCT, STOP_LOSS_PCT, TRAILING_STOP_TRIGGER,
} from '../constants.js';

export function runAutoClose(portfolio) {
  if (!portfolio.autoClose) return { portfolio, closed: 0, reasons: {} };

  const toClose = [];
  for (let i = portfolio.open.length - 1; i >= 0; i--) {
    const pos = portfolio.open[i];
    // ?? not ||: a resolved losing outcome legitimately prices at 0
    const cur = pos.currentPrice ?? pos.entry;
    const val = pos.shares * cur;
    const pnlPct = (val - pos.cost) / pos.cost;

    if (!pos.highWaterMark || cur > pos.highWaterMark) pos.highWaterMark = cur;

    const ageMs = Date.now() - (pos.openedAt || 0);
    const priceNeverMoved = pos.currentPrice == null || pos.currentPrice === pos.entry;
    // Crypto positions hold to resolution: the model's edge is about the final
    // outcome, and stops on near-dated binaries just sell intraday noise.
    const holdToResolution = pos.source === 'crypto';

    let reason = null;
    if (pos.resolved) {
      reason = 'resolved';
    } else if (pnlPct >= TAKE_PROFIT_PCT) {
      reason = 'take-profit';
    } else if (pnlPct <= STOP_LOSS_PCT && !holdToResolution) {
      reason = 'stop-loss';
    } else if (!holdToResolution && pos.highWaterMark > pos.entry) {
      const peakPnlPct = (pos.shares * pos.highWaterMark - pos.cost) / pos.cost;
      if (peakPnlPct >= TRAILING_STOP_TRIGGER && cur <= pos.entry) {
        reason = 'trailing-stop';
      }
    } else if (!pos.slug && priceNeverMoved && ageMs > 48 * 3600000) {
      // Untrackable position (no slug, price feed never found it) — free the slot
      reason = 'stale-exit';
    }

    if (reason) toClose.push({ idx: i, reason });
  }

  const reasons = {};
  for (const { idx, reason } of toClose) {
    const pos = portfolio.open[idx];
    const cur = pos.currentPrice ?? pos.entry;
    const val = pos.shares * cur;
    const pnl = val - pos.cost;
    portfolio.balance += val;
    portfolio.closed.push({
      ...pos, closedAt: Date.now(), exitPrice: cur, pnl, value: val, closeReason: reason,
    });
    portfolio.open.splice(idx, 1);
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  return { portfolio, closed: toClose.length, reasons };
}
