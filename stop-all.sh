#!/usr/bin/env bash
# ============================================================
#  CareSlot — Stop All Backend Services (Linux / macOS)
# ============================================================

echo ""
echo "  ======================================================"
echo "     CareSlot — Stopping All Backend Services"
echo "  ======================================================"
echo ""

PORTS=(3000 4000 4001 4002)

for PORT in "${PORTS[@]}"; do
    PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [ -n "$PID" ]; then
        echo "[*] Stopping service on port $PORT (PID $PID)..."
        kill -9 $PID 2>/dev/null || true
    else
        echo "[-] No service found running on port $PORT"
    fi
done

echo ""
echo "  All CareSlot services stopped!"
echo ""
