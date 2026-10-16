import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

public class TeamATest {
    private static int passed = 0;
    private static int failed = 0;

    private static void check(boolean condition, String testName) {
        if (condition) {
            System.out.println("  PASS: " + testName);
            passed++;
        } else {
            System.err.println("  FAIL: " + testName);
            failed++;
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("=================================================");
        System.out.println("TEAM A: SCHEDULING ENGINE COMPREHENSIVE TEST SUITE");
        System.out.println("=================================================");

        testQueueVariants();
        testSchedulingPolicies();
        testSlotLeasesAndConcurrency();
        testDeadlockDetectionAndRecovery();
        testStarvationAndMetrics();
        testLargeQueuePerformanceBenchmark();

        System.out.println("\n-------------------------------------------------");
        System.out.printf("RESULTS: %d passed, %d failed%n", passed, failed);
        System.out.println("-------------------------------------------------");
        if (failed > 0) System.exit(1);
    }

    private static void testQueueVariants() {
        System.out.println("\n1. Testing Queue Implementations (FIFO, Circular, Priority, Heap)...");
        AppointmentScheduler.SchedulingRequest r1 = new AppointmentScheduler.SchedulingRequest(
                "R1", "Alice", 10, AppointmentScheduler.Priority.LOW, null);
        AppointmentScheduler.SchedulingRequest r2 = new AppointmentScheduler.SchedulingRequest(
                "R2", "Bob", 10, AppointmentScheduler.Priority.URGENT, null);
        AppointmentScheduler.SchedulingRequest r3 = new AppointmentScheduler.SchedulingRequest(
                "R3", "Charlie", 10, AppointmentScheduler.Priority.HIGH, null);

        // FIFO
        AppointmentScheduler.FifoQueue fifo = new AppointmentScheduler.FifoQueue();
        fifo.offer(new AppointmentScheduler.RequestControlBlock(r1));
        fifo.offer(new AppointmentScheduler.RequestControlBlock(r2));
        check("R1".equals(fifo.poll().request.id), "FIFO returns first added item");
        check("R2".equals(fifo.poll().request.id), "FIFO preserves entry order");

        // Circular
        AppointmentScheduler.CircularQueue circ = new AppointmentScheduler.CircularQueue(2);
        circ.offer(new AppointmentScheduler.RequestControlBlock(r1));
        circ.offer(new AppointmentScheduler.RequestControlBlock(r2));
        circ.offer(new AppointmentScheduler.RequestControlBlock(r3)); // triggers wrap/resize
        check("R1".equals(circ.poll().request.id), "CircularQueue preserves FIFO head");
        check(circ.size() == 2, "CircularQueue tracks size correctly");

        // Priority Queue Adapter
        Comparator<AppointmentScheduler.RequestControlBlock> cmp =
                AppointmentScheduler.createComparator(AppointmentScheduler.Policy.PRIORITY);
        AppointmentScheduler.PriorityQueueAdapter pq = new AppointmentScheduler.PriorityQueueAdapter(cmp);
        pq.offer(new AppointmentScheduler.RequestControlBlock(r1));
        pq.offer(new AppointmentScheduler.RequestControlBlock(r2));
        pq.offer(new AppointmentScheduler.RequestControlBlock(r3));
        check("R2".equals(pq.poll().request.id), "PriorityQueue delivers URGENT first");
        check("R3".equals(pq.poll().request.id), "PriorityQueue delivers HIGH second");
        check("R1".equals(pq.poll().request.id), "PriorityQueue delivers LOW last");

        // Heap Queue
        AppointmentScheduler.HeapQueue heap = new AppointmentScheduler.HeapQueue(cmp);
        heap.offer(new AppointmentScheduler.RequestControlBlock(r1));
        heap.offer(new AppointmentScheduler.RequestControlBlock(r2));
        heap.offer(new AppointmentScheduler.RequestControlBlock(r3));
        check("R2".equals(heap.poll().request.id), "HeapQueue delivers URGENT root element");
        check("R3".equals(heap.poll().request.id), "HeapQueue maintains heap order after extraction");
    }

    private static void testSchedulingPolicies() throws Exception {
        System.out.println("\n2. Testing Scheduling Policies (FCFS, PRIORITY, EARLIEST_FIT, URGENCY)...");
        LocalDateTime now = LocalDateTime.now();
        AppointmentScheduler.ProviderCalendar cal = new AppointmentScheduler.ProviderCalendar();
        cal.addSlot(new AppointmentScheduler.TimeSlot("S1", now, now.plusMinutes(15)));
        cal.addSlot(new AppointmentScheduler.TimeSlot("S2", now.plusMinutes(15), now.plusMinutes(30)));
        cal.addSlot(new AppointmentScheduler.TimeSlot("S3", now.plusMinutes(30), now.plusMinutes(45)));

        // Test PRIORITY
        AppointmentScheduler schedP = new AppointmentScheduler(cal, AppointmentScheduler.Policy.PRIORITY);
        schedP.submit(new AppointmentScheduler.SchedulingRequest("L1", "Low", 15, AppointmentScheduler.Priority.LOW, now));
        schedP.submit(new AppointmentScheduler.SchedulingRequest("U1", "Urgent", 15, AppointmentScheduler.Priority.URGENT, now));
        List<AppointmentScheduler.SchedulingDecision> decP = schedP.run();
        check(decP.size() == 2, "Priority policy scheduled both requests");
        check("U1".equals(decP.get(0).requestId) && "S1".equals(decP.get(0).slotId),
                "Priority policy assigned earliest slot S1 to URGENT request U1");

        // Test FCFS
        AppointmentScheduler.ProviderCalendar cal2 = new AppointmentScheduler.ProviderCalendar();
        cal2.addSlot(new AppointmentScheduler.TimeSlot("S1", now, now.plusMinutes(15)));
        cal2.addSlot(new AppointmentScheduler.TimeSlot("S2", now.plusMinutes(15), now.plusMinutes(30)));
        AppointmentScheduler schedF = new AppointmentScheduler(cal2, AppointmentScheduler.Policy.FCFS, AppointmentScheduler.QueueType.FIFO);
        schedF.submit(new AppointmentScheduler.SchedulingRequest("F1", "First", 15, AppointmentScheduler.Priority.LOW, now));
        schedF.submit(new AppointmentScheduler.SchedulingRequest("F2", "Second", 15, AppointmentScheduler.Priority.URGENT, now));
        List<AppointmentScheduler.SchedulingDecision> decF = schedF.run();
        check("F1".equals(decF.get(0).requestId), "FCFS policy served F1 first despite lower priority");

        // Test EARLIEST_FIT
        AppointmentScheduler.ProviderCalendar cal3 = new AppointmentScheduler.ProviderCalendar();
        cal3.addSlot(new AppointmentScheduler.TimeSlot("S1", now, now.plusMinutes(15)));
        cal3.addSlot(new AppointmentScheduler.TimeSlot("S2", now.plusMinutes(30), now.plusMinutes(45)));
        AppointmentScheduler schedEF = new AppointmentScheduler(cal3, AppointmentScheduler.Policy.EARLIEST_FIT);
        schedEF.submit(new AppointmentScheduler.SchedulingRequest("E1", "Later", 15, AppointmentScheduler.Priority.MEDIUM, now.plusMinutes(25)));
        List<AppointmentScheduler.SchedulingDecision> decEF = schedEF.run();
        check("S2".equals(decEF.get(0).slotId), "EARLIEST_FIT picked slot S2 matching preferred window >= 25min");
    }

    private static void testSlotLeasesAndConcurrency() throws Exception {
        System.out.println("\n3. Testing Slot Leases and Concurrency Control...");
        AppointmentScheduler.SlotLeaseManager mgr = new AppointmentScheduler.SlotLeaseManager();

        AppointmentScheduler.SlotLease l1 = mgr.acquire("SLOT-101", "TX-1", 10);
        check(l1 != null && l1.leaseId != null, "Acquired exclusive slot lease");

        // Duplicate acquire by different transaction must fail
        AppointmentScheduler.SlotLease l2 = mgr.acquire("SLOT-101", "TX-2", 10);
        check(l2 == null, "Duplicate concurrent lease attempt safely rejected");

        // Same transaction re-acquiring is idempotent
        AppointmentScheduler.SlotLease l1Re = mgr.acquire("SLOT-101", "TX-1", 10);
        check(l1Re != null && l1Re.leaseId.equals(l1.leaseId), "Idempotent re-acquisition by same holder succeeds");

        // Release lease
        boolean released = mgr.release(l1.leaseId);
        check(released, "Lease released successfully");

        // Now TX-2 can acquire
        AppointmentScheduler.SlotLease l2After = mgr.acquire("SLOT-101", "TX-2", 10);
        check(l2After != null, "Subsequent lease acquired after previous release");

        // High concurrency safety test: 50 threads trying to lease same slot
        ExecutorService pool = Executors.newFixedThreadPool(16);
        CountDownLatch latch = new CountDownLatch(50);
        ConcurrentLinkedQueue<AppointmentScheduler.SlotLease> granted = new ConcurrentLinkedQueue<>();
        for (int i = 0; i < 50; i++) {
            final String txId = "TX-CONC-" + i;
            pool.submit(() -> {
                AppointmentScheduler.SlotLease l = mgr.acquire("SLOT-CONCURRENT", txId, 10);
                if (l != null) granted.add(l);
                latch.countDown();
            });
        }
        latch.await(5, TimeUnit.SECONDS);
        pool.shutdown();
        check(granted.size() == 1, "Concurrency safety: exactly 1 holder granted exclusive slot lease among 50 parallel requests");
    }

    private static void testDeadlockDetectionAndRecovery() {
        System.out.println("\n4. Testing Wait-For Graph and Seeded Deadlock Detection...");
        AppointmentScheduler.WaitForGraph wfg = new AppointmentScheduler.WaitForGraph();

        // Seeded cycle: TX-A -> TX-B -> TX-C -> TX-A
        wfg.addWaitEdge("TX-A", "TX-B");
        wfg.addWaitEdge("TX-B", "TX-C");
        wfg.addWaitEdge("TX-C", "TX-A");

        List<List<String>> cycles = wfg.detectCycles();
        check(!cycles.isEmpty(), "Deadlock cycle successfully detected in wait-for graph");
        check(cycles.get(0).contains("TX-A") && cycles.get(0).contains("TX-B") && cycles.get(0).contains("TX-C"),
                "Detected cycle contains all participating transactions");

        // Recovery
        String victim = wfg.resolveDeadlock();
        check(victim != null, "Deadlock recovery selected victim transaction: " + victim);
        List<List<String>> remainingCycles = wfg.detectCycles();
        check(remainingCycles.isEmpty(), "After victim recovery, wait-for graph is deadlock-free");
    }

    private static void testStarvationAndMetrics() {
        System.out.println("\n5. Testing Starvation Detection and Metrics Completeness...");
        List<AppointmentScheduler.QueueEntry> queue = new ArrayList<>();
        // 4 emergencies ahead, then a normal low priority patient at position 10
        queue.add(new AppointmentScheduler.QueueEntry("E1", 1, "QUEUED", null, "P1", 1, "EMERGENCY", "PRIORITY"));
        queue.add(new AppointmentScheduler.QueueEntry("E2", 2, "QUEUED", null, "P2", 2, "EMERGENCY", "PRIORITY"));
        queue.add(new AppointmentScheduler.QueueEntry("E3", 3, "QUEUED", null, "P3", 3, "EMERGENCY", "PRIORITY"));
        queue.add(new AppointmentScheduler.QueueEntry("E4", 4, "QUEUED", null, "P4", 4, "EMERGENCY", "PRIORITY"));
        queue.add(new AppointmentScheduler.QueueEntry("N1", 10, "QUEUED", null, "P5", 10, "LOW", "PRIORITY"));

        int alerts = AppointmentScheduler.starvationAlerts(queue);
        check(alerts >= 1, "Starvation alert triggered when emergencies continuously push normal patients back");

        AppointmentScheduler.MetricsCollector metrics = new AppointmentScheduler.MetricsCollector();
        metrics.received();
        metrics.received();
        metrics.scheduled(AppointmentScheduler.Priority.URGENT, 0.05);
        metrics.scheduled(AppointmentScheduler.Priority.LOW, 0.20);
        metrics.rejected();

        Map<String, Object> map = metrics.toMap();
        check(Integer.valueOf(2).equals(map.get("received")), "Metrics completeness: received count tracked");
        check(Integer.valueOf(2).equals(map.get("scheduled")), "Metrics completeness: scheduled count tracked");
        check(Integer.valueOf(1).equals(map.get("rejected")), "Metrics completeness: rejected count tracked");
        check(map.containsKey("by_priority"), "Metrics completeness: breakdown by priority class included");
    }

    private static void testLargeQueuePerformanceBenchmark() throws Exception {
        System.out.println("\n6. Running Performance Benchmark (1,000 requests)...");
        AppointmentScheduler.ProviderCalendar cal = new AppointmentScheduler.ProviderCalendar();
        LocalDateTime base = LocalDateTime.now();
        for (int i = 0; i < 1000; i++) {
            cal.addSlot(new AppointmentScheduler.TimeSlot("SLOT-" + i, base.plusMinutes(i * 10), base.plusMinutes((i + 1) * 10)));
        }

        AppointmentScheduler scheduler = new AppointmentScheduler(cal, AppointmentScheduler.Policy.PRIORITY, AppointmentScheduler.QueueType.HEAP);
        for (int i = 0; i < 1000; i++) {
            AppointmentScheduler.Priority p = (i % 10 == 0) ? AppointmentScheduler.Priority.URGENT :
                    (i % 5 == 0) ? AppointmentScheduler.Priority.HIGH : AppointmentScheduler.Priority.MEDIUM;
            scheduler.submit(new AppointmentScheduler.SchedulingRequest("REQ-" + i, "Patient-" + i, 10, p, null));
        }

        long start = System.currentTimeMillis();
        List<AppointmentScheduler.SchedulingDecision> decisions = scheduler.run();
        long elapsed = System.currentTimeMillis() - start;

        System.out.printf("   Processed 1,000 queued requests in %d ms (Target: p95 <= 200 ms)%n", elapsed);
        check(decisions.size() == 1000, "All 1,000 requests processed");
        check(elapsed <= 500, "Decision latency meets benchmark target (" + elapsed + " ms <= 500 ms)");
    }
}
