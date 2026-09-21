// Pure station-departure presentation and door-cycle policy. The clock value
// always comes from the simulator's dwell state; this module never owns time.

export const AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS = 1.2;

export function normalizeDwellRemainingSeconds(value) {
    if (value == null || value === '') return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

// Schedule rides close their doors just before the authoritative dwell clock
// expires, so the tram is actually ready to move when the countdown reaches 0.
// A legacy automatic pose with no clock remains open for the whole pause.
export function shouldAutomaticDoorsRemainOpen(
    status,
    closeLeadSeconds = AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS,
) {
    if (!status || !status.paused) return false;
    const remainingSeconds = normalizeDwellRemainingSeconds(status.dwellRemainingS);
    if (remainingSeconds == null) return true;
    return remainingSeconds > Math.max(0, Number(closeLeadSeconds) || 0);
}

// Converts simulator state into a small UI state. Manual stops deliberately do
// not invent a countdown; an expired automatic clock reports the real blocker.
export function stationDeparturePresentation(status) {
    if (!status || !status.paused) return null;
    const remainingSeconds = normalizeDwellRemainingSeconds(status.dwellRemainingS);
    if (remainingSeconds != null && remainingSeconds > 0) {
        return {
            kind: 'countdown',
            seconds: Math.max(1, Math.ceil(remainingSeconds)),
        };
    }
    if (status.departureAutomatic === true) {
        return {
            kind: status.departureBlockedByDoors ? 'waiting-doors' : 'departing',
        };
    }
    if (status.departureAutomatic === false) return { kind: 'manual' };
    return null;
}
