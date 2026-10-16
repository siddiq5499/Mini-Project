# 🩺 CareSlot — Clinic Appointment Scheduling System

<div align="center">

**A multi-service, microservice-based hospital appointment scheduling platform**  
*Built with Node.js, Java, MySQL, and Vanilla HTML/CSS/JS*

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)]()
[![Java](https://img.shields.io/badge/Java-17%2B-ED8B00?logo=openjdk&logoColor=white)]()
[![MySQL](https://img.shields.io/badge/MySQL-8.0%2B-4479A1?logo=mysql&logoColor=white)]()
[![License](https://img.shields.io/badge/License-UNLICENSED-red)]()

</div>

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup & Installation](#setup--installation)
- [Starting the Application](#starting-the-application)
- [Service Details](#service-details)
- [API Documentation](#api-documentation)
- [Default Credentials](#default-credentials)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Team Contributions](#team-contributions)

---

## 🔭 Overview

**CareSlot** is a full-stack, clinic appointment token management system that supports:

- **Patient self-registration** and appointment booking
- **Admin-controlled token queue** with Call Next / Terminate functionality
- **Doctor dashboard** with patient consultation tracking
- **Emergency priority tokens** that jump ahead of normal queue
- **2-minute availability buffer** for patient check-in
- **Real-time updates** via Server-Sent Events (SSE)
- **Multi-doctor, multi-department** scheduling with daily token limits

The system is divided into **4 microservices** (Teams A–D) that communicate via REST APIs with correlation IDs, idempotency keys, and pre-shared Bearer tokens.

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT (Browser)                         │
│              frontend/ (HTML + CSS + JS)                    │
│                    Port: 3000                               │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP / SSE
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              TEAM D — BFF Gateway (Port 3000)               │
│  backend/team-d-gateway/server.js                           │
│  • Serves frontend static files                            │
│  • User authentication (Scrypt hashing)                    │
│  • Orchestrates calls to Teams A, B, C                     │
│  • SSE broadcasting for real-time updates                  │
└─────┬──────────────────┬──────────────────┬─────────────────┘
      │ REST             │ REST             │ REST
      ▼                  ▼                  ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  TEAM A  │    │   TEAM B     │    │   TEAM C     │
│ Scheduler│    │ Availability │    │  Database    │
│ (Port    │    │ (Port 4002)  │    │  Service     │
│  4001)   │    │              │    │ (Port 4000)  │
│ Java 17  │    │  Java 17     │    │  Node.js     │
│ In-memory│    │  H2 DB +     │    │  MySQL 8.0   │
│ queues   │    │  Interval    │    │              │
│          │    │  Trees       │    │              │
└──────────┘    └──────────────┘    └──────┬───────┘
                                          │ SQL
                                          ▼
                                   ┌──────────────┐
                                   │   MySQL 8.0  │
                                   │ Hospital     │
                                   │ AppointmentDB│
                                   └──────────────┘
```

### Service Communication Flow

```
Patient → Team D (BFF) → Team B (search available slots)
                       → Team C (book appointment via ACID transaction)
                       → Team A (queue management + slot locking)
```

---

## 📁 Project Structure

```
Mini_ProjCombine/
│
├── frontend/                          # 🎨 Frontend (Vanilla HTML/CSS/JS)
│   ├── index.html                     #    Main portal page (login, dashboard, booking)
│   ├── script.js                      #    Client-side logic (65KB+ SPA)
│   └── style.css                      #    Styling (24KB+)
│
├── backend/                           # ⚙️ Backend Microservices
│   │
│   ├── team-a-scheduler/              #    Team A — OS Scheduling Engine (Java)
│   │   ├── AppointmentScheduler.java  #      Core scheduler (Heap/Circular/FIFO queues)
│   │   ├── SchedulerServer.java       #      HTTP REST server (Port 4001)
│   │   ├── Json.java                  #      Zero-dependency JSON parser
│   │   ├── TeamCClient.java           #      REST client → Team C
│   │   ├── TeamATest.java             #      Integration tests
│   │   └── .env                       #      Configuration (PORT, SERVICE_KEY, POLICY)
│   │
│   ├── team-b-availability/           #    Team B — Availability Search Engine (Java/Maven)
│   │   ├── pom.xml                    #      Maven build (Jackson, H2, JUnit)
│   │   ├── src/main/java/com/teamb/   #      Java source packages
│   │   │   └── scheduler/
│   │   │       ├── Main.java          #        Application entry point
│   │   │       ├── api/               #        REST API handlers
│   │   │       ├── search/            #        Interval tree + sweep-line search
│   │   │       ├── conflict/          #        Conflict analytics
│   │   │       ├── db/                #        H2 database layer
│   │   │       ├── model/             #        Data models
│   │   │       ├── client/            #        Team C REST client
│   │   │       ├── index/             #        Slot indexing
│   │   │       ├── validator/         #        Input validation
│   │   │       ├── result/            #        Result types
│   │   │       └── exception/         #        Custom exceptions
│   │   ├── src/main/resources/        #      Static resources
│   │   │   └── index.html             #        Team B demo UI
│   │   ├── data/                      #      H2 database files
│   │   └── .env                       #      Configuration (PORT, SERVICE_KEY)
│   │
│   ├── team-c-database-service/       #    Team C — DBMS & Transaction Manager (Node.js)
│   │   ├── src/server.js              #      REST API server (Port 4000, MySQL)
│   │   ├── db/careslot_team_c.sql     #      MySQL schema (also in database/)
│   │   ├── package.json               #      Dependencies (mysql2)
│   │   ├── tests/                     #      API tests, load tests, recovery drills
│   │   ├── openapi.yaml               #      OpenAPI specification
│   │   └── .env                       #      Configuration (DB credentials, SERVICE_KEY)
│   │
│   └── team-d-gateway/                #    Team D — BFF Gateway (Node.js)
│       ├── server.js                  #      Main server (Port 3000, serves frontend)
│       ├── teamA-client.js            #      REST client → Team A
│       ├── teamB-client.js            #      REST client → Team B
│       ├── teamC-client.js            #      REST client → Team C
│       ├── practice-teams.js          #      Mock Team A/B/C for testing
│       ├── package.json               #      Zero external dependencies
│       ├── data/store.json            #      Local JSON store (fallback)
│       ├── openapi-team-d.yaml        #      OpenAPI specification
│       └── .env                       #      Configuration (Team URLs + keys)
│
├── database/                          # 🗄️ Database Schemas & Data
│   ├── careslot_team_c.sql            #    MySQL schema + seed data + sample queries
│   ├── availabilitydb.mv.db           #    H2 database (Team B availability data)
│   └── README.md                      #    Database documentation
│
├── docs/                              # 📚 Project Documentation & Reports
│   ├── INTEGRATION_REPORT.md          #    Service architecture & cross-team contracts
│   ├── PROJECT_AUDIT_REPORT.md        #    Full project audit findings
│   ├── DATABASE_RESET_PLAN.md         #    Database reset procedures
│   ├── TEST_RESULTS.md                #    Test execution results
│   ├── REMAINING_TASKS.md             #    Pending tasks tracker
│   └── PDF_SPEC_EXTRACTED.txt         #    Original spec extraction
│
├── .gitignore                         # 🙈 Git ignore rules
├── start-all.bat                      # 🚀 One-click start script (Windows)
├── start-all.sh                       # 🚀 One-click start script (Linux/Mac)
└── README.md                          # 📖 This file
```

---

## 📦 Prerequisites

Before running the project, ensure the following are installed:

| Requirement | Version | Download |
|:------------|:--------|:---------|
| **Node.js** | ≥ 18.x | [nodejs.org](https://nodejs.org) |
| **Java JDK** | ≥ 17 | [adoptium.net](https://adoptium.net) |
| **Maven** | ≥ 3.8 | [maven.apache.org](https://maven.apache.org) |
| **MySQL** | ≥ 8.0 | [mysql.com](https://dev.mysql.com/downloads/) |

### Verify Installations

```bash
node --version      # Should show v18.x or higher
java --version      # Should show 17 or higher
mvn --version       # Should show 3.8 or higher
mysql --version     # Should show 8.0 or higher
```

---

## 🔧 Setup & Installation

### Step 1: Set Up the MySQL Database

```bash
# Connect to MySQL
mysql -u root -p

# Run the schema file (creates database, tables, seed data)
source database/careslot_team_c.sql
```

This creates the `HospitalAppointmentDB` database with all tables, views, triggers, and seed data.

### Step 2: Install Node.js Dependencies

```bash
# Team C — Database Service
cd backend/team-c-database-service
npm install

# Team D — Gateway (zero dependencies, no npm install needed)
cd ../team-d-gateway
# No dependencies to install!
```

### Step 3: Build Team B (Java/Maven)

```bash
cd backend/team-b-availability
mvn compile
```

### Step 4: Compile Team A (Java)

```bash
cd backend/team-a-scheduler
javac SchedulerServer.java AppointmentScheduler.java Json.java TeamCClient.java
```

### Step 5: Configure Environment Variables

Each service has a `.env` file pre-configured for local development. Review and update if needed:

| Service | File | Key Settings |
|:--------|:-----|:-------------|
| Team A | `backend/team-a-scheduler/.env` | `PORT=4001`, `POLICY=PRIORITY` |
| Team B | `backend/team-b-availability/.env` | `PORT=4002` |
| Team C | `backend/team-c-database-service/.env` | `PORT=4000`, `DB_USER`, `DB_PASSWORD` |
| Team D | `backend/team-d-gateway/.env` | `TEAM_A_URL`, `TEAM_B_URL`, `TEAM_C_URL` |

---

## 🚀 Starting the Application

### Option 1: One-Click Start (Recommended)

**Windows:**
```bash
# Double-click or run from terminal:
start-all.bat
```

**Linux/Mac:**
```bash
chmod +x start-all.sh
./start-all.sh
```

This starts all 4 services and opens `http://localhost:3000` automatically.

### Option 2: Start Services Individually

Start the services **in this order** (Team C first, since others depend on it):

**Terminal 1 — Team C (Database Service):**
```bash
cd backend/team-c-database-service
npm start
# → Listening on http://localhost:4000
```

**Terminal 2 — Team A (Scheduler Engine):**
```bash
cd backend/team-a-scheduler
java SchedulerServer
# → Listening on http://localhost:4001
```

**Terminal 3 — Team B (Availability Engine):**
```bash
cd backend/team-b-availability
mvn compile exec:java -Dexec.mainClass=com.teamb.scheduler.Main
# → Listening on http://localhost:4002
```

**Terminal 4 — Team D (Gateway + Frontend):**
```bash
cd backend/team-d-gateway
node server.js
# → CareSlot running at http://localhost:3000
```

### Option 3: Quick Start (Team D Only — Standalone Mode)

If you want to test just the frontend + gateway without Teams A/B/C:

```bash
cd backend/team-d-gateway
node server.js
# → Uses local store.json as fallback (no MySQL needed)
```

Open **http://localhost:3000** in your browser.

---

## 🔌 Service Details

### Team A — OS Scheduling Engine (Port 4001)

| Aspect | Detail |
|:-------|:-------|
| **Language** | Java 17 (zero dependencies) |
| **Purpose** | Queue management, slot locking, scheduling policies |
| **Policies** | PRIORITY (Emergency first), FIFO, ROUND_ROBIN |
| **Data** | In-memory queues (Heap, Circular, FIFO) + Slot Leases |

**Key Endpoints:**
- `POST /api/v1/scheduling/requests` — Submit scheduling request
- `GET /api/v1/providers/{id}/queue` — Get provider queue
- `POST /internal/v1/locks/acquire` — Acquire slot lease
- `POST /internal/v1/deadlocks/analyse` — Deadlock detection
- `GET /api/v1/metrics/scheduling` — Scheduling metrics
- `GET /health` — Health check

### Team B — Availability Search Engine (Port 4002)

| Aspect | Detail |
|:-------|:-------|
| **Language** | Java 17 (Maven: Jackson, H2, JUnit) |
| **Purpose** | Free slot search, conflict detection, calendar analytics |
| **Algorithms** | Augmented Interval Tree, Sweep-line, Slot Cache |
| **Data** | H2 embedded database |

**Key Endpoints:**
- `POST /api/v1/availability/search` — Search free slots
- `GET /api/v1/calendars` — List all calendars
- `POST /api/v1/calendars/analyse` — Conflict analytics
- `GET /api/v1/metrics/availability` — Availability metrics
- `GET /health` — Health check

### Team C — DBMS & Transaction Manager (Port 4000)

| Aspect | Detail |
|:-------|:-------|
| **Language** | Node.js 18+ (mysql2) |
| **Purpose** | Authoritative data store, ACID transactions, audit logging |
| **Isolation** | READ COMMITTED + SELECT ... FOR UPDATE |
| **Data** | MySQL 8.0 (`HospitalAppointmentDB`) |

**Key Endpoints:**
- `GET /api/v1/providers` — List doctors
- `POST /api/v1/appointments` — Book appointment (idempotent)
- `POST /internal/v1/appointments/{id}/transition` — State transition
- `GET /api/v1/audit` — Audit trail
- `GET /api/v1/events?since=N` — Event outbox polling
- `GET /health` — Health check

### Team D — BFF Gateway + Frontend (Port 3000)

| Aspect | Detail |
|:-------|:-------|
| **Language** | Node.js 18+ (zero dependencies) |
| **Purpose** | Frontend serving, authentication, orchestration |
| **Auth** | Scrypt password hashing, session tokens |
| **Frontend** | Vanilla HTML/CSS/JS SPA |

**Key Endpoints:**
- `POST /api/v1/ui/session` — Login
- `POST /api/v1/ui/register` — Patient registration
- `GET /api/v1/ui/appointments` — List appointments
- `POST /api/v1/ui/appointments` — Book appointment
- `GET /api/v1/ui/stream` — SSE live updates
- `GET /` — Serve frontend

---

## 📖 API Documentation

- **Team C:** [`backend/team-c-database-service/openapi.yaml`](backend/team-c-database-service/openapi.yaml)
- **Team D:** [`backend/team-d-gateway/openapi-team-d.yaml`](backend/team-d-gateway/openapi-team-d.yaml)

All APIs follow a consistent **envelope format**:

```json
// Success
{
  "data": { ... },
  "meta": { "correlation_id": "...", "api_version": "v1" }
}

// Error
{
  "error": { "code": "TOKENS_FULL", "message": "...", "details": [] },
  "meta": { "correlation_id": "..." }
}
```

---

## 🔑 Default Credentials

| Role | Email | Password | Notes |
|:-----|:------|:---------|:------|
| **Admin** | `admin@gmail.com` | `A@1234567` | Full access: manage doctors, tokens, queue |
| **Doctor** | `rahul@hospital.com` | `Doctor@123` | DR-001 (Cardiologist) |
| **Doctor** | `sneha@hospital.com` | `Doctor@123` | DR-002 (Neurologist) |
| **Doctor** | `amit@hospital.com` | `Doctor@123` | DR-003 (Orthopedic Surgeon) |
| **Doctor** | `priya@hospital.com` | `Doctor@123` | DR-004 (Dermatologist) |
| **Patient** | *Register via UI* | *User-chosen* | Self-registration on the portal |

---

## ✨ Features

### Patient Portal
- ✅ Self-registration with email/phone
- ✅ Browse doctors by department
- ✅ Book appointments with specific time slots
- ✅ View appointment status and token number
- ✅ Real-time queue position updates (SSE)
- ✅ Cancel appointments

### Admin Dashboard
- ✅ Call Next Token (moves queue forward)
- ✅ Terminate consultation
- ✅ Issue Emergency Priority Tokens
- ✅ Configure daily token limits per doctor
- ✅ Developer Reset (clear appointments, keep credentials)
- ✅ View all appointments and queue status

### Doctor Dashboard
- ✅ View today's patient queue
- ✅ 2-minute buffer window for patient check-in
- ✅ "Consultancy Going On" mode (no countdown timer)
- ✅ Mark patients as present/absent

### System Features
- ✅ Multi-service microservice architecture
- ✅ ACID transactions with double-booking protection
- ✅ Append-only audit trail
- ✅ Idempotent booking (retry-safe)
- ✅ Correlation ID tracing across all services
- ✅ Graceful degradation (Team D works standalone if others are down)
- ✅ Server-Sent Events for real-time updates

---

## 🛠 Tech Stack

| Layer | Technology |
|:------|:-----------|
| **Frontend** | HTML5, CSS3, Vanilla JavaScript (SPA) |
| **Backend (Teams C, D)** | Node.js 18+ (zero/minimal dependencies) |
| **Backend (Teams A, B)** | Java 17 (HttpServer, Maven) |
| **Primary Database** | MySQL 8.0 (InnoDB, ACID) |
| **Secondary Database** | H2 (embedded, Team B) |
| **Communication** | REST/JSON, SSE, Bearer Token Auth |
| **Build Tool** | Maven 3.8+ (Team B) |

---

## 👥 Team Contributions

| Team | Module | Responsibility |
|:-----|:-------|:---------------|
| **Team A** | OS Scheduling Engine | Queue data structures (Heap, Circular, FIFO), scheduling policies (Priority, FIFO, Round Robin), slot lease management, deadlock detection |
| **Team B** | Availability Search Engine | Interval tree construction, sweep-line free slot search, conflict analytics, H2 database, calendar management |
| **Team C** | DBMS & Transaction Manager | MySQL schema design, ACID transaction handling, audit logging, event outbox, data isolation enforcement |
| **Team D** | BFF Gateway + Frontend Portal | User authentication, frontend SPA, service orchestration, SSE broadcasting, graceful degradation |

---

## 🐛 Troubleshooting

| Issue | Solution |
|:------|:---------|
| `ECONNREFUSED` on port 4000 | Ensure MySQL is running and Team C is started first |
| `java: command not found` | Install Java 17+ and add to PATH |
| `mvn: command not found` | Install Maven 3.8+ and add to PATH |
| `MODULE_NOT_FOUND: mysql2` | Run `npm install` in `backend/team-c-database-service/` |
| Frontend shows blank page | Ensure Team D gateway is running on port 3000 |
| Doctors not showing up | Start Team C first, then restart Team D for sync |

---

## 📄 License

This project is **UNLICENSED** — developed as an academic mini-project.

---

<div align="center">
  <b>Built with ❤️ for the Mini Project</b>
</div>
