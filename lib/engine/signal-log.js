import { redis, KEYS } from '../redis.js';
import { fetchGammaBySlug } from './price-update.js';

const LOG_CAP = 500;
const MAX_RESOLUTION_SLUGS = 40; // 2 gamma chunk calls per run, budgeted
const MAX_CHECKS = 6;            // give up on markets gamma never closes

const parse = r => (typeof r === 'string' ? JSON.parse(r) : r);

// Records every flagged crypto-edge signal once (at first flag — calibration
// measures the model at signal time) and later marks how the market resolved,
// so model probability can be compared against realized frequency.
// Called from the cron while ENGINE_LOCK is held; must never throw.
export async function updateSignalLog(opportunities) {
  let logged = 0, resolvedMarked = 0;
  try {
    const raw = await redis.lrange(KEYS.SIGNAL_LOG, 0, -1);
    const records = (raw || []).map(parse).filter(Boolean);
    const existing = new Set(records.map(r => r.id));

    for (const o of opportunities || []) {
      if (!o.slug || !o.endDate) continue;
      const id = `${o.slug}|${o.endDate}`;
      if (existing.has(id)) continue;
      if (Date.parse(o.endDate) <= Date.now()) continue; // already past; outcome unknowable at flag time
      records.unshift({
        id, slug: o.slug, question: o.question, kind: o.kind,
        coin: o.coin, strike: o.strike, endDate: o.endDate,
        market: o.market, model: o.model,
        vol: o.vol ?? null, spot: o.spot ?? null, volSource: o.volSource || 'realized',
        ts: Date.now(),
        outcome: null, resolvedAt: null, checks: 0,
      });
      existing.add(id);
      logged++;
    }

    let checksBumped = 0;
    const due = records.filter(r => r.outcome === null && r.checks < MAX_CHECKS && Date.parse(r.endDate) < Date.now());
    if (due.length) {
      const batch = due.slice(0, MAX_RESOLUTION_SLUGS);
      const markets = await fetchGammaBySlug([...new Set(batch.map(r => r.slug))]);
      for (const r of due.slice(0, MAX_RESOLUTION_SLUGS)) {
        const m = markets.get(r.slug);
        const closed = m && (m.closed === true || m.closed === 'True' || m.closed === 'true');
        if (closed) {
          try {
            const yes = parseFloat(JSON.parse(m.outcomePrices)[0]);
            if (Number.isFinite(yes)) {
              r.outcome = yes >= 0.5 ? 1 : 0;
              r.resolvedAt = Date.now();
              resolvedMarked++;
              continue;
            }
          } catch {}
        }
        r.checks = (r.checks || 0) + 1;
        checksBumped++;
      }
    }

    if (logged || resolvedMarked || checksBumped || records.length !== (raw || []).length) {
      const trimmed = records.slice(0, LOG_CAP);
      const pipe = redis.pipeline();
      pipe.del(KEYS.SIGNAL_LOG);
      if (trimmed.length) pipe.rpush(KEYS.SIGNAL_LOG, ...trimmed.map(r => JSON.stringify(r)));
      pipe.ltrim(KEYS.SIGNAL_LOG, 0, LOG_CAP - 1);
      await pipe.exec();
    }
  } catch {}
  return { logged, resolvedMarked };
}
