package com.teamb.scheduler.result;

import java.util.*;

public class ResultBuilder {
    public Map<String,Object> build(
            List<Map<String,Object>> slots,
            Map<String,Object> conflicts,
            long durationMs,
            int calendarVersion,
            String algorithm) {

        Map<String,Object> result = new LinkedHashMap<>();
        result.put("slots", slots);
        result.put("conflicts", conflicts);

        Map<String,Object> metrics = new LinkedHashMap<>();
        metrics.put("slot_count", slots.size());
        metrics.put("runtime_ms", durationMs);
        result.put("metrics", metrics);

        result.put("calendar_version", calendarVersion);
        result.put("algorithm", algorithm);
        return result;
    }
}
