// consistentHash.js — a consistent hash ring WITH VIRTUAL NODES, from scratch.
//
// Implemented by hand (not Redis Cluster's built-in slot hashing) because the
// assignment specifically wants this algorithm understood and explainable.
//
// THE PROBLEM IT SOLVES
// ---------------------
// Naive sharding does `node = hash(key) % N`. If N changes (add/remove a cache
// node), `% N` changes for almost EVERY key, so the whole cache is invalidated
// at once — a thundering-herd of misses onto Postgres. Consistent hashing makes
// adding/removing one node remap only ~1/N of keys instead of ~all of them.
//
// THE ALGORITHM
// -------------
// 1. Map both NODES and KEYS onto the same fixed numeric circle [0, 2^32).
// 2. A key is owned by the FIRST node found walking clockwise from the key's
//    position (wrapping past the top back to the start).
// 3. When a node leaves, only the keys that fell on the arc it covered move —
//    to the next node clockwise. Every other key keeps its owner. Adding a node
//    is the same in reverse: it "steals" only the arc now in front of it.
//
// VIRTUAL NODES
// -------------
// With one point per node, arcs are wildly uneven (one node may own 60% of the
// circle by luck) and removing a node dumps its entire arc onto a single
// neighbour. So we place ~150 "virtual nodes" per physical node — 150 points
// scattered around the circle that all map back to the same physical node. This
// (a) evens out the load and (b) on removal spreads the orphaned keys across
// MANY neighbours instead of one. 150 is the usual sweet spot: variance is low
// and the sorted ring stays small enough to binary-search in microseconds.

// FNV-1a 32-bit hash. Chosen because it is tiny, dependency-free, deterministic,
// and well-distributed for short strings — exactly what a ring position needs.
// (Cryptographic strength is irrelevant here; speed and spread are what matter.)
function fnv1a32(str) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // hash *= 16777619 (FNV prime), done with shifts to stay in 32-bit range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0; // force unsigned 32-bit
}

export class ConsistentHashRing {
  /**
   * @param {string[]} nodes        physical node ids (logical cache nodes here)
   * @param {number}   vnodesPerNode virtual replicas per physical node
   */
  constructor(nodes = [], vnodesPerNode = 150) {
    this.vnodesPerNode = vnodesPerNode;
    // ring: sorted array of { hash, node }. Kept sorted by hash so a key's owner
    // is found with a binary search instead of scanning all points.
    this.ring = [];
    this.nodes = new Set();
    for (const node of nodes) this.addNode(node);
  }

  // The label we hash for virtual node #i of a physical node. Stable so the ring
  // rebuilds identically across processes/restarts (every replica agrees on
  // ownership — essential for a shared cache).
  _vnodeKey(node, i) {
    return `${node}#${i}`;
  }

  addNode(node) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.vnodesPerNode; i++) {
      this.ring.push({ hash: fnv1a32(this._vnodeKey(node, i)), node });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter((p) => p.node !== node);
  }

  // Find the owning node for a key: first ring point clockwise from hash(key).
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = fnv1a32(key);

    // Binary search for the first ring point with hash >= h.
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].hash) return this.ring[0].node; // wrap around the top
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo].node;
  }

  // Introspection for the consistent-hashing demo (distribution stats).
  get nodeList() {
    return [...this.nodes];
  }
  get ringSize() {
    return this.ring.length;
  }
}

export default ConsistentHashRing;
