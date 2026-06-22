// GET /top?limit=10 — the two leaderboards the UI shows side by side:
//   trending: top by trending_score (forward-decayed recent activity)
//   popular:  top by all_time_count (lifetime popularity)
//
// One round trip returns both so the front-end can render the comparison table
// and demonstrate the difference between recency-aware and all-time ranking.
// Read straight from Postgres (small, not on the per-keystroke hot path).

import { Router } from 'express';
import { getTopTrending, getTopPopular } from '../lib/db.js';
import { config } from '../config.js';

export const topRouter = Router();

topRouter.get('/top', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || config.suggestLimit, 50);
  try {
    const [trending, popular] = await Promise.all([
      getTopTrending(limit),
      getTopPopular(limit),
    ]);
    res.json({ trending, popular });
  } catch (err) {
    console.error('[top] error:', err);
    res.status(503).json({ error: 'top_unavailable' });
  }
});
