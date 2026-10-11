'use strict';
/**
 * Team D -> Team C REST client.  Copy this file into  M_Final/Backend/  next to server.js.
 * Zero dependencies (uses Node 18+ built-in fetch).
 *
 * Backend/.env needs:   TEAM_C_URL=http://localhost:4000     TEAM_C_KEY=<the service key>
 */
const crypto = require('crypto');
const BASE = (process.env.TEAM_C_URL || '').replace(/\/$/, '');
const KEY = process.env.TEAM_C_KEY || '';

const enabled = () => Boolean(BASE && KEY);

/** Calls Team C. Returns the "data" part, or throws an Error with .status/.code/.details
 *  (same shape as Team D's own httpErr, so Team D's error handler and the UI keep working). */
async function call(method, path, { body, headers = {}, actor, correlationId } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + KEY,
        'X-Correlation-ID': correlationId || crypto.randomUUID(),
        'X-Source-Service': 'team-d',
        ...(actor ? { 'X-Actor': actor } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) {
    throw Object.assign(new Error('Team C service is not reachable.'), { status: 503, code: 'TEAM_C_UNAVAILABLE', details: [] });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const er = json.error || {};
    throw Object.assign(new Error(er.message || 'Team C error'), { status: res.status, code: er.code || 'INTERNAL_ERROR', details: er.details || [] });
  }
  return json.data;
}

module.exports = {
  enabled, call,
  /* users */
  createUser: (u, o) => call('POST', '/api/v1/users', { body: u, ...o }),
  listUsers: (role, o) => call('GET', '/api/v1/users' + (role ? '?role=' + role : ''), o),
  /* providers */
  listProviders: (o) => call('GET', '/api/v1/providers', o),
  patchProvider: (id, patch, o) => call('PATCH', `/internal/v1/providers/${id}`, { body: patch, ...o }),
  calendar: (id, qs = '', o) => call('GET', `/api/v1/providers/${id}/calendar${qs}`, o),
  /* appointments */
  book: (b, idempotencyKey, o) => call('POST', '/api/v1/appointments', { body: b, headers: { 'Idempotency-Key': idempotencyKey }, ...o }),
  getAppointment: (id, o) => call('GET', `/api/v1/appointments/${id}`, o),
  listAppointments: (qs = '', o) => call('GET', '/api/v1/appointments' + qs, o),
  cancel: (id, o) => call('POST', `/api/v1/appointments/${id}/cancel`, { body: {}, ...o }),
  transition: (id, toState, o) => call('POST', `/internal/v1/appointments/${id}/transition`, { body: { to_state: toState }, ...o }),
  /* reports / audit / events */
  utilization: (qs = '', o) => call('GET', '/api/v1/reports/utilization' + qs, o),
  audit: (qs, o) => call('GET', '/api/v1/audit?' + qs, o),
  events: (since = 0, o) => call('GET', `/api/v1/events?since=${since}`, o)
};
