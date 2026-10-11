package com.teamb.scheduler.model;

import java.time.LocalDate;
import java.time.LocalDateTime;

public record TimeSlot(
        String provider,
        LocalDate date,
        LocalDateTime start,
        LocalDateTime end,
        boolean booked
) {
    public boolean overlaps(LocalDateTime otherStart, LocalDateTime otherEnd) {
        return start.isBefore(otherEnd) && otherStart.isBefore(end);
    }
}
