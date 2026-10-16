package com.teamb.scheduler.index;

import com.teamb.scheduler.model.Appointment;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * High-performance interval registry maintaining:
 * 1. An Augmented Interval Tree per provider for O(log N) overlap queries (baseline).
 * 2. A sorted-array structure with binary-search for comparison experiments (PDF B1).
 */
public class IntervalIndex {
    private final List<Appointment> sortedAppointments = new ArrayList<>();
    private final Map<String, IntervalTree> treesByProvider = new ConcurrentHashMap<>();

    public IntervalIndex(List<Appointment> initial) {
        replaceAll(initial != null ? initial : Collections.emptyList());
    }

    public synchronized void replaceAll(List<Appointment> next) {
        sortedAppointments.clear();
        sortedAppointments.addAll(next);
        sortedAppointments.sort(Comparator.comparing(Appointment::start));

        treesByProvider.clear();
        for (Appointment a : sortedAppointments) {
            treesByProvider.computeIfAbsent(a.provider(), k -> new IntervalTree()).insert(a);
        }
    }

    public synchronized void addInterval(Appointment a) {
        sortedAppointments.add(a);
        sortedAppointments.sort(Comparator.comparing(Appointment::start));
        treesByProvider.computeIfAbsent(a.provider(), k -> new IntervalTree()).insert(a);
    }

    /** Interval-Tree based query */
    public synchronized List<Appointment> lookupWithIntervalTree(String provider, LocalDateTime start, LocalDateTime end) {
        IntervalTree tree = treesByProvider.get(provider);
        if (tree == null) return Collections.emptyList();
        return tree.queryOverlaps(start, end);
    }

    /** Binary-search based date narrowing on sorted array */
    public synchronized List<Appointment> lookupWithBinarySearch(String provider, LocalDate date) {
        LocalDateTime dayStart = date.atStartOfDay();
        LocalDateTime dayEnd = date.plusDays(1).atStartOfDay();

        // Binary search for the first element >= dayStart
        int low = 0, high = sortedAppointments.size() - 1;
        int firstIdx = sortedAppointments.size();
        while (low <= high) {
            int mid = (low + high) >>> 1;
            if (!sortedAppointments.get(mid).start().isBefore(dayStart)) {
                firstIdx = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        List<Appointment> result = new ArrayList<>();
        for (int i = firstIdx; i < sortedAppointments.size(); i++) {
            Appointment a = sortedAppointments.get(i);
            if (!a.start().isBefore(dayEnd)) break;
            if (a.provider().equals(provider)) {
                result.add(a);
            }
        }
        return result;
    }

    public synchronized List<Appointment> lookup(String provider, LocalDate date) {
        return lookupWithBinarySearch(provider, date);
    }

    public synchronized List<Appointment> all() {
        return List.copyOf(sortedAppointments);
    }

    public synchronized List<String> getProviders() {
        return sortedAppointments.stream().map(Appointment::provider).distinct().collect(Collectors.toList());
    }
}
