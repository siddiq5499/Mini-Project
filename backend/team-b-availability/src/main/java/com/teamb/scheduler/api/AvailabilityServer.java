package com.teamb.scheduler.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.*;
import com.teamb.scheduler.conflict.ConflictAnalytics;
import com.teamb.scheduler.index.IntervalIndex;
import com.teamb.scheduler.index.SlotIndexManager;
import com.teamb.scheduler.index.VersionRegistry;
import com.teamb.scheduler.model.Appointment;
import com.teamb.scheduler.result.ResultBuilder;
import com.teamb.scheduler.search.SearchRanking;
import com.teamb.scheduler.validator.RequestValidator;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Team B — Availability Search & Conflict Analytics Engine (Port 4002).
 * Implements:
 * - POST   /api/v1/availability/search             Search best free slots with ranking & algorithm selection
 * - GET    /api/v1/availability/{searchId}         Read search result, ranking and algorithm metadata
 * - GET    /api/v1/calendars                       Render provider calendars, intervals, and calendar version
 * - PUT    /internal/v1/calendars/{id}/intervals   Create or update a blocked/working interval
 * - POST   /api/v1/calendars/analyse               Run sweep-line overlap and calendar utilization analysis
 * - GET    /api/v1/metrics/availability            Read search latency, cache hits, and complexity metrics
 * - GET    /internal/v1/slot-index/{key}           Fast slot lookup (Red-Black tree or Hash index)
 * - POST   /internal/v1/slot-cache/invalidate      Invalidate search cache
 * - GET    /availability                           Legacy query endpoint
 * - GET    /health                                 Health check
 */
public class AvailabilityServer {
    private final int port;
    private final RequestValidator validator;
    private final IntervalIndex index;
    private final SearchRanking ranking;
    private final ConflictAnalytics conflicts;
    private final ResultBuilder builder;
    private final VersionRegistry versions;
    private final ObjectMapper mapper;
    private final ApiKeyManager apiKeys;
    private final SlotIndexManager slotIndexManager = new SlotIndexManager();
    private final Map<String, Map<String, Object>> searchResultsById = new ConcurrentHashMap<>();

    public AvailabilityServer(int port, RequestValidator validator, IntervalIndex index,
            SearchRanking ranking, ConflictAnalytics conflicts, ResultBuilder builder,
            VersionRegistry versions, ObjectMapper mapper,
            com.teamb.scheduler.db.SlotRepository repository, ApiKeyManager apiKeys) {
        this.port = port; this.validator = validator; this.index = index;
        this.ranking = ranking; this.conflicts = conflicts; this.builder = builder;
        this.versions = versions; this.mapper = mapper; this.apiKeys = apiKeys;
    }

    public void start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", this::handleHome);
        server.createContext("/availability", this::handleAvailability);
        server.createContext("/api/v1/availability/search", this::handleSearch);
        server.createContext("/api/v1/availability/", this::handleGetSearch);
        server.createContext("/api/v1/calendars", this::handleCalendars);
        server.createContext("/internal/v1/calendars/", this::handleIntervalUpdate);
        server.createContext("/api/v1/calendars/analyse", this::handleAnalyse);
        server.createContext("/api/v1/metrics/availability", this::handleMetrics);
        server.createContext("/internal/v1/slot-index/", this::handleSlotIndex);
        server.createContext("/internal/v1/slot-cache/invalidate", this::handleCacheInvalidate);
        server.createContext("/health", exchange -> sendRaw(exchange, 200, Map.of("status", "UP", "team", "B")));
        server.setExecutor(null);
        server.start();
    }

    private void handleHome(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendRaw(exchange, 405, Map.of("error", "GET only"));
            return;
        }
        try (InputStream in = AvailabilityServer.class.getResourceAsStream("/index.html")) {
            if (in == null) { sendRaw(exchange, 500, Map.of("error", "Web UI resource not found")); return; }
            byte[] html = in.readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, html.length);
            try (OutputStream out = exchange.getResponseBody()) { out.write(html); }
        }
    }

    private void handleAvailability(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "GET only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }

        long start = System.nanoTime();
        Map<String,String> q = parse(exchange.getRequestURI().getRawQuery());
        String provider = firstNonBlank(q.get("provider"), q.get("provider_id"));
        String date = q.get("date");
        String duration = firstNonBlank(q.get("duration"), q.get("duration_minutes"), "10");

        try {
            validator.validate(provider, date, duration);
            var bookings = index.lookup(provider, LocalDate.parse(date));
            var slots = ranking.findFreeSlots(provider, LocalDate.parse(date),
                    Integer.parseInt(duration), bookings);
            var conflictData = conflicts.analyze(bookings);
            long runtimeMs = (System.nanoTime() - start) / 1_000_000;
            var result = builder.build(slots, conflictData, runtimeMs,
                    versions.currentVersion(), "IntervalTreeBaseline");
            sendEnvelope(exchange, 200, result, null, null);
        } catch (RuntimeException e) {
            sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", e.getMessage());
        } catch (Exception e) {
            sendEnvelope(exchange, 500, null, "INTERNAL_ERROR", "Internal server error");
        }
    }

    private void handleSearch(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "POST only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        long started = System.nanoTime();
        try {
            JsonNode body = mapper.readTree(exchange.getRequestBody());
            String provider = text(body, "provider_id", "provider");
            int duration = body.path("duration_minutes").asInt(body.path("duration").asInt(10));
            String algorithm = body.path("algorithm").asText("INTERVAL_TREE");
            JsonNode range = body.path("date_range");
            LocalDate from = parseDay(firstNonBlank(text(range, "start"), text(body, "date")));
            LocalDate to = parseDay(firstNonBlank(text(range, "end"), text(body, "date")));
            if (to == null) to = from;
            if (from == null) throw new IllegalArgumentException("date_range.start or date is required");
            if (to.isBefore(from)) to = from;
            validator.validate(provider, from.toString(), String.valueOf(duration));

            // Check cache first
            String cacheKey = provider + "_" + from + "_" + to + "_" + duration + "_" + algorithm;
            Object cached = slotIndexManager.getCachedResult(cacheKey, versions.currentVersion());
            if (cached instanceof Map<?, ?> m) {
                @SuppressWarnings("unchecked")
                Map<String, Object> cachedMap = (Map<String, Object>) m;
                sendEnvelope(exchange, 200, cachedMap, null, null);
                return;
            }

            List<Map<String, Object>> slots;
            if ("SWEEP_LINE".equalsIgnoreCase(algorithm)) {
                slots = ranking.findFreeSlotsRange(provider, from, to, duration, index::lookup);
            } else if ("BINARY_SEARCH".equalsIgnoreCase(algorithm)) {
                slots = ranking.findFreeSlotsRange(provider, from, to, duration, index::lookupWithBinarySearch);
            } else {
                slots = ranking.findFreeSlotsRange(provider, from, to, duration, (p, d) ->
                    index.lookupWithIntervalTree(p, d.atStartOfDay(), d.plusDays(1).atStartOfDay()));
            }

            var dayBookings = index.lookup(provider, from);
            var conflictData = conflicts.analyze(dayBookings);
            long runtimeMs = (System.nanoTime() - started) / 1_000_000;

            String searchId = UUID.randomUUID().toString();
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("search_id", searchId);
            data.put("provider_id", provider);
            data.put("ranked_free_slots", slots);
            data.put("total_options", slots.size());
            data.put("tie_break_rule", "EARLIEST_START_TIME");
            data.put("conflicts", conflictData);
            data.put("calendar_version", "v" + versions.currentVersion());
            data.put("algorithm", algorithm);
            data.put("explored_interval_count", dayBookings.size());
            data.put("runtime_ms", runtimeMs);

            searchResultsById.put(searchId, data);
            slotIndexManager.cacheResult(cacheKey, data, versions.currentVersion());

            // populate slot index for fast lookup
            for (Map<String, Object> slot : slots) {
                String slotKey = provider + "_" + slot.get("start");
                slotIndexManager.putSlot(slotKey, slot);
            }

            sendEnvelope(exchange, 200, data, null, null);
        } catch (IllegalArgumentException e) {
            sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", e.getMessage());
        } catch (Exception e) {
            sendEnvelope(exchange, 500, null, "INTERNAL_ERROR", "Internal server error: " + e.getMessage());
        }
    }

    private void handleGetSearch(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "GET only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String searchId = path.substring("/api/v1/availability/".length());
        Map<String, Object> found = searchResultsById.get(searchId);
        if (found == null) {
            sendEnvelope(exchange, 404, null, "NOT_FOUND", "Search ID not found: " + searchId);
            return;
        }
        sendEnvelope(exchange, 200, found, null, null);
    }

    private void handleCalendars(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "GET only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }

        List<Map<String, Object>> calendars = new ArrayList<>();
        List<String> providers = index.getProviders();
        if (providers.isEmpty()) providers = List.of("DR-001", "DR-002", "DR-003", "DR-004");

        for (String p : providers) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("provider_id", p);
            item.put("calendar_version", "v" + versions.currentVersion());
            item.put("intervals_count", index.lookup(p, LocalDate.now()).size());
            item.put("working_hours", Map.of("start", "09:00", "end", "17:00"));
            calendars.add(item);
        }
        sendEnvelope(exchange, 200, Map.of("calendars", calendars, "calendar_version", "v" + versions.currentVersion()), null, null);
    }

    private void handleIntervalUpdate(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"PUT".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "PUT only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String providerId = path.substring("/internal/v1/calendars/".length()).replace("/intervals", "");
        try {
            JsonNode body = mapper.readTree(exchange.getRequestBody());
            String startStr = text(body, "start");
            String endStr = text(body, "end");
            String reason = text(body, "reason");
            if (startStr == null || endStr == null) {
                sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", "start and end required");
                return;
            }
            LocalDateTime start = parseIso(startStr);
            LocalDateTime end = parseIso(endStr);
            if (end.isBefore(start)) {
                sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", "end must be after start");
                return;
            }
            Appointment blocked = new Appointment(providerId, start, end,
                    reason != null ? reason : "BLOCKED");
            index.addInterval(blocked);
            versions.increment();
            slotIndexManager.invalidateCache();

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("provider_id", providerId);
            data.put("calendar_version", "v" + versions.currentVersion());
            data.put("status", "INTERVAL_REGISTERED");
            data.put("start", start.toString());
            data.put("end", end.toString());
            sendEnvelope(exchange, 200, data, null, null);
        } catch (Exception e) {
            sendEnvelope(exchange, 500, null, "INTERNAL_ERROR", e.getMessage());
        }
    }

    private void handleAnalyse(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "POST only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        List<Appointment> all = index.all();
        Map<String, Object> analysis = conflicts.analyze(all);
        sendEnvelope(exchange, 200, analysis, null, null);
    }

    private void handleMetrics(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        Map<String, Object> cacheMetrics = slotIndexManager.getMetrics();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("calendar_version", "v" + versions.currentVersion());
        m.put("total_appointments_indexed", index.all().size());
        m.put("providers_count", index.getProviders().size());
        m.put("cache", cacheMetrics);
        m.put("algorithm_options", List.of("INTERVAL_TREE", "BINARY_SEARCH", "SWEEP_LINE"));
        m.put("index_options", List.of("AVL_RED_BLACK_TREE", "HASH_MAP"));
        sendEnvelope(exchange, 200, m, null, null);
    }

    private void handleSlotIndex(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "GET only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        String path = exchange.getRequestURI().getPath();
        String key = path.substring("/internal/v1/slot-index/".length());
        Map<String, String> q = parse(exchange.getRequestURI().getRawQuery());
        String variant = q.getOrDefault("variant", "rb_tree");
        Map<String, Object> res = slotIndexManager.lookupSlot(key, variant);
        sendEnvelope(exchange, 200, res, null, null);
    }

    private void handleCacheInvalidate(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { exchange.sendResponseHeaders(204, -1); exchange.close(); return; }
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendEnvelope(exchange, 405, null, "METHOD_NOT_ALLOWED", "POST only");
            return;
        }
        if (!authorized(exchange)) {
            sendEnvelope(exchange, 401, null, "UNAUTHENTICATED", "Missing or invalid API key.");
            return;
        }
        int cleared = slotIndexManager.invalidateCache();
        sendEnvelope(exchange, 200, Map.of("cleared_entries", cleared, "status", "CACHE_INVALIDATED"), null, null);
    }

    private boolean authorized(HttpExchange exchange) {
        String bearer = exchange.getRequestHeaders().getFirst("Authorization");
        if (bearer != null && bearer.regionMatches(true, 0, "Bearer ", 0, 7)
                && apiKeys.matches(bearer.substring(7).trim())) return true;
        return apiKeys.matches(exchange.getRequestHeaders().getFirst("X-API-Key"));
    }

    private void cors(HttpExchange exchange) {
        Headers h = exchange.getResponseHeaders();
        h.set("Access-Control-Allow-Origin", "*");
        h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, X-Correlation-ID, X-Source-Service");
        h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    }

    private Map<String,String> parse(String raw) {
        Map<String,String> map = new HashMap<>();
        if (raw == null || raw.isBlank()) return map;
        for (String pair : raw.split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2) {
                map.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8),
                        URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
            }
        }
        return map;
    }

    private void sendRaw(HttpExchange exchange, int code, Object body) throws IOException {
        cors(exchange);
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) { os.write(bytes); }
    }

    private void sendEnvelope(HttpExchange exchange, int code, Object data, String errCode, String errMsg) throws IOException {
        cors(exchange);
        Map<String, Object> body = new LinkedHashMap<>();
        if (errCode != null) {
            body.put("error", Map.of("code", errCode, "message", errMsg == null ? "" : errMsg));
        } else {
            body.put("data", data);
        }
        body.put("meta", Map.of("api_version", "v1", "team", "B"));
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) { os.write(bytes); }
    }

    private static String text(JsonNode n, String... keys) {
        if (n == null || n.isMissingNode()) return null;
        for (String k : keys) {
            String v = n.path(k).asText(null);
            if (v != null && !v.isBlank()) return v;
        }
        return null;
    }

    private static String firstNonBlank(String... vals) {
        if (vals == null) return null;
        for (String v : vals) if (v != null && !v.isBlank()) return v;
        return null;
    }

    private static LocalDate parseDay(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try { return LocalDate.parse(raw.substring(0, 10)); }
        catch (Exception e) {
            try { return OffsetDateTime.parse(raw).toLocalDate(); }
            catch (Exception e2) { throw new IllegalArgumentException("date must be YYYY-MM-DD or ISO-8601"); }
        }
    }

    private static LocalDateTime parseIso(String iso) {
        if (iso == null || iso.isBlank()) return null;
        try {
            String t = iso.replace("Z", "").replace(" ", "T");
            if (t.length() >= 19) t = t.substring(0, 19);
            return LocalDateTime.parse(t);
        } catch (Exception e) {
            return null;
        }
    }
}
