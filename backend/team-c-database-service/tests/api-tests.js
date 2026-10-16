'use strict';
/* Proof of tests (Team_C_req.txt, section E):  node tests/api-tests.js
   Needs the DB loaded and the service running.  Env: BASE (default http://localhost:4000), SERVICE_KEY */
const crypto = require('crypto');
const BASE = process.env.BASE || 'http://localhost:4000';
const KEY = process.env.SERVICE_KEY || '';
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); };
async function call(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Correlation-ID': 'test-' + crypto.randomUUID(), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const h = await call('GET', '/health'); ok(h.status === 200 && h.body.status === 'ok', 'GET /health');
  const noKey = await fetch(BASE + '/api/v1/providers'); ok(noKey.status === 401, 'missing key -> 401 UNAUTHENTICATED');

  // fresh patients so the tests can be re-run any number of times
  const mk = async (i) => {
    const r = await call('POST', '/api/v1/users', { role: 'PATIENT', name: 'Test Patient ' + i, phone: String(7000000000 + Math.floor(Math.random() * 99999999)) });
    if (!r.body.data) throw new Error('Creating a test patient failed. HTTP ' + r.status + ' ' + JSON.stringify(r.body));
    return r.body.data.user_id;
  };
  const [p1, p2, p3] = [await mk(1), await mk(2), await mk(3)];
  const date = day(5 + Math.floor(Math.random() * 20));          // a random future day = empty calendar
  const start = `${date}T11:00:00Z`, end = `${date}T11:10:00Z`;
  const book = (user, key, extra = {}) => call('POST', '/api/v1/appointments', { appointment_id: crypto.randomUUID(), user_id: user, provider_id: 'DR-001', service_type: 'Cardiologist', start, end, priority: 'NORMAL', purpose: 'test', ...extra }, { 'Idempotency-Key': key });

  // 1. duplicate Idempotency-Key
  const key = 'idem-' + crypto.randomUUID();
  const a = await book(p1, key), b = await book(p1, key);
  ok(a.status === 201 && a.body.data.state === 'CONFIRMED', 'booking -> 201 CONFIRMED', JSON.stringify(a.body));
  ok(b.status === 201 && b.body.data.appointment_id === a.body.data.appointment_id && b.headers.get('idempotent-replay') === 'true', 'same Idempotency-Key returns the ORIGINAL appointment');
  const list = await call('GET', `/api/v1/appointments?user_id=${p1}&date=${date}`);
  ok(list.body.data.length === 1, 'duplicate key created NO second row', JSON.stringify(list.body));

  // 2. two parallel bookings for the same slot -> exactly one wins
  const rs = await Promise.all([book(p2, 'par-' + crypto.randomUUID()), book(p3, 'par-' + crypto.randomUUID())]);
  const codes = rs.map((r) => r.status).sort();
  ok(a.status === 201 && rs.every((r) => r.status === 409 && r.body.error.code === 'SLOT_CONFLICT'), 'slot already taken -> 409 SLOT_CONFLICT');
  const date2 = day(30 + Math.floor(Math.random() * 20));
  const s2 = { start: `${date2}T12:00:00Z`, end: `${date2}T12:10:00Z` };
  const rp = await Promise.all([book(p2, 'pp-' + crypto.randomUUID(), s2), book(p3, 'pp-' + crypto.randomUUID(), s2)]);
  const st = rp.map((r) => r.status).sort();
  ok(st[0] === 201 && st[1] === 409, 'two PARALLEL bookings, same slot: one 201, one 409', JSON.stringify(st));

  // 3. illegal transition
  const id = a.body.data.appointment_id;
  const bad = await call('POST', `/internal/v1/appointments/${id}/transition`, { to_state: 'COMPLETED' });
  ok(bad.status === 409 && bad.body.error.code === 'ILLEGAL_TRANSITION', 'CONFIRMED -> COMPLETED is 409 ILLEGAL_TRANSITION', JSON.stringify(bad.body));
  const good = await call('POST', `/internal/v1/appointments/${id}/transition`, { to_state: 'CALLED' });
  ok(good.status === 200 && good.body.data.state === 'CALLED' && good.body.data.version === 2, 'CONFIRMED -> CALLED ok, version 2');

  // 3b. absent patient: new token at the end, then waitlist and restore
  const rs1 = await call('POST', `/internal/v1/appointments/${id}/transition`, { to_state: 'RESCHEDULED', new_token: true });
  ok(rs1.status === 200 && rs1.body.data.state === 'RESCHEDULED' && rs1.body.data.token_number > a.body.data.token_number, 'CALLED -> RESCHEDULED with new_token gives a later token', JSON.stringify(rs1.body));
  const wl = await call('POST', `/internal/v1/appointments/${id}/transition`, { to_state: 'WAITLISTED' });
  const rst = await call('POST', `/internal/v1/appointments/${id}/transition`, { to_state: 'RESCHEDULED' });
  ok(wl.status === 200 && rst.status === 200 && rst.body.data.token_number === rs1.body.data.token_number, 'WAITLISTED -> RESCHEDULED restores the same token', JSON.stringify([wl.body, rst.body]));

  // 4. emergency pushes others later
  const date3 = day(60 + Math.floor(Math.random() * 20));
  const e1 = await book(p2, 'e1-' + crypto.randomUUID(), { start: `${date3}T09:00:00Z`, end: `${date3}T09:10:00Z` });
  const em = await book(p3, 'em-' + crypto.randomUUID(), { start: `${date3}T09:00:00Z`, end: `${date3}T09:10:00Z`, priority: 'EMERGENCY' });
  ok(em.status === 201 && em.body.data.rescheduled.length === 1 && em.body.data.rescheduled[0].appointment_id === e1.body.data.appointment_id && em.body.data.rescheduled[0].state === 'RESCHEDULED', 'EMERGENCY takes the slot, earlier booking RESCHEDULED', JSON.stringify(em.body));

  // 4b. day off / working hours
  const off = `${day(120 + Math.floor(Math.random() * 20))}`;
  const so = await call('PUT', '/internal/v1/providers/DR-001/schedule', { date: off, closed: true });
  const bo = await book(p1, 'off-' + crypto.randomUUID(), { start: undefined, end: undefined, date: off });
  ok(so.status === 200 && bo.status === 409 && bo.body.error.code === 'PROVIDER_UNAVAILABLE', 'day off -> booking refused with PROVIDER_UNAVAILABLE', JSON.stringify([so.body, bo.body]));
  const sr = await call('PUT', '/internal/v1/providers/DR-001/schedule', { date: off, reset: true });
  const bo2 = await book(p1, 'off2-' + crypto.randomUUID(), { start: undefined, end: undefined, date: off });
  ok(sr.status === 200 && bo2.status === 201, 'schedule reset -> booking works again', JSON.stringify([sr.body, bo2.body]));
  const badHours = await call('PUT', '/internal/v1/providers/DR-001/schedule', { date: off, start: '17:00', end: '09:00' });
  ok(badHours.status === 400, 'working hours with end before start -> VALIDATION_ERROR');

  // 4c. integrity check
  const rv = await call('POST', '/internal/v1/recovery/verify');
  ok(rv.status === 200 && rv.body.data.status === 'OK', 'recovery/verify: no integrity violations', JSON.stringify(rv.body));

  // 5. audit + correlation id
  const au = await call('GET', `/api/v1/audit?entity_id=${id}`);
  ok(au.body.data.length >= 2 && au.body.data.every((r) => r.correlation_id && r.actor), 'audit rows carry actor + correlation_id');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });