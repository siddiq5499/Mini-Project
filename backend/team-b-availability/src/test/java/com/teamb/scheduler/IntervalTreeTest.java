package com.teamb.scheduler;

import com.teamb.scheduler.index.IntervalIndex;
import com.teamb.scheduler.index.IntervalTree;
import com.teamb.scheduler.index.SlotIndexManager;
import com.teamb.scheduler.model.Appointment;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

public class IntervalTreeTest {

    @Test
    public void testIntervalTreeOverlapQuery() {
        IntervalTree tree = new IntervalTree();
        LocalDateTime t10 = LocalDateTime.parse("2026-10-12T10:00:00");
        LocalDateTime t11 = LocalDateTime.parse("2026-10-12T11:00:00");
        LocalDateTime t12 = LocalDateTime.parse("2026-10-12T12:00:00");
        LocalDateTime t13 = LocalDateTime.parse("2026-10-12T13:00:00");

        tree.insert(new Appointment("DR-001", t10, t11, "CONFIRMED"));
        tree.insert(new Appointment("DR-001", t12, t13, "CONFIRMED"));

        // Query overlapping with slot 1
        List<Appointment> overlaps1 = tree.queryOverlaps(
                LocalDateTime.parse("2026-10-12T10:30:00"),
                LocalDateTime.parse("2026-10-12T10:45:00"));
        assertEquals(1, overlaps1.size());
        assertEquals("DR-001", overlaps1.get(0).provider());

        // Query in free gap between 11:00 and 12:00
        List<Appointment> gap = tree.queryOverlaps(
                LocalDateTime.parse("2026-10-12T11:15:00"),
                LocalDateTime.parse("2026-10-12T11:45:00"));
        assertTrue(gap.isEmpty(), "No overlap in free interval");
    }

    @Test
    public void testIntervalIndexBinarySearchAndTreeSync() {
        LocalDateTime base = LocalDateTime.parse("2026-10-12T09:00:00");
        List<Appointment> list = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            list.add(new Appointment("DR-001", base.plusMinutes(i * 30), base.plusMinutes(i * 30 + 15), "CONFIRMED"));
        }

        IntervalIndex index = new IntervalIndex(list);
        List<Appointment> bsResult = index.lookupWithBinarySearch("DR-001", LocalDate.parse("2026-10-12"));
        assertEquals(20, bsResult.size());

        List<Appointment> treeResult = index.lookupWithIntervalTree("DR-001", base.plusMinutes(30), base.plusMinutes(40));
        assertEquals(1, treeResult.size());
        assertEquals(base.plusMinutes(30), treeResult.get(0).start());
    }

    @Test
    public void testSlotIndexAndCache() {
        SlotIndexManager mgr = new SlotIndexManager();
        mgr.putSlot("DR-001_09:00", Map.of("start", "09:00", "end", "09:10", "available", true));

        // RB tree lookup
        Map<String, Object> rbRes = mgr.lookupSlot("DR-001_09:00", "rb_tree");
        assertTrue((Boolean) rbRes.get("found"));
        assertTrue(((Number) rbRes.get("lookup_time_us")).longValue() >= 0);

        // Hash lookup
        Map<String, Object> hashRes = mgr.lookupSlot("DR-001_09:00", "hash");
        assertTrue((Boolean) hashRes.get("found"));

        // Cache testing
        mgr.cacheResult("search_key_1", Map.of("slots", 5), 1);
        assertNotNull(mgr.getCachedResult("search_key_1", 1));
        assertNull(mgr.getCachedResult("search_key_1", 2), "Stale calendar version rejected");

        int cleared = mgr.invalidateCache();
        assertEquals(1, cleared);
        assertNull(mgr.getCachedResult("search_key_1", 1));
    }

    @Test
    public void testLargeCalendarPerformanceBenchmark() {
        LocalDateTime base = LocalDateTime.parse("2026-10-12T08:00:00");
        IntervalTree tree = new IntervalTree();
        for (int i = 0; i < 5000; i++) {
            tree.insert(new Appointment("DR-" + (i % 100),
                    base.plusMinutes(i * 5), base.plusMinutes(i * 5 + 4), "BOOKED"));
        }

        long start = System.currentTimeMillis();
        for (int q = 0; q < 1000; q++) {
            LocalDateTime qStart = base.plusMinutes(q * 10);
            tree.queryOverlaps(qStart, qStart.plusMinutes(10));
        }
        long duration = System.currentTimeMillis() - start;
        System.out.printf("   Executed 1,000 interval tree queries over 5,000 intervals in %d ms (Target: p95 <= 100 ms)%n", duration);
        assertTrue(duration <= 500, "Interval tree query latency within target");
    }
}
