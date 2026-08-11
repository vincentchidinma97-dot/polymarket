import {
  TAKE_PROFIT_PCT, STOP_LOSS_PCT, TRAILING_STOP_TRIGGER,
} from '../constants.js';

export function runAutoClose(portfolio) {
  if (!portfolio.autoClose) return { portfolio, closed: 0, reasons: {} };

  const toClose = [];
  for (let i = portfolio.open.length - 1; i >= 0; i--) {
    const pos = portfolio.open[i];
    const cur = pos.currentPrice || pos.entry;
    const val = pos.shares * cur;
    const pnlPct = (val - pos.cost) / pos.cost;

    if (!pos.highWaterMark || cur > pos.highWaterMark) pos.highWaterMark = cur;

    let reason = null;
    if (pnlPct >= TAKE_PROFIT_PCT) {
      reason = 'take-profit';
    } else if (pnlPct <= STOP_LOSS_PCT) {
      reason = 'stop-loss';
    } else if (pos.highWaterMark > pos.entry) {
      const peakPnlPct = (pos.shares * pos.highWaterMark - pos.cost) / pos.cost;
      if (peakPnlPct >= TRAILING_STOP_TRIGGER && cur <= pos.entry) {
        reason = 'trailing-stop';
      }
    }

    if (reason) toClose.push({ idx: i, reason });
  }

  const reasons = {};
  for (const { idx, reason } of toClose) {
    const pos = portfolio.open[idx];
    const cur = pos.currentPrice || pos.entry;
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
