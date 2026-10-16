# Team C - backup, recovery and integrity (evidence for KPI "Recovery")

## 1. Integrity check (any time)
```
curl.exe -X POST -H "Authorization: Bearer YOUR_KEY" http://localhost:4000/internal/v1/recovery/verify
```
Returns `status: OK` when there are 0 orphan appointments, 0 duplicate live slots, 0 duplicate tokens, 0 overlapping live appointments and every appointment has its `APPOINTMENT_CREATED` audit row. It also returns row counts and the time of the newest audit write.

## 2. Recovery drill (safe - does not touch live data)
```
$env:SERVICE_KEY="YOUR_KEY"
node tests/recovery-drill.js
```
It dumps the database with `mysqldump`, restores it into a scratch database `HospitalAppointmentDB_recovery_test`, compares the row count of every table, and writes `tests/recovery-report.json` with the backup time, restore time and an RTO estimate. Target: RTO <= 30 minutes.

## 3. RPO <= 5 minutes
RPO is how much recent data you can lose. Schedule the dump every 5 minutes (Windows Task Scheduler, every 5 minutes):
```
mysqldump -u root --single-transaction --routines --triggers --result-file=C:\backups\careslot.sql HospitalAppointmentDB
```
(use `MYSQL_PWD` or an option file for the password). Worst case you lose 5 minutes of bookings. For zero loss turn on MySQL binary logging and replay it after restoring (point-in-time recovery).

## 4. Audit reconciliation
`Audit_Log` cannot be edited or deleted (database triggers). Reconcile with:
```sql
SELECT a.public_id FROM Appointment a
LEFT JOIN Audit_Log l ON l.entity='appointment' AND l.entity_id=a.public_id AND l.action='APPOINTMENT_CREATED'
WHERE l.audit_id IS NULL;      -- must return 0 rows
```

## 5. Index-performance comparison (evidence)
Run in Workbench after the load test (a few thousand rows):
```sql
EXPLAIN SELECT * FROM Appointment WHERE doctor_id = 3 AND appointment_date = '2027-01-01' AND state = 'CONFIRMED';  -- uses idx_appt_doc_day
EXPLAIN SELECT * FROM Appointment IGNORE INDEX (idx_appt_doc_day, uq_token, uq_live_slot) WHERE doctor_id = 3 AND appointment_date = '2027-01-01' AND state = 'CONFIRMED';  -- full scan
```
Compare `type`, `key` and `rows` in the two plans for your report.
