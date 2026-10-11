package com.teamb.scheduler.db;

import com.teamb.scheduler.model.Appointment;
import java.sql.*;
import java.time.LocalDateTime;
import java.util.*;

public class SlotRepository {
    private static final String URL = "jdbc:h2:./data/availabilitydb";

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(URL, "sa", "");
    }

    public void initSchema() throws SQLException {
        try (Connection c = connect(); Statement s = c.createStatement()) {
            s.execute("""
                CREATE TABLE IF NOT EXISTS appointments(
                    id IDENTITY PRIMARY KEY,
                    provider VARCHAR(50) NOT NULL,
                    start_time TIMESTAMP NOT NULL,
                    end_time TIMESTAMP NOT NULL,
                    status VARCHAR(20) NOT NULL
                )
            """);
        }
    }

    public void seedMockData() throws SQLException {
        try (Connection c = connect();
             PreparedStatement check = c.prepareStatement("SELECT COUNT(*) FROM appointments")) {
            ResultSet rs = check.executeQuery();
            rs.next();
            if (rs.getInt(1) > 0) return;

            insert(c, "DR-001", "2026-10-04T09:30", "2026-10-04T10:00", "BOOKED");
            insert(c, "DR-001", "2026-10-04T11:00", "2026-10-04T12:00", "BOOKED");
            insert(c, "DR-001", "2026-10-04T14:00", "2026-10-04T14:30", "BOOKED");
            insert(c, "DR-002", "2026-10-04T10:00", "2026-10-04T11:00", "BOOKED");
            insert(c, "P12", "2026-10-04T09:30", "2026-10-04T10:00", "BOOKED");
        }
    }

    private void insert(Connection c, String provider, String start, String end, String status)
            throws SQLException {
        try (PreparedStatement p = c.prepareStatement(
                "INSERT INTO appointments(provider,start_time,end_time,status) VALUES(?,?,?,?)")) {
            p.setString(1, provider);
            p.setTimestamp(2, Timestamp.valueOf(LocalDateTime.parse(start)));
            p.setTimestamp(3, Timestamp.valueOf(LocalDateTime.parse(end)));
            p.setString(4, status);
            p.executeUpdate();
        }
    }

    public List<Appointment> findAppointments() throws SQLException {
        List<Appointment> list = new ArrayList<>();
        try (Connection c = connect();
             PreparedStatement p = c.prepareStatement(
                     "SELECT provider,start_time,end_time,status FROM appointments ORDER BY start_time");
             ResultSet rs = p.executeQuery()) {
            while (rs.next()) {
                list.add(new Appointment(
                        rs.getString("provider"),
                        rs.getTimestamp("start_time").toLocalDateTime(),
                        rs.getTimestamp("end_time").toLocalDateTime(),
                        rs.getString("status")));
            }
        }
        return list;
    }
}
