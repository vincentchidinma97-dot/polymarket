import { Redis } from '@upstash/redis';

export const redis = Redis.fromEnv();

export const KEYS = {
  PORTFOLIO: 'pm:portfolio',
  WATCHLIST: 'pm:watchlist',
  CONSENSUS_SNAPSHOT: 'pm:consensus_snapshot',
  LAST_RUN: 'pm:last_run',
  RUN_LOG: 'pm:run_log',
  RUN_COUNT: 'pm:run_count',
};
