'use strict';
/**
 * CareSlot: Team D Portal (Browser Side)
 * Featuring Admin-Controlled Token System, 2-Min Patient Availability Check,
 * "Consultancy Going On" Mode (no timer), and Emergency Priority.
 */

/* =========================== 1. HELPERS =========================== */
const $ = (s) => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const fmtDT = (iso) => `${fmtDate(iso)}, ${fmtTime(iso)}`;

function badge(s) {
  const norm = String(s || '').toUpperCase();
  let label = norm.replace(/_/g, ' ');
  if (norm === 'IN_CONSULTATION') label = '🩺 IN CONSULTATION';
  if (norm === 'CALLED') label = '📢 CALLED (2-MIN BUFFER)';
  return `<span class="badge ${esc(norm)}">${esc(label)}</span>`;
}

const state = {
  token: sessionStorage.getItem('token'),
  user: null,
  view: null,
  renderId: 0,
  es: null,
  live: false,
  lastEvent: 0,
  selectedDoctorForLimit: null,
  reloadCalendar: null
};

function toast(msg, type = 'info', ms = 5000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function showError(el, e, retry) {
  el.innerHTML = `
    <div class="err-box" role="alert">
      <b>${esc(e.message || 'Something went wrong.')}</b>
      <div><small>Code: ${esc(e.code || 'UNKNOWN')}</small></div>
      ${retry ? `<button class="btn small" id="retry-btn" type="button">Try again</button>` : ''}
    </div>`;
  const b = el.querySelector('#retry-btn');
  if (b && retry) b.onclick = retry;
}

/* =========================== 2. API CLIENT =========================== */
async function api(method, path, body, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(path, {
      method,
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': uid(),
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let json;
    try { json = await res.json(); } catch { throw { code: 'BAD_RESPONSE', message: 'Unreadable server response.' }; }
    if (!res.ok) {
      if (res.status === 401 && state.user) logout('Your session expired. Please log in again.');
      throw json.error || { code: 'ERROR', message: 'The request failed.' };
    }
    return json.data;
  } catch (e) {
    if (e.name === 'AbortError') throw { code: 'TIMEOUT', message: 'Server took too long to respond.' };
    if (e instanceof TypeError) throw { code: 'NETWORK', message: 'Cannot reach the CareSlot server.' };
    throw e;
  } finally { clearTimeout(timer); }
}

function fieldErrors(scope, details) {
  document.querySelectorAll(`[id^="${scope}-err-"]`).forEach((el) => { el.textContent = ''; });
  let any = false;
  (details || []).forEach((d) => {
    const el = document.getElementById(`${scope}-err-${d.field}`);
    if (el) { el.textContent = d.message; any = true; }
  });
  return any;
}

/* =========================== 3. LIVE STREAM (SSE) =========================== */
function disconnectStream() {
  if (state.es) {
    try { state.es.close(); } catch {}
    state.es = null;
    state.live = false;
    paintStatus();
  }
}

function connectStream() {
  disconnectStream();
  if (!state.token) return;
  const es = new EventSource('/api/v1/ui/stream?token=' + encodeURIComponent(state.token));
  state.es = es;

  es.onopen = () => {
    state.live = true;
    state.lastEvent = Date.now();
    paintStatus();
  };

  es.onerror = () => {
    state.live = false;
    paintStatus();
  };

  const events = [
    'ping', 'appointment.created', 'appointment.cancelled',
    'emergency.triggered', 'provider.updated', 'notification.new',
    'token.called', 'token.terminated', 'token.updated', 'token.rescheduled',
    'token.waitlisted', 'buffer.expired', 'data.reset'
  ];

  events.forEach((t) => es.addEventListener(t, (e) => onEvent(t, JSON.parse(e.data))));
}

// Disconnect background tabs so they do not exhaust the browser's 6-connection HTTP/1.1 pool per host
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    disconnectStream();
  } else {
    if (state.user && state.token && !state.es) {
      connectStream();
      scheduleRefresh();
    }
  }
});

window.addEventListener('beforeunload', () => {
  disconnectStream();
});

function onEvent(type, ev) {
  state.live = true;
  state.lastEvent = Date.now();
  paintStatus();

  if (type === 'ping') return;

  if (type === 'token.called') {
    toast(`📢 Token #${ev.token_number} (${ev.patient_name}) called! 2-minute availability check started.`, 'info', 7000);
  } else if (type === 'token.terminated') {
    toast(`✅ Token #${ev.terminated_token} checkup completed and terminated by Admin.`, 'info');
  } else if (type === 'emergency.triggered') {
    $('#global-emergency-banner').hidden = false;
    toast(`🚨 EMERGENCY: ${ev.patient_name} assigned FIRST PRIORITY for ${ev.provider_name}!`, 'warn', 9000);
  } else if (type === 'buffer.expired') {
    toast(`⚠️ 2-Minute availability buffer expired for Token #${ev.token_number}! Admin action needed.`, 'warn', 8000);
  } else if (type === 'data.reset') {
    $('#global-emergency-banner').hidden = true;
    toast('Queue data has been reset.', 'info');
  }

  scheduleRefresh();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.view === 'book' && state.reloadCalendar) state.reloadCalendar();
    else if (state.view) showView(state.view, true);
  }, 350);
}

function paintStatus() {
  const stale = !state.live || Date.now() - state.lastEvent > 30000;
  const text = stale ? 'Connecting...' : `Live Queue Connected (${new Date().toLocaleTimeString()})`;
  const el = $('#status');
  if (el) {
    el.textContent = text;
    el.classList.toggle('stale', stale);
  }
}
setInterval(() => state.user && paintStatus(), 2000);

/* =========================== 4. 2-MINUTE BUFFER TIMER TICKER =========================== */
setInterval(() => {
  document.querySelectorAll('[data-buffer-ends]').forEach((el) => {
    const ends = Number(el.dataset.bufferEnds);
    if (!ends) return;

    const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
    const mins = Math.floor(left / 60);
    const secs = left % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const txtEl = el.querySelector('.timer-countdown');
    if (txtEl) txtEl.textContent = timeStr;

    const progEl = el.querySelector('.timer-progress-bar');
    if (progEl) {
      const pct = Math.max(0, Math.min(100, (left / 120) * 100));
      progEl.style.width = pct + '%';
      if (left < 30) progEl.style.backgroundColor = 'var(--red)';
      else if (left < 60) progEl.style.backgroundColor = 'var(--amber)';
    }

    if (left === 0) {
      el.classList.add('expired-buffer');
      const statEl = el.querySelector('.timer-status-text');
      if (statEl) statEl.textContent = '⚠️ Patient Not Available / Buffer Expired';
    }
  });
}, 500);

/* =========================== 5. VIEWS IMPLEMENTATION =========================== */

/* ---------- 5.1 LIVE DASHBOARD (Patient, Doctor, Admin) ---------- */
async function viewDashboard() {
  const data = await api('GET', '/api/v1/ui/dashboard');
  const role = state.user.role;
  const isAdmin = role === 'ADMIN';
  const isDoc = role === 'PROVIDER';
  const isPatient = role === 'PATIENT';

  // Synchronize Emergency Banner (Fixes Issue 2: hides banner when emergency is finished)
  const emergencyBanner = $('#global-emergency-banner');
  if (emergencyBanner) {
    emergencyBanner.hidden = !data.has_active_emergency;
  }

  let html = '';

  // 1. PATIENT HERO CARD
  if (isPatient) {
    const my = data.patient_active_token;
    if (my) {
      const isMyTurn = my.ongoing_token === my.my_token_number;
      const inConsult = my.is_in_consultation;
      const isCalled = my.buffer_active;

      html += `
        <div class="card active-token-hero ${isMyTurn ? 'my-turn-hero' : ''}">
          <div class="hero-header">
            <div>
              <span class="badge ${inConsult ? 'IN_CONSULTATION' : isCalled ? 'EMERGENCY' : 'CONFIRMED'}">
                ${inConsult ? '🩺 CONSULTATION IN PROGRESS' : isCalled ? '📢 YOUR TOKEN HAS BEEN CALLED!' : 'Active Today'}
              </span>
              <h2>${esc(my.doctor_name)}</h2>
              <p class="muted">${esc(my.service)} • Ref: <strong>${esc(my.reference)}</strong></p>
            </div>
            <button class="btn small" id="view-my-slip" type="button">📄 View Token Pass</button>
          </div>

          <div class="token-comparison-grid">
            <div class="token-stat-box current-token-box">
              <span class="token-label">DOCTOR'S ONGOING TOKEN</span>
              <div class="token-number-hero">${my.ongoing_token ? '#' + my.ongoing_token : 'IDLE'}</div>
              <span class="token-sub">${my.ongoing_token ? (inConsult ? 'Consultancy going on' : 'Patient being called') : 'Doctor ready'}</span>
            </div>

            <div class="token-stat-box your-token-box">
              <span class="token-label">YOUR TOKEN NUMBER</span>
              <div class="token-number-hero highlight">#${my.my_token_number}</div>
              <span class="token-sub">${isMyTurn ? (inConsult ? '👉 IN ROOM NOW' : '👉 PLEASE ENTER ROOM NOW') : `${my.tokens_ahead} token(s) ahead of you`}</span>
            </div>
          </div>

          <!-- Availability Buffer Alert vs Consultation Banner (Req 2) -->
          ${isCalled ? `
            <div class="alert-pulse-box">
              ⏰ <strong>YOUR TOKEN IS CALLED! 2-MINUTE REPORTING WINDOW:</strong>
              Please report to the doctor's room immediately to be marked present.
            </div>` : ''}

          ${inConsult ? `
            <div class="consultation-banner">
              🩺 <strong>CONSULTANCY GOING ON:</strong> Your checkup with ${esc(my.doctor_name)} is currently in progress.
            </div>` : ''}

          <div class="token-footer-info">
            <span>⏱️ <strong>Estimated Wait:</strong> approx. ${my.estimated_wait_minutes} mins</span>
            <span>📌 <strong>Current Status:</strong> ${badge(my.state)}</span>
          </div>
        </div>`;
    } else {
      html += `
        <div class="card welcome-hero">
          <div class="welcome-icon">👋</div>
          <div>
            <h2>Hello, ${esc(state.user.name)}!</h2>
            <p class="muted">You don't have an active token right now. Book an appointment to get your daily sequential token number.</p>
          </div>
          <a class="btn primary lg-btn" href="#/book">📅 Book Doctor Token Now</a>
        </div>`;
    }
  }

  // 2. CLINIC METRICS (Doctor & Admin)
  if (!isPatient) {
    const t = data.totals;
    html += `
      <div class="grid">
        <div class="stat"><div class="num">${t.active_tokens}</div>Active Tokens Waiting</div>
        <div class="stat red"><div class="num">${t.emergencies}</div>Emergencies Prioritized</div>
        <div class="stat green"><div class="num">${t.completed}</div>Completed & Terminated</div>
        <div class="stat amber"><div class="num">${t.waitlisted}</div>Waitlisted Patients</div>
      </div>`;
  }

  // Admin Development Reset Bar (Req 3: Resets queue only, keeps login credentials intact)
  if (isAdmin) {
    html += `
      <div class="card dev-bar">
        <div>
          <strong>🛠️ Testing & Development Tools:</strong>
          <span class="muted small-note">Reset queue, active tokens and appointments back to clean state. (All user accounts and login passwords stay safe).</span>
        </div>
        <button class="btn small danger" id="dev-reset-btn" type="button">🔄 Reset Queue & Token Data</button>
      </div>`;
  }

  // 3. DOCTORS TOKEN STATIONS (Admin & Doctor controls)
  html += `<h2>🏥 Clinic Doctor Stations & Ongoing Tokens</h2><div class="doc-stations-grid">`;
 console.log(
      "data",data
    );
  data.doctors.forEach((doc) => {
    if (isDoc && state.user.provider_id !== doc.provider_id) return;
   
    const hasOngoing = doc.current_token !== null;
    const buf = doc.buffer;
    const isWaiting = buf && buf.status === 'WAITING_PATIENT';
    const isInConsult = buf && buf.status === 'IN_CONSULTATION';
    const isBufExpired = buf && (buf.is_expired || buf.status === 'BUFFER_EXPIRED');

    html += `
      <div class="card doctor-station-card ${hasOngoing ? 'active-station' : ''}">
        <div class="station-top">
          <div>
            <h3>${esc(doc.name)}</h3>
            <span class="muted">${esc(doc.service)} • ${badge(doc.status)}</span>
          </div>
          <div class="token-capacity-tag">
            <span>Daily Cap: <strong>${doc.daily_token_limit}</strong></span>
            ${isAdmin || (isDoc && state.user.provider_id === doc.provider_id) ? `
              <button class="btn-link" data-edit-limit="${doc.provider_id}" data-current-limit="${doc.daily_token_limit}" title="Change daily token capacity">⚙️ Edit</button>
            ` : ''}
          </div>
        </div>

        <!-- ONGOING TOKEN DISPLAY (Req 1.b) -->
        <div class="ongoing-token-display">
          <div class="ongoing-label">ONGOING TOKEN</div>
          <div class="ongoing-number ${hasOngoing ? 'live-pulse' : 'idle-token'}">
            ${hasOngoing ? (doc.current_appointment?.type === 'EMERGENCY' ? '🚨 EM' : '#' + doc.current_token) : 'IDLE'}
          </div>
          <div class="ongoing-patient">
            ${hasOngoing && doc.current_appointment ? `
              <strong>${esc(doc.current_appointment.patient_name)}</strong> (${esc(doc.current_appointment.patient_code || '')})
              <div class="muted small-note">${esc(doc.current_appointment.reason || '')}</div>
            ` : '<span class="muted">No patient in room</span>'}
          </div>
        </div>

        <!-- 2-MINUTE BUFFER AVAILABILITY CHECK (Req 2 & 3) -->
        ${isWaiting ? `
          <div class="buffer-timer-container ${isBufExpired ? 'buffer-expired' : ''}" data-buffer-ends="${buf.ends_at}">
            <div class="timer-header">
              <span>⏳ 2-Min Availability Check:</span>
              <strong class="timer-countdown">--:--</strong>
            </div>
            <div class="timer-progress-track">
              <div class="timer-progress-bar"></div>
            </div>
            <div class="timer-status-text">
              ${isBufExpired ? '⚠️ Patient Not Available / Buffer Expired' : 'Waiting for patient to report to room'}
            </div>

            <!-- Admin Actions during 2-min check -->
            ${(isAdmin || (isDoc && state.user.provider_id === doc.provider_id)) ? `
              <div class="buffer-actions">
                <button class="btn small primary" data-act="mark-present" data-doc="${doc.provider_id}">✅ Mark Present</button>
                ${isAdmin ? `
                  <button class="btn small" data-act="reschedule-absent" data-doc="${doc.provider_id}">🔄 Reschedule</button>
                  <button class="btn small danger" data-act="waitlist-absent" data-doc="${doc.provider_id}">⏸️ Put in Waitlist</button>
                ` : ''}
              </div>` : ''}
          </div>
        ` : ''}

        <!-- Once marked present -> CONSULTANCY GOING ON (No timer! Req 2) -->
        ${isInConsult ? `
          <div class="consultancy-active-box">
            <span class="consultancy-pulse-dot"></span>
            <div>
              <strong>🩺 Consultancy Going On</strong>
              <p class="muted small-note">Patient is present in room. Checkup underway.</p>
            </div>
          </div>
        ` : ''}

        <!-- QUEUE CONTROLS (Admin Controlled - Fixes Issue 1) -->
        ${(isAdmin || (isDoc && state.user.provider_id === doc.provider_id)) ? `
          <div class="station-actions">
            <button class="btn primary" data-act="call-next" data-doc="${doc.provider_id}" ${hasOngoing && isWaiting ? 'disabled title="Wait for availability check or mark present"' : ''}>
              🟢 Call Next Token
            </button>
            <button class="btn danger" data-act="terminate-token" data-doc="${doc.provider_id}" ${!hasOngoing ? 'disabled' : ''}>
              🛑 Terminate & Complete Token
            </button>
          </div>
        ` : ''}

        <div class="station-stats-row">
          <span>Total Booked: <strong>${doc.booked_today}</strong></span>
          <span>Completed: <strong>${doc.completed_today}</strong></span>
          <span>Capacity Remaining: <strong>${doc.remaining_today}</strong></span>
        </div>

        ${doc.next_token_in_line ? `
          <div class="next-token-preview">
            ⏭️ <strong>Next in Queue:</strong> Token #${doc.next_token_in_line.token_number} (${esc(doc.next_token_in_line.patient_name)})
            ${doc.next_token_in_line.type === 'EMERGENCY' ? badge('EMERGENCY') : ''}
          </div>
        ` : '<div class="next-token-preview muted">No more tokens waiting in queue</div>'}

        <!-- Full Queue List Preview for this doctor -->
        ${doc.pending_queue && doc.pending_queue.length > 1 ? `
          <div class="pending-queue-list">
            <small class="muted"><strong>Remaining Queue (${doc.pending_queue.length} waiting):</strong></small>
            <div class="queue-chips">
              ${doc.pending_queue.map((q) => `
                <span class="queue-chip ${q.type === 'EMERGENCY' ? 'chip-emergency' : ''}">
                  ${q.type === 'EMERGENCY' ? '🚨 EM' : '#' + q.token_number} (${esc(q.patient_name)})
                </span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>`;
  });

  html += `</div>`;

  // Recent Alerts
  if (data.alerts && data.alerts.length) {
    html += `
      <div class="card">
        <h3>🔔 Recent Queue Alerts</h3>
        <ul class="shift">
          ${data.alerts.map((a) => `
            <li>
              <span>${badge(a.level.toUpperCase())} ${esc(a.message)}</span>
              <span class="muted small-note">${fmtTime(a.at)}</span>
            </li>`).join('')}
        </ul>
      </div>`;
  }

  const after = (el) => {
    // Reset Data Button listener (Req 3)
    const resetBtn = el.querySelector('#dev-reset-btn');
    if (resetBtn) {
      resetBtn.onclick = async () => {
        if (confirm('Are you sure you want to reset all appointment and token queue data? All login accounts will remain safe.')) {
          resetBtn.disabled = true;
          try {
            await api('POST', '/api/v1/ui/dev/reset-data');
            toast('Queue data has been completely reset to clean state.');
            showView('dashboard', true);
          } catch (ex) {
            toast(ex.message, 'error');
          } finally {
            resetBtn.disabled = false;
          }
        }
      };
    }

    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      const editLimit = e.target.closest('button[data-edit-limit]');
      const viewSlip = e.target.closest('#view-my-slip');

      if (viewSlip && data.patient_active_token) {
        showTokenSlip(data.patient_active_token);
        return;
      }

      if (editLimit) {
        openTokenLimitDialog(editLimit.dataset.editLimit, editLimit.dataset.currentLimit);
        return;
      }

      if (!btn) return;
      const act = btn.dataset.act;
      const docId = btn.dataset.doc;

      try {
        if (act === 'call-next') {
          btn.disabled = true;
          await api('POST', '/api/v1/ui/tokens/call-next', { provider_id: docId });
          toast('Next token called. 2-minute availability check started.', 'info');
          showView('dashboard', true);
        } else if (act === 'terminate-token') {
          if (confirm('Terminate checkup for this patient? Token will be archived and next token can be called.')) {
            btn.disabled = true;
            await api('POST', '/api/v1/ui/tokens/terminate', { provider_id: docId });
            toast('Token terminated. Ready for next patient.', 'info');
            showView('dashboard', true);
          }
        } else if (act === 'mark-present') {
          await api('POST', '/api/v1/ui/tokens/mark-present', { provider_id: docId });
          toast('Patient present! Consultancy started (Consultancy Going On).', 'info');
          showView('dashboard', true);
        } else if (act === 'reschedule-absent') {
          await api('POST', '/api/v1/ui/tokens/reschedule-absent', { provider_id: docId });
          toast('Absent patient rescheduled to end of queue.', 'warn');
          showView('dashboard', true);
        } else if (act === 'waitlist-absent') {
          await api('POST', '/api/v1/ui/tokens/waitlist-absent', { provider_id: docId });
          toast('Absent patient moved to waitlist.', 'warn');
          showView('dashboard', true);
        }
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  };

  return { html, after };
}

/* ---------- 5.2 BOOK APPOINTMENT WITH TOKEN SYSTEM (Req 1.a) ---------- */
async function viewBook() {
  const provs = await api('GET', '/api/v1/ui/providers');
  const activeProvs = provs.filter((p) => p.status === 'ACTIVE');
  const today = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const dStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  let selectedDocId = activeProvs[0]?.provider_id || provs[0]?.provider_id;
  let selectedDate = dStr(today);
  let calData = null;
  let currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const html = `
    <div class="card">
      <label for="book-doc-select"><strong>Select Consulting Doctor</strong></label>
      <select id="book-doc-select">
        ${provs.map((p) => `
          <option value="${p.provider_id}" ${p.provider_id === selectedDocId ? 'selected' : ''}>
            ${esc(p.name)} — ${esc(p.service)} (Daily Limit: ${p.daily_token_limit || 30} tokens) ${p.status !== 'ACTIVE' ? '(On Leave)' : ''}
          </option>`).join('')}
      </select>
    </div>

    <div class="book-grid">
      <!-- CALENDAR PANEL (Preserved as requested in Req 1.a) -->
      <div class="card" id="cal-container">
        <p class="muted">Loading calendar...</p>
      </div>

      <!-- TOKEN SUMMARY PANEL -->
      <div class="card" id="token-info-container">
        <h2 id="token-panel-title">Token Details for Selected Date</h2>
        <div id="token-panel-body">
          <p class="muted">Pick a date from the calendar to check token availability.</p>
        </div>
      </div>
    </div>

    <!-- BOOKING CONFIRMATION FORM -->
    <form class="card" id="token-book-form" hidden novalidate>
      <h2>Confirm Token Booking</h2>
      <div class="token-preview-badge" id="token-preview-box"></div>
      <div class="form-group">
        <label for="book-reason">Reason for Consultation</label>
        <textarea id="book-reason" maxlength="200" placeholder="e.g. Regular health checkup, fever, consultation..." required></textarea>
      </div>
      <p id="book-err" class="form-error" role="alert"></p>
      <button class="btn primary lg-btn" id="confirm-book-btn" type="submit">Confirm & Book Token</button>
    </form>`;

  const after = (el) => {
    const docSelect = el.querySelector('#book-doc-select');

    const renderCalendar = () => {
      const box = $('#cal-container');
      if (!box || !calData) return;

      const dateMap = {};
      calData.dates.forEach((d) => { dateMap[d.date] = d; });

      const y = currentMonth.getFullYear();
      const mo = currentMonth.getMonth();
      const firstDay = new Date(y, mo, 1).getDay();
      const totalDays = new Date(y, mo + 1, 0).getDate();

      let cells = '<div class="cal-pad"></div>'.repeat(firstDay);
      for (let day = 1; day <= totalDays; day++) {
        const key = `${y}-${pad2(mo + 1)}-${pad2(day)}`;
        const info = dateMap[key];
        const isPast = new Date(key + 'T23:59:59') < today;

        let cls = 'out';
        let sub = 'N/A';
        let disabled = true;

        if (info && !isPast) {
          if (info.status === 'MINE') {
            cls = 'many today';
            sub = `Token #${info.user_token}`;
            disabled = false;
          } else if (info.status === 'FULL') {
            cls = 'none';
            sub = 'Full';
            disabled = true;
          } else if (info.status === 'UNAVAILABLE') {
            cls = 'none';
            sub = 'Leave';
            disabled = true;
          } else {
            cls = info.remaining_tokens <= 5 ? 'few' : 'many';
            sub = `${info.remaining_tokens} left`;
            disabled = false;
          }
        }

        const isSelected = selectedDate === key;
        cells += `
          <button type="button" class="day-btn ${cls} ${isSelected ? 'selected-date' : ''} ${key === dStr(today) ? 'today-highlight' : ''}"
            data-date="${key}" ${disabled ? 'disabled' : ''} aria-pressed="${isSelected}">
            <span class="dn">${day}</span>
            <span class="ds">${sub}</span>
          </button>`;
      }

      box.innerHTML = `
        <div class="cal-head">
          <button type="button" class="btn small" id="prev-month">Previous</button>
          <h2 id="cal-month-title">${currentMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2>
          <button type="button" class="btn small" id="next-month">Next</button>
        </div>
        <div class="cal-grid">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells}
        </div>
        <div class="legend">
          <span><i class="lg many"></i>Tokens Available</span>
          <span><i class="lg few"></i>Few Left</span>
          <span><i class="lg none"></i>Full / Unavailable</span>
        </div>`;
    };

    const renderTokenInfo = async () => {
      const infoBox = $('#token-panel-body');
      const formBox = $('#token-book-form');
      if (!infoBox) return;

      try {
        const info = await api('GET', `/api/v1/ui/tokens/date-info?provider_id=${selectedDocId}&date=${selectedDate}`);
        $('#token-panel-title').textContent = `Tokens for ${fmtDate(selectedDate + 'T00:00:00')}`;

        if (info.status !== 'ACTIVE') {
          infoBox.innerHTML = `<div class="empty">Doctor is on leave on this date. Please pick another date or doctor.</div>`;
          formBox.hidden = true;
          return;
        }

        if (info.is_full) {
          infoBox.innerHTML = `
            <div class="err-box">
              <strong>All tokens are booked for this date!</strong>
              <p>Daily token limit of ${info.daily_token_limit} tokens reached. Please select another date.</p>
            </div>`;
          formBox.hidden = true;
          return;
        }

        infoBox.innerHTML = `
          <div class="token-summary-card">
            <div class="token-stat-item">
              <span class="muted">Daily Capacity:</span>
              <strong>${info.daily_token_limit} Tokens</strong>
            </div>
            <div class="token-stat-item">
              <span class="muted">Already Booked:</span>
              <strong>${info.booked_count} Tokens</strong>
            </div>
            <div class="token-stat-item">
              <span class="muted">Tokens Remaining:</span>
              <strong class="green-text">${info.remaining_count} Available</strong>
            </div>
          </div>
          <div class="next-assigned-box">
            <span>YOUR ASSIGNED TOKEN WILL BE:</span>
            <div class="assigned-number">TOKEN #${info.next_token_number}</div>
            <p class="muted small-note">Tokens are called sequentially by the Admin. You will receive live updates when called.</p>
          </div>`;

        $('#token-preview-box').innerHTML = `
          <strong>Booking Token #${info.next_token_number}</strong> with ${esc(calData.provider.name)} on ${fmtDate(selectedDate + 'T00:00:00')}`;
        $('#confirm-book-btn').textContent = `Confirm & Book Token #${info.next_token_number}`;
        formBox.hidden = false;
      } catch (e) {
        showError(infoBox, e);
        formBox.hidden = true;
      }
    };

    state.reloadCalendar = async () => {
      try {
        calData = await api('GET', `/api/v1/ui/calendars?provider_id=${selectedDocId}&days=60`);
        renderCalendar();
        renderTokenInfo();
      } catch (err) {
        showError($('#cal-container'), err, state.reloadCalendar);
      }
    };

    docSelect.addEventListener('change', () => {
      selectedDocId = docSelect.value;
      state.reloadCalendar();
    });

    el.querySelector('#cal-container').addEventListener('click', (e) => {
      const prev = e.target.closest('#prev-month');
      const next = e.target.closest('#next-month');
      const dayBtn = e.target.closest('.day-btn');

      if (prev) {
        currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
        renderCalendar();
      } else if (next) {
        currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
        renderCalendar();
      } else if (dayBtn && !dayBtn.disabled) {
        selectedDate = dayBtn.dataset.date;
        renderCalendar();
        renderTokenInfo();
      }
    });

    el.querySelector('#token-book-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#confirm-book-btn');
      const err = $('#book-err');
      const reason = $('#book-reason').value.trim();

      err.textContent = '';
      if (reason.length < 3) {
        err.textContent = 'Please enter a short reason for visit.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Allocating Token...';

      try {
        // one Idempotency-Key per doctor+date attempt: a retry of the same click can never create a second booking
        state.bookKeys = state.bookKeys || {};
        const bookKeyId = selectedDocId + '|' + selectedDate;
        const idemKey = state.bookKeys[bookKeyId] || (state.bookKeys[bookKeyId] = uid());
        const appt = await api('POST', '/api/v1/ui/appointments', {
          provider_id: selectedDocId,
          date: selectedDate,
          reason
        }, { 'Idempotency-Key': idemKey });
        delete state.bookKeys[bookKeyId];

        toast(`✅ Token #${appt.token_number} booked successfully for ${fmtDate(appt.date)}!`);
        showTokenSlip(appt);
        location.hash = '#/dashboard';
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    });

    state.reloadCalendar();
  };

  return { html, after };
}

/* ---------- 5.3 ALL APPOINTMENTS & TOKENS ---------- */
async function viewAppointments() {
  const list = await api('GET', '/api/v1/ui/appointments');
  const role = state.user.role;
  const staff = role !== 'PATIENT';

  const rows = list.map((a) => {
    const isEmerg = a.type === 'EMERGENCY' || a.is_emergency;
    const isServ = a.state === 'IN_CONSULTATION' || a.state === 'CALLED';
    const isComp = a.state === 'COMPLETED';

    return `
      <tr>
        <td><strong>${esc(a.reference)}</strong></td>
        <td>
          <span class="token-pill ${isEmerg ? 'EMERGENCY' : ''}">
            ${isEmerg ? '🚨 EMERGENCY' : 'Token #' + a.token_number}
          </span>
        </td>
        <td>${fmtDate(a.date || a.start)}</td>
        <td>${esc(a.provider_name)}<div class="muted small-note">${esc(a.service)}</div></td>
        ${staff ? `<td>${esc(a.patient_name)}<div class="muted small-note">${esc(a.patient_code || a.patient_phone || '')}</div></td>` : ''}
        <td>${badge(a.state)}</td>
        <td>
          <div class="actions">
            <button class="btn small" data-act="slip" data-id="${a.appointment_id}" type="button">Pass</button>
            ${role === 'ADMIN' && isServ ? `
              <button class="btn small danger" data-act="terminate" data-doc="${a.provider_id}" type="button">Terminate</button>
            ` : ''}
            ${role === 'PATIENT' && (a.state === 'CONFIRMED' || a.state === 'RESCHEDULED') ? `
              <button class="btn small" data-act="remind" data-id="${a.appointment_id}" type="button">Remind me</button>
            ` : ''}
            ${!isComp && a.state !== 'CANCELLED' ? `
              <button class="btn small danger" data-act="cancel" data-id="${a.appointment_id}" type="button">Cancel</button>
            ` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  const html = list.length ? `
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Token</th>
            <th>Date</th>
            <th>Doctor</th>
            ${staff ? '<th>Patient</th>' : ''}
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` :
    `<div class="card empty">No token appointments found. Use "Book Doctor Token" to make one.</div>`;

  const after = (el) => {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;

      const act = b.dataset.act;
      const id = b.dataset.id;
      const doc = b.dataset.doc;

      if (act === 'slip') {
        const appt = list.find((x) => x.appointment_id === id);
        if (appt) showTokenSlip(appt);
      } else if (act === 'terminate') {
        if (confirm('Terminate checkup for this patient?')) {
          await api('POST', '/api/v1/ui/tokens/terminate', { provider_id: doc });
          toast('Token terminated.');
          showView('appointments', true);
        }
      } else if (act === 'remind') {
        const ans = prompt('Remind me how many minutes before my turn?\nChoose 15, 30, 60, 120 or 1440 (one day).', '60');
        if (ans === null) return;
        try {
          const r = await api('POST', `/api/v1/ui/appointments/${id}/reminders`, { minutes_before: Number(ans) });
          toast(`⏰ Reminder set for ${new Date(r.due_at).toLocaleString('en-IN')}.`);
        } catch (ex) {
          toast(ex.message, 'error');
        }
      } else if (act === 'cancel') {
        if (confirm('Cancel this token appointment?')) {
          await api('POST', `/api/v1/ui/appointments/${id}/cancel`);
          toast('Appointment cancelled.');
          showView('appointments', true);
        }
      }
    });
  };

  return { html, after };
}

/* ---------- 5.4 EMERGENCY PRIORITY TOKEN (Req 4) ---------- */
async function viewEmergency() {
  const provs = (await api('GET', '/api/v1/ui/providers')).filter((p) => p.status === 'ACTIVE');
  const isAdmin = state.user.role === 'ADMIN';

  const html = `
    <div class="card emergency">
      <h2>🚨 Request Emergency Priority Token</h2>
      <p class="muted">
        Emergency tokens receive <strong>FIRST PRIORITY</strong> and immediately jump to the top of the queue.
      </p>

      <form id="em-form" novalidate>
        <div class="form-group">
          <label for="em-prov">Consulting Doctor</label>
          <select id="em-prov">
            ${provs.map((p) => `<option value="${p.provider_id}">${esc(p.name)}, ${esc(p.service)}</option>`).join('')}
          </select>
        </div>

        ${isAdmin ? `
          <div class="form-group">
            <label for="em-name">Patient Full Name (Walk-in Emergency)</label>
            <input id="em-name" autocomplete="off" placeholder="e.g. Ramesh Kumar" required>
          </div>
          <div class="form-group">
            <label for="em-phone">Patient 10-Digit Mobile Number</label>
            <input id="em-phone" inputmode="numeric" placeholder="9876543210" required>
          </div>
        ` : ''}

        <div class="form-group">
          <label for="em-reason">Describe Emergency Condition</label>
          <textarea id="em-reason" maxlength="200" placeholder="e.g. Severe chest pain, breathing difficulty..." required></textarea>
        </div>

        <label class="checkline">
          <input type="checkbox" id="em-confirm">
          I confirm this is an authentic medical emergency requiring immediate priority.
        </label>

        <p id="em-msg" class="form-error" role="alert"></p>
        <button class="btn danger block lg-btn" id="em-btn" type="submit">🚨 Issue Emergency Priority Token</button>
      </form>
    </div>
    <div id="em-result"></div>`;

  const after = (el) => {
    el.querySelector('#em-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#em-msg');
      const btn = $('#em-btn');
      const reason = $('#em-reason').value.trim();

      msg.textContent = '';
      if (reason.length < 3) { msg.textContent = 'Please describe the emergency condition.'; return; }
      if (!$('#em-confirm').checked) { msg.textContent = 'Please tick the confirmation checkbox.'; return; }

      btn.disabled = true;
      btn.textContent = 'Issuing Emergency Token...';

      try {
        const body = {
          provider_id: $('#em-prov').value,
          reason,
          patient_name: isAdmin ? $('#em-name').value : undefined,
          patient_phone: isAdmin ? $('#em-phone').value : undefined
        };

        const res = await api('POST', '/api/v1/ui/emergency', body);
        $('#em-form').reset();
        $('#em-result').innerHTML = `
          <div class="card emergency">
            <h2>🚨 Emergency Priority Token Activated!</h2>
            <p>
              Patient <strong>${esc(res.appointment.patient_name)}</strong> has been registered with <strong>FIRST PRIORITY</strong> for ${esc(res.provider.name)}.
            </p>
            <p>Reference: <strong>${esc(res.appointment.reference)}</strong></p>
            <p class="muted">When Admin calls the next token, this emergency case will be called first.</p>
          </div>`;
        toast('Emergency token registered with first priority!', 'warn');
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '🚨 Issue Emergency Priority Token';
      }
    });
  };

  return { html, after };
}

/* ---------- 5.5 DOCTORS & DAILY CAPACITY MANAGEMENT (Req 5) ---------- */
async function viewProviders() {
  const provs = await api('GET', '/api/v1/ui/providers');
  const isAdmin = state.user.role === 'ADMIN';

  const html = `
    ${isAdmin ? `
      <form class="card" id="add-doc-form" novalidate>
        <h2>Add New Doctor</h2>
        <div class="form-grid">
          <div><label for="doc-name">Doctor Name</label><input id="doc-name" placeholder="Dr. John Smith" required></div>
          <div><label for="doc-service">Specialty</label><input id="doc-service" placeholder="Cardiology" required></div>
          <div><label for="doc-email">Login Email</label><input id="doc-email" type="email" placeholder="smith@careslot.com" required></div>
          <div><label for="doc-password">Password</label><input id="doc-password" type="password" placeholder="Doctor@123" required></div>
          <div><label for="doc-limit">Daily Token Limit (Default: 30)</label><input id="doc-limit" type="number" value="30" min="5" max="300" required></div>
        </div>
        <p id="doc-err" class="form-error" role="alert"></p>
        <button class="btn primary" id="add-doc-btn" type="submit">Add Doctor</button>
      </form>` : ''}

    <div class="card table-wrap">
      <h2>Active Clinic Doctors & Token Capacities</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Specialty</th>
            <th>Daily Token Capacity</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${provs.map((p) => `
            <tr>
              <td><strong>${esc(p.provider_id)}</strong></td>
              <td>${esc(p.name)}</td>
              <td>${esc(p.service)}</td>
              <td>
                <strong>${p.daily_token_limit || 30} tokens / day</strong>
                <button class="btn small" data-edit-cap="${p.provider_id}" data-cap="${p.daily_token_limit || 30}">Change</button>
              </td>
              <td>${badge(p.status)}</td>
              <td>
                ${isAdmin ? `
                  <button class="btn small" data-toggle-status="${p.provider_id}" data-status="${p.status === 'ACTIVE' ? 'ON_LEAVE' : 'ACTIVE'}">
                    ${p.status === 'ACTIVE' ? 'Mark On Leave' : 'Mark Active'}
                  </button>` : 'View only'}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const after = (el) => {
    const addForm = el.querySelector('#add-doc-form');
    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#doc-err');
        const btn = $('#add-doc-btn');
        err.textContent = '';
        btn.disabled = true;

        try {
          await api('POST', '/api/v1/ui/providers', {
            name: $('#doc-name').value,
            service: $('#doc-service').value,
            email: $('#doc-email').value,
            password: $('#doc-password').value,
            daily_token_limit: Number($('#doc-limit').value) || 30
          });
          toast('Doctor added successfully with daily token quota.');
          showView('providers');
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          btn.disabled = false;
        }
      });
    }

    el.addEventListener('click', async (e) => {
      const capBtn = e.target.closest('button[data-edit-cap]');
      const statusBtn = e.target.closest('button[data-toggle-status]');

      if (capBtn) {
        openTokenLimitDialog(capBtn.dataset.editCap, capBtn.dataset.cap);
      } else if (statusBtn) {
        await api('PATCH', `/api/v1/ui/providers/${statusBtn.dataset.toggleStatus}`, { status: statusBtn.dataset.status });
        toast('Doctor status updated.');
        showView('providers', true);
      }
    });
  };

  return { html, after };
}

/* ---------- 5.6 NOTIFICATIONS VIEW ---------- */
async function viewNotifications() {
  const list = await api('GET', '/api/v1/ui/notifications');
  const html = list.length ? `
    <div class="card">
      <h2>Queue Notifications & Buffer Alerts</h2>
      <ul class="shift">
        ${list.map((n) => `
          <li>
            <span>${esc(n.message)}</span>
            <div class="muted small-note">${fmtDT(n.at)}</div>
          </li>`).join('')}
      </ul>
    </div>` :
    `<div class="card empty">No notifications yet. Live updates will appear here.</div>`;
  return { html };
}

/* ---------- 5.7 PATIENT DIRECTORY (Admin) ---------- */
async function viewPatients() {
  const html = `
    <div class="card">
      <label for="pq">Search Patients</label>
      <input id="pq" placeholder="Search by name, patient ID, phone or email..." autocomplete="off">
    </div>
    <div class="card table-wrap" id="ptable"><p class="muted">Loading patient directory...</p></div>`;

  const after = (el) => {
    const load = async () => {
      const box = $('#ptable');
      const q = $('#pq').value.trim();
      try {
        const list = await api('GET', `/api/v1/ui/patients?q=${encodeURIComponent(q)}`);
        box.innerHTML = list.length ? `
          <table>
            <thead>
              <tr><th>Patient ID</th><th>Name</th><th>Mobile</th><th>Email</th><th>Total Appointments</th></tr>
            </thead>
            <tbody>
              ${list.map((p) => `
                <tr>
                  <td><strong>${esc(p.patient_code)}</strong></td>
                  <td>${esc(p.name)}</td>
                  <td>${esc(p.phone || '-')}</td>
                  <td>${esc(p.email || '-')}</td>
                  <td>${p.appointments}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty">No patients found.</div>';
      } catch (err) {
        showError(box, err, load);
      }
    };

    let timer;
    el.querySelector('#pq').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    load();
  };

  return { html, after };
}

/* ---------- 5.8 MY PROFILE ---------- */
async function viewProfile() {
  const me = await api('GET', '/api/v1/ui/me');
  const isPatient = me.role === 'PATIENT';

  const html = `
    <div class="card">
      <h2>My Account Profile</h2>
      <dl class="kv">
        <dt>Role</dt><dd><strong>${esc(me.role)}</strong></dd>
        ${me.patient_code ? `<dt>Patient ID</dt><dd><strong>${esc(me.patient_code)}</strong></dd>` : ''}
        ${me.provider_id ? `<dt>Doctor ID</dt><dd><strong>${esc(me.provider_id)}</strong></dd>` : ''}
        <dt>Full Name</dt><dd>${esc(me.name)}</dd>
        <dt>Email</dt><dd>${esc(me.email || '-')}</dd>
        <dt>Mobile</dt><dd>${esc(me.phone || '-')}</dd>
      </dl>
    </div>
    ${isPatient ? `
      <form class="card" id="edit-profile-form" novalidate>
        <h2>Update Contact Details</h2>
        <div class="form-group">
          <label for="pf-name">Full Name</label>
          <input id="pf-name" value="${esc(me.name)}" required>
        </div>
        <div class="form-group">
          <label for="pf-phone">Mobile Number</label>
          <input id="pf-phone" value="${esc(me.phone || '')}" inputmode="numeric" required>
        </div>
        <button class="btn primary" type="submit">Save Changes</button>
      </form>` : ''}`;

  const after = (el) => {
    const f = el.querySelector('#edit-profile-form');
    if (f) {
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const u = await api('PATCH', '/api/v1/ui/me', {
            name: $('#pf-name').value,
            phone: $('#pf-phone').value
          });
          state.user = { ...state.user, ...u };
          $('#user-name').textContent = u.name;
          toast('Profile details updated.');
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
    }
  };

  return { html, after };
}

/* =========================== 6. MODALS & DIALOGS =========================== */

function showTokenSlip(appt) {
  const dlg = $('#token-slip-dialog');
  const det = $('#slip-details');
  if (!dlg || !det) return;

  const isEmerg = appt.type === 'EMERGENCY' || appt.is_emergency;

  det.innerHTML = `
    <div class="slip-token-number ${isEmerg ? 'EMERGENCY' : ''}">
      ${isEmerg ? '🚨 EMERGENCY' : '#' + appt.token_number}
    </div>
    <div class="slip-row"><span>Reference:</span><strong>${esc(appt.reference)}</strong></div>
    <div class="slip-row"><span>Date:</span><strong>${fmtDate(appt.date || appt.start)}</strong></div>
    <div class="slip-row"><span>Doctor:</span><strong>${esc(appt.provider_name || appt.doctor_name)}</strong></div>
    <div class="slip-row"><span>Department:</span><strong>${esc(appt.service || '')}</strong></div>
    <div class="slip-row"><span>Patient:</span><strong>${esc(state.user.name)}</strong></div>
    <div class="slip-row"><span>Status:</span>${badge(appt.state)}</div>`;

  dlg.showModal();
}

$('#slip-close-btn').onclick = () => $('#token-slip-dialog').close();
$('#slip-print-btn').onclick = () => window.print();

function openTokenLimitDialog(providerId, currentLimit) {
  state.selectedDoctorForLimit = providerId;
  const dlg = $('#token-limit-dialog');
  const input = $('#daily-limit-input');
  const err = $('#limit-err');
  if (err) err.textContent = '';
  if (input) input.value = currentLimit || 30;
  dlg.showModal();
}

$('#token-limit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const limit = Number($('#daily-limit-input').value);
  const err = $('#limit-err');
  if (!limit || limit < 5 || limit > 300) {
    err.textContent = 'Please enter a valid daily token capacity between 5 and 300.';
    return;
  }

  try {
    await api('POST', `/api/v1/ui/providers/${state.selectedDoctorForLimit}/token-limit`, { daily_token_limit: limit });
    toast(`Daily token limit updated to ${limit} tokens.`);
    $('#token-limit-dialog').close();
    showView(state.view, true);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

/* ---------- 5.x REPORTS, AUDIT TRAIL & DOCTOR SCHEDULE ---------- */
async function viewReports() {
  const isAdmin = state.user.role === 'ADMIN';
  const providers = isAdmin ? await api('GET', '/api/v1/ui/providers') : [];
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const from0 = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
  const to0 = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  const docOptions = providers.map((p) => `<option value="${esc(p.provider_id)}">${esc(p.name)} (${esc(p.provider_id)})</option>`).join('');

  const html = `
    <section class="card" aria-labelledby="rep-h">
      <h3 id="rep-h">Doctor Utilization</h3>
      <form id="rep-form" class="filter-row">
        <div><label for="rep-from">From</label><input type="date" id="rep-from" value="${from0}" required></div>
        <div><label for="rep-to">To</label><input type="date" id="rep-to" value="${to0}" required></div>
        ${isAdmin ? `<div><label for="rep-doc">Doctor</label><select id="rep-doc"><option value="">All doctors</option>${docOptions}</select></div>` : ''}
        <button class="btn primary" type="submit">Show report</button>
        <button class="btn" type="button" id="rep-csv">Export CSV</button>
      </form>
      <p id="rep-status" class="muted" role="status" aria-live="polite"></p>
      <div class="table-wrap" id="rep-table"></div>
    </section>
    ${isAdmin ? `
    <section class="card" aria-labelledby="au-h">
      <h3 id="au-h">Audit Trail</h3>
      <p class="muted">Every create, cancel and state change is recorded in Team C with who did it and a correlation ID.</p>
      <form id="au-form" class="filter-row">
        <div><label for="au-entity">Appointment / entity ID</label><input id="au-entity" placeholder="e.g. an appointment ID" autocomplete="off"></div>
        <div><label for="au-corr">Correlation ID</label><input id="au-corr" placeholder="optional" autocomplete="off"></div>
        <button class="btn primary" type="submit">Search audit</button>
      </form>
      <p id="au-status" class="muted" role="status" aria-live="polite"></p>
      <div class="table-wrap" id="au-table"></div>
    </section>
    <section class="card" aria-labelledby="sc-h">
      <h3 id="sc-h">Doctor Working Hours &amp; Day Off</h3>
      <p class="muted">Bookings are refused on a day off. A day off cannot be set while that day still has active appointments.</p>
      <form id="sc-form" class="filter-row">
        <div><label for="sc-doc">Doctor</label><select id="sc-doc">${docOptions}</select></div>
        <div><label for="sc-date">Date</label><input type="date" id="sc-date" value="${to0}" required></div>
        <div><label for="sc-start">Start</label><input type="time" id="sc-start" value="09:00"></div>
        <div><label for="sc-end">End</label><input type="time" id="sc-end" value="17:00"></div>
        <button class="btn primary" type="submit">Set working hours</button>
        <button class="btn danger" type="button" id="sc-off">Mark day off</button>
        <button class="btn" type="button" id="sc-reset">Reset to default</button>
      </form>
      <p id="sc-msg" class="field-error" role="alert"></p>
    </section>` : ''}`;

  const after = (el) => {
    /* ---- utilization ---- */
    let lastRows = [], lastRange = '';
    const loadReport = async () => {
      const box = el.querySelector('#rep-table'), st = el.querySelector('#rep-status');
      const from = el.querySelector('#rep-from').value, to = el.querySelector('#rep-to').value;
      const qs = new URLSearchParams({ from, to });
      if (isAdmin && el.querySelector('#rep-doc').value) qs.set('provider_id', el.querySelector('#rep-doc').value);
      st.textContent = 'Loading report...';
      try {
        const out = await api('GET', '/api/v1/ui/reports/utilization?' + qs);
        lastRows = out.rows; lastRange = `${out.from}_${out.to}`;
        box.innerHTML = out.rows.length ? `
          <table>
            <thead><tr><th>Doctor</th><th>Date</th><th>Booked</th><th>Completed</th><th>Cancelled</th><th>Waitlisted</th><th>Daily limit</th><th>Utilization</th></tr></thead>
            <tbody>${out.rows.map((r) => `
              <tr>
                <td>${esc(r.provider_name)}<div class="muted small-note">${esc(r.provider_id)}</div></td>
                <td>${esc(r.date)}</td><td>${r.booked}</td><td>${r.completed}</td><td>${r.cancelled}</td><td>${r.waitlisted}</td>
                <td>${r.daily_token_limit}</td>
                <td>${r.utilization_pct}% <progress max="100" value="${Math.min(100, r.utilization_pct)}" aria-label="Utilization ${r.utilization_pct} percent"></progress></td>
              </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty">No bookings in this period.</div>';
        st.textContent = `${out.rows.length} rows · booked ${out.totals.booked}, completed ${out.totals.completed}, cancelled ${out.totals.cancelled} · overall utilization ${out.totals.utilization_pct}% · source: ${out.source === 'team-c' ? 'Team C database' : 'local copy (Team C unreachable)'}`;
      } catch (e) {
        st.textContent = '';
        showError(box, e, loadReport);
      }
    };
    el.querySelector('#rep-form').addEventListener('submit', (e) => { e.preventDefault(); loadReport(); });

    const csvCell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@]/.test(t)) t = "'" + t;                 // stop spreadsheet formula injection
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    el.querySelector('#rep-csv').addEventListener('click', () => {
      if (!lastRows.length) { toast('Nothing to export yet. Show a report with data first.'); return; }
      const head = ['provider_id', 'provider_name', 'date', 'daily_token_limit', 'booked', 'completed', 'cancelled', 'waitlisted', 'utilization_pct'];
      const csv = [head.join(','), ...lastRows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `utilization_${lastRange}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    loadReport();

    if (!isAdmin) return;

    /* ---- audit trail ---- */
    const loadAudit = async () => {
      const box = el.querySelector('#au-table'), st = el.querySelector('#au-status');
      const qs = new URLSearchParams();
      const ent = el.querySelector('#au-entity').value.trim(), cor = el.querySelector('#au-corr').value.trim();
      if (ent) qs.set('entity_id', ent);
      if (cor) qs.set('correlation_id', cor);
      st.textContent = 'Searching...';
      try {
        const rows = await api('GET', '/api/v1/ui/audit?' + qs);
        st.textContent = `${rows.length} audit rows (newest first)`;
        box.innerHTML = rows.length ? `
          <table>
            <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Entity</th><th>Change</th><th>Correlation ID</th></tr></thead>
            <tbody>${rows.map((r) => {
              const b = r.before_json || {}, a = r.after_json || {};
              const change = (b.state || a.state) ? `${esc(b.state || '–')} → ${esc(a.state || '–')}` : '–';
              return `
              <tr>
                <td>${esc(new Date(r.created_at).toLocaleString('en-IN'))}</td>
                <td>${esc(r.actor)}<div class="muted small-note">${esc(r.source_service)}</div></td>
                <td>${esc(r.action)}</td>
                <td><span class="small-note">${esc(r.entity)}</span><div class="small-note">${esc(r.entity_id)}</div></td>
                <td>${change}
                  <details><summary class="small-note">Details</summary><pre class="audit-json">${esc(JSON.stringify({ before: r.before_json, after: r.after_json }, null, 2))}</pre></details></td>
                <td class="small-note">${esc(r.correlation_id)}</td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>` : '<div class="empty">No audit rows found.</div>';
      } catch (e) {
        st.textContent = '';
        showError(box, e, loadAudit);
      }
    };
    el.querySelector('#au-form').addEventListener('submit', (e) => { e.preventDefault(); loadAudit(); });
    loadAudit();

    /* ---- working hours / day off ---- */
    const msg = el.querySelector('#sc-msg');
    const sendSchedule = async (body, okText) => {
      msg.textContent = '';
      const doc = el.querySelector('#sc-doc').value, date = el.querySelector('#sc-date').value;
      if (!doc || !date) { msg.textContent = 'Choose a doctor and a date.'; return; }
      try {
        await api('PUT', `/api/v1/ui/providers/${encodeURIComponent(doc)}/schedule`, { date, ...body });
        toast(okText);
      } catch (ex) {
        msg.textContent = ex.message;
      }
    };
    el.querySelector('#sc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      sendSchedule({ start: el.querySelector('#sc-start').value, end: el.querySelector('#sc-end').value }, 'Working hours saved.');
    });
    el.querySelector('#sc-off').addEventListener('click', () => {
      if (confirm('Mark this day as a day off? Patients will not be able to book it.')) sendSchedule({ closed: true }, 'Day marked as off.');
    });
    el.querySelector('#sc-reset').addEventListener('click', () => sendSchedule({ reset: true }, 'Back to the default working hours.'));
  };

  return { html, after };
}

/* =========================== 7. NAVIGATION & BOOTSTRAP =========================== */
const VIEWS = {
  dashboard:     { label: 'Live Dashboard',   title: 'Token Queue Dashboard', roles: ['PATIENT', 'PROVIDER', 'ADMIN'], run: viewDashboard },
  book:          { label: 'Book Token',       title: 'Book Doctor Token',     roles: ['PATIENT'], run: viewBook },
  appointments:  { label: 'Appointments',     title: 'All Token Bookings',    roles: ['PATIENT', 'PROVIDER', 'ADMIN'], run: viewAppointments },
  emergency:     { label: 'Emergency',        title: 'Emergency Priority',    roles: ['PATIENT', 'ADMIN'], run: viewEmergency, cls: 'emergency' },
  reports:       { label: 'Reports',          title: 'Reports & Audit',       roles: ['ADMIN', 'PROVIDER'], run: viewReports },
  providers:     { label: 'Doctors & Limits', title: 'Doctors & Capacities',  roles: ['ADMIN'], run: viewProviders },
  patients:      { label: 'Patients',         title: 'Patient Directory',     roles: ['ADMIN'], run: viewPatients },
  notifications: { label: 'Notifications',    title: 'Notifications',         roles: ['PATIENT', 'ADMIN', 'PROVIDER'], run: viewNotifications },
  profile:       { label: 'Profile',          title: 'My Profile',            roles: ['PATIENT', 'PROVIDER', 'ADMIN'], run: viewProfile }
};

const MENU = {
  PATIENT:  ['dashboard', 'book', 'appointments', 'emergency', 'notifications', 'profile'],
  PROVIDER: ['dashboard', 'appointments', 'reports', 'notifications', 'profile'],
  ADMIN:    ['dashboard', 'appointments', 'emergency', 'providers', 'patients', 'reports', 'notifications', 'profile']
};

async function showView(name, silent = false) {
  if (!state.user) return;
  if (!VIEWS[name] || !VIEWS[name].roles.includes(state.user.role)) {
    name = 'dashboard';
  }

  const v = VIEWS[name];
  const el = $('#view');
  const id = ++state.renderId;
  state.view = name;

  document.querySelectorAll('#nav button').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  $('#page-title').textContent = v.title;
  document.title = `${v.title} — CareSlot`;

  el.setAttribute('aria-busy', 'true');
  if (!silent) el.innerHTML = '<p class="muted">Loading...</p>';

  try {
    const out = await v.run();
    if (id !== state.renderId) return;
    // IMPORTANT: put the new page into a FRESH container. The old container (with every click handler
    // added by earlier renders) is thrown away. Without this, each live refresh stacked one more click
    // handler on the page, so a single click on "Call Next Token" was sent to the server several times
    // and the later calls skipped T-001 and called T-002.
    const fresh = el.cloneNode(false);
    el.replaceWith(fresh);
    fresh.innerHTML = out.html;
    if (out.after) out.after(fresh);
  } catch (err) {
    if (id === state.renderId) showError($('#view'), err, () => showView(name));
  } finally {
    if (id === state.renderId) $('#view').setAttribute('aria-busy', 'false');
  }
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) location.hash = '#/' + b.dataset.view;
});
window.addEventListener('hashchange', () => showView(location.hash.replace('#/', '')));

function enterApp(user) {
  state.user = user;
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = user.name;
  $('#user-role').textContent = `${user.role} ${user.patient_code ? '(' + user.patient_code + ')' : user.provider_id ? '(' + user.provider_id + ')' : ''}`;

  $('#nav').innerHTML = MENU[user.role].map((v) =>
    `<button type="button" data-view="${v}" class="${VIEWS[v].cls || ''}">${VIEWS[v].label}</button>`).join('');

  connectStream();
  showView(location.hash.replace('#/', '') || 'dashboard');
}

async function logout(msg = '') {
  state.user = null;
  disconnectStream();
  try { if (state.token) await api('DELETE', '/api/v1/ui/session'); } catch { /* ignore */ }
  state.token = null;
  sessionStorage.removeItem('token');
  location.hash = '';

  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-msg').textContent = msg;
  $('#login-id').focus();
}
$('#logout').addEventListener('click', () => logout());

function startSession(data) {
  state.token = data.token;
  sessionStorage.setItem('token', data.token);
  enterApp(data.user);
}

// Log in / Register Tab Switching
function showTab(which) {
  const isLogin = which === 'login';
  $('#tab-login').setAttribute('aria-selected', isLogin);
  $('#tab-register').setAttribute('aria-selected', !isLogin);
  $('#login-form').hidden = !isLogin;
  $('#register-form').hidden = isLogin;
  (isLogin ? $('#login-id') : $('#reg-name')).focus();
}
$('#tab-login').onclick = () => showTab('login');
$('#tab-register').onclick = () => showTab('register');

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  const btn = $('#login-btn');
  const identifier = $('#login-id').value.trim();
  const password = $('#login-password').value;

  msg.textContent = '';
  if (!identifier || !password) {
    msg.textContent = 'Please enter identifier and password.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await api('POST', '/api/v1/ui/session', { identifier, password });
    startSession(res);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In to Dashboard →';
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#reg-msg');
  const btn = $('#reg-btn');
  fieldErrors('reg', []);

  const name = $('#reg-name').value.trim();
  const phone = $('#reg-phone').value.trim();
  const email = $('#reg-email').value.trim();
  const password = $('#reg-password').value;
  const confirm = $('#reg-confirm').value;

  if (password !== confirm) {
    $('#reg-err-confirm').textContent = 'Passwords do not match.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating Account...';

  try {
    const res = await api('POST', '/api/v1/ui/register', { name, phone, email, password });
    toast(`Account created! Patient ID: ${res.user.patient_code}`);
    startSession(res);
  } catch (err) {
    if (!fieldErrors('reg', err.details)) msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Patient Account';
  }
});

// Boot check
(async function boot() {
  if (!state.token) return;
  try {
    const me = await api('GET', '/api/v1/ui/me');
    enterApp(me);
  } catch {
    sessionStorage.removeItem('token');
    state.token = null;
  }
})();