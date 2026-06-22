-- schema.sql — Postgres source of truth for the typeahead system.
--
-- Two-counter model (see brief §1.1): we keep all_time_count and trending_score
-- as SEPARATE columns and NEVER decay all_time_count. This lets the same table
-- answer both "most popular ever" (basic mode) and "trending now" (trending mode).

CREATE TABLE IF NOT EXISTS queries (
    query             TEXT PRIMARY KEY,
    -- Monotonic lifetime popularity. Powers mode=basic. Never decayed.
    all_time_count    BIGINT NOT NULL DEFAULT 0,
    -- Forward-decay accumulator of recent search activity. Powers mode=trending
    -- and the /top "trending" table. Seeded to 0 (a query isn't trending until
    -- searched); the flusher adds (1/DECAY)^(day-epoch) per search at write time,
    -- so ranking by trending_score == ranking by exponentially-decayed recent
    -- counts. See app/src/config.js and workers/flusher.js for the math.
    trending_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Last time this query was searched (for debugging / future ranking).
    last_searched_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prefix lookups use `query LIKE 'abc%'`. The default B-tree index on a TEXT PK
-- is built with the database collation and is NOT usable for LIKE prefix scans;
-- text_pattern_ops makes `LIKE 'prefix%'` an index range scan. This is the
-- single most important index for /suggest read latency.
CREATE INDEX IF NOT EXISTS idx_queries_prefix
    ON queries (query text_pattern_ops);

-- After narrowing to a prefix range we ORDER BY one of these. Composite-ish
-- single-column indexes let Postgres pick the right sort key per mode.
CREATE INDEX IF NOT EXISTS idx_queries_all_time_count
    ON queries (all_time_count DESC);
CREATE INDEX IF NOT EXISTS idx_queries_trending_score
    ON queries (trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_queries_last_searched_at
    ON queries (last_searched_at DESC);

-- Per-day per-query counts. The decay job reads "searches today" from here
-- instead of re-scanning raw events. The flusher writes BOTH queries (running
-- totals) and daily_search_counts (today's bucket) in one transaction so the
-- two never drift apart.
CREATE TABLE IF NOT EXISTS daily_search_counts (
    query         TEXT NOT NULL,
    day_bucket    DATE NOT NULL,
    search_count  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (query, day_bucket)
);

CREATE INDEX IF NOT EXISTS idx_daily_counts_day
    ON daily_search_counts (day_bucket);
