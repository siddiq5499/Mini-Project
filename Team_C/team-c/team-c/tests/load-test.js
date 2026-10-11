'use strict';
/**
 * Load / concurrency evidence for Team C (KPIs: booking safety, commit latency p95 <= 500 ms).
 *   Windows PowerShell:  $env:SERVICE_KEY="<key>"; $env:N="500"; node tests/load-test.js
 * Set RATE_LIMIT_PER_MIN=0 in Team C's .env first (otherwise the rate limiter will stop the test) and restart Team C.
 * N = number of concurrent bookings (default 500; use 10000 for the full KPI run). CONC = parallel requests (default 100).
 * Writes tests/load-results.json (raw numbers for your evidence pack).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:4000';
const KEY = process.env.SERVICE_KEY || '';
const N = Number(process.env.N || 500), CONC = Number(process.env.CONC || 100);
const HOT = Math.min(N, 200);

async function call(method, p, body, headers = {}) {
  const t0 = performance.now();
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Correlation-ID': 'load-' + crypto.randomUUID(), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, ms: performance.now() - t0 };
}
async function pool(items, worker) {          // run `worker` over items, CONC at a time
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); } }));
  return out;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10 : 0; };
const dayStr = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  if (!KEY) { console.error('Set SERVICE_KEY first.'); process.exit(1); }
  const started = new Date().toISOString();
  console.log(`Load test: N=${N}, concurrency=${CONC}`);

  // 1. patients
  const phoneBase = 6000000000 + Math.floor(Math.random() * 90000000);
  const patients = await pool(Array.from({ length: N }, (_, i) => i), async (i) => {
    const r = await call('POST', '/api/v1/users', { role: 'PATIENT', name: 'Load Patient ' + i, phone: String(phoneBase + i) });
    if (!r.body.data) throw new Error('Could not create a test patient: ' + JSON.stringify(r.body));
    return r.body.data.user_id;
  });
  console.log(`created ${patients.length} test patients`);

  // 2. HOT SLOT: HOT patients try to book exactly the same slot at the same moment
  const hotDate = dayStr(200 + Math.floor(Math.random() * 100));
  const hot = await Promise.all(patients.slice(0, HOT).map((u) => call('POST', '/api/v1/appointments',
    { appointment_id: crypto.randomUUID(), user_id: u, provider_id: 'DR-002', service_type: 'Neurologist', start: `${hotDate}T10:00:00Z`, end: `${hotDate}T10:10:00Z`, priority: 'NORMAL', purpose: 'hot slot' },
    { 'Idempotency-Key': 'hot-' + crypto.randomUUID() })));
  const hotOk = hot.filter((r) => r.status === 201).length, hotConflict = hot.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_CONFLICT').length;
  console.log(`hot slot: ${HOT} simultaneous requests -> ${hotOk} confirmed, ${hotConflict} SLOT_CONFLICT, ${HOT - hotOk - hotConflict} other`);

  // 3. DISTRIBUTED: N bookings for DR-003 spread over days, Team C assigns token + slot
  const PER_DAY = 400;
  await call('PATCH', '/internal/v1/providers/DR-003', { daily_token_limit: 500 });
  const base = 300 + Math.floor(Math.random() * 100), days = Math.ceil(N / PER_DAY);
  const lat = [], codes = {};
  const t0 = performance.now();
  await pool(patients.map((u, i) => ({ u, d: dayStr(base + Math.floor(i / PER_DAY)) })), async ({ u, d }) => {
    const r = await call('POST', '/api/v1/appointments', { appointment_id: crypto.randomUUID(), user_id: u, provider_id: 'DR-003', service_type: 'Orthopedics', date: d, priority: 'NORMAL', purpose: 'load' }, { 'Idempotency-Key': 'ld-' + crypto.randomUUID() });
    lat.push(r.ms); const k = r.status + (r.body.error ? ' ' + r.body.error.code : ''); codes[k] = (codes[k] || 0) + 1;
  });
  const seconds = (performance.now() - t0) / 1000;
  await call('PATCH', '/internal/v1/providers/DR-003', { daily_token_limit: 30 });

  // 4. verify: no duplicate token / start time per day
  let rows = 0, dupTokens = 0, dupStarts = 0;
  for (let k = 0; k < days; k++) {
    const l = await call('GET', `/api/v1/appointments?provider_id=DR-003&date=${dayStr(base + k)}&limit=1000`);
    const list = l.body.data || []; rows += list.length;
    const tk = new Set(), st = new Set();
    list.forEach((a) => { if (tk.has(a.token_number)) dupTokens++; tk.add(a.token_number); if (st.has(a.start)) dupStarts++; st.add(a.start); });
  }
  const rv = await call('POST', '/internal/v1/recovery/verify');

  const res = {
    started, finished: new Date().toISOString(), config: { N, CONC, base: BASE },
    hot_slot: { requests: HOT, confirmed: hotOk, slot_conflict: hotConflict, other: HOT - hotOk - hotConflict, pass: hotOk === 1 },
    distributed: { requests: N, seconds: Math.round(seconds * 10) / 10, throughput_per_s: Math.round((N / seconds) * 10) / 10, status_codes: codes, rows_stored: rows,
      latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.round(Math.max(...lat)) } },
    safety: { duplicate_tokens: dupTokens, duplicate_start_times: dupStarts, db_integrity: rv.body.data ? rv.body.data.status : 'unknown', violations: rv.body.data ? rv.body.data.violations : null },
    kpi: {
      booking_safety_0_double_bookings: dupTokens === 0 && dupStarts === 0 && hotOk === 1,
      commit_latency_p95_le_500ms: pct(lat, 95) <= 500
    }
  };
  fs.writeFileSync(path.join(__dirname, 'load-results.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  console.log(`\nRESULT: booking safety ${res.kpi.booking_safety_0_double_bookings ? 'PASS' : 'FAIL'} | p95 ${res.distributed.latency_ms.p95} ms ${res.kpi.commit_latency_p95_le_500ms ? 'PASS' : 'FAIL'} (target <= 500)`);
  console.log('Saved tests/load-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
