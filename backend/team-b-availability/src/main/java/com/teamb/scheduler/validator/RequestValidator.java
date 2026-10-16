package com.teamb.scheduler.validator;

import com.teamb.scheduler.exception.InvalidSlotException;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;

public class RequestValidator {
    public void validate(String provider, String date, String duration) {
        if (provider == null || provider.isBlank())
            throw new InvalidSlotException("provider is required");
        if (date == null || date.isBlank())
            throw new InvalidSlotException("date is required");
        if (duration == null || duration.isBlank())
            throw new InvalidSlotException("duration is required");

        try { LocalDate.parse(date); }
        catch (DateTimeParseException e) {
            throw new InvalidSlotException("date must be YYYY-MM-DD");
        }

        int minutes;
        try { minutes = Integer.parseInt(duration); }
        catch (NumberFormatException e) {
            throw new InvalidSlotException("duration must be an integer");
        }

        if (minutes <= 0 || minutes > 480)
            throw new InvalidSlotException("duration must be between 1 and 480 minutes");
    }
}
