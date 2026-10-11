package com.teamb.scheduler.conflict;

import com.teamb.scheduler.model.Appointment;
import java.time.LocalDateTime;
import java.util.*;

public class ConflictAnalytics {
    public Map<String,Object> analyze(List<Appointment> appointments) {
        List<Map<String,Object>> overlaps = new ArrayList<>();

        for (int i = 0; i < appointments.size(); i++) {
            for (int j = i + 1; j < appointments.size(); j++) {
                Appointment a = appointments.get(i);
                Appointment b = appointments.get(j);

                boolean overlap = a.start().isBefore(b.end()) && b.start().isBefore(a.end());
                if (overlap) {
                    Map<String,Object> item = new LinkedHashMap<>();
                    item.put("first", a.start() + " to " + a.end());
                    item.put("second", b.start() + " to " + b.end());
                    overlaps.add(item);
                }
            }
        }

        Map<String,Object> result = new LinkedHashMap<>();
        result.put("overlap_detected", !overlaps.isEmpty());
        result.put("count", overlaps.size());
        result.put("items", overlaps);
        return result;
    }
}
