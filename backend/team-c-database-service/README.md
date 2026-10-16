# CareSlot - Team C service (DBMS engine)

REST/JSON service on **port 4000** backed by MySQL. Node 18+.

## 1. Start the database
```bash
mysql -u root -p < db/careslot_team_c.sql        # creates HospitalAppointmentDB + seed data
```
The file can be re-run any time (it resets the data - development only).
Seed: 4 doctors (DR-001..DR-004), 4 patients (PT-0001..PT-0004), 1 admin, 4 appointments.

## 2. Start the service
```bash
cd team-c
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edit .env: DB_PASSWORD and SERVICE_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # makes a good SERVICE_KEY
npm start
```
Check: `curl http://localhost:4000/health` -> `{"status":"ok"}`
and `curl -H "Authorization: Bearer <SERVICE_KEY>" http://localhost:4000/api/v1/providers`

## 3. Run the proof of tests
```bash
SERVICE_KEY=<key> npm test        # Windows PowerShell:  $env:SERVICE_KEY="<key>"; npm test
```
Covers: duplicate Idempotency-Key, two parallel bookings for one slot, illegal state change,
emergency rescheduling, audit rows with correlation_id.

## Decisions for Team D
* Daily limit reached -> **201 with state WAITLISTED** (no token_number). `CAPACITY_EXHAUSTED` is only returned when promoting a waitlisted booking while the day is still full.
* Users: Team D keeps passwords/sessions; Team C stores only the profile (`Users`: name, email, phone, role). Confirmed.
* `start`/`end` are optional on booking. If you send only `date` (YYYY-MM-DD) Team C assigns the next free `SLOT_MINUTES` slot and the next token number. Sending the same fixed start for everybody gives `SLOT_CONFLICT` by design.
* EMERGENCY without `start` goes to the front of that day's waiting queue; the pushed-back appointments come back in `rescheduled[]`.
* Optional headers: `X-Correlation-ID` (echoed + stored), `X-Actor` (who did it, stored in audit), `X-Source-Service`.
* Provider status accepts `ON_LEAVE` as an alias of `INACTIVE`.
* Extra error codes: ALREADY_BOOKED, PROVIDER_UNAVAILABLE, VERSION_CONFLICT (all 409).
* `GET /api/v1/events?since=N` returns events with event_id > N plus `next_cursor`; poll it every 1-2 s.

## Error codes
UNAUTHENTICATED 401 · VALIDATION_ERROR 400 · NOT_FOUND 404 · SLOT_CONFLICT 409 · ILLEGAL_TRANSITION 409 · CAPACITY_EXHAUSTED 409 · DUPLICATE_USER 409 · INTERNAL_ERROR 500 (+ ALREADY_BOOKED, PROVIDER_UNAVAILABLE, VERSION_CONFLICT 409)

## Allowed state changes
REQUESTED→CONFIRMED|WAITLISTED|REJECTED|CANCELLED · CONFIRMED→CALLED|CANCELLED|RESCHEDULED|NO_SHOW|WAITLISTED ·
RESCHEDULED→CONFIRMED|CALLED|CANCELLED|NO_SHOW|WAITLISTED · WAITLISTED→CONFIRMED|RESCHEDULED|CANCELLED|REJECTED ·
CALLED→IN_CONSULTATION|NO_SHOW|CONFIRMED|RESCHEDULED|WAITLISTED|CANCELLED · IN_CONSULTATION→COMPLETED|CANCELLED ·
CANCELLED, REJECTED, COMPLETED, NO_SHOW are final.

## Extras used by Team D
* `POST /internal/v1/appointments/{id}/transition` accepts `"new_token": true` with `to_state: RESCHEDULED`: the patient gets a NEW token at the end of the day's queue (absent patient flow).
* WAITLISTED → RESCHEDULED re-admits a waitlisted patient with the SAME token, at the back of the queue.
* `POST /internal/v1/dev/reset-appointments` clears all appointments (audit kept). Works only when `ALLOW_DEV_RESET=true`.
* FORBIDDEN 403 is returned when that switch is off.

## Evidence scripts
* `npm test` - functional proof (idempotency, parallel booking, transitions, emergency, day off, integrity).
* `node tests/load-test.js` - concurrency + latency evidence (set `RATE_LIMIT_PER_MIN=0` first; `N=10000` for the full KPI run). Writes `tests/load-results.json`.
* `node tests/recovery-drill.js` - backup/restore drill. See `RECOVERY.md`.

## More endpoints
* `PUT /internal/v1/providers/{id}/schedule` body `{date, start, end}` (working hours) or `{date, closed:true}` (day off) or `{date, reset:true}`. Day off is refused while active appointments exist (409). Bookings on a day off return 409 PROVIDER_UNAVAILABLE.
* `POST /internal/v1/recovery/verify` - read-only integrity report.
* 429 RATE_LIMITED when a client IP exceeds `RATE_LIMIT_PER_MIN`.
