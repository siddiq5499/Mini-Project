package com.teamb.scheduler.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.*;
import com.teamb.scheduler.conflict.ConflictAnalytics;
import com.teamb.scheduler.index.IntervalIndex;
import com.teamb.scheduler.index.VersionRegistry;
import com.teamb.scheduler.result.ResultBuilder;
import com.teamb.scheduler.search.SearchRanking;
import com.teamb.scheduler.validator.RequestValidator;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.*;

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
                    versions.currentVersion(), "SortedIntervalIndex");
            sendEnvelope(exchange, 200, result, null, null);
        } catch (RuntimeException e) {
            sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", e.getMessage());
        } catch (Exception e) {
            sendEnvelope(exchange, 500, null, "INTERNAL_ERROR", "Internal server error");
        }
    }

    @SuppressWarnings("unchecked")
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
            String algorithm = body.path("algorithm").asText("earliest-fit");
            JsonNode range = body.path("date_range");
            LocalDate from = parseDay(firstNonBlank(text(range, "start"), text(body, "date")));
            LocalDate to = parseDay(firstNonBlank(text(range, "end"), text(body, "date")));
            if (to == null) to = from;
            if (from == null) throw new IllegalArgumentException("date_range.start or date is required");
            if (to.isBefore(from)) to = from;
            validator.validate(provider, from.toString(), String.valueOf(duration));

            List<Map<String, Object>> slots = ranking.findFreeSlotsRange(
                    provider, from, to, duration, index::lookup);
            var dayBookings = index.lookup(provider, from);
            var conflictData = conflicts.analyze(dayBookings);
            long runtimeMs = (System.nanoTime() - started) / 1_000_000;

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("search_id", UUID.randomUUID().toString());
            data.put("provider_id", provider);
            data.put("ranked_free_slots", slots);
            data.put("conflicts", conflictData);
            data.put("calendar_version", "v" + versions.currentVersion());
            data.put("algorithm", algorithm);
            data.put("runtime_ms", runtimeMs);
            sendEnvelope(exchange, 200, data, null, null);
        } catch (RuntimeException e) {
            sendEnvelope(exchange, 400, null, "VALIDATION_ERROR", e.getMessage());
        } catch (Exception e) {
            sendEnvelope(exchange, 500, null, "INTERNAL_ERROR", "Internal server error");
        }
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
        h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
}
