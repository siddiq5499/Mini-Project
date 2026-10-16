package com.teamb.scheduler.conflict;

import com.teamb.scheduler.model.Appointment;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.*;

/**
 * Sweep-Line Overlap Detection & Conflict Analytics (PDF B4).
 * Creates START and END boundary events, sorts them chronologically (O(N log N)),
 * and sweeps a line across the calendar to detect all overlapping pairs in optimal time.
 */
public class ConflictAnalytics {

    private enum EventType { START, END }

    private static class EndpointEvent {
        final LocalDateTime time;
        final EventType type;
        final Appointment appointment;

        EndpointEvent(LocalDateTime time, EventType type, Appointment appointment) {
            this.time = time;
            this.type = type;
            this.appointment = appointment;
        }
    }

    public Map<String, Object> analyze(List<Appointment> appointments) {
        long startNano = System.nanoTime();
        List<Map<String, Object>> overlaps = new ArrayList<>();
        if (appointments == null || appointments.isEmpty()) {
            return emptyResult(0);
        }

        // 1. Build events for Sweep-Line
        List<EndpointEvent> events = new ArrayList<>(appointments.size() * 2);
        for (Appointment a : appointments) {
            events.add(new EndpointEvent(a.start(), EventType.START, a));
            events.add(new EndpointEvent(a.end(), EventType.END, a));
        }

        // 2. Sort events chronologically. If times are equal, END comes before START to allow back-to-back non-overlapping slots
        events.sort((e1, e2) -> {
            int cmp = e1.time.compareTo(e2.time);
            if (cmp != 0) return cmp;
            if (e1.type != e2.type) return e1.type == EventType.END ? -1 : 1;
            return 0;
        });

        // 3. Sweep line: maintain active intervals
        Set<Appointment> active = new LinkedHashSet<>();
        long totalDurationMinutes = 0;
        LocalDateTime minStart = null;
        LocalDateTime maxEnd = null;

        for (EndpointEvent event : events) {
            if (event.type == EventType.START) {
                // event.appointment overlaps with all currently active appointments
                for (Appointment act : active) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("first", act.start() + " to " + act.end());
                    item.put("second", event.appointment.start() + " to " + event.appointment.end());
                    item.put("first_provider", act.provider());
                    item.put("second_provider", event.appointment.provider());
                    overlaps.add(item);
                }
                active.add(event.appointment);
                if (minStart == null || event.appointment.start().isBefore(minStart)) minStart = event.appointment.start();
                if (maxEnd == null || event.appointment.end().isAfter(maxEnd)) maxEnd = event.appointment.end();
                totalDurationMinutes += Duration.between(event.appointment.start(), event.appointment.end()).toMinutes();
            } else {
                active.remove(event.appointment);
            }
        }

        long elapsedNanos = System.nanoTime() - startNano;

        // Calculate calendar span and utilization
        double utilizationRate = 0.0;
        if (minStart != null && maxEnd != null) {
            long spanMinutes = Math.max(1, Duration.between(minStart, maxEnd).toMinutes());
            utilizationRate = Math.min(100.0, Math.round(((double) totalDurationMinutes / spanMinutes) * 1000.0) / 10.0);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("algorithm", "SWEEP_LINE");
        result.put("complexity", "O(N log N)");
        result.put("overlap_detected", !overlaps.isEmpty());
        result.put("double_booking_count", overlaps.size());
        result.put("count", overlaps.size());
        result.put("items", overlaps);
        result.put("utilization_rate", utilizationRate);
        result.put("analyzed_intervals", appointments.size());
        result.put("execution_time_us", Math.max(1, elapsedNanos / 1000));
        return result;
    }

    private Map<String, Object> emptyResult(long timeUs) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("algorithm", "SWEEP_LINE");
        result.put("complexity", "O(N log N)");
        result.put("overlap_detected", false);
        result.put("double_booking_count", 0);
        result.put("items", Collections.emptyList());
        result.put("utilization_rate", 0.0);
        result.put("analyzed_intervals", 0);
        result.put("execution_time_us", timeUs);
        return result;
    }
}
