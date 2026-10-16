package com.teamb.scheduler;

import com.teamb.scheduler.exception.InvalidSlotException;
import com.teamb.scheduler.validator.RequestValidator;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RequestValidatorTest {
    @Test void validInputPasses() {
        assertDoesNotThrow(() -> new RequestValidator()
                .validate("P12", "2026-10-04", "30"));
    }

    @Test void missingDurationFails() {
        assertThrows(InvalidSlotException.class, () ->
                new RequestValidator().validate("P12", "2026-10-04", null));
    }
}
