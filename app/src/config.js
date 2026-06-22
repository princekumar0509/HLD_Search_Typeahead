// config.js — single source of truth for every tunable constant in the system.
//
// WHY a central config: the assignment must be explainable in a viva. Every
// "magic number" (decay factor, TTL, batch size) is named here with a comment
// explaining the trade-off, rather than scattered as literals across modules.

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

export const config = {
  // ---- HTTP ----
  port: num(process.env.PORT, 3000),

  // ---- Postgres (source of truth) ----
  // A single connection string; the pg Pool multiplexes across app requests.
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://typeahead:typeahead@localhost:5432/typeahead',

  // ---- Redis (cache layer + write-buffer queue) ----
  // We deliberately use ONE physical Redis instance but partition it into
  // multiple LOGICAL cache nodes (see cacheNodes below). Consistent hashing
  // decides which logical node owns a prefix; the logical node id is baked into
  // the Redis key namespace. This satisfies the "distributed cache across
  // multiple logical nodes" requirement while keeping the demo to one container.
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // ---- Consistent hashing ----
  // The logical cache nodes that sit on the hash ring. Adding/removing a name
  // here (and restarting) remaps only ~1/N of prefixes, which the demo script
  // proves. Names are arbitrary labels; what matters is their position on the ring.
  cacheNodes: (process.env.CACHE_NODES || 'cache-a,cache-b,cache-c')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Virtual nodes (replicas) per physical node. ~100-150 gives a smooth,
  // low-variance key distribution; too few => lumpy distribution, too many =>
  // a larger ring to binary-search. 150 is the textbook sweet spot.
  vnodesPerNode: num(process.env.VNODES_PER_NODE, 150),

  // ---- Cache behaviour ----
  // Per-key TTL. Cache-aside means stale data self-heals within this window even
  // if an invalidation is somehow missed. 5 min balances freshness vs hit rate.
  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, 300),
  // Max suggestions returned/cached per prefix. Assignment requires "up to 10".
  suggestLimit: num(process.env.SUGGEST_LIMIT, 10),
  // Upper bound on the length of a prefix we'll cache. Generous (covers typical
  // multi-word queries) so a repeatedly-searched query actually caches and
  // produces hits; it only exists to stop a flood of very long one-off prefixes
  // from bloating the cache. Reads still work for ANY length — this only bounds
  // what we store. TTL bounds total memory regardless.
  maxCacheablePrefixLen: num(process.env.MAX_CACHEABLE_PREFIX_LEN, 32),

  // ---- Write buffer / batch flusher ----
  // The Redis LIST that POST /search pushes onto. A shared queue (not in-process)
  // so any of the N app replicas can enqueue and the single worker drains it.
  queueKey: process.env.QUEUE_KEY || 'search:queue',
  // Flush triggers — whichever fires first:
  //   - time: bound staleness/latency of writes to at most this interval.
  //   - size: bound memory and give large bursts a fast path to Postgres.
  flushIntervalMs: num(process.env.FLUSH_INTERVAL_MS, 5000),
  flushMaxBatch: num(process.env.FLUSH_MAX_BATCH, 1000),

  // ---- Trending (forward exponential decay) ----
  // We rank trending by FORWARD DECAY (Cormode et al. 2009): each search event
  // at day d contributes weight (1/DECAY)^(d - epoch) to the query's
  // trending_score accumulator. The decayed-to-now score is
  // trending_score * DECAY^(now - epoch); since that factor is the SAME for
  // every query, ranking by the raw accumulator == ranking by exponentially
  // decayed counts. This lets the flusher update trending_score INCREMENTALLY at
  // write time (so a freshly-searched query trends immediately) and lets reads
  // rank with a plain ORDER BY — no periodic full-table decay sweep required.
  // An event d days old effectively weighs DECAY^d, so old spikes fade.
  //
  // 0.85 => 15%/day decay. Lower values fade older activity faster.
  decayFactor: num(process.env.DECAY_FACTOR, 0.85),
  // Fixed reference date for the forward-decay weights. Must be stable (the
  // flusher and the reconciliation job both use it). Weights grow as
  // (1/DECAY)^(today - epoch); with 0.85 this stays in safe double range for
  // ~12 years past the epoch, well beyond any demo horizon.
  decayEpoch: process.env.DECAY_EPOCH || '2026-06-01',
  // How often the reconciliation job re-derives trending_score from
  // daily_search_counts (idempotent; guards against drift from lost flushes).
  // Trending liveness does NOT depend on this — the flusher keeps it current.
  decayIntervalMs: num(process.env.DECAY_INTERVAL_MS, 60 * 60 * 1000),

  // ---- Instrumentation ----
  // Rolling window size for the p95 latency tracker (last N /suggest requests).
  latencyWindow: num(process.env.LATENCY_WINDOW, 1000),
};

export default config;
