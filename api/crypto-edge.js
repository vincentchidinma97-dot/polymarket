import { scanCryptoEdges } from '../lib/engine/crypto-edge.js';

export default async function handler(req, res) {
  try {
    const { opportunities, stats } = await scanCryptoEdges();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      opportunities: opportunities.slice(0, 40).map(({ yesRaw, noRaw, edgeRaw, ...o }) => o),
      stats,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
