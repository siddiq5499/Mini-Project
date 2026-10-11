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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

/**
 * Team A — OS scheduling engine as a REST service (port 4001).
 *
 * GET  /health
 * GET  /api/v1/providers/{id}/queue     ready-queue order (PCB + PRIORITY/FCFS)
 * GET  /api/v1/metrics/scheduling       queue depth, throughput, wait, starvation
 * POST /api/v1/schedule                 demo dispatch of a single request
 *
 * Auth: Authorization: Bearer &lt;SERVICE_KEY&gt; (not required for /health).
 * Appointments are loaded from Team C; Team A never writes the database.
 */
public class SchedulerServer {
    private static final List<String> WAITING = List.of("REQUESTED", "CONFIRMED", "RESCHEDULED");
    private static final List<String> DONE = List.of("COMPLETED", "CANCELLED", "NO_SHOW", "REJECTED");

    public static void main(String[] args) throws Exception {
        loadDotEnv(Path.of("..", ".env"));
        loadDotEnv(Path.of(".env"));

        int port = Integer.parseInt(env("PORT", "4001"));
        String key = env("SERVICE_KEY", env("TEAM_A_KEY", "team-a-careslot-local"));
        AppointmentScheduler.Policy policy = parsePolicy(env("POLICY", "PRIORITY"));
        TeamCClient teamC = new TeamCClient(env("TEAM_C_URL", "http://localhost:4000"),
                env("TEAM_C_KEY", ""));

        AppointmentScheduler demo = new AppointmentScheduler(new AppointmentScheduler.ProviderCalendar(), policy);
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", ex -> handle(ex, key, policy, teamC, demo));
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        System.out.println("Team A scheduler listening on http://localhost:" + port);
        System.out.println("Policy: " + policy);
        System.out.println("Team C: " + (teamC.enabled() ? env("TEAM_C_URL", "") : "NOT configured (demo queue only)"));
        System.out.println("Auth: Authorization: Bearer " + key);
    }

    private static void handle(HttpExchange ex, String key, AppointmentScheduler.Policy policy,
                               TeamCClient teamC, AppointmentScheduler demo) throws IOException {
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

            Snapshot snap = snapshot(teamC, policy);

            if ("GET".equals(method) && "/api/v1/metrics/scheduling".equals(path)) {
                send(ex, 200, envelope(snap.metrics));
                return;
            }
            if ("GET".equals(method) && path.startsWith("/api/v1/providers/") && path.endsWith("/queue")) {
                String id = path.substring("/api/v1/providers/".length(), path.length() - "/queue".length());
                List<Map<String, Object>> rows = new ArrayList<>();
                for (AppointmentScheduler.QueueEntry e : snap.queue.stream()
                        .filter(q -> id.equals(qProvider(snap, q.appointmentId)))
                        .toList()) {
                    rows.add(queueJson(e));
                }
                send(ex, 200, envelope(rows));
                return;
            }
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
                demo.submit(req);
                demo.run();
                List<Map<String, Object>> decisions = new ArrayList<>();
                for (AppointmentScheduler.SchedulingDecision d : demo.getDecisions()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("request_id", d.toString().split(":")[0].replace("Request ", "").trim());
                    row.put("detail", d.toString());
                    decisions.add(row);
                }
                send(ex, 200, envelope(Map.of(
                        "policy", policy.name(),
                        "last_decision", demo.getDecisions().isEmpty() ? null
                                : demo.getDecisions().get(demo.getDecisions().size() - 1).toString(),
                        "metrics", Map.of(
                                "received", demo.metrics().received,
                                "scheduled", demo.metrics().scheduled,
                                "rejected", demo.metrics().rejected
                        ),
                        "note", "Demo dispatch only. Live clinic queue is GET /providers/{id}/queue (from Team C)."
                )));
                return;
            }
            send(ex, 404, error("NOT_FOUND", "Unknown Team A endpoint: " + method + " " + path));
        } catch (Exception e) {
            send(ex, 500, error("INTERNAL_ERROR", e.getMessage() == null ? "Team A error" : e.getMessage()));
        }
    }

    private static String qProvider(Snapshot snap, String appointmentId) {
        return snap.providerByAppt.getOrDefault(appointmentId, "");
    }

    private record Snapshot(List<AppointmentScheduler.QueueEntry> queue,
                            Map<String, String> providerByAppt,
                            Map<String, Object> metrics) {}

    private static Snapshot snapshot(TeamCClient teamC, AppointmentScheduler.Policy policy) throws Exception {
        List<AppointmentScheduler.LiveAppointment> all = teamC.enabled()
                ? teamC.listAppointments() : List.of();
        List<AppointmentScheduler.LiveAppointment> waiting = all.stream()
                .filter(a -> a.appointmentId != null && WAITING.contains(String.valueOf(a.state)))
                .toList();

        AppointmentScheduler engine = new AppointmentScheduler(new AppointmentScheduler.ProviderCalendar(), policy);
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
        metrics.put("queue_depth", waiting.size());
        metrics.put("live_appointments", live);
        metrics.put("throughput_per_hour", Math.round((completed * 10.0 / hour) * 10) / 10.0);
        metrics.put("avg_wait_minutes", Math.round(avgWait * 10) / 10.0);
        metrics.put("starvation_alerts", AppointmentScheduler.starvationAlerts(queue));
        metrics.put("policy", policy.name());
        metrics.put("as_of", LocalDate.now().toString());
        metrics.put("source", teamC.enabled() ? "team-c" : "empty");
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
        h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
