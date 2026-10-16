package com.teamb.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.teamb.scheduler.api.AvailabilityServer;
import com.teamb.scheduler.api.ApiKeyManager;
import com.teamb.scheduler.client.TeamCClient;
import com.teamb.scheduler.conflict.ConflictAnalytics;
import com.teamb.scheduler.db.SlotRepository;
import com.teamb.scheduler.index.IntervalIndex;
import com.teamb.scheduler.index.VersionRegistry;
import com.teamb.scheduler.result.ResultBuilder;
import com.teamb.scheduler.search.SearchRanking;
import com.teamb.scheduler.validator.RequestValidator;
import java.nio.file.Files;
import java.nio.file.Path;

public class Main {
    public static void main(String[] args) throws Exception {
        loadDotEnv(Path.of(".env"));
        loadDotEnv(Path.of("..", ".env"));

        int port = Integer.parseInt(env("PORT", "4002"));
        SlotRepository repository = new SlotRepository();
        repository.initSchema();
        repository.seedMockData();

        var index = new IntervalIndex(repository.findAppointments());
        var versions = new VersionRegistry();
        var mapper = new ObjectMapper();
        var teamC = new TeamCClient(env("TEAM_C_URL", "http://localhost:4000"), env("TEAM_C_KEY", ""), mapper);
        refreshFromTeamC(teamC, index, versions);

        String envKey = env("SERVICE_KEY", env("TEAM_B_KEY", ""));
        var apiKeys = envKey.isBlank()
                ? new ApiKeyManager(Path.of("data", "api-key.txt"))
                : ApiKeyManager.fixed(envKey);

        var server = new AvailabilityServer(
                port,
                new RequestValidator(),
                index,
                new SearchRanking(),
                new ConflictAnalytics(),
                new ResultBuilder(),
                versions,
                mapper,
                repository,
                apiKeys
        );

        server.start();
        Thread refresher = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(5000);
                    refreshFromTeamC(teamC, index, versions);
                } catch (InterruptedException e) {
                    return;
                } catch (Exception ignored) { /* keep last snapshot */ }
            }
        }, "team-c-sync");
        refresher.setDaemon(true);
        refresher.start();

        System.out.println("Team B Availability Engine running at http://localhost:" + port);
        System.out.println("Web form: http://localhost:" + port + "/");
        System.out.println("Search API: POST /api/v1/availability/search");
        System.out.println("API key: " + apiKeys.getApiKey());
        System.out.println("Team C: " + (teamC.enabled() ? env("TEAM_C_URL", "") : "NOT configured (H2 demo data)"));
        System.out.println("Press Ctrl+C to stop.");
    }

    private static void refreshFromTeamC(TeamCClient teamC, IntervalIndex index, VersionRegistry versions) {
        if (!teamC.enabled()) return;
        try {
            var rows = teamC.listBookings();
            if (rows != null) {
                index.replaceAll(rows);
                versions.increment();
            }
        } catch (Exception e) {
            System.err.println("[Team C] availability sync failed: " + e.getMessage());
        }
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
        } catch (Exception ignored) { /* optional */ }
    }
}
