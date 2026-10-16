import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

public class AppointmentScheduler {
    private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    public enum Priority {
        LOW(1), MEDIUM(2), HIGH(3), URGENT(4);
        public final int value;
        Priority(int value) { this.value = value; }
    }

    public enum Policy { FCFS, PRIORITY, EARLIEST_FIT, URGENCY }
    public enum QueueType { FIFO, CIRCULAR, PRIORITY_QUEUE, HEAP }
    public enum Status { REQUESTED, QUEUED, READY, SLOT_LOCKED, SCHEDULED, NO_SLOT, INVALID, CONFLICT, WAITLISTED, REJECTED }

    public static class SchedulingRequest {
        public final String id;
        public final String patient;
        public final String providerId;
        public final String serviceType;
        public final int durationMinutes;
        public final Priority priority;
        public final LocalDateTime preferredStart;
        public final LocalDateTime submittedAt;
        public final String correlationId;

        public SchedulingRequest(String id, String patient, int durationMinutes,
                                 Priority priority, LocalDateTime preferredStart) {
            this(id, patient, null, null, durationMinutes, priority, preferredStart, LocalDateTime.now(), null);
        }

        public SchedulingRequest(String id, String patient, String providerId, String serviceType,
                                 int durationMinutes, Priority priority, LocalDateTime preferredStart,
                                 LocalDateTime submittedAt, String correlationId) {
            this.id = id;
            this.patient = patient;
            this.providerId = providerId;
            this.serviceType = serviceType;
            this.durationMinutes = durationMinutes <= 0 ? 10 : durationMinutes;
            this.priority = priority == null ? Priority.LOW : priority;
            this.preferredStart = preferredStart;
            this.submittedAt = submittedAt == null ? LocalDateTime.now() : submittedAt;
            this.correlationId = correlationId;
        }
    }

    public static class RequestControlBlock {
        public final SchedulingRequest request;
        public final LocalDateTime arrivalTime;
        public volatile Status status = Status.QUEUED;
        public volatile int queuePosition;
        public volatile LocalDateTime estimatedStart;

        public RequestControlBlock(SchedulingRequest request) {
            this.request = request;
            this.arrivalTime = request.submittedAt != null ? request.submittedAt : LocalDateTime.now();
        }
    }

    public static class TimeSlot {
        public final String id;
        public final LocalDateTime start;
        public final LocalDateTime end;
        public final ReentrantLock lock = new ReentrantLock();
        public String appointmentId;

        public TimeSlot(String id, LocalDateTime start, LocalDateTime end) {
            this.id = id;
            this.start = start;
            this.end = end;
        }

        public boolean available(int durationMinutes) {
            return appointmentId == null && !start.plusMinutes(durationMinutes).isAfter(end);
        }
    }

    public static class ProviderCalendar {
        private final List<TimeSlot> slots = new ArrayList<>();
        private final ReentrantLock calendarLock = new ReentrantLock();

        public void addSlot(TimeSlot slot) {
            calendarLock.lock();
            try { slots.add(slot); }
            finally { calendarLock.unlock(); }
        }

        public List<TimeSlot> getSlots() {
            calendarLock.lock();
            try { return new ArrayList<>(slots); }
            finally { calendarLock.unlock(); }
        }

        public TimeSlot findSlot(SchedulingRequest request, Policy policy) {
            calendarLock.lock();
            try {
                return slots.stream()
                        .filter(slot -> slot.available(request.durationMinutes))
                        .filter(slot -> policy != Policy.EARLIEST_FIT
                                || request.preferredStart == null
                                || !slot.start.isBefore(request.preferredStart))
                        .min(Comparator.comparing(slot -> slot.start))
                        .orElse(null);
            } finally {
                calendarLock.unlock();
            }
        }

        public void print() {
            calendarLock.lock();
            try {
                for (TimeSlot slot : slots) {
                    String state = slot.appointmentId == null ? "AVAILABLE" : "BOOKED: " + slot.appointmentId;
                    System.out.printf("%s | %s - %s | %s%n", slot.id,
                            slot.start.format(FORMAT), slot.end.format(FORMAT), state);
                }
            } finally {
                calendarLock.unlock();
            }
        }
    }

    public static class SchedulingDecision {
        public final String decisionId;
        public final String requestId;
        public final Status status;
        public final String slotId;
        public final LocalDateTime scheduledStart;
        public final double waitingSeconds;
        public final String policy;
        public final String algorithmVersion;
        public final String message;
        public final Map<String, Object> decisionMetrics;

        public SchedulingDecision(String requestId, Status status, String slotId,
                                  double waitingSeconds, String message) {
            this(UUID.randomUUID().toString(), requestId, status, slotId, null,
                 waitingSeconds, "PRIORITY", "v1.0", message, Collections.emptyMap());
        }

        public SchedulingDecision(String decisionId, String requestId, Status status, String slotId,
                                  LocalDateTime scheduledStart, double waitingSeconds, String policy,
                                  String algorithmVersion, String message, Map<String, Object> decisionMetrics) {
            this.decisionId = decisionId;
            this.requestId = requestId;
            this.status = status;
            this.slotId = slotId;
            this.scheduledStart = scheduledStart;
            this.waitingSeconds = waitingSeconds;
            this.policy = policy;
            this.algorithmVersion = algorithmVersion;
            this.message = message;
            this.decisionMetrics = decisionMetrics != null ? decisionMetrics : Collections.emptyMap();
        }

        @Override
        public String toString() {
            return String.format("Request %s: %s%n  Slot: %s%n  Details: %s%n  Queue wait: %.3f seconds",
                requestId, status, slotId == null ? "No slot assigned" : slotId,
                message, waitingSeconds);
        }
    }

    public static class MetricsCollector {
        public int received;
        public int scheduled;
        public int rejected;
        public double totalWait;
        public final Map<Priority, List<Double>> waitByPriority = new ConcurrentHashMap<>();

        public MetricsCollector() {
            for (Priority p : Priority.values()) waitByPriority.put(p, new CopyOnWriteArrayList<>());
        }

        public synchronized void received() { received++; }
        public synchronized void scheduled(Priority p, double wait) {
            scheduled++;
            totalWait += wait;
            if (p != null) waitByPriority.computeIfAbsent(p, k -> new CopyOnWriteArrayList<>()).add(wait);
        }
        public synchronized void rejected() { rejected++; }

        public synchronized Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("received", received);
            m.put("scheduled", scheduled);
            m.put("rejected", rejected);
            double avgWait = scheduled == 0 ? 0 : totalWait / scheduled;
            m.put("avg_wait_seconds", Math.round(avgWait * 1000.0) / 1000.0);
            Map<String, Object> pStats = new LinkedHashMap<>();
            for (Map.Entry<Priority, List<Double>> e : waitByPriority.entrySet()) {
                List<Double> list = e.getValue();
                if (!list.isEmpty()) {
                    double pAvg = list.stream().mapToDouble(Double::doubleValue).average().orElse(0.0);
                    double pMax = list.stream().mapToDouble(Double::doubleValue).max().orElse(0.0);
                    pStats.put(e.getKey().name(), Map.of("count", list.size(), "avg_sec", Math.round(pAvg * 1000.0) / 1000.0, "max_sec", Math.round(pMax * 1000.0) / 1000.0));
                }
            }
            m.put("by_priority", pStats);
            return m;
        }

        public void print() {
            double averageWait = scheduled == 0 ? 0 : totalWait / scheduled;
            System.out.println("\nSUMMARY");
            System.out.printf("  Requests received : %d%n", received);
            System.out.printf("  Appointments booked: %d%n", scheduled);
            System.out.printf("  Requests rejected  : %d%n", rejected);
            System.out.printf("  Average queue wait : %.3f seconds%n", averageWait);
        }
    }

    // =========================================================================
    // QUEUE STRUCTURES (PDF: FIFO, circular queue, priority queue, heap)
    // =========================================================================
    public interface ISchedulingQueue {
        void offer(RequestControlBlock rcb);
        RequestControlBlock poll();
        RequestControlBlock peek();
        boolean isEmpty();
        int size();
        List<RequestControlBlock> snapshot();
    }

    public static class FifoQueue implements ISchedulingQueue {
        private final Queue<RequestControlBlock> q = new ConcurrentLinkedQueue<>();
        @Override public void offer(RequestControlBlock rcb) { q.offer(rcb); }
        @Override public RequestControlBlock poll() { return q.poll(); }
        @Override public RequestControlBlock peek() { return q.peek(); }
        @Override public boolean isEmpty() { return q.isEmpty(); }
        @Override public int size() { return q.size(); }
        @Override public List<RequestControlBlock> snapshot() { return new ArrayList<>(q); }
    }

    public static class CircularQueue implements ISchedulingQueue {
        private final RequestControlBlock[] elements;
        private int head = 0;
        private int tail = 0;
        private int count = 0;
        private final ReentrantLock lock = new ReentrantLock();

        public CircularQueue(int capacity) {
            elements = new RequestControlBlock[Math.max(16, capacity)];
        }

        @Override
        public void offer(RequestControlBlock rcb) {
            lock.lock();
            try {
                if (count == elements.length) {
                    // resize circular buffer
                    RequestControlBlock[] bigger = new RequestControlBlock[elements.length * 2];
                    for (int i = 0; i < count; i++) bigger[i] = elements[(head + i) % elements.length];
                    head = 0;
                    tail = count;
                    elements[tail] = rcb;
                    tail = (tail + 1) % bigger.length;
                    count++;
                } else {
                    elements[tail] = rcb;
                    tail = (tail + 1) % elements.length;
                    count++;
                }
            } finally { lock.unlock(); }
        }

        @Override
        public RequestControlBlock poll() {
            lock.lock();
            try {
                if (count == 0) return null;
                RequestControlBlock r = elements[head];
                elements[head] = null;
                head = (head + 1) % elements.length;
                count--;
                return r;
            } finally { lock.unlock(); }
        }

        @Override
        public RequestControlBlock peek() {
            lock.lock();
            try { return count == 0 ? null : elements[head]; }
            finally { lock.unlock(); }
        }

        @Override public boolean isEmpty() {
            lock.lock();
            try { return count == 0; }
            finally { lock.unlock(); }
        }

        @Override public int size() {
            lock.lock();
            try { return count; }
            finally { lock.unlock(); }
        }

        @Override public List<RequestControlBlock> snapshot() {
            lock.lock();
            try {
                List<RequestControlBlock> list = new ArrayList<>(count);
                for (int i = 0; i < count; i++) list.add(elements[(head + i) % elements.length]);
                return list;
            } finally { lock.unlock(); }
        }
    }

    public static class PriorityQueueAdapter implements ISchedulingQueue {
        private final PriorityBlockingQueue<RequestControlBlock> pbq;

        public PriorityQueueAdapter(Comparator<RequestControlBlock> comparator) {
            pbq = new PriorityBlockingQueue<>(32, comparator);
        }

        @Override public void offer(RequestControlBlock rcb) { pbq.offer(rcb); }
        @Override public RequestControlBlock poll() { return pbq.poll(); }
        @Override public RequestControlBlock peek() { return pbq.peek(); }
        @Override public boolean isEmpty() { return pbq.isEmpty(); }
        @Override public int size() { return pbq.size(); }
        @Override public List<RequestControlBlock> snapshot() {
            List<RequestControlBlock> list = new ArrayList<>(pbq);
            list.sort(pbq.comparator());
            return list;
        }
    }

    public static class HeapQueue implements ISchedulingQueue {
        private final PriorityQueue<RequestControlBlock> heap;
        private final ReentrantLock lock = new ReentrantLock();

        public HeapQueue(Comparator<RequestControlBlock> comparator) {
            heap = new PriorityQueue<>(32, comparator);
        }

        @Override public void offer(RequestControlBlock rcb) {
            lock.lock();
            try { heap.offer(rcb); }
            finally { lock.unlock(); }
        }

        @Override public RequestControlBlock poll() {
            lock.lock();
            try { return heap.poll(); }
            finally { lock.unlock(); }
        }

        @Override public RequestControlBlock peek() {
            lock.lock();
            try { return heap.peek(); }
            finally { lock.unlock(); }
        }

        @Override public boolean isEmpty() {
            lock.lock();
            try { return heap.isEmpty(); }
            finally { lock.unlock(); }
        }

        @Override public int size() {
            lock.lock();
            try { return heap.size(); }
            finally { lock.unlock(); }
        }

        @Override public List<RequestControlBlock> snapshot() {
            lock.lock();
            try {
                List<RequestControlBlock> list = new ArrayList<>(heap);
                list.sort(heap.comparator());
                return list;
            } finally { lock.unlock(); }
        }
    }

    // =========================================================================
    // SLOT LEASE & CONCURRENCY CONTROL (PDF A3)
    // =========================================================================
    public static class SlotLease {
        public final String leaseId;
        public final String slotId;
        public final String holderId;
        public final LocalDateTime grantedAt;
        public final LocalDateTime expiresAt;

        public SlotLease(String leaseId, String slotId, String holderId, int timeoutSeconds) {
            this.leaseId = leaseId;
            this.slotId = slotId;
            this.holderId = holderId;
            this.grantedAt = LocalDateTime.now();
            this.expiresAt = grantedAt.plusSeconds(Math.max(1, timeoutSeconds));
        }

        public boolean isExpired() {
            return LocalDateTime.now().isAfter(expiresAt);
        }
    }

    public static class SlotLeaseManager {
        private final Map<String, SlotLease> leasesById = new ConcurrentHashMap<>();
        private final Map<String, SlotLease> activeLeaseBySlot = new ConcurrentHashMap<>();
        private final ReentrantLock leaseLock = new ReentrantLock();

        public SlotLease acquire(String slotId, String holderId, int timeoutSeconds) {
            leaseLock.lock();
            try {
                cleanExpired();
                SlotLease existing = activeLeaseBySlot.get(slotId);
                if (existing != null && !existing.isExpired()) {
                    if (existing.holderId.equals(holderId)) return existing; // idempotent re-acquire by same holder
                    return null; // lock conflict
                }
                String leaseId = "lease-" + UUID.randomUUID();
                SlotLease lease = new SlotLease(leaseId, slotId, holderId, timeoutSeconds);
                leasesById.put(leaseId, lease);
                activeLeaseBySlot.put(slotId, lease);
                return lease;
            } finally { leaseLock.unlock(); }
        }

        public boolean release(String leaseId) {
            leaseLock.lock();
            try {
                SlotLease lease = leasesById.remove(leaseId);
                if (lease != null) {
                    activeLeaseBySlot.remove(lease.slotId);
                    return true;
                }
                return false;
            } finally { leaseLock.unlock(); }
        }

        public void cleanExpired() {
            leaseLock.lock();
            try {
                for (Iterator<Map.Entry<String, SlotLease>> it = activeLeaseBySlot.entrySet().iterator(); it.hasNext();) {
                    Map.Entry<String, SlotLease> entry = it.next();
                    if (entry.getValue().isExpired()) {
                        leasesById.remove(entry.getValue().leaseId);
                        it.remove();
                    }
                }
            } finally { leaseLock.unlock(); }
        }

        public int activeLeaseCount() {
            cleanExpired();
            return activeLeaseBySlot.size();
        }
    }

    // =========================================================================
    // WAIT-FOR GRAPH & DEADLOCK DETECTION (PDF A3)
    // =========================================================================
    public static class WaitForGraph {
        // holder -> set of transactions it is waiting for
        private final Map<String, Set<String>> graph = new ConcurrentHashMap<>();
        private final ReentrantLock lock = new ReentrantLock();

        public void addWaitEdge(String waitingTx, String holdingTx) {
            lock.lock();
            try {
                graph.computeIfAbsent(waitingTx, k -> new CopyOnWriteArraySet<>()).add(holdingTx);
            } finally { lock.unlock(); }
        }

        public void removeWaitEdge(String waitingTx, String holdingTx) {
            lock.lock();
            try {
                Set<String> set = graph.get(waitingTx);
                if (set != null) {
                    set.remove(holdingTx);
                    if (set.isEmpty()) graph.remove(waitingTx);
                }
            } finally { lock.unlock(); }
        }

        public void removeNode(String tx) {
            lock.lock();
            try {
                graph.remove(tx);
                for (Set<String> set : graph.values()) set.remove(tx);
            } finally { lock.unlock(); }
        }

        public List<List<String>> detectCycles() {
            lock.lock();
            try {
                List<List<String>> cycles = new ArrayList<>();
                Set<String> visited = new HashSet<>();
                Set<String> onStack = new LinkedHashSet<>();

                for (String node : new ArrayList<>(graph.keySet())) {
                    if (!visited.contains(node)) {
                        dfsCycle(node, visited, onStack, cycles);
                    }
                }
                return cycles;
            } finally { lock.unlock(); }
        }

        private void dfsCycle(String curr, Set<String> visited, Set<String> onStack, List<List<String>> cycles) {
            visited.add(curr);
            onStack.add(curr);

            Set<String> neighbors = graph.getOrDefault(curr, Collections.emptySet());
            for (String next : neighbors) {
                if (onStack.contains(next)) {
                    // found cycle
                    List<String> cycle = new ArrayList<>();
                    boolean start = false;
                    for (String s : onStack) {
                        if (s.equals(next)) start = true;
                        if (start) cycle.add(s);
                    }
                    cycle.add(next);
                    cycles.add(cycle);
                } else if (!visited.contains(next)) {
                    dfsCycle(next, visited, onStack, cycles);
                }
            }
            onStack.remove(curr);
        }

        public String resolveDeadlock() {
            lock.lock();
            try {
                List<List<String>> cycles = detectCycles();
                if (cycles.isEmpty()) return null;
                List<String> cycle = cycles.get(0);
                // victim is the last waiting transaction in cycle
                String victim = cycle.get(cycle.size() - 2);
                removeNode(victim);
                return victim;
            } finally { lock.unlock(); }
        }
    }

    // =========================================================================
    // SCHEDULER ENGINE IMPLEMENTATION
    // =========================================================================
    private final ProviderCalendar calendar;
    private final Policy policy;
    private final MetricsCollector metrics = new MetricsCollector();
    private final List<SchedulingDecision> decisions = new CopyOnWriteArrayList<>();
    private final Map<String, SchedulingRequest> requestsById = new ConcurrentHashMap<>();
    private final Map<String, SchedulingDecision> decisionsById = new ConcurrentHashMap<>();
    private final Semaphore schedulerLock = new Semaphore(1);
    private final ISchedulingQueue waitingQueue;
    private final SlotLeaseManager leaseManager = new SlotLeaseManager();
    private final WaitForGraph waitForGraph = new WaitForGraph();

    public AppointmentScheduler(ProviderCalendar calendar, Policy policy) {
        this(calendar, policy, QueueType.PRIORITY_QUEUE);
    }

    public AppointmentScheduler(ProviderCalendar calendar, Policy policy, QueueType queueType) {
        this.calendar = calendar;
        this.policy = policy == null ? Policy.FCFS : policy;

        Comparator<RequestControlBlock> comparator = createComparator(this.policy);
        this.waitingQueue = switch (queueType != null ? queueType : QueueType.PRIORITY_QUEUE) {
            case FIFO -> new FifoQueue();
            case CIRCULAR -> new CircularQueue(128);
            case HEAP -> new HeapQueue(comparator);
            case PRIORITY_QUEUE -> new PriorityQueueAdapter(comparator);
        };
    }

    public static Comparator<RequestControlBlock> createComparator(Policy policy) {
        if (policy == Policy.FCFS) {
            return Comparator.comparing(rcb -> rcb.arrivalTime);
        }
        if (policy == Policy.EARLIEST_FIT) {
            return Comparator.comparing((RequestControlBlock rcb) ->
                rcb.request.preferredStart == null ? LocalDateTime.MAX : rcb.request.preferredStart)
                .thenComparing(rcb -> rcb.arrivalTime);
        }
        if (policy == Policy.URGENCY) {
            // Urgency: priority * 10 - duration (higher weight first)
            return Comparator.comparingInt((RequestControlBlock rcb) ->
                -(rcb.request.priority.value * 100 - rcb.request.durationMinutes))
                .thenComparing(rcb -> rcb.arrivalTime);
        }
        // PRIORITY policy
        return Comparator.comparingInt((RequestControlBlock rcb) -> rcb.request.priority.value)
                .reversed().thenComparing(rcb -> rcb.arrivalTime);
    }

    public RequestControlBlock submit(SchedulingRequest request) {
        metrics.received();
        if (request == null || request.id == null || request.id.isBlank() || request.durationMinutes <= 0) {
            metrics.rejected();
            if (request != null && request.id != null) {
                SchedulingDecision inv = new SchedulingDecision(request.id, Status.INVALID, null, 0, "Invalid request");
                decisions.add(inv);
                decisionsById.put(inv.decisionId, inv);
            }
            return null;
        }

        // Idempotent submission: if request already submitted, return existing RCB
        if (requestsById.containsKey(request.id)) {
            for (RequestControlBlock existing : waitingQueue.snapshot()) {
                if (existing.request.id.equals(request.id)) return existing;
            }
        }
        requestsById.put(request.id, request);

        RequestControlBlock rcb = new RequestControlBlock(request);
        rcb.status = Status.QUEUED;
        waitingQueue.offer(rcb);

        updateQueuePositions();
        return rcb;
    }

    public synchronized void updateQueuePositions() {
        List<RequestControlBlock> list = waitingQueue.snapshot();
        int pos = 1;
        LocalDateTime est = LocalDateTime.now();
        for (RequestControlBlock r : list) {
            r.queuePosition = pos++;
            r.estimatedStart = est;
            est = est.plusMinutes(r.request.durationMinutes);
        }
    }

    public List<SchedulingDecision> run() throws InterruptedException {
        List<SchedulingDecision> batchDecisions = new ArrayList<>();
        while (!waitingQueue.isEmpty()) {
            RequestControlBlock rcb = waitingQueue.poll();
            if (rcb == null) break;
            schedulerLock.acquire();
            try {
                SchedulingDecision decision = schedule(rcb);
                decisions.add(decision);
                decisionsById.put(decision.decisionId, decision);
                batchDecisions.add(decision);
            } finally {
                schedulerLock.release();
            }
        }
        updateQueuePositions();
        return batchDecisions;
    }

    private SchedulingDecision schedule(RequestControlBlock rcb) throws InterruptedException {
        SchedulingRequest request = rcb.request;
        TimeSlot slot = calendar.findSlot(request, policy);
        double wait = Duration.between(rcb.arrivalTime, LocalDateTime.now()).toNanos() / 1_000_000_000.0;

        if (slot == null) {
            rcb.status = Status.NO_SLOT;
            metrics.rejected();
            return new SchedulingDecision(
                    UUID.randomUUID().toString(), request.id, Status.NO_SLOT, null, null,
                    wait, policy.name(), "v1.0", "No matching slot in provider calendar",
                    Map.of("policy", policy.name(), "queue_position", rcb.queuePosition));
        }

        if (!slot.lock.tryLock(2, TimeUnit.SECONDS)) {
            rcb.status = Status.CONFLICT;
            metrics.rejected();
            return new SchedulingDecision(
                    UUID.randomUUID().toString(), request.id, Status.CONFLICT, slot.id, null,
                    wait, policy.name(), "v1.0", "Slot lock timeout",
                    Map.of("policy", policy.name(), "queue_position", rcb.queuePosition));
        }
        try {
            if (!slot.available(request.durationMinutes)) {
                rcb.status = Status.CONFLICT;
                metrics.rejected();
                return new SchedulingDecision(
                        UUID.randomUUID().toString(), request.id, Status.CONFLICT, slot.id, null,
                        wait, policy.name(), "v1.0", "Slot was booked",
                        Map.of("policy", policy.name(), "queue_position", rcb.queuePosition));
            }
            slot.appointmentId = request.id;
            rcb.status = Status.SCHEDULED;
            metrics.scheduled(request.priority, wait);
            return new SchedulingDecision(
                    UUID.randomUUID().toString(), request.id, Status.SCHEDULED, slot.id, slot.start,
                    wait, policy.name(), "v1.0", "Appointment scheduled",
                    Map.of("policy", policy.name(), "queue_position", rcb.queuePosition, "slot_start", slot.start.toString()));
        } finally {
            slot.lock.unlock();
        }
    }

    public List<SchedulingDecision> getDecisions() { return List.copyOf(decisions); }
    public SchedulingDecision getDecisionById(String decisionId) { return decisionsById.get(decisionId); }
    public SchedulingRequest getRequestById(String requestId) { return requestsById.get(requestId); }
    public MetricsCollector metrics() { return metrics; }
    public ISchedulingQueue getQueue() { return waitingQueue; }
    public SlotLeaseManager getLeaseManager() { return leaseManager; }
    public WaitForGraph getWaitForGraph() { return waitForGraph; }
    public Policy getPolicy() { return policy; }

    public static class LiveAppointment {
        public final String appointmentId;
        public final String providerId;
        public final String patient;
        public final String state;
        public final String start;
        public final String priorityRaw;
        public final int tokenNumber;
        public final int durationMinutes;

        public LiveAppointment(String appointmentId, String providerId, String patient, String state,
                               String start, String priorityRaw, int tokenNumber, int durationMinutes) {
            this.appointmentId = appointmentId;
            this.providerId = providerId;
            this.patient = patient;
            this.state = state;
            this.start = start;
            this.priorityRaw = priorityRaw == null ? "NORMAL" : priorityRaw;
            this.tokenNumber = tokenNumber;
            this.durationMinutes = durationMinutes <= 0 ? 10 : durationMinutes;
        }

        public Priority mappedPriority() {
            return "EMERGENCY".equalsIgnoreCase(priorityRaw) ? Priority.URGENT : Priority.MEDIUM;
        }
    }

    public static class QueueEntry {
        public final String appointmentId;
        public final int queuePosition;
        public final String state;
        public final String estimatedStart;
        public final String patient;
        public final int tokenNumber;
        public final String priority;
        public final String policy;

        public QueueEntry(String appointmentId, int queuePosition, String state, String estimatedStart,
                          String patient, int tokenNumber, String priority, String policy) {
            this.appointmentId = appointmentId;
            this.queuePosition = queuePosition;
            this.state = state;
            this.estimatedStart = estimatedStart;
            this.patient = patient;
            this.tokenNumber = tokenNumber;
            this.priority = priority;
            this.policy = policy;
        }
    }

    public List<QueueEntry> dispatchQueue(List<LiveAppointment> waiting) {
        Comparator<RequestControlBlock> comparator = createComparator(policy);
        PriorityBlockingQueue<RequestControlBlock> ready = new PriorityBlockingQueue<>(
                Math.max(8, waiting.size() + 1), comparator);

        Map<String, LiveAppointment> byId = new LinkedHashMap<>();
        int seq = 0;
        for (LiveAppointment live : waiting) {
            byId.put(live.appointmentId, live);
            SchedulingRequest req = new SchedulingRequest(
                    live.appointmentId, live.patient, live.providerId, null,
                    live.durationMinutes, live.mappedPriority(), parseIso(live.start),
                    LocalDateTime.now(), null);
            RequestControlBlock rcb = new RequestControlBlock(req);
            rcb.status = Status.QUEUED;
            rcb.queuePosition = ++seq;
            ready.offer(rcb);
        }

        List<QueueEntry> out = new ArrayList<>();
        int position = 1;
        while (!ready.isEmpty()) {
            RequestControlBlock rcb = ready.poll();
            LiveAppointment src = byId.get(rcb.request.id);
            rcb.queuePosition = position;
            rcb.status = Status.SCHEDULED;
            out.add(new QueueEntry(
                    src.appointmentId, position, src.state, src.start, src.patient,
                    src.tokenNumber, src.priorityRaw, policy.name()));
            position++;
        }
        return out;
    }

    public static int starvationAlerts(List<QueueEntry> queue) {
        int alerts = 0;
        int emergenciesAhead = 0;
        for (QueueEntry e : queue) {
            if ("EMERGENCY".equalsIgnoreCase(e.priority)) emergenciesAhead++;
            else if (emergenciesAhead >= 3 && e.queuePosition > 8) alerts++;
        }
        return alerts;
    }

    public static LocalDateTime parseIso(String iso) {
        if (iso == null || iso.isBlank()) return null;
        try {
            String t = iso.replace("Z", "").replace(" ", "T");
            if (t.length() >= 19) t = t.substring(0, 19);
            return LocalDateTime.parse(t);
        } catch (Exception e) {
            return null;
        }
    }
}
