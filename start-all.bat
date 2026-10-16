@echo off
REM ============================================================
REM  CareSlot — Start All Backend Services (Windows)
REM  This script starts all 4 backend microservices.
REM  Prerequisites: Node.js 18+, Java 17+, MySQL 8.0+
REM ============================================================

echo.
echo  ======================================================
echo     CareSlot — Starting All Backend Services
echo  ======================================================
echo.

REM --- 1. Team C: Database Service (Port 4000) ---
echo [1/4] Starting Team C — Database Service (Port 4000)...
cd /d "%~dp0backend\team-c-database-service"
if not exist node_modules (
    echo       Installing dependencies...
    call npm install
)
start "CareSlot: Team C (Port 4000)" cmd /k "title CareSlot: Team C - Database Service & node src/server.js"
cd /d "%~dp0"
timeout /t 3 /nobreak > nul

REM --- 2. Team A: OS Scheduler Engine (Port 4001) ---
echo [2/4] Starting Team A — Scheduler Engine (Port 4001)...
cd /d "%~dp0backend\team-a-scheduler"
if not exist SchedulerServer.class (
    echo       Compiling Java files...
    javac SchedulerServer.java AppointmentScheduler.java Json.java TeamCClient.java
)
start "CareSlot: Team A (Port 4001)" cmd /k "title CareSlot: Team A - Scheduler Engine & java SchedulerServer"
cd /d "%~dp0"
timeout /t 2 /nobreak > nul

REM --- 3. Team B: Availability Engine (Port 4002) ---
echo [3/4] Starting Team B — Availability Engine (Port 4002)...
cd /d "%~dp0backend\team-b-availability"
start "CareSlot: Team B (Port 4002)" cmd /k "title CareSlot: Team B - Availability Engine & mvn compile exec:java -Dexec.mainClass=com.teamb.scheduler.Main -q"
cd /d "%~dp0"
timeout /t 2 /nobreak > nul

REM --- 4. Team D: Gateway + Frontend (Port 3000) ---
echo [4/4] Starting Team D — Gateway + Frontend (Port 3000)...
cd /d "%~dp0backend\team-d-gateway"
start "CareSlot: Team D (Port 3000)" cmd /k "title CareSlot: Team D - Gateway & node server.js"
cd /d "%~dp0"

echo.
echo  ======================================================
echo     All services started! Open http://localhost:3000
echo  ======================================================
echo.
echo  Service URLs:
echo    Frontend:        http://localhost:3000
echo    Team C (DB):     http://localhost:4000
echo    Team A (Sched):  http://localhost:4001
echo    Team B (Avail):  http://localhost:4002
echo.
echo  Admin Login:  admin@gmail.com / A@1234567
echo.
pause
