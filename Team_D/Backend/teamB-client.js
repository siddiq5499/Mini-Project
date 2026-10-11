'use strict';
/**
 * Team D -> Team B (availability search). Zero dependencies.
 * Backend/.env: TEAM_B_URL=http://localhost:4002   TEAM_B_KEY=<SERVICE_KEY>
 */
const crypto = require('crypto');
const base = () => (process.env.TEAM_B_URL || '').trim().replace(/\/$/, '');
const key = () => (process.env.TEAM_B_KEY || '').trim();
const enabled = () => Boolean(base() && key());

async function call(method, path, { body, headers = {}, actor, correlationId } = {}) {
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key(),
        'X-API-Key': key(),
        'X-Correlation-ID': correlationId || crypto.randomUUID(),
        'X-Source-Service': 'team-d',
        ...(actor ? { 'X-Actor': actor } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw Object.assign(new Error('Team B availability engine is not reachable.'), { status: 503, code: 'TEAM_B_UNAVAILABLE', details: [] });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const er = json.error || {};
    throw Object.assign(new Error(er.message || 'Team B error'), { status: res.status, code: er.code || 'INTERNAL_ERROR', details: er.details || [] });
  }
  return json.data !== undefined ? json.data : json;
}

module.exports = {
  enabled, call,
  health: async () => {
    const res = await fetch(base() + '/health', { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res || !res.ok) return { ok: false };
    return { ok: true, ...(await res.json().catch(() => ({}))) };
  },
  search: (body, o) => call('POST', '/api/v1/availability/search', { body, ...o })
};
