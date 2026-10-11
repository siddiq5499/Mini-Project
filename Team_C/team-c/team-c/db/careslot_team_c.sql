/* =====================================================================
   CareSlot - Team C (Appointment Data & Transaction Manager)
   Corrected + extended schema.  Needs MySQL 8.0+ (5.7 also works; CHECK
   constraints are simply ignored there).

   FIXES TO YOUR ORIGINAL FILE (list A of Team_C_req.txt)
   1. Stray word "appointment" after  patient_name VARCHAR(100) NOT NULL,   -> removed
   2. Stray word "employee1" after  SELECT * FROM Appointment;              -> removed
   3. "Appoinment" misspelt in the last SELECT                              -> Appointment
   4. CREATE DATABASE  ->  CREATE DATABASE IF NOT EXISTS
   5. Patient_Login was an empty table that the login query searched.
      Team D keeps passwords/sessions, so Patient_Login is REMOVED and the
      login query is gone.  Team C stores only the profile (Users table).

   RE-RUNNABLE: section 0 drops the old tables so the file can be run from
   top to bottom any number of times (it RESETS the data - dev only).
   Run it with:   mysql -u root -p < careslot_team_c.sql
   ===================================================================== */

CREATE DATABASE IF NOT EXISTS HospitalAppointmentDB
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE HospitalAppointmentDB;

/* ---------- 0. dev reset (remove this block in production) ---------- */
SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW  IF EXISTS v_doctor;
DROP VIEW  IF EXISTS v_patient;
DROP TABLE IF EXISTS Outbox_Event;
DROP TABLE IF EXISTS Audit_Log;
DROP TABLE IF EXISTS Appointment;
DROP TABLE IF EXISTS Doctor_Schedule;
DROP TABLE IF EXISTS Patient_Login;
DROP TABLE IF EXISTS Patient;
DROP TABLE IF EXISTS Doctor;
DROP TABLE IF EXISTS Users;
DROP TABLE IF EXISTS Department;
SET FOREIGN_KEY_CHECKS = 1;

/* ---------- 1. Department ---------- */
CREATE TABLE Department (
    department_id   INT PRIMARY KEY AUTO_INCREMENT,
    department_name VARCHAR(100) NOT NULL UNIQUE,
    description     VARCHAR(255)
);

INSERT INTO Department (department_name, description) VALUES
('Cardiology',  'Treatment of heart-related diseases'),
('Neurology',   'Treatment of brain and nervous system disorders'),
('Orthopedics', 'Treatment of bones and joints'),
('Dermatology', 'Treatment of skin-related diseases'),
('Pediatrics',  'Medical care for children'),
('General',     'General medicine / unassigned');

/* ---------- 2. Users  (profile + role only; NO passwords) ----------
   Team D keeps passwords and login sessions.  public_id is the id the
   APIs use:  PT-0001 (patient), DR-001 (doctor), AD-001 (admin).        */
CREATE TABLE Users (
    user_id    INT PRIMARY KEY AUTO_INCREMENT,
    public_id  VARCHAR(40)  NOT NULL UNIQUE,
    name       VARCHAR(100) NOT NULL,
    email      VARCHAR(100) UNIQUE,
    phone      VARCHAR(15)  UNIQUE,
    role       ENUM('PATIENT','PROVIDER','ADMIN') NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* ---------- 3. Doctor (= PROVIDER) ---------- */
CREATE TABLE Doctor (
    doctor_id         INT PRIMARY KEY AUTO_INCREMENT,
    user_id           INT NOT NULL UNIQUE,
    public_id         VARCHAR(20)  NOT NULL UNIQUE,            -- DR-001
    specialization    VARCHAR(100) NOT NULL,
    service           VARCHAR(100) NOT NULL,                   -- "Cardiologist"
    status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    daily_token_limit INT NOT NULL DEFAULT 30,
    department_id     INT NOT NULL,
    CONSTRAINT chk_doctor_limit CHECK (daily_token_limit > 0),
    FOREIGN KEY (user_id)       REFERENCES Users(user_id),
    FOREIGN KEY (department_id) REFERENCES Department(department_id)
);

/* ---------- 4. Patient ---------- */
CREATE TABLE Patient (
    patient_id    INT PRIMARY KEY AUTO_INCREMENT,
    user_id       INT NOT NULL UNIQUE,
    public_id     VARCHAR(20) NOT NULL UNIQUE,                 -- PT-0001
    date_of_birth DATE,
    gender        VARCHAR(10),
    address       VARCHAR(255),
    FOREIGN KEY (user_id) REFERENCES Users(user_id)
);

/* Convenience views: they look like the old Doctor / Patient tables */
CREATE VIEW v_doctor AS
SELECT d.doctor_id, d.public_id, u.name AS doctor_name, u.email, u.phone,
       d.specialization, d.service, d.status, d.daily_token_limit,
       dep.department_name
FROM Doctor d
JOIN Users u        ON u.user_id = d.user_id
JOIN Department dep ON dep.department_id = d.department_id;

CREATE VIEW v_patient AS
SELECT p.patient_id, p.public_id, u.name AS patient_name, u.email, u.phone,
       p.date_of_birth, p.gender, p.address
FROM Patient p
JOIN Users u ON u.user_id = p.user_id;

/* ---------- 5. Doctor_Schedule (working hours per date) ---------- */
CREATE TABLE Doctor_Schedule (
    schedule_id    INT PRIMARY KEY AUTO_INCREMENT,
    doctor_id      INT  NOT NULL,
    available_date DATE NOT NULL,
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    UNIQUE KEY uq_schedule (doctor_id, available_date, start_time),
    FOREIGN KEY (doctor_id) REFERENCES Doctor(doctor_id)
);

/* ---------- 6. Appointment ----------
   Double-booking protection INSIDE the database:
     uq_token      : one token number per (doctor, day)
     uq_live_slot  : one LIVE appointment per (doctor, start time).
                     MySQL has no partial unique index, so live_start is a
                     generated column that is NULL for dead states
                     (CANCELLED, COMPLETED ...).  NULLs never collide.
   The service additionally takes SELECT ... FOR UPDATE on the Doctor row. */
CREATE TABLE Appointment (
    appointment_id   INT PRIMARY KEY AUTO_INCREMENT,
    public_id        CHAR(36)    NOT NULL UNIQUE,              -- UUID used by the APIs
    patient_id       INT         NOT NULL,
    doctor_id        INT         NOT NULL,
    appointment_date DATE        NOT NULL,
    token_number     INT         NULL,                         -- NULL while WAITLISTED
    priority         ENUM('NORMAL','EMERGENCY') NOT NULL DEFAULT 'NORMAL',
    state            ENUM('REQUESTED','CONFIRMED','WAITLISTED','RESCHEDULED','CANCELLED',
                          'REJECTED','CALLED','IN_CONSULTATION','COMPLETED','NO_SHOW')
                     NOT NULL DEFAULT 'REQUESTED',
    start_time       DATETIME    NOT NULL,                     -- stored as UTC
    end_time         DATETIME    NOT NULL,                     -- stored as UTC
    reason           VARCHAR(255),
    version          INT         NOT NULL DEFAULT 1,
    idempotency_key  VARCHAR(100) NOT NULL,
    created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
    live_start       DATETIME GENERATED ALWAYS AS (
        CASE WHEN state IN ('REQUESTED','CONFIRMED','RESCHEDULED','CALLED','IN_CONSULTATION')
             THEN start_time ELSE NULL END) STORED,

    CONSTRAINT chk_appt_time CHECK (end_time > start_time),
    UNIQUE KEY uq_appt_idem (idempotency_key),
    UNIQUE KEY uq_token     (doctor_id, appointment_date, token_number),
    UNIQUE KEY uq_live_slot (doctor_id, live_start),
    KEY idx_appt_patient   (patient_id, appointment_date),
    KEY idx_appt_doc_day   (doctor_id, appointment_date, state),
    KEY idx_appt_date      (appointment_date),
    FOREIGN KEY (patient_id) REFERENCES Patient(patient_id),
    FOREIGN KEY (doctor_id)  REFERENCES Doctor(doctor_id)
);

/* ---------- 7. Audit_Log (append-only) ---------- */
CREATE TABLE Audit_Log (
    audit_id       CHAR(36)     PRIMARY KEY,                   -- UUID
    actor          VARCHAR(100) NOT NULL,
    action         VARCHAR(60)  NOT NULL,
    entity         VARCHAR(40)  NOT NULL,
    entity_id      VARCHAR(64)  NOT NULL,
    before_json    JSON NULL,
    after_json     JSON NULL,
    correlation_id VARCHAR(64)  NOT NULL,
    source_service VARCHAR(40)  NOT NULL,
    created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_audit_corr   (correlation_id),
    KEY idx_audit_entity (entity, entity_id),
    KEY idx_audit_time   (created_at)
);

DELIMITER $$
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON Audit_Log
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit_Log is append-only: UPDATE not allowed';
END$$
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON Audit_Log
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit_Log is append-only: DELETE not allowed';
END$$
DELIMITER ;

/* ---------- 8. Outbox_Event (live updates for Team D) ---------- */
CREATE TABLE Outbox_Event (
    event_id     BIGINT PRIMARY KEY AUTO_INCREMENT,            -- also the "since" cursor
    type         VARCHAR(60) NOT NULL,
    payload_json JSON        NOT NULL,
    created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    delivered    TINYINT(1)  NOT NULL DEFAULT 0,
    KEY idx_outbox_delivered (delivered, event_id)
);

/* =====================================================================
   SEED DATA
   ===================================================================== */

/* Users: 1 admin, 4 doctors, 4 patients */
INSERT INTO Users (public_id, name, email, phone, role) VALUES
('AD-001', 'Scheduling Admin',   'admin@gmail.com',    NULL,         'ADMIN'),
('DR-001', 'Dr. Rahul Patil',    'rahul@hospital.com', '9876543210', 'PROVIDER'),
('DR-002', 'Dr. Sneha Joshi',    'sneha@hospital.com', '9876543211', 'PROVIDER'),
('DR-003', 'Dr. Amit Shah',      'amit@hospital.com',  '9876543212', 'PROVIDER'),
('DR-004', 'Dr. Priya Deshmukh', 'priya@hospital.com', '9876543213', 'PROVIDER'),
('PT-0001','Aarav Patil',        'aarav@gmail.com',    '9876500001', 'PATIENT'),
('PT-0002','Sneha Jadhav',       'sneha@gmail.com',    '9876500002', 'PATIENT'),
('PT-0003','Rahul Mane',         'rahul@gmail.com',    '9876500003', 'PATIENT'),
('PT-0004','Priya Shah',         'priya@gmail.com',    '9876500004', 'PATIENT');

/* Doctors - doctor_id 1..4 so public ids DR-001..DR-004 line up */
INSERT INTO Doctor (user_id, public_id, specialization, service, status, daily_token_limit, department_id)
SELECT u.user_id, u.public_id, x.spec, x.service, 'ACTIVE', 30,
       (SELECT department_id FROM Department WHERE department_name = x.dep)
FROM Users u
JOIN (SELECT 'DR-001' pid, 'Cardiologist'       spec, 'Cardiologist'  service, 'Cardiology'  dep UNION ALL
      SELECT 'DR-002', 'Neurologist',          'Neurologist',        'Neurology'   UNION ALL
      SELECT 'DR-003', 'Orthopedic Surgeon',   'Orthopedics',        'Orthopedics' UNION ALL
      SELECT 'DR-004', 'Dermatologist',        'Dermatologist',      'Dermatology') x
  ON x.pid = u.public_id
ORDER BY u.public_id;

/* Patients - patient_id 1..4 so PT-0001..PT-0004 line up */
INSERT INTO Patient (user_id, public_id, date_of_birth, gender, address)
SELECT u.user_id, u.public_id, x.dob, x.gender, x.addr
FROM Users u
JOIN (SELECT 'PT-0001' pid, '2002-05-15' dob, 'Male'   gender, 'Islampur'  addr UNION ALL
      SELECT 'PT-0002', '2001-08-20', 'Female', 'Sangli'    UNION ALL
      SELECT 'PT-0003', '1998-12-10', 'Male',   'Kolhapur'  UNION ALL
      SELECT 'PT-0004', '2000-03-25', 'Female', 'Pune') x
  ON x.pid = u.public_id
ORDER BY u.public_id;

/* Working hours: every doctor, today + next 13 days, 09:00-17:00 */
INSERT INTO Doctor_Schedule (doctor_id, available_date, start_time, end_time)
SELECT d.doctor_id, DATE_ADD(CURDATE(), INTERVAL n.n DAY), '09:00:00', '17:00:00'
FROM Doctor d
CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL
            SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL
            SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL
            SELECT 12 UNION ALL SELECT 13) n;

/* Appointments (tomorrow + day after; times are UTC) */
INSERT INTO Appointment
 (public_id, patient_id, doctor_id, appointment_date, token_number, priority, state,
  start_time, end_time, reason, version, idempotency_key)
VALUES
(UUID(), 1, 1, DATE_ADD(CURDATE(), INTERVAL 1 DAY), 1, 'NORMAL', 'CONFIRMED',
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '09:00:00'),
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '09:10:00'), 'Regular heart checkup', 1, 'seed-appt-1'),
(UUID(), 2, 2, DATE_ADD(CURDATE(), INTERVAL 1 DAY), 1, 'NORMAL', 'REQUESTED',
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '09:00:00'),
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '09:10:00'), 'Headache and dizziness', 1, 'seed-appt-2'),
(UUID(), 3, 3, DATE_ADD(CURDATE(), INTERVAL 2 DAY), 1, 'NORMAL', 'CONFIRMED',
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 2 DAY), '09:00:00'),
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 2 DAY), '09:10:00'), 'Knee pain', 1, 'seed-appt-3'),
(UUID(), 4, 4, DATE_ADD(CURDATE(), INTERVAL 2 DAY), 1, 'NORMAL', 'CANCELLED',
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 2 DAY), '09:00:00'),
 TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 2 DAY), '09:10:00'), 'Skin allergy', 2, 'seed-appt-4');

/* Audit rows for the seed bookings (100% audit coverage) */
INSERT INTO Audit_Log (audit_id, actor, action, entity, entity_id, before_json, after_json,
                       correlation_id, source_service)
SELECT UUID(), 'system:seed', 'APPOINTMENT_CREATED', 'appointment', a.public_id, NULL,
       JSON_OBJECT('state', a.state, 'token_number', a.token_number, 'version', a.version),
       'seed-run', 'team-c-seed'
FROM Appointment a;

/* =====================================================================
   SAMPLE QUERIES (your original ones, updated for the new design)
   ===================================================================== */
SELECT * FROM Department;
SELECT * FROM v_doctor;
SELECT * FROM v_patient;
SELECT * FROM Doctor_Schedule WHERE available_date = CURDATE();
SELECT * FROM Appointment;

-- Upcoming appointments of one patient
SELECT a.public_id AS appointment_id, a.appointment_date, a.token_number, a.start_time,
       a.state, a.reason, d.doctor_name, d.specialization, d.department_name
FROM Appointment a
JOIN Patient p  ON p.patient_id = a.patient_id
JOIN v_doctor d ON d.doctor_id  = a.doctor_id
WHERE p.public_id = 'PT-0001'
  AND a.appointment_date >= CURDATE()
  AND a.state IN ('REQUESTED','CONFIRMED','RESCHEDULED','WAITLISTED')
ORDER BY a.appointment_date, a.start_time;

-- Search doctors by department
SELECT doctor_id, public_id, doctor_name, specialization, department_name
FROM v_doctor WHERE department_name = 'Cardiology';

-- Doctors available on a date
SELECT d.public_id, d.doctor_name, d.specialization, ds.available_date, ds.start_time, ds.end_time
FROM v_doctor d
JOIN Doctor_Schedule ds ON ds.doctor_id = d.doctor_id
WHERE ds.available_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY);
