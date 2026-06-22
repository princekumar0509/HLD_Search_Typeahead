// load_test.js — ON-DEMAND replay of search_events.csv through POST /search.
//
// Purpose (assignment §7 + §8 evidence):
//   * Exercise the batch-write pipeline end-to-end under realistic volume.
//   * Produce the "N submissions batched into M Postgres writes" number.
//   * Populate trending via the normal write path (each event's ORIGINAL
//     timestamp is preserved, so recent events get larger forward-decay weight),
//     letting the /top "Trending" board reflect the replayed history.
//
// This does NOT run at startup — it's invoked explicitly:
//   docker compose run --rm loadtest         (inside the stack)
//   TARGET=http://localhost:8080 node app/scripts/load_test.js   (from host)
//
// No external deps: built-in fetch + line-by-line file streaming.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const TARGET = process.env.TARGET || 'http://localhost:8080';
const EVENTS_CSV =
  process.env.EVENTS_CSV || path.join(PROJECT_ROOT, 'reference', 'search_events.csv');
// 0 = replay everything. Cap it for a quicker demo (the file is chronological,
// so a cap replays the EARLIEST events — set 0 to include the recent spike).
const LIMIT = Number(process.env.EVENTS_LIMIT || 0);
// How many POSTs in flight at once. Higher = faster, bounded by the backend.
const CONCURRENCY = Number(process.env.CONCURRENCY || 64);

async function postSearch(query, ts) {
  const res = await fetch(`${TARGET}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ts }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function getStats() {
  try {
    const res = await fetch(`${TARGET}/stats`);
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(EVENTS_CSV)) {
    throw new Error(`events csv not found at ${EVENTS_CSV} (set EVENTS_CSV)`);
  }
  console.log(`[loadtest] target=${TARGET} file=${EVENTS_CSV} limit=${LIMIT || 'all'}`);

  // Reset metrics so the write-reduction numbers reflect just this run.
  await fetch(`${TARGET}/stats/reset`, { method: 'POST' }).catch(() => {});

  const rl = readline.createInterface({
    input: fs.createReadStream(EVENTS_CSV),
    crlfDelay: Infinity,
  });

  let sent = 0;
  let firstLine = true;
  const inFlight = new Set();
  const started = Date.now();

  for await (const line of rl) {
    if (firstLine) {
      firstLine = false; // skip CSV header "query,timestamp"
      continue;
    }
    if (!line) continue;
    // query may legitimately contain commas; timestamp is the LAST field.
    const idx = line.lastIndexOf(',');
    if (idx < 0) continue;
    const query = line.slice(0, idx);
    const ts = line.slice(idx + 1);

    // Backpressure: keep at most CONCURRENCY requests in flight.
    const p = postSearch(query, ts)
      .catch(() => {}) // tolerate occasional errors during a load test
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);

    if (++sent % 25000 === 0) {
      const rate = Math.round(sent / ((Date.now() - started) / 1000));
      console.log(`[loadtest] sent ${sent} events (${rate}/s)`);
    }
    if (LIMIT && sent >= LIMIT) break;
  }
  await Promise.allSettled(inFlight);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[loadtest] submitted ${sent} events in ${elapsed}s`);

  // Wait for the flusher to drain the queue, then report the batching ratio.
  console.log('[loadtest] waiting for flusher to drain the queue…');
  let stats = await getStats();
  for (let i = 0; i < 120 && stats && stats.write_queue_depth > 0; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    stats = await getStats();
  }

  if (stats) {
    const b = stats.batch_writes;
    console.log('\n===== BATCH-WRITE RESULT =====');
    console.log(`raw search submissions : ${b.search_submissions}`);
    console.log(`postgres write batches  : ${b.postgres_write_statements}`);
    console.log(`write reduction factor  : ${b.write_reduction_factor}x fewer writes`);
    console.log('==============================');
    console.log('\nTrending updated live via the flusher — see GET /top or the UI.');
  }
}

main().catch((err) => {
  console.error('[loadtest] FAILED:', err);
  process.exit(1);
});
