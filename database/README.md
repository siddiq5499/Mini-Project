# 🗄️ CareSlot — Database Layer

This folder contains the database schemas and data files used by the CareSlot appointment scheduling system.

## Files

| File | Database | Used By | Description |
|:-----|:---------|:--------|:------------|
| `careslot_team_c.sql` | MySQL 8.0 (`HospitalAppointmentDB`) | Team C (Database Service) | Full relational schema with tables, views, triggers, seed data and sample queries |
| `availabilitydb.mv.db` | H2 (Embedded) | Team B (Availability Engine) | Embedded H2 database file for availability search and conflict analytics |

## MySQL Schema — `HospitalAppointmentDB`

### Tables

| Table | Purpose |
|:------|:--------|
| `Department` | Hospital departments (Cardiology, Neurology, etc.) |
| `Users` | Unified user profiles — patients, doctors, admins (no passwords; Team D manages auth) |
| `Doctor` | Doctor specialization, status, daily token limit |
| `Patient` | Patient demographics (DOB, gender, address) |
| `Doctor_Schedule` | Working hours per doctor per date |
| `Appointment` | Bookings with token numbers, states, time slots, idempotency keys |
| `Audit_Log` | Append-only audit trail for every state change (immutable via triggers) |
| `Outbox_Event` | Event outbox for live SSE updates to Team D |

### Views

| View | Purpose |
|:-----|:--------|
| `v_doctor` | Joins Doctor + Users + Department for easy doctor queries |
| `v_patient` | Joins Patient + Users for easy patient queries |

### Appointment States

```
REQUESTED → CONFIRMED → CALLED → IN_CONSULTATION → COMPLETED
    ↓           ↓          ↓           ↓
WAITLISTED  CANCELLED  NO_SHOW    CANCELLED
    ↓
REJECTED
```

## Setup Instructions

### MySQL (Team C)

```bash
# 1. Ensure MySQL 8.0+ is running
# 2. Run the schema file (this resets all data — dev only)
mysql -u root -p < careslot_team_c.sql
```

### H2 (Team B)

The H2 database is embedded and managed automatically by the Team B Java application. No manual setup is required — just ensure the `data/` directory exists inside `backend/team-b-availability/`.

## Seed Data

The SQL file seeds the following test data:
- **6 Departments**: Cardiology, Neurology, Orthopedics, Dermatology, Pediatrics, General
- **1 Admin**: `admin@gmail.com`
- **4 Doctors**: Dr. Rahul Patil (Cardiology), Dr. Sneha Joshi (Neurology), Dr. Amit Shah (Orthopedics), Dr. Priya Deshmukh (Dermatology)
- **4 Patients**: Aarav Patil, Sneha Jadhav, Rahul Mane, Priya Shah
- **14-day schedule** for all doctors (09:00–17:00)
- **4 sample appointments** with audit trail entries
