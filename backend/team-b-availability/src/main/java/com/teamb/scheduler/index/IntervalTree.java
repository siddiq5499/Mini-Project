package com.teamb.scheduler.index;

import com.teamb.scheduler.model.Appointment;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Self-balancing (AVL-based) Augmented Interval Tree (PDF B1).
 * Guarantees O(log N) height, preventing stack overflow on sorted interval insertions,
 * and executes overlap queries in optimal O(k + log N) time.
 */
public class IntervalTree {
    public static class Node {
        public final Appointment appointment;
        public final LocalDateTime start;
        public final LocalDateTime end;
        public LocalDateTime maxEnd;
        public int height;
        public Node left;
        public Node right;

        public Node(Appointment appointment) {
            this.appointment = appointment;
            this.start = appointment.start();
            this.end = appointment.end();
            this.maxEnd = appointment.end();
            this.height = 1;
        }
    }

    private Node root;
    private int size = 0;

    public synchronized void insert(Appointment appointment) {
        root = insertRec(root, appointment);
        size++;
    }

    private int height(Node n) {
        return n == null ? 0 : n.height;
    }

    private LocalDateTime max(LocalDateTime a, LocalDateTime b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.isAfter(b) ? a : b;
    }

    private void updateMaxEndAndHeight(Node n) {
        if (n == null) return;
        n.height = 1 + Math.max(height(n.left), height(n.right));
        LocalDateTime m = n.end;
        if (n.left != null) m = max(m, n.left.maxEnd);
        if (n.right != null) m = max(m, n.right.maxEnd);
        n.maxEnd = m;
    }

    private int getBalance(Node n) {
        return n == null ? 0 : height(n.left) - height(n.right);
    }

    private Node rotateRight(Node y) {
        Node x = y.left;
        Node T2 = x.right;
        x.right = y;
        y.left = T2;
        updateMaxEndAndHeight(y);
        updateMaxEndAndHeight(x);
        return x;
    }

    private Node rotateLeft(Node x) {
        Node y = x.right;
        Node T2 = y.left;
        y.left = x;
        x.right = T2;
        updateMaxEndAndHeight(x);
        updateMaxEndAndHeight(y);
        return y;
    }

    private Node insertRec(Node node, Appointment appointment) {
        if (node == null) return new Node(appointment);

        if (appointment.start().isBefore(node.start)) {
            node.left = insertRec(node.left, appointment);
        } else {
            node.right = insertRec(node.right, appointment);
        }

        updateMaxEndAndHeight(node);

        int balance = getBalance(node);

        // Left Left Case
        if (balance > 1 && appointment.start().isBefore(node.left.start)) {
            return rotateRight(node);
        }
        // Right Right Case
        if (balance < -1 && !appointment.start().isBefore(node.right.start)) {
            return rotateLeft(node);
        }
        // Left Right Case
        if (balance > 1 && !appointment.start().isBefore(node.left.start)) {
            node.left = rotateLeft(node.left);
            return rotateRight(node);
        }
        // Right Left Case
        if (balance < -1 && appointment.start().isBefore(node.right.start)) {
            node.right = rotateRight(node.right);
            return rotateLeft(node);
        }

        return node;
    }

    public synchronized List<Appointment> queryOverlaps(LocalDateTime queryStart, LocalDateTime queryEnd) {
        List<Appointment> result = new ArrayList<>();
        queryRec(root, queryStart, queryEnd, result);
        return result;
    }

    private void queryRec(Node node, LocalDateTime queryStart, LocalDateTime queryEnd, List<Appointment> result) {
        if (node == null) return;

        // Check if current node's interval overlaps [queryStart, queryEnd)
        if (node.start.isBefore(queryEnd) && queryStart.isBefore(node.end)) {
            result.add(node.appointment);
        }

        // If left child has maxEnd >= queryStart, left subtree can contain overlapping intervals
        if (node.left != null && !node.left.maxEnd.isBefore(queryStart)) {
            queryRec(node.left, queryStart, queryEnd, result);
        }

        // If current node's start is before queryEnd, right subtree can also contain overlapping intervals
        if (node.start.isBefore(queryEnd)) {
            queryRec(node.right, queryStart, queryEnd, result);
        }
    }

    public synchronized int size() {
        return size;
    }

    public synchronized void clear() {
        root = null;
        size = 0;
    }
}
