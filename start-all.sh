#!/usr/bin/env bash
# ============================================================
#  CareSlot — Start All Backend Services (Linux / macOS)
#  Prerequisites: Node.js 18+, Java 17+, Maven 3.8+, MySQL 8.0+
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ======================================================"
echo "     CareSlot — Starting All Backend Services"
echo "  ======================================================"
echo ""

# --- 1. Team C: Database Service (Port 4000) ---
echo "[1/4] Starting Team C — Database Service (Port 4000)..."
cd "$SCRIPT_DIR/backend/team-c-database-service"
[ ! -d node_modules ] && echo "      Installing dependencies..." && npm install
node src/server.js &
TEAM_C_PID=$!
cd "$SCRIPT_DIR"
sleep 3

# --- 2. Team A: OS Scheduler Engine (Port 4001) ---
echo "[2/4] Starting Team A — Scheduler Engine (Port 4001)..."
cd "$SCRIPT_DIR/backend/team-a-scheduler"
if [ ! -f SchedulerServer.class ]; then
    echo "      Compiling Java files..."
    javac SchedulerServer.java AppointmentScheduler.java Json.java TeamCClient.java
fi
java SchedulerServer &
TEAM_A_PID=$!
cd "$SCRIPT_DIR"
sleep 2

# --- 3. Team B: Availability Engine (Port 4002) ---
echo "[3/4] Starting Team B — Availability Engine (Port 4002)..."
cd "$SCRIPT_DIR/backend/team-b-availability"
mvn compile exec:java -Dexec.mainClass=com.teamb.scheduler.Main -q &
TEAM_B_PID=$!
cd "$SCRIPT_DIR"
sleep 2

# --- 4. Team D: Gateway + Frontend (Port 3000) ---
echo "[4/4] Starting Team D — Gateway + Frontend (Port 3000)..."
cd "$SCRIPT_DIR/backend/team-d-gateway"
node server.js &
TEAM_D_PID=$!
cd "$SCRIPT_DIR"

echo ""
echo "  ======================================================"
echo "     All services started! Open http://localhost:3000"
echo "  ======================================================"
echo ""
echo "  Service URLs:"
echo "    Frontend:        http://localhost:3000"
echo "    Team C (DB):     http://localhost:4000"
echo "    Team A (Sched):  http://localhost:4001"
echo "    Team B (Avail):  http://localhost:4002"
echo ""
echo "  Admin Login:  admin@gmail.com / A@1234567"
echo ""
echo "  PIDs: Team C=$TEAM_C_PID, Team A=$TEAM_A_PID, Team B=$TEAM_B_PID, Team D=$TEAM_D_PID"
echo "  Press Ctrl+C to stop all services."
echo ""

# Trap SIGINT to kill all background processes
trap 'echo "Stopping all services..."; kill $TEAM_C_PID $TEAM_A_PID $TEAM_B_PID $TEAM_D_PID 2>/dev/null; exit 0' SIGINT SIGTERM

# Wait for all background processes
wait
