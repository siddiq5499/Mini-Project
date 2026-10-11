# Team C → Team D: step-by-step guide (from basics)

## 0. The big picture
```
Browser (Frontend)  →  Team D server.js (port 3000)  →  Team C service (port 4000)  →  MySQL (port 3306)
                          uses TEAM_C_KEY                  checks SERVICE_KEY             HospitalAppointmentDB
```
* An **API key is not made from the SQL file.** The SQL file only creates the database. The key (called `SERVICE_KEY`) is a long random password that **you choose** and put in Team C's `.env`. Team C's service refuses every request that does not carry it. You give the same string to Team D, who puts it in `TEAM_C_KEY`.
* **REST** = Team D sends normal HTTP requests (GET/POST/PATCH) with JSON and gets JSON back.

## 1. Install the tools (once)
1. MySQL Server 8 (+ MySQL Workbench, optional) - remember the root password you set.
2. Node.js 18 or newer (`node -v` to check).

## 2. Create the database from the corrected SQL file
Command line: `mysql -u root -p < team-c/db/careslot_team_c.sql`
or Workbench: *File → Open SQL Script → run the whole script (lightning icon)*.
Check: `SELECT * FROM v_doctor;` shows DR-001…DR-004. (The file drops and rebuilds the tables, so it can be run again and again.)

## 3. Start the Team C service
```bash
cd team-c
npm install
cp .env.example .env          # Windows: copy .env.example .env
```
Create the key:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Open `.env` and set `SERVICE_KEY=<that long string>` and `DB_PASSWORD=<your MySQL password>`. Then:
```bash
npm start       # → Team C service listening on http://localhost:4000
```

## 4. Test with your own eyes (curl or Postman)
```bash
curl http://localhost:4000/health
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:4000/api/v1/providers
curl -X POST http://localhost:4000/api/v1/appointments \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-001" \
  -d '{"user_id":"PT-0001","provider_id":"DR-001","date":"2026-10-20","priority":"NORMAL","purpose":"checkup"}'
```
Run it twice: the second answer is the **same** appointment (idempotency). Then `npm test` (set `SERVICE_KEY` first) for the proof of tests.
No key → `401 UNAUTHENTICATED`. Wrong slot → `409 SLOT_CONFLICT`.

## 5. Connect Team D (M_Final/Backend)
1. Copy `team-d-integration/teamC-client.js` into `M_Final/Backend/`.
2. Create/extend `M_Final/Backend/.env`:
```
TEAM_C_URL=http://localhost:4000
TEAM_C_KEY=<the same SERVICE_KEY>
```
3. At the top of `server.js` (after the `crypto` require) add: `const teamC = require('./teamC-client');`
4. Wire the routes. **Plan:** Team C becomes the system of record for users, providers, bookings; Team D keeps its local store only for passwords/sessions and for the queue-screen state (call-next, buffer), so your existing screens keep working. Do one route at a time and test each.

**a) Register** (`route('POST','/register'…`) - after the duplicate checks, before `store.users.push(u)`:
```js
const tcUser = await teamC.createUser({ role: 'PATIENT', name, phone, email: email || undefined }, { correlationId: c.correlationId });
// use Team C's id instead of your own counter:
const patient_code = tcUser.user_id;           // "PT-0007"
```
(Remove `code('PT', ++store.counters.patient, 4)`. If Team C answers 409 DUPLICATE_USER your `httpErr` handler passes it to the UI.)

**b) Providers list** - `route('GET','/providers'…` returns Team C's list: `return await teamC.listProviders();` (it has `provider_id, name, service, status, daily_token_limit`). Keep merging `current_token` from your local `store.providers` if the doctor screen needs it.

**c) Update doctor** (`PATCH /providers/:id`) → `const p2 = await teamC.patchProvider(c.params.id, { status: c.body.status, daily_token_limit: c.body.daily_token_limit }, { actor: c.user.user_id });` then copy the result into your local provider object. Same for the token-limit route.

**d) Book a token** (`POST /appointments`) - replace the block that builds `appt` with:
```js
const res = await teamC.book(
  { appointment_id: uid(), user_id: c.user.patient_code, provider_id: providerId,
    service_type: p.service, date: dateStr, priority: 'NORMAL', purpose: reason },
  c.body.idempotency_key || uid(),             // the browser should send one key per click; reuse it on retry
  { actor: c.user.patient_code });
// mirror into the local store so queue screens keep working:
const appt = { appointment_id: res.appointment_id, reference: 'AP-' + String(res.token_number || 0).padStart(4,'0'),
  user_id: c.user.user_id, patient_code: c.user.patient_code, patient_name: c.user.name, patient_phone: c.user.phone,
  provider_id: p.provider_id, provider_name: p.name, service: p.service, date: dateStr, start: res.start,
  token_number: res.token_number, type: 'REGULAR', state: res.state, reason, created_at: nowISO(), history: [] };
store.appointments.push(appt);
```
Important: **do not send a fixed `start`** (your old `T09:00:00Z` for everyone). Send `date` only and Team C hands out the slot and token. If `res.state === 'WAITLISTED'` show "Day full - you are on the waiting list".

**e) Cancel** (`POST /appointments/:id/cancel`) - first line after the permission check: `await teamC.cancel(a.appointment_id, { actor: c.user.user_id });` then keep your local `a.state = 'CANCELLED'`.

**f) Emergency** (`POST /emergency`) - `const res = await teamC.book({ appointment_id: uid(), user_id: patient.patient_code, provider_id: p.provider_id, service_type: p.service, date: today, priority: 'EMERGENCY', purpose: reason }, uid());` Use `res.token_number` / `res.start`. For every item in `res.rescheduled` find the local appointment with that `appointment_id` and set `state='RESCHEDULED'`, `start=item.start`, then notify that patient. (The admin walk-in patient must first be created with `teamC.createUser`.)

**g) Call next / mark present / terminate** - when your code sets `state = 'CALLED' | 'IN_CONSULTATION' | 'COMPLETED' | 'NO_SHOW'` also call `await teamC.transition(a.appointment_id, 'CALLED', { actor })`. A `409 ILLEGAL_TRANSITION` means the screen and database disagree - show the message.

**h) Live updates** - poll `teamC.events(cursor)` every 2 s; for every returned event call your existing `broadcast(event.type, event.payload)`; save `next_cursor`. That makes changes made by other services appear on every screen.

## 6. Practice first (optional)
Your `practice-teams.js` is a stand-in Team C on the same port 4000. Start it with `node practice-teams.js` and use `TEAM_C_KEY=practice-c-key` to test the wiring above. Then stop it, start the real Team C service, switch the key - nothing else changes. (The practice Team C ignores `date`, so test bookings with a `start` there.)

## 7. Common problems
| Symptom | Cause / fix |
|---|---|
| `Cannot connect to MySQL` on start | wrong `DB_PASSWORD`, MySQL not running, or SQL file not run |
| `401 UNAUTHENTICATED` | `TEAM_C_KEY` ≠ `SERVICE_KEY`, or the `Bearer ` prefix is missing |
| `TEAM_C_UNAVAILABLE` (503) in Team D | Team C is not running or `TEAM_C_URL` is wrong |
| `409 SLOT_CONFLICT` for everyone | you are sending the same fixed `start`; send `date` only |
| `ALREADY_BOOKED` | same patient, doctor and date - by design |
| Port 4000 busy | change `PORT` in Team C `.env` and `TEAM_C_URL` in Team D |
