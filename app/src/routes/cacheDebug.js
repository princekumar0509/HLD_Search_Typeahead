// GET /cache/debug?prefix=<prefix>
//
// Proves the consistent-hashing requirement concretely: for any prefix it shows
// which LOGICAL cache node owns it (via the ring) and whether that prefix is
// currently a cache HIT or MISS in each mode. Great for the viva — you can type
// a prefix and point at the node that owns it.

import { Router } from 'express';
import { ownerNode, isCached, ring, normalizePrefix, ringDistribution } from '../lib/cache.js';

export const cacheDebugRouter = Router();

// GET /cache/ring — sampled keyspace distribution across logical nodes, for the
// dashboard's consistent-hash visualization.
cacheDebugRouter.get('/cache/ring', (req, res) => {
  const sample = Math.min(Math.max(Number(req.query.sample) || 50000, 1000), 200000);
  res.json(ringDistribution(sample));
});

cacheDebugRouter.get('/cache/debug', async (req, res) => {
  const prefix = `${req.query.prefix ?? ''}`;
  const norm = normalizePrefix(prefix);

  if (norm === '') {
    return res.status(400).json({ error: 'prefix query param is required' });
  }

  try {
    const node = ownerNode(norm);
    const [basicHit, trendingHit] = await Promise.all([
      isCached(norm, 'basic'),
      isCached(norm, 'trending'),
    ]);

    res.json({
      prefix: norm,
      owner_node: node,
      cache_state: {
        basic: basicHit ? 'hit' : 'miss',
        trending: trendingHit ? 'hit' : 'miss',
      },
      ring: { nodes: ring.nodeList, total_vnodes: ring.ringSize },
    });
  } catch (err) {
    console.error('[cache/debug] error:', err);
    res.status(503).json({ error: 'cache_debug_unavailable' });
  }
});
