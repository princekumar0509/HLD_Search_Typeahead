// index.js — entrypoint for the dedicated worker container.
//
// WHY one worker process (not logic embedded in the app replicas):
//   * Exactly ONE drainer of the shared write queue — N app replicas all
//     draining would race and split batches, hurting the batching ratio.
//   * The decay job is a periodic batch job; running it in every replica would
//     multiply the work and the cache invalidations.
// The app replicas stay purely stateless request handlers; all background work
// lives here.

import { startFlusher } from './flusher.js';
import { startDecayWorker } from './decayJob.js';

console.log('[worker] starting flusher + decay worker');
startFlusher();
startDecayWorker();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, exiting`);
    process.exit(0);
  });
}
