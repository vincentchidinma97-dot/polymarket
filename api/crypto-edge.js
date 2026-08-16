import { scanCryptoEdges } from '../lib/engine/crypto-edge.js';

async function computeCalibration() {
  try {
    const { redis, KEYS } = await import('../lib/redis.js');
    const raw = await redis.lrange(KEYS.SIGNAL_LOG, 0, -1);
    const records = (raw || []).map(r => (typeof r === 'string' ? JSON.parse(r) : r)).filter(Boolean);
    const resolved = records.filter(r => r.outcome === 0 || r.outcome === 1);
    const pending = records.filter(r => r.outcome === null || r.outcome === undefined).length;

    const buckets = [0, 1, 2, 3, 4].map(i => ({ lo: i * 20, hi: (i + 1) * 20, n: 0, avgModel: 0, freq: 0 }));
    let brierSum = 0;
    for (const r of resolved) {
      brierSum += (r.model - r.outcome) ** 2;
      const b = buckets[Math.min(4, Math.floor(r.model * 5))];
      b.n++; b.avgModel += r.model; b.freq += r.outcome;
    }
    for (const b of buckets) {
      if (b.n) { b.avgModel = Math.round((b.avgModel / b.n) * 100) / 100; b.freq = Math.round((b.freq / b.n) * 100) / 100; }
    }
    return {
      resolved: resolved.length,
      pending,
      brier: resolved.length ? Math.round((brierSum / resolved.length) * 10000) / 10000 : null,
      buckets,
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  try {
    const [{ opportunities, stats }, calibration] = await Promise.all([
      scanCryptoEdges(),
      computeCalibration(),
    ]);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      opportunities: opportunities.slice(0, 40).map(({ yesRaw, noRaw, edgeRaw, ...o }) => o),
      stats,
      calibration,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
