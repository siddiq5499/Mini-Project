import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

/**
 * Team A — OS scheduling engine as a REST service (port 4001).
 *
 * Implements full PDF specifications:
 * - POST   /api/v1/scheduling/requests         intake & queue placement (idempotent)
 * - GET    /api/v1/providers/{id}/queue        ready-queue order & estimated starts
 * - GET    /api/v1/scheduling/requests/{id}    request lifecycle state
 * - POST   /internal/v1/scheduler/run          dispatch/execute policy
 * - GET    /api/v1/scheduling/decisions/{id}   read scheduling decision
 * - POST   /internal/v1/locks/acquire          slot lease allocation
 * - DELETE /internal/v1/locks/{leaseId}        release reservation lease
 * - POST   /internal/v1/deadlocks/analyse      wait-for-graph cycle analysis & resolution
 * - GET    /api/v1/metrics/scheduling          scheduling telemetry & metrics
 * - GET    /api/v1/stream/scheduling           SSE live dashboard stream
 * - GET    /health                             health check
 * - POST   /api/v1/schedule                    legacy/demo dispatch
 */
public class SchedulerServer {
    private static final List<String> WAITING = List.of("REQUESTED", "CONFIRMED", "RESCHEDULED");
    private static final List<String> DONE = List.of("COMPLETED", "CANCELLED", "NO_SHOW", "REJECTED");
    private static final List<HttpExchange> sseClients = new CopyOnWriteArrayList<>();

    public static void main(String[] args) throws Exception {
        loadDotEnv(Path.of("..", ".env"));
        loadDotEnv(Path.of(".env"));

        int port = Integer.parseInt(env("PORT", "4001"));
        String key = env("SERVICE_KEY", env("TEAM_A_KEY", "team-a-careslot-local"));
        AppointmentScheduler.Policy policy = parsePolicy(env("POLICY", "PRIORITY"));
        TeamCClient teamC = new TeamCClient(env("TEAM_C_URL", "http://localhost:4000"),
                env("TEAM_C_KEY", ""));

        AppointmentScheduler engine = new AppointmentScheduler(new AppointmentScheduler.ProviderCalendar(), policy);
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", ex -> handle(ex, key, policy, teamC, engine));
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        System.out.println("Team A scheduler listening on http://localhost:" + port);
        System.out.println("Policy: " + policy);
        System.out.println("Team C: " + (teamC.enabled() ? env("TEAM_C_URL", "") : "NOT configured (demo queue only)"));
        System.out.println("Auth: Authorization: Bearer " + key);
    }

    private static void handle(HttpExchange ex, String key, AppointmentScheduler.Policy policy,
                               TeamCClient teamC, AppointmentScheduler engine) throws IOException {
        cors(ex);
        if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(204, -1);
            ex.close();
            return;
        }
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod();
        try {
            if ("GET".equals(method) && ("/health".equals(path) || "/".equals(path))) {
                send(ex, 200, Map.of("status", "ok", "team", "A", "policy", policy.name(),
                        "team_c", teamC.enabled()));
                return;
            }
            if (!authorized(ex, key)) {
                send(ex, 401, error("UNAUTHENTICATED", "Missing or invalid service key."));
                return;
            }

            // -------------------------------------------------------------
            // GET /api/v1/stream/scheduling (SSE Stream)
            // -------------------------------------------------------------
            if ("GET".equals(method) && "/api/v1/stream/scheduling".equals(path)) {
                handleSse(ex);
                return;
            }

            // -------------------------------------------------------------
            // POST /api/v1/scheduling/requests (Intake & Enqueue)
            // -------------------------------------------------------------
            if ("POST".equals(method) && "/api/v1/scheduling/requests".equals(path)) {
                String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                Map<String, Object> b = Json.asObj(Json.parse(body.isBlank() ? "{}" : body));
                String reqId = Json.str(b.get("request_id"));
                if (reqId == null || reqId.isBlank()) reqId = UUID.randomUUID().toString();
                String patient = Json.str(b.getOrDefault("user_id", b.getOrDefault("patient", "walk-in")));
                String providerId = Json.str(b.get("provider_id"));
                String service = Json.str(b.get("service_type"));
                int duration = Json.num(b.get("duration_minutes"), 10);
                String prioRaw = Json.str(b.get("priority"));
                AppointmentScheduler.Priority prio = "EMERGENCY".equalsIgnoreCase(prioRaw) || "URGENT".equalsIgnoreCase(prioRaw)
                        ? AppointmentScheduler.Priority.URGENT : AppointmentScheduler.Priority.MEDIUM;
                LocalDateTime pref = AppointmentScheduler.parseIso(Json.str(b.get("preferred_window")));
                if (pref == null) pref = AppointmentScheduler.parseIso(Json.str(b.get("preferred_start")));
                String cid = ex.getRequestHeaders().getFirst("X-Correlation-ID");

                AppointmentScheduler.SchedulingRequest req = new AppointmentScheduler.SchedulingRequest(
                        reqId, patient, providerId, service, duration, prio, pref, LocalDateTime.now(), cid);
                AppointmentScheduler.RequestControlBlock rcb = engine.submit(req);

                Map<String, Object> data = new LinkedHashMap<>();
                data.put("request_id", req.id);
                data.put("queue_position", rcb != null ? rcb.queuePosition : 0);
                data.put("state", rcb != null ? rcb.status.name() : "INVALID");
                data.put("estimated_start", rcb != null && rcb.estimatedStart != null ? rcb.estimatedStart.toString() : null);
                data.put("accepted_policy", policy.name());
                data.put("correlation_id", cid);

                notifySse("scheduling.queued", data);
                send(ex, 201, envelope(data));
                return;
            }

            // -------------------------------------------------------------
            // GET /api/v1/scheduling/requests/{requestId}
            // -------------------------------------------------------------
            if ("GET".equals(method) && path.startsWith("/api/v1/scheduling/requests/")) {
                String reqId = path.substring("/api/v1/scheduling/requests/".length());
                AppointmentScheduler.SchedulingRequest req = engine.getRequestById(reqId);
                if (req == null) {
                    send(ex, 404, error("NOT_FOUND", "Scheduling request not found: " + reqId));
                    return;
                }
                AppointmentScheduler.RequestControlBlock match = null;
                for (AppointmentScheduler.RequestControlBlock r : engine.getQueue().snapshot()) {
                    if (r.request.id.equals(reqId)) { match = r; break; }
                }
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("request_id", req.id);
                data.put("patient", req.patient);
                data.put("provider_id", req.providerId);
                data.put("duration_minutes", req.durationMinutes);
                data.put("priority", req.priority.name());
                data.put("state", match != null ? match.status.name() : "DISPATCHED");
                data.put("queue_position", match != null ? match.queuePosition : null);
                data.put("estimated_start", match != null && match.estimatedStart != null ? match.estimatedStart.toString() : null);
                send(ex, 200, envelope(data));
                return;
            }

            // -------------------------------------------------------------
            // POST /internal/v1/scheduler/run
            // -------------------------------------------------------------
            if ("POST".equals(method) && "/internal/v1/scheduler/run".equals(path)) {
                List<AppointmentScheduler.SchedulingDecision> batch = engine.run();
                List<Map<String, Object>> rows = new ArrayList<>();
                for (AppointmentScheduler.SchedulingDecision d : batch) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("decision_id", d.decisionId);
                    row.put("request_id", d.requestId);
                    row.put("status", d.status.name());
                    row.put("assigned_slot_id", d.slotId);
                    row.put("scheduled_start", d.scheduledStart != null ? d.scheduledStart.toString() : null);
                    row.put("algorithm_version", d.algorithmVersion);
                    row.put("policy", d.policy);
                    row.put("decision_metrics", d.decisionMetrics);
                    rows.add(row);
                }
                notifySse("scheduler.run", Map.of("decisions_count", batch.size()));
                send(ex, 200, envelope(Map.of("decisions", rows, "total", batch.size(), "policy", policy.name())));
                return;
            }

            // -------------------------------------------------------------
            // GET /api/v1/scheduling/decisions/{decisionId}
            // -------------------------------------------------------------
            if ("GET".equals(method) && path.startsWith("/api/v1/scheduling/decisions/")) {
                String decId = path.substring("/api/v1/scheduling/decisions/".length());
                AppointmentScheduler.SchedulingDecision dec = engine.getDecisionById(decId);
                if (dec == null) {
                    send(ex, 404, error("NOT_FOUND", "Decision not found: " + decId));
                    return;
                }
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("decision_id", dec.decisionId);
                data.put("request_id", dec.requestId);
                data.put("status", dec.status.name());
                data.put("assigned_slot_id", dec.slotId);
                data.put("scheduled_start", dec.scheduledStart != null ? dec.scheduledStart.toString() : null);
                data.put("waiting_seconds", dec.waitingSeconds);
                data.put("policy", dec.policy);
                data.put("algorithm_version", dec.algorithmVersion);
                data.put("message", dec.message);
                data.put("decision_metrics", dec.decisionMetrics);
                send(ex, 200, envelope(data));
                return;
            }

            // -------------------------------------------------------------
            // POST /internal/v1/locks/acquire
            // -------------------------------------------------------------
            if ("POST".equals(method) && "/internal/v1/locks/acquire".equals(path)) {
                String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                Map<String, Object> b = Json.asObj(Json.parse(body.isBlank() ? "{}" : body));
                String slotId = Json.str(b.get("slot_id"));
                String holderId = Json.str(b.get("holder_id"));
                int timeout = Json.num(b.get("lease_timeout"), 30);
                if (slotId == null || holderId == null) {
                    send(ex, 400, error("VALIDATION_ERROR", "slot_id and holder_id required"));
                    return;
                }
                AppointmentScheduler.SlotLease lease = engine.getLeaseManager().acquire(slotId, holderId, timeout);
                if (lease == null) {
                    // record wait-for edge if requested
                    engine.getWaitForGraph().addWaitEdge(holderId, slotId);
                    send(ex, 409, envelope(Map.of(
                            "lock_granted", false,
                            "conflict_reason", "Slot already leased to another holder",
                            "deadlock_cycle", engine.getWaitForGraph().detectCycles()
                    )));
                    return;
                }
                send(ex, 200, envelope(Map.of(
                        "lock_granted", true,
                        "lease_id", lease.leaseId,
                        "slot_id", lease.slotId,
                        "holder_id", lease.holderId,
                        "expires_at", lease.expiresAt.toString()
                )));
                return;
            }

            // -------------------------------------------------------------
            // DELETE /internal/v1/locks/{leaseId}
            // -------------------------------------------------------------
            if ("DELETE".equals(method) && path.startsWith("/internal/v1/locks/")) {
                String leaseId = path.substring("/internal/v1/locks/".length());
                boolean released = engine.getLeaseManager().release(leaseId);
                send(ex, 200, envelope(Map.of("lease_id", leaseId, "released", released)));
                return;
            }

            // -------------------------------------------------------------
            // POST /internal/v1/deadlocks/analyse
            // -------------------------------------------------------------
            if ("POST".equals(method) && "/internal/v1/deadlocks/analyse".equals(path)) {
                List<List<String>> cycles = engine.getWaitForGraph().detectCycles();
                String resolvedVictim = null;
                if (!cycles.isEmpty()) {
                    resolvedVictim = engine.getWaitForGraph().resolveDeadlock();
                }
                send(ex, 200, envelope(Map.of(
                        "deadlock_detected", !cycles.isEmpty(),
                        "cycles", cycles,
                        "prevention_or_recovery_action", resolvedVictim != null ? "Aborted victim transaction " + resolvedVictim : "None"
                )));
                return;
            }

            // -------------------------------------------------------------
            // GET /api/v1/metrics/scheduling
            // -------------------------------------------------------------
            Snapshot snap = snapshot(teamC, policy, engine);

            if ("GET".equals(method) && "/api/v1/metrics/scheduling".equals(path)) {
                send(ex, 200, envelope(snap.metrics));
                return;
            }

            // -------------------------------------------------------------
            // GET /api/v1/providers/{id}/queue
            // -------------------------------------------------------------
            if ("GET".equals(method) && path.startsWith("/api/v1/providers/") && path.endsWith("/queue")) {
                String id = path.substring("/api/v1/providers/".length(), path.length() - "/queue".length());
                List<Map<String, Object>> rows = new ArrayList<>();
                for (AppointmentScheduler.QueueEntry e : snap.queue.stream()
                        .filter(q -> id.equals(qProvider(snap, q.appointmentId)))
                        .toList()) {
                    rows.add(queueJson(e));
                }
                // if snap queue was empty, also check internal engine queue
                if (rows.isEmpty()) {
                    for (AppointmentScheduler.RequestControlBlock rcb : engine.getQueue().snapshot()) {
                        if (id.equals(rcb.request.providerId)) {
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("appointment_id", rcb.request.id);
                            m.put("queue_position", rcb.queuePosition);
                            m.put("state", rcb.status.name());
                            m.put("estimated_start", rcb.estimatedStart != null ? rcb.estimatedStart.toString() : null);
                            m.put("patient", rcb.request.patient);
                            m.put("token_number", rcb.queuePosition);
                            m.put("priority", rcb.request.priority.name());
                            m.put("policy", policy.name());
                            rows.add(m);
                        }
                    }
                }
                send(ex, 200, envelope(rows));
                return;
            }

            // -------------------------------------------------------------
            // POST /api/v1/schedule (Legacy/Demo dispatch)
            // -------------------------------------------------------------
            if ("POST".equals(method) && "/api/v1/schedule".equals(path)) {
                String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                Map<String, Object> b = Json.asObj(Json.parse(body.isBlank() ? "{}" : body));
                AppointmentScheduler.SchedulingRequest req = new AppointmentScheduler.SchedulingRequest(
                        Json.str(b.getOrDefault("appointment_id", UUID.randomUUID().toString())),
                        Json.str(b.getOrDefault("patient", "walk-in")),
                        Json.num(b.get("duration_minutes"), 10),
                        "EMERGENCY".equalsIgnoreCase(Json.str(b.get("priority")))
                                ? AppointmentScheduler.Priority.URGENT
                                : AppointmentScheduler.Priority.MEDIUM,
                        AppointmentScheduler.parseIso(Json.str(b.get("preferred_start"))));
                engine.submit(req);
                engine.run();
                List<Map<String, Object>> decisions = new ArrayList<>();
                for (AppointmentScheduler.SchedulingDecision d : engine.getDecisions()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("request_id", d.requestId);
                    row.put("detail", d.toString());
                    decisions.add(row);
                }
                send(ex, 200, envelope(Map.of(
                        "policy", policy.name(),
                        "last_decision", engine.getDecisions().isEmpty() ? null
                                : engine.getDecisions().get(engine.getDecisions().size() - 1).toString(),
                        "metrics", Map.of(
                                "received", engine.metrics().received,
                                "scheduled", engine.metrics().scheduled,
                                "rejected", engine.metrics().rejected
                        ),
                        "note", "Demo dispatch executed."
                )));
                return;
            }

            send(ex, 404, error("NOT_FOUND", "Unknown Team A endpoint: " + method + " " + path));
        } catch (Exception e) {
            send(ex, 500, error("INTERNAL_ERROR", e.getMessage() == null ? "Team A error" : e.getMessage()));
        }
    }

    private static void handleSse(HttpExchange ex) throws IOException {
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.getResponseHeaders().set("Connection", "keep-alive");
        ex.sendResponseHeaders(200, 0);
        sseClients.add(ex);
        OutputStream os = ex.getResponseBody();
        String initial = "event: connected\ndata: {\"status\":\"connected\",\"team\":\"A\"}\n\n";
        os.write(initial.getBytes(StandardCharsets.UTF_8));
        os.flush();
    }

    private static void notifySse(String event, Object data) {
        String msg = "event: " + event + "\ndata: " + Json.val(data) + "\n\n";
        byte[] bytes = msg.getBytes(StandardCharsets.UTF_8);
        for (Iterator<HttpExchange> it = sseClients.iterator(); it.hasNext();) {
            HttpExchange client = it.next();
            try {
                client.getResponseBody().write(bytes);
                client.getResponseBody().flush();
            } catch (Exception e) {
                try { client.close(); } catch (Exception ignored) {}
                sseClients.remove(client);
            }
        }
    }

    private static String qProvider(Snapshot snap, String appointmentId) {
        return snap.providerByAppt.getOrDefault(appointmentId, "");
    }

    private record Snapshot(List<AppointmentScheduler.QueueEntry> queue,
                            Map<String, String> providerByAppt,
                            Map<String, Object> metrics) {}

    private static Snapshot snapshot(TeamCClient teamC, AppointmentScheduler.Policy policy, AppointmentScheduler engine) throws Exception {
        List<AppointmentScheduler.LiveAppointment> all = teamC.enabled()
                ? teamC.listAppointments() : List.of();
        List<AppointmentScheduler.LiveAppointment> waiting = all.stream()
                .filter(a -> a.appointmentId != null && WAITING.contains(String.valueOf(a.state)))
                .toList();

        List<AppointmentScheduler.QueueEntry> queue = new ArrayList<>();
        Map<String, List<AppointmentScheduler.LiveAppointment>> byProvider = new LinkedHashMap<>();
        for (AppointmentScheduler.LiveAppointment a : waiting) {
            byProvider.computeIfAbsent(a.providerId == null ? "" : a.providerId, k -> new ArrayList<>()).add(a);
        }
        for (List<AppointmentScheduler.LiveAppointment> group : byProvider.values()) {
            queue.addAll(engine.dispatchQueue(group));
        }

        Map<String, String> providerByAppt = new LinkedHashMap<>();
        for (AppointmentScheduler.LiveAppointment a : all) {
            if (a.appointmentId != null) providerByAppt.put(a.appointmentId, a.providerId);
        }

        long completed = all.stream().filter(a -> "COMPLETED".equals(a.state)).count();
        long live = all.stream().filter(a -> !DONE.contains(String.valueOf(a.state))).count();
        int hour = Math.max(1, LocalDateTime.now().getHour() - 8);
        double avgWait = queue.isEmpty() ? 0 : queue.stream()
                .mapToInt(q -> (q.queuePosition - 1) * 10).average().orElse(0);

        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("queue_depth", waiting.size() + engine.getQueue().size());
        metrics.put("live_appointments", live);
        metrics.put("throughput_per_hour", Math.round((completed * 10.0 / hour) * 10) / 10.0);
        metrics.put("avg_wait_minutes", Math.round(avgWait * 10) / 10.0);
        metrics.put("starvation_alerts", AppointmentScheduler.starvationAlerts(queue));
        metrics.put("policy", policy.name());
        metrics.put("active_leases", engine.getLeaseManager().activeLeaseCount());
        metrics.put("engine_metrics", engine.metrics().toMap());
        metrics.put("as_of", LocalDate.now().toString());
        metrics.put("source", teamC.enabled() ? "team-c" : "engine");
        return new Snapshot(queue, providerByAppt, metrics);
    }

    private static Map<String, Object> queueJson(AppointmentScheduler.QueueEntry e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("appointment_id", e.appointmentId);
        m.put("queue_position", e.queuePosition);
        m.put("state", e.state);
        m.put("estimated_start", e.estimatedStart);
        m.put("patient", e.patient);
        m.put("token_number", e.tokenNumber);
        m.put("priority", e.priority);
        m.put("policy", e.policy);
        return m;
    }

    private static Map<String, Object> envelope(Object data) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("data", data);
        m.put("meta", Map.of("api_version", "v1", "team", "A"));
        return m;
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code);
        err.put("message", message);
        return Map.of("error", err);
    }

    private static boolean authorized(HttpExchange ex, String key) {
        String hdr = ex.getRequestHeaders().getFirst("Authorization");
        return hdr != null && hdr.equals("Bearer " + key);
    }

    private static void cors(HttpExchange ex) {
        Headers h = ex.getResponseHeaders();
        h.set("Access-Control-Allow-Origin", "*");
        h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Correlation-ID, X-Actor, X-Source-Service");
        h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }

    private static void send(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = Json.val(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static AppointmentScheduler.Policy parsePolicy(String raw) {
        try { return AppointmentScheduler.Policy.valueOf(raw.trim().toUpperCase()); }
        catch (Exception e) { return AppointmentScheduler.Policy.PRIORITY; }
    }

    private static String env(String k, String d) {
        String v = System.getenv(k);
        if (v != null && !v.isBlank()) return v.trim();
        v = System.getProperty(k);
        return v == null || v.isBlank() ? d : v.trim();
    }

    private static void loadDotEnv(Path file) {
        try {
            if (!Files.exists(file)) return;
            for (String line : Files.readAllLines(file)) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                int eq = line.indexOf('=');
                if (eq < 1) continue;
                String k = line.substring(0, eq).trim();
                String v = line.substring(eq + 1).trim().replaceAll("^['\"]|['\"]$", "");
                if (System.getenv(k) == null) System.setProperty(k, v);
            }
        } catch (Exception ignored) { /* optional file */ }
    }
}
