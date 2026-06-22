// redis.js — shared ioredis connection factory.
//
// One physical Redis instance serves THREE roles in this system:
//   1. the distributed cache (ZSETs, namespaced per logical node),
//   2. the write-buffer queue (a LIST),
//   3. shared cross-process metric counters.
// A single ioredis client is safe to share for all non-blocking commands, so we
// keep one process-wide singleton instead of opening a connection per module.

import Redis from 'ioredis';
import { config } from '../config.js';

let client;

export function getRedis() {
  if (!client) {
    client = new Redis(config.redisUrl, {
      // Fail fast and keep retrying — in docker-compose the app may boot before
      // Redis is ready; ioredis queues commands and flushes them on connect.
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
  }
  return client;
}

export async function pingRedis() {
  const res = await getRedis().ping();
  return res === 'PONG';
}

export async function closeRedis() {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
