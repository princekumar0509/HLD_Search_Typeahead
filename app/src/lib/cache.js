// cache.js — the distributed cache layer (cache-aside, ZSET-valued).
//
// Read path for /suggest:
//   1. Normalise the prefix.
//   2. Ask the consistent-hash ring which LOGICAL node owns this prefix.
//   3. Look in that node's namespace for a cached ZSET of suggestions.
//        HIT  -> return it (ZREVRANGE, sorted natively by Redis).
//        MISS -> read Postgres, repopulate the ZSET, set a TTL, return.
//
// WHY ZSETs and not a JSON list: a sorted set lets Redis keep the ranking for us
// (ZADD score member) and serve the top-10 with ZREVRANGE ... WITHSCORES. No
// read-modify-write race on a blob value, and trivially correct ordering.
//
// WHY cache-aside + invalidate (not write-through): we never patch cached ZSETs
// on each write. After a batch flush or decay run we DELETE affected keys; the
// next read recomputes from the source of truth. Far simpler to reason about
// than keeping N cached rankings incrementally consistent, and it satisfies the
// "cache must support expiry/invalidation" requirement directly.

import { getRedis } from './redis.js';
import { ConsistentHashRing } from './consistentHash.js';
import { getSuggestionsFromDb } from './db.js';
import { metrics } from './metrics.js';
import { config } from '../config.js';

// One ring per process, built from config. Every replica builds the SAME ring
// (same node list, same vnode labels, deterministic hash) so they all agree on
// which node owns a prefix — that agreement is what makes the cache shared.
const ring = new ConsistentHashRing(config.cacheNodes, config.vnodesPerNode);

// Normalise so "Iphone", "iphone ", "IPHONE" all hit the same cache entry and
// match the lowercase dataset. Routing AND the key use this normalised form.
export function normalizePrefix(q) {
  return (q ?? '').toString().trim().toLowerCase();
}

// Which logical cache node owns this prefix (used by /cache/debug too).
export function ownerNode(prefix) {
  return ring.getNode(normalizePrefix(prefix));
}

// Key layout: cache:<logicalNode>:suggest:<mode>:<prefix>
// Embedding the node id in the key is what makes this a *partitioned* cache —
// the ring picks the node, the node names the keyspace partition.
function cacheKey(node, mode, prefix) {
  return `cache:${node}:suggest:${mode}:${prefix}`;
}

// True if this prefix currently has a populated cache entry (for /cache/debug).
export async function isCached(prefix, mode) {
  const norm = normalizePrefix(prefix);
  const key = cacheKey(ownerNode(norm), mode, norm);
  return (await getRedis().exists(key)) === 1;
}

// The /suggest read path. Returns { suggestions, cacheHit, node }.
export async function getSuggestions(rawPrefix, mode, limit = config.suggestLimit) {
  const prefix = normalizePrefix(rawPrefix);
  const node = ring.getNode(prefix);
  const redis = getRedis();
  const key = cacheKey(node, mode, prefix);

  // --- try cache ---
  const cached = await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
  if (cached.length > 0) {
    await metrics.incr('cache_hits');
    return { suggestions: parseZset(cached), cacheHit: true, node };
  }

  // --- miss: recompute from Postgres ---
  await metrics.incr('cache_misses');
  const rows = await getSuggestionsFromDb(prefix, mode, limit);

  // Repopulate only when there's something to cache and the prefix is short
  // enough to be worth caching. Empty results are intentionally NOT cached
  // (rare, and avoids a negative-cache layer we'd have to explain) — they
  // simply re-miss next time and return [] gracefully.
  if (rows.length > 0 && prefix.length <= config.maxCacheablePrefixLen) {
    const pipeline = redis.pipeline();
    // ZADD score1 member1 score2 member2 ... — Redis stores the ranking.
    const args = [];
    for (const r of rows) args.push(r.score, r.query);
    pipeline.del(key); // clear any partial/stale state first
    pipeline.zadd(key, ...args);
    pipeline.expire(key, config.cacheTtlSeconds);
    await pipeline.exec();
  }

  return {
    suggestions: rows.map((r) => ({ query: r.query, score: r.score })),
    cacheHit: false,
    node,
  };
}

// ZREVRANGE WITHSCORES returns a flat [member, score, member, score, ...].
function parseZset(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ query: flat[i], score: Number(flat[i + 1]) });
  }
  return out;
}

// Invalidate BOTH modes for a single prefix (used by the flusher after writes
// touch queries under that prefix). DELETE, don't patch — next read recomputes.
export async function invalidatePrefix(prefix) {
  const norm = normalizePrefix(prefix);
  const node = ownerNode(norm);
  await getRedis().del(
    cacheKey(node, 'basic', norm),
    cacheKey(node, 'trending', norm)
  );
}

// Invalidate the cache keys for every prefix that could contain any of the
// given queries. Used by the flusher after a batch of writes: a query like
// "iphone" can appear in the cached results for prefixes i, ip, iph, ... so each
// of those (up to maxCacheablePrefixLen) must be dropped and recomputed.
//
// The flusher only changes all_time_count + daily counts (basic-mode ranking),
// so it passes modes=['basic']; trending rankings are owned by the decay job.
export async function invalidatePrefixesForQueries(queries, modes = ['basic', 'trending']) {
  const prefixes = new Set();
  for (const q of queries) {
    const norm = normalizePrefix(q);
    const maxLen = Math.min(norm.length, config.maxCacheablePrefixLen);
    for (let len = 1; len <= maxLen; len++) prefixes.add(norm.slice(0, len));
  }

  const redis = getRedis();
  const keys = [];
  for (const p of prefixes) {
    const node = ownerNode(p);
    for (const mode of modes) keys.push(cacheKey(node, mode, p));
  }
  // DEL in chunks so one huge batch can't build an unbounded command.
  for (let i = 0; i < keys.length; i += 500) {
    if (keys.length) await redis.del(...keys.slice(i, i + 500));
  }
  return { prefixesInvalidated: prefixes.size, keysDeleted: keys.length };
}

// Invalidate every trending-mode cache key (used by the decay job, which can
// shift trending rankings everywhere at once). SCAN avoids blocking Redis with
// KEYS on a large keyspace. The decay job runs infrequently and off the hot
// path, so a full trending sweep is the simplest safe choice.
export async function invalidateAllTrending() {
  const redis = getRedis();
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      'cache:*:suggest:trending:*',
      'COUNT',
      500
    );
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');
  return deleted;
}

// Sampled keyspace distribution across the logical nodes — for the UI's ring
// visualization. We route `sample` synthetic keys through the SAME ring the
// cache uses and count how many land on each node; with virtual nodes these
// shares should be roughly even. (Sampling mirrors scripts/demo_consistent_hash.js.)
export function ringDistribution(sample = 10000) {
  const counts = Object.fromEntries(ring.nodeList.map((n) => [n, 0]));
  for (let i = 0; i < sample; i++) counts[ring.getNode(`key:${i}`)]++;
  return {
    sample,
    total_vnodes: ring.ringSize,
    nodes: ring.nodeList.map((n) => ({
      node: n,
      keys: counts[n],
      share: Number((counts[n] / sample).toFixed(4)),
    })),
  };
}

export { ring };
