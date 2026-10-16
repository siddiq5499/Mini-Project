/**
 * PRACTICE TEAMS: stand-ins for Team A, Team B and Team C so you can test the connection BEFORE the real teams are ready.
 * They follow the endpoints in the design document. Run:   node practice-teams.js
 * Then put these lines in Backend/.env and restart server.js:
 *   TEAM_C_URL=http://localhost:4000   TEAM_C_KEY=practice-c-key
 *   TEAM_B_URL=http://localhost:4002   TEAM_B_KEY=practice-b-key
 *   TEAM_A_URL=http://localhost:4001   TEAM_A_KEY=practice-a-key
 * (Data here lives in memory only and is lost when you stop this program.)
 */
const http = require('http'), crypto = require('crypto');
const HOUR = 3600e3, db = { providers: [], users: [], appts: [], idem: {} };
const live = (a) => ['CONFIRMED', 'RESCHEDULED'].includes(a.state);

function team(name, port, key, handler) {
  http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const ok = (d, s = 200) => send(s, { data: d, meta: { api_version: 'v1' } });
      const err = (s, code, message) => send(s, { error: { code, message } });
      if (req.headers.authorization !== 'Bearer ' + key) return err(401, 'UNAUTHENTICATED', `${name}: missing or wrong key`);
      const body = raw ? JSON.parse(raw) : {}, u = new URL(req.url, 'http://x');
      console.log(`[${name}] ${req.method} ${u.pathname}  correlation=${req.headers['x-correlation-id'] || '-'}`);
      handler(req.method, u.pathname, body, req, ok, err);
    });
  }).listen(port, () => console.log(`${name} listening on http://localhost:${port}  (key: ${key})`));
}

/* TEAM C: users, doctors, appointments */
team('Team C', 4000, 'practice-c-key', (m, p, b, req, ok, err) => {
  if (m === 'POST' && p === '/api/v1/users') {
    const id = crypto.randomUUID(); const u = { user_id: id, ...b };
    if (b.role === 'PROVIDER') { u.provider_id = 'P' + (db.providers.length + 1); db.providers.push({ provider_id: u.provider_id, name: b.name, service: b.service, status: 'ACTIVE' }); }
    db.users.push(u); return ok(u, 201);
  }
  if (m === 'GET' && p === '/api/v1/providers') return ok(db.providers);
  if (m === 'PATCH' && p.startsWith('/internal/v1/providers/')) { const d = db.providers.find((x) => x.provider_id === p.split('/').pop()); if (!d) return err(404, 'NOT_FOUND', 'No such doctor'); Object.assign(d, b); return ok(d); }
  if (m === 'POST' && p === '/api/v1/appointments') {
    const key = req.headers['idempotency-key']; if (key && db.idem[key]) return ok(db.idem[key]);
    const free = (s) => !db.appts.some((a) => a.provider_id === b.provider_id && a.start === s && live(a));
    const a = { appointment_id: b.appointment_id, user_id: b.user_id, provider_id: b.provider_id, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), state: 'CONFIRMED', priority: b.priority };
    if (!free(a.start)) {
      if (b.priority !== 'EMERGENCY') return err(409, 'SLOT_CONFLICT', 'That slot is already booked');
      let carry = db.appts.find((x) => x.provider_id === a.provider_id && x.start === a.start && live(x)), t = new Date(a.start).getTime();
      while (carry) { t += HOUR; const s = new Date(t).toISOString(); const next = db.appts.find((x) => x.provider_id === a.provider_id && x.start === s && live(x) && x !== carry); carry.start = s; carry.end = new Date(t + HOUR).toISOString(); carry.state = 'RESCHEDULED'; carry = next; }
    }
    db.appts.push(a); if (key) db.idem[key] = a; return ok(a, 201);
  }
  const m1 = p.match(/^\/api\/v1\/appointments\/([^/]+)(\/cancel)?$/);
  if (m1) { const a = db.appts.find((x) => x.appointment_id === m1[1]); if (!a) return err(404, 'NOT_FOUND', 'No such appointment'); if (m === 'POST' && m1[2]) a.state = 'CANCELLED'; return ok(a); }
  err(404, 'NOT_FOUND', 'Unknown Team C endpoint');
});

/* TEAM B: availability search */
team('Team B', 4002, 'practice-b-key', (m, p, b, req, ok, err) => {
  if (m === 'POST' && p === '/api/v1/availability/search') {
    const out = [], end = new Date(b.date_range.end).getTime();
    for (let t = new Date(b.date_range.start).getTime(); t < end; t += HOUR) {
      const s = new Date(t), iso = s.toISOString();
      if (!live({ state: 'CONFIRMED' }) || s.getHours() < 9 || s.getHours() > 16) continue;
      if (!db.appts.some((a) => a.provider_id === b.provider_id && a.start === iso && live(a))) out.push({ start: iso, end: new Date(t + HOUR).toISOString() });
    }
    return ok({ search_id: crypto.randomUUID(), ranked_free_slots: out, calendar_version: 'v' + db.appts.length, algorithm: b.algorithm });
  }
  err(404, 'NOT_FOUND', 'Unknown Team B endpoint');
});

/* TEAM A: queue and metrics */
team('Team A', 4001, 'practice-a-key', (m, p, b, req, ok, err) => {
  const q = p.match(/^\/api\/v1\/providers\/([^/]+)\/queue$/);
  if (m === 'GET' && q) return ok(db.appts.filter((a) => a.provider_id === q[1] && live(a)).sort((x, y) => x.start.localeCompare(y.start)).map((a, i) => ({ appointment_id: a.appointment_id, queue_position: i + 1, state: a.state, estimated_start: a.start })));
  if (m === 'GET' && p === '/api/v1/metrics/scheduling') return ok({ queue_depth: db.appts.filter(live).length, throughput_per_hour: 12, avg_wait_minutes: 18, starvation_alerts: 0 });
  err(404, 'NOT_FOUND', 'Unknown Team A endpoint');
});
