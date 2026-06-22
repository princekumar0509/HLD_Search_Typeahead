// load.js — one-shot seed loader for the queries table.
//
// WHY this is a standalone script with its OWN pg client (not the app's db.js):
//   * It must NOT count toward the /stats pg_read/pg_write metrics — bulk seeding
//     is not application traffic.
//   * It runs before/independently of the app, so it shouldn't drag in Redis.
//
// WHY COPY and not INSERTs: 718k rows. Row-by-row INSERT would be ~minutes and
// hammer the WAL. COPY streams the whole file into a staging table in one
// command (seconds). We then do ONE set-based UPSERT into the real table.
//
// Seeding:
//   all_time_count = count   (lifetime popularity — basic mode; never decayed)
//   trending_score = 0       (trending reflects RECENT activity only; a seeded
//                             query has no recent searches yet, so it isn't
//                             trending until people actually search it. The
//                             flusher then accumulates forward-decay weight per
//                             live search, so a query trends as it's searched.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const CSV_PATH =
  process.env.QUERIES_CSV || path.join(PROJECT_ROOT, 'reference', 'queries.csv');
const SCHEMA_PATH =
  process.env.SCHEMA_SQL || path.join(PROJECT_ROOT, 'db', 'schema.sql');
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://typeahead:typeahead@localhost:5432/typeahead';

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`queries.csv not found at ${CSV_PATH} (set QUERIES_CSV)`);
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log(`[load] connected to Postgres`);

  try {
    // 1. Ensure schema exists (idempotent).
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await client.query(schema);
    console.log('[load] schema applied');

    // 2. Stage the raw CSV. UNLOGGED skips WAL for this throwaway table => faster.
    await client.query('DROP TABLE IF EXISTS _queries_staging');
    await client.query(
      'CREATE UNLOGGED TABLE _queries_staging (query TEXT, count BIGINT)'
    );

    // 3. Stream the file into staging via COPY.
    console.log(`[load] COPYing ${CSV_PATH} ...`);
    const ingest = client.query(
      copyFrom(
        `COPY _queries_staging (query, count)
         FROM STDIN WITH (FORMAT csv, HEADER true)`
      )
    );
    await pipeline(fs.createReadStream(CSV_PATH), ingest);

    const { rows: staged } = await client.query(
      'SELECT count(*)::bigint AS n FROM _queries_staging'
    );
    console.log(`[load] staged ${staged[0].n} raw rows`);

    // 4. Set-based UPSERT into the real table. GROUP BY guards against any
    //    duplicate query rows in the source (sum their counts). ON CONFLICT makes
    //    re-running the loader idempotent (it overwrites rather than erroring).
    console.log('[load] upserting into queries ...');
    await client.query(`
      INSERT INTO queries (query, all_time_count, trending_score)
      SELECT query, SUM(count), 0
      FROM _queries_staging
      WHERE query IS NOT NULL AND length(query) > 0
      GROUP BY query
      ON CONFLICT (query) DO UPDATE
        SET all_time_count = EXCLUDED.all_time_count,
            trending_score = 0
    `);

    await client.query('DROP TABLE _queries_staging');

    const { rows: total } = await client.query(
      'SELECT count(*)::bigint AS n FROM queries'
    );
    console.log(`[load] done — queries table has ${total[0].n} rows`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[load] FAILED:', err);
  process.exit(1);
});
