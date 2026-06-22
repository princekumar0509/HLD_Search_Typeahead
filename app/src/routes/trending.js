// GET /trending  — top trending queries OVERALL (not prefix-scoped).
//
// Convenience endpoint for the UI's "Trending searches" panel. Reads straight
// from Postgres ordered by trending_score; it's a single small query and not on
// the per-keystroke hot path, so it is not cached.

import { Router } from 'express';
import { getTopTrending } from '../lib/db.js';
import { config } from '../config.js';

export const trendingRouter = Router();

trendingRouter.get('/trending', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || config.suggestLimit, 50);
  try {
    const items = await getTopTrending(limit);
    res.json({ count: items.length, trending: items });
  } catch (err) {
    console.error('[trending] error:', err);
    res.status(503).json({ error: 'trending_unavailable' });
  }
});
