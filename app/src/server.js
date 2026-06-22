// server.js — the stateless Express app server.
//
// N identical copies of this run behind nginx (round-robin). It owns NO state:
// all shared state lives in Postgres (truth) and Redis (cache + queue + metrics),
// which is exactly what lets us scale replicas horizontally.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { metrics } from './lib/metrics.js';

import { suggestRouter } from './routes/suggest.js';
import { searchRouter } from './routes/search.js';
import { trendingRouter } from './routes/trending.js';
import { topRouter } from './routes/top.js';
import { cacheDebugRouter } from './routes/cacheDebug.js';
import { statsRouter } from './routes/stats.js';
import { healthRouter } from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

metrics.configure({ latencyWindow: config.latencyWindow });

const app = express();
app.use(express.json());

// Tag every response with the instance id so a demo can SEE nginx round-robin
// across replicas (each app container sets INSTANCE_ID in compose).
const INSTANCE_ID = process.env.INSTANCE_ID || 'app';
app.use((_req, res, next) => {
  res.set('X-Instance-Id', INSTANCE_ID);
  next();
});

// API routes (mounted at root — paths are defined inside each router).
app.use(suggestRouter);
app.use(searchRouter);
app.use(trendingRouter);
app.use(topRouter);
app.use(cacheDebugRouter);
app.use(statsRouter);
app.use(healthRouter);

// Static vanilla-JS frontend.
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(config.port, () => {
  console.log(
    `[server] ${INSTANCE_ID} listening on :${config.port} ` +
      `(cache nodes: ${config.cacheNodes.join(', ')})`
  );
});

// Graceful shutdown so in-flight requests finish and connections close cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
