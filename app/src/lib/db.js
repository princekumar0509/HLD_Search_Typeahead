// db.js — Postgres access layer (the SOURCE OF TRUTH).
//
// Everything that touches Postgres goes through here so we have ONE place that
// owns the connection pool and ONE place that counts reads/writes for the
// /stats instrumentation. Routes never `import pg` directly.

import pg from 'pg';
import { config } from '../config.js';
import { metrics } from './metrics.js';

const { Pool } = pg;

// A single shared pool per process. pg multiplexes concurrent requests over a
// small set of connections — far cheaper than connect-per-request, and it caps
// load on Postgres (the expensive resource we are protecting).
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// Centralised query helper. Every read/write is counted so /stats can report
// "how many times did we actually hit Postgres" — the number batching reduces.
export async function dbQuery(text, params, kind = 'read') {
  await metrics.incr(kind === 'read' ? 'pg_reads' : 'pg_writes');
  return pool.query(text, params);
}

// Core read path for /suggest on a cache MISS.
//
// Prefix match via `query LIKE $1` where $1 is `prefix%` (uses the
// text_pattern_ops index). ORDER BY differs ONLY in the sort column — the same
// API, the same query shape, swapped sort key per the two-counter model.
//
// We escape LIKE metacharacters (%, _, \) in the user prefix so a query like
// "50%" can't turn into a wildcard scan.
export async function getSuggestionsFromDb(prefix, mode, limit) {
  const sortColumn = mode === 'trending' ? 'trending_score' : 'all_time_count';
  const escaped = prefix.replace(/([\\%_])/g, '\\$1');

  const sql = `
    SELECT query, all_time_count, trending_score
    FROM queries
    WHERE query LIKE $1
    ORDER BY ${sortColumn} DESC, query ASC
    LIMIT $2`;
  const { rows } = await dbQuery(sql, [`${escaped}%`, limit], 'read');

  // The score we cache in the ZSET depends on the mode the read was for.
  return rows.map((r) => ({
    query: r.query,
    score: mode === 'trending' ? Number(r.trending_score) : Number(r.all_time_count),
  }));
}

// Top trending queries overall (not prefix-scoped) for GET /trending.
export async function getTopTrending(limit) {
  const sql = `
    SELECT query, trending_score, all_time_count
    FROM queries
    WHERE trending_score > 0
    ORDER BY trending_score DESC, query ASC
    LIMIT $1`;
  const { rows } = await dbQuery(sql, [limit], 'read');
  return rows.map((r) => ({
    query: r.query,
    trending_score: Number(r.trending_score),
    all_time_count: Number(r.all_time_count),
  }));
}

// Top queries by lifetime popularity overall (for the /top "most popular"
// table — the all-time-count counterpart to getTopTrending).
export async function getTopPopular(limit) {
  const sql = `
    SELECT query, all_time_count, trending_score
    FROM queries
    ORDER BY all_time_count DESC, query ASC
    LIMIT $1`;
  const { rows } = await dbQuery(sql, [limit], 'read');
  return rows.map((r) => ({
    query: r.query,
    all_time_count: Number(r.all_time_count),
    trending_score: Number(r.trending_score),
  }));
}

export async function pingDb() {
  await pool.query('SELECT 1');
  return true;
}

export async function closeDb() {
  await pool.end();
}
