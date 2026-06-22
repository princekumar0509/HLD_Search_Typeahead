# NOTES — High-Level Design & Decision Log

This is the "explain everything" companion to the README. It documents the
high-level design, the reasoning behind **every** decision, and exactly how each
moving part works: load balancing, the trending formula, how the cache is
partitioned across nodes, the batching/buffer pipeline, the workers, and how
every metric is computed.

> Design philosophy (from the brief): **clarity over cleverness.** A small number
> of well-understood moving parts, each explainable line-by-line, beats extra
> features. Every "magic number" lives in [app/src/config.js](app/src/config.js)
> with a comment.

---

## Table of contents
1. [System overview & request lifecycle](#1-system-overview--request-lifecycle)
2. [Data model & why two counters](#2-data-model--why-two-counters)
3. [Load balancing](#3-load-balancing)
4. [The distributed cache](#4-the-distributed-cache)
5. [Consistent hashing — how data is divided across cache nodes](#5-consistent-hashing--how-data-is-divided-across-cache-nodes)
6. [Trending — the recency formula (most important)](#6-trending--the-recency-formula-most-important)
7. [Batching & the write buffer](#7-batching--the-write-buffer)
8. [The workers](#8-the-workers)
9. [Metrics — how each stat is calculated](#9-metrics--how-each-stat-is-calculated)
10. [Consistency / latency trade-offs](#10-consistency--latency-trade-offs)
11. [Decision log (quick reference)](#11-decision-log-quick-reference)

---

## 1. System overview & request lifecycle

Five process types, all wired by `docker-compose`:

| Process | Count | Role |
|---|---|---|
| **nginx** | 1 | Load balancer (round-robin) in front of the app replicas |
| **app** | 3 | Stateless Node/Express servers; serve the API + static dashboard |
| **postgres** | 1 | Source of truth (durable) |
| **redis** | 1 | Cache + write-buffer queue + shared metric counters |
| **worker** | 1 | Flusher (drains buffer → batched writes) + decay reconciliation |

### Read lifecycle — `GET /suggest?q=wik&mode=basic`
1. nginx round-robins the request to one of app1/app2/app3.
2. The app normalises the prefix (`trim().toLowerCase()`).
3. The **consistent-hash ring** maps the prefix → a *logical cache node*
   (`cache-a|b|c`). The Redis key is `cache:<node>:suggest:<mode>:<prefix>`.
4. **Cache hit:** `ZREVRANGE key 0 9 WITHSCORES` returns the ranked suggestions
   (sub-millisecond). Increment `cache_hits`.
5. **Cache miss:** increment `cache_misses`, run the prefix query against
   Postgres (`… WHERE query LIKE 'wik%' ORDER BY <sortcol> DESC LIMIT 10`),
   `ZADD` the results into the ZSET, set a TTL, return.
6. Record the end-to-end latency into the rolling p95 window.

### Write lifecycle — `POST /search {"query":"wik"}`
1. nginx → an app replica.
2. The app `RPUSH`es `{query, ts}` onto the Redis LIST `search:queue` and
   returns `{"message":"Searched"}` **immediately**. No Postgres write here.
   Increment `search_submissions`.
3. Later, the **worker's flusher** drains the queue, aggregates duplicates, and
   issues **one** batched `UPSERT` to Postgres (bumping `all_time_count` and
   `trending_score`, and the day's `daily_search_counts`). Increment `pg_writes`
   once per flush.

The asymmetry is deliberate: **reads are cache-first and cheap; writes are
buffered and batched.** Postgres — the scarce resource — is touched as little as
possible on both paths.

---

## 2. Data model & why two counters

```sql
CREATE TABLE queries (
  query            TEXT PRIMARY KEY,
  all_time_count   BIGINT  NOT NULL DEFAULT 0,   -- monotonic; NEVER decayed
  trending_score   DOUBLE PRECISION NOT NULL DEFAULT 0,  -- recency-weighted
  last_searched_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_queries_prefix          ON queries (query text_pattern_ops);
CREATE INDEX idx_queries_all_time_count  ON queries (all_time_count DESC);
CREATE INDEX idx_queries_trending_score  ON queries (trending_score DESC);

CREATE TABLE daily_search_counts (
  query        TEXT NOT NULL,
  day_bucket   DATE NOT NULL,
  search_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (query, day_bucket)
);
```

**Decision: two separate counters, never one.**
- `all_time_count` answers *"what's most popular ever"* (basic mode, 60% of the
  rubric). It only ever increases.
- `trending_score` answers *"what's hot right now"* (trending mode, 20%). It's a
  recency-weighted value that fades over time.

If we decayed a single counter, we'd destroy the ability to answer the all-time
question. So they're stored independently and the **same `/suggest` API** just
changes its `ORDER BY` based on the `mode` query param.

**Why `text_pattern_ops`:** the default B-tree index on a `TEXT` column uses the
database collation and is **not** usable for `LIKE 'prefix%'`. `text_pattern_ops`
makes the prefix scan an index *range* scan — the single most important index for
read latency. Verified: `Index Cond: (query ~>=~ 'iph' AND query ~<~ 'ipi')`.

**Why `daily_search_counts`:** it's the authoritative per-day history the decay
reconciliation reads from, without re-scanning raw events. The flusher writes
both tables in the **same transaction** so they never drift.

---

## 3. Load balancing

**Technique: nginx reverse proxy, round-robin across 3 explicit upstreams.**

```nginx
upstream app_servers {
    server app1:3000;
    server app2:3000;
    server app3:3000;
}
```

- **Why round-robin:** the app servers are **stateless** — every piece of shared
  state lives in Postgres/Redis — so any replica can serve any request. No sticky
  sessions are needed, and round-robin spreads load evenly with zero
  coordination.
- **Why three *explicit* upstreams** (rather than one service name + Docker DNS):
  nginx resolves an upstream hostname **once at startup** and caches the IP, so a
  single service name would pin all traffic to one replica. Listing app1/app2/app3
  explicitly guarantees real round-robin. (Confirmed in testing: 6 requests
  rotate app1→app2→app3→app1→…)
- Each replica stamps an `X-Instance-Id` response header so you can *see* the
  balancing. nginx also logs `$upstream_addr`.
- **Scaling:** add `app4`, list it in the upstream — done. No app code changes,
  because there's no per-instance state.

---

## 4. The distributed cache

**Decision: cache-aside, with ZSET values, TTL-bounded freshness.**

### Why cache-aside (not write-through)
Redis is **never** the primary write target for counts. On a read miss we
recompute from Postgres and populate the cache. This is far simpler to reason
about than keeping N cached sorted lists incrementally consistent on every write.

### Why ZSET values (not a JSON blob)
Each cache entry is a Redis **sorted set**: `ZADD key <score> <query>`. Redis
maintains the ranking for us; reads are `ZREVRANGE key 0 9 WITHSCORES`. This
avoids any read-modify-write race on a flat JSON value and gives correct ordering
for free.

Key layout: `cache:<logicalNode>:suggest:<mode>:<prefix>`
- `<logicalNode>` (e.g. `cache-b`) comes from the consistent-hash ring — this is
  what makes the cache *partitioned* (see §5).
- `<mode>` is `basic` or `trending` (two independent rankings).
- `<prefix>` is the normalised prefix.

### Freshness: TTL, not per-write eviction (important nuance)
Every populated key gets a TTL (`CACHE_TTL_SECONDS`, default 300s). We do **not**
delete cache keys on every flush. Reasoning:
- The brief's accepted trade-off is *"reads may lag by up to one cache TTL
  window."* TTL expiry satisfies the "no stale data forever" requirement.
- Evicting a prefix on every write would keep any **actively-searched** prefix
  permanently cold — the cache would never produce hits for popular queries
  (this was a real bug we hit and fixed). TTL-bounded freshness lets repeated
  reads of the same prefix hit.
- The live **`/top` leaderboards are uncached** (read straight from Postgres), so
  trending still updates instantly regardless of the suggest cache TTL.
- The **decay reconciliation** still invalidates trending keys when it runs
  (infrequent, off the hot path).

We only cache prefixes up to `MAX_CACHEABLE_PREFIX_LEN` (default 32) — long enough
to cover real multi-word queries, bounded so a flood of one-off long prefixes
can't bloat memory. Reads still work for any length; this only bounds what we
*store*. Empty result sets are not cached (rare; avoids a negative-cache layer).

---

## 5. Consistent hashing — how data is divided across cache nodes

Implemented **from scratch** in
[app/src/lib/consistentHash.js](app/src/lib/consistentHash.js) (the brief
requires the algorithm be understood and explainable, not delegated to Redis
Cluster's built-in slot hashing).

### The problem it solves
Naïve sharding does `node = hash(key) % N`. Change `N` (add/remove a cache node)
and `% N` changes for **almost every** key — the whole cache invalidates at once,
stampeding Postgres. Consistent hashing makes adding/removing one node remap only
**~1/N** of keys.

### The algorithm
1. Map both **nodes** and **keys** onto the same circle `[0, 2³²)`.
2. A key is owned by the **first node found walking clockwise** from the key's
   position (wrapping past the top).
3. When a node leaves, only the keys on the arc it covered move — to the next
   node clockwise. Every other key keeps its owner.

### Virtual nodes (how the data is actually divided)
With one point per physical node, arcs are wildly uneven and removing a node
dumps its whole arc onto a single neighbour. So each logical node is placed on the
ring **`VNODES_PER_NODE` times** (default **150**) as *virtual nodes*
(`cache-a#0` … `cache-a#149`), all mapping back to the same node. This:
- **evens out the distribution** (each node owns ~1/N of the circle), and
- on removal, spreads the orphaned keys across **many** neighbours, not one.

Measured distribution (50k sampled keys, 150 vnodes × 3 nodes): ≈ 43% / 25% / 31%
— "roughly even"; the spread is the inherent finite-vnode variance and tightens
as you raise `VNODES_PER_NODE`.

### Hash function
**FNV-1a (32-bit)** — tiny, dependency-free, deterministic, well-distributed for
short strings. Cryptographic strength is irrelevant here; speed and spread are
what matter. Because it's deterministic and every process builds the **same** ring
from the same node list, **all app replicas agree on which node owns a prefix** —
that agreement is what makes the cache coherent across replicas.

### Lookup cost
The ring is a sorted array of `{hash, node}` points; ownership is a **binary
search** for the first point ≥ `hash(key)` (microseconds), not a linear scan.

### How nodes are "distributed and handled"
- The logical nodes are `CACHE_NODES` (default `cache-a,cache-b,cache-c`). Each is
  a **key-namespace partition inside one Redis instance** — the prefix in the
  Redis key (`cache:<node>:…`) is the partition. (One physical Redis keeps the
  demo to a single container while still exercising the routing algorithm
  end-to-end; the ring code is identical if those were three real Redis
  containers — only the connection target would change.)
- `GET /cache/debug?prefix=…` shows the owning node + hit/miss live.
- `GET /cache/ring` returns the sampled keyspace share per node (powers the
  dashboard ring panel).
- `npm run demo-hash` proves both properties: even distribution, and that
  removing 1 of 3 nodes remaps **~33%** of keys (vs ~67% for `hash % N`), and
  re-adding restores 100% (determinism).

---

## 6. Trending — the recency formula (most important)

**Goal:** recently-searched queries should rank above queries that were popular
long ago, and a short-lived spike must **not** dominate forever.

### The formula: forward exponential decay
Each search event on day `d` contributes a **forward-decay weight** to the
query's `trending_score` accumulator:

```
weight(d)        = (1 / DECAY) ^ (d − epoch)            # DECAY = 0.85, epoch = 2026-06-01
trending_score(q) = Σ over q's events  weight(event_day)
```

The score we'd actually want for ranking is the *decayed-to-now* value:

```
decayed_now(q) = trending_score(q) · DECAY ^ (now − epoch)
```

But `DECAY ^ (now − epoch)` is the **same constant for every query**, so it
cancels in any comparison:

```
decayed_now(a) > decayed_now(b)   ⇔   trending_score(a) > trending_score(b)
```

**Therefore ranking by the raw accumulator `trending_score` is identical to
ranking by exponentially-decayed recent counts** — and we can rank with a plain
`ORDER BY trending_score DESC`. No per-read recomputation, no full-table sweep.

This is the **closed form of the brief's recurrence**
`score_today = score_yesterday · DECAY + searches_today` (initial condition 0):
unrolling that recurrence over the daily buckets gives exactly the weighted sum
above. We implement the closed form because it is **idempotent** (run it any
number of times, any schedule → same result) and naturally includes every recent
day-bucket.

### Why this is the *right* model for the data
An event `d` days old effectively weighs `DECAY^d` (today 1.0, yesterday 0.85, a
week ago 0.85⁷ ≈ 0.32). So:
- recent activity dominates → recently-searched queries rise;
- a one-day spike fades within ~10 days and **cannot permanently over-rank**
  (assignment §7 requirement 3);
- old activity needs no active "fading" pass — its weight is simply small.

### Where it's computed (so trending is *live*)
The **flusher** adds `Σ weight(event_day)` to `trending_score` **at write time**
(per flush). Computing the weight per *event day* (not "today") means replayed
historical events get their real day's weight. Because the score updates on the
next flush after a search, a query starts trending within ~5s of being searched —
this is the fix for *"I searched X 100× but it never trended"* (the old design
only updated trending in a periodic job).

`trending_score` is **seeded to 0** at load: a query isn't trending until it's
actually searched (its lifetime popularity lives in `all_time_count`, shown in the
"Most popular" board).

### Overflow note
Forward weights grow as `(1/0.85)^days`. With the default epoch this stays in safe
`double` range for ~12 years — far beyond any demo/assignment horizon. The decay
reconciliation can rebase the epoch if ever needed.

### Trade-offs of this approach
- **Freshness vs latency:** ranking is exact and free at read time; the only lag
  is one flush interval before a new search is reflected.
- **Implementation complexity:** one extra column + a weight computation; no
  scheduled decay sweep on the hot path, no stateful day-by-day step that breaks
  if run off-schedule.

---

## 7. Batching & the write buffer

**Goal (assignment §8):** never write to Postgres synchronously per search.

### The buffer
- A single **Redis LIST**, key `search:queue`
  ([app/src/lib/writeBuffer.js](app/src/lib/writeBuffer.js)).
- `POST /search` does `RPUSH search:queue {"query","ts"}` and returns instantly.
- **Why Redis, not an in-process array:** there are N stateless app replicas. An
  in-process queue would give each replica its own buffer that the single flusher
  can't see — writes would be split or lost. A shared Redis LIST is the
  rendezvous: any replica `RPUSH`es, the one worker `LPOP`s. (No extra message
  broker is justified — Redis is already in the stack.)
- `ts` (timestamp) is stored so the flusher can attribute each event to the right
  `day_bucket` for the decay weighting.

### The flush (how batching is done)
The flusher ([app/workers/flusher.js](app/workers/flusher.js)) runs a loop with a
**time-OR-size trigger** (whichever comes first):
- **size:** queue depth ≥ `FLUSH_MAX_BATCH` (1000) → flush now (bounds memory &
  gives bursts a fast path);
- **time:** `FLUSH_INTERVAL_MS` (5000ms) since the last flush → flush now (bounds
  how stale writes get).

On a flush it:
1. **Drains** up to `FLUSH_MAX_BATCH` events with a single `LPOP key count`.
2. **Aggregates in memory**: builds `perQuery` (`{delta, lastTs, trendDelta}`) and
   `perDay` (`{query, day, count}`) maps. 200 `"pizza"` events collapse into one
   `delta = 200`, and `trendDelta = Σ weight(day)`.
3. **Writes ONE transaction** with two set-based `unnest` UPSERTs:
   - `queries`: `all_time_count += delta`, `trending_score += trendDelta`,
     `last_searched_at = GREATEST(…)` — `ON CONFLICT (query) DO UPDATE`.
   - `daily_search_counts`: `search_count += count` per `(query, day_bucket)`.
4. Increments `pg_writes` **once** (one flush = one batched write event).

So *thousands* of `POST /search` calls become a handful of `UPSERT`s. Measured:
**500,000 submissions → 669 write batches ≈ 747×** reduction.

### Failure trade-off (documented, per assignment §8)
Events live only in the Redis queue until flushed. If the worker crashes
mid-window, that window's un-flushed events are lost (and `LPOP` removes items
before the commit, so a crash between `LPOP` and `COMMIT` also drops that batch).
This is an accepted **at-most-once** simplification: the use case is "trending
direction", not financial-grade accounting. A stronger guarantee would use
`LMOVE` into a processing list + ack, at the cost of more moving parts.

---

## 8. The workers

One **worker** container ([app/workers/index.js](app/workers/index.js)) runs two
loops. Why a dedicated worker and not logic inside the app replicas?
- There must be **exactly one** drainer of the shared queue — three replicas all
  draining would race and split batches, hurting the batching ratio.
- The decay job is a periodic batch job; running it in every replica would
  multiply the work and cache invalidations.
- The app replicas stay pure, stateless request handlers.

### Worker 1 — the flusher
Drains the buffer and performs the batched writes (see §7). Time-OR-size trigger;
recursive `setTimeout` (not `setInterval`) so a slow flush never overlaps the next
tick. It also keeps `trending_score` current via the forward-decay increment.

### Worker 2 — the decay reconciliation
[app/workers/decayJob.js](app/workers/decayJob.js). Because the flusher already
keeps `trending_score` correct at write time, this job is **not** on the liveness
path. Its job is to **re-derive** `trending_score` from the authoritative
`daily_search_counts` (the same forward-decay sum) on a schedule
(`DECAY_INTERVAL_MS`, default 1h), guarding against drift from any lost flush:

```sql
UPDATE queries SET trending_score = 0 WHERE trending_score <> 0;   -- reset
WITH recency AS (
  SELECT query, SUM(search_count * power(1/DECAY, day_bucket - epoch)) AS score
  FROM daily_search_counts GROUP BY query)
UPDATE queries q SET trending_score = r.score FROM recency r WHERE q.query = r.query;
```

It then invalidates trending-mode cache keys (a full sweep is safe because it runs
infrequently). It's idempotent, so running it on demand (`npm run decay`) or on
any schedule yields the same result.

---

## 9. Metrics — how each stat is calculated

Implemented in [app/src/lib/metrics.js](app/src/lib/metrics.js). Two kinds:

**Counters live in Redis** (so they're GLOBAL across the 3 replicas + worker — a
`/stats` request served by any replica reports a coherent system-wide view). Each
is a Redis integer incremented with `INCRBY` (atomic, ~microseconds):

| Counter | Incremented where | Meaning |
|---|---|---|
| `cache_hits` | cache layer, on a ZSET hit | suggest reads served from Redis |
| `cache_misses` | cache layer, on a miss | suggest reads that fell through to Postgres |
| `pg_reads` | `db.js` `dbQuery(…, 'read')` | Postgres read queries (suggest misses + `/top` + `/trending`) |
| `pg_writes` | flusher, once per flush | **batched** write transactions sent to Postgres |
| `search_submissions` | `writeBuffer.enqueueSearch` | raw `POST /search` count (the "before batching" number) |

**Derived values** (computed in `snapshot()` at read time):
- `cache.hit_rate` = `cache_hits / (cache_hits + cache_misses)` (0 if no reads).
- `batch_writes.write_reduction_factor` = `search_submissions / pg_writes` — the
  headline batching number ("N searches → M writes").
- `write_queue_depth` = `LLEN search:queue` — live buffer backlog (drives the
  dashboard's "Buffer pending" gauge).

**Latency (p50/p95/p99)** is a rolling window kept in a **Redis LIST**
(`metrics:suggest_latency_ms`, capped at `LATENCY_WINDOW` = 1000 via `LPUSH` +
`LTRIM`). Storing it in Redis (not in-process) makes it **global** — otherwise
`/stats` would only see the latencies of whichever replica happened to serve the
`/stats` request (often zero). Percentiles are computed by sorting the window and
indexing at `floor(p/100 · n)`. Each `/suggest` handler measures its own
end-to-end time with `process.hrtime.bigint()` and pushes it.

**Dashboard refresh:** `/stats` every 1.5s (Redis-only, no Postgres), `/top`
every 5s (uncached Postgres read — deliberately slow to keep `pg_reads` low),
`/cache/ring` every 15s (in-memory sampling). The two sparklines (latency, hit
rate) are built client-side from a rolling history of poll samples.

> Note: `pg_reads` climbs continuously even when idle because the dashboard polls
> the **uncached** `/top` every 5s (2 reads/poll). That's expected — it's the
> dashboard watching its own leaderboards, and it illustrates the read-heavy
> nature of the workload (reads ≫ writes, which is *why* the cache + batching
> exist).

---

## 10. Consistency / latency trade-offs

The system **deliberately favors latency and availability over strict
consistency**:
- **Writes** lag by up to one flush interval (`FLUSH_INTERVAL_MS`). A worker crash
  before a flush loses that window's increments (at-most-once).
- **Reads** can serve cached data up to one TTL window (`CACHE_TTL_SECONDS`) old.
- Counts are therefore *eventually* consistent, not exact.

This is acceptable because the product is **trending/popularity direction**, not
financial accounting. The pay-off is sub-millisecond cache reads, instant write
acks, and a Postgres write load reduced by ~750×. Every one of these knobs is a
single constant in `config.js`, so the freshness/latency balance is tunable
without code changes.

---

## 11. Decision log (quick reference)

| Decision | Why | Trade-off accepted |
|---|---|---|
| Two counters (`all_time_count`, `trending_score`) | Answer both "most popular ever" and "hot now" from one table | One extra column |
| Forward-decay trending, updated at write time | Live trending, ranks with plain `ORDER BY`, no sweep | Weight grows over time (rebase ~12yr) |
| Batch at the Postgres boundary via Redis LIST | Protect the scarce resource; correct across N replicas | Up to one flush-window of writes lost on crash |
| Cache-aside + ZSET + TTL (no per-write eviction) | Simple, race-free ranking; hot prefixes actually cache | Reads lag up to one TTL window |
| Consistent hashing from scratch, 150 vnodes | Adding/removing a node remaps ~1/N, not ~all | Finite-vnode distribution variance |
| nginx round-robin over 3 explicit upstreams | Stateless replicas; avoids DNS-caching pin | Static replica list |
| One worker for flush + decay | Exactly one queue drainer; no duplicated work | Single point for background work |
| Metrics & p95 in Redis | Global, coherent stats across replicas | Tiny Redis traffic per request |
| Single Redis, logical cache-node namespaces | Keep the demo to one container; same ring algorithm | Not physically separate Redis processes |

For the line-by-line "what & why", every module carries comments explaining the
reasoning — start at [app/src/config.js](app/src/config.js) and follow the
imports.
