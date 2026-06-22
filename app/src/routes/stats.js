// GET /stats — instrumentation snapshot for the performance report.
//
// Surfaces the three numbers the assignment asks to be "measurable":
//   * cache hit rate
//   * Postgres read/write counts
//   * write-reduction from batching (submissions vs actual write statements)
// plus p95/p99 /suggest latency and the live write-queue depth.

import { Router } from 'express';
import { metrics } from '../lib/metrics.js';
import { queueDepth } from '../lib/writeBuffer.js';
import { ring } from '../lib/cache.js';

export const statsRouter = Router();

statsRouter.get('/stats', async (_req, res) => {
  try {
    const snapshot = await metrics.snapshot();
    res.json({
      ...snapshot,
      write_queue_depth: await queueDepth(),
      ring: { nodes: ring.nodeList, total_vnodes: ring.ringSize },
    });
  } catch (err) {
    console.error('[stats] error:', err);
    res.status(503).json({ error: 'stats_unavailable' });
  }
});

// Optional: reset counters between demo runs so numbers are easy to read.
statsRouter.post('/stats/reset', async (_req, res) => {
  await metrics.reset();
  res.json({ message: 'metrics reset' });
});
