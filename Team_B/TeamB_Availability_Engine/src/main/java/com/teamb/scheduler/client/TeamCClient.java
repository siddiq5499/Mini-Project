package com.teamb.scheduler.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teamb.scheduler.model.Appointment;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/** Loads booked intervals from Team C so availability matches the real clinic calendar. */
public class TeamCClient {
    private final String base;
    private final String key;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();

    public TeamCClient(String base, String key, ObjectMapper mapper) {
        this.base = base == null ? "" : base.replaceAll("/$", "");
        this.key = key == null ? "" : key;
        this.mapper = mapper;
    }

    public boolean enabled() {
        return !base.isBlank() && !key.isBlank();
    }

    public List<Appointment> listBookings() throws Exception {
        if (!enabled()) return List.of();
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/api/v1/appointments?limit=1000"))
                .timeout(Duration.ofSeconds(8))
                .header("Authorization", "Bearer " + key)
                .header("X-Source-Service", "team-b")
                .GET()
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) {
            throw new IllegalStateException("Team C HTTP " + res.statusCode());
        }
        JsonNode data = mapper.readTree(res.body()).path("data");
        List<Appointment> out = new ArrayList<>();
        if (!data.isArray()) return out;
        for (JsonNode a : data) {
            String state = a.path("state").asText("");
            if (state.equals("CANCELLED") || state.equals("REJECTED") || state.equals("WAITLISTED")) continue;
            String startRaw = a.path("start").asText(null);
            String endRaw = a.path("end").asText(null);
            if (startRaw == null || endRaw == null || startRaw.isBlank()) continue;
            out.add(new Appointment(
                    a.path("provider_id").asText(),
                    parse(startRaw),
                    parse(endRaw),
                    state));
        }
        return out;
    }

    static LocalDateTime parse(String iso) {
        try {
            return OffsetDateTime.parse(iso).toLocalDateTime();
        } catch (Exception e) {
            String t = iso.replace("Z", "").replace(" ", "T");
            if (t.length() >= 19) t = t.substring(0, 19);
            return LocalDateTime.parse(t);
        }
    }
}
