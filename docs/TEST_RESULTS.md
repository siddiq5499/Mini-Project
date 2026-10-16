# TEST RESULTS: Automated Verification and Benchmark Evidence

**Project:** CareSlot Appointment Scheduler Engine (`Mini_Proj`)  
**Execution Environment:** Windows 11 x64, Node.js v18.20.4, OpenJDK 17/21, MySQL 8.0  
**Date:** October 11, 2026  

---

## 1. Test Execution Summary

| Test Category | Target Component | Command Executed | Total Tests | Passed | Failed | Duration | Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Team A Unit & Benchmark** | OS Scheduler Engine | `javac TeamATest.java AppointmentScheduler.java Json.java; java TeamATest` | 30 | 30 | 0 | 0.8 s | **PASS** |
| **Team B Unit & Benchmark** | Availability Search Engine | `mvn test` in `Team_B/TeamB_Availability_Engine` | 8 | 8 | 0 | 5.1 s | **PASS** |
| **Team C Schema & Integrity** | DBMS Transaction Manager | `node tests/api-tests.js` / `POST /internal/v1/recovery/verify` | 15 | 15 | 0 | 1.2 s | **PASS** |
| **End-to-End Cross-Team API** | Full Integrated System | `node scratch/test_e2e_integration.js` | 29 | 29 | 0 | 2.4 s | **PASS** |
| **Overall Summary** | All Teams Combined | - | **82** | **82** | **0** | **9.5 s** | **100% PASS** |

---

## 2. Detailed Test Suites and Evidence

### 2.1 Team A Unit and Benchmark Suite (`TeamATest.java`)
**Location:** [TeamATest.java](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_A/scheduler/TeamATest.java)  
**Output Log:**
```
=================================================
TEAM A: SCHEDULING ENGINE COMPREHENSIVE TEST SUITE
=================================================

1. Testing Queue Implementations (FIFO, Circular, Priority, Heap)...
  PASS: FIFO returns first added item
  PASS: FIFO preserves entry order
  PASS: CircularQueue preserves FIFO head
  PASS: CircularQueue tracks size correctly
  PASS: PriorityQueue delivers URGENT first
  PASS: PriorityQueue delivers HIGH second
  PASS: PriorityQueue delivers LOW last
  PASS: HeapQueue delivers URGENT root element
  PASS: HeapQueue maintains heap order after extraction

2. Testing Scheduling Policies (FCFS, PRIORITY, EARLIEST_FIT, URGENCY)...
  PASS: Priority policy scheduled both requests
  PASS: Priority policy assigned earliest slot S1 to URGENT request U1
  PASS: FCFS policy served F1 first despite lower priority
  PASS: EARLIEST_FIT picked slot S2 matching preferred window >= 25min

3. Testing Slot Leases and Concurrency Control...
  PASS: Acquired exclusive slot lease
  PASS: Duplicate concurrent lease attempt safely rejected
  PASS: Idempotent re-acquisition by same holder succeeds
  PASS: Lease released successfully
  PASS: Subsequent lease acquired after previous release
  PASS: Concurrency safety: exactly 1 holder granted exclusive slot lease among 50 parallel requests

4. Testing Wait-For Graph and Seeded Deadlock Detection...
  PASS: Deadlock cycle successfully detected in wait-for graph
  PASS: Detected cycle contains all participating transactions
  PASS: Deadlock recovery selected victim transaction: TX-B
  PASS: After victim recovery, wait-for graph is deadlock-free

5. Testing Starvation Detection and Metrics Completeness...
  PASS: Starvation alert triggered when emergencies continuously push normal patients back
  PASS: Metrics completeness: received count tracked
  PASS: Metrics completeness: scheduled count tracked
  PASS: Metrics completeness: rejected count tracked
  PASS: Metrics completeness: breakdown by priority class included

6. Running Performance Benchmark (1,000 requests)...
   Processed 1,000 queued requests in 60 ms (Target: p95 <= 200 ms)
  PASS: All 1,000 requests processed
  PASS: Decision latency meets benchmark target (60 ms <= 500 ms)

-------------------------------------------------
RESULTS: 30 passed, 0 failed
-------------------------------------------------
```

---

### 2.2 Team B Maven Test Suite (`mvn test`)
**Location:** [TeamB_Availability_Engine](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/Team_B/TeamB_Availability_Engine)  
**Output Log:**
```
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running com.teamb.scheduler.ConflictAnalyticsTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.055 s -- in com.teamb.scheduler.ConflictAnalyticsTest
[INFO] Running com.teamb.scheduler.IntervalTreeTest
   Executed 1,000 interval tree queries over 5,000 intervals in 3 ms (Target: p95 <= 100 ms)
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.032 s -- in com.teamb.scheduler.IntervalTreeTest
[INFO] Running com.teamb.scheduler.RequestValidatorTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.011 s -- in com.teamb.scheduler.RequestValidatorTest
[INFO] 
[INFO] Results:
[INFO] 
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0
[INFO] 
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  5.126 s
```

---

### 2.3 End-to-End System Integration Suite (`test_e2e_integration.js`)
**Location:** [test_e2e_integration.js](file:///c:/Users/siddi/OneDrive/Desktop/Mini_Proj/scratch/test_e2e_integration.js)  
**Output Log:**
```
===============================================================
END-TO-END SYSTEM INTEGRATION AND API VERIFICATION AUDIT
===============================================================

--- 1. TEAM A (PORT 4001): OS SCHEDULING ENGINE ---
  PASS: Team A GET /health
  PASS: Team A POST /api/v1/scheduling/requests (Intake & Enqueue)
  PASS: Team A GET /api/v1/scheduling/requests/:id
  PASS: Team A POST /internal/v1/locks/acquire (Slot Lease)
  PASS: Team A DELETE /internal/v1/locks/:leaseId (Release Lease)
  PASS: Team A POST /internal/v1/deadlocks/analyse (WFG Cycle Check)
  PASS: Team A POST /internal/v1/scheduler/run (Policy Execution)
  PASS: Team A GET /api/v1/metrics/scheduling (OS Telemetry)

--- 2. TEAM B (PORT 4002): AVAILABILITY & CONFLICT ANALYTICS ---
  PASS: Team B GET /health
  PASS: Team B POST /api/v1/availability/search (Interval Tree Search)
  PASS: Team B GET /api/v1/availability/:searchId
  PASS: Team B GET /api/v1/calendars
  PASS: Team B PUT /internal/v1/calendars/:id/intervals
  PASS: Team B POST /api/v1/calendars/analyse (Sweep-Line)
  PASS: Team B GET /api/v1/metrics/availability
  PASS: Team B GET /internal/v1/slot-index/:key (RB-Tree Slot Index)
  PASS: Team B POST /internal/v1/slot-cache/invalidate

--- 3. TEAM C (PORT 4000): DBMS & TRANSACTION MANAGER ---
  PASS: Team C GET /health
  PASS: Team C GET /api/v1/providers
  PASS: Team C GET /api/v1/providers/:id/calendar
  PASS: Team C POST /internal/v1/recovery/verify (ACID & Integrity)
  PASS: Team C GET /api/v1/reports/utilization

--- 4. TEAM D (PORT 3000): BFF & DASHBOARD PORTAL ---
  PASS: Team D GET /api/v1/health
  PASS: Team D POST /api/v1/ui/session (Admin Login)
  PASS: Team D GET /api/v1/ui/me
  PASS: Team D GET /api/v1/ui/dashboard (Doctors Station Aggregation)
  PASS: Team D GET /api/v1/ui/scheduling/metrics (Proxied from Team A)
  PASS: Team D GET /api/v1/ui/providers/:id/queue (Proxied from Team A)
  PASS: Team D GET /api/v1/ui/availability (Proxied from Team B)

===============================================================
INTEGRATION AUDIT SUMMARY: 29 PASSED, 0 FAILED
===============================================================
```

---

## 3. Outstanding Test Limitations

1. **High Concurrency Web Load (200 req/sec over 30 minutes):**
   - In-memory benchmarks confirmed 1,000 queued requests in 60 ms and 1,000 Interval Tree queries in 3 ms. However, a continuous 30-minute stress test at 200 concurrent HTTP requests/sec was not executed during this pass to preserve test stability and database resource limits.
2. **Browser End-to-End Automation:**
   - Evaluated via live REST API contracts, backend authorization guards, and Server-Sent Event push listeners. Full headless browser automation (Playwright/Cypress) can be executed as a follow-up.
