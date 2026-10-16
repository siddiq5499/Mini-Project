package com.teamb.scheduler.search;

import com.teamb.scheduler.model.Appointment;
import java.time.*;
import java.util.*;

public class SearchRanking {
    public List<Map<String, Object>> findFreeSlots(
            String provider, LocalDate date, int duration, List<Appointment> bookings) {

        LocalDateTime dayStart = date.atTime(9, 0);
        LocalDateTime dayEnd = date.atTime(17, 0);
        List<Map<String, Object>> result = new ArrayList<>();
        List<Appointment> ordered = new ArrayList<>(bookings);
        ordered.sort(Comparator.comparing(Appointment::start));

        LocalDateTime cursor = dayStart;
        for (Appointment booking : ordered) {
            if (booking.start().isAfter(cursor)) {
                addSlotIfLongEnough(result, cursor, booking.start(), duration);
            }
            if (booking.end().isAfter(cursor)) cursor = booking.end();
        }
        addSlotIfLongEnough(result, cursor, dayEnd, duration);

        result.sort(Comparator
                .comparing((Map<String,Object> m) -> (String)m.get("start"))
                .thenComparing(m -> (String)m.get("end")));

        return result;
    }

    private void addSlotIfLongEnough(List<Map<String,Object>> result,
                                      LocalDateTime start, LocalDateTime end, int duration) {
        if (Duration.between(start, end).toMinutes() >= duration) {
            LocalDateTime slotEnd = start.plusMinutes(duration);
            Map<String,Object> slot = new LinkedHashMap<>();
            slot.put("start", iso(start));
            slot.put("end", iso(slotEnd));
            result.add(slot);
        }
    }

    public List<Map<String, Object>> findFreeSlotsRange(
            String provider, LocalDate from, LocalDate to, int duration, IntervalBookings bookings) {
        List<Map<String, Object>> all = new ArrayList<>();
        for (LocalDate d = from; !d.isAfter(to); d = d.plusDays(1)) {
            all.addAll(findFreeSlots(provider, d, duration, bookings.on(provider, d)));
        }
        return all;
    }

    @FunctionalInterface
    public interface IntervalBookings {
        List<Appointment> on(String provider, LocalDate date);
    }

    static String iso(LocalDateTime t) {
        return t.toString() + (t.toString().length() == 16 ? ":00.000Z" : "Z");
    }
}
