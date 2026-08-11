const DATA_API = 'https://data-api.polymarket.com';
const UA = 'polymarket-tracker/1.0';

async function pmFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${DATA_API}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`polymarket ${path}: HTTP ${r.status}`);
  return r.json();
}

export function fetchLeaderboard(window = '1w', rankType = 'pnl', limit = 50) {
  return pmFetch('/v1/leaderboard', { window, rankType, limit });
}

export function fetchPositions(wallet, limit = 200, sortBy, sortDirection) {
  const params = { user: wallet, limit };
  if (sortBy) params.sortBy = sortBy;
  if (sortDirection) params.sortDirection = sortDirection;
  return pmFetch('/positions', params);
}

export function fetchTrades(wallet, limit = 20, takerOnly = true) {
  return pmFetch('/trades', { user: wallet, limit, takerOnly: String(takerOnly) });
}
