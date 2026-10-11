package com.teamb.scheduler;

import com.teamb.scheduler.conflict.ConflictAnalytics;
import com.teamb.scheduler.model.Appointment;
import org.junit.jupiter.api.Test;
import java.time.LocalDateTime;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class ConflictAnalyticsTest {
    @Test void overlapDetected() {
        var a = new Appointment("P12",
                LocalDateTime.parse("2026-10-04T10:00"),
                LocalDateTime.parse("2026-10-04T11:00"), "BOOKED");
        var b = new Appointment("P12",
                LocalDateTime.parse("2026-10-04T10:30"),
                LocalDateTime.parse("2026-10-04T11:30"), "BOOKED");

        var result = new ConflictAnalytics().analyze(List.of(a,b));
        assertEquals(true, result.get("overlap_detected"));
        assertEquals(1, result.get("count"));
    }

    @Test void backToBackIsNotConflict() {
        var a = new Appointment("P12",
                LocalDateTime.parse("2026-10-04T10:00"),
                LocalDateTime.parse("2026-10-04T11:00"), "BOOKED");
        var b = new Appointment("P12",
                LocalDateTime.parse("2026-10-04T11:00"),
                LocalDateTime.parse("2026-10-04T12:00"), "BOOKED");

        var result = new ConflictAnalytics().analyze(List.of(a,b));
        assertEquals(false, result.get("overlap_detected"));
    }
}
