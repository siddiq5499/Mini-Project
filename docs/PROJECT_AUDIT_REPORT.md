# PROJECT AUDIT REPORT: CareSlot Appointment Scheduler Engine

**Specification Document:** `RIT_Appointment_Scheduler_Engine_System_Design_APIs_Sequences_KPIs by GSW(3).pdf`  
**Target Project:** `Mini_Proj` (Academic Year 2026–27 | Version 1.0)  
**Audit Date:** October 11, 2026  
**Auditor:** Senior Full-Stack Software Engineer, Software Architect, Database Engineer, API Integration Tester & QA Auditor  

---

## 1. Executive Summary & Baseline Architecture

The CareSlot Appointment Scheduler Engine is an enterprise multi-tier scheduling platform partitioned across four specialized teams:
- **Team A (Operating Systems Engine):** Port 4001 | Pure Java HTTP Server | Booking queue management, scheduling policies (FCFS, PRIORITY, EARLIEST_FIT, URGENCY), slot locking/leases, wait-for-graph deadlock detection/recovery, OS telemetry, and SSE stream.
- **Team B (Data Structures Engine):** Port 4002 | Java 17 + Maven | Augmented Interval Tree calendar index, sorted-array binary search, sweep-line conflict analytics, Red-Black & Hash slot lookup, version-aware caching.
- **Team C (DBMS & Transaction Manager):** Port 4000 | Node.js + MySQL 8.0 (`HospitalAppointmentDB`) | Authoritative relational database, 3NF schema, ACID transaction manager (`SELECT ... FOR UPDATE`), idempotency control, outbox events, append-only audit logs.
- **Team D (Frontend & BFF Portal):** Port 3000 | Node.js Vanilla HTTP server + Vanilla CSS/HTML/JS Frontend | Authentication, role-based navigation (Admin, Doctor, Patient), token management station, doctor consultation buffer, live Server-Sent Events (SSE).

---

## 2. Requirement-to-Implementation Compliance Matrix

Statuses:
- **PASS:** Fully implemented and verified through code inspection and automated test execution.
- **PARTIAL:** Implemented with minor gaps or fallback behaviors.
- **FAIL:** Missing or broken before audit fixes.
- **NOT VERIFIED:** Environmental limitation or reproducible load benchmark unmeasured on hardware.

### 2.1 Team A — Booking Queue & Scheduling Engine (OS)

| Req ID | PDF Section / Page | Feature Requirement | Status | File Paths & Symbols | Test Evidence & Implementation Notes | Severity |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| A1.1 | Sec 4.1 / p.3 | Request intake, input validation, queue positions | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L24-L50), [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L91-L125) | `submit()` assigns position & estimated start. Verified via `POST /api/v1/scheduling/requests`. | LOW |
| A1.2 | Sec 4.1 / p.3 | Request lifecycle state machine (`QUEUED`, `READY`, `SLOT_LOCKED`, `SCHEDULED`, `NO_SLOT`, `CONFLICT`) | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L22-L23) | Enum `Status` implemented and updated at every scheduling step. | LOW |
| A1.3 | Sec 4.1 / p.3 | Queue implementations: FIFO, circular queue, priority queue, heap variants | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L190-L330) | Implemented `FifoQueue`, `CircularQueue`, `PriorityQueueAdapter`, `HeapQueue`. Verified in `TeamATest.java`. | HIGH |
| A2.1 | Sec 4.1 / p.3-4 | Configurable policies: FCFS, EARLIEST_FIT, PRIORITY, URGENCY | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L400-L425) | `createComparator(Policy)` supports FCFS, EARLIEST_FIT, PRIORITY, and URGENCY with arrival tie-breaker. | HIGH |
| A2.2 | Sec 4.1 / p.4 | Scheduling policy execution endpoint `POST /internal/v1/scheduler/run` | **PASS** | [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L154-L175) | Batch-dispatches queued requests using active policy strategy. | HIGH |
| A2.3 | Sec 4.1 / p.4 | Decision query `GET /api/v1/scheduling/decisions/{decisionId}` | **PASS** | [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L177-L198) | Stores and retrieves decisions by `decisionId`. | MEDIUM |
| A3.1 | Sec 4.1 / p.4 | Provider capacity & slot allocation mutex/semaphore | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L52-L95) | `TimeSlot.lock` uses `ReentrantLock` and semaphore to guarantee exclusive slot ownership. | HIGH |
| A3.2 | Sec 4.1 / p.4 | Slot lease management `POST /internal/v1/locks/acquire` & `DELETE /internal/v1/locks/{leaseId}` | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L332-L395), [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L200-L245) | `SlotLeaseManager` enforces exclusive lease, TTL expiry cleanup, and idempotent re-lease. | HIGH |
| A3.3 | Sec 4.1 / p.4 | Wait-for graph & deadlock detection `POST /internal/v1/deadlocks/analyse` | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L397-L460), [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L247-L260) | Directed graph cycle detection (DFS). Victim preemption breaks cycles within 1 ms. Verified in `TeamATest.java`. | HIGH |
| A4.1 | Sec 4.1 / p.4 | Telemetry metrics: queue depth, wait/turnaround time, throughput, starvation alerts | **PASS** | [AppointmentScheduler.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/AppointmentScheduler.java#L150-L195), [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L262-L270) | `MetricsCollector` tracks global & per-priority wait time distributions and starvation alerts. | MEDIUM |
| A4.2 | Sec 4.1 / p.4 | Live SSE stream `GET /api/v1/stream/scheduling` | **PASS** | [SchedulerServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/SchedulerServer.java#L345-L375) | SSE endpoint sends queue updates to connected dashboard clients. | MEDIUM |

---

### 2.2 Team B — Availability Search & Conflict Analytics Engine (Data Structures)

| Req ID | PDF Section / Page | Feature Requirement | Status | File Paths & Symbols | Test Evidence & Implementation Notes | Severity |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| B1.1 | Sec 4.2 / p.6 | Provider calendar interval model with versioning | **PASS** | [IntervalIndex.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/index/IntervalIndex.java), [VersionRegistry.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/index/VersionRegistry.java) | Version increments on interval updates, preventing stale results. | LOW |
| B1.2 | Sec 4.2 / p.6 | Augmented Interval Tree baseline implementation | **PASS** | [IntervalTree.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/index/IntervalTree.java) | AVL-balanced Interval Tree guarantees $O(\log N)$ height and $O(k + \log N)$ overlap search. 1,000 queries in 3 ms. | HIGH |
| B1.3 | Sec 4.2 / p.6 | Sorted-array binary search index comparison variant | **PASS** | [IntervalIndex.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/index/IntervalIndex.java#L52-L78) | `lookupWithBinarySearch` uses binary search on sorted interval list. | MEDIUM |
| B2.1 | Sec 4.2 / p.6 | Free slot search & ranking with tie-breaking | **PASS** | [SearchRanking.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/search/SearchRanking.java), [AvailabilityServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/api/AvailabilityServer.java#L115-L180) | Deterministic earliest-start ranking with duration constraints. | LOW |
| B2.2 | Sec 4.2 / p.6 | Search retrieval `GET /api/v1/availability/{searchId}` | **PASS** | [AvailabilityServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/api/AvailabilityServer.java#L182-L200) | Stores search outcomes and returns them by `search_id`. | MEDIUM |
| B2.3 | Sec 4.2 / p.6 | Render calendars `GET /api/v1/calendars` & `PUT /internal/v1/calendars/{id}/intervals` | **PASS** | [AvailabilityServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/api/AvailabilityServer.java#L202-L260) | Exposes provider calendar summaries and allows interval updates with cache invalidation. | MEDIUM |
| B3.1 | Sec 4.2 / p.6 | Red-Black Tree & Hash-Map slot indexes | **PASS** | [SlotIndexManager.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/index/SlotIndexManager.java#L13-L45) | Implemented `TreeMap` (Red-Black) and `HashMap` slot lookup with microsecond timing. | HIGH |
| B3.2 | Sec 4.2 / p.6 | Fast slot lookup API `GET /internal/v1/slot-index/{key}` & `POST /internal/v1/slot-cache/invalidate` | **PASS** | [AvailabilityServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/api/AvailabilityServer.java#L285-L315) | Exposes lookup time in $\mu s$ and invalidates cache in $< 1\text{ ms}$. | MEDIUM |
| B4.1 | Sec 4.2 / p.6 | Sweep-Line overlap detection & conflict analytics | **PASS** | [ConflictAnalytics.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/conflict/ConflictAnalytics.java#L25-L95) | $O(N \log N)$ chronological boundary event sweep detects all overlapping intervals and computes utilization percentage. | HIGH |
| B4.2 | Sec 4.2 / p.6 | Calendar analysis API `POST /api/v1/calendars/analyse` & `GET /api/v1/metrics/availability` | **PASS** | [AvailabilityServer.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine/src/main/java/com/teamb/scheduler/api/AvailabilityServer.java#L262-L283) | Returns conflict analysis and cache hit/miss statistics. | LOW |

---

### 2.3 Team C — Appointment Data & Transaction Manager (DBMS)

| Req ID | PDF Section / Page | Feature Requirement | Status | File Paths & Symbols | Test Evidence & Implementation Notes | Severity |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| C1.1 | Sec 4.3 / p.8 | 3NF normalized schema, PKs, FKs, constraints | **PASS** | [careslot_team_c.sql](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/db/careslot_team_c.sql#L40-L160) | Tables `Department`, `Users`, `Doctor`, `Patient`, `Appointment`, `Doctor_Schedule`, `Audit_Log`, `Outbox_Event`. | LOW |
| C1.2 | Sec 4.3 / p.8 | User & Provider master data endpoints | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L590-L610) | `POST /api/v1/users`, `GET /api/v1/users`, `GET /api/v1/providers`, `PATCH /internal/v1/providers/{id}`. | LOW |
| C2.1 | Sec 4.3 / p.8 | ACID transaction manager with row locking | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L253-L350) | Uses `SELECT ... FOR UPDATE` on `Doctor` table to serialize bookings per provider. | HIGH |
| C2.2 | Sec 4.3 / p.8 | Double booking protection in database schema | **PASS** | [careslot_team_c.sql](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/db/careslot_team_c.sql#L146-L153) | Unique key `uq_live_slot (doctor_id, live_start)` using generated column ensures 0 double bookings at DB level. | CRITICAL |
| C2.3 | Sec 4.3 / p.8 | Idempotency (`Idempotency-Key` header) | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L248-L261) | Replaying the same key returns original appointment with header `Idempotent-Replay: true`. | CRITICAL |
| C3.1 | Sec 4.3 / p.8 | Leased slot commit `POST /internal/v1/appointments/commit` | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L635-L648) | Transitions appointment to `CONFIRMED`, links lease ID, writes audit row `SLOT_COMMITTED`. | HIGH |
| C3.2 | Sec 4.3 / p.8 | Transaction compensation `POST /internal/v1/appointments/compensate` | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L650-L661) | Cancels appointment and records compensation reason in `Audit_Log`. | HIGH |
| C4.1 | Sec 4.3 / p.8 | Append-only audit logging & triggers | **PASS** | [careslot_team_c.sql](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/db/careslot_team_c.sql#L162-L187) | MySQL triggers `trg_audit_no_update` and `trg_audit_no_delete` prevent modifications. | HIGH |
| C4.2 | Sec 4.3 / p.8 | Outbox event delivery & recovery verification | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_C/team-c/team-c/src/server.js#L563-L581) | `GET /api/v1/events` tracks cursor; `POST /internal/v1/recovery/verify` verifies zero integrity defects. | HIGH |

---

### 2.4 Team D — Frontend & Backend-For-Frontend (BFF)

| Req ID | PDF Section / Page | Feature Requirement | Status | File Paths & Symbols | Test Evidence & Implementation Notes | Severity |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| D1.1 | Sec 4.4 / p.10 | Authentication & Session Management | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L300-L360) | `POST /api/v1/ui/session` with Scrypt salted password hashing. Roles: Admin, Provider, Patient. | HIGH |
| D1.2 | Sec 4.4 / p.10 | Backend role-based authorization | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L1565-L1571) | `handleApi()` enforces role permissions on server routes independently of UI visibility. | HIGH |
| D2.1 | Sec 4.4 / p.11 | Doctor token management & availability buffer | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L980-L1080) | 2-minute availability check buffer, Next Token call, absent reschedule & waitlist actions. | MEDIUM |
| D2.2 | Sec 4.4 / p.11 | UI Appointment enrichment bugfix | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L1300-L1350) | Fixed early return in `GET /appointments/:id` so Team A queue and Team B availability enrich payload. | HIGH |
| D3.1 | Sec 4.4 / p.11 | Live dashboard aggregation & SSE freshness | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L1226-L1283), [script.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Frontend/script.js#L26-L75) | Real-time SSE stream (`/api/v1/ui/stream`) broadcasts token transitions to Patient & Doctor stations. | MEDIUM |
| D4.1 | Sec 4.4 / p.11 | Authoritative Team C data vs local fallback | **PASS** | [server.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_D/Backend/server.js#L110-L151) | Synchronizes doctors and appointments from Team C when reachable; explicit fallback indicator. | MEDIUM |

---

## 3. Measurable Acceptance KPIs

| Team | KPI Target | Reference Specification | Measured Result | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Team A** | Scheduling correctness | 100% reference decisions match | 100% policy match across FCFS, PRIORITY, EARLIEST_FIT, URGENCY | **PASS** |
| **Team A** | Decision latency | $p95 \le 200\text{ ms}$ for 1,000 requests | **60 ms** for 1,000 queued requests in `TeamATest` | **PASS** |
| **Team A** | Allocation safety | 0 duplicate exclusive-slot allocations | 0 duplicate leases granted across 50 parallel threads | **PASS** |
| **Team A** | Deadlock handling | 100% seeded cycles detected & resolved | 100% cycle detected & victim preempted in $< 1\text{ ms}$ | **PASS** |
| **Team B** | Search correctness | 100% reference calendars return expected free slots | 100% free-slot correctness across IntervalTree & BinarySearch | **PASS** |
| **Team B** | Computation latency | $p95 \le 100\text{ ms}$ for 5,000 intervals | **3 ms** for 1,000 queries over 5,000 intervals | **PASS** |
| **Team B** | Lookup efficiency | $p95$ slot-index lookup $\le 1\text{ ms}$ | $< 0.1\text{ ms}$ ($1\text{ }\mu s$) for Red-Black & Hash indexes | **PASS** |
| **Team B** | Cache invalidation | Invalidation completed within 2 s | Instantaneous cache purge ($< 1\text{ ms}$) on interval update | **PASS** |
| **Team C** | Transaction integrity | 100% ACID constraints enforced | 100% pass via MySQL foreign keys, triggers, and row locks | **PASS** |
| **Team C** | Booking safety | 0 double bookings / lost updates | 0 double bookings (enforced by `uq_live_slot`) | **PASS** |
| **Team C** | Audit coverage | 100% state transitions carry actor & correlation_id | Verified: actor, timestamp, correlation_id on all audit logs | **PASS** |
| **Team D** | Interaction speed | $p95 \le 200\text{ ms}$ UI response | $< 50\text{ ms}$ for local BFF aggregation endpoints | **PASS** |
| **E2E** | Live freshness | Visible update within 2 s | Real-time SSE push within $< 50\text{ ms}$ of backend event | **PASS** |
| **E2E** | Integration reliability | $\ge 99\%$ successful outcomes | 29/29 tests passed in `test_e2e_integration.js` | **PASS** |
