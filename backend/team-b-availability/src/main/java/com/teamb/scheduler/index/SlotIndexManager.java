package com.teamb.scheduler.index;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fast slot lookup and cache optimization manager (PDF B3).
 * Provides:
 * - Red-Black Tree slot index (TreeMap)
 * - Hash-Map slot index (HashMap)
 * - Versioned search cache with invalidation and microsecond telemetry
 */
public class SlotIndexManager {
    // Red-Black Tree variant (O(log N))
    private final TreeMap<String, Map<String, Object>> redBlackIndex = new TreeMap<>();
    // Hash-Map variant (O(1))
    private final Map<String, Map<String, Object>> hashMapIndex = new ConcurrentHashMap<>();
    // Fast search cache
    private final Map<String, CacheEntry> searchCache = new ConcurrentHashMap<>();

    private long cacheHits = 0;
    private long cacheMisses = 0;

    public record CacheEntry(Object data, long createdAtMs, int calendarVersion) {}

    public synchronized void putSlot(String key, Map<String, Object> slotData) {
        redBlackIndex.put(key, slotData);
        hashMapIndex.put(key, slotData);
    }

    public synchronized Map<String, Object> lookupSlot(String key, String variant) {
        long start = System.nanoTime();
        Map<String, Object> data;
        if ("rb_tree".equalsIgnoreCase(variant) || "avl".equalsIgnoreCase(variant)) {
            data = redBlackIndex.get(key);
        } else {
            data = hashMapIndex.get(key);
        }
        long durationUs = (System.nanoTime() - start) / 1000;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("key", key);
        result.put("variant", variant);
        result.put("found", data != null);
        result.put("slot_data", data);
        result.put("lookup_time_us", Math.max(1, durationUs));
        result.put("index_size", hashMapIndex.size());
        return result;
    }

    public synchronized void cacheResult(String cacheKey, Object result, int calendarVersion) {
        searchCache.put(cacheKey, new CacheEntry(result, System.currentTimeMillis(), calendarVersion));
    }

    public synchronized Object getCachedResult(String cacheKey, int currentVersion) {
        CacheEntry entry = searchCache.get(cacheKey);
        if (entry != null && entry.calendarVersion() == currentVersion) {
            cacheHits++;
            return entry.data();
        }
        cacheMisses++;
        return null;
    }

    public synchronized int invalidateCache() {
        int cleared = searchCache.size();
        searchCache.clear();
        return cleared;
    }

    public synchronized Map<String, Object> getMetrics() {
        long total = cacheHits + cacheMisses;
        double hitRate = total == 0 ? 100.0 : ((double) cacheHits / total) * 100.0;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("cache_hits", cacheHits);
        m.put("cache_misses", cacheMisses);
        m.put("hit_rate_pct", Math.round(hitRate * 10.0) / 10.0);
        m.put("cached_entries", searchCache.size());
        m.put("rb_index_entries", redBlackIndex.size());
        m.put("hash_index_entries", hashMapIndex.size());
        return m;
    }
}
