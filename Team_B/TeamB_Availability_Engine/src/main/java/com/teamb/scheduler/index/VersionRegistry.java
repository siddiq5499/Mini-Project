package com.teamb.scheduler.index;

public class VersionRegistry {
    private int calendarVersion = 41;

    public int currentVersion() { return calendarVersion; }

    public void increment() { calendarVersion++; }

    public void setVersion(int version) { this.calendarVersion = Math.max(1, version); }
}
