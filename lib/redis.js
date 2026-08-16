import { Redis } from '@upstash/redis';

export const redis = Redis.fromEnv();

export const KEYS = {
  PORTFOLIO: 'pm:portfolio',
  WATCHLIST: 'pm:watchlist',
  CONSENSUS_SNAPSHOT: 'pm:consensus_snapshot',
  LAST_RUN: 'pm:last_run',
  RUN_LOG: 'pm:run_log',
  RUN_COUNT: 'pm:run_count',
  ENGINE_LOCK: 'pm:engine_lock',
  SIGNAL_LOG: 'pm:signal_log',   // crypto-edge signals for model calibration, LTRIM 0 499
  EQUITY_LOG: 'pm:equity_log',   // hourly mark-to-market points, LTRIM 0 719 (~30 days)
};
