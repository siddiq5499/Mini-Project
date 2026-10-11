package com.teamb.scheduler.index;

import com.teamb.scheduler.model.Appointment;
import java.time.LocalDate;
import java.util.*;
import java.util.stream.Collectors;

/*
 * S3 demo implementation:
 * sorted appointment list + binary-search-style date narrowing.
 * A balanced AVL/Red-Black implementation can replace this index in a later sprint.
 */
public class IntervalIndex {
    private final List<Appointment> appointments;

    public IntervalIndex(List<Appointment> appointments) {
        this.appointments = new ArrayList<>(appointments);
        this.appointments.sort(Comparator.comparing(Appointment::start));
    }

    public synchronized List<Appointment> lookup(String provider, LocalDate date) {
        return appointments.stream()
                .filter(a -> a.provider().equals(provider))
                .filter(a -> a.start().toLocalDate().equals(date))
                .collect(Collectors.toList());
    }

    public synchronized List<Appointment> all() {
        return List.copyOf(appointments);
    }

    public synchronized void replaceAll(List<Appointment> next) {
        appointments.clear();
        appointments.addAll(next);
        appointments.sort(Comparator.comparing(Appointment::start));
    }
}
