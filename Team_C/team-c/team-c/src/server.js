'use strict';
/**
 * CareSlot - Team C service (Appointment Data & Transaction Manager)
 * REST/JSON on port 4000.  Node >= 18, one dependency: mysql2.
 *
 * Design choices (answers to Team_C_req.txt):
 *  - Daily limit reached  -> HTTP 201 with state WAITLISTED (we do NOT return CAPACITY_EXHAUSTED
 *    on booking; CAPACITY_EXHAUSTED is returned only when a WAITLISTED booking is promoted to
 *    CONFIRMED while the day is still full).
 *  - Isolation level: READ COMMITTED + SELECT ... FOR UPDATE on the Doctor row (one lock per doctor).
 *  - Double booking is blocked twice: row lock in the service AND UNIQUE keys in MySQL.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------ config ------------------------------ */
(function loadEnv() {
  try {
    fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch { /* no .env: defaults */ }
})();
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const CFG = {
  port: Number(env('PORT', '4000')),
  key: env('SERVICE_KEY'),
  slotMs: Math.max(1, Number(env('SLOT_MINUTES', '10'))) * 60000,
  dayStartHour: Number(env('DAY_START_HOUR_UTC', '9')),
  rateLimit: Number(env('RATE_LIMIT_PER_MIN', '3000')),      // requests per minute per client IP, 0 = off
  db: {
    host: env('DB_HOST', '127.0.0.1'), port: Number(env('DB_PORT', '3306')),
    user: env('DB_USER', 'root'), password: env('DB_PASSWORD', ''),
    database: env('DB_NAME', 'HospitalAppointmentDB')
  }
};
if (!CFG.key) { console.error('SERVICE_KEY is not set. Copy .env.example to .env and set it.'); process.exit(1); }

const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  ...CFG.db, waitForConnections: true, connectionLimit: 20,
  timezone: 'Z', dateStrings: true, charset: 'utf8mb4'
});

/* ------------------------------ helpers ------------------------------ */
const STATES = ['REQUESTED', 'CONFIRMED', 'WAITLISTED', 'RESCHEDULED', 'CANCELLED', 'REJECTED',
  'CALLED', 'IN_CONSULTATION', 'COMPLETED', 'NO_SHOW'];
const LIVE = ['REQUESTED', 'CONFIRMED', 'RESCHEDULED', 'CALLED', 'IN_CONSULTATION'];
const SERVING = ['CALLED', 'IN_CONSULTATION'];
const NOT_COUNTED = "('CANCELLED','REJECTED','WAITLISTED')";   // do not use a daily token
/* Allowed state changes (anything else -> 409 ILLEGAL_TRANSITION) */
const TRANSITIONS = {
  REQUESTED:       ['CONFIRMED', 'WAITLISTED', 'REJECTED', 'CANCELLED'],
  CONFIRMED:       ['CALLED', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW', 'WAITLISTED'],
  RESCHEDULED:     ['CONFIRMED', 'CALLED', 'CANCELLED', 'NO_SHOW', 'WAITLISTED'],
  WAITLISTED:      ['CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'REJECTED'],
  CALLED:          ['IN_CONSULTATION', 'NO_SHOW', 'CONFIRMED', 'RESCHEDULED', 'WAITLISTED', 'CANCELLED'],
  IN_CONSULTATION: ['COMPLETED', 'CANCELLED'],
  CANCELLED: [], REJECTED: [], COMPLETED: [], NO_SHOW: []
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const httpErr = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details });
const toDb = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const dbMs = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const iso = (s) => (s ? new Date(dbMs(s)).toISOString() : null);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const pad = (n, w) => String(n).padStart(w, '0');
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const isoOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v, max = 255) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      if ((e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < 3) continue;
      throw e;
    } finally { conn.release(); }
  }
}

async function audit(conn, c, action, entity, entityId, before, after) {
  const id = crypto.randomUUID();
  await conn.query(
    'INSERT INTO Audit_Log (audit_id, actor, action, entity, entity_id, before_json, after_json, correlation_id, source_service) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, c.actor, action, entity, entityId, json(before), json(after), c.correlation_id, c.source]);
  return id;
}
const outbox = (conn, type, payload) =>
  conn.query('INSERT INTO Outbox_Event (type, payload_json) VALUES (?,?)', [type, JSON.stringify(payload)]);

/* ------------------------------ queries ------------------------------ */
const APPT_SELECT = `
  SELECT a.appointment_id AS _id, a.public_id AS appointment_id, a.doctor_id, a.patient_id,
         p.public_id AS user_id, pu.name AS patient_name, pu.phone AS patient_phone,
         d.public_id AS provider_id, du.name AS provider_name, d.service AS service_type,
         d.daily_token_limit, a.appointment_date, a.token_number, a.priority, a.state, a.version,
         a.start_time, a.end_time, a.reason, a.idempotency_key, a.created_at, a.updated_at
  FROM Appointment a
  JOIN Patient p ON p.patient_id = a.patient_id JOIN Users pu ON pu.user_id = p.user_id
  JOIN Doctor  d ON d.doctor_id  = a.doctor_id  JOIN Users du ON du.user_id = d.user_id`;

const fmtAppt = (r) => ({
  appointment_id: r.appointment_id, user_id: r.user_id, patient_name: r.patient_name, patient_phone: r.patient_phone,
  provider_id: r.provider_id, provider_name: r.provider_name, service_type: r.service_type,
  state: r.state, version: r.version, priority: r.priority, token_number: r.token_number,
  date: r.appointment_date, start: iso(r.start_time), end: iso(r.end_time), purpose: r.reason,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at)
});

async function getApptRow(conn, where, params, lock = false) {
  const [rows] = await conn.query(`${APPT_SELECT} WHERE ${where} ${lock ? 'FOR UPDATE' : ''}`, params);
  return rows[0] || null;
}

/* The first start time >= startMs where [start, start+dur) overlaps no LIVE appointment of this doctor */
async function firstFree(conn, doctorId, startMs, durMs) {
  for (let i = 0; i < 1000; i++) {
    const [rows] = await conn.query(
      'SELECT end_time FROM Appointment WHERE doctor_id=? AND live_start < ? AND end_time > ? ORDER BY end_time DESC LIMIT 1 FOR UPDATE',
      [doctorId, toDb(startMs + durMs), toDb(startMs)]);
    if (!rows.length) return startMs;
    startMs = dbMs(rows[0].end_time);
  }
  throw httpErr(409, 'CAPACITY_EXHAUSTED', 'No free slot could be found for this doctor.');
}

/* end time of the last live appointment of that day (or the start of the working day) */
async function queueEnd(conn, doctorId, date) {
  const [r] = await conn.query('SELECT MAX(end_time) e FROM Appointment WHERE doctor_id=? AND appointment_date=? AND live_start IS NOT NULL', [doctorId, date]);
  return r[0].e ? dbMs(r[0].e) : Date.parse(date + 'T00:00:00Z') + CFG.dayStartHour * 3600000;
}

const countedToday = async (conn, doctorId, date) =>
  (await conn.query(`SELECT COUNT(*) n FROM Appointment WHERE doctor_id=? AND appointment_date=? AND state NOT IN ${NOT_COUNTED}`, [doctorId, date]))[0][0].n;
const maxToken = async (conn, doctorId, date) =>
  Number((await conn.query('SELECT COALESCE(MAX(token_number),0) m FROM Appointment WHERE doctor_id=? AND appointment_date=?', [doctorId, date]))[0][0].m);

/* ------------------------------ users ------------------------------ */
async function createUser(c, b) {
  const role = str(b.role).toUpperCase();
  if (!['PATIENT', 'PROVIDER', 'ADMIN'].includes(role)) throw httpErr(400, 'VALIDATION_ERROR', 'role must be PATIENT, PROVIDER or ADMIN.', [{ field: 'role' }]);
  const name = str(b.name, 100), email = str(b.email, 100).toLowerCase() || null, phone = str(b.phone, 15) || null;
  const details = [];
  if (name.length < 2) details.push({ field: 'name', issue: 'min 2 characters' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) details.push({ field: 'email', issue: 'invalid email' });
  if (phone && !/^\d{10}$/.test(phone)) details.push({ field: 'phone', issue: 'must be 10 digits' });
  if (role === 'PATIENT' && !phone) details.push({ field: 'phone', issue: 'required for PATIENT' });
  const service = str(b.service, 100);
  if (role === 'PROVIDER' && !service) details.push({ field: 'service', issue: 'required for PROVIDER' });
  const limit = b.daily_token_limit === undefined ? 30 : Number(b.daily_token_limit);
  if (role === 'PROVIDER' && (!Number.isInteger(limit) || limit < 1 || limit > 500)) details.push({ field: 'daily_token_limit', issue: '1..500' });
  if (details.length) throw httpErr(400, 'VALIDATION_ERROR', 'Invalid user data.', details);

  try {
    return await tx(async (conn) => {
      const [u] = await conn.query('INSERT INTO Users (public_id, name, email, phone, role) VALUES (?,?,?,?,?)',
        [crypto.randomUUID(), name, email, phone, role]);
      let publicId, extra = {};
      if (role === 'PATIENT') {
        const [p] = await conn.query('INSERT INTO Patient (user_id, public_id, date_of_birth, gender, address) VALUES (?,?,?,?,?)',
          [u.insertId, 'tmp' + crypto.randomBytes(8).toString('hex'), b.date_of_birth || null, str(b.gender, 10) || null, str(b.address) || null]);
        publicId = 'PT-' + pad(p.insertId, 4);
        await conn.query('UPDATE Patient SET public_id=? WHERE patient_id=?', [publicId, p.insertId]);
        extra = { patient_code: publicId };
      } else if (role === 'PROVIDER') {
        const [dep] = await conn.query('SELECT department_id FROM Department WHERE department_name IN (?, ?) ORDER BY department_name=? DESC LIMIT 1',
          [str(b.department, 100) || 'General', 'General', str(b.department, 100) || 'General']);
        const [d] = await conn.query('INSERT INTO Doctor (user_id, public_id, specialization, service, status, daily_token_limit, department_id) VALUES (?,?,?,?,?,?,?)',
          [u.insertId, 'tmp' + crypto.randomBytes(8).toString('hex'), str(b.specialization, 100) || service, service, 'ACTIVE', limit, dep[0].department_id]);
        publicId = 'DR-' + pad(d.insertId, 3);
        await conn.query('UPDATE Doctor SET public_id=? WHERE doctor_id=?', [publicId, d.insertId]);
        extra = { provider_id: publicId, service, status: 'ACTIVE', daily_token_limit: limit };
      } else {
        publicId = 'AD-' + pad(u.insertId, 3);
      }
      await conn.query('UPDATE Users SET public_id=? WHERE user_id=?', [publicId, u.insertId]);
      const out = { user_id: publicId, role, name, email, phone, ...extra, created_at: new Date().toISOString() };
      await audit(conn, c, 'USER_CREATED', 'user', publicId, null, out);
      await outbox(conn, 'user.created', { user_id: publicId, role });
      return out;
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'DUPLICATE_USER', 'A user with this email or phone already exists.', [{ detail: e.sqlMessage }]);
    throw e;
  }
}

const USER_SELECT = `
  SELECT u.public_id AS user_id, u.name, u.email, u.phone, u.role, u.created_at,
         d.public_id AS provider_id, d.service, d.status, d.daily_token_limit,
         p.public_id AS patient_code,
         (SELECT COUNT(*) FROM Appointment ap WHERE ap.patient_id = p.patient_id) AS appointments
  FROM Users u LEFT JOIN Doctor d ON d.user_id = u.user_id LEFT JOIN Patient p ON p.user_id = u.user_id`;
const fmtUser = (r) => {
  const o = { user_id: r.user_id, role: r.role, name: r.name, email: r.email, phone: r.phone, created_at: iso(r.created_at) };
  if (r.role === 'PATIENT') Object.assign(o, { patient_code: r.patient_code, appointments: r.appointments });
  if (r.role === 'PROVIDER') Object.assign(o, { provider_id: r.provider_id, service: r.service, status: r.status, daily_token_limit: r.daily_token_limit });
  return o;
};

/* ------------------------------ booking ------------------------------ */
async function replayResponse(row) {
  const [a] = await pool.query("SELECT audit_id, after_json FROM Audit_Log WHERE entity='appointment' AND entity_id=? AND action='APPOINTMENT_CREATED' ORDER BY created_at LIMIT 1", [row.appointment_id]);
  const after = a[0] && a[0].after_json ? parseJson(a[0].after_json) : {};
  return bookingResponse(row, a[0] ? a[0].audit_id : null, after.rescheduled || []);
}
const bookingResponse = (row, auditId, rescheduled) => ({
  ...fmtAppt(row), audit_id: auditId, rescheduled
});

async function createBooking(c, b, idemKey) {
  /* ---- validation (before touching the DB) ---- */
  const details = [];
  if (!idemKey) throw httpErr(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required.', [{ field: 'Idempotency-Key' }]);
  if (idemKey.length > 100) details.push({ field: 'Idempotency-Key', issue: 'max 100 chars' });
  const userPid = str(b.user_id, 40), provPid = str(b.provider_id, 20);
  if (!userPid) details.push({ field: 'user_id', issue: 'required' });
  if (!provPid) details.push({ field: 'provider_id', issue: 'required' });
  const priority = str(b.priority).toUpperCase() || 'NORMAL';
  if (!['NORMAL', 'EMERGENCY'].includes(priority)) details.push({ field: 'priority', issue: 'NORMAL or EMERGENCY' });
  let apptId = b.appointment_id ? String(b.appointment_id) : crypto.randomUUID();
  if (!UUID_RE.test(apptId)) details.push({ field: 'appointment_id', issue: 'must be a UUID' });
  let startMs = null, endMs = null;
  if (b.start !== undefined && b.start !== null && b.start !== '') {
    if (!isoOk(b.start)) details.push({ field: 'start', issue: 'ISO 8601 UTC required' }); else startMs = Date.parse(b.start);
    if (b.end) { if (!isoOk(b.end)) details.push({ field: 'end', issue: 'ISO 8601 UTC required' }); else endMs = Date.parse(b.end); }
    else endMs = startMs === null ? null : startMs + CFG.slotMs;
    if (startMs !== null && endMs !== null && endMs <= startMs) details.push({ field: 'end', issue: 'must be after start' });
  }
  let date = b.date ? String(b.date) : (startMs !== null ? new Date(startMs).toISOString().slice(0, 10) : '');
  if (!DATE_RE.test(date)) details.push({ field: 'date', issue: 'send start/end, or date as YYYY-MM-DD' });
  if (details.length) throw httpErr(400, 'VALIDATION_ERROR', 'Invalid booking request.', details);
  const reason = str(b.purpose || b.reason) || null;

  /* ---- fast replay: same key already used ---- */
  const prior = await getApptRow(pool, 'a.idempotency_key = ?', [idemKey]);
  if (prior) return { status: 201, replay: true, body: await replayResponse(prior) };

  try {
    return await tx(async (conn) => {
      /* 1. per-doctor lock: everything below is serialised per doctor */
      const [dr] = await conn.query('SELECT d.doctor_id, d.status, d.daily_token_limit FROM Doctor d WHERE d.public_id=? FOR UPDATE', [provPid]);
      if (!dr.length) throw httpErr(404, 'NOT_FOUND', `Provider ${provPid} not found.`);
      const doc = dr[0];
      /* 2. replay again, now that we hold the lock (two parallel requests with one key) */
      const again = await getApptRow(conn, 'a.idempotency_key = ? OR a.public_id = ?', [idemKey, apptId]);
      if (again) return { status: 201, replay: true, body: await replayResponse(again) };

      const [pt] = await conn.query('SELECT patient_id FROM Patient WHERE public_id=?', [userPid]);
      if (!pt.length) throw httpErr(404, 'NOT_FOUND', `Patient ${userPid} not found.`);
      if (doc.status !== 'ACTIVE') throw httpErr(409, 'PROVIDER_UNAVAILABLE', 'Doctor is currently unavailable (on leave).');

      const emergency = priority === 'EMERGENCY';
      if (!emergency) {
        const [dupe] = await conn.query(
          "SELECT token_number FROM Appointment WHERE patient_id=? AND doctor_id=? AND appointment_date=? AND state IN ('REQUESTED','CONFIRMED','RESCHEDULED','WAITLISTED','CALLED','IN_CONSULTATION') LIMIT 1",
          [pt[0].patient_id, doc.doctor_id, date]);
        if (dupe.length) throw httpErr(409, 'ALREADY_BOOKED', `You already hold a booking${dupe[0].token_number ? ' (Token #' + dupe[0].token_number + ')' : ''} with this doctor on ${date}.`);
      }

      /* working hours of that day (Doctor_Schedule); start = end means "day off" */
      const [sch] = await conn.query('SELECT start_time, end_time FROM Doctor_Schedule WHERE doctor_id=? AND available_date=? ORDER BY start_time', [doc.doctor_id, date]);
      if (sch.length && sch.every((r) => r.start_time === r.end_time))
        throw httpErr(409, 'PROVIDER_UNAVAILABLE', `Doctor is not working on ${date}.`);
      const hmsMs = (t) => { const [h, m, sec] = String(t).split(':').map(Number); return ((h * 60 + m) * 60 + (sec || 0)) * 1000; };
      const midnight = Date.parse(date + 'T00:00:00Z');

      const used = await countedToday(conn, doc.doctor_id, date);
      const highest = await maxToken(conn, doc.doctor_id, date);
      let full = !emergency && used >= doc.daily_token_limit;
      const dur = startMs !== null ? endMs - startMs : CFG.slotMs;
      const dayStart = midnight + (sch.length ? hmsMs(sch[0].start_time) : CFG.dayStartHour * 3600000);
      const dayEnd = sch.length ? midnight + hmsMs(sch[sch.length - 1].end_time) : null;

      let state = 'CONFIRMED', token = highest + 1;
      const moved = [];

      if (full) {
        /* daily limit reached -> WAITLISTED (no token, does not occupy a slot) */
        state = 'WAITLISTED'; token = null;
        if (startMs === null) { startMs = dayStart; endMs = startMs + dur; }
      } else if (startMs === null) {
        if (emergency) {
          /* first position: the start of the earliest waiting appointment of that day */
          const [first] = await conn.query(
            "SELECT start_time FROM Appointment WHERE doctor_id=? AND appointment_date=? AND state IN ('REQUESTED','CONFIRMED','RESCHEDULED') ORDER BY start_time LIMIT 1",
            [doc.doctor_id, date]);
          startMs = first.length ? dbMs(first[0].start_time) : await firstFree(conn, doc.doctor_id, dayStart, dur);
        } else {
          startMs = await firstFree(conn, doc.doctor_id, dayStart + highest * CFG.slotMs, dur);
        }
        endMs = startMs + dur;
        if (!emergency && dayEnd !== null && endMs > dayEnd) { full = true; state = 'WAITLISTED'; token = null; }   // no time left that day
      }

      if (!full) {
        /* slot check: any live appointment overlapping [start,end) ? */
        const [over] = await conn.query(
          `SELECT a.appointment_id AS _id, a.public_id, a.state, a.version, a.start_time, a.end_time, p.public_id AS user_id
           FROM Appointment a JOIN Patient p ON p.patient_id=a.patient_id
           WHERE a.doctor_id=? AND a.live_start < ? AND a.end_time > ? ORDER BY a.start_time FOR UPDATE`,
          [doc.doctor_id, toDb(endMs), toDb(startMs)]);
        if (over.length) {
          if (!emergency) {
            throw httpErr(409, 'SLOT_CONFLICT', 'That slot is already booked.',
              [{ provider_id: provPid, start: iso(over[0].start_time), end: iso(over[0].end_time) }]);
          }
          /* EMERGENCY: push the affected appointments later, chain-wise */
          const [chain] = await conn.query(
            `SELECT a.appointment_id AS _id, a.public_id, a.state, a.version, a.start_time, a.end_time, p.public_id AS user_id
             FROM Appointment a JOIN Patient p ON p.patient_id=a.patient_id
             WHERE a.doctor_id=? AND a.live_start IS NOT NULL AND a.end_time > ? ORDER BY a.start_time FOR UPDATE`,
            [doc.doctor_id, toDb(startMs)]);
          let front = endMs; const plan = [];
          for (const r of chain) {
            if (dbMs(r.start_time) >= front) break;           // a gap: the rest is unaffected
            if (SERVING.includes(r.state)) throw httpErr(409, 'SLOT_CONFLICT', 'The doctor is already with a patient at that time; choose a later start.', [{ provider_id: provPid }]);
            const len = dbMs(r.end_time) - dbMs(r.start_time);
            plan.push({ r, newStart: front, newEnd: front + len });
            front += len;
          }
          for (const m of plan.reverse()) {                   // last one first: never two live rows on one start
            await conn.query("UPDATE Appointment SET start_time=?, end_time=?, state='RESCHEDULED', version=version+1 WHERE appointment_id=?",
              [toDb(m.newStart), toDb(m.newEnd), m.r._id]);
            const info = {
              appointment_id: m.r.public_id, user_id: m.r.user_id, previous_start: iso(m.r.start_time),
              start: new Date(m.newStart).toISOString(), end: new Date(m.newEnd).toISOString(),
              state: 'RESCHEDULED', version: m.r.version + 1
            };
            await audit(conn, c, 'APPOINTMENT_RESCHEDULED', 'appointment', m.r.public_id,
              { state: m.r.state, version: m.r.version, start: iso(m.r.start_time), end: iso(m.r.end_time) },
              { state: 'RESCHEDULED', version: info.version, start: info.start, end: info.end, reason: 'EMERGENCY_PRIORITY' });
            await outbox(conn, 'appointment.rescheduled', { appointment_id: info.appointment_id, provider_id: provPid, start: info.start });
            moved.unshift(info);
          }
        }
      }

      /* 3. insert the appointment */
      await conn.query(
        `INSERT INTO Appointment (public_id, patient_id, doctor_id, appointment_date, token_number, priority, state,
                                  start_time, end_time, reason, version, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
        [apptId, pt[0].patient_id, doc.doctor_id, date, token, priority, state, toDb(startMs), toDb(endMs), reason, idemKey]);

      const row = await getApptRow(conn, 'a.public_id = ?', [apptId]);
      const after = { ...fmtAppt(row), rescheduled: moved };
      const auditId = await audit(conn, c, 'APPOINTMENT_CREATED', 'appointment', apptId, null, after);
      await outbox(conn, 'appointment.created', {
        appointment_id: apptId, provider_id: provPid, user_id: userPid, state, priority,
        token_number: token, date, start: after.start
      });
      return { status: 201, replay: false, body: bookingResponse(row, auditId, moved) };
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      const m = String(e.sqlMessage || '');
      if (m.includes('uq_appt_idem') || m.includes('public_id')) {
        const row = await getApptRow(pool, 'a.idempotency_key = ? OR a.public_id = ?', [idemKey, apptId]);
        if (row) return { status: 201, replay: true, body: await replayResponse(row) };
      }
      throw httpErr(409, 'SLOT_CONFLICT', 'That slot was just taken by another booking.', [{ detail: m }]);
    }
    throw e;
  }
}

/* ------------------------------ state changes ------------------------------ */
async function changeState(c, id, toState, expectedVersion, action = 'APPOINTMENT_STATE_CHANGED', opts = {}) {
  if (!STATES.includes(toState)) throw httpErr(400, 'VALIDATION_ERROR', `to_state must be one of ${STATES.join(', ')}.`, [{ field: 'to_state' }]);
  if (expectedVersion !== undefined && expectedVersion !== null && !Number.isInteger(Number(expectedVersion))) throw httpErr(400, 'VALIDATION_ERROR', 'expected_version must be an integer.');
  const probe = await getApptRow(pool, 'a.public_id = ?', [id]);
  if (!probe) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  return tx(async (conn) => {
    await conn.query('SELECT doctor_id FROM Doctor WHERE doctor_id=? FOR UPDATE', [probe.doctor_id]);   // same lock order as booking
    const cur = await getApptRow(conn, 'a.public_id = ?', [id], true);
    if (!cur) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== cur.version)
      throw httpErr(409, 'VERSION_CONFLICT', `Appointment is at version ${cur.version}, not ${expectedVersion}.`, [{ current_version: cur.version }]);
    if (!TRANSITIONS[cur.state].includes(toState))
      throw httpErr(409, 'ILLEGAL_TRANSITION', `Cannot move from ${cur.state} to ${toState}.`,
        [{ from: cur.state, to: toState, allowed: TRANSITIONS[cur.state] }]);

    let token = cur.token_number, startMs = dbMs(cur.start_time), endMs = dbMs(cur.end_time);
    if (cur.state === 'WAITLISTED' && toState === 'CONFIRMED') {            // promotion
      if (await countedToday(conn, cur.doctor_id, cur.appointment_date) >= cur.daily_token_limit)
        throw httpErr(409, 'CAPACITY_EXHAUSTED', 'The daily token limit is still full; cannot confirm.');
      token = (await maxToken(conn, cur.doctor_id, cur.appointment_date)) + 1;
      const free = await firstFree(conn, cur.doctor_id, startMs, endMs - startMs);
      endMs = free + (endMs - startMs); startMs = free;
    }
    const dur = endMs - startMs;
    if (cur.state === 'WAITLISTED' && toState === 'RESCHEDULED') {          // reception re-admits an absent patient: keeps the token, goes to the back
      if (token === null) token = (await maxToken(conn, cur.doctor_id, cur.appointment_date)) + 1;
      const free = await firstFree(conn, cur.doctor_id, await queueEnd(conn, cur.doctor_id, cur.appointment_date), dur);
      startMs = free; endMs = free + dur;
    } else if (toState === 'RESCHEDULED' && opts.new_token) {               // absent patient gets a NEW token at the end of the queue
      token = (await maxToken(conn, cur.doctor_id, cur.appointment_date)) + 1;
      const free = await firstFree(conn, cur.doctor_id, await queueEnd(conn, cur.doctor_id, cur.appointment_date), dur);
      startMs = free; endMs = free + dur;
    }
    if (LIVE.includes(toState) && !LIVE.includes(cur.state) && cur.state !== 'WAITLISTED') {
      const free = await firstFree(conn, cur.doctor_id, startMs, endMs - startMs);   // coming back from NO_SHOW etc. (not allowed today, safe)
      endMs = free + (endMs - startMs); startMs = free;
    }
    await conn.query('UPDATE Appointment SET state=?, token_number=?, start_time=?, end_time=?, version=version+1 WHERE appointment_id=?',
      [toState, token, toDb(startMs), toDb(endMs), cur._id]);
    const row = await getApptRow(conn, 'a.public_id = ?', [id]);
    const auditId = await audit(conn, c, action, 'appointment', id,
      { state: cur.state, version: cur.version, token_number: cur.token_number, start: iso(cur.start_time) },
      { state: row.state, version: row.version, token_number: row.token_number, start: iso(row.start_time) });
    await outbox(conn, toState === 'CANCELLED' ? 'appointment.cancelled' : 'appointment.state_changed', {
      appointment_id: id, provider_id: row.provider_id, user_id: row.user_id,
      from_state: cur.state, state: toState, version: row.version, token_number: row.token_number, date: row.appointment_date
    });
    return { ...fmtAppt(row), audit_id: auditId };
  });
}

/* ------------------------------ providers ------------------------------ */
const PROV_SELECT = `
  SELECT d.public_id AS provider_id, u.name, d.service, d.specialization, d.status, d.daily_token_limit,
         dep.department_name AS department, u.email
  FROM Doctor d JOIN Users u ON u.user_id = d.user_id JOIN Department dep ON dep.department_id = d.department_id`;

async function patchProvider(c, id, b) {
  const sets = [], p = {};
  if (b.status !== undefined) {
    let s = str(b.status).toUpperCase(); if (s === 'ON_LEAVE') s = 'INACTIVE';       // Team D's old word
    if (!['ACTIVE', 'INACTIVE'].includes(s)) throw httpErr(400, 'VALIDATION_ERROR', 'status must be ACTIVE or INACTIVE.', [{ field: 'status' }]);
    p.status = s;
  }
  if (b.daily_token_limit !== undefined) {
    const n = Number(b.daily_token_limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw httpErr(400, 'VALIDATION_ERROR', 'daily_token_limit must be an integer 1..500.', [{ field: 'daily_token_limit' }]);
    p.daily_token_limit = n;
  }
  if (b.name !== undefined) { p.name = str(b.name, 100); if (p.name.length < 2) throw httpErr(400, 'VALIDATION_ERROR', 'name too short.', [{ field: 'name' }]); }
  if (b.service !== undefined) { p.service = str(b.service, 100); if (!p.service) throw httpErr(400, 'VALIDATION_ERROR', 'service cannot be empty.', [{ field: 'service' }]); }
  if (!Object.keys(p).length) throw httpErr(400, 'VALIDATION_ERROR', 'Send at least one of status, daily_token_limit, name, service.');
  return tx(async (conn) => {
    const [r] = await conn.query('SELECT d.doctor_id, d.user_id FROM Doctor d WHERE d.public_id=? FOR UPDATE', [id]);
    if (!r.length) throw httpErr(404, 'NOT_FOUND', `Provider ${id} not found.`);
    const [[before]] = await conn.query(`${PROV_SELECT} WHERE d.doctor_id=?`, [r[0].doctor_id]);
    const dset = ['status', 'daily_token_limit', 'service'].filter((k) => p[k] !== undefined);
    if (dset.length) await conn.query(`UPDATE Doctor SET ${dset.map((k) => k + '=?').join(', ')} WHERE doctor_id=?`, [...dset.map((k) => p[k]), r[0].doctor_id]);
    if (p.name !== undefined) await conn.query('UPDATE Users SET name=? WHERE user_id=?', [p.name, r[0].user_id]);
    const [[after]] = await conn.query(`${PROV_SELECT} WHERE d.doctor_id=?`, [r[0].doctor_id]);
    await audit(conn, c, 'PROVIDER_UPDATED', 'provider', id, before, after);
    await outbox(conn, 'provider.updated', { provider_id: id, ...p });
    return after;
  });
}

async function providerCalendar(id, q) {
  const [dr] = await pool.query(`${PROV_SELECT} WHERE d.public_id=?`, [id]);
  if (!dr.length) throw httpErr(404, 'NOT_FOUND', `Provider ${id} not found.`);
  const [[dd]] = await pool.query('SELECT doctor_id FROM Doctor WHERE public_id=?', [id]);
  const from = q.from || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(from)) throw httpErr(400, 'VALIDATION_ERROR', 'from must be YYYY-MM-DD.', [{ field: 'from' }]);
  const days = Math.min(60, Math.max(1, Number(q.days) || 30));
  const fromMs = Date.parse(from + 'T00:00:00Z'), to = new Date(fromMs + (days - 1) * 86400000).toISOString().slice(0, 10);
  const [hours] = await pool.query('SELECT available_date, start_time, end_time FROM Doctor_Schedule WHERE doctor_id=? AND available_date BETWEEN ? AND ? ORDER BY available_date, start_time', [dd.doctor_id, from, to]);
  const [counts] = await pool.query(`SELECT appointment_date, COUNT(*) n FROM Appointment WHERE doctor_id=? AND appointment_date BETWEEN ? AND ? AND state NOT IN ${NOT_COUNTED} GROUP BY appointment_date`, [dd.doctor_id, from, to]);
  const [blocked] = await pool.query('SELECT public_id, start_time, end_time, state FROM Appointment WHERE doctor_id=? AND live_start IS NOT NULL AND appointment_date BETWEEN ? AND ? ORDER BY start_time', [dd.doctor_id, from, to]);
  let mine = {};
  if (q.user_id) {
    const [m] = await pool.query(`SELECT a.appointment_date, a.token_number FROM Appointment a JOIN Patient p ON p.patient_id=a.patient_id WHERE p.public_id=? AND a.doctor_id=? AND a.appointment_date BETWEEN ? AND ? AND a.state NOT IN ${NOT_COUNTED}`, [q.user_id, dd.doctor_id, from, to]);
    m.forEach((x) => { mine[x.appointment_date] = x.token_number; });
  }
  const [[ver]] = await pool.query('SELECT COALESCE(MAX(event_id),0) v FROM Outbox_Event');
  const byDate = Object.fromEntries(counts.map((x) => [x.appointment_date, Number(x.n)]));
  const closed = new Set(hours.filter((h) => h.start_time === h.end_time).map((h) => h.available_date));
  const limit = dr[0].daily_token_limit, dayList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(fromMs + i * 86400000).toISOString().slice(0, 10), booked = byDate[d] || 0, remaining = Math.max(0, limit - booked);
    dayList.push({
      date: d, daily_token_limit: limit, booked_tokens: booked, remaining_tokens: remaining,
      status: (dr[0].status !== 'ACTIVE' || closed.has(d)) ? 'UNAVAILABLE' : (mine[d] ? 'MINE' : (remaining <= 0 ? 'FULL' : 'AVAILABLE')),
      user_token: mine[d] || null
    });
  }
  return {
    provider: { provider_id: id, name: dr[0].name, service: dr[0].service, status: dr[0].status, daily_token_limit: limit },
    calendar_version: 'v' + ver.v, capacity: { daily_token_limit: limit, slot_minutes: CFG.slotMs / 60000 },
    working_hours: hours.map((h) => ({ date: h.available_date, start: h.start_time, end: h.end_time, closed: h.start_time === h.end_time })),
    default_working_hours: { start: pad(CFG.dayStartHour, 2) + ':00:00', note: 'used for dates without a Doctor_Schedule row' },
    blocked_intervals: blocked.map((b) => ({ start: iso(b.start_time), end: iso(b.end_time), state: b.state })),
    dates: dayList
  };
}

/* ------------------------------ reports / audit / events ------------------------------ */
async function utilization(q) {
  const where = ['1=1'], p = [];
  const from = q.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = q.to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw httpErr(400, 'VALIDATION_ERROR', 'from/to must be YYYY-MM-DD.');
  where.push('a.appointment_date BETWEEN ? AND ?'); p.push(from, to);
  if (q.provider_id) { where.push('d.public_id = ?'); p.push(q.provider_id); }
  const [rows] = await pool.query(
    `SELECT d.public_id AS provider_id, u.name AS provider_name, a.appointment_date AS date, d.daily_token_limit,
            SUM(a.state NOT IN ${NOT_COUNTED}) AS booked, SUM(a.state='COMPLETED') AS completed,
            SUM(a.state='CANCELLED') AS cancelled, SUM(a.state='NO_SHOW') AS no_show, SUM(a.state='WAITLISTED') AS waitlisted
     FROM Appointment a JOIN Doctor d ON d.doctor_id=a.doctor_id JOIN Users u ON u.user_id=d.user_id
     WHERE ${where.join(' AND ')} GROUP BY d.public_id, u.name, a.appointment_date, d.daily_token_limit
     ORDER BY a.appointment_date, d.public_id`, p);
  return rows.map((r) => ({
    provider_id: r.provider_id, provider_name: r.provider_name, date: r.date, daily_token_limit: r.daily_token_limit,
    booked: Number(r.booked), completed: Number(r.completed), cancelled: Number(r.cancelled), no_show: Number(r.no_show),
    waitlisted: Number(r.waitlisted), utilization_pct: Math.round((Number(r.booked) * 1000) / r.daily_token_limit) / 10
  }));
}

/* ------------------------------ schedule + recovery ------------------------------ */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
async function setSchedule(c, id, b) {
  const date = str(b.date, 10);
  if (!DATE_RE.test(date)) throw httpErr(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD.', [{ field: 'date' }]);
  const mode = b.reset === true ? 'reset' : (b.closed === true ? 'closed' : 'hours');
  let start = null, end = null;
  if (mode === 'hours') {
    if (!HHMM.test(str(b.start, 8)) || !HHMM.test(str(b.end, 8))) throw httpErr(400, 'VALIDATION_ERROR', 'start and end must be HH:MM.', [{ field: 'start' }, { field: 'end' }]);
    start = str(b.start, 8); end = str(b.end, 8);
    if (start.length === 5) start += ':00';
    if (end.length === 5) end += ':00';
    if (end <= start) throw httpErr(400, 'VALIDATION_ERROR', 'end must be after start.', [{ field: 'end' }]);
  }
  return tx(async (conn) => {
    const [dr] = await conn.query('SELECT doctor_id FROM Doctor WHERE public_id=? FOR UPDATE', [id]);
    if (!dr.length) throw httpErr(404, 'NOT_FOUND', `Provider ${id} not found.`);
    const doctorId = dr[0].doctor_id;
    if (mode === 'closed') {
      const [[n]] = await conn.query("SELECT COUNT(*) n FROM Appointment WHERE doctor_id=? AND appointment_date=? AND state IN ('REQUESTED','CONFIRMED','RESCHEDULED','CALLED','IN_CONSULTATION','WAITLISTED')", [doctorId, date]);
      if (Number(n.n) > 0) throw httpErr(409, 'SLOT_CONFLICT', `${n.n} active appointment(s) exist on ${date}. Cancel them before marking a day off.`, [{ count: Number(n.n) }]);
    }
    const [before] = await conn.query('SELECT start_time, end_time FROM Doctor_Schedule WHERE doctor_id=? AND available_date=?', [doctorId, date]);
    await conn.query('DELETE FROM Doctor_Schedule WHERE doctor_id=? AND available_date=?', [doctorId, date]);
    if (mode === 'closed') await conn.query("INSERT INTO Doctor_Schedule (doctor_id, available_date, start_time, end_time) VALUES (?,?,'00:00:00','00:00:00')", [doctorId, date]);
    if (mode === 'hours') await conn.query('INSERT INTO Doctor_Schedule (doctor_id, available_date, start_time, end_time) VALUES (?,?,?,?)', [doctorId, date, start, end]);
    const out = { provider_id: id, date, mode, start, end };
    await audit(conn, c, 'PROVIDER_SCHEDULE_CHANGED', 'provider', id,
      { date, hours: before.map((r) => ({ start: r.start_time, end: r.end_time })) }, out);
    await outbox(conn, 'provider.schedule_changed', { provider_id: id, date, mode });
    return out;
  });
}

/* Read-only integrity check used for the recovery exercise (Team C KPI: recovery / data quality) */
async function recoveryVerify() {
  const t0 = Date.now();
  const n = async (sql) => Number((await pool.query(sql))[0][0].n);
  const counts = {};
  for (const t of ['Department', 'Users', 'Doctor', 'Patient', 'Doctor_Schedule', 'Appointment', 'Audit_Log', 'Outbox_Event']) counts[t] = await n(`SELECT COUNT(*) n FROM ${t}`);
  const violations = {
    orphan_appointments: await n('SELECT COUNT(*) n FROM Appointment a LEFT JOIN Patient p ON p.patient_id=a.patient_id LEFT JOIN Doctor d ON d.doctor_id=a.doctor_id WHERE p.patient_id IS NULL OR d.doctor_id IS NULL'),
    duplicate_live_slots: await n('SELECT COUNT(*) n FROM (SELECT doctor_id, live_start FROM Appointment WHERE live_start IS NOT NULL GROUP BY doctor_id, live_start HAVING COUNT(*) > 1) t'),
    duplicate_tokens: await n('SELECT COUNT(*) n FROM (SELECT doctor_id, appointment_date, token_number FROM Appointment WHERE token_number IS NOT NULL GROUP BY doctor_id, appointment_date, token_number HAVING COUNT(*) > 1) t'),
    overlapping_live_appointments: await n('SELECT COUNT(*) n FROM Appointment a JOIN Appointment b ON a.doctor_id=b.doctor_id AND a.appointment_id<b.appointment_id AND a.live_start IS NOT NULL AND b.live_start IS NOT NULL AND a.live_start<b.end_time AND b.live_start<a.end_time'),
    appointments_without_create_audit: await n("SELECT COUNT(*) n FROM Appointment a LEFT JOIN Audit_Log l ON l.entity='appointment' AND l.entity_id=a.public_id AND l.action='APPOINTMENT_CREATED' WHERE l.audit_id IS NULL")
  };
  const [[last]] = await pool.query('SELECT MAX(created_at) at FROM Audit_Log');
  return {
    status: Object.values(violations).every((v) => v === 0) ? 'OK' : 'PROBLEMS_FOUND',
    checked_at: new Date().toISOString(), duration_ms: Date.now() - t0,
    row_counts: counts, violations, last_audit_write: iso(last.at)
  };
}

/* ------------------------------ router ------------------------------ */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, handler, re: new RegExp('^' + pattern.replace(/\{\w+\}/g, '([^/]+)') + '$') });
const idOf = (s) => decodeURIComponent(s);

route('GET', '/health', async () => ({ raw: { status: 'ok' } }));

route('POST', '/api/v1/users', async (x) => ({ status: 201, data: await createUser(x.c, x.body) }));
route('GET', '/api/v1/users', async (x) => {
  const w = ['1=1'], p = [];
  if (x.query.role) { const r = x.query.role.toUpperCase(); if (!['PATIENT', 'PROVIDER', 'ADMIN'].includes(r)) throw httpErr(400, 'VALIDATION_ERROR', 'Bad role.', [{ field: 'role' }]); w.push('u.role=?'); p.push(r); }
  if (x.query.q) { w.push('(u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR u.public_id LIKE ?)'); const l = `%${x.query.q}%`; p.push(l, l, l, l); }
  const [rows] = await pool.query(`${USER_SELECT} WHERE ${w.join(' AND ')} ORDER BY u.public_id`, p);
  return { data: rows.map(fmtUser) };
});
route('GET', '/api/v1/users/{id}', async (x) => {
  const [rows] = await pool.query(`${USER_SELECT} WHERE u.public_id=?`, [idOf(x.params[0])]);
  if (!rows.length) throw httpErr(404, 'NOT_FOUND', 'User not found.');
  return { data: fmtUser(rows[0]) };
});

route('GET', '/api/v1/providers', async (x) => {
  const [rows] = await pool.query(`${PROV_SELECT} ${x.query.status ? 'WHERE d.status=?' : ''} ORDER BY d.doctor_id`, x.query.status ? [x.query.status.toUpperCase()] : []);
  return { data: rows };
});
route('PATCH', '/internal/v1/providers/{id}', async (x) => ({ data: await patchProvider(x.c, idOf(x.params[0]), x.body) }));
route('GET', '/api/v1/providers/{id}/calendar', async (x) => ({ data: await providerCalendar(idOf(x.params[0]), x.query) }));

route('POST', '/api/v1/appointments', async (x) => {
  const r = await createBooking(x.c, x.body, str(x.req.headers['idempotency-key'], 200));
  if (r.replay) x.headers['Idempotent-Replay'] = 'true';
  return { status: r.status, data: r.body };
});
route('GET', '/api/v1/appointments', async (x) => {
  const w = ['1=1'], p = [], q = x.query;
  if (q.user_id) { w.push('p.public_id=?'); p.push(q.user_id); }
  if (q.provider_id) { w.push('d.public_id=?'); p.push(q.provider_id); }
  if (q.date) { if (!DATE_RE.test(q.date)) throw httpErr(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD.', [{ field: 'date' }]); w.push('a.appointment_date=?'); p.push(q.date); }
  if (q.state) { const s = q.state.toUpperCase(); if (!STATES.includes(s)) throw httpErr(400, 'VALIDATION_ERROR', 'Unknown state.', [{ field: 'state' }]); w.push('a.state=?'); p.push(s); }
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
  const [rows] = await pool.query(`${APPT_SELECT} WHERE ${w.join(' AND ')} ORDER BY a.appointment_date DESC, a.token_number, a.start_time LIMIT ${limit}`, p);
  return { data: rows.map(fmtAppt) };
});
route('GET', '/api/v1/appointments/{id}', async (x) => {
  const r = await getApptRow(pool, 'a.public_id=?', [idOf(x.params[0])]);
  if (!r) throw httpErr(404, 'NOT_FOUND', 'Appointment not found.');
  return { data: fmtAppt(r) };
});
route('POST', '/api/v1/appointments/{id}/cancel', async (x) => ({ data: await changeState(x.c, idOf(x.params[0]), 'CANCELLED', x.body.expected_version, 'APPOINTMENT_CANCELLED') }));
route('POST', '/internal/v1/appointments/{id}/transition', async (x) => ({ data: await changeState(x.c, idOf(x.params[0]), str(x.body.to_state).toUpperCase(), x.body.expected_version, 'APPOINTMENT_STATE_CHANGED', { new_token: x.body.new_token === true }) }));

/* Development only: clears all appointments (audit rows are kept). Needs ALLOW_DEV_RESET=true in .env */
route('POST', '/internal/v1/dev/reset-appointments', async (x) => {
  if (env('ALLOW_DEV_RESET', 'false').toLowerCase() !== 'true') throw httpErr(403, 'FORBIDDEN', 'Dev reset is disabled. Set ALLOW_DEV_RESET=true in the Team C .env and restart.');
  return { data: await tx(async (conn) => {
    const [r] = await conn.query('DELETE FROM Appointment');
    await audit(conn, x.c, 'DEV_RESET_APPOINTMENTS', 'system', 'all', { deleted: r.affectedRows }, null);
    return { deleted: r.affectedRows };
  }) };
});

route('PUT', '/internal/v1/providers/{id}/schedule', async (x) => ({ data: await setSchedule(x.c, idOf(x.params[0]), x.body) }));
route('POST', '/internal/v1/recovery/verify', async () => ({ data: await recoveryVerify() }));
route('GET', '/api/v1/reports/utilization', async (x) => ({ data: await utilization(x.query) }));
route('GET', '/api/v1/audit', async (x) => {
  const w = ['1=1'], p = [];
  if (x.query.correlation_id) { w.push('correlation_id=?'); p.push(x.query.correlation_id); }
  if (x.query.entity_id) { w.push('entity_id=?'); p.push(x.query.entity_id); }
  const limit = Math.min(1000, Math.max(1, Number(x.query.limit) || 200));
  const [rows] = await pool.query(`SELECT audit_id, actor, action, entity, entity_id, before_json, after_json, correlation_id, source_service, created_at FROM Audit_Log WHERE ${w.join(' AND ')} ORDER BY created_at ${x.query.order === 'desc' ? 'DESC' : 'ASC'}, audit_id LIMIT ${limit}`, p);
  return { data: rows.map((r) => ({ ...r, before_json: r.before_json ? parseJson(r.before_json) : null, after_json: r.after_json ? parseJson(r.after_json) : null, created_at: iso(r.created_at) })) };
});
route('GET', '/api/v1/events', async (x) => {
  const since = Math.max(0, Number(x.query.since) || 0);
  const [rows] = await pool.query('SELECT event_id, type, payload_json, created_at FROM Outbox_Event WHERE event_id > ? ORDER BY event_id LIMIT 100', [since]);
  const next = rows.length ? Number(rows[rows.length - 1].event_id) : since;
  if (rows.length) await pool.query('UPDATE Outbox_Event SET delivered=1 WHERE event_id > ? AND event_id <= ? AND delivered=0', [since, next]);
  return { data: { events: rows.map((r) => ({ event_id: Number(r.event_id), type: r.type, payload: parseJson(r.payload_json), created_at: iso(r.created_at) })), next_cursor: next } };
});

/* ------------------------------ http server ------------------------------ */
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (ch) => { raw += ch; if (raw.length > 1e6) { reject(httpErr(400, 'VALIDATION_ERROR', 'Body too large.')); req.destroy(); } });
  req.on('end', () => {
    if (!raw.trim()) return resolve({});
    try { const b = JSON.parse(raw); resolve(b && typeof b === 'object' ? b : {}); }
    catch { reject(httpErr(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.')); }
  });
  req.on('error', reject);
});
const keyOk = (hdr) => {
  const m = /^Bearer (.+)$/.exec(hdr || ''); if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest(), b = crypto.createHash('sha256').update(CFG.key).digest();
  return crypto.timingSafeEqual(a, b);
};

const hits = new Map();
const tooMany = (req) => {
  if (!CFG.rateLimit) return false;
  const ip = req.socket.remoteAddress || 'x', now = Date.now();
  let b = hits.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, n: 0 }; hits.set(ip, b); }
  return ++b.n > CFG.rateLimit;
};
setInterval(() => { const now = Date.now(); for (const [k, b] of hits) if (now - b.start > 60000) hits.delete(k); }, 60000).unref();

const server = http.createServer(async (req, res) => {
  const cid = str(req.headers['x-correlation-id'], 64) || crypto.randomUUID();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Correlation-ID': cid };
  const send = (status, body, extra = {}) => { res.writeHead(status, { ...headers, ...extra }); res.end(JSON.stringify(body)); };
  const t0 = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (url.pathname !== '/health' && tooMany(req)) throw httpErr(429, 'RATE_LIMITED', 'Too many requests. Slow down and retry in a minute.');
    if (!(r && url.pathname === '/health') && !keyOk(req.headers.authorization))
      return send(401, { error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid service key.', details: [] }, meta: { correlation_id: cid } });
    if (!r) throw httpErr(404, 'NOT_FOUND', `No such endpoint: ${req.method} ${url.pathname}`);
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const x = {
      req, body, headers: {}, params: r.re.exec(url.pathname).slice(1), query: Object.fromEntries(url.searchParams),
      c: { correlation_id: cid, actor: str(req.headers['x-actor'], 100) || 'service:team-d', source: str(req.headers['x-source-service'], 40) || 'team-d' }
    };
    const out = await r.handler(x);
    if (out.raw) return send(200, out.raw);
    send(out.status || 200, { data: out.data, meta: { correlation_id: cid, api_version: 'v1' } }, x.headers);
  } catch (e) {
    if (e.status) return send(e.status, { error: { code: e.code, message: e.message, details: e.details || [] }, meta: { correlation_id: cid } });
    console.error(`[${cid}] INTERNAL_ERROR`, e);
    send(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.', details: [] }, meta: { correlation_id: cid } });
  } finally {
    if (req.url !== '/health') console.log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms cid=${cid}`);
  }
});

pool.query('SELECT 1').then(() => {
  server.listen(CFG.port, () => console.log(`Team C service listening on http://localhost:${CFG.port}  (db: ${CFG.db.database})`));
}).catch((e) => { console.error('Cannot connect to MySQL:', e.message); process.exit(1); });