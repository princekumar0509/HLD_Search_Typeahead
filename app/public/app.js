// app.js — vanilla-JS typeahead + live metrics dashboard. No framework/build.

const $ = (id) => document.getElementById(id);
const qInput = $('q');
const goBtn = $('go');
const list = $('suggestions');
const statusEl = $('status');

let activeIndex = -1;
let items = [];
let lastReqId = 0;
let currentOwner = null; // logical node owning the current prefix (for ring highlight)
let ringNodes = [];

const fmt = (n) => Number(n).toLocaleString('en-US');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Typeahead ──────────────────────────────────────────────
// WHY 250ms debounce: typing bursts at ~5-8 keys/sec; without it every keystroke
// would hit the backend and waste the cache. 250ms waits for a natural pause so
// a word triggers ~one request, not eight (assignment §4.1).
async function fetchSuggestions() {
  const q = qInput.value.trim();
  updateRoute(q); // show which cache node owns this prefix as you type
  if (q === '') { renderSuggestions([]); return; }
  const reqId = ++lastReqId;
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=basic`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (reqId !== lastReqId) return; // newer request already fired
    renderSuggestions(data.suggestions || []);
    $('r-lat').textContent = `${data.latency_ms}ms`;
  } catch {
    if (reqId !== lastReqId) return;
    renderSuggestions([]);
    setStatus('Suggestions unavailable (backend down?)', 'error');
  }
}

function renderSuggestions(suggestions) {
  items = suggestions; activeIndex = -1;
  if (!suggestions.length) { list.hidden = true; list.innerHTML = ''; return; }
  const prefix = qInput.value.trim().toLowerCase();
  list.innerHTML = suggestions.map((s, i) => {
    const q = s.query;
    const marked = prefix && q.toLowerCase().startsWith(prefix)
      ? `<mark>${escapeHtml(q.slice(0, prefix.length))}</mark>${escapeHtml(q.slice(prefix.length))}`
      : escapeHtml(q);
    return `<li role="option" data-i="${i}"><span>${marked}</span><span class="score">${fmt(Math.round(s.score))}</span></li>`;
  }).join('');
  list.hidden = false;
}

function highlight(idx) {
  const lis = [...list.children];
  lis.forEach((li, i) => li.classList.toggle('active', i === idx));
  activeIndex = idx;
  if (lis[idx]) lis[idx].scrollIntoView({ block: 'nearest' });
}

qInput.addEventListener('keydown', (e) => {
  if (list.hidden) { if (e.key === 'Enter') submitSearch(qInput.value.trim()); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight((activeIndex + 1) % items.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((activeIndex - 1 + items.length) % items.length); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const chosen = activeIndex >= 0 ? items[activeIndex].query : qInput.value.trim();
    qInput.value = chosen; list.hidden = true; submitSearch(chosen);
  } else if (e.key === 'Escape') { list.hidden = true; }
});

list.addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const chosen = items[Number(li.dataset.i)].query;
  qInput.value = chosen; list.hidden = true; submitSearch(chosen);
});

// ── Cache routing as you type (GET /cache/debug) ───────────
const updateRoute = debounce(async (q) => {
  if (!q) { $('r-prefix').textContent = '—'; $('r-node').textContent = '—';
    $('r-state').textContent = '—'; $('r-state').className = 'state'; currentOwner = null; renderRing(); return; }
  try {
    const res = await fetch(`/cache/debug?prefix=${encodeURIComponent(q)}`);
    const d = await res.json();
    $('r-prefix').textContent = d.prefix;
    $('r-node').textContent = d.owner_node;
    const st = d.cache_state.basic;
    $('r-state').textContent = st;
    $('r-state').className = 'state ' + st;
    currentOwner = d.owner_node;
    if (d.ring?.nodes) ringNodes = d.ring.nodes;
    renderRing();
  } catch { /* ignore */ }
}, 200);

// ── Search submission ──────────────────────────────────────
async function submitSearch(query) {
  if (!query) return;
  setStatus('Searching…');
  try {
    // 1) record the search (write path → Redis buffer, returns instantly)
    const res = await fetch('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    // 2) read suggestions for it (cache-aside READ path). This is what makes the
    //    hit rate climb when you search the same query repeatedly: the first
    //    read is a miss that populates the cache, every repeat is a HIT (the
    //    flusher no longer evicts it — freshness is bounded by TTL instead).
    try {
      const sres = await fetch(`/suggest?q=${encodeURIComponent(query)}&mode=basic`);
      const sd = await sres.json();
      $('r-prefix').textContent = (query.trim().toLowerCase()).slice(0, 64) || '—';
      if (sd.cache) {
        $('r-node').textContent = sd.cache.node;
        $('r-state').textContent = sd.cache.hit ? 'hit' : 'miss';
        $('r-state').className = 'state ' + (sd.cache.hit ? 'hit' : 'miss');
        $('r-lat').textContent = `${sd.latency_ms}ms`;
        currentOwner = sd.cache.node; renderRing();
      }
    } catch { /* ignore read errors */ }
    setStatus(`✓ ${data.message}: "${data.query}" — recorded; climbs Trending within ~5s (next flush)`, 'ok');
    refreshStats(); setTimeout(refreshBoards, 1300);
  } catch { setStatus('Search submission failed', 'error'); }
}

// ── Live metric cards (GET /stats) ─────────────────────────
const latHist = [];   // rolling p95 samples for the sparkline
const hitHist = [];    // rolling hit-rate samples
const HIST = 40;
let prev = {};         // previous values, to flash cards on change

function setVal(id, val, { flashCard } = {}) {
  const el = $(id);
  const str = typeof val === 'number' ? fmt(val) : val;
  if (el.textContent !== str) {
    el.textContent = str;
    if (flashCard) { const c = el.closest('.card'); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  }
}

function sparkline(svgId, data, color, { pct } = {}) {
  const svg = $(svgId);
  if (data.length < 2) { svg.innerHTML = ''; return; }
  const max = pct ? 100 : Math.max(...data, 1);
  const min = 0;
  const W = 100, H = 30;
  const step = W / (data.length - 1);
  const y = (v) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4);
  const pts = data.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const line = pts.join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  svg.innerHTML =
    `<polyline points="${area}" fill="${color}" opacity="0.12" stroke="none"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
}

async function refreshStats() {
  try {
    const res = await fetch('/stats');
    const d = await res.json();
    $('live-dot').classList.remove('beat'); void $('live-dot').offsetWidth; $('live-dot').classList.add('beat');

    const lat = d.suggest_latency_ms;
    setVal('m-p95', lat.p95); setVal('m-p50', lat.p50); setVal('m-p99', lat.p99); setVal('m-samples', lat.samples);
    latHist.push(lat.p95); if (latHist.length > HIST) latHist.shift();
    sparkline('spark-lat', latHist, '#5b9dff');

    const hr = Math.round(d.cache.hit_rate * 100);
    setVal('m-hitrate', hr); setVal('m-hits', d.cache.hits); setVal('m-misses', d.cache.misses);
    hitHist.push(hr); if (hitHist.length > HIST) hitHist.shift();
    sparkline('spark-hit', hitHist, '#41d6a3', { pct: true });

    setVal('m-searches', d.batch_writes.search_submissions, { flashCard: true });
    setVal('m-writes', d.postgres.writes, { flashCard: true });
    setVal('m-reduction', d.batch_writes.write_reduction_factor ?? '—');
    setVal('m-subs', d.batch_writes.search_submissions);
    setVal('m-batches', d.batch_writes.postgres_write_statements);

    const qd = d.write_queue_depth;
    setVal('m-queue', qd, { flashCard: qd > (prev.queue || 0) });
    // Bar scales against the flush batch size (1000) so a burst visibly fills it.
    $('queue-fill').style.width = Math.min(100, (qd / 1000) * 100) + '%';
    prev.queue = qd;

  } catch { /* keep last values on a transient error */ }
}

// ── Consistent-hash ring + keyspace distribution (GET /cache/ring) ──
let ringDist = null; // { sample, total_vnodes, nodes:[{node,keys,share}] }
async function fetchRing() {
  try {
    const res = await fetch('/cache/ring');
    ringDist = await res.json();
    ringNodes = ringDist.nodes.map((n) => n.node);
    renderRing();
  } catch { /* ignore */ }
}

function renderRing() {
  if (!ringDist) return;
  const per = Math.round(ringDist.total_vnodes / ringDist.nodes.length);
  const maxShare = Math.max(...ringDist.nodes.map((n) => n.share), 0.0001);
  $('ring').innerHTML = ringDist.nodes.map((n) => {
    const owner = n.node === currentOwner;
    const pct = (n.share * 100).toFixed(1);
    return `<div class="node ${owner ? 'owner' : ''}">
      <div class="node-row"><span class="nm">${escapeHtml(n.node)}</span>
        <span class="node-share">${pct}%</span></div>
      <div class="node-bar"><span style="width:${(n.share / maxShare * 100).toFixed(1)}%"></span></div>
      <div class="meta">${per} vnodes · ${fmt(n.keys)} of ${fmt(ringDist.sample)} keys${owner ? ' · ◀ owns current prefix' : ''}</div>
    </div>`;
  }).join('');
}

// ── Leaderboards (GET /top) ────────────────────────────────
let lastTrend = new Set();
function renderBoard(tbodyId, rows, scoreKey, otherKey, trackBump) {
  const tbody = $(tbodyId);
  if (!rows || !rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="muted">no data yet — search something</td></tr>'; return; }
  const nextSet = new Set(rows.map((r) => r.query));
  tbody.innerHTML = rows.map((r, i) => {
    const isNew = trackBump && !lastTrend.has(r.query);
    return `<tr class="${isNew ? 'bump' : ''}"><td class="rank">${i + 1}</td><td>${escapeHtml(r.query)}</td>` +
      `<td class="num">${fmt(Math.round(r[scoreKey]))}</td>` +
      `<td class="num muted">${fmt(Math.round(r[otherKey]))}</td></tr>`;
  }).join('');
  if (trackBump) lastTrend = nextSet;
}

async function refreshBoards() {
  try {
    const res = await fetch('/top?limit=10');
    const d = await res.json();
    renderBoard('trending-body', d.trending, 'trending_score', 'all_time_count', true);
    renderBoard('popular-body', d.popular, 'all_time_count', 'trending_score', false);
  } catch { /* ignore */ }
}

// ── Wiring ─────────────────────────────────────────────────
qInput.addEventListener('input', debounce(fetchSuggestions, 250));
goBtn.addEventListener('click', () => submitSearch(qInput.value.trim()));
document.addEventListener('click', (e) => { if (!e.target.closest('.searchbox')) list.hidden = true; });

refreshStats(); refreshBoards(); fetchRing();
setInterval(refreshStats, 1500);  // metrics feel live
setInterval(refreshBoards, 5000); // boards: 5s poll keeps /top (uncached) DB reads low
setInterval(fetchRing, 15000);    // distribution is ~static; refresh occasionally
