'use strict';
/**
 * Team D -> Team A (OS scheduler). Zero dependencies.
 * Backend/.env: TEAM_A_URL=http://localhost:4001   TEAM_A_KEY=<SERVICE_KEY>
 */
const crypto = require('crypto');
const base = () => (process.env.TEAM_A_URL || '').trim().replace(/\/$/, '');
const key = () => (process.env.TEAM_A_KEY || '').trim();
const enabled = () => Boolean(base() && key());

async function call(method, path, { body, headers = {}, actor, correlationId } = {}) {
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key(),
        'X-Correlation-ID': correlationId || crypto.randomUUID(),
        'X-Source-Service': 'team-d',
        ...(actor ? { 'X-Actor': actor } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw Object.assign(new Error('Team A scheduler is not reachable.'), { status: 503, code: 'TEAM_A_UNAVAILABLE', details: [] });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const er = json.error || {};
    throw Object.assign(new Error(er.message || 'Team A error'), { status: res.status, code: er.code || 'INTERNAL_ERROR', details: er.details || [] });
  }
  return json.data;
}

module.exports = {
  enabled, call,
  health: async () => {
    const res = await fetch(base() + '/health', { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res || !res.ok) return { ok: false };
    return { ok: true, ...(await res.json().catch(() => ({}))) };
  },
  metrics: (o) => call('GET', '/api/v1/metrics/scheduling', o),
  queue: (providerId, o) => call('GET', `/api/v1/providers/${encodeURIComponent(providerId)}/queue`, o)
};
