// metrics.js — instrumentation for the /stats endpoint and viva talking points.
//
// Two kinds of metric:
//   * COUNTERS (cache hits/misses, pg reads/writes, search submissions, batched
//     writes) live in Redis so they are GLOBAL across the 3 app replicas and the
//     worker. Any replica serving /stats then reports a coherent system-wide view
//     instead of just its own slice. Redis INCR is atomic and ~microseconds.
//   * p95 LATENCY is a per-process in-memory rolling window. Latency is measured
//     where the request is served, and a simple ring buffer (no metrics stack) is
//     exactly what the brief asks for.

import { getRedis } from './redis.js';

const COUNTER_NAMES = [
  'cache_hits',
  'cache_misses',
  'pg_reads',
  'pg_writes', // number of batched UPSERT statements actually sent to Postgres
  'search_submissions', // raw POST /search count (the "before batching" number)
];

const counterKey = (name) => `metrics:${name}`;
// Rolling window of recent /suggest latencies, kept in a REDIS LIST (not an
// in-process array) so p95 is GLOBAL across the round-robin'd app replicas —
// otherwise /stats would only ever see the latencies of whichever replica
// happened to serve the /stats request (often zero).
const LAT_KEY = 'metrics:suggest_latency_ms';
let latencyCap = 1000;

function percentileOf(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return Number(sortedAsc[idx].toFixed(2));
}

export const metrics = {
  configure({ latencyWindow }) {
    latencyCap = latencyWindow || latencyCap;
  },

  async incr(name, by = 1) {
    try {
      await getRedis().incrby(counterKey(name), by);
    } catch {
      // Metrics must never break the request path. Swallow Redis hiccups.
    }
  },

  // Fire-and-forget: push the latency and trim the list back to the cap. Not
  // awaited by the request path so it adds no latency of its own.
  recordLatency(ms) {
    getRedis()
      .pipeline()
      .lpush(LAT_KEY, ms)
      .ltrim(LAT_KEY, 0, latencyCap - 1)
      .exec()
      .catch(() => {});
  },

  async snapshot() {
    const redis = getRedis();
    const raw = await redis.mget(COUNTER_NAMES.map(counterKey));
    const counters = {};
    COUNTER_NAMES.forEach((name, i) => {
      counters[name] = Number(raw[i] || 0);
    });

    const lat = (await redis.lrange(LAT_KEY, 0, -1))
      .map(Number)
      .sort((a, b) => a - b);

    const hits = counters.cache_hits;
    const misses = counters.cache_misses;
    const totalReads = hits + misses;

    // Write-reduction is the headline batch-writes metric: how many raw search
    // submissions collapsed into how many actual Postgres write statements.
    const submissions = counters.search_submissions;
    const writes = counters.pg_writes;

    return {
      cache: {
        hits,
        misses,
        hit_rate: totalReads ? Number((hits / totalReads).toFixed(4)) : 0,
      },
      postgres: {
        reads: counters.pg_reads,
        writes,
      },
      batch_writes: {
        search_submissions: submissions,
        postgres_write_statements: writes,
        // e.g. 50000 submissions / 120 writes = 416x fewer writes.
        write_reduction_factor:
          writes > 0 ? Number((submissions / writes).toFixed(1)) : null,
      },
      suggest_latency_ms: {
        samples: lat.length,
        p50: percentileOf(lat, 50),
        p95: percentileOf(lat, 95),
        p99: percentileOf(lat, 99),
      },
    };
  },

  async reset() {
    const redis = getRedis();
    await redis.del(...COUNTER_NAMES.map(counterKey), LAT_KEY);
  },
};

export default metrics;
