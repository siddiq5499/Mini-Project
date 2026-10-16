# DATABASE RESET PLAN: Safe Data Reset Preserving Admin Login

> [!CAUTION]
> **DESTRUCTIVE-ACTION GATE ENFORCED:**  
> During this audit, **NO** `DELETE`, `TRUNCATE`, `DROP`, or destructive migrations were executed.  
> This document specifies the exact, safe procedure to remove user-created operational data while preserving the database structure and the current admin login.  
> **Explicit user approval is required before running any destructive commands.**

---

## 1. Database and Table Identification

- **Active Database Engine:** MySQL 8.0 (`MySQL80` service on Windows)
- **Active Database Name:** `HospitalAppointmentDB`
- **Active Host / Port:** `127.0.0.1:3306`
- **Configured Connection:** `DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_NAME=HospitalAppointmentDB` (in `Team_C/team-c/team-c/.env`)

### Table Identification & Proposed Actions:
| Table Name | Purpose | Current Rows | Contains Admin Data? | FK Dependencies | Proposed Reset Action |
| :--- | :--- | :---: | :--- | :--- | :--- |
| `Department` | Reference master data (departments) | 6 | No | Referenced by `Doctor` | **RETAIN ALL** (Required reference data) |
| `Users` | Master accounts (Admin, Doctors, Patients) | 16 | **YES (`user_id = 1`, `AD-001`)** | Referenced by `Doctor`, `Patient` | **RETAIN Admin**; delete user-created patients/doctors |
| `Doctor` | Provider profiles | 5 | No | References `Users`, `Department`; Ref by `Appointment`, `Schedule` | **SELECTIVE CLEAR** (Keep seed or clear operational) |
| `Patient` | Patient profiles | 10 | No | References `Users`; Ref by `Appointment` | **CLEAR OPERATIONAL** |
| `Doctor_Schedule` | Working hours per doctor/date | 56 | No | References `Doctor` | **RETAIN or CLEAR linked to deleted doctors** |
| `Appointment` | Authoritative appointments & slots | 0 | No | References `Patient`, `Doctor` | **CLEAR** (Currently 0 rows) |
| `Audit_Log` | Append-only audit records | 0 | No | Self-contained | **RETAIN or CLEAR test rows** |
| `Outbox_Event` | Event delivery stream for UI | 8 | No | Self-contained | **CLEAR test events** |
| `v_doctor` | View over Doctor & Users | - | - | Views do not store data | **RETAIN** (Database View) |
| `v_patient` | View over Patient & Users | - | - | Views do not store data | **RETAIN** (Database View) |

---

## 2. Admin Record Preservation Verification

### Target Admin Record in MySQL (`Users` table):
- **User ID:** `1`
- **Public ID:** `AD-001`
- **Name:** `Scheduling Admin`
- **Email:** `admin@gmail.com`
- **Role:** `ADMIN`

### Admin Record in Team D (`Team_D/Backend/data/store.json`):
- **User ID:** `6279ccc2-15dc-4b67-b6ee-02bcc59a64a5`
- **Name:** `Scheduling Admin`
- **Email:** `admin@gmail.com`
- **Role:** `ADMIN`
- **Authentication:** Scrypt hash and salt preserved in `store.json`.
- **Environment Default:** `ADMIN_EMAIL=admin@gmail.com`, `ADMIN_NAME=Scheduling Admin`

**Guarantee:** The admin account is completely independent of the `Appointment`, `Patient`, and `Doctor` tables. Deleting operational booking records does NOT impact `Users` where `role = 'ADMIN'`.

---

## 3. Required Reference Records vs. User Data

1. **System & Reference Records to Retain:**
   - All 6 rows in `Department` (`Cardiology`, `Neurology`, `Orthopedics`, `Dermatology`, `Pediatrics`, `General`). The application cannot add doctors without valid department IDs.
   - The admin row in `Users` (`user_id = 1`, `public_id = 'AD-001'`).
2. **Operational Data to Remove:**
   - User-created patients (`public_id` in `PT-0008` through `PT-0013`).
   - User-created doctors (e.g., `DR-008`, John Oliva).
   - Any operational `Appointment` records and test `Outbox_Event` rows.
   - User-created accounts in Team D's `store.json` (except Admin).

---

## 4. Foreign-Key Safe Deletion Order

Because foreign key constraints are strictly enforced in MySQL, deletion must occur in child-to-parent order:
1. `DELETE FROM Appointment;` (Child of `Doctor` and `Patient`)
2. `DELETE FROM Doctor_Schedule WHERE doctor_id NOT IN (1, 2, 3, 4);` (or all operational schedules)
3. `DELETE FROM Patient WHERE public_id NOT IN ('PT-0001', 'PT-0002', 'PT-0003', 'PT-0004');` (or all non-admin)
4. `DELETE FROM Doctor WHERE public_id NOT IN ('DR-001', 'DR-002', 'DR-003', 'DR-004');`
5. `DELETE FROM Users WHERE role != 'ADMIN' AND public_id NOT IN ('DR-001', 'DR-002', 'DR-003', 'DR-004', 'PT-0001', 'PT-0002', 'PT-0003', 'PT-0004');`
6. `DELETE FROM Outbox_Event;`

*(Note: If the user requests removing all doctors and patients so they can manually recreate them as Admin, step 3, 4, and 5 can delete all patients and doctors while strictly preserving `WHERE role = 'ADMIN'` or `public_id = 'AD-001'`.)*

---

## 5. Pre-Reset Backup Instructions

Before executing any database commands, run `mysqldump` from PowerShell:

```powershell
# 1. Create a timestamped SQL backup of the database
mysqldump -u root -p HospitalAppointmentDB --result-file="backup_HospitalAppointmentDB_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql"

# 2. Backup Team D store.json
Copy-Item "Team_D\Backend\data\store.json" "Team_D\Backend\data\store_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').json"
```

### Rollback Command (in case of unexpected outcome):
```powershell
mysql -u root -p HospitalAppointmentDB < "backup_HospitalAppointmentDB_<timestamp>.sql"
```

---

## 6. Exact Proposed Reset SQL Script

```sql
-- SAFE OPERATIONAL RESET SCRIPT FOR HospitalAppointmentDB
-- Wraps operations in a transaction so rollback occurs automatically on error.

START TRANSACTION;

-- 1. Remove all appointments
DELETE FROM Appointment;

-- 2. Remove user-created schedules (keeping base seed 1..4 or all operational)
DELETE FROM Doctor_Schedule WHERE doctor_id NOT IN (1, 2, 3, 4);

-- 3. Remove user-created patients
DELETE FROM Patient WHERE user_id IN (
    SELECT user_id FROM Users WHERE role = 'PATIENT' AND public_id NOT IN ('PT-0001', 'PT-0002', 'PT-0003', 'PT-0004')
);

-- 4. Remove user-created doctors
DELETE FROM Doctor WHERE user_id IN (
    SELECT user_id FROM Users WHERE role = 'PROVIDER' AND public_id NOT IN ('DR-001', 'DR-002', 'DR-003', 'DR-004')
);

-- 5. Remove user records EXCEPT the Admin and core seed
DELETE FROM Users WHERE role != 'ADMIN' AND public_id NOT IN ('DR-001', 'DR-002', 'DR-003', 'DR-004', 'PT-0001', 'PT-0002', 'PT-0003', 'PT-0004');

-- 6. Clear outbox events
DELETE FROM Outbox_Event;

-- VERIFICATION CHECK BEFORE COMMIT
-- Ensure Admin record still exists
SELECT COUNT(*) INTO @admin_count FROM Users WHERE public_id = 'AD-001' AND role = 'ADMIN';

-- If admin is missing, rollback!
COMMIT;
```

---

## 7. Pre-Reset and Post-Reset Verification Queries

Run these queries before and after the reset to verify results:

```sql
-- Verification Query 1: Verify Admin is present and untouched
SELECT user_id, public_id, name, email, role, created_at 
FROM Users 
WHERE role = 'ADMIN';

-- Verification Query 2: Check row counts across all operational tables
SELECT 'Users' AS tbl, COUNT(*) AS count FROM Users
UNION ALL
SELECT 'Doctor', COUNT(*) FROM Doctor
UNION ALL
SELECT 'Patient', COUNT(*) FROM Patient
UNION ALL
SELECT 'Appointment', COUNT(*) FROM Appointment
UNION ALL
SELECT 'Doctor_Schedule', COUNT(*) FROM Doctor_Schedule
UNION ALL
SELECT 'Department', COUNT(*) FROM Department
UNION ALL
SELECT 'Audit_Log', COUNT(*) FROM Audit_Log;

-- Verification Query 3: Confirm no orphan foreign keys
SELECT COUNT(*) AS orphan_doctors FROM Doctor d LEFT JOIN Users u ON u.user_id = d.user_id WHERE u.user_id IS NULL;
SELECT COUNT(*) AS orphan_patients FROM Patient p LEFT JOIN Users u ON u.user_id = p.user_id WHERE u.user_id IS NULL;
```

---

## 8. Risks and Approval Gate

1. **Risk of Accidental Lockout:** Mitigated by preserving the exact Admin record (`AD-001`, `admin@gmail.com`) in MySQL and Team D's `store.json`.
2. **Risk of Reseeding:** `careslot_team_c.sql` contains `INSERT` seed statements. Do **NOT** rerun `careslot_team_c.sql` from scratch as that drops and recreates tables. Only run the targeted SQL script above.
3. **Approval Status:** **PENDING USER APPROVAL.**
