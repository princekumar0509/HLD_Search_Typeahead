// GET /suggest?q=<prefix>&mode=basic|trending
//
// The headline read endpoint. Same API, two ranking modes (the two-counter
// model): mode=basic sorts by all_time_count, mode=trending by trending_score.
// Goes through the cache-aside layer, and is instrumented for p95 latency.

import { Router } from 'express';
import { getSuggestions } from '../lib/cache.js';
import { metrics } from '../lib/metrics.js';
import { config } from '../config.js';

export const suggestRouter = Router();

suggestRouter.get('/suggest', async (req, res) => {
  const start = process.hrtime.bigint();

  // Handle empty / missing input gracefully: an empty array, NOT an error.
  const rawQ = req.query.q;
  const mode = req.query.mode === 'trending' ? 'trending' : 'basic';

  if (rawQ === undefined || rawQ === null || `${rawQ}`.trim() === '') {
    return res.json({ query: '', mode, count: 0, suggestions: [] });
  }

  try {
    const { suggestions, cacheHit, node } = await getSuggestions(
      `${rawQ}`,
      mode,
      config.suggestLimit
    );

    // Latency is measured around the whole handler and fed to the rolling p95.
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.recordLatency(ms);

    res.json({
      query: `${rawQ}`,
      mode,
      count: suggestions.length,
      cache: { hit: cacheHit, node },
      latency_ms: Number(ms.toFixed(2)),
      suggestions,
    });
  } catch (err) {
    console.error('[suggest] error:', err);
    res.status(503).json({ error: 'suggestion_unavailable' });
  }
});
