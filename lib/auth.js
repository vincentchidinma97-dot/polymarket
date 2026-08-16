import { timingSafeEqual } from 'crypto';

function safeEq(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Single-user dashboard auth: one shared key set in DASHBOARD_SECRET,
// sent by the browser as x-dashboard-key. Fail-closed: no env var, no access.
export function hasDashboardAuth(req) {
  const secret = process.env.DASHBOARD_SECRET;
  return !!secret && safeEq(req.headers['x-dashboard-key'], secret);
}

// External cron (cron-job.org) auth. The query-string form remains supported
// because the service cannot reliably send custom headers; the exposure is
// machine-to-machine URLs (provider dashboard + server logs), not browsers —
// no referrers or history. Use a secret distinct from DASHBOARD_SECRET.
export function hasCronAuth(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEq(bearer, secret) || safeEq(req.query.key, secret);
}
