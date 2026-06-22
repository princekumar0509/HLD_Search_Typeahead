// POST /search   body: { "query": "..." }
//
// The low-latency WRITE path. We do NOT touch Postgres here — we append to the
// Redis write-buffer queue and return immediately. The flusher worker turns many
// of these into one batched UPSERT later. This is the whole point of the batch
// -writes requirement: keep the user-facing write fast, protect Postgres.

import { Router } from 'express';
import { enqueueSearch } from '../lib/writeBuffer.js';

export const searchRouter = Router();

searchRouter.post('/search', async (req, res) => {
  const query = req.body?.query;

  // Validate but stay forgiving — reject only truly unusable input.
  if (typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'query must be a non-empty string' });
  }

  try {
    // Optional `ts` (ISO string): used ONLY by the load-test replayer so it can
    // preserve each event's original timestamp (and thus its day_bucket) for the
    // recency demo. Real UI submissions omit it and default to "now".
    const ts =
      typeof req.body?.ts === 'string' ? req.body.ts : new Date().toISOString();
    // Store the normalised (trimmed, lowercased) form so counts aggregate
    // correctly regardless of how the user typed it, matching the dataset.
    await enqueueSearch(query.trim().toLowerCase(), ts);
    // Dummy response exactly as the assignment specifies.
    res.json({ message: 'Searched', query });
  } catch (err) {
    console.error('[search] enqueue failed:', err);
    res.status(503).json({ error: 'search_unavailable' });
  }
});
