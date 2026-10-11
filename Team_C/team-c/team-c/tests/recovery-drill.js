'use strict';
/**
 * Backup + restore drill (Team C KPI: RPO <= 5 min, RTO <= 30 min).
 *   Windows PowerShell:  $env:SERVICE_KEY="<key>"; node tests/recovery-drill.js
 * It NEVER touches your live data: it dumps HospitalAppointmentDB, restores the dump into a scratch database
 * (<name>_recovery_test), compares every table's row count, and reports the time taken.
 * Needs the MySQL command-line tools (mysqldump, mysql). If they are not on PATH set MYSQL_BIN to their folder,
 * e.g.  $env:MYSQL_BIN="C:\Program Files\MySQL\MySQL Server 8.0\bin"
 * Reads DB_* from ../.env. Writes tests/recovery-report.json
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; });
const mysql = require('mysql2/promise');
const E = (k, d = '') => process.env[k] || d;
const bin = (n) => (E('MYSQL_BIN') ? path.join(E('MYSQL_BIN'), n) : n);
const cfg = { host: E('DB_HOST', '127.0.0.1'), port: E('DB_PORT', '3306'), user: E('DB_USER', 'root'), password: E('DB_PASSWORD'), db: E('DB_NAME', 'HospitalAppointmentDB') };
const scratch = cfg.db + '_recovery_test';
const base = ['-h', cfg.host, '-P', cfg.port, '-u', cfg.user];
const env = { ...process.env, MYSQL_PWD: cfg.password };
const dumpFile = path.join(__dirname, 'backup-' + Date.now() + '.sql');
const TABLES = ['Department', 'Users', 'Doctor', 'Patient', 'Doctor_Schedule', 'Appointment', 'Audit_Log', 'Outbox_Event'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(bin(cmd), args, { env, encoding: 'utf8', maxBuffer: 1 << 30, shell: process.platform === 'win32', ...opts });
  if (r.error || r.status !== 0) { console.error(`FAILED: ${cmd}\n${r.error ? r.error.message : r.stderr}\nIf the command is not found, set MYSQL_BIN (see the top of this file).`); process.exit(1); }
  return r;
}
async function counts(db) {
  const c = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), user: cfg.user, password: cfg.password, database: db });
  const out = {};
  for (const t of TABLES) out[t] = Number((await c.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n);
  const [[last]] = await c.query('SELECT MAX(created_at) at FROM Audit_Log');
  await c.end();
  return { out, last: last.at };
}

(async () => {
  const t0 = Date.now();
  const before = await counts(cfg.db);
  const lastWrite = before.last ? new Date(String(before.last).replace(' ', 'T') + 'Z') : null;

  const tb = Date.now();
  const dump = run('mysqldump', [...base, '--single-transaction', '--routines', '--triggers', '--result-file=' + dumpFile, cfg.db]);
  const backupMs = Date.now() - tb;
  const backupTakenAt = new Date();

  const tr = Date.now();
  run('mysql', [...base, '-e', `DROP DATABASE IF EXISTS \`${scratch}\`; CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4;`]);
  run('mysql', [...base, scratch], { input: fs.readFileSync(dumpFile) });
  const restoreMs = Date.now() - tr;

  const after = await counts(scratch);
  const same = TABLES.every((t) => before.out[t] === after.out[t]);
  const report = {
    live_database: cfg.db, scratch_database: scratch, dump_file: path.basename(dumpFile), dump_bytes: fs.statSync(dumpFile).size,
    backup_seconds: backupMs / 1000, restore_seconds: restoreMs / 1000, total_seconds: (Date.now() - t0) / 1000,
    rto_estimate_minutes: Math.round(((backupMs + restoreMs) / 60000) * 100) / 100, rto_target_minutes: 30,
    rpo_note: 'RPO = time between the last committed write and the newest backup. With a backup scheduled every 5 minutes the worst case is 5 minutes.',
    newest_audit_write: lastWrite ? lastWrite.toISOString() : null, backup_taken_at: backupTakenAt.toISOString(),
    row_counts_live: before.out, row_counts_restored: after.out, all_tables_match: same,
    pass: same && (backupMs + restoreMs) / 60000 <= 30
  };
  fs.writeFileSync(path.join(__dirname, 'recovery-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nRESULT: restore ${same ? 'MATCHES' : 'DIFFERS'} | RTO estimate ${report.rto_estimate_minutes} min (target <= 30) -> ${report.pass ? 'PASS' : 'FAIL'}`);
  console.log(`Run the live integrity check too:  POST /internal/v1/recovery/verify  (see RECOVERY.md)`);
  console.log('The scratch database ' + scratch + ' can be dropped when you are done:  DROP DATABASE ' + scratch + ';');
})().catch((e) => { console.error(e.message); process.exit(1); });
