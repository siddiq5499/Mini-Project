import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

public class AppointmentScheduler {
    private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    public enum Priority {
        LOW(1), MEDIUM(2), HIGH(3), URGENT(4);
        final int value;
        Priority(int value) { this.value = value; }
    }

    public enum Policy { FCFS, PRIORITY, EARLIEST_FIT }
    public enum Status { QUEUED, SCHEDULED, NO_SLOT, INVALID, CONFLICT }

    public static class SchedulingRequest {
        final String id;
        final String patient;
        final int durationMinutes;
        final Priority priority;
        final LocalDateTime preferredStart;

        public SchedulingRequest(String id, String patient, int durationMinutes,
                                 Priority priority, LocalDateTime preferredStart) {
            this.id = id;
            this.patient = patient;
            this.durationMinutes = durationMinutes;
            this.priority = priority == null ? Priority.LOW : priority;
            this.preferredStart = preferredStart;
        }
    }

    public static class RequestControlBlock {
        final SchedulingRequest request;
        final LocalDateTime arrivalTime = LocalDateTime.now();
        Status status = Status.QUEUED;
        int queuePosition;

        RequestControlBlock(SchedulingRequest request) {
            this.request = request;
        }
    }

    public static class TimeSlot {
        final String id;
        final LocalDateTime start;
        final LocalDateTime end;
        final ReentrantLock lock = new ReentrantLock();
        String appointmentId;

        public TimeSlot(String id, LocalDateTime start, LocalDateTime end) {
            this.id = id;
            this.start = start;
            this.end = end;
        }

        boolean available(int durationMinutes) {
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

        TimeSlot findSlot(SchedulingRequest request, Policy policy) {
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
        final String requestId;
        final Status status;
        final String slotId;
        final double waitingSeconds;
        final String message;

        SchedulingDecision(String requestId, Status status, String slotId,
                           double waitingSeconds, String message) {
            this.requestId = requestId;
            this.status = status;
            this.slotId = slotId;
            this.waitingSeconds = waitingSeconds;
            this.message = message;
        }

        @Override
        public String toString() {
            return String.format("Request %s: %s%n  Slot: %s%n  Details: %s%n  Queue wait: %.3f seconds",
                requestId, status, slotId == null ? "No slot assigned" : slotId,
                message, waitingSeconds);
        }
    }

    public static class MetricsCollector {
        int received;
        int scheduled;
        int rejected;
        double totalWait;

        void received() { received++; }
        void scheduled(double wait) { scheduled++; totalWait += wait; }
        void rejected() { rejected++; }

        public void print() {
            double averageWait = scheduled == 0 ? 0 : totalWait / scheduled;
            System.out.println("\nSUMMARY");
            System.out.printf("  Requests received : %d%n", received);
            System.out.printf("  Appointments booked: %d%n", scheduled);
            System.out.printf("  Requests rejected  : %d%n", rejected);
            System.out.printf("  Average queue wait : %.3f seconds%n", averageWait);
        }
    }

    private final ProviderCalendar calendar;
    private final Policy policy;
    private final MetricsCollector metrics = new MetricsCollector();
    private final List<SchedulingDecision> decisions = new ArrayList<>();
    private final Semaphore schedulerLock = new Semaphore(1);
    private final PriorityBlockingQueue<RequestControlBlock> waitingQueue;

    public AppointmentScheduler(ProviderCalendar calendar, Policy policy) {
        this.calendar = calendar;
        this.policy = policy == null ? Policy.FCFS : policy;
        Comparator<RequestControlBlock> order = Comparator.comparing(pcb -> pcb.arrivalTime);
        if (this.policy == Policy.PRIORITY) {
            order = Comparator.comparingInt((RequestControlBlock pcb) -> pcb.request.priority.value)
                    .reversed().thenComparing(pcb -> pcb.arrivalTime);
        }
        this.waitingQueue = new PriorityBlockingQueue<>(20, order);
    }

    public void submit(SchedulingRequest request) {
        metrics.received();
        if (request == null || request.id == null || request.id.isBlank() || request.durationMinutes <= 0) {
            metrics.rejected();
            if (request != null) {
                decisions.add(new SchedulingDecision(request.id, Status.INVALID, null, 0, "Invalid request"));
            }
            return;
        }
        RequestControlBlock pcb = new RequestControlBlock(request);
        waitingQueue.offer(pcb);
        int position = 1;
        for (RequestControlBlock queued : waitingQueue) queued.queuePosition = position++;
        System.out.printf("QUEUED %s for %s (%s)%n", request.id, request.patient, request.priority);
    }

    public void run() throws InterruptedException {
        while (!waitingQueue.isEmpty()) {
            RequestControlBlock pcb = waitingQueue.poll();
            schedulerLock.acquire();
            try {
                decisions.add(schedule(pcb));
            } finally {
                schedulerLock.release();
            }
        }
    }

    private SchedulingDecision schedule(RequestControlBlock pcb) throws InterruptedException {
        SchedulingRequest request = pcb.request;
        System.out.printf("DISPATCH %s | status=%s | queue position=%d%n",
            request.id, pcb.status, pcb.queuePosition);
        TimeSlot slot = calendar.findSlot(request, policy);
        double wait = Duration.between(pcb.arrivalTime, LocalDateTime.now()).toNanos() / 1_000_000_000.0;

        if (slot == null) {
            pcb.status = Status.NO_SLOT;
            metrics.rejected();
            return new SchedulingDecision(request.id, Status.NO_SLOT, null, wait, "No matching slot");
        }

        if (!slot.lock.tryLock(2, TimeUnit.SECONDS)) {
            pcb.status = Status.CONFLICT;
            metrics.rejected();
            return new SchedulingDecision(request.id, Status.CONFLICT, slot.id, wait, "Slot lock timeout");
        }
        try {
            if (!slot.available(request.durationMinutes)) {
                pcb.status = Status.CONFLICT;
                metrics.rejected();
                return new SchedulingDecision(request.id, Status.CONFLICT, slot.id, wait, "Slot was booked");
            }
            slot.appointmentId = request.id;
            pcb.status = Status.SCHEDULED;
            metrics.scheduled(wait);
            return new SchedulingDecision(request.id, Status.SCHEDULED, slot.id, wait, "Appointment scheduled");
        } finally {
            slot.lock.unlock();
        }
    }

    public List<SchedulingDecision> getDecisions() {
        return List.copyOf(decisions);
    }

    public MetricsCollector metrics() {
        return metrics;
    }

    /** Live appointment copied from Team C (DBMS). Team A only ranks / dispatches it. */
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

    /**
     * OS ready-queue dispatch: wrap Team C rows as PCBs, order them with the configured
     * policy (PRIORITY = emergency first, then FCFS), and assign queue_position.
     * Does not re-book slots — Team C remains the system of record.
     */
    public List<QueueEntry> dispatchQueue(List<LiveAppointment> waiting) {
        Comparator<RequestControlBlock> bySlot = Comparator.comparing(
                (RequestControlBlock pcb) -> pcb.request.preferredStart == null
                        ? LocalDateTime.MAX : pcb.request.preferredStart);
        Comparator<RequestControlBlock> order = bySlot.thenComparing(pcb -> pcb.arrivalTime);
        if (policy == Policy.PRIORITY) {
            order = Comparator.comparingInt((RequestControlBlock pcb) -> pcb.request.priority.value)
                    .reversed()
                    .thenComparing(bySlot)
                    .thenComparing(pcb -> pcb.arrivalTime);
        }
        PriorityBlockingQueue<RequestControlBlock> ready = new PriorityBlockingQueue<>(
                Math.max(8, waiting.size() + 1), order);

        java.util.Map<String, LiveAppointment> byId = new java.util.LinkedHashMap<>();
        int seq = 0;
        for (LiveAppointment live : waiting) {
            byId.put(live.appointmentId, live);
            SchedulingRequest req = new SchedulingRequest(
                    live.appointmentId, live.patient, live.durationMinutes,
                    live.mappedPriority(), parseIso(live.start));
            RequestControlBlock pcb = new RequestControlBlock(req);
            pcb.status = Status.QUEUED;
            pcb.queuePosition = ++seq;
            ready.offer(pcb);
        }

        List<QueueEntry> out = new ArrayList<>();
        int position = 1;
        while (!ready.isEmpty()) {
            RequestControlBlock pcb = ready.poll();
            LiveAppointment src = byId.get(pcb.request.id);
            pcb.queuePosition = position;
            pcb.status = Status.SCHEDULED;
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

    static LocalDateTime parseIso(String iso) {
        if (iso == null || iso.isBlank()) return null;
        try {
            String t = iso.replace("Z", "").replace(" ", "T");
            if (t.length() >= 19) t = t.substring(0, 19);
            return LocalDateTime.parse(t);
        } catch (Exception e) {
            return null;
        }
    }

    public static void main(String[] args) throws InterruptedException {
        LocalDateTime start = LocalDateTime.of(2026, 10, 5, 9, 0);
        ProviderCalendar calendar = new ProviderCalendar();
        calendar.addSlot(new TimeSlot("S1", start, start.plusMinutes(30)));
        calendar.addSlot(new TimeSlot("S2", start.plusMinutes(30), start.plusMinutes(60)));
        calendar.addSlot(new TimeSlot("S3", start.plusMinutes(60), start.plusMinutes(90)));

        AppointmentScheduler scheduler = new AppointmentScheduler(calendar, Policy.PRIORITY);
        scheduler.submit(new SchedulingRequest("REQ-1", "Rahul", 30, Priority.LOW, start));
        scheduler.submit(new SchedulingRequest("REQ-2", "Maya", 30, Priority.URGENT, start));
        scheduler.submit(new SchedulingRequest("REQ-3", "Sam", 30, Priority.HIGH, start));
        scheduler.submit(new SchedulingRequest("REQ-4", "Alex", 30, Priority.MEDIUM, start));

        System.out.println("\nSCHEDULING APPOINTMENTS\n");
        scheduler.run();
        System.out.println("\nRESULTS");
        scheduler.getDecisions().forEach(System.out::println);
        scheduler.metrics.print();
        calendar.print();
    }
}
