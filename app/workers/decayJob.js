// decayJob.js — periodic RECONCILIATION of trending_score.
//
// With forward decay, trending_score is kept current by the FLUSHER at write
// time (it adds (1/DECAY)^(day-epoch) per search). So — unlike a classic
// "decay sweep" — trending liveness does NOT depend on this job, and old
// activity already fades on its own (recent events carry exponentially larger
// weight, so stale queries simply rank low).
//
// This job exists only to RE-DERIVE trending_score from the authoritative
// daily_search_counts table, in case incremental flush updates ever drift (e.g.
// a flush lost to a crash). It computes the exact same forward-decay sum the
// flusher accumulates, so it is idempotent and safe to run anytime:
//
//   trending_score(q) = Σ_d  search_count(q, d) · (1/DECAY)^(d − epoch)
//
// Ranking by this == ranking by DECAY^age-decayed recent counts (see config.js).

import { pool } from '../src/lib/db.js';
import { invalidateAllTrending } from '../src/lib/cache.js';
import { config } from '../src/config.js';

export async function runDecay() {
  const invDecay = 1 / config.decayFactor;
  const epoch = config.decayEpoch;
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('BEGIN');

    // Reset to 0, then set the forward-decay sum for queries with activity.
    await client.query('UPDATE queries SET trending_score = 0 WHERE trending_score <> 0');
    const res = await client.query(
      `WITH recency AS (
         SELECT query,
                SUM(search_count * power($1::float8, (day_bucket - $2::date))) AS score
         FROM daily_search_counts
         GROUP BY query
       )
       UPDATE queries q
          SET trending_score = r.score
         FROM recency r
        WHERE q.query = r.query`,
      [invDecay, epoch]
    );

    await client.query('COMMIT');

    // Rankings may have shifted, so drop all trending-mode cache keys; the next
    // trending read recomputes from the reconciled scores.
    const invalidated = await invalidateAllTrending();

    console.log(
      `[decay] reconciled trending_score (forward decay, factor=${config.decayFactor}, ` +
        `epoch=${epoch}); ${res.rowCount} queries with activity; ` +
        `${invalidated} trending cache keys invalidated; ${Date.now() - started}ms`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function startDecayWorker() {
  console.log(
    `[decay] reconciliation worker started (interval=${config.decayIntervalMs}ms). ` +
      `Trending stays live via the flusher; this only re-derives from truth.`
  );
  // One reconciliation on startup, then on the configured interval.
  runDecay().catch((e) => console.error('[decay] initial run failed:', e));
  setInterval(() => {
    runDecay().catch((e) => console.error('[decay] scheduled run failed:', e));
  }, config.decayIntervalMs);
}

// Standalone one-shot: `node workers/decayJob.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDecay()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[decay] FAILED:', e);
      process.exit(1);
    });
}
