@echo off
REM ============================================================
REM  CareSlot — Stop All Backend Services (Windows)
REM  Terminates processes listening on ports 3000, 4000, 4001, 4002
REM ============================================================

echo.
echo  ======================================================
echo     CareSlot — Stopping All Backend Services
echo  ======================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3000, 4000, 4001, 4002; " ^
  "foreach ($port in $ports) { " ^
  "  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; " ^
  "  if ($conns) { " ^
  "    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique; " ^
  "    foreach ($id in $pids) { " ^
  "      Write-Host ('[*] Stopping service on port ' + $port + ' (PID ' + $id + ')'); " ^
  "      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; " ^
  "    } " ^
  "  } else { " ^
  "    Write-Host ('[-] No service running on port ' + $port); " ^
  "  } " ^
  "}"

echo.
echo  ======================================================
echo     All CareSlot services stopped!
echo  ======================================================
echo.
