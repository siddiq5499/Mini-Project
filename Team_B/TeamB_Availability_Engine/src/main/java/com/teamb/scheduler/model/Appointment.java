package com.teamb.scheduler.model;

import java.time.LocalDateTime;

public record Appointment(
        String provider,
        LocalDateTime start,
        LocalDateTime end,
        String status
) {}
