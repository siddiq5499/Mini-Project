'use strict';
/**
 * CareSlot — Appointment Portal Backend (Admin-Controlled Token System)
 * Built with native Node.js (zero external dependencies).
 * Features:
 *  - Date-based Token Generation with configurable Daily Token Limits (Default: 30)
 *  - Admin & Doctor controlled queue progression (Call Next Token, Terminate Token)
 *  - 2-Minute Buffer Window ONLY for checking patient availability
 *  - Once marked present -> Consultancy Begins (no timer, shows "Consultancy Going On")
 *  - Emergency Priority Tokens jumping ahead of normal tokens
 *  - Real-time Server-Sent Events (SSE) broadcasting ongoing token to Patient, Doctor & Admin
 *  - Developer Reset Button (resets appointments & tokens while preserving credentials)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const teamC = require('./teamC-client');   // REST client for the Team C API
const teamA = require('./teamA-client');   // OS scheduler (queue + metrics)
const teamB = require('./teamB-client');   // availability search + conflict analytics

/* ============================== 1. CONFIG & ENV ============================== */
(function loadEnv() {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch { /* defaults are used */ }
})();

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const CFG = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  admin: {
    name: env('ADMIN_NAME', 'Scheduling Admin'),
    email: env('ADMIN_EMAIL', 'admin@gmail.com').toLowerCase(),
    password: env('ADMIN_PASSWORD', 'A@1234567')
  },
  defaultDailyTokens: 30,
  bufferDurationSec: 120 // 2 minutes buffer for availability check
};

/* ============================== 2. STORAGE & HELPERS ============================== */
const DATA_DIR = env('DATA_DIR') ? path.resolve(env('DATA_DIR')) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const nowISO = () => new Date().toISOString();
const pad = (n, w = 2) => String(n).padStart(w, '0');
const todayDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const code = (prefix, n, w = 3) => `${prefix}-${String(Number(n) || 1).padStart(w, '0')}`;
const httpErr = (status, errCode, message, details = []) => Object.assign(new Error(message), { status, code: errCode, details });

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}

function checkPw(pw, u) {
  if (!u.hash || !u.salt) return false;
  const a = Buffer.from(crypto.scryptSync(pw, u.salt, 32).toString('hex'));
  const b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Initial Default Providers Seed


let store = {
  users: [],
  providers: [],
  appointments: [],
  notifications: [],
  alerts: [],
  counters: { patient: 0, doctor: 3, appointment: 0, emergency: 0 },
  calendarVersion: 1
};

try {
  if (fs.existsSync(DATA_FILE)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  }
} catch (e) {
  console.warn('Initializing fresh store:', e.message);
}

// Safety check for counters (Prevents NaN like EM-0NaN)
store.counters = store.counters || {};
store.counters.emergency = Number(store.counters.emergency) || 0;
store.counters.appointment = Number(store.counters.appointment) || 0;
store.counters.patient = Number(store.counters.patient) || 0;
store.counters.doctor = Number(store.counters.doctor) || 3;

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(store, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (err) {
    console.error('Save failed:', err.message);
  }
}

/* ---- Team C is the system of record for doctors. This copies its doctor list into the local store
   (names, service, status, daily limit). If Team C is down, the local copy keeps working. ---- */
let providerSyncAt = 0, providerSyncBlockedUntil = 0, teamCWarned = false;
async function syncProvidersFromTeamC(force = false) {
  if (!teamC.enabled()) return false;
  if (!force && Date.now() - providerSyncAt < 3000) return true;
  if (Date.now() < providerSyncBlockedUntil) return false;
  try {
    const list = await teamC.listProviders();
    if (!Array.isArray(list) || !list.length) return false;
    const before = JSON.stringify(store.providers) + store.users.length;
    const ids = new Set();
    for (const tc of list) {
      ids.add(tc.provider_id);
      let p = store.providers.find((x) => x.provider_id === tc.provider_id);
      if (!p) {
        p = { provider_id: tc.provider_id, email: tc.email || null, current_token: null, current_appointment_id: null, buffer: null };
        store.providers.push(p);
      }
      p.name = tc.name;
      p.service = tc.service;
      p.status = tc.status === 'ACTIVE' ? 'ACTIVE' : 'ON_LEAVE';
      p.daily_token_limit = tc.daily_token_limit;
      if (!p.email && tc.email) p.email = tc.email;
      // every doctor needs a login account (default password Doctor@123, same as the seed doctors)
      const hasLogin = store.users.some((u) => u.role === 'PROVIDER' && u.provider_id === p.provider_id);
      if (!hasLogin && p.email && !store.users.some((u) => u.email === p.email)) {
        store.users.push({ user_id: uid(), name: p.name, email: p.email, phone: null, role: 'PROVIDER',
          provider_id: p.provider_id, created_at: nowISO(), ...hashPw('Doctor@123') });
      }
    }
    store.providers = store.providers.filter((p) => ids.has(p.provider_id));   // Team C is the master list
    providerSyncAt = Date.now();
    teamCWarned = false;
    if (JSON.stringify(store.providers) + store.users.length !== before) save();
    return true;
  } catch (e) {
    providerSyncBlockedUntil = Date.now() + 5000;
    if (!teamCWarned) { console.warn('[Team C] doctor sync failed, using local data:', e.message); teamCWarned = true; }
    return false;
  }
}

/* ---- One-time copy of patients that only exist in store.json into the Team C database.
   Each gets its official PT-xxxx id from Team C (their local patient_code is replaced). Safe to run on every start. ---- */
async function migratePatientsToTeamC() {
  if (!teamC.enabled()) return;
  // 1. Patients marked as already copied must still exist in the database (they vanish if the SQL file is re-run).
  try {
    const known = await teamC.call('GET', '/api/v1/users?role=PATIENT');
    const byId = new Map((known || []).map((x) => [x.user_id, x]));
    let missing = 0;
    for (const u of store.users) {
      if (u.role === 'PATIENT' && u.team_c) {
        const x = byId.get(u.patient_code);
        if (!x || x.phone !== u.phone) { u.team_c = false; missing++; }
      }
    }
    if (missing) {
      save();
      console.log(`[Team C] ${missing} patient(s) are missing from the database - they will be copied again.`);
    }
  } catch (e) {
    console.warn('[Team C] could not verify existing patients:', e.message);
    if (e.code === 'TEAM_C_UNAVAILABLE') return;
  }
  // 2. Copy every patient that is not in the database yet.
  const todo = store.users.filter((x) => x.role === 'PATIENT' && !x.team_c);
  if (!todo.length) return;
  let moved = 0, skipped = 0;
  for (const u of todo) {
    try {
      let tc;
      try {
        tc = await teamC.createUser({ role: 'PATIENT', name: u.name, phone: u.phone, email: u.email || undefined });
      } catch (e) {
        if (e.code !== 'DUPLICATE_USER') throw e;
        // already in the database (same phone/email): reuse that record
        const found = await teamC.call('GET', `/api/v1/users?role=PATIENT&q=${encodeURIComponent(u.phone || u.email || '')}`);
        tc = (found || []).find((x) => x.phone === u.phone || (u.email && x.email === u.email));
        if (!tc) throw e;
      }
      const oldCode = u.patient_code;
      u.patient_code = tc.user_id;
      u.team_c = true;
      store.appointments.forEach((a) => { if (a.user_id === u.user_id) a.patient_code = u.patient_code; });
      console.log(`[Team C] migrated patient ${u.name}: ${oldCode} -> ${u.patient_code}`);
      moved++;
    } catch (e) {
      skipped++;
      console.warn(`[Team C] could not migrate patient ${u.name} (${u.phone}): ${e.message}`);
      if (e.code === 'TEAM_C_UNAVAILABLE') break;
    }
  }
  if (moved) save();
  console.log(`[Team C] patient migration finished: ${moved} moved, ${skipped} skipped.`);
}

/* ---- Helpers for sending state changes to Team C ---- */
const tcMeta = (c) => ({
  actor: c.user ? (c.user.patient_code || c.user.provider_id || c.user.email || c.user.user_id) : undefined,
  correlationId: c.cid
});
// Moves an appointment to a new state in Team C. Appointments that were made before the integration only
// exist locally (Team C answers 404) - those are skipped. Any other Team C error (e.g. ILLEGAL_TRANSITION) is shown to the user.
async function tcTransition(appt, toState, c, extra) {
  if (!teamC.enabled() || !appt) return null;
  try { return await teamC.transition(appt.appointment_id, toState, tcMeta(c), extra); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
async function tcCancel(appt, c) {
  if (!teamC.enabled() || !appt) return;
  try { await teamC.cancel(appt.appointment_id, tcMeta(c)); }
  catch (e) { if (e.status !== 404) throw e; }
}
// Emergency walk-in patients are created locally first; make sure they also exist in Team C.
async function ensureTeamCPatient(u) {
  if (!teamC.enabled() || u.team_c) return;
  let tc;
  try {
    tc = await teamC.createUser({ role: 'PATIENT', name: u.name, phone: u.phone, email: u.email || undefined });
  } catch (e) {
    if (e.code !== 'DUPLICATE_USER') throw e;
    const found = await teamC.call('GET', `/api/v1/users?role=PATIENT&q=${encodeURIComponent(u.phone || '')}`);
    tc = (found || []).find((x) => x.phone === u.phone);
    if (!tc) throw e;
  }
  u.patient_code = tc.user_id;
  u.team_c = true;
  save();
}

/* ---- Live updates: poll Team C's outbox and push the events to the browsers (SSE) ---- */
let tcCursor = null;
async function pollTeamCEvents() {
  if (!teamC.enabled()) return;
  try {
    if (tcCursor === null) {                       // first run: skip the history, only react to new events
      let since = 0;
      for (;;) { const r = await teamC.events(since); if (!r.events.length) break; since = r.next_cursor; }
      tcCursor = since;
      return;
    }
    const r = await teamC.events(tcCursor);
    for (const ev of r.events) {
      const type = ['appointment.created', 'appointment.cancelled', 'provider.updated'].includes(ev.type) ? ev.type
        : (['appointment.state_changed', 'appointment.rescheduled'].includes(ev.type) ? 'token.updated' : null);
      if (type) broadcast(type, { ...ev.payload, source: 'team-c' });
    }
    tcCursor = r.next_cursor;
  } catch { /* try again on the next tick */ }
}
setInterval(pollTeamCEvents, 3000);

// Ensure Admin & Provider accounts
(function initAccounts() {
  let admin = store.users.find((u) => (u.email === CFG.admin.email || u.email === 'admin@careslot.local') && u.role === 'ADMIN');
  if (!admin) {
    admin = {
      user_id: uid(),
      name: CFG.admin.name,
      email: CFG.admin.email,
      phone: '9876543210',
      role: 'ADMIN',
      created_at: nowISO()
    };
    store.users.push(admin);
  }
  Object.assign(admin, hashPw(CFG.admin.password));

  // Ensure provider logins & daily_token_limit defaults
  store.providers.forEach((p) => {
    let u = store.users.find((x) => x.email === p.email && x.role === 'PROVIDER');
    if (!u) {
      u = {
        user_id: uid(),
        name: p.name,
        email: p.email,
        phone: null,
        role: 'PROVIDER',
        provider_id: p.provider_id,
        created_at: nowISO()
      };
      Object.assign(u, hashPw('Doctor@123'));
      store.users.push(u);
    }
    if (!p.daily_token_limit) p.daily_token_limit = CFG.defaultDailyTokens;
    if (p.current_token === undefined) p.current_token = null;
    if (p.buffer === undefined) p.buffer = null;
  });

  save();
})();

const sessions = new Map();
function newSession(user) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { user_id: user.user_id, expires: Date.now() + 12 * 3600 * 1000 });
  return t;
}
function userFromToken(t) {
  const s = sessions.get(t);
  if (!s || s.expires < Date.now()) {
    sessions.delete(t);
    return null;
  }
  return store.users.find((u) => u.user_id === s.user_id) || null;
}

const pub = (u) => ({
  user_id: u.user_id,
  patient_code: u.patient_code || null,
  name: u.name,
  email: u.email || null,
  phone: u.phone || null,
  role: u.role,
  provider_id: u.provider_id || null
});

/* ============================== 3. SSE LIVE UPDATES ============================== */
const streamClients = new Set();
function broadcast(type, payload = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ type, ts: nowISO(), ...payload })}\n\n`;
  streamClients.forEach((res) => {
    try { res.write(msg); } catch { streamClients.delete(res); }
  });
}
setInterval(() => broadcast('ping'), 15000);

function notify(userId, message) {
  const n = { id: uid(), user_id: userId, message, at: nowISO() };
  store.notifications.push(n);
  broadcast('notification.new', { user_id: userId, message });
}

function addAlert(level, message) {
  store.alerts.unshift({ id: uid(), level, message, at: nowISO() });
  store.alerts.length = Math.min(store.alerts.length, 25);
  broadcast('alert.new', { level, message });
}

/* ============================== 4. TOKEN & BUFFER MANAGEMENT ============================== */

// States in which a token is waiting in the queue / being served
const WAITING_STATES = ['CONFIRMED', 'RESCHEDULED'];
const SERVING_STATES = ['CALLED', 'IN_CONSULTATION'];

const isEmergencyAppt = (a) => a.type === 'EMERGENCY' || a.is_emergency;

/* THE queue order (one rule, used everywhere so the screen and "Call Next" can never disagree):
 *   1. Emergency tokens first (oldest emergency first)
 *   2. then by DATE (earlier date first)
 *   3. then by TOKEN NUMBER (T-001 before T-002)
 *   4. if two tokens somehow share a number, the one booked earlier goes first */
function compareQueue(a, b) {
  const aEm = isEmergencyAppt(a), bEm = isEmergencyAppt(b);
  if (aEm !== bEm) return aEm ? -1 : 1;
  if (aEm && bEm) return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  return String(a.date || '').localeCompare(String(b.date || ''))
    || (Number(a.token_number) || 0) - (Number(b.token_number) || 0)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

/* Tokens that may be called right now for a doctor: waiting tokens dated TODAY (or an earlier day
 * that was never served), plus emergencies. Tokens booked for a FUTURE date are not callable today. */
function getPendingQueue(providerId) {
  const today = todayDateStr();
  return store.appointments
    .filter((a) => a.provider_id === providerId && WAITING_STATES.includes(a.state) && (isEmergencyAppt(a) || !a.date || a.date <= today))
    .sort(compareQueue);
}

/* Self-healing: if a token is marked CALLED / IN_CONSULTATION but the doctor is not actually serving it
 * (this is what the old double-click bug left behind), put it back into the waiting queue. */
function repairOrphans(provider) {
  let fixed = 0;
  store.appointments.forEach((a) => {
    if (a.provider_id === provider.provider_id && SERVING_STATES.includes(a.state) && a.appointment_id !== provider.current_appointment_id) {
      a.state = 'CONFIRMED';
      a.history = a.history || [];
      a.history.push({ action: 'RESTORED_TO_QUEUE', reason: 'ORPHANED_CALL_RECOVERED', at: nowISO() });
      fixed++;
    }
  });
  return fixed;
}

// On every server start: recover any token left stuck as CALLED / IN_CONSULTATION by an earlier double call
(function healOnStart() {
  let fixed = 0;
  store.providers.forEach((p) => { fixed += repairOrphans(p); });
  if (fixed) { save(); console.log(`Recovered ${fixed} stuck token(s) back into the waiting queue.`); }
})();

// Find active appointments for doctor (includes today's and all pending queue tokens)
function getDoctorActiveQueue(providerId, dateStr = null) {
  return store.appointments.filter((a) => {
    if (a.provider_id !== providerId) return false;
    if (a.state === 'CANCELLED') return false;
    if (dateStr && a.date === dateStr) return true;
    // Any active/waiting token for this doctor
    return ['CONFIRMED', 'RESCHEDULED', 'CALLED', 'IN_CONSULTATION'].includes(a.state);
  });
}

function getDoctorTokenStatus(provider) {
  const today = todayDateStr();
  const allDocAppts = getDoctorActiveQueue(provider.provider_id);
  const todayAppts = store.appointments.filter((a) => a.provider_id === provider.provider_id && a.date === today && a.state !== 'CANCELLED');
  const todayCompleted = todayAppts.filter((a) => a.state === 'COMPLETED').length;
  const todayWaitlisted = store.appointments.filter((a) => a.provider_id === provider.provider_id && a.state === 'WAITLISTED').length;
  const emergencyCount = allDocAppts.filter((a) => isEmergencyAppt(a) && WAITING_STATES.includes(a.state)).length;

  let bufferInfo = null;
  if (provider.buffer) {
    if (provider.buffer.status === 'IN_CONSULTATION') {
      bufferInfo = {
        ...provider.buffer,
        status: 'IN_CONSULTATION',
        seconds_left: null,
        is_expired: false
      };
    } else {
      const timeLeft = Math.max(0, Math.ceil((provider.buffer.ends_at - Date.now()) / 1000));
      bufferInfo = {
        ...provider.buffer,
        seconds_left: timeLeft,
        is_expired: timeLeft <= 0 && provider.buffer.status === 'WAITING_PATIENT'
      };
    }
  }

  // Queue of pending tokens waiting to be called (same rule as "Call Next")
  const pendingQueue = getPendingQueue(provider.provider_id);

  const nextAppt = pendingQueue[0] || null;
  const currentAppt = store.appointments.find((a) => a.appointment_id === provider.current_appointment_id) || null;

  return {
    provider_id: provider.provider_id,
    name: provider.name,
    service: provider.service,
    status: provider.status,
    daily_token_limit: provider.daily_token_limit || CFG.defaultDailyTokens,
    current_token: provider.current_token,
    current_appointment: currentAppt ? {
      appointment_id: currentAppt.appointment_id,
      patient_name: currentAppt.patient_name,
      patient_code: currentAppt.patient_code,
      token_number: currentAppt.token_number,
      type: currentAppt.type,
      state: currentAppt.state,
      reason: currentAppt.reason
    } : null,
    booked_today: todayAppts.length,
    completed_today: todayCompleted,
    waitlisted_today: todayWaitlisted,
    emergency_pending: emergencyCount,
    remaining_today: Math.max(0, (provider.daily_token_limit || CFG.defaultDailyTokens) - todayAppts.length),
    next_token_in_line: nextAppt ? {
      token_number: nextAppt.token_number,
      patient_name: nextAppt.patient_name,
      patient_code: nextAppt.patient_code,
      type: nextAppt.type
    } : null,
    pending_queue: pendingQueue.map((a) => ({
      appointment_id: a.appointment_id,
      token_number: a.token_number,
      patient_name: a.patient_name,
      patient_code: a.patient_code,
      type: a.type,
      state: a.state
    })),
    buffer: bufferInfo
  };
}

// Background checker for expired 2-minute availability check (Req 3)
setInterval(() => {
  let dirty = false;
  const now = Date.now();

  store.providers.forEach((prov) => {
    if (prov.buffer && prov.buffer.status === 'WAITING_PATIENT' && prov.buffer.ends_at && now >= prov.buffer.ends_at) {
      prov.buffer.status = 'BUFFER_EXPIRED';
      dirty = true;
      const appt = store.appointments.find((a) => a.appointment_id === prov.buffer.appointment_id);
      if (appt) {
        appt.buffer_expired = true;
        notify(appt.user_id, `⚠️ 2-minute availability check expired for Token #${appt.token_number}. Please consult Admin.`);
      }
      addAlert('warn', `Buffer expired: Token #${prov.buffer.token_number} (${prov.buffer.patient_name}) did not report within 2 minutes. Admin action required.`);
      broadcast('buffer.expired', { provider_id: prov.provider_id, token_number: prov.buffer.token_number });
    }
  });

  if (dirty) save();
}, 2000);

/* ============================== 5. ROUTE REGISTRATION ============================== */
const routes = [];
const route = (method, pattern, roles, handler) => {
  routes.push({
    method,
    roles,
    handler,
    re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'),
    keys: (pattern.match(/:\w+/g) || []).map((k) => k.slice(1))
  });
};

/* ---- Auth & Profile ---- */
route('POST', '/session', null, async (c) => {
  const id = String(c.body.identifier || '').trim().toLowerCase();
  const pw = String(c.body.password || '');
  if (!id || !pw) throw httpErr(400, 'VALIDATION_ERROR', 'Enter email/phone and password.');

  const u = store.users.find((x) =>
    (x.email && x.email.toLowerCase() === id) ||
    (x.phone && x.phone === id)
  );
  if (!u || !checkPw(pw, u)) {
    throw httpErr(401, 'BAD_CREDENTIALS', 'Wrong email/phone or password.');
  }

  return { token: newSession(u), user: pub(u) };
});

route('DELETE', '/session', [], async (c) => {
  for (const [t, s] of sessions) {
    if (s.user_id === c.user.user_id && t === c.token) sessions.delete(t);
  }
  return { logged_out: true };
});

route('POST', '/register', null, async (c) => {
  const name = String(c.body.name || '').trim();
  const phone = String(c.body.phone || '').trim();
  const email = String(c.body.email || '').trim().toLowerCase();
  const pw = String(c.body.password || '');

  if (!name || name.length < 2) throw httpErr(400, 'VALIDATION_ERROR', 'Enter full name.');
  if (!/^\d{10}$/.test(phone)) throw httpErr(400, 'VALIDATION_ERROR', 'Enter valid 10-digit mobile number.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpErr(400, 'VALIDATION_ERROR', 'Enter valid email.');
  if (pw.length < 6) throw httpErr(400, 'VALIDATION_ERROR', 'Password must be at least 6 characters.');

  if (store.users.some((u) => u.phone === phone)) throw httpErr(409, 'PHONE_EXISTS', 'Mobile number already registered.');
  if (email && store.users.some((u) => u.email === email)) throw httpErr(409, 'EMAIL_EXISTS', 'Email already registered.');

  let patient_code;
  if (teamC.enabled()) {
    // Team C creates the patient and gives the official id (PT-0005 ...). Errors (duplicate phone/email, Team C down) go to the UI.
    const tc = await teamC.createUser({ role: 'PATIENT', name, phone, email: email || undefined }, { correlationId: c.cid });
    patient_code = tc.user_id;
    console.log(`[Team C] patient registered in database: ${patient_code} (${name})`);
  } else {
    patient_code = code('PT', ++store.counters.patient, 4);
  }
  const u = {
    user_id: uid(),
    patient_code,
    team_c: teamC.enabled(),
    name,
    phone,
    email: email || null,
    role: 'PATIENT',
    created_at: nowISO(),
    ...hashPw(pw)
  };

  store.users.push(u);
  save();
  c.status = 201;
  return { token: newSession(u), user: pub(u) };
});

route('GET', '/me', [], async (c) => pub(c.user));

route('PATCH', '/me', ['PATIENT'], async (c) => {
  const name = String(c.body.name || '').trim();
  const phone = String(c.body.phone || '').trim();
  if (name) c.user.name = name;
  if (phone) c.user.phone = phone;
  save();
  return pub(c.user);
});

route('GET', '/patients', ['ADMIN'], async (c) => {
  const q = String(c.query.q || '').trim().toLowerCase();
  return store.users
    .filter((u) => u.role === 'PATIENT')
    .filter((u) => !q || [u.name, u.patient_code, u.phone, u.email].some((v) => String(v || '').toLowerCase().includes(q)))
    .map((u) => ({
      ...pub(u),
      appointments: store.appointments.filter((a) => a.user_id === u.user_id).length,
      created_at: u.created_at
    }))
    .sort((a, b) => (a.patient_code || '').localeCompare(b.patient_code || ''));
});

/* ---- Doctors & Daily Token Quota (Req 5) ---- */
route('GET', '/providers', [], async () => {
  await syncProvidersFromTeamC(true);
  return store.providers.map((p) => ({
    provider_id: p.provider_id,
    name: p.name,
    service: p.service,
    status: p.status,
    daily_token_limit: p.daily_token_limit || CFG.defaultDailyTokens,
    current_token: p.current_token
  }));
});

route('POST', '/providers', ['ADMIN'], async (c) => {
  const name = String(c.body.name || '').trim();
  const service = String(c.body.service || '').trim();
  const email = String(c.body.email || '').trim().toLowerCase();
  const pw = String(c.body.password || '');
  const limit = Math.max(5, Math.min(200, Number(c.body.daily_token_limit) || CFG.defaultDailyTokens));

  if (!name || !service || !email || !pw) throw httpErr(400, 'VALIDATION_ERROR', 'Fill all required fields.');
  if (store.users.some((u) => u.email === email)) throw httpErr(409, 'EMAIL_EXISTS', 'Email already in use.');

  let provider_id;
  if (teamC.enabled()) {
    const tc = await teamC.createUser({ role: 'PROVIDER', name, email, service, daily_token_limit: limit },
      { actor: c.user.user_id, correlationId: c.cid });
    provider_id = tc.provider_id;
  } else {
    provider_id = code('DR', ++store.counters.doctor, 3);
  }
  const provider = {
    provider_id,
    name,
    service,
    email,
    status: 'ACTIVE',
    daily_token_limit: limit,
    current_token: null,
    current_appointment_id: null,
    buffer: null
  };

  if (!store.providers.find((x) => x.provider_id === provider_id)) store.providers.push(provider);
  store.users = store.users.filter((u) => !(u.role === 'PROVIDER' && u.provider_id === provider_id));
  store.users.push({
    user_id: uid(),
    name,
    email,
    phone: null,
    role: 'PROVIDER',
    provider_id,
    created_at: nowISO(),
    ...hashPw(pw)
  });

  save();
  broadcast('provider.updated', { provider_id });
  c.status = 201;
  return provider;
});

route('PATCH', '/providers/:id', ['ADMIN'], async (c) => {
  const p = store.providers.find((x) => x.provider_id === c.params.id);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  if (teamC.enabled()) {
    const patch = {};
    if (c.body.status && ['ACTIVE', 'ON_LEAVE'].includes(c.body.status)) patch.status = c.body.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    if (c.body.daily_token_limit) patch.daily_token_limit = Math.max(5, Math.min(200, Number(c.body.daily_token_limit)));
    if (Object.keys(patch).length) await teamC.patchProvider(p.provider_id, patch, { actor: c.user.user_id, correlationId: c.cid });
  }
  if (c.body.status && ['ACTIVE', 'ON_LEAVE'].includes(c.body.status)) {
    p.status = c.body.status;
  }
  if (c.body.daily_token_limit) {
    p.daily_token_limit = Math.max(5, Math.min(200, Number(c.body.daily_token_limit)));
  }
  save();
  broadcast('provider.updated', { provider_id: p.provider_id });
  return p;
});

// Doctor or Admin setting Doctor's Daily Token Limit (Req 5)
route('POST', '/providers/:id/token-limit', ['ADMIN', 'PROVIDER'], async (c) => {
  const p = store.providers.find((x) => x.provider_id === c.params.id);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  if (c.user.role === 'PROVIDER' && c.user.provider_id !== p.provider_id) {
    throw httpErr(403, 'FORBIDDEN', 'Cannot alter another doctor daily token limit.');
  }

  const limit = Number(c.body.daily_token_limit);
  if (!limit || limit < 5 || limit > 300) {
    throw httpErr(400, 'VALIDATION_ERROR', 'Daily token limit must be between 5 and 300.');
  }

  if (teamC.enabled()) await teamC.patchProvider(p.provider_id, { daily_token_limit: limit }, { actor: c.user.user_id, correlationId: c.cid });
  p.daily_token_limit = limit;
  save();
  broadcast('provider.updated', { provider_id: p.provider_id, daily_token_limit: limit });
  addAlert('info', `${p.name} daily token capacity set to ${limit} tokens.`);
  return { provider_id: p.provider_id, name: p.name, daily_token_limit: limit };
});

/* ---- Date-based Token Availability for Calendar ---- */
route('GET', '/tokens/date-info', [], async (c) => {
  const providerId = c.query.provider_id;
  const dateStr = c.query.date || todayDateStr();
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(400, 'VALIDATION_ERROR', 'Valid doctor required.');

  const limit = p.daily_token_limit || CFG.defaultDailyTokens;
  let booked = null;
  if (teamC.enabled()) {
    try { booked = (await teamC.calendar(providerId, `?from=${dateStr}&days=1`)).dates[0].booked_tokens; }
    catch { /* Team C unreachable: use the local copy */ }
  }
  if (booked === null) booked = store.appointments.filter((a) => a.provider_id === providerId && a.date === dateStr && a.state !== 'CANCELLED').length;
  const remaining = Math.max(0, limit - booked);

  return {
    provider_id: p.provider_id,
    date: dateStr,
    daily_token_limit: limit,
    booked_count: booked,
    remaining_count: remaining,
    next_token_number: booked + 1,
    is_full: remaining <= 0,
    status: p.status
  };
});

route('GET', '/calendars', [], async (c) => {
  const providerId = c.query.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(400, 'VALIDATION_ERROR', 'Valid doctor required.');

  const days = Math.min(60, Number(c.query.days) || 30);
  if (teamC.enabled()) {
    try {
      const qs = `?from=${todayDateStr()}&days=${days}` + (c.user && c.user.role === 'PATIENT' && c.user.patient_code ? `&user_id=${encodeURIComponent(c.user.patient_code)}` : '');
      const cal = await teamC.calendar(providerId, qs);
      return {
        provider: { provider_id: p.provider_id, name: p.name, service: p.service, status: p.status, daily_token_limit: cal.provider.daily_token_limit },
        calendar_version: parseInt(String(cal.calendar_version).replace(/\D/g, ''), 10) || store.calendarVersion,
        dates: cal.dates
      };
    } catch { /* Team C unreachable: use the local copy below */ }
  }
  const now = new Date();
  const limit = p.daily_token_limit || CFG.defaultDailyTokens;

  const datesData = [];
  for (let i = 0; i < days; i++) {
    const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dStr = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
    const dayAppts = store.appointments.filter((a) => a.provider_id === p.provider_id && a.date === dStr && a.state !== 'CANCELLED');
    const booked = dayAppts.length;
    const remaining = Math.max(0, limit - booked);
    const userAppt = c.user ? dayAppts.find((a) => a.user_id === c.user.user_id) : null;

    datesData.push({
      date: dStr,
      daily_token_limit: limit,
      booked_tokens: booked,
      remaining_tokens: remaining,
      status: p.status !== 'ACTIVE' ? 'UNAVAILABLE' : (userAppt ? 'MINE' : (remaining <= 0 ? 'FULL' : 'AVAILABLE')),
      user_token: userAppt ? userAppt.token_number : null
    });
  }

  return {
    provider: {
      provider_id: p.provider_id,
      name: p.name,
      service: p.service,
      status: p.status,
      daily_token_limit: limit
    },
    calendar_version: store.calendarVersion,
    dates: datesData
  };
});

/* ---- Token Booking (Req 1.a) ---- */
route('POST', '/appointments', ['PATIENT'], async (c) => {
  const providerId = String(c.body.provider_id || '').trim();
  const dateStr = String(c.body.date || '').trim();
  const reason = String(c.body.reason || '').trim().slice(0, 200);
  const idemKey = String(c.req.headers['idempotency-key'] || '').trim().slice(0, 100);
  // the browser retried the same click: return the booking that already exists
  const replay = idemKey && store.appointments.find((a) => a.idem_key === idemKey && a.user_id === c.user.user_id);
  if (replay) { c.status = 201; return replay; }

  if (!providerId || !dateStr) throw httpErr(400, 'VALIDATION_ERROR', 'Doctor and date required.');
  if (reason.length < 3) throw httpErr(400, 'VALIDATION_ERROR', 'Please provide a short reason for visit.');

  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  if (p.status !== 'ACTIVE') throw httpErr(409, 'PROVIDER_UNAVAILABLE', 'Doctor is currently on leave.');

  const existingToday = store.appointments.find((a) =>
    a.user_id === c.user.user_id &&
    a.provider_id === providerId &&
    a.date === dateStr &&
    ['CONFIRMED', 'RESCHEDULED', 'IN_CONSULTATION', 'CALLED'].includes(a.state)
  );
  if (existingToday) {
    throw httpErr(409, 'ALREADY_BOOKED', `You already hold Token #${existingToday.token_number} for this doctor on ${dateStr}.`);
  }

  const existingAppts = store.appointments.filter((a) => a.provider_id === providerId && a.date === dateStr && a.state !== 'CANCELLED');
  const limit = p.daily_token_limit || CFG.defaultDailyTokens;

  if (existingAppts.length >= limit) {
    throw httpErr(409, 'TOKENS_FULL', `All ${limit} tokens for ${p.name} on ${dateStr} are booked. Please choose another date.`);
  }

  // Calculate highest token number on that date so far
  const highestToken = existingAppts.reduce((max, a) => Math.max(max, Number(a.token_number) || 0), 0);
  let nextTokenNum = highestToken + 1;

  let tcRes = null;
  if (teamC.enabled()) {
    // Team C is the authority: double-booking check, token + time slot, audit row - all in one database transaction
    tcRes = await teamC.book({
      appointment_id: uid(), user_id: c.user.patient_code, provider_id: p.provider_id, service_type: p.service,
      date: dateStr, priority: 'NORMAL', purpose: reason
    }, idemKey || uid(), tcMeta(c));
    if (tcRes.state === 'WAITLISTED') {          // Team C says the day is full: undo and show the usual message
      await teamC.cancel(tcRes.appointment_id, tcMeta(c)).catch(() => {});
      throw httpErr(409, 'TOKENS_FULL', `All ${limit} tokens for ${p.name} on ${dateStr} are booked. Please choose another date.`);
    }
    nextTokenNum = tcRes.token_number;
  }

  store.counters.appointment = (Number(store.counters.appointment) || 0) + 1;
  const appt = {
    appointment_id: tcRes ? tcRes.appointment_id : uid(),
    idem_key: idemKey || null,
    reference: code('AP', store.counters.appointment, 4),
    user_id: c.user.user_id,
    patient_code: c.user.patient_code,
    patient_name: c.user.name,
    patient_phone: c.user.phone,
    provider_id: p.provider_id,
    provider_name: p.name,
    service: p.service,
    date: dateStr,
    start: tcRes ? tcRes.start : `${dateStr}T09:00:00.000Z`,
    token_number: nextTokenNum,
    type: 'REGULAR',
    state: 'CONFIRMED',
    reason,
    created_at: nowISO(),
    history: []
  };

  store.appointments.push(appt);
  store.calendarVersion++;
  save();

  notify(c.user.user_id, `✅ Booked Token #${nextTokenNum} for ${p.name} on ${dateStr}. Ref: ${appt.reference}`);
  addAlert('info', `New Token #${nextTokenNum} issued for ${p.name} (${dateStr}).`);
  broadcast('appointment.created', { provider_id: p.provider_id, date: dateStr, token_number: nextTokenNum });

  c.status = 201;
  return appt;
});

route('GET', '/appointments', [], async (c) => {
  const canSee = (a) =>
    c.user.role === 'ADMIN' ||
    (c.user.role === 'PROVIDER' && a.provider_id === c.user.provider_id) ||
    (c.user.role === 'PATIENT' && a.user_id === c.user.user_id);

  return store.appointments
    .filter(canSee)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || Number(a.token_number) - Number(b.token_number));
});

route('POST', '/appointments/:id/cancel', ['PATIENT', 'ADMIN'], async (c) => {
  const a = store.appointments.find((x) => x.appointment_id === c.params.id);
  if (!a) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  if (c.user.role === 'PATIENT' && a.user_id !== c.user.user_id) throw httpErr(403, 'FORBIDDEN', 'Access denied.');
  if (['COMPLETED', 'CANCELLED'].includes(a.state)) throw httpErr(409, 'ILLEGAL_STATE', 'Appointment cannot be cancelled.');

  await tcCancel(a, c);
  a.state = 'CANCELLED';
  save();
  notify(a.user_id, `Appointment ${a.reference} (Token #${a.token_number}) has been cancelled.`);
  broadcast('appointment.cancelled', { provider_id: a.provider_id, appointment_id: a.appointment_id });
  return a;
});

/* ---- Emergency Booking (Req 4: First Priority, Req 7: Fix EM-0NaN -> EM-001) ---- */
route('POST', '/emergency', ['PATIENT', 'ADMIN'], async (c) => {
  const providerId = String(c.body.provider_id || '').trim();
  const reason = String(c.body.reason || '').trim();
  if (!providerId || reason.length < 3) throw httpErr(400, 'VALIDATION_ERROR', 'Doctor and emergency description required.');

  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');

  let patient = c.user;
  if (c.user.role === 'ADMIN') {
    const pName = String(c.body.patient_name || '').trim();
    const pPhone = String(c.body.patient_phone || '').trim();
    if (!pName || !pPhone) throw httpErr(400, 'VALIDATION_ERROR', 'Patient name and mobile required for emergency walk-in.');
    patient = store.users.find((u) => u.phone === pPhone) || {
      user_id: uid(),
      name: pName,
      phone: pPhone,
      patient_code: code('EM-PT', ++store.counters.patient, 4),
      role: 'PATIENT',
      created_at: nowISO()
    };
    if (!store.users.includes(patient)) store.users.push(patient);
  }
  await ensureTeamCPatient(patient);

  const today = todayDateStr();
  let tcRes = null;
  if (teamC.enabled()) {
    // EMERGENCY: Team C puts the patient first in the day's queue and moves the affected appointments later (RESCHEDULED)
    tcRes = await teamC.book({
      appointment_id: uid(), user_id: patient.patient_code, provider_id: p.provider_id, service_type: p.service,
      date: today, priority: 'EMERGENCY', purpose: `[EMERGENCY] ${reason}`
    }, uid(), tcMeta(c));
    for (const m of tcRes.rescheduled || []) {
      const la = store.appointments.find((x) => x.appointment_id === m.appointment_id);
      if (!la) continue;
      la.state = 'RESCHEDULED';
      la.start = m.start;
      (la.history = la.history || []).push({ action: 'PUSHED_BACK_BY_EMERGENCY', at: nowISO() });
      notify(la.user_id, `⚠️ Your Token #${la.token_number} with ${p.name} was moved later because of an emergency case.`);
    }
  }
  // Safe integer increment (Fixes EM-0NaN issue completely)
  const emCount = (Number(store.counters.emergency) || 0) + 1;
  store.counters.emergency = emCount;

  const emAppt = {
    appointment_id: tcRes ? tcRes.appointment_id : uid(),
    reference: code('EM', emCount, 3), // Produces EM-001, EM-002, EM-003...
    user_id: patient.user_id,
    patient_code: patient.patient_code,
    patient_name: patient.name,
    patient_phone: patient.phone,
    provider_id: p.provider_id,
    provider_name: p.name,
    service: p.service,
    date: today,
    start: `${today}T${new Date().toTimeString().slice(0, 8)}.000Z`,
    token_number: 0,
    is_emergency: true,
    type: 'EMERGENCY',
    state: 'CONFIRMED',
    reason: `[EMERGENCY] ${reason}`,
    created_at: nowISO(),
    history: []
  };

  store.appointments.unshift(emAppt);
  save();

  notify(patient.user_id, `🚨 Emergency registered with ${p.name}. Ref: ${emAppt.reference}. Assigned FIRST PRIORITY.`);
  addAlert('emergency', `🚨 EMERGENCY TOKEN for ${p.name}: ${patient.name}. First priority in queue.`);
  broadcast('emergency.triggered', {
    provider_id: p.provider_id,
    provider_name: p.name,
    appointment_id: emAppt.appointment_id,
    patient_name: patient.name
  });

  c.status = 201;
  return { appointment: emAppt, provider: p };
});

/* ---- Queue Control & 2-Min Availability Buffer (Req 1, 2, 3) ---- */

route('GET', '/tokens/live', [], async () => {
  return store.providers.map(getDoctorTokenStatus);
});

// Call Next Token with 2-Minute Buffer for Availability Check
route('POST', '/tokens/call-next', ['ADMIN', 'PROVIDER'], async (c) => {
  const providerId = c.body.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  if (c.user.role === 'PROVIDER' && c.user.provider_id !== p.provider_id) throw httpErr(403, 'FORBIDDEN', 'Access denied.');

  // GUARD: never call a second token while one is still being handled.
  // (A repeated / double click used to overwrite the first token and make it disappear from the queue.)
  const serving = p.current_appointment_id && store.appointments.find((a) => a.appointment_id === p.current_appointment_id && SERVING_STATES.includes(a.state));
  if (serving) {
    throw httpErr(409, 'TOKEN_IN_PROGRESS',
      `Token #${serving.token_number} (${serving.patient_name}) is still ${serving.state === 'CALLED' ? 'being called' : 'in consultation'}. Terminate it before calling the next token.`);
  }
  // The doctor is idle: clear any stale pointer and recover tokens left behind by an old double call
  p.current_token = null; p.current_appointment_id = null; p.buffer = null;
  if (repairOrphans(p)) save();

  // Next token = the first one in the shared queue order (emergency, then date, then token number)
  const queue = getPendingQueue(providerId);

  if (!queue.length) {
    const future = store.appointments
      .filter((a) => a.provider_id === providerId && WAITING_STATES.includes(a.state))
      .sort(compareQueue)[0];
    throw httpErr(400, 'NO_TOKENS', future
      ? `No pending tokens for today. The next booked token is for ${future.date}.`
      : 'No pending tokens for this doctor today.');
  }

  const nextAppt = queue[0];
  await tcTransition(nextAppt, 'CALLED', c);
  nextAppt.state = 'CALLED';
  p.current_token = nextAppt.token_number;
  p.current_appointment_id = nextAppt.appointment_id;

  // 2-Minute Buffer Window ONLY to check if patient is available (Req 2 & 3)
  const endsAt = Date.now() + (CFG.bufferDurationSec * 1000);
  p.buffer = {
    appointment_id: nextAppt.appointment_id,
    token_number: nextAppt.token_number,
    patient_name: nextAppt.patient_name,
    user_id: nextAppt.user_id,
    started_at: Date.now(),
    ends_at: endsAt,
    duration_sec: CFG.bufferDurationSec,
    status: 'WAITING_PATIENT'
  };

  save();

  notify(nextAppt.user_id, `📢 Token #${nextAppt.token_number} is now CALLED by ${p.name}! Please report to the room within 2 minutes.`);
  addAlert('info', `Token #${nextAppt.token_number} (${nextAppt.patient_name}) called for ${p.name}. 2-minute availability check started.`);
  broadcast('token.called', {
    provider_id: p.provider_id,
    token_number: nextAppt.token_number,
    patient_name: nextAppt.patient_name,
    buffer_ends_at: endsAt
  });

  return getDoctorTokenStatus(p);
});

// Admin / Doctor marks patient PRESENT -> Consultancy begins (no timer, shows "Consultancy Going On" - Req 2)
route('POST', '/tokens/mark-present', ['ADMIN', 'PROVIDER'], async (c) => {
  const providerId = c.body.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  if (!p.buffer) throw httpErr(400, 'NO_ACTIVE_BUFFER', 'No active patient call.');

  const appt = store.appointments.find((a) => a.appointment_id === p.current_appointment_id);
  if (appt) {
    await tcTransition(appt, 'IN_CONSULTATION', c);
    appt.state = 'IN_CONSULTATION';
  }

  // Consultancy begins: Timer is stopped/dismissed (Req 2)
  p.buffer = {
    appointment_id: p.buffer.appointment_id,
    token_number: p.buffer.token_number,
    patient_name: p.buffer.patient_name,
    user_id: p.buffer.user_id,
    status: 'IN_CONSULTATION',
    consultancy_started_at: nowISO()
  };

  save();

  notify(p.buffer.user_id, `Patient present. Consultation with ${p.name} is now underway.`);
  broadcast('token.updated', { provider_id: p.provider_id, status: 'IN_CONSULTATION' });
  return getDoctorTokenStatus(p);
});

// Admin terminates completed token after checkup is done (Req 1.c, 2)
route('POST', '/tokens/terminate', ['ADMIN', 'PROVIDER'], async (c) => {
  const providerId = c.body.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');

  const appt = store.appointments.find((a) => a.appointment_id === p.current_appointment_id);
  if (!appt && !p.current_token) {
    throw httpErr(400, 'NO_ACTIVE_TOKEN', 'No ongoing token to terminate.');
  }

  const completedTokenNum = appt ? appt.token_number : p.current_token;
  if (appt) {
    if (appt.state === 'CALLED') await tcTransition(appt, 'IN_CONSULTATION', c);   // Team C needs the consultation step first
    await tcTransition(appt, 'COMPLETED', c);
    appt.state = 'COMPLETED';
    appt.completed_at = nowISO();
    notify(appt.user_id, `✅ Consultation completed. Token #${appt.token_number} terminated.`);
  }

  // Clear ongoing token
  p.current_token = null;
  p.current_appointment_id = null;
  p.buffer = null;
  save();

  addAlert('info', `Token #${completedTokenNum} checkup completed and terminated by Admin for ${p.name}.`);
  broadcast('token.terminated', {
    provider_id: p.provider_id,
    terminated_token: completedTokenNum
  });

  return getDoctorTokenStatus(p);
});

// Admin reschedules absent patient (Req 3)
route('POST', '/tokens/reschedule-absent', ['ADMIN'], async (c) => {
  const providerId = c.body.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');

  const appt = store.appointments.find((a) => a.appointment_id === p.current_appointment_id);
  if (!appt) throw httpErr(400, 'NO_ACTIVE_TOKEN', 'No active token to reschedule.');

  const sameDay = store.appointments.filter((a) => a.provider_id === providerId && a.date === appt.date && a.state !== 'CANCELLED');
  const maxToken = sameDay.reduce((max, a) => Math.max(max, Number(a.token_number) || 0), 0);
  let newNum = maxToken + 1;
  const oldNum = appt.token_number;
  const tcR = await tcTransition(appt, 'RESCHEDULED', c, { new_token: true });   // Team C hands out the new token
  if (tcR && tcR.token_number) newNum = tcR.token_number;
  if (tcR && tcR.start) appt.start = tcR.start;

  appt.history.push({ from_token: oldNum, to_token: newNum, reason: 'ABSENT_DURING_2MIN_BUFFER', at: nowISO() });
  appt.token_number = newNum;
  appt.state = 'RESCHEDULED';

  p.current_token = null;
  p.current_appointment_id = null;
  p.buffer = null;
  save();

  notify(appt.user_id, `⚠️ Patient absent during 2-minute availability check. Rescheduled to Token #${newNum} for ${p.name}.`);
  addAlert('warn', `Token #${oldNum} patient was absent. Rescheduled to Token #${newNum}.`);
  broadcast('token.rescheduled', { provider_id: p.provider_id, new_token: newNum });

  return getDoctorTokenStatus(p);
});

// Admin puts absent patient on waitlist (Req 3)
route('POST', '/tokens/waitlist-absent', ['ADMIN'], async (c) => {
  const providerId = c.body.provider_id;
  const p = store.providers.find((x) => x.provider_id === providerId);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');

  const appt = store.appointments.find((a) => a.appointment_id === p.current_appointment_id);
  if (!appt) throw httpErr(400, 'NO_ACTIVE_TOKEN', 'No active token to waitlist.');

  await tcTransition(appt, 'WAITLISTED', c);
  appt.state = 'WAITLISTED';
  appt.history.push({ token: appt.token_number, action: 'WAITLISTED_DUE_TO_ABSENCE', at: nowISO() });

  const oldToken = p.current_token;
  p.current_token = null;
  p.current_appointment_id = null;
  p.buffer = null;
  save();

  notify(appt.user_id, `⏳ Token #${oldToken} moved to WAITLIST due to 2-minute buffer expiry. Please contact reception.`);
  addAlert('warn', `Token #${oldToken} moved to waitlist after buffer timeout.`);
  broadcast('token.waitlisted', { provider_id: p.provider_id, token_number: oldToken });

  return getDoctorTokenStatus(p);
});

// Admin restores waitlisted patient back to active queue
route('POST', '/tokens/restore-waitlist', ['ADMIN'], async (c) => {
  const appointmentId = c.body.appointment_id;
  const appt = store.appointments.find((a) => a.appointment_id === appointmentId);
  if (!appt) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  if (appt.state !== 'WAITLISTED') throw httpErr(400, 'NOT_WAITLISTED', 'Patient is not currently waitlisted.');

  const tcR = await tcTransition(appt, 'RESCHEDULED', c);
  if (tcR && tcR.start) appt.start = tcR.start;
  appt.state = 'RESCHEDULED';
  save();
  notify(appt.user_id, `Your waitlisted Token #${appt.token_number} is reinstated into the active queue.`);
  broadcast('token.updated', { provider_id: appt.provider_id });
  return appt;
});

/* ---- Developer Reset Data (Req 3: Resets appointments & queue only, keeps credentials safe) ---- */
route('POST', '/dev/reset-data', ['ADMIN'], async (c) => {
  let tcNote = '';
  if (teamC.enabled()) {
    try { await teamC.devReset(tcMeta(c)); } catch (e) { tcNote = ` (Team C data was NOT cleared: ${e.message})`; }
  }
  store.appointments = [];
  store.notifications = [];
  store.alerts = [];
  store.idem = {};
  store.reminders = [];
  store.counters.appointment = 0;
  store.counters.emergency = 0;

  store.providers.forEach((p) => {
    p.current_token = null;
    p.current_appointment_id = null;
    p.buffer = null;
  });

  store.calendarVersion++;
  save();

  addAlert('info', 'All queue and appointment data has been reset to fresh state.');
  broadcast('data.reset');
  return { reset: true, message: 'All appointments and tokens have been cleared successfully.' + tcNote };
});

/* ---- Dashboard & Analytics ---- */
route('GET', '/dashboard', ['PROVIDER', 'ADMIN', 'PATIENT'], async (c) => {
  const today = todayDateStr();
  const tokenStatuses = store.providers.map(getDoctorTokenStatus);

  const activeAppts = store.appointments.filter((a) => ['CONFIRMED', 'RESCHEDULED', 'IN_CONSULTATION', 'CALLED'].includes(a.state));
  const emergencies = store.appointments.filter((a) => a.type === 'EMERGENCY' && a.state !== 'CANCELLED');
  const completed = store.appointments.filter((a) => a.state === 'COMPLETED');
  const waitlisted = store.appointments.filter((a) => a.state === 'WAITLISTED');

  // Check if an emergency is currently pending or active (Fixes Issue 2)
  const hasActiveEmergency = store.appointments.some((a) =>
    (a.type === 'EMERGENCY' || a.is_emergency) &&
    ['CONFIRMED', 'CALLED', 'IN_CONSULTATION', 'RESCHEDULED'].includes(a.state)
  );

  let patientActiveToken = null;
  if (c.user.role === 'PATIENT') {
    const myAppt = store.appointments.find((a) =>
      a.user_id === c.user.user_id &&
      ['CONFIRMED', 'RESCHEDULED', 'IN_CONSULTATION', 'CALLED'].includes(a.state)
    );
    if (myAppt) {
      const docStatus = tokenStatuses.find((t) => t.provider_id === myAppt.provider_id);
      // people ahead = tokens waiting before mine in the real queue order, plus the one being served now
      const pos = getPendingQueue(myAppt.provider_id).findIndex((a) => a.appointment_id === myAppt.appointment_id);
      const servingNow = docStatus && docStatus.current_appointment && docStatus.current_appointment.appointment_id !== myAppt.appointment_id ? 1 : 0;
      const ahead = pos >= 0 ? pos + servingNow : 0;
      patientActiveToken = {
        appointment_id: myAppt.appointment_id,
        reference: myAppt.reference,
        doctor_name: myAppt.provider_name,
        service: myAppt.service,
        my_token_number: myAppt.token_number,
        ongoing_token: docStatus ? docStatus.current_token : null,
        tokens_ahead: ahead,
        estimated_wait_minutes: ahead * 8,
        state: myAppt.state,
        is_in_consultation: docStatus && docStatus.buffer && docStatus.buffer.status === 'IN_CONSULTATION' && docStatus.buffer.appointment_id === myAppt.appointment_id,
        buffer_active: docStatus && docStatus.buffer && docStatus.buffer.status === 'WAITING_PATIENT' && docStatus.buffer.appointment_id === myAppt.appointment_id
      };
    }
  }

  return {
    generated_at: nowISO(),
    today,
    has_active_emergency: hasActiveEmergency,
    doctors: tokenStatuses,
    patient_active_token: patientActiveToken,
    totals: {
      active_tokens: activeAppts.length,
      emergencies: emergencies.length,
      completed: completed.length,
      waitlisted: waitlisted.length
    },
    alerts: store.alerts.slice(0, 8)
  };
});

/* ---- Appointment details (aggregate: Team C state + queue position) ---- */
route('GET', '/appointments/:id', [], async (c) => {
  const a = store.appointments.find((x) => x.appointment_id === c.params.id);
  if (!a) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  if (c.user.role === 'PATIENT' && a.user_id !== c.user.user_id) throw httpErr(403, 'FORBIDDEN', 'Access denied.');
  if (c.user.role === 'PROVIDER' && a.provider_id !== c.user.provider_id) throw httpErr(403, 'FORBIDDEN', 'Access denied.');

  let authoritative = { source: 'local', state: a.state, version: null };
  if (teamC.enabled()) {
    try {
      const t = await teamC.getAppointment(a.appointment_id, tcMeta(c));
      authoritative = { source: 'team-c', state: t.state, version: t.version, token_number: t.token_number, start: t.start, end: t.end };
    } catch (e) {
      if (e.status !== 404) authoritative.note = 'Team C is not reachable; showing the local copy.';
    }
  }
  const p = store.providers.find((x) => x.provider_id === a.provider_id);
  const queue = getPendingQueue(a.provider_id);
  const idx = queue.findIndex((x) => x.appointment_id === a.appointment_id);
  const payload = {
    appointment: a,
    authoritative,
    queue: {
      position: idx >= 0 ? idx + 1 : null,
      people_ahead: idx >= 0 ? idx : null,
      now_serving_token: p ? p.current_token : null,
      estimated_start: authoritative.start || a.start
    },
    availability_status: 'NOT_CHECKED',
    reminders: reminders().filter((r) => r.appointment_id === a.appointment_id)
      .map((r) => ({ reminder_id: r.reminder_id, minutes_before: r.minutes_before, due_at: r.due_at, sent: r.sent }))
  };

  if (teamA.enabled()) {
    try {
      const q = await teamA.queue(a.provider_id, tcMeta(c));
      const mine = (q || []).find((x) => x.appointment_id === a.appointment_id);
      if (mine) {
        payload.queue.position = mine.queue_position;
        payload.queue.people_ahead = Math.max(0, mine.queue_position - 1);
        payload.queue.source = 'team-a';
        payload.queue.policy = mine.policy;
      }
    } catch { /* keep local queue numbers */ }
  }
  if (teamB.enabled() && a.date) {
    try {
      const search = await teamB.search({
        provider_id: a.provider_id,
        date_range: { start: a.date, end: a.date },
        duration_minutes: 10,
        algorithm: 'earliest-fit'
      }, tcMeta(c));
      const overlaps = search && search.conflicts && search.conflicts.overlap_detected;
      payload.availability_status = overlaps ? 'DEGRADED' : 'OK';
      payload.availability = {
        source: 'team-b',
        algorithm: search.algorithm,
        calendar_version: search.calendar_version,
        free_slot_count: (search.ranked_free_slots || []).length,
        conflicts: search.conflicts || null
      };
    } catch {
      payload.availability_status = 'UNAVAILABLE';
    }
  }
  return payload;
});

/* ---- Team B availability search (proxied) ---- */
route('GET', '/availability', [], async (c) => {
  if (!teamB.enabled()) throw httpErr(503, 'TEAM_B_UNAVAILABLE', 'Team B availability engine is not configured.');
  const providerId = String(c.query.provider_id || '').trim();
  const dateStr = String(c.query.date || todayDateStr()).trim();
  const duration = Math.max(1, Math.min(480, Number(c.query.duration_minutes || c.query.duration) || 10));
  if (!providerId) throw httpErr(400, 'VALIDATION_ERROR', 'provider_id is required.');
  return teamB.search({
    provider_id: providerId,
    date_range: { start: dateStr, end: dateStr },
    duration_minutes: duration,
    algorithm: String(c.query.algorithm || 'earliest-fit')
  }, tcMeta(c));
});

/* ---- Team A scheduling metrics / queue ---- */
route('GET', '/scheduling/metrics', ['ADMIN', 'PROVIDER'], async (c) => {
  if (!teamA.enabled()) throw httpErr(503, 'TEAM_A_UNAVAILABLE', 'Team A scheduler is not configured.');
  return teamA.metrics(tcMeta(c));
});
route('GET', '/providers/:id/queue', [], async (c) => {
  if (!teamA.enabled()) throw httpErr(503, 'TEAM_A_UNAVAILABLE', 'Team A scheduler is not configured.');
  return teamA.queue(c.params.id, tcMeta(c));
});

/* ---- Reminders ---- */
const REMINDER_CHOICES = [15, 30, 60, 120, 1440];
const reminders = () => (Array.isArray(store.reminders) ? store.reminders : (store.reminders = []));
route('POST', '/appointments/:id/reminders', ['PATIENT', 'ADMIN'], async (c) => {
  const a = store.appointments.find((x) => x.appointment_id === c.params.id);
  if (!a) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  if (c.user.role === 'PATIENT' && a.user_id !== c.user.user_id) throw httpErr(403, 'FORBIDDEN', 'Access denied.');
  if (!['CONFIRMED', 'RESCHEDULED', 'WAITLISTED'].includes(a.state)) throw httpErr(400, 'VALIDATION_ERROR', 'Reminders can only be set for upcoming appointments.');
  const minutes = Number(c.body.minutes_before);
  if (!REMINDER_CHOICES.includes(minutes)) throw httpErr(400, 'VALIDATION_ERROR', `minutes_before must be one of ${REMINDER_CHOICES.join(', ')}.`);
  const startMs = Date.parse(a.start);
  const dueMs = (Number.isNaN(startMs) ? Date.parse(a.date + 'T00:00:00Z') : startMs) - minutes * 60000;
  if (dueMs <= Date.now()) throw httpErr(400, 'VALIDATION_ERROR', 'That reminder time has already passed. Choose a shorter reminder.');
  const same = reminders().find((r) => r.appointment_id === a.appointment_id && r.minutes_before === minutes && !r.sent);
  if (same) return same;
  const r = { reminder_id: uid(), appointment_id: a.appointment_id, user_id: a.user_id, minutes_before: minutes, channel: 'IN_APP', due_at: new Date(dueMs).toISOString(), sent: false, created_at: nowISO() };
  reminders().push(r);
  save();
  c.status = 201;
  return r;
});
function fireReminders() {
  const now = Date.now();
  let changed = false;
  for (const r of reminders()) {
    if (r.sent || Date.parse(r.due_at) > now) continue;
    r.sent = true; r.sent_at = nowISO(); changed = true;
    const a = store.appointments.find((x) => x.appointment_id === r.appointment_id);
    if (a && !['CANCELLED', 'COMPLETED'].includes(a.state)) {
      notify(r.user_id, `⏰ Reminder: Token #${a.token_number} with ${a.provider_name} on ${a.date}.`);
    }
  }
  if (changed) save();
}
setInterval(fireReminders, 30000);

/* ---- Reports (Admin: all doctors, Provider: own) ---- */
const shiftDate = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function localUtilization(from, to, providerId) {
  const map = new Map();
  for (const a of store.appointments) {
    if (a.date < from || a.date > to) continue;
    if (providerId && a.provider_id !== providerId) continue;
    const k = a.provider_id + '|' + a.date;
    let r = map.get(k);
    if (!r) {
      const p = store.providers.find((x) => x.provider_id === a.provider_id) || {};
      r = { provider_id: a.provider_id, provider_name: a.provider_name || p.name, date: a.date, daily_token_limit: p.daily_token_limit || CFG.defaultDailyTokens, booked: 0, completed: 0, cancelled: 0, no_show: 0, waitlisted: 0 };
      map.set(k, r);
    }
    if (a.state === 'CANCELLED') r.cancelled++;
    else if (a.state === 'WAITLISTED') r.waitlisted++;
    else { r.booked++; if (a.state === 'COMPLETED') r.completed++; }
  }
  return [...map.values()].map((r) => ({ ...r, utilization_pct: Math.round((r.booked * 1000) / r.daily_token_limit) / 10 }))
    .sort((x, y) => x.date.localeCompare(y.date) || x.provider_id.localeCompare(y.provider_id));
}
route('GET', '/reports/utilization', ['ADMIN', 'PROVIDER'], async (c) => {
  const today = todayDateStr();
  const from = c.query.from || shiftDate(today, -7), to = c.query.to || shiftDate(today, 7);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) throw httpErr(400, 'VALIDATION_ERROR', 'Dates must look like 2026-10-31.');
  if (from > to) throw httpErr(400, 'VALIDATION_ERROR', '"From" must not be after "To".');
  const providerId = c.user.role === 'PROVIDER' ? c.user.provider_id : String(c.query.provider_id || '').trim();
  let rows, source = 'team-c';
  try {
    if (!teamC.enabled()) throw new Error('not configured');
    rows = await teamC.utilization(`?from=${from}&to=${to}` + (providerId ? `&provider_id=${encodeURIComponent(providerId)}` : ''), tcMeta(c));
  } catch (e) {
    rows = localUtilization(from, to, providerId);
    source = 'local';
  }
  const sum = (k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
  const cap = sum('daily_token_limit');
  return {
    source, from, to, rows,
    totals: { booked: sum('booked'), completed: sum('completed'), cancelled: sum('cancelled'), waitlisted: sum('waitlisted'), utilization_pct: cap ? Math.round((sum('booked') * 1000) / cap) / 10 : 0 }
  };
});

/* ---- Audit trail (Admin) - stored in Team C ---- */
route('GET', '/audit', ['ADMIN'], async (c) => {
  if (!teamC.enabled()) throw httpErr(503, 'TEAM_C_UNAVAILABLE', 'The audit trail is stored in Team C, which is not configured.');
  const qs = new URLSearchParams({ order: 'desc', limit: String(Math.min(500, Number(c.query.limit) || 100)) });
  if (c.query.entity_id) qs.set('entity_id', String(c.query.entity_id).trim());
  if (c.query.correlation_id) qs.set('correlation_id', String(c.query.correlation_id).trim());
  return teamC.audit(qs.toString(), tcMeta(c));
});

/* ---- Doctor working hours / day off (Admin) - stored in Team C ---- */
route('PUT', '/providers/:id/schedule', ['ADMIN'], async (c) => {
  if (!teamC.enabled()) throw httpErr(503, 'TEAM_C_UNAVAILABLE', 'Working hours are stored in Team C, which is not configured.');
  const p = store.providers.find((x) => x.provider_id === c.params.id);
  if (!p) throw httpErr(404, 'NOT_FOUND', 'Doctor not found.');
  const out = await teamC.setSchedule(p.provider_id, c.body, tcMeta(c));
  store.calendarVersion++;
  save();
  broadcast('provider.updated', { provider_id: p.provider_id });
  return out;
});

route('GET', '/notifications', [], async (c) => {
  return store.notifications
    .filter((n) => c.user.role === 'ADMIN' || n.user_id === c.user.user_id)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 40);
});

/* ---- SSE Stream ---- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const STREAM = Symbol('stream');

route('GET', '/stream', [], async (c) => {
  c.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    ...SEC
  });
  if (c.res.flushHeaders) c.res.flushHeaders();
  c.res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping', ts: nowISO() })}\n\n`);
  streamClients.add(c.res);
  const cleanup = () => streamClients.delete(c.res);
  c.req.on('close', cleanup);
  c.res.on('close', cleanup);
  return STREAM;
});

/* ============================== 6. HTTP SERVER & STATIC SERVE ============================== */
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (ch) => {
    d += ch;
    if (d.length > 1e6) { reject(httpErr(413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')); req.destroy(); }
  });
  req.on('end', () => {
    try { resolve(d ? JSON.parse(d) : {}); } catch { reject(httpErr(400, 'BAD_JSON', 'Malformed JSON body.')); }
  });
});

/* ---- Rate limiting (per client IP, per minute). Login/register are stricter. ---- */
const rateBuckets = new Map();
function rateLimit(req, P) {
  if (P === '/stream') return;                                  // one long-lived connection, not a flood
  const strict = req.method === 'POST' && (P === '/session' || P === '/register');
  const limit = strict ? 30 : 1200;
  const key = (req.socket.remoteAddress || 'x') + (strict ? '|auth' : '|all');
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.start > 60000) { b = { start: now, n: 0 }; rateBuckets.set(key, b); }
  if (++b.n > limit) throw httpErr(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (now - b.start > 60000) rateBuckets.delete(k); }, 60000).unref();

async function handleApi(req, res, url) {
  const cid = req.headers['x-correlation-id'] || uid();
  const send = (status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Correlation-ID': cid,
      'Cache-Control': 'no-store',
      ...SEC
    });
    res.end(JSON.stringify(payload));
  };

  try {
    if (url.pathname === '/api/v1/health') {
      return send(200, { status: 'healthy', timestamp: nowISO() });
    }

    if (!url.pathname.startsWith('/api/v1/ui/')) throw httpErr(404, 'NOT_FOUND', 'API endpoint not found.');
    const P = url.pathname.slice('/api/v1/ui'.length);
    rateLimit(req, P);

    const r = routes.find((x) => x.method === req.method && x.re.test(P));
    if (!r) throw httpErr(404, 'NOT_FOUND', 'Endpoint does not exist.');

    const m = P.match(r.re);
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      (P === '/stream' ? url.searchParams.get('token') || '' : '');

    let user = null;
    if (r.roles) {
      user = userFromToken(token);
      if (!user) throw httpErr(401, 'UNAUTHENTICATED', 'Please log in to continue.');
      if (r.roles.length && !r.roles.includes(user.role)) {
        throw httpErr(403, 'FORBIDDEN', 'Insufficient permissions.');
      }
    }

    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const ctx = {
      req, res, user, token, params,
      query: Object.fromEntries(url.searchParams),
      body, cid, status: 200
    };

    if (P !== '/stream' && P !== '/session' && P !== '/register') await syncProvidersFromTeamC();
    const data = await r.handler(ctx);
    if (data === STREAM) return;
    send(ctx.status, { data, meta: { correlation_id: cid, timestamp: nowISO() } });
  } catch (err) {
    send(err.status || 500, {
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Server error occurred.'
      },
      meta: { correlation_id: cid }
    });
  }
}

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(FRONT, rel));
  if (!file.startsWith(FRONT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, SEC);
      return res.end('File Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SEC
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(CFG.port, () => {
  console.log(`\n======================================================`);
  console.log(`CareSlot Token Management System is running!`);
  console.log(`URL: http://localhost:${CFG.port}`);
  console.log(`Admin Login: ${CFG.admin.email} / ${CFG.admin.password}`);
  console.log(`Default Doctor Daily Token Capacity: ${CFG.defaultDailyTokens}`);
  console.log(`2-Minute Patient Availability Buffer: ${CFG.bufferDurationSec}s`);
  console.log(`Consultancy: "Consultancy Going On" once present (no countdown)`);
  console.log(`Team C API: ${teamC.enabled() ? process.env.TEAM_C_URL : 'NOT configured (using local store.json)'}`);
  console.log(`======================================================\n`);
  syncProvidersFromTeamC(true).then((ok) => {
    if (teamC.enabled()) console.log(ok ? '[Team C] connected - doctors synced from the database.' : '[Team C] NOT reachable - using local doctors.');
    if (ok) migratePatientsToTeamC();
  });
});