// GET /health — liveness check used by docker-compose healthchecks and nginx.
// Confirms BOTH backing stores are reachable from this app instance.

import { Router } from 'express';
import { pingDb } from '../lib/db.js';
import { pingRedis } from '../lib/redis.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const result = { status: 'ok', postgres: false, redis: false };
  try {
    result.postgres = await pingDb();
  } catch {
    result.status = 'degraded';
  }
  try {
    result.redis = await pingRedis();
  } catch {
    result.status = 'degraded';
  }
  res.status(result.postgres && result.redis ? 200 : 503).json(result);
});
