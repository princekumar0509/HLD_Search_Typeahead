// writeBuffer.js — the producer side of the batch-write pipeline.
//
// POST /search calls enqueueSearch() and returns IMMEDIATELY. The actual
// Postgres write happens later, in bulk, in the flusher worker.
//
// WHY a Redis LIST and not an in-process array: there are N stateless app
// replicas behind nginx. An in-process queue would give each replica its own
// buffer that the single flusher can't see, so writes would be lost or
// uncoordinated. A shared Redis LIST is the rendezvous point — any replica
// RPUSHes, the one worker LPOPs. (Redis is already in the stack; no extra broker
// is justified — see brief §8 "no message broker beyond Redis".)

import { getRedis } from './redis.js';
import { config } from '../config.js';
import { metrics } from './metrics.js';

// Append one search event to the tail of the queue. O(1), fire-and-forget fast.
// We store the timestamp so the flusher can attribute counts to the right
// day_bucket for the trending/decay machinery.
export async function enqueueSearch(query, ts = new Date().toISOString()) {
  const entry = JSON.stringify({ query, ts });
  await getRedis().rpush(config.queueKey, entry);
  await metrics.incr('search_submissions');
}

// Current queue depth — handy for /stats and for the flusher's size trigger.
export async function queueDepth() {
  return getRedis().llen(config.queueKey);
}
