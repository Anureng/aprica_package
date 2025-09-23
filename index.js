/**
 * Aprica Monitor SDK (Node/Express)
 * - Low-cardinality metrics: method, route, status
 * - Latency histogram buckets (p95/p99 ready)
 * - Failure reasons (categorized; no bodies/headers)
 * - Rolling-window load detector (alerts via Aprica)
 * - HTTPS push with gzip, non-blocking
 *
 * ENV (optional):
 *   APRICA_INGEST_URL=https://ingest.aprica.dev/v1/metrics
 *   APRICA_ALERT_URL=https://ingest.aprica.dev/v1/alerts
 *   APRICA_FLUSH_MS=10000
 *   APRICA_LOAD_WINDOW_SEC=60
 *   APRICA_LOAD_RPS_WARN=50
 *   APRICA_LOAD_RPS_CRIT=100
 *   APRICA_DEBUG=1
 */

const os = require('os');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_INGEST = process.env.APRICA_INGEST_URL || 'https://ingest.aprica.dev/v1/metrics';
const DEFAULT_ALERT  = process.env.APRICA_ALERT_URL  || 'https://ingest.aprica.dev/v1/alerts';
const FLUSH_MS       = Number(process.env.APRICA_FLUSH_MS || 10_000);

const LOAD_WINDOW_SEC = Number(process.env.APRICA_LOAD_WINDOW_SEC || 60);
const LOAD_WARN       = Number(process.env.APRICA_LOAD_RPS_WARN || 50);
const LOAD_CRIT       = Number(process.env.APRICA_LOAD_RPS_CRIT || 100);

// Histogram buckets in seconds
const B = [0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 13];

// ---- in-memory state ----
const state = {
  counters: new Map(),       // "metric{labels}" -> number (delta)
  gauges:   new Map(),       // "metric{labels}" -> number (last value)
  histos:   new Map(),       // "metric{labels}" -> { b:[], c:count, s:sum }
  inflightByRoute: new Map(),// route -> number
  // load window (req timestamps in seconds, ring-buffer per second bucket)
  loadWindow: Array(LOAD_WINDOW_SEC).fill(0),
  loadIndex: 0,
  lastTickSec: Math.floor(Date.now()/1000),
  // failure reason counts (low-cardinality)
  failureReasons: new Map()  // "reason" -> count
};

function nowSec() { return Math.floor(Date.now()/1000); }

function advanceLoadWindow() {
  const cur = nowSec();
  let steps = cur - state.lastTickSec;
  if (steps <= 0) return;
  if (steps > LOAD_WINDOW_SEC) steps = LOAD_WINDOW_SEC; // cap

  for (let i = 0; i < steps; i++) {
    state.loadIndex = (state.loadIndex + 1) % LOAD_WINDOW_SEC;
    state.loadWindow[state.loadIndex] = 0;
  }
  state.lastTickSec = cur;
}

function addToLoadWindow(n=1) {
  advanceLoadWindow();
  state.loadWindow[state.loadIndex] += n;
}

function getRPS() {
  advanceLoadWindow();
  const total = state.loadWindow.reduce((a,b)=>a+b,0);
  return total / LOAD_WINDOW_SEC;
}

function k(name, labels) {
  if (!labels) return name;
  const s = Object.keys(labels).sort().map(x=>`${x}=${labels[x]}`).join(',');
  return `${name}{${s}}`;
}

function incCounter(name, labels, n=1) {
  const key = k(name, labels);
  state.counters.set(key, (state.counters.get(key) || 0) + n);
}

function gaugeSet(name, labels, v) {
  state.gauges.set(k(name, labels), v);
}

function observeHisto(name, labels, value) {
  const key = k(name, labels);
  let h = state.histos.get(key);
  if (!h) {
    h = { b: Array(B.length).fill(0), c: 0, s: 0 };
    state.histos.set(key, h);
  }
  // find bucket
  for (let i=0;i<B.length;i++) {
    if (value <= B[i]) { h.b[i]++; break; }
  }
  h.c++; h.s += value;
}

function classifyError(err, resStatus) {
  // Avoid PII/headers. Keep it coarse and safe.
  if (!err && resStatus && resStatus >= 500) return 'server_error';
  if (!err && resStatus && resStatus >= 400) return 'client_error';

  if (!err) return 'unknown_error';

  const name = (err.name || '').toLowerCase();
  const msg  = (err.message || '').toLowerCase();

  if (name.includes('timeout') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('validation') || name.includes('validation')) return 'validation_error';
  if (msg.includes('db') || msg.includes('mongo') || msg.includes('sql') || name.includes('sequelize')) return 'database_error';
  if (msg.includes('redis') || msg.includes('cache')) return 'cache_error';
  if (msg.includes('kafka') || msg.includes('queue') || msg.includes('rabbit')) return 'queue_error';
  if (msg.includes('axios') || msg.includes('fetch') || msg.includes('upstream') || msg.includes('econnrefused')) return 'upstream_error';
  return 'unhandled_exception';
}

function apricaMiddleware(opts = {}) {
  const normalizeRoute = opts.normalizeRoute || ((req) =>
    (req.route && req.route.path) || (req.baseUrl || req.path) || 'unknown'
  );

  // Optional hook to tag known failure reasons from your app
  const failureTag = opts.failureTag || ((req, res) => null);

  return function (req, res, next) {
    const start = process.hrtime.bigint();
    const route = normalizeRoute(req);
    const method = req.method;

    // increase inflight and load window
    const infl = (state.inflightByRoute.get(route) || 0) + 1;
    state.inflightByRoute.set(route, infl);
    gaugeSet('aprica_http_in_flight', { route }, infl);

    addToLoadWindow(1);

    let capturedErr = null;

    // Capture downstream errors if app uses next(err)
    const origNext = next;
    function wrappedNext(err) {
      if (err && !capturedErr) capturedErr = err;
      return origNext(err);
    }

    // finish handler
    res.on('finish', () => {
      const status = String(res.statusCode);
      const dur = Number(process.hrtime.bigint() - start) / 1e9;

      incCounter('aprica_http_requests_total', { method, route, status }, 1);
      observeHisto('aprica_http_request_duration_seconds', { method, route, status }, dur);

      const nowInfl = Math.max((state.inflightByRoute.get(route) || 1) - 1, 0);
      state.inflightByRoute.set(route, nowInfl);
      gaugeSet('aprica_http_in_flight', { route }, nowInfl);

      // failure tagging: from error or status code
      const tag = failureTag(req, res);
      if (res.statusCode >= 400 || capturedErr || tag) {
        const reason = tag || classifyError(capturedErr, res.statusCode);
        state.failureReasons.set(reason, (state.failureReasons.get(reason) || 0) + 1);
        incCounter('aprica_http_failures_total', { method, route, reason }, 1);
      }
    });

    return origNext === wrappedNext ? next() : wrappedNext();
  };
}

// ----- Exporter / Flusher -----
function makeAgent() {
  return new https.Agent({ keepAlive: true, timeout: 15_000, maxSockets: 50 });
}

function pushGz(urlStr, headers, buffer) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers,
        agent: makeAgent()
      }, (res) => {
        // Drain and resolve; we don't block app even on non-200
        res.on('data', ()=>{});
        res.on('end', resolve);
      });
      req.on('error', resolve);
      req.end(buffer);
    } catch (_) { resolve(); }
  });
}

function startApricaExporter({ orgId, apiKey, endpoint = DEFAULT_INGEST, alertEndpoint = DEFAULT_ALERT, service, environment } = {}) {
  if (!orgId || !apiKey) throw new Error('Aprica: orgId and apiKey required');

  const base = {
    service: service || process.env.APRICA_SERVICE || 'unknown-service',
    environment: environment || process.env.NODE_ENV || 'development',
    host: os.hostname(),
    runtime: `node_${process.version}`,
    sdk: 'aprica-monitor@1',
  };

  async function flushOnce() {
    // snapshot
    const series = [];

    for (const [key, v] of state.counters.entries()) series.push({ t: 'counter', k: key, v });
    state.counters.clear();

    for (const [key, v] of state.gauges.entries()) series.push({ t: 'gauge', k: key, v });

    for (const [key, h] of state.histos.entries()) series.push({ t: 'hist', k: key, b: B, c: h.c, s: h.s, n: h.b });
    state.histos.clear();

    // Failure reasons (optional top-level summary)
    const failures = [];
    for (const [reason, count] of state.failureReasons.entries()) failures.push([reason, count]);
    state.failureReasons.clear();

    if (series.length === 0 && failures.length === 0) return;

    const payload = {
      ts: Date.now(),
      base,
      series,
      failures
    };

    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    if (process.env.APRICA_DEBUG) console.log('[Aprica] flush', { points: series.length, failures: failures.length });

    await pushGz(endpoint, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'X-Aprica-Org': orgId,
      'X-Aprica-Key': apiKey
    }, gz);
  }

  // simple local load alerting (optional: also do on server)
  async function maybeSendLoadAlert() {
    const rps = getRPS();
    let level = null;
    if (rps >= LOAD_CRIT) level = 'critical';
    else if (rps >= LOAD_WARN) level = 'warning';
    if (!level) return;

    const payload = {
      ts: Date.now(),
      type: 'high_load',
      level,
      rps,
      base
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    await pushGz(alertEndpoint, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'X-Aprica-Org': orgId,
      'X-Aprica-Key': apiKey
    }, gz);
  }

  const flushTimer = setInterval(flushOnce, Math.max(FLUSH_MS, 3000) + Math.floor(Math.random()*300));
  flushTimer.unref?.();

  const loadTimer = setInterval(maybeSendLoadAlert, 5_000);
  loadTimer.unref?.();

  const shutdown = async () => { try { await flushOnce(); } catch {} process.exit(0); };
  process.on('beforeExit', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    flush: flushOnce,
    stop: () => { clearInterval(flushTimer); clearInterval(loadTimer); }
  };
}

// Utility: generate a safe, opaque request ID for correlation (optional)
function requestId() {
  return crypto.randomBytes(12).toString('base64url');
}

module.exports = {
  apricaMiddleware,
  startApricaExporter,
  requestId
};
