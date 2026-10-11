import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Pulls live appointments from Team C (system of record). */
final class TeamCClient {
    private final String base;
    private final String key;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();

    TeamCClient(String base, String key) {
        this.base = base == null ? "" : base.replaceAll("/$", "");
        this.key = key == null ? "" : key;
    }

    boolean enabled() {
        return !base.isBlank() && !key.isBlank();
    }

    @SuppressWarnings("unchecked")
    List<AppointmentScheduler.LiveAppointment> listAppointments() throws Exception {
        if (!enabled()) return List.of();
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/api/v1/appointments?limit=1000"))
                .timeout(Duration.ofSeconds(8))
                .header("Authorization", "Bearer " + key)
                .header("X-Source-Service", "team-a")
                .GET()
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) {
            throw new IllegalStateException("Team C HTTP " + res.statusCode());
        }
        Map<String, Object> env = Json.asObj(Json.parse(res.body()));
        List<Object> rows = Json.asArr(env.get("data"));
        List<AppointmentScheduler.LiveAppointment> out = new ArrayList<>();
        for (Object row : rows) {
            Map<String, Object> a = Json.asObj(row);
            int dur = 10;
            try {
                var start = AppointmentScheduler.parseIso(Json.str(a.get("start")));
                var end = AppointmentScheduler.parseIso(Json.str(a.get("end")));
                if (start != null && end != null) {
                    dur = (int) java.time.Duration.between(start, end).toMinutes();
                    if (dur <= 0) dur = 10;
                }
            } catch (Exception ignored) { /* keep 10 */ }
            out.add(new AppointmentScheduler.LiveAppointment(
                    Json.str(a.get("appointment_id")),
                    Json.str(a.get("provider_id")),
                    Json.str(a.get("patient_name")),
                    Json.str(a.get("state")),
                    Json.str(a.get("start")),
                    Json.str(a.get("priority")),
                    Json.num(a.get("token_number"), 0),
                    dur));
        }
        return out;
    }
}
