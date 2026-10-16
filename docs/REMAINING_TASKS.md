# REMAINING TASKS & OPERATIONAL GUIDE

**Project:** CareSlot Appointment Scheduler Engine (`Mini_Proj`)  
**Status:** All 11 Phases Completed (including Safe Database Reset)  
**Date:** October 11, 2026  

---

## 1. Phase Status Summary

- [x] **Phase 1: Project Baseline & Inspection** — Complete.
- [x] **Phase 2: Audit Team A (OS Engine)** — Complete & Verified.
- [x] **Phase 3: Audit Team B (Data Structures Engine)** — Complete & Verified.
- [x] **Phase 4: Audit Team C (DBMS Engine)** — Complete & Verified.
- [x] **Phase 5: Audit Team D (Frontend & BFF Portal)** — Complete & Verified.
- [x] **Phase 6: End-to-End System Integration** — Complete & Verified.
- [x] **Phase 7: Missing-Requirements Report** — [PROJECT_AUDIT_REPORT.md](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/PROJECT_AUDIT_REPORT.md) generated.
- [x] **Phase 8: Fix Verified Problems Safely** — Complete across all 4 services.
- [x] **Phase 9: Run Tests and Verify Fixes** — [TEST_RESULTS.md](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/TEST_RESULTS.md) generated (82/82 tests passing).
- [x] **Phase 10: Safe Database Data Reset** — **EXECUTED (Option B)**:
  - Backup created: `Team_D\Backend\data\store_backup_20261011_231947.json`.
  - Transaction-safe deletion executed: Removed all operational patients, doctors, schedules, and events.
  - Verified Admin account (`AD-001` / `admin@gmail.com`) intact and successfully logged in.
- [x] **Phase 11: Final Deliverables** — All documentation artifacts published to the root directory.

---

## 2. Startup Commands for Each Service

All four services can be run concurrently in separate terminal windows:

### Terminal 1: Team C (DBMS & Transaction Manager — Port 4000)
```powershell
cd c:\Users\siddi\OneDrive\Desktop\Mini_Proj\Team_C\team-c\team-c
node src\server.js
```
*Health Check:* `http://localhost:4000/health`

### Terminal 2: Team A (Booking Queue & OS Scheduler Engine — Port 4001)
```powershell
cd c:\Users\siddi\OneDrive\Desktop\Mini_Proj\Team_A\scheduler
javac AppointmentScheduler.java Json.java SchedulerServer.java TeamCClient.java
java SchedulerServer
```
*Health Check:* `http://localhost:4001/health`

### Terminal 3: Team B (Availability Search & Conflict Analytics Engine — Port 4002)
```powershell
cd c:\Users\siddi\OneDrive\Desktop\Mini_Proj\Team_B\TeamB_Availability_Engine
mvn compile "-Dexec.mainClass=com.teamb.scheduler.Main" exec:java
```
*Health Check:* `http://localhost:4002/health`

### Terminal 4: Team D (Frontend & BFF Portal — Port 3000)
```powershell
cd c:\Users\siddi\OneDrive\Desktop\Mini_Proj\Team_D\Backend
node server.js
```
*Health Check:* `http://localhost:3000/api/v1/health`  
*Browser Portal:* `http://localhost:3000/`

---

## 3. Testing the Clean Slate System

1. Open `http://localhost:3000/` in your browser.
2. Log in using your existing Admin credentials (`admin@gmail.com`).
3. You will see a clean dashboard with 0 active tokens, 0 doctors, and 0 appointments.
4. As Admin, you can add new doctors, configure their token capacities, set working schedules, and book new appointments.
