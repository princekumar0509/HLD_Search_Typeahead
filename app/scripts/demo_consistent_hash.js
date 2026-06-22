// demo_consistent_hash.js — proves the two properties consistent hashing is
// supposed to give us (assignment "show consistent-hashing behavior"):
//
//   1. EVEN DISTRIBUTION — with virtual nodes, each physical node owns roughly
//      an equal share of keys (not the wildly uneven arcs you'd get with one
//      point per node).
//   2. PARTIAL REMAPPING — removing/adding ONE node moves only ~1/N of keys,
//      not almost all of them (which naive `hash % N` would).
//
// Pure Node, no deps — imports the same ring the app uses.
//   node app/scripts/demo_consistent_hash.js

import { ConsistentHashRing } from '../src/lib/consistentHash.js';

const NODES = (process.env.CACHE_NODES || 'cache-a,cache-b,cache-c')
  .split(',')
  .map((s) => s.trim());
const VNODES = Number(process.env.VNODES_PER_NODE || 150);
const NUM_KEYS = Number(process.env.DEMO_KEYS || 100000);

// Generate a stable set of synthetic prefix-like keys.
function makeKeys(n) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`prefix:${i}`);
  return keys;
}

function distribution(ring, keys) {
  const counts = Object.fromEntries(ring.nodeList.map((n) => [n, 0]));
  const owner = new Map();
  for (const k of keys) {
    const node = ring.getNode(k);
    counts[node]++;
    owner.set(k, node);
  }
  return { counts, owner };
}

function printDistribution(title, counts, total) {
  console.log(`\n${title}`);
  for (const [node, c] of Object.entries(counts)) {
    const pct = ((c / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${node.padEnd(10)} ${String(c).padStart(7)}  ${pct.padStart(5)}%  ${bar}`);
  }
}

const keys = makeKeys(NUM_KEYS);

// ---- 1. Even distribution with virtual nodes ----
const ring = new ConsistentHashRing(NODES, VNODES);
console.log(
  `Ring: ${NODES.length} physical nodes × ${VNODES} vnodes = ${ring.ringSize} ring points`
);
const before = distribution(ring, keys);
printDistribution(`Distribution of ${NUM_KEYS} keys across ${NODES.length} nodes:`, before.counts, NUM_KEYS);

// ---- 2. Partial remapping on node removal ----
const removed = NODES[NODES.length - 1];
ring.removeNode(removed);
const after = distribution(ring, keys);

let moved = 0;
for (const k of keys) if (before.owner.get(k) !== after.owner.get(k)) moved++;

printDistribution(`After removing "${removed}" — redistribution:`, after.counts, NUM_KEYS);

const movedPct = ((moved / NUM_KEYS) * 100).toFixed(1);
const idealPct = (100 / NODES.length).toFixed(1);
console.log(`\nKeys remapped after removing 1 of ${NODES.length} nodes: ${moved} (${movedPct}%)`);
console.log(`Ideal for consistent hashing: ~${idealPct}% (= keys that lived on the removed node).`);
console.log(
  `Naive hash%N would have remapped ~${(((NODES.length - 1) / NODES.length) * 100).toFixed(0)}% of ALL keys.`
);

// ---- 3. Re-adding the node restores (most of) the original mapping ----
ring.addNode(removed);
const readd = distribution(ring, keys);
let restored = 0;
for (const k of keys) if (before.owner.get(k) === readd.owner.get(k)) restored++;
console.log(
  `\nAfter re-adding "${removed}": ${((restored / NUM_KEYS) * 100).toFixed(1)}% of keys back to their original node (determinism check).`
);
