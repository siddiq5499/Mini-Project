package com.teamb.scheduler.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;

/** Generates a local demo API key once and stores it outside the source tree. */
public final class ApiKeyManager {
    private final String apiKey;
    private final Path keyFile;

    public ApiKeyManager(Path keyFile) throws IOException {
        this.keyFile = keyFile;
        Path parent = keyFile.getParent();
        if (parent != null) Files.createDirectories(parent);
        if (Files.exists(keyFile) && !Files.readString(keyFile).isBlank()) {
            apiKey = Files.readString(keyFile, StandardCharsets.UTF_8).trim();
        } else {
            byte[] random = new byte[32];
            new SecureRandom().nextBytes(random);
            apiKey = "tb_" + Base64.getUrlEncoder().withoutPadding().encodeToString(random);
            Files.writeString(keyFile, apiKey + System.lineSeparator(), StandardCharsets.UTF_8);
        }
    }

    public String getApiKey() { return apiKey; }
    public boolean matches(String candidate) { return candidate != null && java.security.MessageDigest.isEqual(
            apiKey.getBytes(StandardCharsets.UTF_8), candidate.getBytes(StandardCharsets.UTF_8)); }

    public static ApiKeyManager fixed(String key) throws IOException {
        return new ApiKeyManager(key);
    }

    private ApiKeyManager(String key) {
        this.keyFile = Path.of("data", "api-key.txt");
        this.apiKey = key;
    }
}
